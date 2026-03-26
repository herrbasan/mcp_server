/**
 * Codebase Indexing Service
 * 
 * Fast semantic code search using nDB vector database.
 * 
 * Architecture:
 * - nDB: Vector storage and similarity search
 * - SQLite: Metadata (mtimes, hashes, file info)
 * - Tree-sitter: Code structure extraction
 * - ripgrep: Live exact text search
 */

import { Database } from './nVDB/napi/index.js';
import { SimpleMetadataStore } from './simple-metadata.js';
import { Indexer } from './indexer.js';
import { SearchRouter } from './search-router.js';
import { GrepSearcher } from './grep.js';
import { CodebaseMaintenance } from './maintenance.js';
import { analyzeProject, isAnalysisStale, getPrioritizedFiles } from './project-analyzer.js';
import path from 'path';
import fs from 'fs/promises';

const DEFAULT_CONFIG = {
  dataDir: 'data/codebases',
  embeddingDimension: 768,
  // embeddingModel is read from environment or config - no hardcoded default
  // This ensures it matches the router's configured embedding provider
  maxFileSize: 1024 * 1024, // 1MB
  ignorePatterns: [
    // Build artifacts
    '**/node_modules/**',
    '**/.git/**',
    '**/.svn/**',
    '**/.hg/**',
    '**/.vscode/**',
    '**/.idea/**',
    '**/.vs/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/out/**',
    '**/target/**',
    '**/bin/**',
    '**/obj/**',
    '**/Debug/**',
    '**/Release/**',
    // Python
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '*.pyc',
    '*.pyo',
    '**/*.egg-info/**',
    // Coverage/Temp
    '**/coverage/**',
    '**/.nyc_output/**',
    '**/.coverage/**',
    '**/htmlcov/**',
    '**/.tmp/**',
    '**/tmp/**',
    '**/temp/**',
    '*.tmp',
    // Logs & locks
    '*.log',
    '*.lock',
    'package-lock.json',
    'yarn.lock',
    'Cargo.lock',
    'composer.lock',
    'Pipfile.lock',
    'poetry.lock',
    // Generated files
    '*.map',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.d.ts',
    '*.generated.*',
    // Binary media (explicitly excluded)
    '*.png',
    '*.jpg',
    '*.jpeg',
    '*.gif',
    '*.bmp',
    '*.ico',
    '*.webp',
    '*.svg',  // SVG can be text but usually assets, skip by default
    '*.mp3',
    '*.mp4',
    '*.avi',
    '*.mov',
    '*.wmv',
    '*.wav',
    '*.ogg',
    '*.webm',
    '*.pdf',
    '*.doc',
    '*.docx',
    '*.xls',
    '*.xlsx',
    '*.ppt',
    '*.pptx',
    '*.zip',
    '*.tar',
    '*.gz',
    '*.rar',
    '*.7z',
    '*.exe',
    '*.dll',
    '*.so',
    '*.dylib',
    '*.bin',
    '*.dat',
    '*.db',
    '*.sqlite',
    '*.sqlite3',
    // Misc
    '.DS_Store',
    'Thumbs.db',
    '*.bak',
    '*.swp',
    '*.swo',
    '*~'
  ]
};

export class CodebaseIndexingService {
  constructor(config = {}, llmRouter) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.router = llmRouter;
    this.indexes = new Map(); // name -> { db, collection, metadata }
    this.indexer = new Indexer(this.config, llmRouter);
    this.searchRouter = new SearchRouter();
    this.grepSearcher = new GrepSearcher();
    this.progressCallback = null;
    
    // Initialize maintenance module
    this.maintenance = new CodebaseMaintenance(this, config.maintenance);
    
    // Store spaces configuration for path resolution
    this.spaces = config.spaces || {};
    
    // Preload all codebases into memory for fast global search
    this.preloaded = false;
  }
  
  /**
   * Preload all codebases into memory (nDB is in-memory, this loads from disk once)
   */
  async preloadAll() {
    if (this.preloaded) return;
    
    const start = Date.now();
    const all = await this.listCodebases();
    console.log(`[CodebaseIndexing] Preloading ${all.length} codebases into memory...`);
    
    // Load in batches to avoid overwhelming the system
    const batchSize = 20;
    for (let i = 0; i < all.length; i += batchSize) {
      const batch = all.slice(i, i + batchSize);
      await Promise.all(batch.map(cb => 
        this._getCodebase(cb.name).catch(() => null)
      ));
    }
    
    this.preloaded = true;
    console.log(`[CodebaseIndexing] Preloaded ${all.length} codebases in ${Date.now() - start}ms`);
  }
  
  /**
   * Resolve a project path using spaces configuration
   * 
   * Supports:
   * - Absolute path: "D:\\Projects\\MyApp" or "\\\server\\share\\project"
   * - Space + project: { space: "COOLKID-Work", project: "MyApp" }
   *   -> Resolves to first accessible path from space config
   */
  async resolveSourcePath(args) {
    // If absolute source path provided, use it directly
    if (args.source) {
      return args.source;
    }
    
    // Otherwise resolve from space + project
    if (!args.space) {
      throw new Error('Either "source" (absolute path) or "space" (space name) is required');
    }
    
    const spaceConfig = this.spaces[args.space];
    if (!spaceConfig) {
      throw new Error(`Unknown space: "${args.space}". Available: ${Object.keys(this.spaces).join(', ')}`);
    }
    
    // spaceConfig is an array of paths: [UNC, local]
    // Try each path and use the first one that exists
    const projectName = args.project || args.name;
    
    for (const basePath of spaceConfig) {
      const fullPath = path.join(basePath, projectName);
      
      try {
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) {
          return fullPath;
        }
      } catch {
        // Path doesn't exist or isn't accessible, try next
        continue;
      }
    }
    
    throw new Error(
      `Could not find project "${projectName}" in space "${args.space}". ` +
      `Tried: ${spaceConfig.map(p => path.join(p, projectName)).join(', ')}`
    );
  }
  
  /**
   * Start automatic maintenance cycle
   */
  startMaintenance() {
    this.maintenance.start();
  }
  
  /**
   * Stop automatic maintenance cycle
   */
  stopMaintenance() {
    this.maintenance.stop();
  }
  
  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  /**
   * List available spaces from configuration
   */
  async listSpaces() {
    return Object.entries(this.spaces).map(([name, paths]) => ({
      name,
      paths,
      description: `Project root: ${paths[0]}`
    }));
  }

  /**
   * Validate embedding dimension matches router
   */
  async validateDimension() {
    const routerDim = await this.router.getEmbeddingDimension?.() || this.config.embeddingDimension;
    if (routerDim !== this.config.embeddingDimension) {
      throw new Error(
        `Embedding dimension mismatch: config=${this.config.embeddingDimension}, router=${routerDim}`
      );
    }
  }

  /**
   * Get storage path for a codebase
   */
  _getCodebasePath(name) {
    return path.join(this.config.dataDir, name);
  }

  /**
   * List all indexed codebases
   */
  async listCodebases() {
    try {
      const entries = await fs.readdir(this.config.dataDir, { withFileTypes: true });
      const codebases = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const metadata = await this._loadCodebaseMetadata(entry.name);
          const analysis = metadata?.llmAnalysis;
          
          codebases.push({
            name: entry.name,
            source: metadata?.source || null,
            files: metadata?.fileCount || 0,
            lastIndexed: metadata?.lastIndexed || null,
            status: metadata?.status || 'unknown',
            description: analysis?.description || null,
            hasAnalysis: !!analysis,
            analysisStale: analysis ? await isAnalysisStale(analysis, metadata.source) : null
          });
        }
      }

      return codebases;
    } catch (err) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Load metadata for a codebase
   */
  async _loadCodebaseMetadata(name) {
    try {
      const metadataPath = path.join(this._getCodebasePath(name), 'metadata.json');
      const data = await fs.readFile(metadataPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Save metadata for a codebase
   */
  async _saveCodebaseMetadata(name, metadata) {
    const codebasePath = this._getCodebasePath(name);
    await fs.mkdir(codebasePath, { recursive: true });
    
    const metadataPath = path.join(codebasePath, 'metadata.json');
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Index a new codebase
   * @param {Object} options
   * @param {string} options.name - Codebase name (e.g., "SoundApp")
   * @param {string} [options.source] - Absolute path to source directory (optional if space provided)
   * @param {string} [options.space] - Space name (e.g., "COOLKID-Work") - resolves project path
   * @param {string} [options.project] - Project folder within space (defaults to name)
   * @param {boolean} [options.analyze] - Run LLM analysis after indexing (default: false)
   * @param {Function} onProgress - Progress callback
   */
  async indexCodebase(args, onProgress) {
    const { name, analyze = false } = args;
    if (!name) {
      throw new Error('name is required');
    }
    
    // Resolve source path from args
    const source = await this.resolveSourcePath(args);

    // Validate source exists
    const stats = await fs.stat(source).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(`Source directory does not exist: ${source}`);
    }

    const codebasePath = this._getCodebasePath(name);
    
    // Check if already exists
    try {
      await fs.access(codebasePath);
      throw new Error(`Codebase '${name}' already exists. Use refreshCodebase() to update.`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    // Create directories
    await fs.mkdir(codebasePath, { recursive: true });

    // Initialize nDB
    const db = new Database(path.join(codebasePath, 'nvdb'));
    const collection = db.createCollection('files', this.config.embeddingDimension, {
      durability: 'buffered'
    });

    // Initialize SQLite metadata
    const metadata = new SimpleMetadataStore(codebasePath);
    await metadata.init();

    // Save source path and config
    await this._saveCodebaseMetadata(name, {
      name,
      source,
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      status: 'indexing',
      embeddingModel: this.config.embeddingModel,
      embeddingDimension: this.config.embeddingDimension
    });

    // Run initial indexing
    const result = await this._runIndexing(name, source, collection, metadata, false, onProgress);

    // Update metadata - use metadata.fileCount for actual total (not just newly indexed)
    await this._saveCodebaseMetadata(name, {
      name,
      source,
      createdAt: new Date().toISOString(),
      lastIndexed: new Date().toISOString(),
      status: result.errors > 0 ? 'partial' : 'current',
      fileCount: metadata.fileCount,
      embeddingModel: this.config.embeddingModel,
      embeddingDimension: this.config.embeddingDimension
    });

    // Store in memory
    this.indexes.set(name, { db, collection, metadata, source });

    // Optional: Run LLM analysis after indexing
    let analysisResult = null;
    if (analyze && result.indexed > 0) {
      try {
        onProgress?.({ phase: 'analyzing', message: 'Running LLM project analysis...' });
        analysisResult = await this.analyzeCodebase({ name }, onProgress);
      } catch (err) {
        console.warn(`[indexCodebase] Analysis failed: ${err.message}`);
        analysisResult = { error: err.message };
      }
    }

    return {
      name,
      source,
      indexed: result.indexed,
      errors: result.errors,
      duration: result.duration,
      rate: result.rate,
      errorsDetail: result.errorsDetail,
      analysis: analysisResult ? {
        completed: !!analysisResult.analyzed,
        description: analysisResult.description,
        duration: analysisResult.duration,
        error: analysisResult.error
      } : null
    };
  }

  /**
   * Refresh (incrementally update) a codebase
   * @param {Object} options
   * @param {string} options.name - Codebase name
   * @param {boolean} [options.analyze] - Re-run LLM analysis if stale (default: false)
   */
  async refreshCodebase({ name, analyze = false }, onProgress) {
    const codebase = await this._getCodebase(name);
    const metadataRecord = await this._loadCodebaseMetadata(name);
    
    await this._saveCodebaseMetadata(name, {
      ...metadataRecord,
      status: 'refreshing'
    });

    const result = await this._runIndexing(
      name,
      codebase.source,
      codebase.collection,
      codebase.metadata,
      true, // incremental
      onProgress
    );

    await this._saveCodebaseMetadata(name, {
      ...metadataRecord,
      lastIndexed: new Date().toISOString(),
      status: result.errors > 0 ? 'partial' : 'current',
      fileCount: codebase.metadata.fileCount
    });

    // Optional: Re-run analysis if requested and analysis exists and is stale
    let analysisResult = null;
    if (analyze && metadataRecord?.llmAnalysis) {
      const isStale = await isAnalysisStale(metadataRecord.llmAnalysis, codebase.source);
      if (isStale || result.indexed > 0) {
        try {
          onProgress?.({ phase: 'analyzing', message: 'Re-running LLM project analysis...' });
          analysisResult = await this.analyzeCodebase({ name }, onProgress);
        } catch (err) {
          console.warn(`[refreshCodebase] Analysis failed: ${err.message}`);
          analysisResult = { error: err.message };
        }
      }
    }

    return {
      ...result,
      analysis: analysisResult ? {
        completed: !!analysisResult.analyzed,
        description: analysisResult.description,
        duration: analysisResult.duration,
        error: analysisResult.error
      } : null
    };
  }

  /**
   * Remove a codebase and all its data
   */
  async removeCodebase({ name }) {
    const codebasePath = this._getCodebasePath(name);
    
    // Close if open
    if (this.indexes.has(name)) {
      const { metadata } = this.indexes.get(name);
      // Close SQLite connection
      metadata.close();
      this.indexes.delete(name);
    }

    // Delete directory
    await fs.rm(codebasePath, { recursive: true, force: true });

    return { name, removed: true };
  }

  /**
   * Find codebases matching a partial name (case-insensitive substring match)
   */
  async _findCodebasesByPartialName(partialName) {
    const all = await this.listCodebases();
    const lower = partialName.toLowerCase();
    return all.filter(cb => cb.name.toLowerCase().includes(lower));
  }

  /**
   * Resolve a codebase name - exact match or partial match (returns first/best match)
   */
  async _resolveCodebaseName(name) {
    // Try exact match first
    const exact = await this._loadCodebaseMetadata(name);
    if (exact) return name;

    // Try partial match
    const matches = await this._findCodebasesByPartialName(name);
    if (matches.length >= 1) {
      // Return first match instead of erroring on multiple
      return matches[0].name;
    }
    
    throw new Error(`Codebase '${name}' not found`);
  }

  /**
   * Get or load a codebase
   */
  async _getCodebase(name) {
    // Resolve name (supports partial matching)
    const resolvedName = await this._resolveCodebaseName(name);
    
    // Return cached if available
    if (this.indexes.has(resolvedName)) {
      return this.indexes.get(resolvedName);
    }

    // Load from disk
    const metadata = await this._loadCodebaseMetadata(resolvedName);
    if (!metadata) {
      throw new Error(`Codebase '${resolvedName}' not found`);
    }

    const codebasePath = this._getCodebasePath(resolvedName);
    const db = new Database(path.join(codebasePath, 'nvdb'));
    const collection = db.getCollection('files');
    const metaStore = new SimpleMetadataStore(codebasePath);
    await metaStore.init();

    const codebase = {
      db,
      collection,
      metadata: metaStore,
      source: metadata.source
    };

    this.indexes.set(resolvedName, codebase);
    return codebase;
  }

  /**
   * Run the indexing process
   */
  async _runIndexing(name, source, collection, metadata, incremental = false, onProgress) {
    const result = await this.indexer.indexDirectory({
      source,
      collection,
      metadata,
      incremental,
      onProgress: (progress) => {
        console.log(`[${name}] ${progress.message}`);
        onProgress?.(progress);
      }
    });

    // Flush to disk
    collection.flush();

    return result;
  }

  /**
   * Search by keyword (path + content)
   */
  async searchKeyword({ codebase, query, limit = 20, searchContent = true }) {
    const { metadata } = await this._getCodebase(codebase);
    
    const results = await metadata.searchKeyword(query, limit, searchContent);
    
    return {
      results: results.map(r => ({
        file: `${codebase}:${r.path}`,
        path: r.path,
        rank: r.rank,
        contentMatches: r.contentMatches || null
      })),
      count: results.length
    };
  }

  /**
   * Live grep search
   */
  async grepCodebase({ 
    codebase, 
    pattern, 
    regex = true, 
    limit = 50, 
    maxMatchesPerFile = 5,
    caseSensitive = false,
    pathPattern = null,
    noCache = false
  }) {
    const { source } = await this._getCodebase(codebase);
    
    const results = await this.grepSearcher.grep(source, pattern, { 
      regex, 
      limit, 
      maxMatchesPerFile,
      caseSensitive,
      pathPattern,
      noCache
    });
    
    return {
      results: results.map(r => ({
        file: `${codebase}:${r.path}`,
        ...r
      })),
      count: results.length
    };
  }

  /**
   * Hybrid search - combines semantic + keyword + optional grep
   */
  async search({ codebase, query, strategy = 'hybrid', limit = 10, filter }) {
    const { collection, metadata, source } = await this._getCodebase(codebase);
    
    // Gather results based on strategy
    const semanticResults = [];
    const keywordResults = [];
    let grepResults = [];
    
    // Always do semantic for 'hybrid' and 'semantic' strategies
    if (strategy === 'hybrid' || strategy === 'semantic') {
      const queryEmbedding = await this.router.embedText(query);
      const rawResults = collection.search({
        vector: queryEmbedding,
        top_k: limit * 3,
        approximate: true,
        ef: 64
      });
      
      for (const match of rawResults) {
        const fileInfo = await metadata.getFile(match.id);
        if (fileInfo) {
          semanticResults.push({
            path: match.id,
            score: match.score,
            language: fileInfo.language,
            functions: fileInfo.functions || [],
            classes: fileInfo.classes || []
          });
        }
      }
    }
    
    // Keyword search for 'hybrid' and 'keyword' strategies
    if (strategy === 'hybrid' || strategy === 'keyword') {
      const rawKeyword = await metadata.searchKeyword(query, limit * 2);
      keywordResults.push(...rawKeyword.map(r => ({ path: r.path, rank: r.rank })));
    }
    
    // Grep for exact matches (only for short queries)
    if (strategy === 'hybrid' && query.length < 50 && !query.includes(' ')) {
      try {
        grepResults = await this.grepSearcher.grep(source, query, { regex: false, limit: 20 });
      } catch {
        // Grep optional - ignore errors
      }
    }
    
    // Combine results
    let combined;
    if (strategy === 'hybrid') {
      combined = this.searchRouter.combineResults(semanticResults, keywordResults);
    } else if (strategy === 'semantic') {
      combined = semanticResults;
    } else if (strategy === 'keyword') {
      combined = keywordResults.map(r => ({ 
        path: r.path, 
        score: 1 / (1 + Math.abs(r.rank))  // Convert rank to score
      }));
    }
    
    // Apply filters
    if (filter?.language) {
      combined = combined.filter(r => r.language === filter.language || !r.language);
    }
    
    // Limit results
    combined = combined.slice(0, limit);
    
    // Enrich with full file info
    const enriched = [];
    for (const item of combined) {
      const fileInfo = await metadata.getFile(item.path);
      if (fileInfo) {
        enriched.push({
          file: `${codebase}:${item.path}`,
          path: item.path,
          score: item.score,
          semanticScore: item.semanticScore,
          keywordScore: item.keywordScore,
          language: fileInfo.language,
          functions: fileInfo.functions || [],
          classes: fileInfo.classes || []
        });
      }
    }
    
    return {
      results: enriched,
      count: enriched.length,
      strategy
    };
  }

  /**
   * Search for semantically similar code
   */
  async searchSemantic({ codebase, query, limit = 10, filter }) {
    const { collection, metadata } = await this._getCodebase(codebase);

    // Generate query embedding
    const queryEmbedding = await this.router.embedText(query);

    // Search nDB
    const results = collection.search({
      vector: queryEmbedding,
      top_k: limit * 2, // Fetch extra for post-filtering
      approximate: true,
      ef: 64
    });

    // Apply post-filtering and enrich results
    const enriched = [];
    for (const match of results) {
      if (enriched.length >= limit) break;

      const fileInfo = await metadata.getFile(match.id);
      if (!fileInfo) continue;

      // Apply filters
      if (filter?.language && fileInfo.language !== filter.language) continue;

      enriched.push({
        file: `${codebase}:${match.id}`,
        score: match.score,
        path: match.id,
        language: fileInfo.language,
        functions: fileInfo.functions || [],
        classes: fileInfo.classes || []
      });
    }

    return { results: enriched, count: enriched.length };
  }

  /**
   * Search across ALL codebases - optimized with parallel processing
   */
  async searchAll({ query, strategy = 'hybrid', limit = 10, filter, perCodebaseLimit = 5, concurrency = 10 }) {
    const startTime = Date.now();
    const allCodebases = await this.listCodebases();
    
    // Filter out empty codebases (0 files) - these can't have results
    const validCodebases = allCodebases.filter(cb => cb.files > 0);
    
    const allResults = [];
    const errors = [];
    let resultsFound = 0;
    
    // Helper to search a single codebase
    const searchOne = async (cb) => {
      // Early termination check
      if (resultsFound >= limit) return null;
      
      try {
        const searchLimit = Math.min(perCodebaseLimit, limit);
        let results;
        
        if (strategy === 'grep') {
          results = await this.grepCodebase({ 
            codebase: cb.name, 
            pattern: query, 
            regex: true, 
            limit: searchLimit 
          });
        } else if (strategy === 'keyword') {
          results = await this.searchKeyword({ 
            codebase: cb.name, 
            query, 
            limit: searchLimit 
          });
        } else if (strategy === 'semantic') {
          results = await this.searchSemantic({ 
            codebase: cb.name, 
            query, 
            limit: searchLimit,
            filter 
          });
        } else {
          // hybrid
          results = await this.search({ 
            codebase: cb.name, 
            query, 
            strategy: 'hybrid', 
            limit: searchLimit,
            filter 
          });
        }
        
        if (results.results && results.results.length > 0) {
          resultsFound += results.results.length;
          return {
            codebase: cb.name,
            count: results.count,
            results: results.results.map(r => ({ ...r, codebase: cb.name }))
          };
        }
      } catch (err) {
        errors.push({ codebase: cb.name, error: err.message });
      }
      return null;
    };
    
    // Process in batches for concurrency control
    for (let i = 0; i < validCodebases.length; i += concurrency) {
      // Early termination if we have enough results
      if (resultsFound >= limit) break;
      
      const batch = validCodebases.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(searchOne));
      
      for (const result of batchResults) {
        if (result) allResults.push(result);
      }
    }
    
    // Flatten and sort by score (for semantic/hybrid) or keep grouped
    const flattened = [];
    for (const cbResult of allResults) {
      flattened.push(...cbResult.results);
    }
    
    // Sort by score (descending) if available
    if (strategy !== 'grep' && strategy !== 'keyword') {
      flattened.sort((a, b) => (b.score || 0) - (a.score || 0));
    }
    
    // Apply global limit
    const limited = flattened.slice(0, limit);
    
    const duration = Date.now() - startTime;
    
    return {
      results: limited,
      totalCount: flattened.length,
      codebasesSearched: validCodebases.length,
      codebasesWithResults: allResults.length,
      strategy,
      durationMs: duration,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Analyze search results using local LLM to reduce token cost for calling LLM.
   * Returns structured summary with key findings, relevant files, and implementation patterns.
   */
  async analyzeSearchResults(searchResults, query, searchType = 'search') {
    if (!this.router) {
      throw new Error('LLM router not available for analysis');
    }

    const results = searchResults.results || [];
    if (results.length === 0) {
      return { 
        summary: 'No results found.', 
        keyFindings: [], 
        relevantFiles: [], 
        implementationPatterns: [],
        raw: 'No results to analyze.'
      };
    }

    // Build context from search results
    const context = results.map((r, i) => {
      const parts = [
        `Result ${i + 1}: ${r.file || r.path || 'unknown'}`,
        r.score ? `Score: ${r.score.toFixed(3)}` : null,
        r.language ? `Language: ${r.language}` : null,
        r.functions?.length ? `Functions: ${r.functions.join(', ')}` : null,
        r.classes?.length ? `Classes: ${r.classes.join(', ')}` : null,
        r.line ? `Line ${r.line}: ${r.content || ''}` : null
      ].filter(Boolean);
      return parts.join('\n');
    }).join('\n\n---\n\n');

    const analysisPrompt = `You are analyzing code search results to extract key information. Be concise and structured.

Search Query: "${query}"
Search Type: ${searchType}
Number of Results: ${results.length}

Search Results:
${context}

Provide a structured analysis in this exact format:

SUMMARY: (2-3 sentences describing what was found and how it relates to the query)

KEY_FINDINGS:
- (bullet point 1: specific implementation detail or pattern found)
- (bullet point 2: another key finding)
- (add more as relevant, max 5)

RELEVANT_FILES:
1. (filepath) - (why it's relevant in 5-8 words)
2. (add more as relevant, max 5)

IMPLEMENTATION_PATTERNS:
- (pattern name): (brief description of how it's implemented)
- (add more as found, max 3)`;

    const analysis = await this.router.predict({
      prompt: analysisPrompt,
      temperature: 0.3,
      taskType: 'analysis'
    });

    // Parse the analysis into structured format
    const lines = analysis.trim().split('\n');
    const parsed = {
      summary: '',
      keyFindings: [],
      relevantFiles: [],
      implementationPatterns: [],
      raw: analysis.trim()
    };

    let section = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('SUMMARY:')) {
        section = 'summary';
        parsed.summary = trimmed.slice(8).trim();
      } else if (trimmed.startsWith('KEY_FINDINGS:')) {
        section = 'findings';
      } else if (trimmed.startsWith('RELEVANT_FILES:')) {
        section = 'files';
      } else if (trimmed.startsWith('IMPLEMENTATION_PATTERNS:')) {
        section = 'patterns';
      } else if (trimmed.startsWith('- ') && section === 'findings') {
        parsed.keyFindings.push(trimmed.slice(2));
      } else if (/^\d+\./.test(trimmed) && section === 'files') {
        parsed.relevantFiles.push(trimmed.replace(/^\d+\.\s*/, ''));
      } else if (trimmed.startsWith('- ') && section === 'patterns') {
        parsed.implementationPatterns.push(trimmed.slice(2));
      } else if (section === 'summary' && !trimmed.startsWith('KEY_FINDINGS:')) {
        parsed.summary += ' ' + trimmed;
      }
    }

    parsed.summary = parsed.summary.trim();
    return parsed;
  }

  /**
   * Get file tree for a codebase
   */
  async getFileTree({ codebase, path: subpath = '' }) {
    const { metadata } = await this._getCodebase(codebase);
    return metadata.getFileTree(subpath);
  }

  /**
   * Get file info (functions, classes, etc.)
   */
  async getFileInfo({ codebase, path: filePath }) {
    const { collection, metadata } = await this._getCodebase(codebase);
    const info = await metadata.getFile(filePath);
    
    if (!info) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Get symbols from nDB payload
    let symbols = { functions: [], classes: [], imports: [] };
    try {
      // nDB stores payload as JSON string - retrieve it via collection.get
      const doc = collection.get(filePath);
      if (doc && doc.payload) {
        const payload = JSON.parse(doc.payload);
        symbols.functions = payload.functions || [];
        symbols.classes = payload.classes || [];
        symbols.imports = payload.imports || [];
      }
    } catch {
      // If get() fails or payload is missing, return empty symbols
    }

    return {
      file: `${codebase}:${filePath}`,
      ...info,
      functions: symbols.functions,
      classes: symbols.classes,
      imports: symbols.imports
    };
  }

  /**
   * Get file content with staleness check
   */
  async getFile({ codebase, path: filePath }) {
    const { source, metadata } = await this._getCodebase(codebase);
    const info = await metadata.getFile(filePath);

    if (!info) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read current file
    const fullPath = path.join(source, filePath);
    const content = await fs.readFile(fullPath, 'utf-8').catch(() => null);

    if (content === null) {
      throw new Error(`File not readable: ${filePath}`);
    }

    // Check staleness
    const stats = await fs.stat(fullPath);
    const stale = stats.mtimeMs > info.mtime;

    return {
      content,
      stale,
      lastIndexed: info.lastIndexed
    };
  }

  // ========== Maintenance Operations ==========

  /**
   * Check staleness status of a codebase
   */
  async checkCodebaseStatus({ codebase }) {
    return this.maintenance.getStalenessReport(codebase);
  }

  /**
   * Check if a specific file is stale
   */
  async checkFileStale({ codebase, path: filePath }) {
    return this.maintenance.isFileStale(codebase, filePath);
  }

  /**
   * Manually run maintenance cycle
   */
  async runMaintenance({ codebase } = {}) {
    if (codebase) {
      // Refresh specific codebase
      const result = await this.maintenance.checkAndRefresh(codebase);
      return { codebase, ...result };
    } else {
      // Run full maintenance cycle
      await this.maintenance.runMaintenance();
      return { 
        message: 'Maintenance cycle complete',
        stats: this.maintenance.getStats()
      };
    }
  }

  /**
   * Get maintenance statistics
   */
  async getMaintenanceStats() {
    return this.maintenance.getStats();
  }

  // ========== LLM Project Analysis ==========

  /**
   * Analyze a codebase using LLM to generate description and identify key files
   */
  async analyzeCodebase({ name }, onProgress) {
    const codebase = await this._getCodebase(name);
    const metadataRecord = await this._loadCodebaseMetadata(name);
    
    if (!metadataRecord) {
      throw new Error(`Codebase '${name}' not found`);
    }

    onProgress?.({ phase: 'analyzing', message: 'Starting LLM analysis...' });

    const analysis = await analyzeProject(
      this.router,
      codebase.metadata,
      codebase.source,
      onProgress
    );

    // Save analysis to metadata
    await this._saveCodebaseMetadata(name, {
      ...metadataRecord,
      llmAnalysis: analysis
    });

    return {
      name,
      analyzed: true,
      description: analysis.description,
      duration: analysis.duration,
      filesAnalyzed: analysis.filesAnalyzed
    };
  }

  /**
   * Get codebase description with staleness check
   */
  async getCodebaseDescription({ name }) {
    const metadata = await this._loadCodebaseMetadata(name);
    
    if (!metadata) {
      throw new Error(`Codebase '${name}' not found`);
    }

    const analysis = metadata.llmAnalysis;
    
    if (!analysis) {
      return {
        name,
        hasAnalysis: false,
        message: 'No LLM analysis available. Run analyze_codebase first.'
      };
    }

    // Check staleness
    const stale = await isAnalysisStale(analysis, metadata.source);

    return {
      name,
      hasAnalysis: true,
      stale,
      description: analysis.description,
      purpose: analysis.purpose,
      insights: analysis.insights,
      keyFiles: analysis.keyFiles,
      entryPoints: analysis.entryPoints,
      analyzedAt: analysis.analyzedAt,
      model: analysis.model,
      duration: analysis.duration
    };
  }

  /**
   * Get prioritized file list for search
   */
  async getPrioritizedFiles({ name }) {
    const codebase = await this._getCodebase(name);
    const metadata = await this._loadCodebaseMetadata(name);
    
    const allFiles = (await codebase.metadata.getAllFiles()).map(f => f.path);
    const prioritized = getPrioritizedFiles(metadata?.llmAnalysis, allFiles);
    
    return {
      name,
      prioritized,
      totalFiles: allFiles.length
    };
  }

  // ========== MCP Tool Integration ==========

  getTools() {
    return [
      {
        name: 'list_codebases',
        description: 'List all indexed codebases with status and file counts',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'list_spaces',
        description: 'List available spaces (configured project roots) for indexing codebases. Use this to find space names before calling index_codebase.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'index_codebase',
        description: 'Index a new codebase for semantic search. Provide either "source" (absolute path) OR "space" (configured space name).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Codebase name (e.g., "SoundApp")' },
            source: { type: 'string', description: 'Absolute path to source directory (alternative to space)' },
            space: { type: 'string', description: 'Space name from config (e.g., "COOLKID-Work") - resolves project path automatically' },
            project: { type: 'string', description: 'Project folder name within space (defaults to codebase name if not specified)' },
            analyze: { type: 'boolean', description: 'Run LLM analysis after indexing to generate project description (default: false)', default: false }
          },
          required: ['name']
        }
      },
      {
        name: 'search_codebase',
        description: 'Primary search tool for single codebase. RECOMMENDED over grep_codebase for most searches. Combines semantic (meaning) + keyword (exact) matching. Use strategy:keyword for fast name lookups, strategy:semantic for concept queries. Use analyze:true to get AI-summarized results (saves 50-90% tokens). Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            query: { type: 'string', description: 'Search query (natural language or keywords)' },
            strategy: { type: 'string', enum: ['hybrid', 'semantic', 'keyword'], default: 'hybrid', description: 'hybrid=best overall, keyword=fast exact match, semantic=conceptual similarity' },
            limit: { type: 'number', default: 10 },
            filter: { 
              type: 'object',
              properties: { language: { type: 'string' } }
            },
            analyze: { type: 'boolean', default: false, description: 'Use local LLM to analyze results and return structured summary with keyFindings, relevantFiles, implementationPatterns. Saves 50-90% tokens vs raw results. Recommended for exploration.' },
            includeRaw: { type: 'boolean', default: false, description: 'Include raw search results in addition to analysis. Use when you want both the AI summary AND original snippets for drilling down.' }
          },
          required: ['codebase', 'query']
        }
      },
      {
        name: 'search_semantic',
        description: 'Semantic (AI embedding) search - finds conceptually similar code. Best for: "how is X implemented?", "find code that does Y", pattern discovery. Slower than keyword but understands meaning, not just text. Use analyze:true for structured summary. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            query: { type: 'string', description: 'Natural language query describing what you are looking for' },
            limit: { type: 'number', default: 10 },
            filter: { 
              type: 'object',
              properties: { language: { type: 'string' } }
            },
            analyze: { type: 'boolean', default: false, description: 'Use local LLM to analyze results and return structured summary with keyFindings, relevantFiles, implementationPatterns. Saves 50-90% tokens vs raw results. Recommended for exploration.' },
            includeRaw: { type: 'boolean', default: false, description: 'Include raw search results in addition to analysis. Use when you want both the AI summary AND original snippets for drilling down.' }
          },
          required: ['codebase', 'query']
        }
      },
      {
        name: 'search_keyword',
        description: 'FAST indexed keyword search. Best for: exact function names, class names, variable names, imports. Searches file paths AND content. Much faster than grep_codebase (<100ms vs 1-3s). Use this INSTEAD of grep_codebase when searching for specific identifiers. Use analyze:true for AI summary. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            query: { type: 'string', description: 'Keywords to search (function names, class names, etc.)' },
            limit: { type: 'number', default: 20 },
            searchContent: { type: 'boolean', default: true, description: 'Search file content (not just paths). Slightly slower but more thorough.' },
            analyze: { type: 'boolean', default: false, description: 'Use local LLM to analyze results and return structured summary (reduces token cost for calling LLM)' },
            includeRaw: { type: 'boolean', default: false, description: 'Include raw search results in addition to analysis (increases token usage)' }
          },
          required: ['codebase', 'query']
        }
      },
      {
        name: 'grep_codebase',
        description: 'Live regex search using ripgrep. ALWAYS CURRENT (searches filesystem directly). Use ONLY when: (1) You need regex patterns like "function.*predict\\(", (2) You need exact line numbers for editing, (3) You suspect index is stale. OTHERWISE prefer search_keyword (faster for names) or search_semantic (for concepts). Slower than indexed search (1-3s vs <200ms). Use analyze:true to get structured analysis. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            pattern: { type: 'string', description: 'Search pattern (regex or literal string)' },
            regex: { type: 'boolean', default: true, description: 'Use regex pattern matching. Set to false for literal string search (faster)' },
            limit: { type: 'number', default: 50, description: 'Max total results to return' },
            maxMatchesPerFile: { type: 'number', default: 5, description: 'Max matches per file (-1 for unlimited, 1 for "find files only")' },
            caseSensitive: { type: 'boolean', default: false, description: 'Case-sensitive search' },
            pathPattern: { type: 'string', description: 'Filter by file path glob (e.g., "*.js", "src/**")' },
            noCache: { type: 'boolean', default: false, description: 'Skip cache and force fresh search' },
            analyze: { type: 'boolean', default: false, description: 'Use local LLM to analyze results and return structured summary with keyFindings, relevantFiles, implementationPatterns. Saves 50-90% tokens vs raw results.' },
            includeRaw: { type: 'boolean', default: false, description: 'Include raw search results in addition to analysis. Use when you want both the AI summary AND original snippets for drilling down.' }
          },
          required: ['codebase', 'pattern']
        }
      },
      {
        name: 'search_all_codebases',
        description: '[RECOMMENDED] Search across ALL indexed codebases at once. Perfect for finding "how is X implemented across different projects?" Strategies: hybrid (default, best overall), semantic (conceptual), keyword (fast exact match). AVOID strategy:grep unless you need regex - it is 10x slower. Use analyze:true (strongly recommended) to get AI-summarized insights instead of 50+ raw snippets (saves 50-90% tokens).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (natural language, keywords, or grep pattern)' },
            strategy: { type: 'string', enum: ['hybrid', 'semantic', 'keyword', 'grep'], default: 'hybrid', description: 'hybrid=best overall (default), keyword=fastest, semantic=conceptual, grep=slow regex (avoid unless needed)' },
            limit: { type: 'number', default: 20, description: 'Total result limit across all codebases' },
            perCodebaseLimit: { type: 'number', default: 5, description: 'Max results per codebase' },
            concurrency: { type: 'number', default: 10, description: 'Number of codebases to search in parallel' },
            filter: { 
              type: 'object',
              properties: { language: { type: 'string' } }
            },
            analyze: { type: 'boolean', default: false, description: 'Use local LLM to analyze results and return structured summary with keyFindings, relevantFiles, implementationPatterns. Saves 50-90% tokens vs raw results. STRONGLY RECOMMENDED for cross-codebase exploration.' },
            includeRaw: { type: 'boolean', default: false, description: 'Include raw search results in addition to analysis. Use when you want both the AI summary AND original snippets for drilling down.' }
          },
          required: ['query']
        }
      },
      {
        name: 'get_file_info',
        description: 'Get file structure (functions, classes, imports) without content. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            path: { type: 'string' }
          },
          required: ['codebase', 'path']
        }
      },
      {
        name: 'get_file',
        description: 'Get file content with staleness check. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            path: { type: 'string' }
          },
          required: ['codebase', 'path']
        }
      },
      {
        name: 'refresh_codebase',
        description: 'Incremental refresh of codebase index',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            analyze: { type: 'boolean', description: 'Re-run LLM analysis if stale (default: false)', default: false }
          },
          required: ['name']
        }
      },
      {
        name: 'remove_codebase',
        description: 'Remove a codebase and all its data',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' }
          },
          required: ['name']
        }
      },
      {
        name: 'check_codebase_status',
        description: 'Check staleness status of a codebase (stale files, missing files). Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' }
          },
          required: ['codebase']
        }
      },
      {
        name: 'check_file_stale',
        description: 'Check if a specific file is stale (changed since indexing). Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Codebase name (partial match supported)' },
            path: { type: 'string', description: 'File path relative to codebase root' }
          },
          required: ['codebase', 'path']
        }
      },
      {
        name: 'run_maintenance',
        description: 'Manually trigger maintenance cycle to refresh stale codebases',
        inputSchema: {
          type: 'object',
          properties: {
            codebase: { type: 'string', description: 'Specific codebase to refresh, or omit for all' }
          }
        }
      },
      {
        name: 'get_maintenance_stats',
        description: 'Get maintenance statistics and status',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'analyze_codebase',
        description: 'Run LLM analysis to generate project description and identify key files. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Codebase name to analyze (partial match supported)' }
          },
          required: ['name']
        }
      },
      {
        name: 'get_codebase_description',
        description: 'Get LLM-generated project description with staleness check. Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Codebase name (partial match supported)' }
          },
          required: ['name']
        }
      },
      {
        name: 'get_prioritized_files',
        description: 'Get files ordered by importance (high/medium/low priority). Codebase name supports partial matching.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Codebase name (partial match supported)' }
          },
          required: ['name']
        }
      }
    ];
  }

  handlesTool(name) {
    return [
      'list_codebases',
      'list_spaces',
      'index_codebase',
      'refresh_codebase',
      'remove_codebase',
      'search_codebase',
      'search_semantic',
      'search_keyword',
      'grep_codebase',
      'search_all_codebases',
      'get_file_tree',
      'get_file_info',
      'get_file',
      'check_codebase_status',
      'check_file_stale',
      'run_maintenance',
      'get_maintenance_stats',
      'analyze_codebase',
      'get_codebase_description',
      'get_prioritized_files'
    ].includes(name);
  }

  async callTool(name, args) {
    // Map tool names to method names
    const methodMap = {
      'list_codebases': 'listCodebases',
      'list_spaces': 'listSpaces',
      'index_codebase': 'indexCodebase',
      'refresh_codebase': 'refreshCodebase',
      'remove_codebase': 'removeCodebase',
      'search_codebase': 'search',
      'search_semantic': 'searchSemantic',
      'search_keyword': 'searchKeyword',
      'grep_codebase': 'grepCodebase',
      'search_all_codebases': 'searchAll',
      'get_file_tree': 'getFileTree',
      'get_file_info': 'getFileInfo',
      'get_file': 'getFile',
      'check_codebase_status': 'checkCodebaseStatus',
      'check_file_stale': 'checkFileStale',
      'run_maintenance': 'runMaintenance',
      'get_maintenance_stats': 'getMaintenanceStats',
      'analyze_codebase': 'analyzeCodebase',
      'get_codebase_description': 'getCodebaseDescription',
      'get_prioritized_files': 'getPrioritizedFiles'
    };
    
    const methodName = methodMap[name];
    if (!methodName || typeof this[methodName] !== 'function') {
      throw new Error(`Unknown tool: ${name}`);
    }
    
    // Extract analyze flag before passing to method
    const shouldAnalyze = args.analyze === true;
    const methodArgs = { ...args };
    delete methodArgs.analyze;
    
    const result = await this[methodName](methodArgs);
    
    // Post-process with LLM analysis if requested (for search tools)
    const searchTools = ['search_codebase', 'search_semantic', 'search_keyword', 'search_all_codebases', 'grep_codebase'];
    if (shouldAnalyze && searchTools.includes(name)) {
      try {
        // grep_codebase uses 'pattern' instead of 'query'
        const searchQuery = args.query || args.pattern || 'unknown query';
        const analysis = await this.analyzeSearchResults(result, searchQuery, name);
        const combined = {
          analysis,
          stats: {
            resultCount: result.count ?? result.totalCount ?? 0,
            searchType: name,
            originalQuery: searchQuery
          },
          // Include raw results only if explicitly requested (for token efficiency)
          ...(args.includeRaw ? { rawResults: result.results || result } : {})
        };
        return { content: [{ type: 'text', text: JSON.stringify(combined, null, 2) }] };
      } catch (err) {
        // If analysis fails, return original result with error note
        result._analysisError = err.message;
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    }
    
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
}
// --- Agent Contract ---

let serviceInstance = null;

export async function init(context) {
    serviceInstance = new CodebaseIndexingService({ ...context.config.codebase, spaces: context.config.spaces }, context.gateway);
    serviceInstance.setProgressCallback((cb) => {
        serviceInstance.progressCallback = cb ? (data) => context.progress(data.message, data.progress, data.total) : null;
    });
    // Try to preload but don't crash on failure
    serviceInstance.preloadAll().catch(err => console.error('[CodebaseIndexing] Preload failed:', err.message));
    // Start periodic maintenance cycle
    serviceInstance.startMaintenance();
    return serviceInstance;
}

export async function shutdown() {
    if (serviceInstance) {
        if (serviceInstance.stopMaintenance) serviceInstance.stopMaintenance();
        serviceInstance.maintenance.stop();
    }
}

// Tool handlers
export async function list_codebases(args, context) { return serviceInstance.callTool('list_codebases', args); }
export async function list_spaces(args, context) { return serviceInstance.callTool('list_spaces', args); }
export async function index_codebase(args, context) { return serviceInstance.callTool('index_codebase', args); }
export async function search_codebase(args, context) { return serviceInstance.callTool('search_codebase', args); }
export async function search_semantic(args, context) { return serviceInstance.callTool('search_semantic', args); }
export async function search_keyword(args, context) { return serviceInstance.callTool('search_keyword', args); }
export async function grep_codebase(args, context) { return serviceInstance.callTool('grep_codebase', args); }
export async function search_all_codebases(args, context) { return serviceInstance.callTool('search_all_codebases', args); }
export async function get_file_info(args, context) { return serviceInstance.callTool('get_file_info', args); }
export async function get_file(args, context) { return serviceInstance.callTool('get_file', args); }
export async function refresh_codebase(args, context) { return serviceInstance.callTool('refresh_codebase', args); }
export async function remove_codebase(args, context) { return serviceInstance.callTool('remove_codebase', args); }
export async function check_codebase_status(args, context) { return serviceInstance.callTool('check_codebase_status', args); }
export async function check_file_stale(args, context) { return serviceInstance.callTool('check_file_stale', args); }
export async function run_maintenance(args, context) { return serviceInstance.callTool('run_maintenance', args); }
export async function get_maintenance_stats(args, context) { return serviceInstance.callTool('get_maintenance_stats', args); }
export async function analyze_codebase(args, context) { return serviceInstance.callTool('analyze_codebase', args); }
export async function get_codebase_description(args, context) { return serviceInstance.callTool('get_codebase_description', args); }
export async function get_prioritized_files(args, context) { return serviceInstance.callTool('get_prioritized_files', args); }
