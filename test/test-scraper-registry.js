import { ScraperRegistry } from '../src/scrapers/index.js';
import puppeteer from 'puppeteer';

const TEST_URLS = [
  'https://www.google.com/search?q=node.js+best+practices',
  'https://en.wikipedia.org/wiki/Node.js',
  'https://nodejs.org/en/about'
];

console.log('🧪 Testing Scraper Registry\n');

const registry = new ScraperRegistry();

for (const url of TEST_URLS) {
  const scraper = registry.getScraperForUrl(url);
  console.log(`${url}`);
  console.log(`  → Scraper: ${scraper.name}\n`);
}

console.log('\n🌐 Testing actual scraping (Google search)...\n');

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled'
  ]
});

const page = await browser.newPage();

try {
  const url = 'https://www.google.com/search?q=test+query';
  console.log(`Testing: ${url}\n`);
  
  const html = await registry.scrapeUrl(url, page);
  
  console.log(`✅ Scraped ${(html.length / 1024).toFixed(1)} KB`);
  console.log(`   Title: ${html.match(/<title>(.*?)<\/title>/)?.[1] || 'N/A'}`);
  
  // Check for detection
  const detected = html.toLowerCase().includes('unusual traffic') || 
                   html.toLowerCase().includes('captcha');
  
  console.log(`   Detected: ${detected ? '❌ YES' : '✅ No'}\n`);
  
} catch (err) {
  console.error(`❌ Error: ${err.message}\n`);
} finally {
  await browser.close();
}

console.log('✅ Test complete');
