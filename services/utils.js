export class Utils {
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

  static formatSearchResultsForLLM(results, maxResults = 5, maxSnippetLen = 300) {
    return results
      .slice(0, maxResults)
      .map((r, i) => {
        const snippet = (r.snippet || "").replace(/\s+/g, " ").trim().slice(0, maxSnippetLen);
        return `${i + 1}. Title: ${r.title}\n   Snippet: ${snippet}\n   URL: ${r.link}`;
      })
      .join("\n\n");
  }

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
