import { ScraperRegistry } from '../scrapers/index.js';
import { searchGoogle } from '../scrapers/google-adapter.js';
import { searchDuckDuckGo } from '../scrapers/duckduckgo-adapter.js';
import { extractContent, validateContent } from '../scrapers/content-extractor.js';
import { StreamingResearchPipeline, prioritizeUrls, shouldTerminateEarly } from '../lib/streaming-research.js';

export class WebResearchServer {
  constructor(config, llmRouter = null, browserServer = null) {
    this.router = llmRouter;
    this.browserServer = browserServer; // Shared browser instance
    this.synthesisProvider = config.synthesisProvider || null; // null = use task default
    this.selectionProvider = config.selectionProvider || null;
    this.scraperRegistry = new ScraperRegistry();
    
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
      try {
        this.progressCallback({ progress, total, message });
      } catch {
        // Client disconnected, ignore
      }
    }
  }

  enhanceQuery(query) {
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

Generate 3-5 search query variants optimized for Google/DuckDuckGo/Bing.`;

    const schema = {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              reasoning: { type: 'string' }
            },
            required: ['query', 'reasoning']
          }
        },
        recommended: { type: 'string' }
      },
      required: ['queries', 'recommended']
    };

    try {
      const parsed = await this.queryLLM(prompt, null, 1500, schema);
      
      if (!parsed?.queries || !Array.isArray(parsed.queries) || !parsed.recommended) {
        throw new Error('Invalid response structure');
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
    return [{
      name: 'research_topic',
      description: 'Research a topic via web search. Multi-phase: search, select sources, scrape, synthesize with citations. Returns complete report.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (quote terms, use site: filters)' },
          max_pages: { type: 'number', description: 'Max pages (default: 10)' },
          engines: { type: 'array', items: { type: 'string' }, description: 'google, duckduckgo, bing' }
        },
        required: ['query']
      }
    }];
  }

  handlesTool(name) {
    return name === 'research_topic';
  }

  async callTool(name, args) {
    console.error('[WebResearch] callTool entered');
    
    const { query, max_pages = this.maxPages, engines = this.searchEngines } = args;
    console.error(`[WebResearch] query=${query}, max_pages=${max_pages}, engines=${engines}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      console.error(`\n🔍 Research: "${query}"`);
      console.error(`   Limits: ${max_pages} pages, ${this.timeout/1000}s timeout`);
      
      this.sendProgress(0, 5, `Starting research: "${query}"`);
      
      const report = max_pages >= 5 
        ? await this.researchTopicFast(query, max_pages, engines, controller.signal)
        : await this.researchTopic(query, max_pages, engines, controller.signal);
      
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
    
    if (!currentSynthesis || !currentSynthesis.text) {
      return '❌ Research failed: No content could be synthesized from available sources.';
    }
    
    return currentSynthesis.text;
  }

  async researchTopicFast(query, maxPages = 10, engines, signal) {
    const startTime = Date.now();
    console.error(`\n🚀 FAST RESEARCH MODE: "${query}"`);
    console.error(`   Target: ${maxPages} pages, streaming synthesis`);
    
    console.error('\n📡 Phase 1: Searching...');
    const searchResults = await this.searchMultipleEngines(query, engines, signal);
    
    if (searchResults.length === 0) {
      return '❌ No search results found.';
    }
    
    console.error(`   Prioritizing ${searchResults.length} results...`);
    const urls = prioritizeUrls(searchResults.map(r => r.url), query);
    const topUrls = urls.slice(0, maxPages);
    console.error(`   Top ${topUrls.length} URLs selected for scraping`);
    
    console.error('\n📄 Phase 2: Streaming scrape & synthesis...');
    const pipeline = new StreamingResearchPipeline({
      maxConcurrent: 10,
      scrapeTimeout: this.limits.scrapeTimeout,
      maxTotalTime: 45000 // 45s hard limit for scraping
    });
    
    const scrapedContent = [];
    let synthesis = null;
    let pageCount = 0;
    
    const scrapeFn = async (url) => {
      const result = await this.scrapePageWrapper(url, signal);
      return result ? { success: true, ...result } : null;
    };
    
    for await (const update of pipeline.scrapeStreaming(topUrls, scrapeFn, signal)) {
      if (signal?.aborted) break;
      
      if (update.type === 'page') {
        pageCount = update.count;
        scrapedContent.push(update.data);
        this.sendProgress(Math.min(pageCount, 5), 6, `📄 Scraped ${pageCount} pages...`);
        
        if (shouldTerminateEarly(scrapedContent, { 
          minSources: 3, 
          minTotalChars: 3000,
          minHighQualitySources: 2 
        })) {
          console.error(`   ✅ Early termination: sufficient content gathered`);
          break;
        }
      }
    }
    
    if (scrapedContent.length === 0) {
      return '❌ Failed to scrape any content from sources.';
    }
    
    console.error(`   Scraped ${scrapedContent.length} pages in ${Date.now() - startTime}ms`);
    
    console.error('\n🔬 Phase 3: Synthesizing...');
    this.sendProgress(5, 6, '🧠 Synthesizing findings...');
    synthesis = await this.synthesizeContent(query, scrapedContent, signal);
    
    console.error(`\n✅ Research complete in ${Date.now() - startTime}ms\n`);
    this.sendProgress(6, 6, '✅ Research complete');
    
    return synthesis;
  }
  
  async scrapePageWrapper(url, signal) {
    try {
      const pageHandle = await this.browserServer.getPage();
      const { page, markUsed, close } = pageHandle;
      
      try {
        const result = await this.scrapePage(page, url, signal);
        markUsed();
        return result;
      } finally {
        close();
      }
    } catch (err) {
      console.error(`   ✗ ${url.substring(0, 60)}... (${err.message})`);
      return null;
    }
  }

  async searchMultipleEngines(query, engines, signal) {
    console.error(`   [DEBUG] Searching with engines: ${engines.join(', ')}`);
    const searches = engines.map(engine => this.searchEngineAdapter(engine, query));
    const results = await Promise.allSettled(searches);
    
    const allResults = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        const engineResults = result.value;
        console.error(`   ✓ ${engines[i]}: ${engineResults.length} results`);
        // Log first result source for verification
        if (engineResults.length > 0) {
          console.error(`      Sample: ${engineResults[0].url?.substring(0, 50)}... (_engine: ${engineResults[0]._engine})`);
        }
        allResults.push(...engineResults);
      } else {
        console.error(`   ⚠️ ${engines[i]} search failed: ${result.reason.message}`);
        console.error(`   Stack: ${result.reason.stack?.substring(0, 200)}`);
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

  async searchEngineAdapter(engine, query) {
    // Use browser server for supported engines
    let results;
    if (engine === 'google') {
      results = await searchGoogle(query, this.browserServer);
    } else if (engine === 'duckduckgo') {
      results = await searchDuckDuckGo(query, this.browserServer);
    } else {
      // Fallback to old method for unsupported engines
      results = await this.searchEngine(engine, query);
    }
    
    // Tag results with source engine for debugging
    return results.map(r => ({ ...r, _engine: engine }));
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
    
    const prompt = `Rank URLs by relevance and authority for the query "${query}".

**High-Priority Sources (rank these FIRST):**
1. GitHub issues/pull requests (github.com/*/issues, github.com/*/pull) - for bugs, errors, troubleshooting
2. StackOverflow answers (stackoverflow.com/questions) - for technical problems
3. Official documentation (docs.*, */documentation/*, */api/*, */reference/*)
4. Wikipedia (wikipedia.org, *.wikipedia.org) - for general knowledge
5. Academic papers (arxiv.org, *.edu, *.ac.uk, scholar.google.com)
6. Technical blogs from known sources (github.blog, stackoverflow.blog)

**Medium-Priority:**
7. GitHub repositories (github.com/*/tree, github.com/*/*) - for code examples
8. Technical forums (reddit.com/r/*, discourse.*, forum.*)
9. Developer blogs (dev.to, medium.com, hashnode.com)

**Lower-Priority:**
10. News sites, marketing pages, product homepages

**Reject entirely:** App stores, social media posts, paywalls, spam

URLs to rank:
${filtered.map((r, i) => `${i+1}. ${r.url} - ${r.title.substring(0, 80)}`).join('\n')}

Return the top ${Math.min(maxPages, filtered.length)} indices (1-indexed) in order of relevance.`;

    const schema = {
      type: 'object',
      properties: {
        indices: {
          type: 'array',
          items: { type: 'number' }
        }
      },
      required: ['indices']
    };

    try {
      const response = await this.queryLLM(prompt, signal, 2000, schema);
      const indices = response?.indices;
      
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
      
      throw new Error('No valid indices in response');
    } catch (err) {
      console.error(`   ⚠️ LLM selection failed (${err.message}), using top filtered results`);
      return filtered.slice(0, maxPages).map(r => r.url);
    }
  }

  async scrapePages(urls, signal) {
    const results = [];
    
    const concurrency = this.limits.concurrentScrapes;
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const batchNum = Math.floor(i / concurrency) + 1;
      const totalBatches = Math.ceil(urls.length / concurrency);
      
      this.sendProgress(i, urls.length, `🌐 Scraping batch ${batchNum}/${totalBatches}...`);
      
      if (i > 0) {
        const batchDelay = 1000 + Math.random() * 2000; // 1-3s between batches
        await new Promise(r => setTimeout(r, batchDelay));
      }
      
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
    if (!this.browserServer) {
      throw new Error('Browser server not available for scraping');
    }
    
    const pageHandle = await this.browserServer.getPage();
    const { page, markUsed, close } = pageHandle;
    
    try {
      const result = await this.scrapePage(page, url, signal);
      markUsed();
      return result;
    } catch (err) {
      console.error(`   ✗ ${url.substring(0, 60)}... (${err.message})`);
      return null;
    } finally {
      close();
    }
  }

  async scrapePage(page, url, signal) {
    let html = null;
    
    try {
      await this.setupStealthMode(page);
      
      // Random delay before navigation (100-500ms)
      await this.randomDelay(100, 500);
      
      const scrapePromise = this.scraperRegistry.scrapeUrl(url, page);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Scrape timeout')), this.limits.scrapeTimeout)
      );
      
      try {
        html = await Promise.race([scrapePromise, timeoutPromise]);
      } catch (err) {
        if (err.message === 'Scrape timeout') {
          console.error(`   ⏱️  ${url.substring(0, 60)}... (timeout, using partial content)`);
          html = await page.content().catch(() => null);
        } else {
          throw err;
        }
      }
      
      if (!html) {
        console.error(`   ✗ ${url.substring(0, 60)}... (no content)`);
        return null;
      }
      
      const extracted = extractContent(html, url, {
        minLength: 200,
        maxLength: Math.floor(this.limits.maxMemoryPerPage / 2),
        charThreshold: 200
      });
      
      if (!extracted || !extracted.success) {
        console.error(`   ✗ ${url.substring(0, 60)}... (extraction failed: ${extracted?.error || 'unknown'})`);
        return null;
      }
      
      const validation = validateContent(extracted, url);
      if (!validation.valid) {
        console.error(`   ✗ ${url.substring(0, 60)}... (content invalid: ${validation.reason})`);
        return null;
      }
      
      console.error(`   ✓ ${url.substring(0, 60)}... (${extracted.strategy})`);
      
      return { 
        url, 
        content: extracted.content,
        title: extracted.title,
        excerpt: extracted.excerpt,
        sections: extracted.sections,
        strategy: extracted.strategy,
        stats: extracted.stats
      };
    } catch (err) {
      console.error(`   ✗ ${url.substring(0, 60)}... (${err.message})`);
      return null;
    }
  }
  
  async synthesizeContent(query, scrapedContent, signal) {
    // Build structured source list with sections
    const sources = scrapedContent.map((s, i) => {
      let text = `--- SOURCE ${i+1}: ${s.url} ---\n`;
      if (s.title) text += `Title: ${s.title}\n`;
      if (s._engine) text += `Engine: ${s._engine}\n`;
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

    const synthesis = await this.queryLLM(prompt, signal, 1024);
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
4. What specific follow-up query would fill the biggest gap?`;

    const schema = {
      type: 'object',
      properties: {
        confidence: { type: 'number' },
        gaps: { type: 'array', items: { type: 'string' } },
        contradictions: { type: 'array', items: { type: 'string' } },
        followUpQuery: { type: 'string', nullable: true }
      },
      required: ['confidence', 'gaps', 'contradictions', 'followUpQuery']
    };

    try {
      const response = await this.queryLLM(prompt, signal, 1024, schema);
      
      if (typeof response?.confidence === 'number') {
        return response;
      }
      throw new Error('Invalid evaluation response');
    } catch {
      // Fallback: high confidence, no follow-up (iteration stops)
      return { confidence: 85, gaps: [], contradictions: [], followUpQuery: null };
    }
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

  async queryLLM(prompt, signal, maxTokens = 1000, responseFormat = null, progressMessage = null) {
    if (!this.router) {
      throw new Error('LLM router not configured for web research');
    }

    console.error(`[WebResearch.queryLLM] router exists: ${!!this.router}, provider: ${this.synthesisProvider}, maxTokens: ${maxTokens}`);
    console.error(`[WebResearch.queryLLM] prompt length: ${prompt.length}, responseFormat: ${!!responseFormat}`);
    
    console.error(`[WebResearch.queryLLM] About to call router.predict`);
    const response = await this.router.predict({
      prompt,
      responseFormat
    });
    
    console.error(`[WebResearch.queryLLM] router.predict succeeded`);
    // If responseFormat was specified, router returns JSON string - parse it
    if (responseFormat) {
      try {
        return JSON.parse(response);
      } catch {
        return response; // Fallback to raw if parse fails
      }
    }
    return response;
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
