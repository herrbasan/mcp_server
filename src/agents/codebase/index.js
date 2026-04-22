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
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.client = new NIndexerClient(this.config.nIndexer || {});
    this.progressCallback = null;
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
    return this.client.search(codebase, query, strategy, limit, filter);
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
   * Get file info for multiple files (bulk scan)
   */
  async getFilesInfo({ codebase, paths }) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('paths must be a non-empty array');
    }
    const results = [];
    for (const p of paths) {
      try {
        const info = await this.client.getFileInfo(codebase, p);
        results.push({ path: p, ...info });
      } catch (err) {
        results.push({ path: p, error: err.message });
      }
    }
    return results;
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
  async runMaintenance({ codebase, reindex, analyze } = {}) {
    return this.client.runMaintenance(codebase, reindex, analyze);
  }

  /**
   * Get maintenance statistics
   */
  async getMaintenanceStats() {
    return this.client.getMaintenanceStats();
  }

  // ========== Project Analysis (nIndexer heuristic) ==========

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
    { ...context.config.codebase, spaces: context.config.spaces, nIndexer: nIndexerConfig }
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
function _result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function list_codebases(args, context) { return _result(await serviceInstance.listCodebases()); }
export async function index_codebase(args, context) { return _result(await serviceInstance.indexCodebase(args)); }
export async function search_codebase(args, context) { return _result(await serviceInstance.search(args)); }
export async function search_semantic(args, context) { return _result(await serviceInstance.searchSemantic(args)); }
export async function search_keyword(args, context) { return _result(await serviceInstance.searchKeyword(args)); }
export async function grep_codebase(args, context) { return _result(await serviceInstance.grepCodebase(args)); }
export async function search_all_codebases(args, context) { return _result(await serviceInstance.searchAll(args)); }
export async function get_file_tree(args, context) { return _result(await serviceInstance.getFileTree(args)); }
export async function get_file_info(args, context) { return _result(await serviceInstance.getFileInfo(args)); }
export async function get_files_info(args, context) { return _result(await serviceInstance.getFilesInfo(args)); }
export async function get_file(args, context) { return _result(await serviceInstance.getFile(args)); }
export async function refresh_codebase(args, context) { return _result(await serviceInstance.refreshCodebase(args)); }
export async function remove_codebase(args, context) { return _result(await serviceInstance.removeCodebase(args)); }
export async function check_codebase_status(args, context) { return _result(await serviceInstance.checkCodebaseStatus(args)); }
export async function check_file_stale(args, context) { return _result(await serviceInstance.checkFileStale(args)); }
export async function run_maintenance(args, context) { return _result(await serviceInstance.runMaintenance(args)); }
export async function get_maintenance_stats(args, context) { return _result(await serviceInstance.getMaintenanceStats()); }
export async function analyze_codebase(args, context) { return _result(await serviceInstance.analyzeCodebase(args)); }
export async function get_codebase_description(args, context) { return _result(await serviceInstance.getCodebaseDescription(args)); }
export async function get_prioritized_files(args, context) { return _result(await serviceInstance.getPrioritizedFiles(args)); }
