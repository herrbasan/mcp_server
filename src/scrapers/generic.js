// Generic scraper - direct navigation for most sites

export class GenericScraper {
  constructor() {
    this.name = 'GenericScraper';
  }

  canHandle(url) {
    // Generic scraper handles everything
    return true;
  }

  async scrape(url, page) {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    // Small human-like delay
    await new Promise(r => setTimeout(r, 200 + Math.random() * 500));

    return await page.content();
  }
}
