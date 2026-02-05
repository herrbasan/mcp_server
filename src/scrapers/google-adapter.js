// Google search adapter using browser server

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pasteQuery(page, query) {
  await page.evaluate((q) => {
    const input = document.querySelector('textarea[name="q"], input[name="q"]');
    if (input) {
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, query);
  
  await sleep(100);
}

async function extractSearchResults(page) {
  return await page.evaluate(() => {
    const items = [];
    
    // Try multiple selectors for search results
    const selectors = ['.g', 'div[data-hveid]', '.tF2Cxc'];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      
      for (const el of elements) {
        const linkEl = el.querySelector('a[href^="http"]');
        const titleEl = el.querySelector('h3');
        const snippetEl = el.querySelector('.VwiC3b, .s, .yXK7lf');
        
        if (linkEl && titleEl) {
          const url = linkEl.href;
          
          // Skip Google's own links
          if (url.includes('google.com/search') || 
              url.includes('support.google.com')) {
            continue;
          }
          
          items.push({
            title: titleEl.textContent.trim(),
            url: url,
            snippet: snippetEl ? snippetEl.textContent.trim() : ''
          });
        }
      }
      
      if (items.length > 0) break;
    }
    
    return items;
  });
}

export async function searchGoogle(query, browserServer, timeoutMs = 15000) {
  if (!browserServer) {
    throw new Error('browserServer is required for searchGoogle');
  }
  
  const pageHandle = await browserServer.getPage();
  const { page, markUsed } = pageHandle;
  const startTime = Date.now();
  
  try {
    // Navigate to Google
    await page.goto('https://www.google.com', { 
      waitUntil: 'domcontentloaded', 
      timeout: timeoutMs 
    });
    
    // Find and fill search box
    await page.waitForSelector('textarea[name="q"], input[name="q"]', { timeout: 5000 });
    await pasteQuery(page, query);
    
    // Submit search
    await page.keyboard.press('Enter');
    
    // Wait for results page to load
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    
    // Extra wait for results to render
    await sleep(1000);
    
    // Extract results
    const results = await extractSearchResults(page);
    
    console.error(`[Google] Found ${results.length} results in ${Date.now() - startTime}ms`);
    
    markUsed();
    return results;
    
  } catch (error) {
    // Try partial extraction
    try {
      const partial = await extractSearchResults(page);
      if (partial.length > 0) {
        console.error(`[Google] Partial results (${partial.length})`);
        markUsed();
        return partial;
      }
    } catch {}
    
    await page.close().catch(() => {});
    throw error;
  }
}
