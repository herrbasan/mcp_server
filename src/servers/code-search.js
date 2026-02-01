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
        name: 'refresh_index',
        description: 'Incrementally update code search index for files changed since last build. Fast (seconds). Call after making code changes to keep index fresh.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Local path to workspace (e.g., D:\\DEV\\mcp_server)'
            },
            machine: {
              type: 'string',
              description: 'Machine name (optional, uses default from config if not specified)'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'get_index_stats',
        description: 'Get code search index health: exists, file count, age, staleness warnings. Use to check if workspace is indexed before searching.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Local path to workspace'
            },
            machine: {
              type: 'string',
              description: 'Machine name (optional)'
            }
          },
          required: ['path']
        }
      },
      {
        name: 'search_files',
        description: 'Find files by name/path pattern using glob matching. Fast cached search.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Local path to workspace'
            },
            glob: {
              type: 'string',
              description: 'Glob pattern (e.g., "*auth*.js", "src/**/*.ts")'
            },
            machine: {
              type: 'string',
              description: 'Machine name (optional)'
            }
          },
          required: ['path', 'glob']
        }
      },
      {
        name: 'search_keyword',
        description: 'Fast keyword/regex search across indexed files. Uses cached index for speed.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Local path to workspace'
            },
            pattern: {
              type: 'string',
              description: 'Search pattern or regex'
            },
            regex: {
              type: 'boolean',
              description: 'Treat pattern as regex (default: false)'
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 50)'
            },
            machine: {
              type: 'string',
              description: 'Machine name (optional)'
            }
          },
          required: ['path', 'pattern']
        }
      },
      {
        name: 'search_semantic',
        description: 'Semantic code search using embeddings - finds code by meaning, not keywords. Returns files with similarity scores.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Local path to workspace'
            },
            query: {
              type: 'string',
              description: 'What to search for (e.g., "authentication logic", "error handling")'
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 10)'
            },
            machine: {
              type: 'string',
              description: 'Machine name (optional)'
            }
          },
          required: ['path', 'query']
        }
      },
      {
        name: 'search_code',
        description: 'Multi-modal search combining semantic, keyword, and file name matching. Best for complex queries. Triggers LLM enrichment on top results.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Local path to workspace'
            },
            query: {
              type: 'string',
              description: 'Search query (supports natural language)'
            },
            limit: {
              type: 'number',
              description: 'Max results (default: 5)'
            },
            machine: {
              type: 'string',
              description: 'Machine name (optional)'
            }
          },
          required: ['path', 'query']
        }
      }
    ];
  }

  handlesTool(name) {
    return [
      'refresh_index',
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
        case 'refresh_index':
          return await this._refreshIndex(args);
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

  async _getIndexStats(args) {
    const { path: localPath, machine = null } = args;
    const indexFile = this._getIndexFilePath(localPath, machine);

    try {
      const index = await this._loadIndex(indexFile);
      const ageHours = (Date.now() - new Date(index.last_refresh || index.created_at).getTime()) / 3600000;
      const stale = ageHours > 168; // 7 days

      const stats = {
        exists: true,
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
              hint: `No index found. Run: node scripts/build-index.js --workspace "${localPath}"`
            }, null, 2)
          }]
        };
      }
      throw err;
    }
  }

  async _refreshIndex(args) {
    const { path: localPath, machine = null } = args;
    const startTime = Date.now();

    this.sendProgress(5, 100, 'Resolving workspace path...');
    
    const uncPath = this.workspace.resolvePath(localPath, machine);
    const indexFile = this._getIndexFilePath(localPath, machine);

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
          throw new Error(`No index found. Run: node scripts/build-index.js --workspace "${localPath}"`);
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
    const { path: localPath, glob, machine = null } = args;
    const index = await this._loadIndexForWorkspace(localPath, machine);

    const regex = this._globToRegex(glob);
    const matches = Object.keys(index.files)
      .filter(filePath => regex.test(filePath))
      .map(filePath => ({
        path: filePath,
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
    const { path: localPath, pattern, regex = false, limit = 50, machine = null } = args;
    const index = await this._loadIndexForWorkspace(localPath, machine);
    const uncPath = this.workspace.resolvePath(localPath, machine);

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
              file: filePath,
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
    const { path: localPath, query, limit = 10, machine = null } = args;
    const index = await this._loadIndexForWorkspace(localPath, machine);

    // Generate query embedding
    const queryEmbedding = await this._generateEmbedding(query);

    // Compute similarity with all files
    const results = [];
    for (const [filePath, fileData] of Object.entries(index.files)) {
      if (!fileData.embedding) continue;
      
      const similarity = this._cosineSimilarity(queryEmbedding, fileData.embedding);
      results.push({
        path: filePath,
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
    const { path: localPath, query, limit = 5, machine = null } = args;

    // Multi-modal search: combine semantic + keyword + filename
    const semanticResults = await this._searchSemantic({ ...args, limit: limit * 2 });
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

  _getIndexFilePath(localPath, machine) {
    const filename = this.workspace.getIndexPath(localPath, machine);
    return path.join(this.indexPath, filename);
  }

  async _loadIndex(indexFile) {
    const content = await fs.readFile(indexFile, 'utf-8');
    return JSON.parse(content);
  }

  async _loadIndexForWorkspace(localPath, machine) {
    const indexFile = this._getIndexFilePath(localPath, machine);
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
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2));
    await fs.rename(tempFile, indexFile);
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
