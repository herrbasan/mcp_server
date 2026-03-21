export class GoogleSearchScraper {
  constructor() {
    this.name = 'GoogleSearchScraper';
    this.domains = ['google.com', 'google.de', 'google.co.uk'];
  }

  canHandle(url) {
    return this.domains.some(domain => url.includes(domain) && url.includes('/search'));
  }

  async scrape(url, page) {
    const urlObj = new URL(url);
    const query = urlObj.searchParams.get('q');
    
    if (!query) {
      throw new Error('No search query found in Google URL');
    }

    await page.goto('https://www.google.com?hl=en&gl=us', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    await this.randomDelay(800, 1500);

    await this.handleCookieDialog(page);

    await this.randomDelay(500, 1200);
    
    const searchBox = await page.$('textarea[name="q"], input[name="q"]');
    if (!searchBox) {
      throw new Error('Google search box not found');
    }

    await searchBox.click();
    await page.keyboard.type(query, { delay: 50 + Math.random() * 100 });
    
    await this.randomDelay(300, 800);
    
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });

    return await page.content();
  }

  async handleCookieDialog(page) {
    const selectors = [
      'button[id="L2AGLb"]',
      'button:contains("Accept all")',
      'button:contains("Alle akzeptieren")',
      'div[role="dialog"] button:nth-of-type(2)'
    ];

    for (const selector of selectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click();
          await this.randomDelay(1000, 2000);
          return;
        }
      } catch (e) {
        // Try next
      }
    }
  }

  randomDelay(min, max) {
    return new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));
  }
}
