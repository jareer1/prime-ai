// server.mjs
import express from "express";
import config from "./config.js";
import { ImageAnalysisService, ComprehensiveAnalysisService } from "./services/analysis.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

app.post("/analyze-comprehensive", async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ error: "imageUrl is required" });
    }

    console.log('Processing comprehensive analysis for image URL:', imageUrl);

    const productData = await ImageAnalysisService.analyzeProductImage(imageUrl);

    const primaryQuery = ImageAnalysisService.buildSearchQuery(productData);
    const searchResults = await ImageAnalysisService.performWebSearch(primaryQuery, productData);

    const comprehensiveResult = await ComprehensiveAnalysisService.analyzeComprehensive(productData, searchResults);

    if (!comprehensiveResult) {
      return res.status(500).json({
        error: "Failed to parse comprehensive analysis response",
        productData,
        searchQuery: primaryQuery,
        searchResults: searchResults.slice(0, 6)
      });
    }

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

app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: "internal_server_error", message: "An unexpected error occurred" });
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found", message: "Endpoint not found" });
});

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  console.log(`POST http://localhost:${config.port}/analyze-comprehensive`);
});
