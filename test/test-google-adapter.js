// Test Google adapter step by step
import puppeteer from 'puppeteer';

const CHROME_PROFILE = 'd:\\DEV\\mcp_server\\data\\chrome-profile';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test() {
  console.log('=== Google Adapter Step-by-Step Test ===\n');
  
  // Step 1: Launch browser
  console.log('1. Launching browser...');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: CHROME_PROFILE,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  console.log('   ✓ Browser launched\n');
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  
  try {
    // Step 2: Navigate to Google
    console.log('2. Navigating to Google...');
    await page.goto('https://www.google.com', { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    console.log('   ✓ Page loaded');
    console.log(`   URL: ${page.url()}\n`);
    
    // Step 3: Check login status
    console.log('3. Checking login status...');
    const isLoggedIn = await page.evaluate(() => {
      return !!(document.querySelector('a[aria-label*="Google Account"]') || 
                document.querySelector('img[alt*="Google Account"]') ||
                document.querySelector('[data-ogsr-up]'));
    });
    console.log(`   Logged in: ${isLoggedIn}\n`);
    
    // Step 4: Find search box
    console.log('4. Finding search box...');
    const searchBox = await page.waitForSelector('textarea[name="q"], input[name="q"]', { 
      timeout: 10000 
    });
    const tagName = await searchBox.evaluate(el => el.tagName);
    console.log(`   ✓ Found: <${tagName.toLowerCase()} name="q">\n`);
    
    // Step 5: Click and focus
    console.log('5. Clicking search box...');
    await searchBox.click({ clickCount: 3 });
    await sleep(100);
    console.log('   ✓ Clicked\n');
    
    // Step 6: Enter query
    const query = 'JavaScript async await';
    console.log(`6. Entering query: "${query}"...`);
    await page.evaluate((q) => {
      const input = document.querySelector('textarea[name="q"], input[name="q"]');
      if (input) {
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, query);
    await sleep(100);
    
    const inputValue = await searchBox.evaluate(el => el.value);
    console.log(`   ✓ Input value: "${inputValue}"\n`);
    
    // Step 7: Submit search
    console.log('7. Pressing Enter...');
    await page.keyboard.press('Enter');
    console.log('   ✓ Enter pressed\n');
    
    // Step 8: Wait for navigation
    console.log('8. Waiting for navigation...');
    await page.waitForNavigation({ 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    console.log(`   ✓ Navigated to: ${page.url()}\n`);
    
    // Step 9: Extract results
    console.log('9. Extracting search results...');
    const results = await page.evaluate(() => {
      const items = [];
      const selectors = ['.g', 'div[data-hveid].MjjYud', '[jscontroller="SC7lYd"]'];
      
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(`Found ${elements.length} elements with selector: ${selector}`);
          
          for (const el of elements) {
            const titleEl = el.querySelector('h3') || el.querySelector('[role="heading"]');
            const linkEl = el.querySelector('a[href]');
            const snippetEl = el.querySelector('.VwiC3b') || el.querySelector('[data-sncf="1"]');
            
            if (titleEl && linkEl) {
              const url = linkEl.href;
              if (url.includes('google.com/search') || url.includes('support.google.com')) continue;
              
              items.push({
                title: titleEl.textContent.trim(),
                url: url,
                snippet: snippetEl ? snippetEl.textContent.trim().substring(0, 100) : ''
              });
            }
          }
          if (items.length > 0) break;
        }
      }
      return items;
    });
    
    console.log(`   ✓ Found ${results.length} results:\n`);
    results.slice(0, 5).forEach((r, i) => {
      console.log(`   ${i+1}. ${r.title}`);
      console.log(`      ${r.url}`);
      console.log(`      ${r.snippet}...\n`);
    });
    
    console.log('=== Test Complete ===');
    
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    console.error(err.stack);
  } finally {
    await sleep(2000);
    await browser.close();
  }
}

test();
