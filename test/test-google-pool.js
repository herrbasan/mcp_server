import puppeteer from 'puppeteer';

const QUERY = process.argv[2] || 'what is quantum computing';
const POOL_SIZE = 3; // Number of browser contexts to keep open

console.log('\n🔍 Testing Google AI Overview Extraction (Browser Pool)');
console.log(`Query: "${QUERY}"`);
console.log(`Pool size: ${POOL_SIZE} contexts\n`);

// Browser pool manager
class BrowserPool {
  constructor() {
    this.browser = null;
    this.contexts = [];
    this.available = [];
  }

  async initialize(size) {
    console.log('🌐 Initializing browser pool...');
    
    // Use single browser with multiple incognito contexts
    // Each context is isolated but shares the browser process
    this.browser = await puppeteer.launch({
      headless: false,
      devtools: true,
      slowMo: 100,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null
    });

    // Create multiple incognito contexts (isolated sessions)
    for (let i = 0; i < size; i++) {
      const context = await this.browser.createBrowserContext();
      const page = await context.newPage();
      
      // Set random viewport per context
      await page.setViewport({
        width: 1280 + Math.floor(Math.random() * 200),
        height: 800 + Math.floor(Math.random() * 200)
      });

      const ctx = { id: i, context, page, busy: false };
      this.contexts.push(ctx);
      this.available.push(ctx);
      
      console.log(`   ✅ Context ${i} created (incognito)`);
    }
    
    console.log(`✅ Pool initialized with ${size} incognito contexts\n`);
  }

  async acquire() {
    while (this.available.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const ctx = this.available.shift();
    ctx.busy = true;
    return ctx;
  }

  release(ctx) {
    ctx.busy = false;
    this.available.push(ctx);
  }

  async close() {
    console.log('\n🔒 Closing browser pool...');
    if (this.browser) {
      for (const ctx of this.contexts) {
        await ctx.context.close();
      }
      await this.browser.close();
      console.log('✅ Pool closed cleanly');
    }
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pasteQuery(page, query) {
  console.log('   ⌨️  Pasting query (instant like Ctrl+V)');
  
  // Find search input and set value directly (simulates paste)
  await page.evaluate((q) => {
    const input = document.querySelector('textarea[name="q"], input[name="q"]');
    if (input) {
      input.value = q;
      // Trigger input event so Google knows value changed
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, query);
  
  await sleep(200); // Brief pause after "paste"
}

async function searchGoogle(pool, query) {
  const ctx = await pool.acquire();
  console.log(`\n🔎 Context ${ctx.id}: Searching for "${query}"`);
  
  try {
    const { page } = ctx;
    
    // Navigate to Google (only needed first time per context)
    if (page.url() === 'about:blank') {
      console.log(`   📍 Navigating to google.com`);
      await page.goto('https://www.google.com', { waitUntil: 'networkidle2' });
      await sleep(500);
    }
    
    // Click search box
    console.log('   🖱️  Clicking search box');
    const searchBox = await page.waitForSelector('textarea[name="q"], input[name="q"]');
    await searchBox.click({ clickCount: 3 }); // Triple-click to select all
    await sleep(100);
    
    // Paste query (instant, like Ctrl+V)
    await pasteQuery(page, query);
    
    // Press Enter
    console.log('   ⏎  Pressing Enter');
    const navigationPromise = page.waitForNavigation({ 
      waitUntil: 'domcontentloaded', 
      timeout: 10000 
    }).catch(err => {
      console.log('   ⚠️  Navigation timeout (might be okay)');
      return null;
    });
    
    await page.keyboard.press('Enter');
    await navigationPromise;
    
    // Wait a bit for results to render
    await sleep(2000);
    
    console.log(`   📍 Current URL: ${page.url()}`);
    console.log('   ✅ Results loaded');
    
    // Extract AI Overview
    const aiOverview = await extractAIOverview(page);
    
    if (aiOverview) {
      console.log(`\n   📊 AI Overview found (${aiOverview.text.length} chars)`);
      console.log(`   Selector: ${aiOverview.selector}`);
      console.log(`   Preview: ${aiOverview.text.substring(0, 200)}...`);
    } else {
      console.log('\n   ⚠️  No AI Overview found');
    }
    
    return aiOverview;
    
  } finally {
    pool.release(ctx);
    console.log(`   🔓 Context ${ctx.id} released`);
  }
}

async function extractAIOverview(page) {
  // Try multiple selectors for AI Overview (query-dependent format)
  const selectors = [
    '[jscontroller="SC7lYd"]',           // Compact format (programming topics)
    '[data-hveid][data-ved] > div > div:first-child', // Detailed format (science topics)
    '#rso > div:first-child > div:first-child',       // Alternative structural
    '.wHYlTd.Ww4FFb.tF2Cxc.asEBEc.vt6azd'             // Class-based (unstable)
  ];
  
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (!element) continue;
      
      const text = await element.evaluate(el => el.textContent.trim());
      
      // AI Overviews are substantial (>100 chars) and unique
      if (text.length > 100 && !text.includes('Sign in')) {
        return { selector, text };
      }
    } catch (e) {
      // Selector failed, try next
    }
  }
  
  return null;
}

async function main() {
  const pool = new BrowserPool();
  
  try {
    await pool.initialize(POOL_SIZE);
    
    // Test with single query
    const result = await searchGoogle(pool, QUERY);
    
    // Demonstrate pool reuse with second query
    console.log('\n\n🔄 Testing pool reuse with different query...');
    await sleep(2000);
    const result2 = await searchGoogle(pool, 'how does async await work in javascript');
    
    console.log('\n\n✅ Test complete! Pool still open - press Ctrl+C to exit');
    
    // Keep pool open indefinitely until user closes
    await new Promise(() => {});
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    await pool.close();
  }
}

main();
