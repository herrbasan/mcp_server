export class GenericScraper {
  constructor() {
    this.name = 'GenericScraper';
  }

  canHandle(url) {
    return true;
  }

  async scrape(url, page) {
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 10000
      });
    } catch (err) {
      if (err.name === 'TimeoutError') {
        console.error(`   [GenericScraper] Navigation timeout for ${url.substring(0, 50)}...`);
      } else {
        throw err;
      }
    }

    await Promise.race([
      new Promise(r => setTimeout(r, 200 + Math.random() * 500)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Delay timeout')), 5000))
    ]).catch(() => {});

    return await Promise.race([
      page.content(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Content extraction timeout')), 5000)
      )
    ]);
  }
}
