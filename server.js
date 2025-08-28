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
   * Pick nutrition and ingredients from search results
   * @param {Array} results - Search results array
   * @returns {object} Filtered nutrition and ingredients results
   */
  static pickNutritionAndIngredients(results) {
    const nutrition = results.filter(r =>
      /nutrition|nutrition facts|label/i.test(r.title + r.snippet)
    );
    const ingredients = results.filter(r =>
      /ingredient/i.test(r.title + r.snippet)
    );
    
    return {
      nutrition: nutrition.slice(0, 3),
      ingredients: ingredients.slice(0, 3)
    };
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
      temperature: 0.2,
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
            text: `You are analyzing a packaged product image. 
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

  /**
   * Extract nutrition information from search results
   * @param {Array} searchResults - Web search results
   * @param {object} productData - Product data
   * @returns {Promise<object>} Extracted nutrition information
   */
  static async extractNutritionInfo(searchResults, productData) {
    const topResults = searchResults.slice(0, 6);
    const searchBlock = Utils.formatSearchResultsForLLM(topResults, 6, 300);

    const systemPrompt = `You are a helpful assistant that extracts nutrition information from web search results. 

Analyze the provided search results and page content to find nutrition facts and ingredients for the product. You can also use your general knowledge about common food products.

Please return your response as JSON with this structure:
{
  "product_name": "string or null",
  "nutrition_facts_text": "full nutrition facts text ",
  "nutrition": {
    "serving_size": "string ",
    "calories": "string ", 
    "total_fat": "string",
    "saturated_fat": "string",
    "trans_fat": "string,
    "cholesterol": "string",
    "sodium": "string ",
    "total_carbohydrate": "string",
    "dietary_fiber": "string",
    "total_sugars": "string",
    "added_sugars": "string ",
    "protein": "string",
    "vitamin_d": "string",
    "calcium": "string",
    "iron": "string",
    "potassium": "string"
  },
  "ingredients": [
    {
      "text": "ingredient name",
    }
  ],
  "confidence": "high, medium, or low",
  "sources": [
    {
      "title": "string",
      "url": "string",
      "snippet": "string", 
      "used_for": ["nutrition", "ingredients", or "both"]
    }
  ]
}

Guidelines:
- Look for nutrition facts tables, ingredient lists, and product information
- If you find specific values, include them
- For ingredients, list them as individual items
- Return only valid JSON, no other text`;

    const userPrompt = `Here's the product information from the image: ${JSON.stringify(productData)}

Below are web search results and page content that might contain nutrition information:

${searchBlock}

Please analyze this information and extract any nutrition facts and ingredients you can find. If you don't find specific information, you can use your general knowledge about similar products. Return your response as JSON.`;

    const response = await OpenAIService.createChatCompletion([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]);

    const llmRaw = response.choices?.[0]?.message?.content || "";
    return Utils.extractJsonFromText(llmRaw);
  }
}

class TestosteroneAnalysisService {
  /**
   * Analyze food for testosterone impact
   * @param {string} name - Food name
   * @param {string} kcal - Calories
   * @param {number} portion_g - Portion in grams
   * @returns {Promise<object>} Testosterone impact analysis
   */
  static async analyzeTestosteroneImpact(name, kcal, portion_g) {
    const systemPrompt = `You are a nutrition expert specializing in testosterone optimization through diet. Analyze the given food item and provide detailed testosterone impact assessment.

Return ONLY valid JSON with this exact structure:
{
  "status": true,
  "message": null,
  "data": {
    "t_score_impact": {
      "label": "Optimized" | "Moderate" | "Poor",
      "score_perc": number (0-100),
      "macro_balance": "Good" | "Fair" | "Poor",
      "processed_profile": "Low" | "Medium" | "High",
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
    }
  }
}

Guidelines for testosterone impact:
- High protein foods (especially red meat, eggs, fish) boost testosterone
- Healthy fats (omega-3s, monounsaturated) support hormone production
- Fiber helps with insulin sensitivity and testosterone
- Processed foods, trans fats, and excessive sugar negatively impact testosterone
- Cholesterol is a precursor to testosterone synthesis
- Score 90-100: Excellent for testosterone
- Score 70-89: Good for testosterone  
- Score 50-69: Moderate impact
- Score 0-49: Poor for testosterone

Use your knowledge of nutrition and testosterone optimization to provide accurate assessments.`;

    const userPrompt = `Analyze this food item for testosterone impact:

Food Name: ${name}
Calories: ${kcal} kcal
Portion Size: ${portion_g} grams

Please provide the testosterone impact analysis in the specified JSON format.`;

    const response = await OpenAIService.createChatCompletion([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], {
      temperature: 0.1,
      max_tokens: 800
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

  /**
   * Validate testosterone analysis request
   * @param {object} body - Request body
   * @returns {object} Validation result
   */
  static validateTestosteroneAnalysisRequest(body) {
    const { name, kcal, portion_g } = body;
    
    if (!name || !kcal || !portion_g) {
      return { 
        isValid: false, 
        error: "Missing required fields: name, kcal, and portion_g are required" 
      };
    }
    
    return { isValid: true };
  }
}

// ------------------
// API Routes
// ------------------
app.post("/analyze-image", async (req, res) => {
  try {
    // Validate request
    const validation = ValidationService.validateImageAnalysisRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: validation.error });
    }

    const { imageUrl } = req.body;
    console.log('Processing image analysis for URL:', imageUrl);

    // Analyze product image
    const productData = await ImageAnalysisService.analyzeProductImage(imageUrl);
    console.log('Product data extracted:', productData);

    // Build search query
    const primaryQuery = ImageAnalysisService.buildSearchQuery(productData);
    console.log('Search query:', primaryQuery);

    // Perform web search
    const searchResults = await ImageAnalysisService.performWebSearch(primaryQuery, productData);
    console.log(`Found ${searchResults.length} search results`);

    // Extract nutrition information
    const finalExtract = await ImageAnalysisService.extractNutritionInfo(searchResults, productData);

    if (!finalExtract) {
      return res.json({
        productData,
        searchQuery: primaryQuery,
        searchResults: searchResults.slice(0, 6),
        note: "LLM did not return valid JSON"
      });
    }

    // Return successful response
    return res.json({
      data: finalExtract
    });

  } catch (error) {
    console.error('Image analysis error:', error);
    res.status(500).json({ 
      error: "internal_error", 
      details: error.message 
    });
  }
});

app.post("/analyze-testosterone-impact", async (req, res) => {
  try {
    // Validate request
    const validation = ValidationService.validateTestosteroneAnalysisRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ error: validation.error });
    }

    const { name, kcal, portion_g } = req.body;
    console.log('Processing testosterone analysis for:', name);

    // Analyze testosterone impact
    const result = await TestosteroneAnalysisService.analyzeTestosteroneImpact(name, kcal, portion_g);

    if (!result) {
      return res.status(500).json({
        error: "Failed to parse AI response"
      });
    }

    return res.json(result);

  } catch (error) {
    console.error('Testosterone analysis error:', error);
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
});
