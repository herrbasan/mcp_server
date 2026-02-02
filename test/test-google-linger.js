import puppeteer from 'puppeteer';

const QUERY = process.argv[2] || 'what is quantum computing';
const MIN_LINGER_MS = 10000;  // 10 seconds minimum before closing tab
const MAX_LINGER_MS = 30000;  // 30 seconds maximum

console.log('\n🔍 Testing Google AI Overview Extraction (Lingering Tabs)');
console.log(`Query: "${QUERY}"`);
console.log(`Tab linger time: ${MIN_LINGER_MS/1000}-${MAX_LINGER_MS/1000}s\n`);

// Browser manager with delayed tab cleanup
class BrowserManager {
  constructor() {
    this.browser = null;
    this.pages = []; // { page, usedAt, closing, isHome }
    this.homePage = null; // Keep one permanent tab
  }

  async initialize() {
    console.log('🌐 Launching browser with persistent profile...');
    
    this.browser = await puppeteer.launch({
      headless: false,
      devtools: true,
      slowMo: 20,
      userDataDir: 'd:\\DEV\\mcp_server\\data\\chrome-profile',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--start-maximized'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null
    });
    
    console.log('✅ Browser launched\n');
    
    // Start background cleanup task
    this.startCleanupTask();
  }

  async createPage() {
    const page = await this.browser.newPage();
    
    // Set random viewport
    await page.setViewport({
      width: 1280 + Math.floor(Math.random() * 200),
      height: 800 + Math.floor(Math.random() * 200)
    });
    
    // Set realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const pageInfo = { page, usedAt: null, closing: false, isHome: false };
    this.pages.push(pageInfo);
    
    return pageInfo;
  }

  markUsed(pageInfo) {
    pageInfo.usedAt = Date.now();
    
    // Calculate random linger time
    const lingerMs = MIN_LINGER_MS + Math.random() * (MAX_LINGER_MS - MIN_LINGER_MS);
    console.log(`   ⏱️  Tab will linger for ${Math.round(lingerMs/1000)}s before closing`);
  }

  startCleanupTask() {
    setInterval(() => {
      const now = Date.now();
      
      for (const pageInfo of this.pages) {
        // Never close home page
        if (pageInfo.isHome) continue;
        
        if (pageInfo.usedAt && !pageInfo.closing) {
          const age = now - pageInfo.usedAt;
          const lingerMs = MIN_LINGER_MS + Math.random() * (MAX_LINGER_MS - MIN_LINGER_MS);
          
          if (age > lingerMs) {
            pageInfo.closing = true;
            this.closePage(pageInfo);
          }
        }
      }
    }, 5000); // Check every 5 seconds
  }

  async closePage(pageInfo) {
    try {
      const lingered = Math.round((Date.now() - pageInfo.usedAt) / 1000);
      console.log(`   🗑️  Closing tab (lingered ${lingered}s)`);
      await pageInfo.page.close();
      this.pages = this.pages.filter(p => p !== pageInfo);
    } catch (e) {
      // Already closed
    }
  }

  async close() {
    console.log('\n🔒 Closing browser gracefully...');
    if (this.browser) {
      // Give Chrome time to save session/cookies
      console.log('   ⏳ Waiting 3s for session data to save...');
      await new Promise(r => setTimeout(r, 3000));
      
      await this.browser.close();
      console.log('✅ Browser closed cleanly');
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
  
  await sleep(100); // Brief pause after "paste"
}

async function searchGoogle(manager, query) {
  const pageInfo = await manager.createPage();
  const { page } = pageInfo;
  
  console.log(`\n🔎 [Google] Searching for "${query}"`);
  
  try {
    // Navigate to Google
    console.log('   📍 Navigating to google.com');
    await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(200);
    
    // Click search box
    console.log('   🖱️  Clicking search box');
    const searchBox = await page.waitForSelector('textarea[name="q"], input[name="q"]', { timeout: 10000 });
    await searchBox.click({ clickCount: 3 }); // Triple-click to select all
    await sleep(50);
    
    // Paste query (instant, like Ctrl+V)
    await pasteQuery(page, query);
    
    // Press Enter
    console.log('   ⏎  Pressing Enter');
    await page.keyboard.press('Enter');
    
    // Wait for results
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    console.log('   ✅ Results loaded');
    
    // Extract search results
    const results = await extractGoogleResults(page);
    
    console.log(`\n   📊 Found ${results.length} Google results:\n`);
    results.forEach((result, i) => {
      console.log(`   ${i + 1}. ${result.title}`);
      console.log(`      ${result.url}`);
      console.log(`      ${result.snippet.substring(0, 150)}...`);
      console.log();
    });
    
    // Mark as used - tab will close after random delay
    manager.markUsed(pageInfo);
    
    return results;
    
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    // Close failed page immediately
    await page.close();
    manager.pages = manager.pages.filter(p => p !== pageInfo);
    throw error;
  }
}

async function searchDuckDuckGo(manager, query) {
  const pageInfo = await manager.createPage();
  const { page } = pageInfo;
  
  console.log(`\n🦆 [DuckDuckGo] Searching for "${query}"`);
  
  try {
    // Navigate to DuckDuckGo
    console.log('   📍 Navigating to duckduckgo.com');
    await page.goto('https://duckduckgo.com', { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(500);
    
    // Click search box
    console.log('   🖱️  Clicking search box');
    const searchBox = await page.waitForSelector('input[name="q"]', { timeout: 10000 });
    await searchBox.click({ clickCount: 3 }); // Triple-click to select all
    await sleep(100);
    
    // Paste query
    await page.evaluate((q) => {
      const input = document.querySelector('input[name="q"]');
      if (input) {
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, query);
    console.log('   ⌨️  Pasting query');
    await sleep(200);
    
    // Press Enter
    console.log('   ⏎  Pressing Enter');
    await page.keyboard.press('Enter');
    
    // Wait for results
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    console.log('   ✅ Results loaded');
    
    // Extract search results
    const results = await extractDuckDuckGoResults(page);
    
    console.log(`\n   📊 Found ${results.length} DuckDuckGo results:\n`);
    results.forEach((result, i) => {
      console.log(`   ${i + 1}. ${result.title}`);
      console.log(`      ${result.url}`);
      console.log(`      ${result.snippet.substring(0, 150)}...`);
      console.log();
    });
    
    // Mark as used - tab will close after random delay
    manager.markUsed(pageInfo);
    
    return results;
    
  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    // Close failed page immediately
    await page.close();
    manager.pages = manager.pages.filter(p => p !== pageInfo);
    throw error;
  }
}

async function extractGoogleResults(page) {
  const results = await page.evaluate(() => {
    const items = [];
    
    // Try multiple selectors for search results
    const selectors = [
      '.g',                    // Classic Google result
      'div[data-hveid].MjjYud', // Modern wrapper
      '.Gx5Zad.fP1Qef.xpd.EtOod.pkphOe', // Alternative
      '[jscontroller="SC7lYd"]' // Card style
    ];
    
    console.log('🔍 Trying selectors...');
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      console.log(`   ${selector}: ${elements.length} matches`);
      
      if (elements.length > 0) {
        for (const el of elements) {
          // Try multiple title selectors
          const titleEl = el.querySelector('h3') || 
                         el.querySelector('[role="heading"]') ||
                         el.querySelector('.LC20lb');
          
          // Try multiple link selectors
          const linkEl = el.querySelector('a[href]') ||
                        el.querySelector('a[jsname]');
          
          // Try multiple snippet selectors  
          const snippetEl = el.querySelector('.VwiC3b') ||
                           el.querySelector('.yXK7lf') ||
                           el.querySelector('[data-sncf="1"]') ||
                           el.querySelector('.s');
          
          if (titleEl && linkEl) {
            const url = linkEl.href;
            
            // Skip Google's own links
            if (url.includes('google.com/search') || 
                url.includes('support.google.com') ||
                url.includes('accounts.google.com')) {
              continue;
            }
            
            items.push({
              title: titleEl.textContent.trim(),
              url: url,
              snippet: snippetEl ? snippetEl.textContent.trim() : '',
              selector: selector
            });
          }
        }
        
        if (items.length > 0) {
          console.log(`   ✅ Found ${items.length} results with ${selector}`);
          break; // Stop after first successful selector
        }
      }
    }
    
    return items;
  });
  
  return results;
}

async function extractDuckDuckGoResults(page) {
  const results = await page.evaluate(() => {
    const items = [];
    
    // DuckDuckGo result selectors
    const resultElements = document.querySelectorAll('[data-testid="result"]');
    
    for (const el of resultElements) {
      const titleEl = el.querySelector('[data-testid="result-title-a"]') ||
                     el.querySelector('h2 a') ||
                     el.querySelector('a[href]');
      
      const snippetEl = el.querySelector('[data-result="snippet"]') ||
                       el.querySelector('.result__snippet') ||
                       el.querySelector('[data-testid="result-snippet"]');
      
      if (titleEl) {
        const url = titleEl.href;
        
        // Skip DuckDuckGo's own links
        if (url.includes('duckduckgo.com') || url.includes('duck.co')) {
          continue;
        }
        
        items.push({
          title: titleEl.textContent.trim(),
          url: url,
          snippet: snippetEl ? snippetEl.textContent.trim() : ''
        });
      }
    }
    
    return items;
  });
  
  return results;
}

async function main() {
  const manager = new BrowserManager();
  
  try {
    await manager.initialize();
    
    // Test Google
    const googleResults = await searchGoogle(manager, QUERY);
    
    // Test DuckDuckGo
    console.log('\n\n🔄 Testing DuckDuckGo...');
    await sleep(2000);
    const ddgResults = await searchDuckDuckGo(manager, QUERY);
    
    console.log('\n\n✅ Test complete! Tabs will close automatically after linger time');
    console.log('   Browser stays open - press Ctrl+C to exit\n');
    
    // Keep browser open indefinitely until user closes
    await new Promise(() => {});
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    await manager.close();
  }
}

main();
