const OpenAI = require('openai');
const { OpenAIClient, AzureKeyCredential } = require('@azure/openai');
const axios = require('axios');
const webSearchService = require('./webSearch');

// Initialize OpenAI client (supports both OpenAI and Azure OpenAI)
let openai;
let azureClient;

if (process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_ENDPOINT) {
  // Use Azure OpenAI
  console.log('🤖 Initializing Azure OpenAI client...');
  console.log(`🔧 Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT}`);
  console.log(`🔧 Deployment: ${process.env.AZURE_OPENAI_DEPLOYMENT}`);
  
  azureClient = new OpenAIClient(
    process.env.AZURE_OPENAI_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_OPENAI_API_KEY)
  );
  console.log('✅ Azure OpenAI client initialized successfully');
} else if (process.env.OPENAI_API_KEY) {
  // Use standard OpenAI
  console.log('🤖 Initializing standard OpenAI client...');
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  console.log('✅ Standard OpenAI client initialized successfully');
} else {
  // No API key configured - will be handled in the analyzeFoodImage function
  console.warn('⚠️ No OpenAI API key configured. Food analysis will not work.');
}

/**
 * Analyzes a food image using GPT-4 Vision to extract nutrition facts and ingredients
 * @param {string} imageUrl - URL of the food image to analyze
 * @returns {Object} Analysis results with nutrition facts and ingredients
 */
async function analyzeFoodImage(imageUrl) {
  try {
    // Validate the image URL is accessible
    await validateImageUrl(imageUrl);
    console.log('Image URL validated successfully');
    console.log('Image URL:', imageUrl);
    // Create the prompt for food analysis
    const systemPrompt = `You are a professional nutritionist and food analyst. Your task is to analyze food images and provide detailed nutrition information and ingredients.

IMPORTANT INSTRUCTIONS:
1. Identify the food item(s) in the image
2. Provide comprehensive nutrition facts including:
   - Calories per serving
   - Macronutrients (protein, carbohydrates, fat)
   - Micronutrients (vitamins, minerals)
   - Fiber content
   - Sugar content
   - Sodium content
3. List all visible ingredients in order of prominence
4. If nutrition label is visible, extract exact values
5. If no nutrition label is visible, provide estimated values based on typical serving sizes
6. Include serving size information
7. Note any allergens or dietary restrictions
8. Provide health insights and recommendations

Format your response as structured JSON with the following structure:
{
  "foodItem": "Name of the food item",
  "nutritionFacts": {
    "servingSize": "Serving size information",
    "calories": "Calories per serving",
    "macronutrients": {
      "protein": "Protein content",
      "carbohydrates": "Carbohydrate content", 
      "fat": "Fat content",
      "fiber": "Fiber content",
      "sugar": "Sugar content"
    },
    "micronutrients": {
      "vitamins": ["List of vitamins"],
      "minerals": ["List of minerals"]
    },
    "sodium": "Sodium content",
    "cholesterol": "Cholesterol content if applicable"
  },
  "ingredients": ["List of ingredients in order"],
  "allergens": ["List of potential allergens"],
  "dietaryInfo": {
    "vegetarian": true/false,
    "vegan": true/false,
    "glutenFree": true/false,
    "dairyFree": true/false
  },
  "healthInsights": "Brief health insights and recommendations",
  "confidence": "High/Medium/Low - confidence level in the analysis"
}`;

    // Check if we have a valid client
    if (!azureClient && !openai) {
      throw new Error('No OpenAI API key configured. Please set either OPENAI_API_KEY or AZURE_OPENAI_API_KEY in your .env file.');
    }

    // Make the API call to OpenAI
    let response;
    
    if (azureClient) {
      // Use Azure OpenAI
      console.log(`🔧 Using Azure OpenAI deployment: ${process.env.AZURE_OPENAI_DEPLOYMENT}`);
      console.log(`🔧 Azure OpenAI endpoint: ${process.env.AZURE_OPENAI_ENDPOINT}`);
      
      response = await azureClient.getChatCompletions(
        process.env.AZURE_OPENAI_DEPLOYMENT,
        [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please analyze this food image and provide detailed nutrition facts and ingredients in the specified JSON format."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ],
        {
          maxTokens: 2000,
          temperature: 0.1, // Low temperature for more consistent results
        }
      );
    } else {
      // Use standard OpenAI
      response = await openai.chat.completions.create({
        model: "gpt-4-vision-preview",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please analyze this food image and provide detailed nutrition facts and ingredients in the specified JSON format."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ],
        max_tokens: 2000,
        temperature: 0.1, // Low temperature for more consistent results
      });
    }

    const analysisText = azureClient 
      ? response.choices[0].message.content 
      : response.choices[0].message.content;
    
    // Try to parse the JSON response
    let analysis;
    try {
      // Extract JSON from the response (in case there's additional text)
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        analysis = JSON.parse(analysisText);
      }
    } catch (parseError) {
      console.error('Failed to parse JSON response:', parseError);
      // Return a structured error response
      return {
        foodItem: "Unknown",
        nutritionFacts: {
          servingSize: "Unable to determine",
          calories: "Unable to determine",
          macronutrients: {
            protein: "Unable to determine",
            carbohydrates: "Unable to determine",
            fat: "Unable to determine",
            fiber: "Unable to determine",
            sugar: "Unable to determine"
          },
          micronutrients: {
            vitamins: [],
            minerals: []
          },
          sodium: "Unable to determine",
          cholesterol: "Unable to determine"
        },
        ingredients: [],
        allergens: [],
        dietaryInfo: {
          vegetarian: null,
          vegan: null,
          glutenFree: null,
          dairyFree: null
        },
        healthInsights: "Analysis failed - unable to parse response",
        confidence: "Low",
        rawResponse: analysisText
      };
    }

    // Enhance with web search data if enabled
    if (webSearchService.enabled && analysis.foodItem && analysis.foodItem !== "Unknown") {
      try {
        console.log('🔍 Enhancing analysis with web search data...');
        
        // Search for additional nutrition data
        const webNutritionData = await webSearchService.searchNutritionData(analysis.foodItem);
        
        // Search for ingredient data
        const ingredientData = await webSearchService.searchIngredientData(analysis.ingredients);
        
        // Search for allergen data
        const allergenData = await webSearchService.searchAllergenData(analysis.foodItem);
        
        // Merge web search data with analysis
        if (webNutritionData && webNutritionData.enhanced) {
          // Enhance the main analysis with web search data
          analysis.webSearchData = webNutritionData;
          
          // If web search provides better data, use it to enhance the main analysis
          if (webNutritionData.nutritionFacts && webNutritionData.confidence === "High") {
            // Merge nutrition facts (web search takes precedence if confidence is high)
            analysis.nutritionFacts = {
              ...analysis.nutritionFacts,
              ...webNutritionData.nutritionFacts
            };
          }
          
          // Merge ingredients if web search has more complete data
          if (webNutritionData.ingredients && webNutritionData.ingredients.length > analysis.ingredients.length) {
            analysis.ingredients = webNutritionData.ingredients;
          }
          
          // Merge allergens
          if (webNutritionData.allergens && webNutritionData.allergens.length > 0) {
            analysis.allergens = [...new Set([...analysis.allergens, ...webNutritionData.allergens])];
          }
          
          // Update dietary info if web search provides it
          if (webNutritionData.dietaryInfo) {
            analysis.dietaryInfo = {
              ...analysis.dietaryInfo,
              ...webNutritionData.dietaryInfo
            };
          }
          
          // Enhance health insights
          if (webNutritionData.healthInsights) {
            analysis.healthInsights = `${analysis.healthInsights} ${webNutritionData.healthInsights}`;
          }
          
          // Update confidence level
          if (webNutritionData.confidence === "High") {
            analysis.confidence = "High";
          }
        }
        
        if (ingredientData) {
          analysis.ingredientDetails = ingredientData;
        }
        
        if (allergenData && allergenData.length > 0) {
          analysis.enhancedAllergens = allergenData;
        }
        
        console.log('✅ Web search enhancement completed');
      } catch (webSearchError) {
        console.warn('⚠️ Web search enhancement failed:', webSearchError.message);
        // Continue with original analysis if web search fails
      }
    }

    return analysis;

  } catch (error) {
    console.error('Error in food analysis:', error);
    throw new Error(`Food analysis failed: ${error.message}`);
  }
}

/**
 * Validates that the image URL is accessible
 * @param {string} imageUrl - URL to validate
 */
async function validateImageUrl(imageUrl) {
  try {
    const response = await axios.head(imageUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const contentType = response.headers['content-type'];
    if (!contentType || !contentType.startsWith('image/')) {
      throw new Error('URL does not point to a valid image');
    }
  } catch (error) {
    throw new Error(`Invalid or inaccessible image URL: ${error.message}`);
  }
}

module.exports = {
  analyzeFoodImage
};
