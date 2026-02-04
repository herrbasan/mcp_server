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
    // Use a shorter timeout and catch it to return partial content
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 10000
      });
    } catch (err) {
      // Navigation timeout or error - page might still have content
      if (err.name === 'TimeoutError') {
        console.error(`   [GenericScraper] Navigation timeout for ${url.substring(0, 50)}...`);
      } else {
        throw err;
      }
    }

    // Small human-like delay (but timeout-protected)
    await Promise.race([
      new Promise(r => setTimeout(r, 200 + Math.random() * 500)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Delay timeout')), 5000))
    ]).catch(() => {}); // Ignore delay timeout

    // Get content with its own timeout
    return await Promise.race([
      page.content(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Content extraction timeout')), 5000)
      )
    ]);
  }
}
