// Streaming Research Pipeline
// Scrapes and synthesizes concurrently - returns results as they're ready
// Allows 10+ pages without timeout issues

import { extractContent, validateContent } from '../scrapers/content-extractor.js';

/**
 * Stream scrape URLs with concurrent synthesis
 * As each page is scraped, it's added to the synthesis context
 * Returns partial results if timeout approaches
 */
export class StreamingResearchPipeline {
  constructor(options = {}) {
    this.scrapeTimeout = options.scrapeTimeout || 8000;
    this.maxConcurrent = options.maxConcurrent || 10;
    this.synthesisInterval = options.synthesisInterval || 3; // Synthesize every N pages
    this.maxTotalTime = options.maxTotalTime || 50000; // 50s max (leaves buffer for client timeout)
    
    this.results = [];
    this.startTime = null;
    this.synthesisCallbacks = [];
    this.isComplete = false;
  }

  /**
   * Scrape URLs with streaming results
   * Yields progress updates: { type: 'page' | 'synthesis', data: ... }
   */
  async *scrapeStreaming(urls, scrapeFn, signal) {
    this.startTime = Date.now();
    const remaining = [...urls];
    const inProgress = new Map(); // url -> promise
    
    // Start initial batch up to maxConcurrent
    while (inProgress.size < this.maxConcurrent && remaining.length > 0) {
      const url = remaining.shift();
      const promise = this._scrapeWithTimeout(url, scrapeFn, signal);
      inProgress.set(url, promise);
    }
    
    // Process as they complete, starting new ones immediately
    while (inProgress.size > 0) {
      // Check total time
      const elapsed = Date.now() - this.startTime;
      if (elapsed > this.maxTotalTime) {
        console.error(`[StreamingResearch] Approaching timeout (${elapsed}ms), stopping`);
        break;
      }
      
      // Wait for first to complete
      const [url, result] = await this._raceMap(inProgress);
      inProgress.delete(url);
      
      if (result && result.success) {
        this.results.push(result);
        yield { type: 'page', data: result, count: this.results.length };
        
        // Trigger synthesis every N pages
        if (this.results.length % this.synthesisInterval === 0) {
          const synthesis = await this._quickSynthesize(this.results);
          yield { type: 'synthesis', data: synthesis, partial: true };
        }
      }
      
      // Start next URL if available
      if (remaining.length > 0 && !signal?.aborted) {
        const nextUrl = remaining.shift();
        const promise = this._scrapeWithTimeout(nextUrl, scrapeFn, signal);
        inProgress.set(nextUrl, promise);
      }
    }
    
    // Cancel any remaining
    for (const [url, promise] of inProgress) {
      // Note: can't truly cancel promises, but they'll timeout naturally
    }
    
    this.isComplete = true;
    
    // Final synthesis with all results
    if (this.results.length > 0) {
      const finalSynthesis = await this._quickSynthesize(this.results);
      yield { type: 'synthesis', data: finalSynthesis, partial: false };
    }
  }

  /**
   * Scrape a single URL with timeout and retry
   */
  async _scrapeWithTimeout(url, scrapeFn, signal) {
    const start = Date.now();
    
    try {
      // Race between scrape and timeout
      const result = await Promise.race([
        scrapeFn(url, signal),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Scrape timeout')), this.scrapeTimeout)
        )
      ]);
      
      const elapsed = Date.now() - start;
      console.error(`[StreamingResearch] ${url.substring(0, 50)}... scraped in ${elapsed}ms`);
      return result;
      
    } catch (err) {
      console.error(`[StreamingResearch] ${url.substring(0, 50)}... failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Race a Map of promises, return [key, result] of first to settle
   */
  async _raceMap(map) {
    const entries = Array.from(map.entries());
    const promises = entries.map(([key, promise]) => 
      promise.then(result => [key, result])
    );
    return Promise.race(promises);
  }

  /**
   * Quick synthesis - summarize what we have so far
   * This is much faster than full synthesis since we don't wait for LLM
   */
  async _quickSynthesize(results) {
    // Build summary without LLM for speed
    const sources = results.map(r => ({
      url: r.url,
      title: r.title,
      excerpt: r.excerpt,
      size: r.content?.length || 0,
      strategy: r.strategy
    }));
    
    return {
      sourceCount: results.length,
      totalContentSize: results.reduce((sum, r) => sum + (r.content?.length || 0), 0),
      sources: sources,
      timestamp: Date.now()
    };
  }

  /**
   * Get current results (for external synthesis)
   */
  getResults() {
    return this.results;
  }

  /**
   * Check if we have enough content to synthesize
   */
  hasMinimumContent(minSources = 3, minTotalChars = 2000) {
    if (this.results.length < minSources) return false;
    const totalChars = this.results.reduce((sum, r) => sum + (r.content?.length || 0), 0);
    return totalChars >= minTotalChars;
  }
}

/**
 * Smart URL prioritization - which URLs to scrape first
 */
export function prioritizeUrls(urls, query) {
  const queryLower = query.toLowerCase();
  const scored = urls.map(url => {
    let score = 0;
    const urlLower = url.toLowerCase();
    
    // High priority: Official docs
    if (urlLower.includes('docs.') || 
        urlLower.includes('/documentation') ||
        urlLower.includes('/api/') ||
        urlLower.includes('reference')) {
      score += 100;
    }
    
    // High priority: Technical forums
    if (urlLower.includes('stackoverflow.com/questions')) score += 90;
    if (urlLower.includes('github.com') && urlLower.includes('/issues/')) score += 85;
    if (urlLower.includes('github.com') && urlLower.includes('/discussions/')) score += 80;
    
    // Medium priority: Technical blogs
    if (urlLower.includes('dev.to')) score += 50;
    if (urlLower.includes('medium.com')) score += 40;
    if (urlLower.includes('github.blog')) score += 70;
    
    // Wikipedia for general knowledge
    if (urlLower.includes('wikipedia.org')) score += 45;
    
    // Deprioritize: Homepages, app stores
    if ((urlLower.match(/\//g) || []).length <= 3) score -= 30; // Short URL = likely homepage
    if (urlLower.includes('apps.apple.com')) score -= 100;
    if (urlLower.includes('play.google.com')) score -= 100;
    
    // Boost if query terms in URL
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3);
    for (const word of queryWords) {
      if (urlLower.includes(word)) score += 20;
    }
    
    return { url, score };
  });
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  return scored.map(s => s.url);
}

/**
 * Early termination check - do we have enough quality content?
 */
export function shouldTerminateEarly(results, options = {}) {
  const { 
    minSources = 3, 
    minTotalChars = 3000,
    minHighQualitySources = 2 
  } = options;
  
  if (results.length < minSources) return false;
  
  const totalChars = results.reduce((sum, r) => sum + (r.content?.length || 0), 0);
  if (totalChars < minTotalChars) return false;
  
  // Count high-quality sources (extracted with good strategy, decent length)
  const highQuality = results.filter(r => 
    r.content?.length > 500 && 
    ['readability', 'semantic'].includes(r.strategy)
  ).length;
  
  if (highQuality >= minHighQualitySources) {
    console.error(`[StreamingResearch] Early termination: ${results.length} sources, ${totalChars} chars, ${highQuality} high-quality`);
    return true;
  }
  
  return false;
}
