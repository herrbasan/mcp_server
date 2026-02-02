import puppeteer from 'puppeteer';

const query = process.argv[2] || 'what is quantum computing';

console.log(`\n🧪 Testing Google AI Overview Extraction`);
console.log(`Query: "${query}"`);
console.log(`Profile: d:\\DEV\\mcp_server\\data\\chrome-profile`);
console.log(`\n💡 First run: Log in to Google if prompted`);
console.log(`   Subsequent runs: Will use saved session\n`);
console.log(`Opening visible browser window...\n`);

// Use persistent profile to maintain Google login
// First run: browser will open, log in to Google, then close
// Subsequent runs: will use saved session
const userDataDir = 'd:\\DEV\\mcp_server\\data\\chrome-profile';

const browser = await puppeteer.launch({ 
  headless: false,  // VISIBLE WINDOW
  devtools: true,   // Open DevTools
  slowMo: 50,       // Much faster - just enough to see actions
  userDataDir,      // Persistent profile (keeps login)
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--start-maximized'
  ]
});

const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });

// Set realistic user agent
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

// Dismiss "restore pages" dialog if it appears
try {
  const pages = await browser.pages();
  for (const p of pages) {
    const url = p.url();
    if (url.includes('restore')) {
      await p.close();
    }
  }
} catch (e) {
  // Ignore
}

console.log('📍 Step 1: Navigate to google.com');
await page.goto('https://www.google.com', { waitUntil: 'networkidle2', timeout: 15000 });
console.log('   ✓ Loaded\n');

// Check if logged in
const isLoggedIn = await page.evaluate(() => {
  // Check for account button/avatar
  const accountButton = document.querySelector('[aria-label*="Google Account"]') || 
                       document.querySelector('[aria-label*="account"]') ||
                       document.querySelector('a[href*="accounts.google.com"]');
  return !!accountButton;
});

if (isLoggedIn) {
  console.log('   ✅ Logged in to Google account\n');
} else {
  console.log('   ⚠️  Not logged in - you may get CAPTCHA\'d');
  console.log('   💡 Log in manually in this window, then run script again\n');
}

await new Promise(r => setTimeout(r, 1000));

console.log('📍 Step 2: Find and click search input');
const inputSelector = await page.evaluate(() => {
  // Try multiple selectors
  const selectors = ['textarea[name="q"]', 'input[name="q"]', '[name="q"]'];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return sel;
  }
  return null;
});

if (!inputSelector) {
  console.error('❌ Could not find search input!');
  console.log('\n⏸️  Press Ctrl+C to close browser');
  await new Promise(() => {});
}

console.log(`   Found: ${inputSelector}`);
await page.click(inputSelector);
console.log('   ✓ Clicked\n');

await new Promise(r => setTimeout(r, 500));

console.log('📍 Step 3: Type query character-by-character');
for (let i = 0; i < query.length; i++) {
  const char = query[i];
  const delay = 30 + Math.random() * 50; // Human speed: 30-80ms per char
  await page.keyboard.type(char, { delay });
  process.stdout.write(`   Typed: "${query.substring(0, i + 1)}"\r`);
}
console.log('\n   ✓ Query typed\n');

await new Promise(r => setTimeout(r, 800));

console.log('📍 Step 4: Press Enter');
await page.keyboard.press('Enter');
console.log('   ✓ Pressed Enter\n');

console.log('📍 Step 5: Wait for search results to load');
await new Promise(r => setTimeout(r, 2000));
console.log('   ✓ Waited\n');

console.log('📍 Step 6: Look for "Show more" button on AI Overview');
const showMoreClicked = await page.evaluate(() => {
  const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
  const showMoreBtn = buttons.find(btn => 
    btn.textContent.toLowerCase().includes('show more') ||
    btn.textContent.toLowerCase().includes('more')
  );
  if (showMoreBtn) {
    showMoreBtn.click();
    return true;
  }
  return false;
});

if (showMoreClicked) {
  console.log('   ✓ Clicked "Show more" button\n');
  await new Promise(r => setTimeout(r, 1000));
} else {
  console.log('   ℹ️  No "Show more" button found\n');
}

console.log('📍 Step 7: Extract AI Overview using multiple selectors');
const aiOverview = await page.evaluate(() => {
  const selectors = [
    '[data-attrid="AIAnswer"]',
    '[data-attrid*="AI"]',
    '[jsname*="AI"]',
    '[data-attrid="SGDetailedAnswer"]',
    '[data-attrid*="informative"]',
    '[jsname="yKMVIe"]',
    '[jscontroller="SC7lYd"]',
    '.kp-wholepage',
    '.xpdopen',
    '[data-hveid][data-ved] > div > div:first-child',
    '.kno-rdesc span',
    '.Z0LcW',
    '.hgKElc',
    '.kno-rdesc',
    '#rso > div:first-child div[data-attrid]',
    '#rso > div:first-child [jscontroller]',
    '[data-attrid*="gemini"]',
    '[aria-label*="AI"]',
    '[aria-label*="generated"]'
  ];
  
  const results = [];
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el, idx) => {
      const text = el.textContent?.trim();
      if (text && text.length > 100) {
        results.push({
          selector,
          index: idx,
          length: text.length,
          preview: text.substring(0, 200) + '...',
          fullText: text,
          html: el.innerHTML.substring(0, 500),
          classes: el.className,
          attributes: Array.from(el.attributes).map(a => `${a.name}="${a.value}"`).slice(0, 5)
        });
      }
    });
  }
  return results;
});

if (aiOverview.length === 0) {
  console.log('   ⚠️  No AI Overview found!\n');
  console.log('   Checking page structure...\n');
  
  const pageInfo = await page.evaluate(() => {
    return {
      title: document.title,
      hasResults: !!document.querySelector('.g'),
      topSelectors: Array.from(document.querySelectorAll('#rso > div:first-child *'))
        .slice(0, 10)
        .map(el => ({
          tag: el.tagName,
          id: el.id,
          class: el.className,
          attrs: Array.from(el.attributes).map(a => `${a.name}="${a.value}"`).slice(0, 3)
        }))
    };
  });
  
  console.log('   Page title:', pageInfo.title);
  console.log('   Has regular results:', pageInfo.hasResults);
  console.log('   Top elements:');
  pageInfo.topSelectors.forEach(el => {
    console.log(`      ${el.tag}${el.id ? '#' + el.id : ''}${el.class ? '.' + el.class.split(' ').join('.') : ''}`);
  });
  
} else {
  console.log(`   ✅ Found ${aiOverview.length} potential AI Overview blocks:\n`);
  
  aiOverview.forEach((item, idx) => {
    console.log(`   Block ${idx + 1}:`);
    console.log(`      Selector: ${item.selector}${item.index > 0 ? ` [${item.index}]` : ''}`);
    console.log(`      Classes: ${item.classes}`);
    console.log(`      Length: ${item.length} chars`);
    console.log(`      Attributes: ${item.attributes.join(', ')}`);
    console.log(`      Preview: ${item.preview}\n`);
  });
  
  // Show the most likely candidate (longest text)
  const best = aiOverview.reduce((a, b) => a.length > b.length ? a : b);
  console.log(`\n   🎯 Best candidate (${best.length} chars):`);
  console.log(`      Selector: ${best.selector}`);
  console.log(`      Classes: ${best.classes}`);
  console.log(`\n${best.fullText}\n`);
}

console.log('📍 Step 7: Extract regular search results');
const searchResults = await page.evaluate(() => {
  const items = [];
  document.querySelectorAll('.g').forEach((el, idx) => {
    const link = el.querySelector('a');
    const title = el.querySelector('h3');
    if (link && link.href && title) {
      items.push({
        position: idx + 1,
        url: link.href,
        title: title.textContent.trim()
      });
    }
  });
  return items;
});

console.log(`   Found ${searchResults.length} regular results:`);
searchResults.slice(0, 5).forEach(r => {
  console.log(`      ${r.position}. ${r.title}`);
  console.log(`         ${r.url.substring(0, 80)}...`);
});

console.log(`\n✅ Test complete!`);
console.log(`\n💡 Recommendations:`);
if (aiOverview.length > 0) {
  const best = aiOverview.reduce((a, b) => a.length > b.length ? a : b);
  console.log(`   - Use selector: ${best.selector}`);
  console.log(`   - Tag: <${best.tagName}>`);
  console.log(`   - Stable attributes: ${best.attributes || 'none'}`);
  console.log(`   - Extract full text content`);
  console.log(`   - Mark as special result (don't scrape URL)`);
} else {
  console.log(`   - AI Overview may not be present for this query`);
  console.log(`   - Try queries like "what is X" or "how does Y work"`);
  console.log(`   - Check if you got CAPTCHA'd`);
}

console.log(`\n🔄 Closing browser gracefully in 3 seconds...`);
await new Promise(r => setTimeout(r, 3000));
await browser.close();
console.log(`✅ Browser closed cleanly\n`);
