import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { ScraperRegistry } from '../scrapers/index.js';
import { searchGoogle } from '../scrapers/google-adapter.js';
import { searchDuckDuckGo } from '../scrapers/duckduckgo-adapter.js';

export class WebResearchServer {
  constructor(config, llmRouter = null, browserServer = null) {
    this.router = llmRouter;
    this.browserServer = browserServer; // Shared browser instance
    this.synthesisProvider = config.synthesisProvider || null; // null = use task default
    this.selectionProvider = config.selectionProvider || null;
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
      try {
        this.progressCallback(progress, total, message);
      } catch {
        // Client disconnected, ignore
      }
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
    return [
      // prepare_research_query - kept in backpocket, not exposed
      // See prepareQuery() method below for implementation
      {
        name: 'research_topic',
        description: 'AUTONOMOUS WEB RESEARCH: 5-phase pipeline that (1) searches multiple engines, (2) selects best sources via local LLM, (3) scrapes with 10 concurrent headless browsers, (4) cross-references facts, (5) synthesizes summary with citations. Use when you need current information Claude doesn\'t know. TIP: Optimize query BEFORE calling - use quotes for exact terms ("Virtual DOM"), site: filters (site:stackoverflow.com), specific phrasing to reduce ambiguity. The pipeline runs autonomously and returns a complete research report. Always display the complete research report to the user VERBATIM before providing commentary.',
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
    console.error('[WebResearch] callTool entered');
    
    const { query, max_pages = this.maxPages, engines = this.searchEngines } = args;
    console.error(`[WebResearch] query=${query}, max_pages=${max_pages}, engines=${engines}`);
    
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
    
    if (!currentSynthesis || !currentSynthesis.text) {
      return '❌ Research failed: No content could be synthesized from available sources.';
    }
    
    return currentSynthesis.text;
  }

  async searchMultipleEngines(query, engines, signal) {
    const searches = engines.map(engine => this.searchEngineAdapter(engine, query));
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

  async searchEngineAdapter(engine, query) {
    // Use browser server for supported engines
    if (engine === 'google') {
      return await searchGoogle(query, this.browserServer);
    } else if (engine === 'duckduckgo') {
      return await searchDuckDuckGo(query, this.browserServer);
    } else {
      // Fallback to old method for unsupported engines
      return await this.searchEngine(engine, query);
    }
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
    if (!this.browserServer) {
      throw new Error('Browser server not available for scraping');
    }
    
    const pageHandle = await this.browserServer.getPage();
    const { page, markUsed, close } = pageHandle;
    
    try {
      const result = await this.scrapePage(page, url, signal);
      markUsed(); // Mark for lingering cleanup
      return result;
    } catch (err) {
      console.error(`   ✗ ${url.substring(0, 60)}... (${err.message})`);
      return null;
    } finally {
      close(); // Release back to browser server for cleanup
    }
  }

  async scrapePage(page, url, signal) {
    let html = null;
    
    try {
      await this.setupStealthMode(page);
      
      // Random delay before navigation (100-500ms)
      await this.randomDelay(100, 500);
      
      // Try to scrape with timeout, but capture partial content on timeout
      const scrapePromise = this.scraperRegistry.scrapeUrl(url, page);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Scrape timeout')), this.limits.scrapeTimeout)
      );
      
      try {
        html = await Promise.race([scrapePromise, timeoutPromise]);
      } catch (err) {
        if (err.message === 'Scrape timeout') {
          // Timeout - grab whatever HTML is currently loaded
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
    } catch (err) {
      console.error(`   ✗ ${url.substring(0, 60)}... (${err.message})`);
      return null;
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

  async queryLLM(prompt, signal, maxTokens = 1000, responseFormat = null) {
    if (!this.router) {
      throw new Error('LLM router not configured for web research');
    }

    console.error(`[WebResearch.queryLLM] router exists: ${!!this.router}, provider: ${this.synthesisProvider}, maxTokens: ${maxTokens}`);
    console.error(`[WebResearch.queryLLM] prompt length: ${prompt.length}, responseFormat: ${!!responseFormat}`);
    
    try {
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
    } catch (err) {
      console.error(`[WebResearch.queryLLM] router.predict failed: ${err.message}`);
      throw new Error(`LLM query failed: ${err.message}`);
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
