/**
 * Codebase Indexing Service
 *
 * WebSocket client wrapper for nIndexer service.
 * Provides semantic code search, keyword search, grep, and file operations.
 *
 * Architecture:
 * - nIndexer: External WebSocket service (port 3666) for vector search and indexing
 * - This agent: Thin client that translates MCP tools → nIndexer JSON-RPC calls
 */

import { NIndexerClient } from './nindexer-client.js';
import path from 'path';
import fs from 'fs/promises';

const DEFAULT_CONFIG = {
  wsUrl: 'ws://localhost:3666',
  connectTimeout: 5000,
  requestTimeout: 30000,
  reconnectInterval: 3000,
  maxReconnectAttempts: 5
};

export class CodebaseIndexingService {
  constructor(config = {}, llmRouter) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.router = llmRouter;
    this.client = new NIndexerClient(this.config.nIndexer || {});
    this.progressCallback = null;

    // Store spaces configuration for path resolution (before calling nIndexer)
    this.spaces = config.spaces || {};
  }

  /**
   * Connect to nIndexer service
   */
  async connect() {
    await this.client.connect();
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
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

  // ========== Proxy Methods to nIndexer ==========

  /**
   * List all indexed codebases
   */
  async listCodebases() {
    return this.client.listCodebases();
  }

  /**
   * Index a new codebase
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

    // Call nIndexer to index
    const result = await this.client.indexCodebase(name, source, analyze);

    return {
      name,
      source,
      indexed: result.indexed,
      errors: result.errors,
      duration: result.duration,
      rate: result.rate,
      analysis: result.analysis ? {
        completed: !!result.analysis.completed,
        description: result.analysis.description,
        duration: result.analysis.duration,
        error: result.analysis.error
      } : null
    };
  }

  /**
   * Refresh (incrementally update) a codebase
   */
  async refreshCodebase({ name, analyze = false }, onProgress) {
    const result = await this.client.refreshCodebase(name, analyze);

    return {
      indexed: result.indexed,
      errors: result.errors,
      duration: result.duration,
      rate: result.rate,
      analysis: result.analysis ? {
        completed: !!result.analysis.completed,
        description: result.analysis.description,
        duration: result.analysis.duration,
        error: result.analysis.error
      } : null
    };
  }

  /**
   * Remove a codebase
   */
  async removeCodebase({ name }) {
    return this.client.removeCodebase(name);
  }

  /**
   * Hybrid search - combines semantic + keyword
   */
  async search({ codebase, query, strategy = 'hybrid', limit = 10, filter }) {
    return this.client.search(codebase, query, limit, filter);
  }

  /**
   * Semantic search
   */
  async searchSemantic({ codebase, query, limit = 10, filter }) {
    return this.client.searchSemantic(codebase, query, limit, filter);
  }

  /**
   * Keyword search
   */
  async searchKeyword({ codebase, query, limit = 20, searchContent = true }) {
    return this.client.searchKeyword(codebase, query, limit, searchContent);
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
    return this.client.grepCodebase(codebase, pattern, {
      regex,
      limit,
      maxMatchesPerFile,
      caseSensitive,
      pathPattern,
      noCache
    });
  }

  /**
   * Search across ALL codebases
   */
  async searchAll({ query, strategy = 'hybrid', limit = 10, filter, perCodebaseLimit = 5, concurrency = 10 }) {
    return this.client.searchAll(query, strategy, limit, perCodebaseLimit);
  }

  /**
   * Analyze search results using local LLM
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
   * Get file tree
   */
  async getFileTree({ codebase, path: subpath = '' }) {
    return this.client.getFileTree(codebase, subpath);
  }

  /**
   * Get file info (functions, classes, imports)
   */
  async getFileInfo({ codebase, path: filePath }) {
    return this.client.getFileInfo(codebase, filePath);
  }

  /**
   * Get file content with staleness check
   */
  async getFile({ codebase, path: filePath }) {
    return this.client.getFile(codebase, filePath);
  }

  // ========== Maintenance Operations ==========

  /**
   * Check staleness status
   */
  async checkCodebaseStatus({ codebase }) {
    return this.client.checkCodebaseStatus(codebase);
  }

  /**
   * Check if a specific file is stale
   */
  async checkFileStale({ codebase, path: filePath }) {
    const result = await this.client.getFile(codebase, filePath);
    return { stale: result.stale, lastIndexed: result.lastIndexed };
  }

  /**
   * Manually run maintenance
   */
  async runMaintenance({ codebase } = {}) {
    return this.client.runMaintenance(codebase);
  }

  /**
   * Get maintenance statistics
   */
  async getMaintenanceStats() {
    return this.client.getMaintenanceStats();
  }

  // ========== LLM Project Analysis ==========

  /**
   * Analyze codebase with LLM
   */
  async analyzeCodebase({ name }, onProgress) {
    return this.client.analyzeCodebase(name);
  }

  /**
   * Get codebase description with staleness check
   */
  async getCodebaseDescription({ name }) {
    return this.client.getCodebaseDescription(name);
  }

  /**
   * Get prioritized file list
   */
  async getPrioritizedFiles({ name }) {
    return this.client.getPrioritizedFiles(name);
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
        description: 'FAST indexed keyword search. Best for: exact function names, class names, variable names, imports. Searches file paths AND content. Much faster than grep_codebase (<100ms vs 1-3s). Use this INSTEAD of grep_codebase when searching for specific identifiers. Codebase name supports partial matching.',
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
        description: '[RECOMMENDED] Search across ALL indexed codebases at once. Perfect for finding "how is X implemented across different projects?" Strategies: hybrid (default, semantic, keyword). Use analyze:true (strongly recommended) to get AI-summarized insights instead of 50+ raw snippets (saves 50-90% tokens).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query (natural language, keywords, or grep pattern)' },
            strategy: { type: 'string', enum: ['hybrid', 'semantic', 'keyword'], default: 'hybrid', description: 'hybrid=best overall (default), keyword=fastest, semantic=conceptual' },
            limit: { type: 'number', default: 20, description: 'Total result limit across all codebases' },
            perCodebaseLimit: { type: 'number', default: 5, description: 'Max results per codebase' },
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
    const methodMap = {
      'list_codebases': 'listCodebases',
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
        const searchQuery = args.query || args.pattern || 'unknown query';
        const analysis = await this.analyzeSearchResults(result, searchQuery, name);
        const combined = {
          analysis,
          stats: {
            resultCount: result.count ?? result.totalCount ?? 0,
            searchType: name,
            originalQuery: searchQuery
          },
          ...(args.includeRaw ? { rawResults: result.results || result } : {})
        };
        return { content: [{ type: 'text', text: JSON.stringify(combined, null, 2) }] };
      } catch (err) {
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
  const nIndexerConfig = {
    wsUrl: context.config.nIndexer?.wsUrl || 'ws://localhost:3666',
    connectTimeout: context.config.nIndexer?.connectTimeout || 5000,
    requestTimeout: context.config.nIndexer?.requestTimeout || 30000,
    reconnectInterval: context.config.nIndexer?.reconnectInterval || 3000,
    maxReconnectAttempts: context.config.nIndexer?.maxReconnectAttempts || 5
  };

  serviceInstance = new CodebaseIndexingService(
    { ...context.config.codebase, spaces: context.config.spaces, nIndexer: nIndexerConfig },
    context.gateway
  );

  // Connect to nIndexer service
  try {
    await serviceInstance.connect();
    console.log('[CodebaseIndexing] Connected to nIndexer at', nIndexerConfig.wsUrl);
  } catch (err) {
    console.error('[CodebaseIndexing] Failed to connect to nIndexer:', err.message);
    // Don't throw - allow agent to initialize and retry on first request
  }

  serviceInstance.setProgressCallback((cb) => {
    serviceInstance.progressCallback = cb ? (data) => context.progress(data.message, data.progress, data.total) : null;
  });

  return serviceInstance;
}

export async function shutdown() {
  if (serviceInstance) {
    serviceInstance.client.disconnect();
  }
}

// Tool handlers
export async function list_codebases(args, context) { return serviceInstance.callTool('list_codebases', args); }
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
