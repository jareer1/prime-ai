import { OpenAIService } from "./openai.js";
import { BraveSearchService } from "./brave.js";
import { WebScrapingService } from "./scraper.js";
import { Utils } from "./utils.js";

export class ImageAnalysisService {
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
  "net_weight": integer|null,
  "barcode_or_upc": string|null,
  "visible_text": string[],
  "confidence": "high"|"medium"|"low"
}

Rules:
- net_weight MUST be an integer number of grams; if unknown, use 0.`
          },
          {
            type: "image_url",
            image_url: { url: imageUrl }
          }
        ]
      }
    ]);

    return Utils.extractJsonFromText(response.choices[0].message.content) || { product_name: null, brand: null };
  }

  static buildSearchQuery(productData) {
    const brand = productData.brand?.toString()?.trim() || "";
    const pname = productData.product_name?.toString()?.trim() || "";
    const barcode = productData.barcode_or_upc?.toString()?.trim() || "";

    let primaryQuery = [brand, pname].filter(Boolean).join(" ").trim();

    if (!primaryQuery && barcode) primaryQuery = barcode;
    if (!primaryQuery) primaryQuery = (productData.visible_text || []).slice(0, 4).join(" ").trim();

    return (" nutrition facts, ingredients for " + primaryQuery).trim();
  }

  static async performWebSearch(primaryQuery, productData) {
    const allResults = [];

    try {
      allResults.push({ query: primaryQuery, results: await BraveSearchService.search(primaryQuery, 8) });
    } catch (error) {
      const pname = productData.product_name?.toString()?.trim() || "";
      if (pname && pname !== primaryQuery) {
        const fallbackQuery = `${pname} nutrition facts ingredients`;
        try {
          await new Promise(resolve => setTimeout(resolve, 400));
          allResults.push({ query: fallbackQuery, results: await BraveSearchService.search(fallbackQuery, 8) });
        } catch {}
      }
      const barcode = productData.barcode_or_upc?.toString()?.trim() || "";
      if (barcode && allResults.length === 0) {
        try {
          await new Promise(resolve => setTimeout(resolve, 400));
          allResults.push({ query: barcode + " nutrition facts", results: await BraveSearchService.search(barcode, 8) });
        } catch {}
      }
    }

    return allResults.flatMap(group => group.results || []);
  }
}

export class ComprehensiveAnalysisService {
  static async analyzeComprehensive(productData, searchResults) {
    const topResults = searchResults.slice(0, 6);

    const scrapedContent = await WebScrapingService.scrapeMultipleUrls(topResults, 5);
    const scrapedBlock = Utils.formatScrapedContentForLLM(scrapedContent, 5);

    const systemPrompt = `You are a nutrition analyst. Given the photo of a food item, perform ALL of the following steps and return results in JSON only:

1. Processing Check

Classify the food as:

✅ Whole (minimally processed)

⚠ Processed (heavily processed)

2. Brand & Label Detection

Identify the brand name if visible.

If no brand is detected, use "Unknown".

If no verified nutrition label is visible, estimate macros.

3. Macro Balance Analysis

Estimate total calories and macronutrient split (grams + % of protein, fat, carbs).

Compare against testosterone-supportive macro balance:

Protein: 20–30%

Fat: 30–40%

Carbs: 30–40%

Output a Macro Balance Score (0–100) with traffic light:

🟢 good

🟡 moderate

🔴 poor

4. Ingredient Hormone Disruptor Scan

Review all listed ingredients one by one.

Flag disruptors under these categories:

Seed Oils (❌ high risk):

canola, soybean, sunflower, safflower, cottonseed, corn, grapeseed, palm kernel oil.

Soy & Derivatives (❌):

soy protein isolate, soy lecithin, soy flour.

Added Sugars (⚠ / ❌):

cane sugar, organic cane sugar, corn syrup, glucose syrup, high-fructose corn syrup, maltodextrin.

Refined Carbs (⚠ / ❌):

white flour, enriched wheat flour, potato starch, corn starch, rice flour.

Artificial Sweeteners (⚠ / ❌):

aspartame, sucralose, saccharin.

Sugar Alcohols (⚠ moderate):

maltitol, sorbitol, xylitol, erythritol.

Additives & Preservatives (⚠ / ❌ depending on load):

artificial colors (Red 40, Yellow 5, Blue 1)

preservatives (BHT, TBHQ, sodium benzoate, nitrates/nitrites)

emulsifiers/thickeners (carrageenan, polysorbate 80, gums in excess)

vague “natural flavors”.

Packaging Leach Risks (❌ if stated):

BPA, phthalates.

Ingredient Risk Classification

✅ No disruptors

⚠ Possible disruptors (mild/moderate risk)

❌ High disruptors (multiple or strong disruptors present)

⚡ Always list every disruptor found under "disruptors_found".

5. Testosterone Score

Combine Macro Balance Score (50%) and Ingredient Risk (50%):

✅ = 100

⚠ = 65

❌ = 20

Output a Final Testosterone Score (0–100) with category:

🟢 Excellent (85–100)

🟡 Moderate (60–84)

🔴 Poor (0–59)

IMPORTANT numeric formatting:
- All quantities (calories, grams, milligrams, macro values, scores) MUST be numbers (decimals allowed), NOT strings, and MUST NOT include units in the values.
- If a quantity is not available or unknown, use 0 (not null).
- serving_size MUST be an integer (grams); if unknown, use 0.
- product_info.net_weight MUST be an integer (grams); if unknown, use 0.

{
    "product_info": {
      "product_name": "<product name or Unknown>",
      "brand": "<brand name or Unknown>",
      "net_weight": <net_weight_g or 0>,
      "barcode_or_upc": null,
      "visible_text": []
    },
    "nutrition_facts": {
      "serving_size": <serving_size_g or 0>,
      "calories": <nutrition.calories or 0>,
      "total_fat": <nutrition.fat_g or 0>,
      "saturated_fat": <saturated_fat_g or 0>,
      "trans_fat": <trans_fat_g or 0>,
      "cholesterol": <cholesterol_mg or 0>,
      "sodium": <sodium_mg or 0>,
      "total_carbohydrate": <nutrition.carbs_g or 0>,
      "dietary_fiber": <fiber_g or 0>,
      "total_sugars": <sugar_g or 0>,
      "added_sugars": <added_sugar_g or 0>,
      "protein": <nutrition.protein_g or 0>,
      "vitamin_d": <vitamin_d_mcg or 0>,
      "calcium": <calcium_mg or 0>,
      "iron": <iron_mg or 0>,
      "potassium": <potassium_mg or 0>
    },
    "ingredients": [
      /* Optional: expand into objects like
      {
        "text": "<ingredient name>",
        "testosterone_impact": "positive | neutral | negative",
        "notes": "<short reason>"
      }
      */
    ],
    "allergens": [],
    "seed_oils": [],
    "processed_profile": {
      "score": <processed_profile_score>,
      "level": "<Low | Medium | High>",
      "added_synthetic_sugars": [],
      "additives": [],
      "refined_carbs": []
    },
    "estrogenic_compounds": [],
    "microplastics": [],
    "t_score_impact": {
      "label": "<map from testosterone_score.label: 🟢→Good, 🟡→Moderate, 🔴→Poor>",
      "score_perc": <testosterone_score.score>,
      "macro_balance": "<map from macro_balance_score.label: 🟢→Good, 🟡→Moderate, 🔴→Poor>",
      "hormone_disruptor": <count_of_disruptors>
    },
    "macros": {
      "protein_g": <nutrition.protein_g or 0>,
      "carbs": {
        "fiber_g": <fiber_g or 0>,
        "sugar_g": <sugar_g or 0>,
        "added_sugar_g": <added_sugar_g or 0>
      },
      "fats": {
        "saturated_g": <saturated_fat_g or 0>,
        "trans_g": <trans_fat_g or 0>
      },
      "cholesterol_mg": <cholesterol_mg or 0>
    },
    "sources": []
  },
  "debug": {
    "mapping_notes": {
      "from_processing": "processing → processed_profile.level/score",
      "from_brand": "brand → product_info.brand",
      "from_nutrition": "nutrition.{calories,protein_g,fat_g,carbs_g} → nutrition_facts + macros",
      "from_macro_balance_score": "macro_balance_score.label → t_score_impact.macro_balance",
      "from_ingredient_risk": "ingredient_risk.disruptors_found → t_score_impact.hormone_disruptor (count), also populate seed_oils/additives/refined_carbs/estrogenic_compounds when applicable",
      "from_testosterone_score": "testosterone_score.score/label → t_score_impact.score_perc/label"
    },
    "scoring_method": {
      "equal_weight_rule": "testosterone_score.score = average( macro_balance_subscore , disruptor_subscore )",
      "macro_balance_subscore": "<use macro_balance_score.score>",
      "disruptor_subscore": "<100 if ingredient_risk.level=='✅', 50 if '⚠', 0 if '❌'; or scale down with count/severity>",
      "notes": "Equal impact between macro balance and hormone disruptors, as requested."
    },
    "original_fields_snapshot": {
      "processing": "<processing>",
      "macro_balance_score": {
        "score": "<macro_balance_score.score>",
        "label": "<macro_balance_score.label>"
      },
      "ingredient_risk": {
        "level": "<ingredient_risk.level>",
        "disruptors_found": ["<...>"]
      },
      "testosterone_score": {
        "score": "<testosterone_score.score>",
        "label": "<testosterone_score.label>"
      }
    }
  }
`;

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
