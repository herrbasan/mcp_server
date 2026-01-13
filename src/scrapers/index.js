// Scraper registry - matches URLs to specialized scrapers

import { GoogleSearchScraper } from './google-search.js';
import { GenericScraper } from './generic.js';

export class ScraperRegistry {
  constructor() {
    // Order matters - first match wins
    this.scrapers = [
      new GoogleSearchScraper(),
      new GenericScraper()  // Fallback
    ];
  }

  getScraperForUrl(url) {
    for (const scraper of this.scrapers) {
      if (scraper.canHandle(url)) {
        return scraper;
      }
    }
    return this.scrapers[this.scrapers.length - 1]; // Fallback to generic
  }

  async scrapeUrl(url, page) {
    const scraper = this.getScraperForUrl(url);
    console.error(`   Using scraper: ${scraper.name} for ${url.substring(0, 60)}...`);
    return await scraper.scrape(url, page);
  }
}
