import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { WorkspaceResolver } from '../lib/workspace.js';

/**
 * Code Search Server - Fast semantic search for large codebases
 * Base index: tree-sitter + embeddings (~20-30min for 100k files)
 * LLM enrichment: query-driven, not upfront
 */
export class CodeSearchServer {
  constructor(config, llmRouter) {
    this.router = llmRouter;
    this.workspace = new WorkspaceResolver(config.workspaces || {});
    this.indexPath = config.indexPath || 'data/indexes';
    this.progressCallback = null;
    this.indexes = new Map(); // workspace -> loaded index
    this.progressCallback = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback({ progress, total, message });
    }
  }

  getPrompts() {
    return [
      {
        name: 'code-archaeology',
        description: 'Find how a feature was implemented across the codebase using multi-modal search',
        arguments: [
          { name: 'feature', description: 'The feature or pattern to investigate (e.g., "authentication", "WebSocket handling")', required: true },
          { name: 'workspace', description: 'Workspace path (e.g., D:\\Work\\_GIT\\SoundApp)', required: true }
        ]
      },
      {
        name: 'find-similar-code',
        description: 'Locate code similar to a reference implementation using semantic search',
        arguments: [
          { name: 'description', description: 'Describe what the code does (e.g., "parses audio metadata")', required: true },
          { name: 'workspace', description: 'Workspace path', required: true }
        ]
      },
      {
        name: 'trace-dependency',
        description: 'Find all files importing or using a specific module/function using keyword search',
        arguments: [
          { name: 'symbol', description: 'Function, class, or module name', required: true },
          { name: 'workspace', description: 'Workspace path', required: true }
        ]
      }
    ];
  }

  async getPrompt(name, args) {
    if (name === 'code-archaeology') {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Let's investigate how "${args.feature}" is implemented in ${args.workspace}:

**Creative Multi-Tool Workflow:**

1. **Semantic Discovery** - Find conceptually related code:
   \`search_semantic(path="${args.workspace}", query="${args.feature} implementation patterns", limit=15)\`

2. **Keyword Validation** - Verify with exact matches:
   \`search_keyword(path="${args.workspace}", pattern="${args.feature}", limit=30)\`

3. **File Pattern Analysis** - Look for naming conventions:
   \`search_files(path="${args.workspace}", glob="**/*${args.feature.toLowerCase().replace(/\s+/g, '-')}*")\`

4. **Retrieve Key Files** - Get full source for top 3 semantic matches:
   Use \`retrieve_file\` on the highest-scoring files

5. **Cross-Reference** - Combine findings:
   - Files appearing in multiple searches are likely core implementations
   - Unique semantic matches might be edge cases or experimental code
   - File patterns reveal architectural organization

**Why this works:** Semantic search finds intent, keywords find usage, file patterns find structure. Together they paint a complete picture.`
            }
          }
        ]
      };
    }

    if (name === 'find-similar-code') {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Find code similar to: "${args.description}" in ${args.workspace}

**Semantic Search Strategy:**

1. **Broad Semantic Scan**:
   \`search_semantic(path="${args.workspace}", query="${args.description}", limit=20)\`
   
2. **Refine by Function Names** (extract from results):
   \`search_keyword(path="${args.workspace}", pattern="function.*parse|class.*Parser", regex=true)\`

3. **Retrieve Top Matches**:
   Use \`retrieve_file\` on files with >70% similarity score

**Creative Insight:** Semantic embeddings capture *what code does*, not just *what it's called*. You might discover:
- Similar algorithms with different names
- Refactored versions of the same logic
- Parallel implementations across modules
- Opportunities for code reuse`
            }
          }
        ]
      };
    }

    if (name === 'trace-dependency') {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Trace all usages of "${args.symbol}" in ${args.workspace}

**Dependency Tracing Pattern:**

1. **Import Statements**:
   \`search_keyword(path="${args.workspace}", pattern="import.*${args.symbol}|require.*${args.symbol}", regex=true)\`

2. **Direct Usage**:
   \`search_keyword(path="${args.workspace}", pattern="${args.symbol}\\\\(|${args.symbol}\\\\.", regex=true, limit=50)\`

3. **Type References** (TypeScript/JSDoc):
   \`search_keyword(path="${args.workspace}", pattern="@type.*${args.symbol}|: ${args.symbol}", regex=true)\`

4. **File Organization**:
   \`search_files(path="${args.workspace}", glob="**/${args.symbol}*")\`

5. **Semantic Context**:
   \`search_semantic(path="${args.workspace}", query="code that uses ${args.symbol} for its primary functionality")\`

**Pro Tip:** Combine keyword precision with semantic understanding to catch both direct calls and conceptual dependencies. This reveals the true dependency graph, not just import statements.`
            }
          }
        ]
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  }

  getTools() {
    return [
      {
        name: 'get_workspace_config',
        description: 'CALL FIRST to discover available workspaces for code search. Returns workspace names, index status, and file counts. All other code search tools require a workspace name from this list. File results use format "workspace:path" (e.g., "BADKID-DEV:src/file.js") - pass these directly to retrieve_file.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_file_info',
        description: 'Get detailed metadata for a specific file. Returns: functions/classes with LINE NUMBERS, imports, exports, language, size. CRITICAL: Use this after search to see WHERE functions are located (line numbers), then use retrieve_file with startLine/endLine to fetch only what you need. Workflow: search_semantic → get_file_info (see line numbers) → retrieve_file (partial). Does NOT return content.',
        inputSchema: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'File ID from search results (format: "workspace:path" e.g., "BADKID-DEV:src/http-server.js")'
            }
          },
          required: ['file']
        }
      },
      {
        name: 'refresh_index',
        description: 'Incrementally update code search index for a workspace. Fast (seconds) - only processes files changed since last index. Call after making code changes to keep search results current.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV", "COOLKID-Work")'
            }
          },
          required: ['workspace']
        }
      },
      {
        name: 'refresh_all_indexes',
        description: 'Refresh indexes for ALL configured workspaces in one call. Useful after bulk changes across multiple projects or when setting up a new environment.',
        inputSchema: {
          type: 'object',
          properties: {
            force: {
              type: 'boolean',
              description: 'Force full rebuild instead of incremental update (default: false)'
            }
          },
          required: []
        }
      },
      {
        name: 'get_index_stats',
        description: 'Check index health for a workspace: file count, last build time, staleness warnings. Use before searching to verify the index exists and is fresh.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")'
            }
          },
          required: ['workspace']
        }
      },
      {
        name: 'search_files',
        description: 'Find files by name/path pattern using glob matching. Returns ONLY file IDs ("workspace:path") - no metadata, no functions, no content. Fast for exploring directory structure or finding files by name. For metadata, use get_file_info after finding files. For content, use retrieve_file.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")'
            },
            glob: {
              type: 'string',
              description: 'Glob pattern: "*auth*.js" (files containing auth), "src/**/*.ts" (all TS in src), "**/*test*" (all test files)'
            }
          },
          required: ['workspace', 'glob']
        }
      },
      {
        name: 'search_keyword',
        description: 'Fast text/regex search across all indexed files. Returns file IDs with matching line excerpts - no function metadata. Use for: finding exact strings, function calls, variable references, TODO comments. For function/class structure, use search_semantic or get_file_info instead.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")'
            },
            pattern: {
              type: 'string',
              description: 'Search text or regex pattern (e.g., "StreamableHTTP", "async function \\w+", "TODO|FIXME")'
            },
            regex: {
              type: 'boolean',
              description: 'Treat pattern as regex (default: false). Enable for advanced patterns.'
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 50)'
            }
          },
          required: ['workspace', 'pattern']
        }
      },
      {
        name: 'search_semantic',
        description: 'Find code by MEANING using AI embeddings - understands concepts, not just keywords. Returns: file IDs, similarity scores (0-100%), language, size, and FUNCTION/CLASS NAMES found in each file. Does NOT include line numbers - use get_file_info for that. Use for: "authentication logic", "error handling", "database connection setup". Functions array helps you identify relevant files before retrieving content.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")'
            },
            query: {
              type: 'string',
              description: 'Natural language description of what you\'re looking for (e.g., "WebSocket connection handling", "memory leak prevention")'
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 10)'
            }
          },
          required: ['workspace', 'query']
        }
      },
      {
        name: 'search_code',
        description: 'Multi-modal search combining semantic + keyword + file patterns. Returns: file IDs, similarity scores, function/class names, and enriched code snippets. Best for complex queries where you\'re not sure of exact terms. Like search_semantic, includes function/class arrays but no line numbers - use get_file_info for precise locations.',
        inputSchema: {
          type: 'object',
          properties: {
            workspace: {
              type: 'string',
              description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")'
            },
            query: {
              type: 'string',
              description: 'Natural language search query - will search by meaning AND keywords'
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 5)'
            }
          },
          required: ['workspace', 'query']
        }
      }
    ];
  }

  handlesTool(name) {
    return [
      'get_workspace_config',
      'get_file_info',
      'refresh_index',
      'refresh_all_indexes',
      'get_index_stats',
      'search_files',
      'search_keyword',
      'search_semantic',
      'search_code'
    ].includes(name);
  }

  async callTool(name, args) {
    try {
      switch (name) {
        case 'get_workspace_config':
          return await this._getWorkspaceConfig();
        case 'get_file_info':
          return await this._getFileInfo(args);
        case 'refresh_index':
          return await this._refreshIndex(args);
        case 'refresh_all_indexes':
          return await this._refreshAllIndexes();
        case 'get_index_stats':
          return await this._getIndexStats(args);
        case 'search_files':
          return await this._searchFiles(args);
        case 'search_keyword':
          return await this._searchKeyword(args);
        case 'search_semantic':
          return await this._searchSemantic(args);
        case 'search_code':
          return await this._searchCode(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: err.message, code: err.code || 'SEARCH_ERROR' }, null, 2)
        }]
      };
    }
  }

  /**
   * Get index file path for a workspace
   */
  _getIndexFilePath(workspace) {
    return path.join(this.indexPath, `${workspace}.json`);
  }

  async _getWorkspaceConfig() {
    // Get available indexes
    const indexDir = path.join(process.cwd(), 'data', 'indexes');
    let availableIndexes = [];
    try {
      const files = await fs.readdir(indexDir);
      availableIndexes = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    } catch (err) {
      // indexDir doesn't exist yet
    }
    
    const workspaces = this.workspace.getWorkspaces();
    
    const result = {
      workspaces: workspaces.map(({ name, uncPath }) => ({
        name,
        uncPath,
        indexed: availableIndexes.includes(name)
      })),
      usage: {
        search: "mcp_orchestrator_search_files({ workspace: 'BADKID-DEV', glob: '**/*.js' })",
        retrieve: "mcp_orchestrator_retrieve_file({ file: 'BADKID-DEV:src/http-server.js' })",
        note: "Search returns file IDs like 'workspace:relative/path' - pass these directly to retrieve_file"
      }
    };
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  async _getIndexStats(args) {
    const { workspace } = args;
    const indexFile = this._getIndexFilePath(workspace);

    try {
      const index = await this._loadIndex(indexFile);
      const ageHours = (Date.now() - new Date(index.last_refresh || index.created_at).getTime()) / 3600000;
      const stale = ageHours > 168; // 7 days

      const stats = {
        exists: true,
        workspace,
        file_count: index.file_count || 0,
        last_full_build: index.last_full_build || index.created_at,
        last_refresh: index.last_refresh || index.created_at,
        age_hours: Math.round(ageHours * 10) / 10,
        stale,
        enriched_files: Object.values(index.files || {}).filter(f => f.enrichment).length,
        build_in_progress: index.build_in_progress || false
      };

      return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              exists: false,
              workspace,
              hint: `No index found. Run: node scripts/build-index.js --workspace "${workspace}"`
            }, null, 2)
          }]
        };
      }
      throw err;
    }
  }

  async _getFileInfo(args) {
    const { file } = args;

    try {
      const { workspace, relativePath } = this.workspace.parseFileId(file);
      const indexFile = this._getIndexFilePath(workspace);
      const index = await this._loadIndex(indexFile);

      const fileData = index.files[relativePath];
      if (!fileData) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'File not found in index',
              file,
              hint: 'File may not be indexed yet. Try refresh_index first.'
            }, null, 2)
          }]
        };
      }

      // Return metadata without content or embeddings
      const info = {
        file,
        workspace,
        path: relativePath,
        language: fileData.language,
        size_bytes: fileData.size_bytes,
        functions: fileData.tree?.functions?.map(f => ({ name: f.name, line: f.line })) || [],
        classes: fileData.tree?.classes?.map(c => ({ name: c.name, line: c.line })) || [],
        imports: fileData.tree?.imports || [],
        exports: fileData.tree?.exports || [],
        last_indexed: fileData.last_indexed_at,
        enriched: !!fileData.enrichment
      };

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(info, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            file
          }, null, 2)
        }]
      };
    }
  }

  async _refreshAllIndexes() {
    const workspaces = this.workspace.getWorkspaces();
    const results = [];
    
    this.sendProgress(0, workspaces.length, 'Starting refresh of all indexes...');
    
    for (let i = 0; i < workspaces.length; i++) {
      const { name } = workspaces[i];
      this.sendProgress(i, workspaces.length, `Refreshing ${name}...`);
      
      try {
        const result = await this._refreshIndex({ workspace: name });
        const parsed = JSON.parse(result.content[0].text);
        results.push({ workspace: name, status: 'success', ...parsed });
      } catch (err) {
        results.push({ workspace: name, status: 'error', error: err.message });
      }
    }
    
    this.sendProgress(workspaces.length, workspaces.length, 'Complete');
    
    const summary = {
      total: workspaces.length,
      success: results.filter(r => r.status === 'success').length,
      errors: results.filter(r => r.status === 'error').length,
      results
    };
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(summary, null, 2)
      }]
    };
  }

  async _refreshIndex(args) {
    const { workspace } = args;
    const startTime = Date.now();

    this.sendProgress(5, 100, 'Resolving workspace path...');
    
    const uncPath = this.workspace.getWorkspacePath(workspace);
    const indexFile = this._getIndexFilePath(workspace);

    // Try to acquire lock
    const lockAcquired = await this._acquireIndexLock(indexFile);
    if (!lockAcquired) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'ALREADY_RUNNING' }, null, 2)
        }]
      };
    }

    try {
      this.sendProgress(10, 100, 'Loading existing index...');
      
      let index;
      try {
        index = await this._loadIndex(indexFile);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(`No index found. Run: node scripts/build-index.js --workspace "${workspace}"`);
        }
        throw err;
      }

      this.sendProgress(20, 100, 'Scanning workspace...');

      // Walk workspace and collect file metadata
      const currentFiles = new Map();
      await this._walkWorkspace(uncPath, uncPath, currentFiles);

      this.sendProgress(40, 100, 'Computing changes...');

      // Determine what changed
      const stats = {
        files_checked: currentFiles.size,
        files_updated: 0,
        files_added: 0,
        files_removed: 0
      };

      // Find deleted files
      for (const filePath of Object.keys(index.files)) {
        if (!currentFiles.has(filePath)) {
          delete index.files[filePath];
          stats.files_removed++;
        }
      }

      // Find new/modified files
      const toUpdate = [];
      for (const [filePath, metadata] of currentFiles) {
        const existing = index.files[filePath];
        if (!existing || existing.mtime < metadata.mtime) {
          toUpdate.push({ filePath, metadata });
          if (existing) {
            stats.files_updated++;
          } else {
            stats.files_added++;
          }
        }
      }

      if (toUpdate.length > 0) {
        this.sendProgress(50, 100, `Processing ${toUpdate.length} changed files...`);
        
        // Process changed files
        for (let i = 0; i < toUpdate.length; i++) {
          const { filePath, metadata } = toUpdate[i];
          const progress = 50 + (i / toUpdate.length) * 40;
          this.sendProgress(progress, 100, `Processing ${i + 1}/${toUpdate.length}...`);

          try {
            const fullPath = path.join(uncPath, filePath);
            const content = await fs.readFile(fullPath, 'utf-8');
            const contentHash = this._hash(content);

            // Parse structure (simplified - real impl would use tree-sitter)
            const tree = this._parseFile(content, filePath);

            // Generate embedding
            const embedding = await this._generateEmbedding(filePath, tree);

            index.files[filePath] = {
              path: filePath,
              content_hash: contentHash,
              mtime: metadata.mtime,
              last_indexed_at: new Date().toISOString(),
              language: this._detectLanguage(filePath),
              size_bytes: metadata.size,
              tree,
              embedding,
              parse_failed: false
            };
          } catch (err) {
            console.warn(`Failed to index ${filePath}:`, err.message);
          }
        }
      }

      // Update metadata
      index.file_count = currentFiles.size;
      index.last_refresh = new Date().toISOString();
      stats.duration_ms = Date.now() - startTime;

      this.sendProgress(95, 100, 'Writing index...');
      await this._atomicWriteIndex(indexFile, index);

      // Release lock
      await this._releaseIndexLock(indexFile);

      this.sendProgress(100, 100, 'Complete');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', ...stats }, null, 2)
        }]
      };
    } catch (err) {
      await this._releaseIndexLock(indexFile);
      throw err;
    }
  }

  async _searchFiles(args) {
    const { workspace, glob } = args;
    const index = await this._loadIndexForWorkspace(workspace);

    const regex = this._globToRegex(glob);
    const matches = Object.keys(index.files)
      .filter(filePath => regex.test(filePath))
      .map(filePath => ({
        file: this.workspace.createFileId(workspace, filePath),
        language: index.files[filePath].language,
        size: index.files[filePath].size_bytes
      }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ matches, count: matches.length }, null, 2)
      }]
    };
  }

  async _searchKeyword(args) {
    const { workspace, pattern, regex = false, limit = 50 } = args;
    const index = await this._loadIndexForWorkspace(workspace);
    const uncPath = this.workspace.getWorkspacePath(workspace);

    const searchRegex = regex ? new RegExp(pattern, 'gi') : null;
    const matches = [];

    for (const [filePath, fileData] of Object.entries(index.files)) {
      if (matches.length >= limit) break;

      try {
        const fullPath = path.join(uncPath, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const match = regex ? searchRegex.test(lines[i]) : lines[i].includes(pattern);
          if (match) {
            const trimmed = lines[i].trim();
            matches.push({
              file: this.workspace.createFileId(workspace, filePath),
              line: i + 1,
              content: trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed,
              language: fileData.language
            });
            if (matches.length >= limit) break;
          }
        }
      } catch (err) {
        // Skip unreadable files
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ matches, count: matches.length }, null, 2)
      }]
    };
  }

  async _searchSemantic(args) {
    const { workspace, query, limit = 10 } = args;
    const index = await this._loadIndexForWorkspace(workspace);

    // Generate query embedding
    const queryEmbedding = await this._generateEmbedding(query);

    // Compute similarity with all files
    const results = [];
    for (const [filePath, fileData] of Object.entries(index.files)) {
      if (!fileData.embedding) continue;
      
      const similarity = this._cosineSimilarity(queryEmbedding, fileData.embedding);
      results.push({
        file: this.workspace.createFileId(workspace, filePath),
        similarity,
        language: fileData.language,
        size: fileData.size_bytes,
        functions: fileData.tree?.functions?.map(f => f.name) || [],
        classes: fileData.tree?.classes?.map(c => c.name) || []
      });
    }

    // Sort by similarity and take top results
    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, limit);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ results: topResults, count: topResults.length }, null, 2)
      }]
    };
  }

  async _searchCode(args) {
    const { workspace, query, limit = 5 } = args;

    // Multi-modal search: combine semantic + keyword + filename
    const semanticResults = await this._searchSemantic({ workspace, query, limit: limit * 2 });
    const semantic = JSON.parse(semanticResults.content[0].text).results;

    // Trigger enrichment on top results (if not already enriched)
    // TODO: Implement enrichment with local LLM

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: semantic.slice(0, limit),
          count: semantic.slice(0, limit).length,
          enrichment_available: false
        }, null, 2)
      }]
    };
  }

  // ========== HELPER METHODS ==========

  async _loadIndex(indexFile) {
    const content = await fs.readFile(indexFile, 'utf-8');
    return JSON.parse(content);
  }

  async _loadIndexForWorkspace(workspace) {
    const indexFile = this._getIndexFilePath(workspace);
    const index = await this._loadIndex(indexFile);
    if (!index.files) {
      throw new Error('Invalid index: no files found');
    }
    return index;
  }

  async _atomicWriteIndex(indexFile, data) {
    // Ensure directory exists
    await fs.mkdir(path.dirname(indexFile), { recursive: true });

    const tempFile = `${indexFile}.tmp.${Date.now()}`;
    
    // Stream write to avoid "Invalid string length" for large indexes
    await this._writeIndexStreaming(tempFile, data);
    await fs.rename(tempFile, indexFile);
  }

  /**
   * Write index file in streaming fashion to handle large file counts.
   * Avoids "Invalid string length" error from JSON.stringify on 500MB+ indexes.
   */
  async _writeIndexStreaming(filePath, index) {
    const { createWriteStream } = await import('fs');
    const stream = createWriteStream(filePath, { encoding: 'utf-8' });
    
    const write = (data) => new Promise((resolve, reject) => {
      if (!stream.write(data)) {
        stream.once('drain', resolve);
      } else {
        resolve();
      }
    });

    // Write header fields
    await write('{\n');
    await write(`  "version": ${index.version},\n`);
    await write(`  "workspace": ${JSON.stringify(index.workspace)},\n`);
    await write(`  "created_at": ${JSON.stringify(index.created_at)},\n`);
    await write(`  "last_full_build": ${JSON.stringify(index.last_full_build)},\n`);
    await write(`  "last_refresh": ${JSON.stringify(index.last_refresh)},\n`);
    await write(`  "file_count": ${index.file_count},\n`);
    await write(`  "total_size_bytes": ${index.total_size_bytes},\n`);
    await write(`  "build_in_progress": ${index.build_in_progress},\n`);
    if (index.lock_acquired_at !== undefined) {
      await write(`  "lock_acquired_at": ${JSON.stringify(index.lock_acquired_at)},\n`);
    }
    await write(`  "files": {\n`);

    // Write files one at a time to avoid string length limit
    const entries = Object.entries(index.files);
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      const comma = i < entries.length - 1 ? ',' : '';
      await write(`    ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}\n`);
    }

    await write('  }\n');
    await write('}\n');

    await new Promise((resolve, reject) => {
      stream.end(resolve);
      stream.on('error', reject);
    });
  }

  async _acquireIndexLock(indexFile) {
    try {
      const index = await this._loadIndex(indexFile);
      
      if (index.build_in_progress) {
        const lockAge = Date.now() - new Date(index.lock_acquired_at).getTime();
        if (lockAge > 30 * 60 * 1000) {
          console.warn('Breaking stale index lock (>30min)');
        } else {
          return false;
        }
      }

      index.build_in_progress = true;
      index.lock_acquired_at = new Date().toISOString();
      await this._atomicWriteIndex(indexFile, index);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        // No index exists - can't refresh without initial build
        throw new Error('Index does not exist. Run initial build first.');
      }
      throw err;
    }
  }

  async _releaseIndexLock(indexFile) {
    try {
      const index = await this._loadIndex(indexFile);
      index.build_in_progress = false;
      index.lock_acquired_at = null;
      await this._atomicWriteIndex(indexFile, index);
    } catch (err) {
      console.error('Failed to release lock:', err.message);
    }
  }

  async _walkWorkspace(basePath, currentPath, files) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        // Skip common ignored directories
        if (['.git', 'node_modules', '.next', 'dist', 'build', '.vscode'].includes(entry.name)) {
          continue;
        }
        await this._walkWorkspace(basePath, fullPath, files);
      } else if (entry.isFile()) {
        // Skip non-code files
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.md'].includes(ext)) {
          continue;
        }

        const stats = await fs.stat(fullPath);
        files.set(relativePath.replace(/\\/g, '/'), {
          mtime: stats.mtimeMs,
          size: stats.size
        });
      }
    }
  }

  _parseFile(content, filePath) {
    // Simplified parser - real implementation would use tree-sitter
    const ext = path.extname(filePath).toLowerCase();
    const tree = {
      functions: [],
      classes: [],
      imports: [],
      exports: [],
      comments: []
    };

    // Basic regex-based parsing for JS/TS
    if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
      const functionRegex = /(?:function|const|let|var)\s+(\w+)\s*[=\(]/g;
      const classRegex = /class\s+(\w+)/g;
      const importRegex = /import\s+.*?from\s+['"](.+?)['"]/g;

      let match;
      while ((match = functionRegex.exec(content)) !== null) {
        tree.functions.push({ name: match[1], line: this._getLineNumber(content, match.index) });
      }
      while ((match = classRegex.exec(content)) !== null) {
        tree.classes.push({ name: match[1], line: this._getLineNumber(content, match.index) });
      }
      while ((match = importRegex.exec(content)) !== null) {
        tree.imports.push({ module: match[1] });
      }
    }

    return tree;
  }

  _getLineNumber(content, index) {
    return content.slice(0, index).split('\n').length;
  }

  async _generateEmbedding(text, tree = null) {
    try {
      // Combine file path, symbols, and structure for better embeddings
      let embeddingText = text;
      if (tree) {
        const symbols = [
          ...tree.functions.map(f => f.name),
          ...tree.classes.map(c => c.name)
        ].join(' ');
        embeddingText = `${text} ${symbols}`;
      }

      // Truncate to avoid token limits (roughly 8k chars = 2k tokens)
      if (embeddingText.length > 8000) {
        embeddingText = embeddingText.slice(0, 8000);
      }

      const embedding = await this.router.embedText(embeddingText, null); // null = use task default for 'embedding'
      return embedding;
    } catch (err) {
      console.warn('Embedding generation failed:', err.message);
      // Return zero vector as fallback
      return new Array(768).fill(0);
    }
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  _hash(content) {
    return createHash('sha256').update(content).digest('hex');
  }

  _detectLanguage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const langMap = {
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.cs': 'csharp',
      '.go': 'go',
      '.rs': 'rust',
      '.md': 'markdown'
    };
    return langMap[ext] || 'unknown';
  }

  _globToRegex(glob) {
    // Use placeholder to prevent ** replacement from being clobbered by * replacement
    let pattern = glob
      .replace(/\./g, '\\.')
      .replace(/\*\*/g, '\x00STARSTAR\x00')  // Placeholder for **
      .replace(/\*/g, '[^/\\\\]*')            // * matches within directory (not / or \)
      .replace(/\x00STARSTAR\x00/g, '.*')    // ** matches across directories
      .replace(/\?/g, '.');
    return new RegExp(`^${pattern}$`, 'i');
  }
}
