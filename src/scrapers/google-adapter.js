// Google search adapter using browser server

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pasteQuery(page, query) {
  // Simulate Ctrl+V paste (instant)
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
  const results = await page.evaluate(() => {
    const items = [];
    
    // Try multiple selectors for search results
    const selectors = [
      '.g',
      'div[data-hveid].MjjYud',
      '.Gx5Zad.fP1Qef.xpd.EtOod.pkphOe',
      '[jscontroller="SC7lYd"]'
    ];
    
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      
      if (elements.length > 0) {
        for (const el of elements) {
          const titleEl = el.querySelector('h3') || 
                         el.querySelector('[role="heading"]') ||
                         el.querySelector('.LC20lb');
          
          const linkEl = el.querySelector('a[href]') ||
                        el.querySelector('a[jsname]');
          
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
              snippet: snippetEl ? snippetEl.textContent.trim() : ''
            });
          }
        }
        
        if (items.length > 0) break;
      }
    }
    
    return items;
  });
  
  return results;
}

export async function searchGoogle(query, browserServer) {
  if (!browserServer) {
    throw new Error('browserServer is required for searchGoogle');
  }
  
  const pageHandle = await browserServer.getPage();
  const { page, markUsed } = pageHandle;
  
  try {
    // Navigate to Google
    await page.goto('https://www.google.com', { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    await sleep(200);
    
    // Check if logged in (look for account icon/profile button)
    const isLoggedIn = await page.evaluate(() => {
      // Check for Google account avatar/button
      return !!(document.querySelector('a[aria-label*="Google Account"]') || 
                document.querySelector('img[alt*="Google Account"]') ||
                document.querySelector('[data-ogsr-up]'));
    });
    
    if (!isLoggedIn) {
      console.error('[Google] ⚠️  Not logged in - search quality may be degraded');
      console.error('[Google] Run browser_login tool to refresh Google session');
    }
    
    // Click search box
    const searchBox = await page.waitForSelector('textarea[name="q"], input[name="q"]', { 
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
    markUsed();
    
    return results;
    
  } catch (error) {
    // Close failed page immediately
    await page.close().catch(() => {});
    throw error;
  }
}
