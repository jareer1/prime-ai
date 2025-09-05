import fetch from "node-fetch";

export class WebScrapingService {
  static async scrapeUrl(url, maxLength = 3000) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        },
        timeout: 10000
      });

      if (!response.ok) return null;

      const html = await response.text();
      const textContent = this.extractTextFromHTML(html);
      if (!textContent) return null;

      return { url, content: textContent.slice(0, maxLength), success: true };
    } catch (error) {
      console.warn(`Failed to scrape ${url}:`, error.message);
      return null;
    }
  }

  static extractTextFromHTML(html) {
    try {
      let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ');
      text = text.replace(/&nbsp;/g, ' ');
      text = text.replace(/&amp;/g, '&');
      text = text.replace(/&lt;/g, '<');
      text = text.replace(/&gt;/g, '>');
      text = text.replace(/&quot;/g, '"');
      text = text.replace(/&#39;/g, "'");
      text = text.replace(/\s+/g, ' ').trim();
      return text;
    } catch (error) {
      console.warn('Failed to extract text from HTML:', error.message);
      return '';
    }
  }

  static async scrapeMultipleUrls(searchResults, maxUrls = 5) {
    const urlsToScrape = searchResults.slice(0, maxUrls);
    const scrapedResults = [];

    for (const result of urlsToScrape) {
      try {
        const scrapedContent = await this.scrapeUrl(result.link);
        if (scrapedContent && scrapedContent.success) {
          scrapedResults.push({ title: result.title, url: result.link, content: scrapedContent.content });
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.warn(`Failed to scrape ${result.link}:`, error.message);
      }
    }

    return scrapedResults;
  }
}
