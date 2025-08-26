const axios = require('axios');
const OpenAI = require('openai');
const { OpenAIClient, AzureKeyCredential } = require('@azure/openai');

/**
 * Enhanced web search service for nutrition data
 * Uses real search APIs and GPT-4 for data processing
 */

class WebSearchService {
  constructor() {
    this.enabled = process.env.ENABLE_WEB_SEARCH === 'true';
    
    // Initialize OpenAI client (supports both OpenAI and Azure OpenAI)
    if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
      // Use Azure OpenAI
      this.azureClient = new OpenAIClient(
        process.env.AZURE_OPENAI_ENDPOINT,
        new AzureKeyCredential(process.env.AZURE_OPENAI_API_KEY)
      );
    } else if (process.env.OPENAI_API_KEY) {
      // Use standard OpenAI
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    } else {
      // No API key configured - will be handled in individual methods
      console.warn('⚠️ No OpenAI API key configured. Web search functionality will be limited.');
    }
    
    // Search API configurations
    this.searchApis = {
      // You can add multiple search APIs here
      google: {
        enabled: process.env.GOOGLE_SEARCH_ENABLED === 'true',
        apiKey: process.env.GOOGLE_SEARCH_API_KEY,
        engineId: process.env.GOOGLE_SEARCH_ENGINE_ID,
        baseUrl: 'https://www.googleapis.com/customsearch/v1'
      },
      // Add other search APIs as needed
    };
  }

  /**
   * Search for nutrition information about a specific food item
   * @param {string} foodItem - Name of the food item to search for
   * @returns {Object} Enhanced nutrition data
   */
  async searchNutritionData(foodItem) {
    if (!this.enabled) {
      console.log('Web search is disabled. Skipping nutrition data search.');
      return null;
    }

    try {
      console.log(`🔍 Searching for nutrition data: ${foodItem}`);
      
      // Perform web search
      const searchResults = await this.performWebSearch(foodItem);
      
      if (!searchResults || searchResults.length === 0) {
        console.log('No search results found');
        return null;
      }

      // Extract and process nutrition data using GPT-4
      const nutritionData = await this.extractNutritionDataWithGPT(foodItem, searchResults);
      
      return nutritionData;
    } catch (error) {
      console.error('Web search failed:', error.message);
      return null;
    }
  }

  /**
   * Perform web search for food nutrition information
   * @param {string} query - Search query
   * @returns {Array} Search results
   */
  async performWebSearch(query) {
    const searchQuery = `${query} nutrition facts calories protein carbohydrates fat ingredients label`;
    let allResults = [];

    // Try Google Custom Search if enabled
    if (this.searchApis.google.enabled && this.searchApis.google.apiKey) {
      try {
        const googleResults = await this.performGoogleSearch(searchQuery);
        allResults = allResults.concat(googleResults);
      } catch (error) {
        console.warn('Google search failed:', error.message);
      }
    }

    // Fallback to a simple web search simulation if no APIs are configured
    if (allResults.length === 0) {
      console.log('No search APIs configured, using fallback search...');
      allResults = await this.performFallbackSearch(query);
    }

    return allResults;
  }

  /**
   * Perform Google Custom Search
   * @param {string} query - Search query
   * @returns {Array} Search results
   */
  async performGoogleSearch(query) {
    const { apiKey, engineId, baseUrl } = this.searchApis.google;
    
    const response = await axios.get(baseUrl, {
      params: {
        key: apiKey,
        cx: engineId,
        q: query,
        num: 10, // Get more results for better data extraction
        dateRestrict: 'm1', // Restrict to last month for fresh data
        sort: 'relevance'
      },
      timeout: 10000
    });

    if (response.data.items) {
      return response.data.items.map(item => ({
        title: item.title,
        snippet: item.snippet,
        link: item.link,
        source: 'google'
      }));
    }

    return [];
  }

  /**
   * Fallback search method when no APIs are configured
   * @param {string} query - Search query
   * @returns {Array} Mock search results
   */
  async performFallbackSearch(query) {
    // This is a fallback that simulates search results
    // In production, you should configure at least one search API
    console.log('Using fallback search - configure search APIs for better results');
    
    return [
      {
        title: `${query} Nutrition Facts and Ingredients`,
        snippet: `Comprehensive nutrition information for ${query} including calories, protein, carbohydrates, fat, and complete ingredient list.`,
        link: `https://nutrition-database.com/${encodeURIComponent(query)}`,
        source: 'fallback'
      }
    ];
  }

  /**
   * Extract nutrition data from search results using GPT-4
   * @param {string} foodItem - Food item name
   * @param {Array} searchResults - Search results
   * @returns {Object} Structured nutrition data
   */
  async extractNutritionDataWithGPT(foodItem, searchResults) {
    try {
      console.log('🤖 Processing search results with GPT-4...');

      // Prepare search results for GPT processing
      const searchText = searchResults.map(result => 
        `Title: ${result.title}\nSnippet: ${result.snippet}\nURL: ${result.link}\n`
      ).join('\n---\n');

      const prompt = `You are a professional nutritionist and data analyst. Analyze the following web search results for "${foodItem}" and extract comprehensive nutrition information.

SEARCH RESULTS:
${searchText}

TASK: Extract and structure the following information from the search results:
1. Nutrition Facts (calories, protein, carbs, fat, fiber, sugar, sodium, etc.)
2. Complete ingredient list
3. Serving size information
4. Allergen information
5. Dietary restrictions (vegetarian, vegan, gluten-free, etc.)
6. Health benefits and warnings
7. Additional nutritional insights

IMPORTANT:
- If multiple sources provide different values, use the most common or most reliable source
- If information is missing, indicate "Not available" rather than guessing
- Focus on official nutrition labels and reputable sources
- Extract exact values when available

Format your response as JSON with this structure:
{
  "nutritionFacts": {
    "servingSize": "string",
    "calories": "string",
    "macronutrients": {
      "protein": "string",
      "carbohydrates": "string", 
      "fat": "string",
      "fiber": "string",
      "sugar": "string"
    },
    "micronutrients": {
      "vitamins": ["array of vitamins"],
      "minerals": ["array of minerals"]
    },
    "sodium": "string",
    "cholesterol": "string"
  },
  "ingredients": ["array of ingredients"],
  "allergens": ["array of allergens"],
  "dietaryInfo": {
    "vegetarian": boolean,
    "vegan": boolean,
    "glutenFree": boolean,
    "dairyFree": boolean
  },
  "healthInsights": "string",
  "dataSource": "string (source of the data)",
  "confidence": "High/Medium/Low"
}`;

      let response;
      
      if (this.azureClient) {
        // Use Azure OpenAI
        response = await this.azureClient.getChatCompletions(
          process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
          [
            {
              role: "system",
              content: "You are a professional nutritionist and data analyst. Extract structured nutrition data from web search results."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          {
            maxTokens: 2000,
            temperature: 0.1,
          }
        );
      } else {
        // Use standard OpenAI
        response = await this.openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content: "You are a professional nutritionist and data analyst. Extract structured nutrition data from web search results."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          max_tokens: 2000,
          temperature: 0.1,
        });
      }

      const analysisText = response.choices[0].message.content;
      
      // Parse the JSON response
      let nutritionData;
      try {
        const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          nutritionData = JSON.parse(jsonMatch[0]);
        } else {
          nutritionData = JSON.parse(analysisText);
        }
      } catch (parseError) {
        console.error('Failed to parse GPT response:', parseError);
        return this.createFallbackNutritionData(foodItem);
      }

      // Add metadata
      nutritionData.enhanced = true;
      nutritionData.source = 'web_search_gpt4';
      nutritionData.searchResults = searchResults.length;
      nutritionData.processedAt = new Date().toISOString();

      console.log('✅ GPT-4 nutrition data extraction completed');
      return nutritionData;

    } catch (error) {
      console.error('GPT-4 processing failed:', error.message);
      return this.createFallbackNutritionData(foodItem);
    }
  }

  /**
   * Create fallback nutrition data when processing fails
   * @param {string} foodItem - Food item name
   * @returns {Object} Fallback nutrition data
   */
  createFallbackNutritionData(foodItem) {
    return {
      nutritionFacts: {
        servingSize: "Not available",
        calories: "Not available",
        macronutrients: {
          protein: "Not available",
          carbohydrates: "Not available",
          fat: "Not available",
          fiber: "Not available",
          sugar: "Not available"
        },
        micronutrients: {
          vitamins: [],
          minerals: []
        },
        sodium: "Not available",
        cholesterol: "Not available"
      },
      ingredients: [],
      allergens: [],
      dietaryInfo: {
        vegetarian: null,
        vegan: null,
        glutenFree: null,
        dairyFree: null
      },
      healthInsights: "Unable to extract nutrition data from web search",
      dataSource: "fallback",
      confidence: "Low",
      enhanced: false,
      source: 'web_search_fallback',
      processedAt: new Date().toISOString()
    };
  }

  /**
   * Search for ingredient information
   * @param {Array} ingredients - List of ingredients
   * @returns {Object} Enhanced ingredient data
   */
  async searchIngredientData(ingredients) {
    if (!this.enabled || !ingredients || ingredients.length === 0) {
      return null;
    }

    try {
      console.log(`🔍 Searching for ingredient data: ${ingredients.join(', ')}`);
      
      const ingredientData = {};
      
      // Process each ingredient (limit to first 5 to avoid rate limits)
      const ingredientsToProcess = ingredients.slice(0, 5);
      
      for (const ingredient of ingredientsToProcess) {
        try {
          const data = await this.searchNutritionData(ingredient);
          if (data) {
            ingredientData[ingredient] = data;
          }
          // Add delay between requests to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.warn(`Failed to search for ingredient ${ingredient}:`, error.message);
        }
      }
      
      return ingredientData;
    } catch (error) {
      console.error('Ingredient search failed:', error.message);
      return null;
    }
  }

  /**
   * Search for allergen information
   * @param {string} foodItem - Food item name
   * @returns {Array} Allergen information
   */
  async searchAllergenData(foodItem) {
    if (!this.enabled) {
      return null;
    }

    try {
      console.log(`🔍 Searching for allergen data: ${foodItem}`);
      
      const searchQuery = `${foodItem} allergens common allergies ingredients`;
      const searchResults = await this.performWebSearch(searchQuery);
      
      if (searchResults.length === 0) {
        return [];
      }

      // Use GPT-4 to extract allergen information
      const allergenData = await this.extractAllergenDataWithGPT(foodItem, searchResults);
      
      return allergenData;
    } catch (error) {
      console.error('Allergen search failed:', error.message);
      return [];
    }
  }

  /**
   * Extract allergen data using GPT-4
   * @param {string} foodItem - Food item name
   * @param {Array} searchResults - Search results
   * @returns {Array} Allergen information
   */
  async extractAllergenDataWithGPT(foodItem, searchResults) {
    try {
      const searchText = searchResults.map(result => 
        `Title: ${result.title}\nSnippet: ${result.snippet}\nURL: ${result.link}\n`
      ).join('\n---\n');

      const prompt = `Analyze the following web search results for "${foodItem}" and extract allergen information.

SEARCH RESULTS:
${searchText}

TASK: Extract all potential allergens and allergy-related information for this food item.

Common allergens to look for:
- Milk/Dairy
- Eggs
- Fish
- Shellfish
- Tree nuts
- Peanuts
- Wheat/Gluten
- Soy
- Sesame

Format your response as a JSON array of allergens:
[
  {
    "allergen": "string",
    "risk": "High/Medium/Low",
    "description": "string"
  }
]

If no allergens are found, return an empty array.`;

      let response;
      
      if (this.azureClient) {
        // Use Azure OpenAI
        response = await this.azureClient.getChatCompletions(
          process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
          [
            {
              role: "system",
              content: "You are a food safety expert. Extract allergen information from web search results."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          {
            maxTokens: 1000,
            temperature: 0.1,
          }
        );
      } else {
        // Use standard OpenAI
        response = await this.openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content: "You are a food safety expert. Extract allergen information from web search results."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          max_tokens: 1000,
          temperature: 0.1,
        });
      }

      const analysisText = response.choices[0].message.content;
      
      try {
        const jsonMatch = analysisText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        } else {
          return JSON.parse(analysisText);
        }
      } catch (parseError) {
        console.error('Failed to parse allergen data:', parseError);
        return [];
      }

    } catch (error) {
      console.error('GPT-4 allergen extraction failed:', error.message);
      return [];
    }
  }

  /**
   * Enable or disable web search
   * @param {boolean} enabled - Whether to enable web search
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`Web search ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get search API status
   * @returns {Object} Status of configured search APIs
   */
  getSearchApiStatus() {
    const status = {};
    
    for (const [name, config] of Object.entries(this.searchApis)) {
      status[name] = {
        enabled: config.enabled,
        configured: !!(config.apiKey && config.enabled)
      };
    }
    
    return status;
  }
}

// Create singleton instance
const webSearchService = new WebSearchService();

module.exports = webSearchService;
