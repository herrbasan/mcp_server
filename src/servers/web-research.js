import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { ScraperRegistry } from '../scrapers/index.js';

export class WebResearchServer {
  constructor(config) {
    this.llmEndpoint = config.llmEndpoint;
    this.llmModel = config.llmModel;
    this.scraperRegistry = new ScraperRegistry();
    
    // Guardrails (local-first reliability focus)
    this.limits = {
      totalTimeout: config.timeout || config.totalTimeout || 120000,  // 120s total pipeline
      scrapeTimeout: config.scrapeTimeout || 8000,       // 8s per page scrape
      llmTimeout: config.llmTimeout || 10000,            // 10s per LLM call
      maxIterations: config.maxIterations || 2,          // refinement loops
      maxPages: config.maxPages || 10,                   // pages to scrape
      maxMemoryPerPage: config.maxMemoryPerPage || 12582912, // 12MB per page
      concurrentScrapes: config.concurrentScrapes || 10  // parallel scrape limit (10 for high-end systems)
    };
    
    this.maxPages = this.limits.maxPages;
    this.maxDepth = config.maxDepth || 2;
    this.timeout = this.limits.totalTimeout;
    this.searchEngines = config.searchEngines || ['duckduckgo', 'google'];
    this.progressCallback = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback(progress, total, message);
    }
  }

  enhanceQuery(query) {
    // DISABLED: Over-quoting breaks search engines
    // Return query as-is to let search engines handle natural language
    return query;
  }

  async prepareQuery(args) {
    const { user_query, context } = args;
    
    const prompt = `You are a search query optimization expert. Given a user's research question, generate 3-5 highly effective search query variants that will find the most relevant and authoritative sources.

User question: "${user_query}"
${context ? `\nContext: ${context}` : ''}

Consider:
1. Technical terminology (e.g., quote multi-word terms like "Virtual DOM")
2. Domain-specific sites (e.g., add "site:stackoverflow.com" for coding questions)
3. Disambiguation (add context words to prevent ambiguous results)
4. Alternative phrasings (how would different experts phrase this?)
5. Specificity levels (one broad query, one narrow query, one focused on examples/tutorials)

Generate 3-5 search query variants optimized for Google/DuckDuckGo/Bing.

Return ONLY valid JSON (no markdown, no code blocks, no explanation):
{"queries":[{"query":"exact search string","reasoning":"why this variant"}],"recommended":"query string you recommend most"}`

    try {
      const response = await this.queryLLM(prompt, null, 1500);
      
      console.error(`[DEBUG] LLM response length: ${response.length} chars`);
      
      // Strategy: Find all potential JSON objects, validate them, take the last valid one
      // This handles thinking tags, markdown blocks, and other preambles
      
      let cleaned = response
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      
      // Find all {...} blocks
      const jsonCandidates = [];
      let depth = 0;
      let start = -1;
      
      for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === '{') {
          if (depth === 0) start = i;
          depth++;
        } else if (cleaned[i] === '}') {
          depth--;
          if (depth === 0 && start >= 0) {
            jsonCandidates.push(cleaned.substring(start, i + 1));
            start = -1;
          }
        }
      }
      
      console.error(`[DEBUG] Found ${jsonCandidates.length} JSON candidates`);
      
      // Try to parse candidates in reverse order (last one first)
      let parsed = null;
      for (let i = jsonCandidates.length - 1; i >= 0; i--) {
        try {
          const candidate = jsonCandidates[i];
          const obj = JSON.parse(candidate);
          
          // Validate it has the right structure
          if (obj.queries && Array.isArray(obj.queries) && obj.recommended) {
            parsed = obj;
            console.error(`[DEBUG] Successfully parsed candidate ${i + 1}`);
            break;
          }
        } catch (e) {
          // Try next candidate
        }
      }
      
      if (!parsed) {
        throw new Error('No valid JSON with correct structure found');
      }
      
      // Format for user review
      const formatted = `**Query Preparation Results**

Original: "${user_query}"

**Recommended Query:**
\`${parsed.recommended}\`

**Alternative Variants:**
${parsed.queries.map((q, i) => `${i + 1}. \`${q.query}\`
   *${q.reasoning}*`).join('\n\n')}

---
*Review these queries and choose one to execute with \`research_topic\`*`;

      return {
        content: [{ type: 'text', text: formatted }]
      };
    } catch (err) {
      return {
        content: [{ 
          type: 'text', 
          text: `❌ Query preparation failed: ${err.message}\n\nFalling back to basic enhancement: "${this.enhanceQuery(user_query)}"` 
        }],
        isError: true
      };
    }
  }

  getTools() {
    return [
      // prepare_research_query - kept in backpocket, not exposed
      // See prepareQuery() method below for implementation
      {
        name: 'research_topic',
        description: 'Research a topic across multiple web sources. IMPORTANT: Before calling, optimize your search query - consider technical terms that need quotes (e.g., "Virtual DOM"), site: filters for authoritative sources (stackoverflow.com, github.com), and specific phrasing to avoid ambiguous results. Then: searches engines, selects best sources, scrapes content, cross-references facts, returns synthesized summary with citations. Uses local LLM for analysis. Always display the complete research report to the user VERBATIM before providing commentary.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Optimized search query (technical terms quoted, site: filters if relevant)' },
            max_pages: { type: 'number', description: 'Max pages to scrape (default: 10)' },
            engines: { type: 'array', items: { type: 'string' }, description: 'Search engines to use (google, bing, duckduckgo)' }
          },
          required: ['query']
        }
      }
    ];
  }

  handlesTool(name) {
    return name === 'research_topic';
  }

  async callTool(name, args) {
    // Backpocket: prepare_research_query available via prepareQuery() but not exposed
    
    const { query, max_pages = this.maxPages, engines = this.searchEngines } = args;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      console.error(`\n🔍 Research: "${query}"`);
      console.error(`   Limits: ${max_pages} pages, ${this.timeout/1000}s timeout`);
      
      this.sendProgress(0, 5, `Starting research: "${query}"`);
      const report = await this.researchTopic(query, max_pages, engines, controller.signal);
      
      return {
        content: [{
          type: 'text',
          text: report
        }]
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        return {
          content: [{ type: 'text', text: `⏱️ Research timeout (${this.timeout/1000}s). Try narrowing the query.` }],
          isError: true
        };
      }
      return {
        content: [{ type: 'text', text: `❌ Research error: ${err.message}` }],
        isError: true
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async researchTopic(query, maxPages, engines, signal) {
    const visitedUrls = new Set();
    let allScrapedContent = [];
    let currentSynthesis = null;
    let iteration = 0;
    
    while (iteration < this.limits.maxIterations) {
      console.error(`\n${'='.repeat(60)}`);
      console.error(`🔄 ITERATION ${iteration + 1}/${this.limits.maxIterations}`);
      console.error(`${'='.repeat(60)}`);
      
      const iterPhase = iteration * 5;
      this.sendProgress(iterPhase, 10, `Iteration ${iteration + 1}/${this.limits.maxIterations}`);
      
      // Determine query for this iteration
      const iterationQuery = iteration === 0 ? query : currentSynthesis.followUpQuery;
      const enhancedQuery = this.enhanceQuery(iterationQuery);
      
      console.error(`\n🔍 Query: "${iterationQuery}"`);
      if (enhancedQuery !== iterationQuery) {
        console.error(`   Enhanced to: "${enhancedQuery}"`);
      }
      console.error(`   Raw query length: ${enhancedQuery.length} chars`);
      
      // Phase 1: Search engines
      console.error('\n📡 Phase 1: Searching...');
      this.sendProgress(iterPhase + 1, 10, '🔍 Searching across engines...');
      const searchResults = await this.searchMultipleEngines(enhancedQuery, engines, signal);
      
      // Filter out visited URLs
      const unvisitedResults = searchResults.filter(r => !visitedUrls.has(r.url));
      console.error(`   Found ${searchResults.length} results (${unvisitedResults.length} new)`);
      
      if (unvisitedResults.length === 0) {
        console.error(`   ℹ️ No new sources found, ending iteration`);
        break;
      }

      // Phase 2: LLM selects best sources
      console.error('\n🤖 Phase 2: Selecting best sources...');
      this.sendProgress(iterPhase + 2, 10, `📋 Selecting best ${maxPages} sources...`);
      const selectedUrls = await this.selectBestSources(iterationQuery, unvisitedResults, maxPages, signal);
      console.error(`   Selected ${selectedUrls.length} URLs to scrape`);

      // Phase 3: Scrape pages
      console.error('\n📄 Phase 3: Scraping content...');
      this.sendProgress(iterPhase + 3, 10, `🌐 Scraping ${selectedUrls.length} pages...`);
      const newContent = await this.scrapePages(selectedUrls, signal);
      console.error(`   Successfully scraped ${newContent.length} pages`);
      
      // Track visited URLs
      selectedUrls.forEach(url => visitedUrls.add(url));
      allScrapedContent.push(...newContent);

      if (allScrapedContent.length === 0) {
        return '❌ Failed to scrape any content. Sources may be blocked or unavailable.';
      }

      // Phase 4: Cross-reference and synthesize
      console.error('\n🔬 Phase 4: Synthesizing...');
      this.sendProgress(iterPhase + 4, 10, '🧠 Synthesizing findings...');
      const synthesis = await this.synthesizeContent(query, allScrapedContent, signal);
      
      // Phase 5: Self-evaluation (only if not final iteration)
      if (iteration < this.limits.maxIterations - 1) {
        console.error('\n🎯 Phase 5: Self-evaluation...');
        this.sendProgress(iterPhase + 5, 10, '🎯 Evaluating synthesis quality...');
        const evaluation = await this.evaluateSynthesis(query, synthesis, signal);
        
        console.error(`   Confidence: ${evaluation.confidence}%`);
        console.error(`   Gaps: ${evaluation.gaps.length > 0 ? evaluation.gaps.join('; ') : 'none'}`);
        
        if (evaluation.confidence >= 80) {
          console.error(`   ✅ Confidence threshold met, research complete`);
          currentSynthesis = { text: synthesis, ...evaluation };
          break;
        }
        
        if (evaluation.followUpQuery) {
          console.error(`   🔄 Follow-up: "${evaluation.followUpQuery}"`);
          this.sendProgress(iterPhase + 5, 10, `🔄 Follow-up: "${evaluation.followUpQuery}"`);
          currentSynthesis = { text: synthesis, ...evaluation };
          iteration++;
        } else {
          console.error(`   ℹ️ No follow-up query generated, ending`);
          currentSynthesis = { text: synthesis, ...evaluation };
          break;
        }
      } else {
        currentSynthesis = { text: synthesis };
        break;
      }
    }
    
    console.error('\n✅ Research complete\n');
    this.sendProgress(10, 10, '✅ Research complete');
    return currentSynthesis.text;
  }

  async searchMultipleEngines(query, engines, signal) {
    const searches = engines.map(engine => this.searchEngine(engine, query, signal));
    const results = await Promise.allSettled(searches);
    
    const allResults = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        console.error(`   ✓ ${engines[i]}: ${result.value.length} results`);
        allResults.push(...result.value);
      } else {
        console.error(`   ⚠️ ${engines[i]} search failed: ${result.reason.message}`);
      }
    });
    
    // Deduplicate by URL
    const seen = new Set();
    const deduped = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
    
    console.error(`   Total after dedup: ${deduped.length} unique sources`);
    
    return deduped;
  }

  async searchEngine(engine, query, signal) {
    const browser = await puppeteer.launch({ 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    
    try {
      const page = await browser.newPage();
      await this.setupStealthMode(page);
      
      let searchUrl, resultSelector, linkSelector, titleSelector;
      
      if (engine === 'duckduckgo') {
        searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
        resultSelector = '.result';
        linkSelector = '.result__a';
        titleSelector = '.result__a';
      } else if (engine === 'google') {
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us`;
        resultSelector = '.g';
        linkSelector = 'a';
        titleSelector = 'h3';
      } else if (engine === 'bing') {
        searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&cc=US`;
        resultSelector = '.b_algo';
        linkSelector = 'h2 a';
        titleSelector = 'h2';
      } else {
        return [];
      }

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      
      // Debug: check what we actually got
      if (engine === 'google') {
        const pageTitle = await page.title();
        const bodyText = await page.evaluate(() => document.body.textContent.substring(0, 500));
        console.error(`   [Google Debug] Title: ${pageTitle}`);
        console.error(`   [Google Debug] Body preview: ${bodyText.substring(0, 100)}...`);
      }
      
      const results = await page.evaluate((rs, ls, ts) => {
        const items = [];
        document.querySelectorAll(rs).forEach(el => {
          const link = el.querySelector(ls);
          const title = el.querySelector(ts);
          if (link && link.href && title) {
            items.push({
              url: link.href,
              title: title.textContent.trim(),
              snippet: el.textContent.substring(0, 200).trim()
            });
          }
        });
        return items;
      }, resultSelector, linkSelector, titleSelector);
      
      // Decode Bing redirect URLs to get actual destination
      const cleanedResults = results.map(r => {
        if (r.url.includes('bing.com/ck/a')) {
          try {
            const url = new URL(r.url);
            const encodedUrl = url.searchParams.get('u');
            if (encodedUrl) {
              // Bing uses base64-like encoding with custom alphabet
              // Try to decode: a1aHR0cHM6Ly9... pattern (a1 = base64 marker)
              const decoded = Buffer.from(encodedUrl.substring(2), 'base64').toString('utf-8');
              r.url = decoded;
              console.error(`   [Bing] Decoded: ${r.url.substring(0, 60)}...`);
            }
          } catch (e) {
            console.error(`   [Bing] Decode failed for ${r.title}, keeping redirect URL`);
          }
        }
        return r;
      });

      return cleanedResults.slice(0, 15); // Top 15 from each engine
    } catch (err) {
      console.error(`   ${engine} error: ${err.message}`);
      return [];
    } finally {
      await browser.close();
    }
  }

  async selectBestSources(query, searchResults, maxPages, signal) {
    // Pre-filter: Remove obviously irrelevant results
    const filtered = searchResults.filter(r => {
      const url = r.url.toLowerCase();
      const title = r.title.toLowerCase();
      const snippet = r.snippet.toLowerCase();
      const combined = title + ' ' + snippet;
      
      // Reject app stores
      if (url.includes('apps.apple.com') || url.includes('play.google.com')) return false;
      
      // Reject generic homepages (unless query is about that company)
      const queryLower = query.toLowerCase();
      if ((url.match(/\//g) || []).length <= 3) { // Very short URL = likely homepage
        const domain = url.split('/')[2]?.replace('www.', '');
        if (domain && !queryLower.includes(domain.split('.')[0])) {
          // Homepage but query doesn't mention company
          return false;
        }
      }
      
      // Reject social media posts (keep only profiles/repos)
      if (url.includes('twitter.com') || url.includes('facebook.com') || url.includes('instagram.com')) return false;
      
      // Require at least some keyword overlap (but be lenient)
      const queryWords = query.toLowerCase().replace(/["]/g, '').split(/\s+/).filter(w => w.length > 2);
      const hasOverlap = queryWords.some(word => 
        word.length > 3 && combined.includes(word)
      );
      
      if (!hasOverlap && queryWords.length > 2) {
        // Only reject if we have enough keywords and NONE match
        return false;
      }
      
      return true;
    });
    
    console.error(`   [DEBUG] Pre-filter: ${searchResults.length} → ${filtered.length} sources`);
    if (filtered.length === 0) {
      console.error('   ⚠️ All sources filtered out, falling back to top results');
      return searchResults.slice(0, maxPages).map(r => r.url);
    }
    
    console.error(`   Pre-filtered: ${searchResults.length} → ${filtered.length} sources`);
    if (filtered.length < searchResults.length) {
      const removed = searchResults.filter(s => !filtered.includes(s));
      console.error(`   🗑️  Filtered out ${removed.length} sources:`);
      removed.slice(0, 5).forEach(s => {
        console.error(`      - ${s.url} (${s.title.substring(0, 40)}...)`);
      });
    }
    
    const prompt = `You are a strict JSON-only responder.

Rank the ${filtered.length} URLs for the query "${query}":

${filtered.map((r, i) => `${i+1}. ${r.url}`).join('\n')}

Prioritize: docs > papers > tutorials > github > stackoverflow > blogs
Reject: marketing, news, homepages, app stores

Output ONLY a JSON array of the top ${Math.min(maxPages, filtered.length)} numbers, nothing else, no explanation, no markdown.

Example valid output: [3, 7, 1, 9, 2, 4, 8, 6, 10, 5]

Array:`;


    try {
      const response = await this.queryLLM(prompt, signal);
      
      console.error(`   [DEBUG] LLM raw response: ${response.substring(0, 300)}`);
      
      // Extract JSON array using regex
      const arrayMatch = response.match(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/);
      
      if (arrayMatch) {
        const indices = JSON.parse(arrayMatch[0]);
        console.error(`   [DEBUG] Parsed array: ${JSON.stringify(indices)}`);
        
        if (Array.isArray(indices) && indices.length > 0) {
          const valid = [];
          
          for (const item of indices) {
            if (typeof item === 'number' && item >= 1 && item <= filtered.length) {
              valid.push(filtered[item - 1].url);
            }
          }
          
          if (valid.length > 0) {
            console.error(`   ✓ LLM selected ${valid.length} sources`);
            return valid.slice(0, maxPages);
          }
        }
      }
      
      throw new Error('No valid JSON array found in LLM response');
    } catch (err) {
      // Fallback: take top results if LLM fails
      console.error(`   ⚠️ LLM selection failed (${err.message}), using top filtered results`);
      return filtered.slice(0, maxPages).map(r => r.url);
    }
  }

  async scrapePages(urls, signal) {
    const results = [];
    
    // Scrape with configured concurrency limit
    const concurrency = this.limits.concurrentScrapes;
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      
      // Add random delay between batches to avoid rate limiting
      if (i > 0) {
        const batchDelay = 1000 + Math.random() * 2000; // 1-3s between batches
        await new Promise(r => setTimeout(r, batchDelay));
      }
      
      // Each page gets its own isolated browser instance
      const promises = batch.map(url => this.scrapePageIsolated(url, signal));
      const batchResults = await Promise.allSettled(promises);
      
      batchResults.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
          console.error(`   ✓ Scraped: ${batch[idx]} (${Math.round(result.value.content.length / 1024)}KB)`);
        } else {
          const reason = result.reason?.message || result.reason || 'Unknown error';
          console.error(`   ✗ Failed: ${batch[idx]}`);
          console.error(`      Reason: ${reason}`);
        }
      });
    }
    
    return results;
  }

  async scrapePageIsolated(url, signal) {
    let browser = null;
    let killTimer = null;
    
    try {
      browser = await puppeteer.launch({ 
        headless: true,
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
      
      // Hard kill browser if timeout exceeded
      killTimer = setTimeout(async () => {
        console.error(`   ⚠️ Force-killing browser for ${url.substring(0, 60)}...`);
        if (browser && browser.process()) {
          const proc = browser.process();
          try {
            // Windows-compatible force kill
            if (process.platform === 'win32') {
              const { execSync } = await import('child_process');
              execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
            } else {
              proc.kill('SIGKILL');
            }
          } catch (e) {
            // Already dead
          }
        }
      }, this.limits.scrapeTimeout + 1000);
      
      const result = await this.scrapePage(browser, url, signal);
      clearTimeout(killTimer);
      return result;
      
    } catch (err) {
      console.error(`   ✗ ${url.substring(0, 60)}... (${err.message})`);
      return null;
    } finally {
      if (killTimer) clearTimeout(killTimer);
      if (browser) {
        try {
          const closePromise = browser.close();
          const timeoutPromise = new Promise(resolve => setTimeout(resolve, 2000));
          await Promise.race([closePromise, timeoutPromise]);
          
          // If still running after timeout, force kill (Windows-compatible)
          if (browser.process() && !browser.process().killed) {
            const proc = browser.process();
            if (process.platform === 'win32') {
              const { execSync } = await import('child_process');
              try {
                execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
              } catch (e) {}
            } else {
              proc.kill('SIGKILL');
            }
          }
        } catch (e) {
          // Force kill on any error
          try {
            if (browser.process() && !browser.process().killed) {
              const proc = browser.process();
              if (process.platform === 'win32') {
                const { execSync } = await import('child_process');
                execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
              } else {
                proc.kill('SIGKILL');
              }
            }
          } catch (killErr) {
            // Already dead, ignore
          }
        }
      }
    }
  }

  async scrapePage(browser, url, signal) {
    const page = await browser.newPage();
    
    try {
      // Wrap entire scrape operation in timeout promise
      const scrapePromise = (async () => {
        await this.setupStealthMode(page);
        
        // Random delay before navigation (100-500ms)
        await this.randomDelay(100, 500);
        
        // Use site-specific scraper if available
        const html = await this.scraperRegistry.scrapeUrl(url, page);
        
        // Extract clean content using Readability
        const extracted = this.extractReadableContent(html, url);
        
        if (!extracted) {
          console.error(`   ✗ ${url.substring(0, 60)}... (Readability failed)`);
          return null;
        }
        
        console.error(`   ✓ ${url.substring(0, 60)}...`);
        
        return { 
          url, 
          content: extracted.textContent,
          title: extracted.title,
          excerpt: extracted.excerpt,
          sections: extracted.sections
        };
      })();
      
      // Race between scrape and timeout
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Scrape timeout')), this.limits.scrapeTimeout)
      );
      
      return await Promise.race([scrapePromise, timeoutPromise]);
    } catch (err) {
      console.error(`   ✗ ${url.substring(0, 60)}... (${err.message})`);
      return null;
    } finally {
      await page.close().catch(() => {});
    }
  }
  
  extractReadableContent(html, url) {
    try {
      const htmlSize = html.length;
      
      // Create DOM from HTML
      const dom = new JSDOM(html, { url });
      const doc = dom.window.document;
      
      // Use Readability to extract main content
      const reader = new Readability(doc, {
        charThreshold: 500, // Min chars for valid article
        nbTopCandidates: 5
      });
      
      const article = reader.parse();
      
      if (!article) return null;
      
      // Extract section structure from parsed content
      const contentDom = new JSDOM(article.content);
      const contentDoc = contentDom.window.document;
      
      const sections = [];
      const headings = contentDoc.querySelectorAll('h1, h2, h3');
      
      headings.forEach(heading => {
        const level = parseInt(heading.tagName[1]);
        const text = heading.textContent.trim();
        if (text) {
          sections.push({ level, heading: text });
        }
      });
      
      // Extract clean text (strip HTML but preserve structure)
      const textContent = contentDoc.body.textContent
        .replace(/\s+/g, ' ')
        .trim();
      
      // Respect memory limit
      const maxChars = Math.floor(this.limits.maxMemoryPerPage / 2);
      const truncated = textContent.substring(0, maxChars);
      
      const reduction = ((1 - truncated.length / htmlSize) * 100).toFixed(1);
      console.error(`      Size: ${htmlSize.toLocaleString()} → ${truncated.length.toLocaleString()} chars (${reduction}% smaller)`);
      
      if (sections.length > 0) {
        console.error(`      Sections: ${sections.slice(0, 5).map(s => s.heading).join(' | ')}${sections.length > 5 ? '...' : ''}`);
      }
      
      // Show first 200 chars of extracted content for quality check
      const preview = truncated.substring(0, 200).replace(/\s+/g, ' ');
      console.error(`      Preview: ${preview}...`);
      
      return {
        title: article.title,
        textContent: truncated,
        excerpt: article.excerpt,
        sections: sections.slice(0, 20) // Max 20 headings for structure
      };
    } catch (err) {
      console.error(`   Readability extraction failed: ${err.message}`);
      return null;
    }
  }

  async synthesizeContent(query, scrapedContent, signal) {
    // Build structured source list with sections
    const sources = scrapedContent.map((s, i) => {
      let text = `--- SOURCE ${i+1}: ${s.url} ---\n`;
      if (s.title) text += `Title: ${s.title}\n`;
      if (s.sections && s.sections.length > 0) {
        text += `Sections: ${s.sections.map(sec => sec.heading).join(', ')}\n`;
      }
      text += `\n${s.content}\n`;
      return text;
    }).join('\n');
    
    const prompt = `Research query: "${query}"

I've gathered content from ${scrapedContent.length} sources. Each has been cleaned using Readability to remove ads/navigation/boilerplate. Analyze and synthesize this information.

${sources}

Tasks:
1. Identify key facts that appear in MULTIPLE sources (high confidence)
2. Note any contradictions or disagreements between sources
3. Synthesize into a clear, concise summary (500-800 words)
4. Include citations using [1], [2] notation
5. Add "Sources:" section at the end with numbered URLs

Format as clean markdown. Be concise and factual.`;

    const synthesis = await this.queryLLM(prompt, signal, 12288);
    return synthesis;
  }

  async evaluateSynthesis(query, synthesis, signal) {
    const prompt = `Original research query: "${query}"

Research synthesis:
${synthesis}

Critically evaluate this synthesis:
1. What is your confidence this answers the query completely? (0-100)
2. What important questions remain unanswered?
3. Are there any contradictions or gaps in the information?
4. What specific follow-up query would fill the biggest gap?

Return JSON only:
{
  "confidence": <number 0-100>,
  "gaps": [<string>, ...],
  "contradictions": [<string>, ...],
  "followUpQuery": "<string or null>"
}`;

    const response = await this.queryLLM(prompt, signal, 1024);
    
    // Extract JSON using brace-counting (same robust approach as selectBestSources)
    const candidates = [];
    let depth = 0, start = -1;
    
    for (let i = 0; i < response.length; i++) {
      if (response[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (response[i] === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          candidates.push(response.substring(start, i + 1));
          start = -1;
        }
      }
    }
    
    // Try candidates in reverse (last is usually the valid one)
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(candidates[i]);
        if (typeof parsed.confidence === 'number') {
          return parsed;
        }
      } catch {}
    }
    
    // Fallback: high confidence, no follow-up (iteration stops)
    this.log.warn('Failed to parse evaluation JSON, stopping iteration');
    return { confidence: 85, gaps: [], contradictions: [], followUpQuery: null };
  }

  async mergeSyntheses(originalQuery, firstSynthesis, followUpQuery, secondSynthesis, signal) {
    const prompt = `Original research query: "${originalQuery}"

First synthesis:
${firstSynthesis}

Follow-up query: "${followUpQuery}"
Additional findings:
${secondSynthesis}

Merge these into a single comprehensive synthesis:
1. Integrate new findings with original
2. Resolve any contradictions
3. Maintain clear structure with citations
4. Keep it concise (800-1200 words)

Return the merged synthesis in markdown.`;

    return await this.queryLLM(prompt, signal, 16384);
  }

  async queryLLM(prompt, signal, maxTokens = 1000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.limits.llmTimeout);
    
    try {
      const res = await fetch(this.llmEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.llmModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: maxTokens
        }),
        signal: signal || controller.signal
      });

      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      
      const data = await res.json();
      if (!data?.choices?.[0]?.message?.content) {
        throw new Error('Invalid LLM response');
      }
      
      return data.choices[0].message.content;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async setupStealthMode(page) {
    // Randomize viewport to common resolutions
    const viewports = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1536, height: 864 },
      { width: 1440, height: 900 }
    ];
    const viewport = viewports[Math.floor(Math.random() * viewports.length)];
    await page.setViewport(viewport);

    // Realistic user agents
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
    ];
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(userAgent);

    // Set realistic headers with custom User-Agent
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
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

    // Remove webdriver flags and add realistic browser properties
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });

      // Mock plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });

      // Mock languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });

      // Chrome runtime
      window.chrome = {
        runtime: {}
      };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
      
      // Override WebGL vendor for better fingerprinting
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Intel Inc.';
        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
        return getParameter.call(this, parameter);
      };
    });
  }

  async humanScroll(page) {
    try {
      // Random scroll depth (30-80% of page)
      const scrollPercent = 0.3 + Math.random() * 0.5;
      await page.evaluate((percent) => {
        window.scrollTo({
          top: document.body.scrollHeight * percent,
          behavior: 'smooth'
        });
      }, scrollPercent);
      
      // Wait a bit after scrolling
      await this.randomDelay(300, 800);
    } catch (err) {
      // Ignore scroll errors
    }
  }

  randomDelay(min, max) {
    const delay = min + Math.random() * (max - min);
    return new Promise(resolve => setTimeout(resolve, delay));
  }
}
