// DuckDuckGo search adapter using browser server

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function extractSearchResults(page) {
  return await page.evaluate(() => {
    const items = [];
    
    // DuckDuckGo uses data-testid attributes
    document.querySelectorAll('[data-testid="result"]').forEach(el => {
      const linkEl = el.querySelector('[data-testid="result-title-a"]');
      const snippetEl = el.querySelector('[data-result="snippet"]');
      
      if (linkEl && linkEl.href) {
        const url = linkEl.href;
        const title = linkEl.textContent.trim();
        
        // Skip DDG's own links
        if (!url.includes('duckduckgo.com') && title.length > 0) {
          items.push({
            title: title,
            url: url,
            snippet: snippetEl ? snippetEl.textContent.trim() : ''
          });
        }
      }
    });
    
    return items;
  });
}

export async function searchDuckDuckGo(query, browserServer, timeoutMs = 15000) {
  console.error(`[DuckDuckGo] Searching: "${query}"`);
  
  if (!browserServer) {
    throw new Error('browserServer is required');
  }
  
  const pageHandle = await browserServer.getPage();
  const { page, markUsed } = pageHandle;
  const startTime = Date.now();
  
  try {
    // Go directly to search results page
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`;
    
    await page.goto(searchUrl, { 
      waitUntil: 'networkidle0', 
      timeout: timeoutMs 
    });
    
    // Wait for results to load
    await sleep(2000);
    
    const results = await extractSearchResults(page);
    
    console.error(`[DuckDuckGo] Found ${results.length} results in ${Date.now() - startTime}ms`);
    
    markUsed();
    return results;
    
  } catch (error) {
    console.error(`[DuckDuckGo] Error: ${error.message}`);
    
    // Try partial extraction
    try {
      const partial = await extractSearchResults(page);
      if (partial.length > 0) {
        console.error(`[DuckDuckGo] Partial results (${partial.length})`);
        markUsed();
        return partial;
      }
    } catch {}
    
    await page.close().catch(() => {});
    throw error;
  }
}
