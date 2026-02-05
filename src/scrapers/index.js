import { GoogleSearchScraper } from './google-search.js';
import { GenericScraper } from './generic.js';

export class ScraperRegistry {
  constructor() {
    this.scrapers = [
      new GoogleSearchScraper(),
      new GenericScraper()
    ];
  }

  getScraperForUrl(url) {
    for (const scraper of this.scrapers) {
      if (scraper.canHandle(url)) {
        return scraper;
      }
    }
    return this.scrapers[this.scrapers.length - 1];
  }

  async scrapeUrl(url, page) {
    const scraper = this.getScraperForUrl(url);
    console.error(`   Using scraper: ${scraper.name} for ${url.substring(0, 60)}...`);
    return await scraper.scrape(url, page);
  }
}
