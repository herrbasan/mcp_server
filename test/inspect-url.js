import puppeteer from 'puppeteer';

const input = process.argv[2];

if (!input) {
  console.error('Usage: node test/inspect-url.js <url or search query>');
  console.error('Examples:');
  console.error('  node test/inspect-url.js "web scraping"           # Google search');
  console.error('  node test/inspect-url.js "https://wikipedia.org"  # Direct URL');
  process.exit(1);
}

// Determine if input is URL or search query
const isUrl = input.startsWith('http://') || input.startsWith('https://');
const mode = isUrl ? 'url' : 'search';

console.log(`🔍 Opening ${mode === 'search' ? 'Google search' : 'URL'} with scraper configuration...`);
console.log(`${mode === 'search' ? 'Query' : 'URL'}: ${input}\n`);

// Same stealth setup as web-research.js
async function setupStealthMode(page) {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 }
  ];
  const viewport = viewports[Math.floor(Math.random() * viewports.length)];
  await page.setViewport(viewport);

  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
  ];
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  await page.setUserAgent(userAgent);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,de;q=0.1',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'User-Agent': userAgent + ' (LocalEmbeddings Research Bot; +https://github.com/research-tools)',
    'DNT': '1',
    'Connection': 'keep-alive'
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
    
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
  });
}

const browser = await puppeteer.launch({
  headless: false,
  devtools: true,  // Open DevTools automatically
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list',
    '--disable-dev-shm-usage',
    '--disable-gpu'
  ]
});

const page = await browser.newPage();

// Capture console messages
page.on('console', msg => {
  const type = msg.type();
  const text = msg.text();
  const icon = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
  console.log(`${icon} [${type}] ${text}`);
});

// Capture page errors
page.on('pageerror', err => {
  console.log(`❌ [Page Error] ${err.message}`);
});

// Capture failed requests
page.on('requestfailed', request => {
  console.log(`❌ [Failed] ${request.url()} - ${request.failure().errorText}`);
});

console.log('📝 Applying stealth mode (same as scraper)...');
await setupStealthMode(page);

const startTime = Date.now();

try {
  if (mode === 'search') {
    // Go to Google homepage first (with English language parameter)
    console.log('🌐 Going to Google homepage (English)...');
    await page.goto('https://www.google.com?hl=en&gl=us', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
    console.log('✅ Homepage loaded\n');
    
    // Wait for page to settle
    await new Promise(r => setTimeout(r, 1000));
    
    // Handle cookie consent dialog if it appears
    console.log('🍪 Checking for cookie dialog...');
    try {
      // Try multiple selectors for different languages/versions
      const selectors = [
        'button[id="L2AGLb"]',  // "Accept all" button ID
        'button:contains("Accept all")',
        'button:contains("Alle akzeptieren")',
        'button:contains("I agree")',
        'div[role="dialog"] button:nth-of-type(2)'  // Usually second button is "accept"
      ];
      
      let clicked = false;
      for (const selector of selectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            console.log(`✅ Found cookie button with selector: ${selector}`);
            await button.click();
            await new Promise(r => setTimeout(r, 1500));
            console.log('✅ Cookie dialog accepted\n');
            clicked = true;
            break;
          }
        } catch (e) {
          // Try next selector
        }
      }
      
      if (!clicked) {
        console.log('✅ No cookie dialog found (or already accepted)\n');
      }
    } catch (e) {
      console.log(`⚠️  Cookie dialog handling: ${e.message}\n`);
    }
    
    // Wait a bit to look more human
    await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
    
    // Find and fill search box
    console.log('⌨️  Typing search query...');
    const searchBox = await page.$('textarea[name="q"], input[name="q"]');
    if (!searchBox) {
      throw new Error('Could not find Google search box');
    }
    
    // Type with human-like delays
    await searchBox.click();
    await page.keyboard.type(input, { delay: 50 + Math.random() * 100 });
    console.log('✅ Query typed\n');
    
    // Wait a bit before submitting
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
    
    // Submit search
    console.log('🔍 Submitting search...');
    await page.keyboard.press('Enter');
    
    // Wait for results
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
    
  } else {
    // Direct URL navigation
    console.log('🌐 Navigating to URL...');
    await page.goto(input, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });
  }
  
  const loadTime = Date.now() - startTime;
  console.log(`✅ Page loaded (${loadTime}ms)\n`);
  
  // Analyze page
  const analysis = await page.evaluate(() => {
    return {
      title: document.title,
      url: window.location.href,
      bodyText: document.body?.innerText?.substring(0, 500) || '',
      navigator: {
        webdriver: navigator.webdriver,
        plugins: navigator.plugins.length,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: navigator.languages,
        vendor: navigator.vendor,
        hasChrome: !!window.chrome
      },
      detection: {
        hasCaptcha: document.body?.innerText?.toLowerCase().includes('captcha') || false,
        hasUnusualTraffic: document.body?.innerText?.toLowerCase().includes('unusual traffic') || false,
        hasBlocked: document.body?.innerText?.toLowerCase().includes('blocked') || false,
        hasBotDetected: document.body?.innerText?.toLowerCase().includes('bot') || false
      }
    };
  });
  
  console.log('📊 Page Analysis:');
  console.log(`   Title: ${analysis.title}`);
  console.log(`   Final URL: ${analysis.url}`);
  console.log(`\n   Navigator Properties:`);
  console.log(`     webdriver: ${analysis.navigator.webdriver}`);
  console.log(`     plugins: ${analysis.navigator.plugins}`);
  console.log(`     chrome object: ${analysis.navigator.hasChrome}`);
  console.log(`     platform: ${analysis.navigator.platform}`);
  console.log(`     languages: [${analysis.navigator.languages.join(', ')}]`);
  
  console.log(`\n   Detection Indicators:`);
  console.log(`     Captcha: ${analysis.detection.hasCaptcha ? '⚠️ YES' : '✅ No'}`);
  console.log(`     Unusual Traffic: ${analysis.detection.hasUnusualTraffic ? '⚠️ YES' : '✅ No'}`);
  console.log(`     Blocked: ${analysis.detection.hasBlocked ? '⚠️ YES' : '✅ No'}`);
  console.log(`     Bot Mention: ${analysis.detection.hasBotDetected ? '⚠️ YES' : '✅ No'}`);
  
  console.log(`\n   First 500 chars of body:`);
  console.log(`   ${analysis.bodyText.substring(0, 500)}\n`);
  
} catch (err) {
  console.error(`❌ Error: ${err.message}\n`);
}

console.log('👀 Browser window open with DevTools.');
console.log('   - Check Console tab for errors/warnings');
console.log('   - Check Network tab for failed requests');
console.log('   - Check Elements tab to inspect DOM');
console.log('   - Visually inspect the page\n');
console.log('⏸️  Press Ctrl+C when done inspecting.\n');

// Keep alive
await new Promise(() => {});
