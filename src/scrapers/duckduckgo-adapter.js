// DuckDuckGo search adapter using browser pool
import { getSharedPool } from './browser-pool.js';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pasteQuery(page, query) {
  // Simulate Ctrl+V paste (instant)
  await page.evaluate((q) => {
    const input = document.querySelector('input[name="q"]');
    if (input) {
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, query);
  
  await sleep(100);
}

async function extractSearchResults(page) {
  const results = await page.evaluate(() => {
    const items = [];
    
    // DuckDuckGo result selectors
    const resultElements = document.querySelectorAll('[data-testid="result"]');
    
    for (const el of resultElements) {
      // Title and URL
      const linkEl = el.querySelector('a[data-testid="result-title-a"]');
      const snippetEl = el.querySelector('[data-result="snippet"]');
      
      if (linkEl) {
        const url = linkEl.href;
        
        // Skip DDG's own links
        if (url.includes('duckduckgo.com')) {
          continue;
        }
        
        items.push({
          title: linkEl.textContent.trim(),
          url: url,
          snippet: snippetEl ? snippetEl.textContent.trim() : ''
        });
      }
    }
    
    return items;
  });
  
  return results;
}

export async function searchDuckDuckGo(query, options = {}) {
  const pool = getSharedPool({
    headless: options.headless !== false,
    devtools: options.devtools || false,
    userDataDir: options.userDataDir || null // DDG doesn't need login
  });
  
  const pageInfo = await pool.createPage();
  const { page } = pageInfo;
  
  try {
    // Navigate to DuckDuckGo
    await page.goto('https://duckduckgo.com', { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    await sleep(200);
    
    // Click search box
    const searchBox = await page.waitForSelector('input[name="q"]', { 
      timeout: 10000 
    });
    await searchBox.click({ clickCount: 3 });
    await sleep(50);
    
    // Paste query
    await pasteQuery(page, query);
    
    // Submit
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    // Extract results
    const results = await extractSearchResults(page);
    
    // Mark page as used - will linger then close
    pool.markUsed(pageInfo);
    
    return results;
    
  } catch (error) {
    // Close failed page immediately
    await page.close().catch(() => {});
    pool.pages = pool.pages.filter(p => p !== pageInfo);
    throw error;
  }
}
