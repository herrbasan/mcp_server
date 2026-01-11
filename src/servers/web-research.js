import puppeteer from 'puppeteer';

export class WebResearchServer {
  constructor(config) {
    this.llmEndpoint = config.llmEndpoint;
    this.llmModel = config.llmModel;
    this.maxPages = config.maxPages || 10;
    this.maxDepth = config.maxDepth || 2;
    this.timeout = config.timeout || 180000;
    this.searchEngines = config.searchEngines || ['duckduckgo', 'google'];
  }

  enhanceQuery(query) {
    // Technical terms that need quotes to prevent word splitting
    const technicalTerms = [
      /\bVirtual DOM\b/gi,
      /\bReact\s+\w+/gi, // React hooks, React components, etc.
      /\bVue\s+\w+/gi,
      /\bWeb Components?\b/gi,
      /\bShadow DOM\b/gi,
      /\bService Worker\b/gi,
      /\bWeb Worker\b/gi,
      /\bWebSocket\b/gi,
      /\bIndexedDB\b/gi,
      /\bLocalStorage\b/gi,
      /\bSessionStorage\b/gi,
    ];
    
    let enhanced = query;
    
    // Quote technical terms
    for (const term of technicalTerms) {
      enhanced = enhanced.replace(term, (match) => `"${match}"`);
    }
    
    // Add context keywords for disambiguation
    const contextMap = {
      'Virtual DOM': 'Virtual DOM React performance web development',
      'Shadow DOM': 'Shadow DOM web components JavaScript',
      'Service Worker': 'Service Worker PWA JavaScript',
    };
    
    for (const [term, context] of Object.entries(contextMap)) {
      if (query.toLowerCase().includes(term.toLowerCase()) && !query.includes('"')) {
        // Only add context if we haven't already quoted it
        if (!enhanced.includes(`"${term}"`)) {
          enhanced = context;
          break;
        }
      }
    }
    
    return enhanced;
  }

  getTools() {
    return [{
      name: 'research_topic',
      description: 'Research a topic across multiple web sources. Searches engines, selects best sources, scrapes content, cross-references facts, returns synthesized summary with citations. Cost-effective: uses local LLM for heavy lifting. IMPORTANT: Always display the complete research report to the user VERBATIM before providing any analysis or commentary.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topic or question to research' },
          max_pages: { type: 'number', description: 'Max pages to scrape (default: 10)' },
          engines: { type: 'array', items: { type: 'string' }, description: 'Search engines to use (google, bing, duckduckgo)' }
        },
        required: ['query']
      }
    }];
  }

  handlesTool(name) {
    return name === 'research_topic';
  }

  async callTool(name, args) {
    const { query, max_pages = this.maxPages, engines = this.searchEngines } = args;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      console.error(`\n🔍 Research: "${query}"`);
      console.error(`   Limits: ${max_pages} pages, ${this.timeout/1000}s timeout`);
      
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
    // Enhance query for better technical results
    const enhancedQuery = this.enhanceQuery(query);
    console.error(`\n🔍 Original query: "${query}"`);
    if (enhancedQuery !== query) {
      console.error(`   Enhanced to: "${enhancedQuery}"`);
    }
    
    // Phase 1: Search engines
    console.error('\n📡 Phase 1: Searching...');
    const searchResults = await this.searchMultipleEngines(enhancedQuery, engines, signal);
    console.error(`   Found ${searchResults.length} potential sources`);
    
    if (searchResults.length === 0) {
      return '❌ No search results found. Try a different query.';
    }

    // Phase 2: LLM selects best sources
    console.error('\n🤖 Phase 2: Selecting best sources...');
    const selectedUrls = await this.selectBestSources(query, searchResults, maxPages, signal);
    console.error(`   Selected ${selectedUrls.length} URLs to scrape`);

    // Phase 3: Scrape pages
    console.error('\n📄 Phase 3: Scraping content...');
    const scrapedContent = await this.scrapePages(selectedUrls, signal);
    console.error(`   Successfully scraped ${scrapedContent.length} pages`);

    if (scrapedContent.length === 0) {
      return '❌ Failed to scrape any content. Sources may be blocked or unavailable.';
    }

    // Phase 4: Cross-reference and synthesize
    console.error('\n🔬 Phase 4: Cross-referencing facts...');
    const synthesis = await this.synthesizeContent(query, scrapedContent, signal);
    
    console.error('✅ Research complete\n');
    return synthesis;
  }

  async searchMultipleEngines(query, engines, signal) {
    const searches = engines.map(engine => this.searchEngine(engine, query, signal));
    const results = await Promise.allSettled(searches);
    
    const allResults = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      } else {
        console.error(`   ⚠️ ${engines[i]} search failed: ${result.reason.message}`);
      }
    });
    
    // Deduplicate by URL
    const seen = new Set();
    return allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });
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
        searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        resultSelector = '.result';
        linkSelector = '.result__a';
        titleSelector = '.result__a';
      } else if (engine === 'google') {
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        resultSelector = '.g';
        linkSelector = 'a';
        titleSelector = 'h3';
      } else if (engine === 'bing') {
        searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
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

      return results.slice(0, 15); // Top 15 from each engine
    } catch (err) {
      console.error(`   ${engine} error: ${err.message}`);
      return [];
    } finally {
      await browser.close();
    }
  }

  async selectBestSources(query, searchResults, maxPages, signal) {
    const prompt = `Given this research query: "${query}"

Here are ${searchResults.length} potential sources:

${searchResults.map((r, i) => `${i+1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}`).join('\n\n')}

Select the ${Math.min(maxPages, searchResults.length)} MOST authoritative and relevant sources.
Consider: official documentation, established tech sites, GitHub, Stack Overflow, reputable blogs.
Avoid: spam, ads, irrelevant content.

Return ONLY a JSON array of URLs, nothing else. Example: ["url1", "url2", "url3"]`;

    const response = await this.queryLLM(prompt, signal);
    
    try {
      const urls = JSON.parse(response);
      return urls.filter(url => searchResults.some(r => r.url === url)).slice(0, maxPages);
    } catch {
      // Fallback: take top results if LLM fails
      console.error('   ⚠️ LLM selection failed, using top results');
      return searchResults.slice(0, maxPages).map(r => r.url);
    }
  }

  async scrapePages(urls, signal) {
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
    const results = [];
    
    try {
      // Scrape in batches of 3 to avoid overwhelming
      for (let i = 0; i < urls.length; i += 3) {
        const batch = urls.slice(i, i + 3);
        const promises = batch.map(url => this.scrapePage(browser, url, signal));
        const batchResults = await Promise.allSettled(promises);
        
        batchResults.forEach((result, idx) => {
          if (result.status === 'fulfilled' && result.value) {
            results.push(result.value);
          } else {
            console.error(`   ⚠️ Failed: ${batch[idx]}`);
          }
        });
      }
    } finally {
      await browser.close();
    }
    
    return results;
  }

  async scrapePage(browser, url, signal) {
    const page = await browser.newPage();
    
    try {
      await this.setupStealthMode(page);
      
      // Random delay before navigation (100-500ms)
      await this.randomDelay(100, 500);
      
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      
      // Simulate human-like scrolling
      await this.humanScroll(page);
      
      // Extract main content
      const content = await page.evaluate(() => {
        // Remove unwanted elements
        ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe'].forEach(tag => {
          document.querySelectorAll(tag).forEach(el => el.remove());
        });
        
        // Try to find main content
        const main = document.querySelector('main, article, .content, .post, #content');
        const text = main ? main.textContent : document.body.textContent;
        
        return text.replace(/\s+/g, ' ').trim().substring(0, 8000); // Limit to 8k chars
      });
      
      console.error(`   ✓ ${url.substring(0, 60)}...`);
      
      return { url, content };
    } catch (err) {
      return null;
    } finally {
      await page.close();
    }
  }

  async synthesizeContent(query, scrapedContent, signal) {
    const prompt = `Research query: "${query}"

I've gathered content from ${scrapedContent.length} sources. Analyze and synthesize this information.

${scrapedContent.map((s, i) => `\n--- SOURCE ${i+1}: ${s.url} ---\n${s.content}\n`).join('\n')}

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

  async queryLLM(prompt, signal, maxTokens = 1000) {
    const res = await fetch(this.llmEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.llmModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: maxTokens
      }),
      signal
    });

    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    
    const data = await res.json();
    if (!data?.choices?.[0]?.message?.content) {
      throw new Error('Invalid LLM response');
    }
    
    return data.choices[0].message.content;
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

    // Set realistic headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
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
