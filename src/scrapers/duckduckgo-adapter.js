// DuckDuckGo search adapter using browser server

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pasteQuery(page, query) {
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
  return await page.evaluate(() => {
    const items = [];
    const resultElements = document.querySelectorAll('[data-testid="result"]');
    
    for (const el of resultElements) {
      const linkEl = el.querySelector('a[data-testid="result-title-a"]');
      const snippetEl = el.querySelector('[data-result="snippet"]');
      
      if (linkEl && !linkEl.href.includes('duckduckgo.com')) {
        items.push({
          title: linkEl.textContent.trim(),
          url: linkEl.href,
          snippet: snippetEl ? snippetEl.textContent.trim() : ''
        });
      }
    }
    return items;
  });
}

export async function searchDuckDuckGo(query, browserServer) {
  if (!browserServer) {
    throw new Error('browserServer is required for searchDuckDuckGo');
  }
  
  const pageHandle = await browserServer.getPage();
  const { page, markUsed } = pageHandle;
  
  try {
    await page.goto('https://duckduckgo.com', { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    await sleep(200);
    
    const searchBox = await page.waitForSelector('input[name="q"]', { timeout: 10000 });
    await searchBox.click({ clickCount: 3 });
    await sleep(50);
    
    await pasteQuery(page, query);
    
    // Focus input and submit
    await searchBox.focus();
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    
    const results = await extractSearchResults(page);
    markUsed();
    return results;
    
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}
