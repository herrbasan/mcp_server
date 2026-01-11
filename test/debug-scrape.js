import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

// Get URL from command line or use defaults
const args = process.argv.slice(2);
const TEST_URLS = args.length > 0 ? args : [
  'https://de.wikipedia.org/wiki/YouTube',
  'https://apps.apple.com/de/app/youtube/id544007664',
  'https://react.dev/learn/hooks-overview', // Control - should work
];

const HEADLESS = process.env.HEADLESS === 'true'; // Set HEADLESS=true for headless mode
const TIMEOUT = parseInt(process.env.TIMEOUT || '8000'); // Override with TIMEOUT=10000

async function debugScrape(url) {
  console.log('\n' + '='.repeat(80));
  console.log(`Testing: ${url}`);
  console.log('='.repeat(80));
  
  const browser = await puppeteer.launch({ 
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security'
    ],
    devtools: !HEADLESS // Open DevTools if visible
  });
  
  const page = await browser.newPage();
  
  try {
    console.log('\n📝 Step 1: Setting up stealth mode...');
    
    // Stealth setup
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });
    
    console.log('✅ Stealth mode configured\n');
    
    console.log('📝 Step 2: Navigating to URL...');
    const navStart = Date.now();
    
    const scrapePromise = (async () => {
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: TIMEOUT 
      });
      
      const navTime = Date.now() - navStart;
      console.log(`✅ Navigation complete (${navTime}ms)\n`);
      
      console.log('📝 Step 3: Scrolling page...');
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
      await new Promise(r => setTimeout(r, 200));
      
      console.log('✅ Scrolled\n');
      
      console.log('📝 Step 4: Getting page content...');
      const html = await page.content();
      console.log(`✅ HTML retrieved (${(html.length / 1024).toFixed(1)} KB)\n`);
      
      console.log('📝 Step 5: Running Readability extraction...');
      const dom = new JSDOM(html, { url });
      const doc = dom.window.document;
      
      const reader = new Readability(doc, {
        charThreshold: 500,
        nbTopCandidates: 5
      });
      
      const article = reader.parse();
      
      if (!article) {
        console.log('❌ Readability failed - no article content found');
        return null;
      }
      
      console.log('✅ Readability successful\n');
      console.log(`   Title: ${article.title}`);
      console.log(`   Excerpt: ${article.excerpt?.substring(0, 100)}...`);
      console.log(`   Content length: ${article.textContent.length} chars`);
      
      // Extract sections
      const contentDom = new JSDOM(article.content);
      const headings = contentDom.window.document.querySelectorAll('h1, h2, h3');
      const sections = [];
      headings.forEach(h => {
        const level = parseInt(h.tagName[1]);
        const text = h.textContent.trim();
        if (text) sections.push({ level, heading: text });
      });
      
      console.log(`   Sections found: ${sections.length}`);
      if (sections.length > 0) {
        console.log(`   First 5 sections:`);
        sections.slice(0, 5).forEach(s => {
          console.log(`     ${'  '.repeat(s.level - 1)}${s.heading}`);
        });
      }
      
      return {
        url,
        title: article.title,
        excerpt: article.excerpt,
        contentLength: article.textContent.length,
        sections: sections.length,
        htmlSize: html.length
      };
    })();
    
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Scrape timeout')), TIMEOUT)
    );
    
    const result = await Promise.race([scrapePromise, timeoutPromise]);
    
    console.log('\n✅ SUCCESS\n');
    console.log('Summary:');
    console.log(`  HTML: ${(result.htmlSize / 1024).toFixed(1)} KB → ${(result.contentLength / 1024).toFixed(1)} KB`);
    console.log(`  Reduction: ${((1 - result.contentLength / result.htmlSize) * 100).toFixed(1)}%`);
    console.log(`  Sections: ${result.sections}`);
    
    if (!HEADLESS) {
      console.log('\n⏸️  Browser window open for inspection. Press Ctrl+C to close.');
      await new Promise(() => {}); // Keep browser open
    }
    
  } catch (err) {
    console.log(`\n❌ FAILED: ${err.message}\n`);
    
    if (err.message.includes('timeout')) {
      console.log('🐛 Debug info:');
      console.log('  - Page might have infinite loading resources');
      console.log('  - Check DevTools Network tab for stuck requests');
      console.log('  - Look for blocking scripts or iframes');
    }
    
    if (!HEADLESS) {
      console.log('\n⏸️  Browser window open for debugging. Press Ctrl+C to close.');
      await new Promise(() => {}); // Keep browser open for debugging
    }
  } finally {
    if (HEADLESS) {
      await browser.close();
    }
  }
}

// Run tests
console.log('🧪 Puppeteer + Readability Debug Test');
console.log(`Mode: ${HEADLESS ? 'Headless' : 'Visible Browser'}`);
console.log(`Timeout: ${TIMEOUT}ms`);

if (args.length > 0) {
  console.log(`Testing ${TEST_URLS.length} URL(s) from command line:\n`);
} else {
  console.log(`No URL provided, testing defaults:\n`);
}

TEST_URLS.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
console.log();

for (const url of TEST_URLS) {
  await debugScrape(url);
  
  if (HEADLESS && TEST_URLS.indexOf(url) < TEST_URLS.length - 1) {
    console.log('\n⏸️  Waiting 2s before next test...');
    await new Promise(r => setTimeout(r, 2000));
  }
}

if (HEADLESS) {
  console.log('\n✅ All tests complete');
  process.exit(0);
}
