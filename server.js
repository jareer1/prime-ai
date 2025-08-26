// server.mjs
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();
const app = express();
app.use(express.json({ limit: "1mb" }));

// ------------------
// ENV CONFIG
// ------------------
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT; 
const AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT; 
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

const client = new OpenAI({
  apiKey: AZURE_OPENAI_KEY,
  baseURL: `${AZURE_OPENAI_ENDPOINT.replace(/\/+$/, "")}/openai/deployments/${encodeURIComponent(AZURE_OPENAI_DEPLOYMENT)}`,
  defaultQuery: { "api-version": process.env.AZURE_OPENAI_API_VERSION },
  defaultHeaders: { "api-key": AZURE_OPENAI_KEY }
});

// ------------------
// Helpers
// ------------------
function extractJsonFromText(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

async function braveSearch(query, count = 6) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const r = await fetch(url, {
    headers: { "X-Subscription-Token": BRAVE_API_KEY }
  });

  if (!r.ok) {
    throw new Error(`Brave API error: ${r.status} ${await r.text()}`);
  }

  const data = await r.json();
  return (data.web?.results || []).map(item => ({
    title: item.title || "",
    link: item.url || "",
    snippet: item.description || ""
  }));
}

function pickNutritionAndIngredients(results) {
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

// ------------------
// Endpoint
// ------------------
app.post("/analyze-image", async (req, res) => {
  try {
    const { imageUrl } = req.body;
    console.log('Image URL:', imageUrl);
    if (!imageUrl) return res.status(400).json({ error: "imageUrl required" });
    console.log('AZURE_OPENAI_DEPLOYMENT:', AZURE_OPENAI_DEPLOYMENT);
    console.log('AZURE_OPENAI_ENDPOINT:', AZURE_OPENAI_ENDPOINT);
    console.log('AZURE_OPENAI_KEY:', AZURE_OPENAI_KEY);
    console.log('AZURE_OPENAI_API_VERSION:', AZURE_OPENAI_API_VERSION);
    const response = await client.chat.completions.create({
      model: AZURE_OPENAI_DEPLOYMENT, // deployment name from Azure portal
      messages: [
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
      ]
    });
    
    // 1) Analyze product with Azure OpenAI
    console.log('Response:', response);
    const productData = extractJsonFromText(response.choices[0].message.content) || { product_name: null, brand: null };
    console.log('Product data:', productData);

    // 2) Build a single combined search query (brand + product)
    const brand = productData.brand?.toString()?.trim() || "";
    const pname = productData.product_name?.toString()?.trim() || "";
    const barcode = productData.barcode_or_upc?.toString()?.trim() || "";

    // Prefer brand + product. If missing brand, use product only. Always include "nutrition facts ingredients".
    let primaryQuery = [brand, pname].filter(Boolean).join(" ").trim();
    if (!primaryQuery && barcode) {
      primaryQuery = barcode; // fallback to barcode only
    }
    if (!primaryQuery) {
      // final fallback: visible_text joined
      primaryQuery = (productData.visible_text || []).slice(0, 4).join(" ").trim();
    }
    primaryQuery = (" nutrition facts, ingredients for "+primaryQuery ).trim();

    // 3) Query Brave once (with a small retry/fallback if no results)
    let allResults = [];
    try {
      allResults.push({ query: primaryQuery, results: await braveSearch(primaryQuery, 8) });
    } catch (err) {
      console.warn("Primary Brave search failed:", err.message);
      // Optional: fallback to a simpler query (product only)
      if (pname && pname !== primaryQuery) {
        const fallbackQ = `${pname} nutrition facts ingredients`;
        try {
          await new Promise(r => setTimeout(r, 400)); // small delay
          allResults.push({ query: fallbackQ, results: await braveSearch(fallbackQ, 8) });
        } catch (err2) {
          console.warn("Fallback Brave search failed:", err2.message);
        }
      }
      // Optional: try barcode if present
      if (barcode && allResults.length === 0) {
        try {
          await new Promise(r => setTimeout(r, 400));
          allResults.push({ query: barcode + " nutrition facts", results: await braveSearch(barcode, 8) });
        } catch (err3) {
          console.warn("Barcode Brave search failed:", err3.message);
        }
      }
    }

    // flatten and pick
    const flatResults = allResults.flatMap(g => g.results || []);
    const picked = pickNutritionAndIngredients(flatResults);

    // --------- add helper (if not present) ----------
    function formatSearchResultsForLLM(results, maxResults = 5, maxSnippetLen = 300) {
      return results
        .slice(0, maxResults)
        .map((r, i) => {
          const snippet = (r.snippet || "").replace(/\s+/g, " ").trim().slice(0, maxSnippetLen);
          return `${i + 1}. Title: ${r.title}\n   Snippet: ${snippet}\n   URL: ${r.link}`;
        })
        .join("\n\n");
    }
    // -------------------------------------------------

    // --- insert after you build flatResults & picked ---
    const topResults = flatResults.slice(0, 6); // take top 6 raw results
    const searchBlock = formatSearchResultsForLLM(topResults, 6, 300);

    // Fetch page content for top results
    async function fetchPageText(url, maxLen = 4000) {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Bot/1.0; +https://example.com/bot)" }
        });
        if (!resp.ok) return null;
        const html = await resp.text();

        let cheerio;
        try { cheerio = (await import('cheerio')).default; } catch (e) { return null; }

        const $ = cheerio.load(html);
        const pageTextParts = [];

        // 1) Elements that contain 'Ingredients' label
        $('*:contains("Ingredients")').each((i, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (/Ingredients?:/i.test(text)) {
            let block = text;
            const next = $(el).next();
            if (next && next.length) block += ' ' + $(next).text().replace(/\s+/g, ' ').trim();
            pageTextParts.push(block);
          }
        });

        // 2) 'Nutrition Facts' or 'Nutrition' headings -> capture table or surrounding text
        $('*:contains("Nutrition Facts"), *:contains("Nutrition")').each((i, el) => {
          const text = $(el).text().replace(/\s+/g, ' ').trim();
          if (/Nutrition Facts|Nutrition:/i.test(text)) {
            const tbl = $(el).next('table');
            let block = text;
            if (tbl && tbl.length) {
              block += ' ' + tbl.text().replace(/\s+/g, ' ').trim();
            } else {
              let sib = $(el).next();
              let collected = 0;
              while (sib && sib.length && collected < 3) {
                block += ' ' + $(sib).text().replace(/\s+/g, ' ').trim();
                sib = sib.next();
                collected++;
              }
            }
            pageTextParts.push(block);
          }
        });

        return pageTextParts.join('\n\n').slice(0, maxLen);
      } catch (err) {
        console.warn(`Failed to fetch page content from ${url}:`, err.message);
        return null;
      }
    }

    // Fetch page content for top 3 results
    
    // Enhanced system prompt with structured schema
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
- Return only valid JSON, no other text
`;
    console.log('enhancedSearchBlock',searchBlock)

    const userPrompt = `Here's the product information from the image: ${JSON.stringify(productData)}

Below are web search results and page content that might contain nutrition information:

${searchBlock}

Please analyze this information and extract any nutrition facts and ingredients you can find. If you don't find specific information, you can use your general knowledge about similar products. Return your response as JSON.`;

    let finalExtract = null;
    try {
      const llmResp = await client.chat.completions.create({
        model: AZURE_OPENAI_DEPLOYMENT,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 1000
      });

      const llmRaw = llmResp.choices?.[0]?.message?.content || "";
      finalExtract = extractJsonFromText(llmRaw);

      if (!finalExtract) {
        // model did not return strict JSON: return helpful debug info
        return res.json({
          productData,
          searchQuery: primaryQuery,
          searchResults: topResults,
          llmRaw,
          note: "LLM did not return valid JSON. See llmRaw for output."
        });
      }

      // Success: return parsed structured data
      return res.json({
        productData,
        searchQuery: primaryQuery,
        searchResults: topResults,
        extracted: finalExtract
      });

    } catch (err) {
      console.error("LLM extraction error:", err);
      return res.status(500).json({
        productData,
        searchQuery: primaryQuery,
        searchResults: topResults,
        error: err.message
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal_error", details: err.message });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));
