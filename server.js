// server.mjs
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import OpenAI from "openai";

// Load environment variables
dotenv.config();

// ------------------
// Configuration
// ------------------
const config = {
  port: process.env.PORT || 3000,
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  },
  brave: {
    apiKey: process.env.BRAVE_API_KEY
  }
};

// Validate required environment variables
const requiredEnvVars = [
  'OPENAI_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// ------------------
// Initialize Express App
// ------------------
const app = express();

// Middleware
app.use(express.json({ limit: "1mb" }));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ------------------
// Initialize OpenAI Client
// ------------------
const openAIClient = new OpenAI({
  apiKey: config.openai.apiKey
});

// ------------------
// Utility Functions
// ------------------
class Utils {
  /**
   * Extract JSON from text response
   * @param {string} text - Text containing JSON
   * @returns {object|null} Parsed JSON or null
   */
  static extractJsonFromText(text) {
    if (!text) return null;
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.warn('Failed to parse JSON from text:', error.message);
      return null;
    }
  }

  /**
   * Format search results for LLM consumption
   * @param {Array} results - Search results array
   * @param {number} maxResults - Maximum number of results
   * @param {number} maxSnippetLen - Maximum snippet length
   * @returns {string} Formatted search results
   */
  static formatSearchResultsForLLM(results, maxResults = 5, maxSnippetLen = 300) {
    return results
      .slice(0, maxResults)
      .map((r, i) => {
        const snippet = (r.snippet || "").replace(/\s+/g, " ").trim().slice(0, maxSnippetLen);
        return `${i + 1}. Title: ${r.title}\n   Snippet: ${snippet}\n   URL: ${r.link}`;
      })
      .join("\n\n");
  }

  /**
   * Format scraped content for LLM consumption
   * @param {Array} scrapedResults - Array of scraped content
   * @param {number} maxResults - Maximum number of results
   * @returns {string} Formatted scraped content
   */
  static formatScrapedContentForLLM(scrapedResults, maxResults = 5) {
    return scrapedResults
      .slice(0, maxResults)
      .map((r, i) => {
        const content = (r.content || "").replace(/\s+/g, " ").trim().slice(0, 2000);
        return `${i + 1}. Title: ${r.title}\n   URL: ${r.url}\n   Content: ${content}`;
      })
      .join("\n\n");
  }
}

// ------------------
// External API Services
// ------------------
class BraveSearchService {
  /**
   * Search using Brave API
   * @param {string} query - Search query
   * @param {number} count - Number of results
   * @returns {Promise<Array>} Search results
   */
  static async search(query, count = 6) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    
    try {
      const response = await fetch(url, {
        headers: { "X-Subscription-Token": config.brave.apiKey }
      });

      if (!response.ok) {
        throw new Error(`Brave API error: ${response.status} ${await response.text()}`);
      }

      const data = await response.json();
      return (data.web?.results || []).map(item => ({
        title: item.title || "",
        link: item.url || "",
        snippet: item.description || ""
      }));
    } catch (error) {
      console.error('Brave search failed:', error.message);
      throw error;
    }
  }
}

class WebScrapingService {
  /**
   * Scrape content from a URL
   * @param {string} url - URL to scrape
   * @param {number} maxLength - Maximum content length
   * @returns {Promise<object|null>} Scraped content or null
   */
  static async scrapeUrl(url, maxLength = 3000) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        timeout: 10000
      });

      if (!response.ok) {
        return null;
      }

      const html = await response.text();
      
      // Extract text content from HTML
      const textContent = this.extractTextFromHTML(html);
      
      if (!textContent) {
        return null;
      }

      return {
        url: url,
        content: textContent.slice(0, maxLength),
        success: true
      };

    } catch (error) {
      console.warn(`Failed to scrape ${url}:`, error.message);
      return null;
    }
  }

  /**
   * Extract text content from HTML
   * @param {string} html - HTML content
   * @returns {string} Extracted text
   */
  static extractTextFromHTML(html) {
    try {
      // Remove script and style tags
      let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      
      // Remove HTML tags
      text = text.replace(/<[^>]+>/g, ' ');
      
      // Decode HTML entities
      text = text.replace(/&nbsp;/g, ' ');
      text = text.replace(/&amp;/g, '&');
      text = text.replace(/&lt;/g, '<');
      text = text.replace(/&gt;/g, '>');
      text = text.replace(/&quot;/g, '"');
      text = text.replace(/&#39;/g, "'");
      
      // Clean up whitespace
      text = text.replace(/\s+/g, ' ').trim();
      
      return text;
    } catch (error) {
      console.warn('Failed to extract text from HTML:', error.message);
      return '';
    }
  }

  /**
   * Scrape multiple URLs and return content
   * @param {Array} searchResults - Array of search results with URLs
   * @param {number} maxUrls - Maximum number of URLs to scrape
   * @returns {Promise<Array>} Array of scraped content
   */
  static async scrapeMultipleUrls(searchResults, maxUrls = 5) {
    const urlsToScrape = searchResults.slice(0, maxUrls);
    const scrapedResults = [];

    for (const result of urlsToScrape) {
      try {
        const scrapedContent = await this.scrapeUrl(result.link);
        if (scrapedContent && scrapedContent.success) {
          scrapedResults.push({
            title: result.title,
            url: result.link,
            content: scrapedContent.content
          });
        }
        
        // Add small delay to be respectful to servers
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.warn(`Failed to scrape ${result.link}:`, error.message);
      }
    }

    return scrapedResults;
  }
}

class OpenAIService {
  /**
   * Create chat completion
   * @param {Array} messages - Chat messages
   * @param {object} options - Additional options
   * @returns {Promise<object>} OpenAI response
   */
  static async createChatCompletion(messages, options = {}) {
    const defaultOptions = {
      model: config.openai.model,
      temperature: 0.1,
      max_tokens: 1000
    };

    try {
      return await openAIClient.chat.completions.create({
        ...defaultOptions,
        ...options,
        messages
      });
    } catch (error) {
      console.error('OpenAI API call failed:', error.message);
      throw error;
    }
  }
}

// ------------------
// Business Logic Services
// ------------------
class ImageAnalysisService {
  /**
   * Analyze product image
   * @param {string} imageUrl - URL of the image to analyze
   * @returns {Promise<object>} Product data from image
   */
  static async analyzeProductImage(imageUrl) {
    const response = await OpenAIService.createChatCompletion([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are analyzing the image of a packaged product. Analyze the image for branding and product identification, and for detailed nutrition and ingredient information.

Return only JSON with fields:
{
  "product_name": string|null,
  "brand": string|null,
  "net_weight": string|null,
  "barcode_or_upc": string|null,
  "visible_text": string[],
  "confidence": "high"|"medium"|"low"
}`
          },
          {
            type: "image_url",
            image_url: { url: imageUrl }
          }
        ]
      }
    ]);

    return Utils.extractJsonFromText(response.choices[0].message.content) || { 
      product_name: null, 
      brand: null
    };
  }

  /**
   * Build search query from product data
   * @param {object} productData - Product information
   * @returns {string} Search query
   */
  static buildSearchQuery(productData) {
    const brand = productData.brand?.toString()?.trim() || "";
    const pname = productData.product_name?.toString()?.trim() || "";
    const barcode = productData.barcode_or_upc?.toString()?.trim() || "";

    let primaryQuery = [brand, pname].filter(Boolean).join(" ").trim();
    
    if (!primaryQuery && barcode) {
      primaryQuery = barcode;
    }
    
    if (!primaryQuery) {
      primaryQuery = (productData.visible_text || []).slice(0, 4).join(" ").trim();
    }
    
    return (" nutrition facts, ingredients for " + primaryQuery).trim();
  }

  /**
   * Perform web search with fallback strategies
   * @param {string} primaryQuery - Primary search query
   * @param {object} productData - Product data for fallback queries
   * @returns {Promise<Array>} Search results
   */
  static async performWebSearch(primaryQuery, productData) {
    const allResults = [];
    
    try {
      allResults.push({ 
        query: primaryQuery, 
        results: await BraveSearchService.search(primaryQuery, 8) 
      });
    } catch (error) {
      console.warn("Primary Brave search failed:", error.message);
      
      // Fallback to product name only
      const pname = productData.product_name?.toString()?.trim() || "";
      if (pname && pname !== primaryQuery) {
        const fallbackQuery = `${pname} nutrition facts ingredients`;
        try {
          await new Promise(resolve => setTimeout(resolve, 400));
          allResults.push({ 
            query: fallbackQuery, 
            results: await BraveSearchService.search(fallbackQuery, 8) 
          });
        } catch (fallbackError) {
          console.warn("Fallback Brave search failed:", fallbackError.message);
        }
      }
      
      // Try barcode if present
      const barcode = productData.barcode_or_upc?.toString()?.trim() || "";
      if (barcode && allResults.length === 0) {
        try {
          await new Promise(resolve => setTimeout(resolve, 400));
          allResults.push({ 
            query: barcode + " nutrition facts", 
            results: await BraveSearchService.search(barcode, 8) 
          });
        } catch (barcodeError) {
          console.warn("Barcode Brave search failed:", barcodeError.message);
        }
      }
    }

    return allResults.flatMap(group => group.results || []);
  }
}

class ComprehensiveAnalysisService {
  /**
   * Analyze food comprehensively for nutrition and testosterone impact
   * @param {object} productData - Product data from image analysis
   * @param {Array} searchResults - Web search results
   * @returns {Promise<object>} Comprehensive analysis
   */
  static async analyzeComprehensive(productData, searchResults) {
    const topResults = searchResults.slice(0, 6);
    
    // Scrape content from top search results
    console.log('Scraping content from top search results...');
    const scrapedContent = await WebScrapingService.scrapeMultipleUrls(topResults, 5);
    console.log(`Successfully scraped ${scrapedContent.length} pages`);
    
    // Format scraped content for LLM
    const scrapedBlock = Utils.formatScrapedContentForLLM(scrapedContent, 5);

    const systemPrompt = `You are a comprehensive nutrition and testosterone optimization expert. Analyze the product data and detailed web content to provide accurate analysis.

Return ONLY valid JSON with this exact structure:
{
  "status": true,
  "message": null,
  "data": {
    "product_info": {
      "product_name": "string",
      "brand": "string",
      "net_weight": "string",
      "barcode_or_upc": "string",
      "visible_text": ["string"]
    },
    "nutrition_facts": {
      "serving_size": "string",
      "calories": "string",
      "total_fat": "string",
      "saturated_fat": "string",
      "trans_fat": "string",
      "cholesterol": "string",
      "sodium": "string",
      "total_carbohydrate": "string",
      "dietary_fiber": "string",
      "total_sugars": "string",
      "added_sugars": "string",
      "protein": "string",
      "vitamin_d": "string",
      "calcium": "string",
      "iron": "string",
      "potassium": "string"
    },
    "ingredients": [
      {
        "text": "ingredient name",
        "testosterone_impact": "positive|negative|neutral",
        "notes": "brief explanation"
      }
    ],
    "allergens": ["string"],
    "seed_oils": ["list of oils used"],
    "processed_profile": {
      "score": number (1-10, where 1 is minimal processing, 10 is highly processed),
      "level": "Low|Medium|High",
      "added_synthetic_sugars": ["list of added or synthetic sugars"],
      "additives": ["list of additives"],
      "refined_carbs": ["list of refined carbohydrates"]
    },
    "estrogenic_compounds": ["list of estrogenic compounds"],
    "microplastics": ["list of microplastics if any"],
    "t_score_impact": {
      "label": "Optimized|Moderate|Poor",
      "score_perc": number (0-100),
      "macro_balance": "Good|Fair|Poor",
      "hormone_disruptor": number (0-2, where 0 is no, 1 is mild, 2 is high)
    },
    "micros": {
      "protein_g": number,
      "carbs": {
        "fiber_g": number,
        "sugar_g": number,
        "added_sugar_g": number
      },
      "fats": {
        "saturated_g": number,
        "trans_g": number
      },
      "cholesterol_mg": number
    },
    "sources": [
      {
        "title": "string",
        "url": "string",
        "content_summary": "string",
        "used_for": ["nutrition", "ingredients", "testosterone", or "other"]
      }
    ]
  }
}

Guidelines:
- Analyze the image data and detailed web content
- Use the scraped page content for accurate nutrition information
- Identify seed oils (soybean, canola, sunflower, cottonseed, etc.)
- Assess processing level based on ingredients and additives
- Identify estrogenic compounds (BPA, phthalates, etc.)
- Check for microplastics in packaging or ingredients
- Mark ingredients with testosterone impact in parentheses
- Calculate macro balance based on protein, carbs, and fats
- Provide comprehensive testosterone impact assessment
- Use scientific knowledge and detailed web content for accurate analysis`;

    const userPrompt = `Analyze this product comprehensively using the image data and detailed web content:

Product Data from Image:
${JSON.stringify(productData, null, 2)}

Detailed Web Content (Scraped from top search results):
${scrapedBlock}

Please provide comprehensive analysis including nutrition facts, ingredients analysis, processing assessment, and testosterone impact. Use the detailed web content to provide accurate and specific information. Return your response as JSON.`;

    const response = await OpenAIService.createChatCompletion([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], {
      temperature: 0.1,
      max_tokens: 1500
    });

    const responseContent = response.choices[0].message.content;
    return Utils.extractJsonFromText(responseContent);
  }
}

// ------------------
// Request Validation
// ------------------
class ValidationService {
  /**
   * Validate image analysis request
   * @param {object} body - Request body
   * @returns {object} Validation result
   */
  static validateImageAnalysisRequest(body) {
    if (!body.imageUrl) {
      return { isValid: false, error: "imageUrl is required" };
    }
    return { isValid: true };
  }
}

// ------------------
// API Routes
// ------------------
app.post("/analyze-comprehensive", async (req, res) => {
  try {
    // Validate request
    const validation = ValidationService.validateImageAnalysisRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: validation.error });
    }

    const { imageUrl } = req.body;
    console.log('Processing comprehensive analysis for image URL:', imageUrl);

    // Analyze product image
    const productData = await ImageAnalysisService.analyzeProductImage(imageUrl);
    console.log('Product data extracted:', productData);

    // Build search query
    const primaryQuery = ImageAnalysisService.buildSearchQuery(productData);
    console.log('Search query:', primaryQuery);

    // Perform web search
    const searchResults = await ImageAnalysisService.performWebSearch(primaryQuery, productData);
    console.log(`Found ${searchResults.length} search results`);

    // Perform comprehensive analysis
    const comprehensiveResult = await ComprehensiveAnalysisService.analyzeComprehensive(productData, searchResults);

    if (!comprehensiveResult) {
      return res.status(500).json({
        error: "Failed to parse comprehensive analysis response",
        productData,
        searchQuery: primaryQuery,
        searchResults: searchResults.slice(0, 6)
      });
    }

    // Return comprehensive analysis with additional context
    return res.json({
      ...comprehensiveResult,
      debug: {
        searchQuery: primaryQuery,
        searchResultsCount: searchResults.length,
        scrapedPagesCount: Math.min(5, searchResults.length)
      }
    });

  } catch (error) {
    console.error('Comprehensive analysis error:', error);
    res.status(500).json({ 
      error: "internal_error", 
      details: error.message 
    });
  }
});

// ------------------
// Health Check Endpoint
// ------------------
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    services: {
      openai: !!config.openai.apiKey,
      brave: !!config.brave.apiKey
    }
  });
});

// ------------------
// Error Handling Middleware
// ------------------
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: "internal_server_error",
    message: "An unexpected error occurred"
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: "not_found",
    message: "Endpoint not found" 
  });
});

// ------------------
// Start Server
// ------------------
app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  console.log(`Health check available at: http://localhost:${config.port}/health`);
  console.log(`Comprehensive analysis endpoint: POST http://localhost:${config.port}/analyze-comprehensive`);
});
