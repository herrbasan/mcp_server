import puppeteer from 'puppeteer';
import { LLMRouter } from '../src/llm/router.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load environment variables
loadDotEnv({ path: join(__dirname, '..', '.env') });

const configRaw = readFileSync(join(__dirname, '..', 'config.json'), 'utf-8');
const configStr = configRaw.replace(/\${(\w+)}/g, (_, key) => process.env[key] || '');
const config = JSON.parse(configStr);

const SEARCH_TOPICS = [
  'best programming languages 2026',
  'how to make pizza dough',
  'machine learning fundamentals',
  'climate change solutions',
  'quantum computing explained',
  'healthy breakfast recipes',
  'space exploration news',
  'renewable energy trends'
];

function cleanHTML(html) {
  console.log(`\n[HTML Cleanup] Original size: ${html.length} chars`);
  
  // Remove scripts, styles, comments
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
  
  // Collapse whitespace
  cleaned = cleaned
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
  
  console.log(`[HTML Cleanup] Cleaned size: ${cleaned.length} chars (${((1 - cleaned.length/html.length) * 100).toFixed(1)}% reduction)`);
  
  // If still too large, extract just the main content area
  if (cleaned.length > 80000) {
    console.log('[HTML Cleanup] Still too large, extracting search results container...');
    // Try to find the main search results container - be less greedy
    const searchMatch = cleaned.match(/<div[^>]*id="search"[^>]*>([\s\S]+)/i);
    if (searchMatch) {
      // Take up to 80k chars from the search div
      cleaned = '<div id="search">' + searchMatch[1].substring(0, 80000);
      console.log(`[HTML Cleanup] Extracted search container: ${cleaned.length} chars`);
    } else {
      // Fallback: take first 80k chars
      cleaned = cleaned.substring(0, 80000);
      console.log('[HTML Cleanup] Fallback: truncated to 80k chars');
    }
  }
  
  return cleaned;
}

async function extractWithLLM(pageText, query, router) {
  console.log('\n[LLM Extraction] Preparing prompt...');
  
  const prompt = `Extract all search results from this Google search results page text.
The page shows results for the query: "${query}"

Return ONLY a JSON array of search results with this exact structure:
[
  {
    "title": "Result title",
    "url": "https://example.com",
    "snippet": "Description or snippet text"
  }
]

Rules:
- Extract ALL organic search results (not ads)
- Include title, URL, and snippet for each
- Return valid JSON only, no additional text
- If no results found, return empty array []

PAGE TEXT:
${pageText}`;

  console.log(`[LLM Extraction] Prompt length: ${prompt.length} chars`);
  console.log('[LLM Extraction] Calling LLM with structured output...');
  
  const schema = {
    type: 'json_schema',
    json_schema: {
      name: 'search_results',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                snippet: { type: 'string' }
              },
              required: ['title', 'url', 'snippet'],
              additionalProperties: false
            }
          }
        },
        required: ['results'],
        additionalProperties: false
      }
    }
  };
  
  const response = await router.predict({
    prompt,
    provider: 'lmstudio',
    taskType: 'analysis',
    maxTokens: 4000,
    temperature: 0,
    responseFormat: schema
  });
  
  console.log('[LLM Extraction] Response received, parsing JSON...');
  const parsed = JSON.parse(response);
  console.log(`[LLM Extraction] Extracted ${parsed.results?.length || 0} results`);
  
  return parsed.results || [];
}

async function testGoogleExtraction(browser, router, query) {
  console.log('\n' + '='.repeat(80));
  console.log(`🔍 TESTING: "${query}"`);
  console.log('='.repeat(80));
  
  const page = await browser.newPage();
  
  try {
    // Configure page
    console.log('\n[Browser] Setting up page...');
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate to Google
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    console.log(`[Browser] Navigating to: ${searchUrl}`);
    
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('[Browser] Page loaded, waiting for content to render...');
    
    await new Promise(r => setTimeout(r, 2000));
    console.log('[Browser] Content rendered');
    
    // Get clean text content from browser (no HTML parsing needed)
    console.log('[Browser] Extracting page text content...');
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log(`[Browser] Text extracted: ${pageText.length} chars`);
    
    // Show preview of extracted text
    console.log('\n[Browser] TEXT PREVIEW (first 2000 chars):');
    console.log('─'.repeat(80));
    console.log(pageText.substring(0, 2000));
    console.log('─'.repeat(80));
    console.log(`... (${pageText.length - 2000} more chars)\n`);
    
    // Extract with LLM
    const results = await extractWithLLM(pageText, query, router);
    
    // Display results
    console.log('\n' + '─'.repeat(80));
    console.log('📋 EXTRACTED RESULTS:');
    console.log('─'.repeat(80));
    
    if (results.length === 0) {
      console.log('⚠️  No results extracted');
    } else {
      results.forEach((r, i) => {
        console.log(`\n${i + 1}. ${r.title}`);
        console.log(`   URL: ${r.url}`);
        console.log(`   Snippet: ${r.snippet.substring(0, 150)}${r.snippet.length > 150 ? '...' : ''}`);
      });
    }
    
    console.log('\n' + '─'.repeat(80));
    console.log(`✅ Test complete: ${results.length} results extracted`);
    console.log('─'.repeat(80));
    
  } catch (err) {
    console.error('\n❌ ERROR:', err.message);
    console.error('Stack:', err.stack);
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('🚀 Google Search LLM Extraction Test');
  console.log('─'.repeat(80));
  
  // Initialize LLM Router
  console.log('\n[Setup] Initializing LLM Router...');
  const router = new LLMRouter(config.llm);
  console.log('[Setup] LLM Router ready');
  
  // Launch browser
  console.log('[Setup] Launching browser (visible mode with persistent profile)...');
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: 'd:\\DEV\\mcp_server\\data\\chrome-profile',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });
  console.log('[Setup] Browser ready');
  
  // Run tests
  const numTests = 3;
  const delayBetweenTests = 5000; // 5 seconds
  
  for (let i = 0; i < numTests; i++) {
    const query = SEARCH_TOPICS[Math.floor(Math.random() * SEARCH_TOPICS.length)];
    await testGoogleExtraction(browser, router, query);
    
    if (i < numTests - 1) {
      console.log(`\n⏱️  Waiting ${delayBetweenTests/1000}s before next test...\n`);
      await new Promise(r => setTimeout(r, delayBetweenTests));
    }
  }
  
  // Cleanup
  console.log('\n[Cleanup] Closing browser...');
  await browser.close();
  console.log('[Cleanup] Done');
  
  console.log('\n✅ All tests complete');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
