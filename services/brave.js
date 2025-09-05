import fetch from "node-fetch";
import config from "../config.js";

export class BraveSearchService {
  static async search(query, count = 6) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
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
  }
}
