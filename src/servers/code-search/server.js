/**
 * Code Search Server - Fast semantic search for large codebases
 * Pure functional module using router architecture
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { WorkspaceResolver } from '../../lib/workspace.js';
import {
  generateFileId,
  detectLanguage,
  parseFile,
  walkWorkspace,
  generateEmbeddingText,
  writeIndexStreaming,
  atomicWriteIndex,
  loadIndex
} from './indexer.js';

// ========== PURE HELPERS ==========

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function getLineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function cosineSimilarity(a, b) {
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

function globToRegex(glob) {
  let pattern = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '\x00STARSTAR\x00')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\x00STARSTAR\x00/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i');
}

async function generateEmbedding(router, text, tree = null) {
  try {
    const embeddingText = generateEmbeddingText(text, tree);
    return await router.embedText(embeddingText, null);
  } catch (err) {
    console.warn('Embedding generation failed:', err.message);
    return new Array(768).fill(0);
  }
}

// ========== PROMPTS ==========

const PROMPTS = [
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

const PROMPT_NAMES = new Set(PROMPTS.map(p => p.name));

function getPrompt(name, args) {
  if (name === 'code-archaeology') {
    return {
      messages: [{
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
      }]
    };
  }

  if (name === 'find-similar-code') {
    return {
      messages: [{
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
      }]
    };
  }

  if (name === 'trace-dependency') {
    return {
      messages: [{
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

**Pro Tip:** Combine keyword precision with semantic understanding to catch both direct calls and conceptual dependencies.`
        }
      }]
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}

// ========== TOOLS ==========

const TOOLS = [
  {
    name: 'get_workspace_config',
    description: 'ALWAYS CALL FIRST before any code search operation - discovers available workspaces and their index status. Returns workspace names ("BADKID-DEV", "COOLKID-Work") required by ALL other search tools. Shows which workspaces are indexed and ready. File IDs returned by search tools use "workspace:path" format - pass these IDs directly to retrieve_file without modification. Example: "BADKID-DEV:src/file.js" → retrieve_file({ file: "BADKID-DEV:src/file.js" }).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'get_file_info',
    description: 'Get file metadata with LINE NUMBERS for functions/classes - CRITICAL for efficient partial retrieval. Does NOT return content. MANDATORY WORKFLOW: (1) search_semantic/keyword to find files, (2) get_file_info to see "parseToolCall at line 17", (3) retrieve_file(startLine=17, endLine=43) to fetch just that function. Skipping this wastes 10-500x tokens by retrieving entire files! Returns: functions[], classes[] (with line numbers), imports[], language, size.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File ID from search results (format: "workspace:path" e.g., "BADKID-DEV:src/http-server.js")' }
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
        workspace: { type: 'string', description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV", "COOLKID-Work")' }
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
        force: { type: 'boolean', description: 'Force full rebuild instead of incremental update (default: false)' }
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
        workspace: { type: 'string', description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")' }
      },
      required: ['workspace']
    }
  },
  {
    name: 'search_files',
    description: 'Find files by name/path using glob patterns - fastest file discovery. Returns ONLY file IDs, no content. PATTERNS: "*test*.js" (any test file), "src/**/*.ts" (all TS in src tree), "**/auth*" (auth files anywhere). WORKFLOW: (1) search_files to find candidates, (2) get_file_info for structure, (3) retrieve_file for content. USE WHEN: Know file name/path pattern, exploring directory structure. DON\'T USE: Searching code content (use search_keyword/semantic).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")' },
        glob: { type: 'string', description: 'Glob pattern: "*auth*.js" (files containing auth), "src/**/*.ts" (all TS in src), "**/*test*" (all test files)' }
      },
      required: ['workspace', 'glob']
    }
  },
  {
    name: 'search_keyword',
    description: 'Fast exact text/regex search - use when you know exact string. Returns file IDs + matching line excerpts. WHEN TO USE: Exact function names "handleRequest", variable references "authToken", error messages, TODOs, specific API calls. REGEX: Set regex=true for patterns like "async function \\w+" or "TODO|FIXME". DON\'T USE: Conceptual searches (use search_semantic), file structure (use get_file_info). Much faster than semantic search when you know exact terms!',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")' },
        pattern: { type: 'string', description: 'Search text or regex pattern (e.g., "StreamableHTTP", "async function \\w+", "TODO|FIXME")' },
        regex: { type: 'boolean', description: 'Treat pattern as regex (default: false). Enable for advanced patterns.' },
        limit: { type: 'number', description: 'Max results (default: 50)' }
      },
      required: ['workspace', 'pattern']
    }
  },
  {
    name: 'search_semantic',
    description: 'Find code by MEANING using AI embeddings - best for conceptual searches when you don\'t know exact keywords. Returns file IDs + similarity scores + function/class names (NO line numbers). WORKFLOW: (1) search_semantic("authentication logic"), (2) review results - functions array shows what\'s in each file, (3) get_file_info on promising files to get line numbers, (4) retrieve_file with partial retrieval. USE WHEN: Exploring unfamiliar codebase, searching by concept not name. DON\'T USE: Exact function/class names (use search_keyword), file names (use search_files).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")' },
        query: { type: 'string', description: 'Natural language description of what you\'re looking for (e.g., "WebSocket connection handling", "memory leak prevention")' },
        limit: { type: 'number', description: 'Max results (default: 10)' }
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
        workspace: { type: 'string', description: 'Workspace name from get_workspace_config (e.g., "BADKID-DEV")' },
        query: { type: 'string', description: 'Natural language search query - will search by meaning AND keywords' },
        limit: { type: 'number', description: 'Max results (default: 5)' }
      },
      required: ['workspace', 'query']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

// ========== FACTORY FUNCTION ==========

export function createCodeSearchServer(config, router) {
  const workspace = new WorkspaceResolver(config.workspaces || {});
  const indexPath = config.indexPath || 'data/indexes';
  let progressCallback = null;

  // In-memory index cache
  const indexCache = new Map();

  function sendProgress(progress, total, message) {
    if (progressCallback) {
      progressCallback({ progress, total, message });
    }
  }

  function getIndexFilePath(workspaceName) {
    return path.join(indexPath, `${workspaceName}.json`);
  }

  async function loadIndexForWorkspace(workspaceName) {
    // Return cached if available
    if (indexCache.has(workspaceName)) {
      return indexCache.get(workspaceName);
    }
    
    // Load from disk
    const indexFile = getIndexFilePath(workspaceName);
    const index = await loadIndex(indexFile);
    if (!index.files) {
      throw new Error('Invalid index: no files found');
    }
    
    // Cache it
    indexCache.set(workspaceName, index);
    return index;
  }

  function clearIndexCache(workspaceName = null) {
    if (workspaceName) {
      indexCache.delete(workspaceName);
    } else {
      indexCache.clear();
    }
  }

  async function reloadIndex(workspaceName) {
    clearIndexCache(workspaceName);
    return await loadIndexForWorkspace(workspaceName);
  }

  async function acquireIndexLock(indexFile) {
    try {
      const index = await loadIndex(indexFile);
      
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
      await atomicWriteIndex(indexFile, index);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error('Index does not exist. Run initial build first.');
      }
      throw err;
    }
  }

  async function releaseIndexLock(indexFile) {
    try {
      const index = await loadIndex(indexFile);
      index.build_in_progress = false;
      index.lock_acquired_at = null;
      await atomicWriteIndex(indexFile, index);
    } catch (err) {
      console.error('Failed to release lock:', err.message);
    }
  }

  // ========== TOOL HANDLERS ==========

  async function getWorkspaceConfig() {
    const indexDir = path.join(process.cwd(), 'data', 'indexes');
    let availableIndexes = [];
    try {
      const files = await fs.readdir(indexDir);
      availableIndexes = files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    } catch (err) {}
    
    const workspaces = workspace.getWorkspaces();
    
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
    
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  async function getIndexStats(args) {
    const { workspace: workspaceName } = args;
    const indexFile = getIndexFilePath(workspaceName);

    try {
      const index = await loadIndex(indexFile);
      const ageHours = (Date.now() - new Date(index.last_refresh || index.created_at).getTime()) / 3600000;
      const stale = ageHours > 168;

      const stats = {
        exists: true,
        workspace: workspaceName,
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
              workspace: workspaceName,
              hint: `No index found. Run: node scripts/build-index.js --workspace "${workspaceName}"`
            }, null, 2)
          }]
        };
      }
      throw err;
    }
  }

  async function getFileInfo(args) {
    const { file } = args;

    try {
      let workspaceName, fileData, filePath;

      // Try to parse as old format first (workspace:path)
      if (file.includes(':')) {
        const parsed = workspace.parseFileId(file);
        workspaceName = parsed.workspace;
        filePath = parsed.relativePath;
        
        const index = await loadIndexForWorkspace(workspaceName);
        
        // Look up by path (old index) or by generated ID (new index)
        const fileId = generateFileId(workspaceName, filePath);
        fileData = index.files[fileId] || index.files[filePath];
      } else {
        // New format: file is a hash ID
        // Need to search all workspaces to find which one contains this ID
        const workspaces = workspace.getWorkspaces();
        for (const ws of workspaces) {
          const index = await loadIndexForWorkspace(ws.name);
          if (index.files[file]) {
            workspaceName = ws.name;
            fileData = index.files[file];
            filePath = fileData.path;
            break;
          }
        }
      }

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

      const info = {
        file: fileData.id || file,
        workspace: workspaceName,
        path: filePath || fileData.path,
        language: fileData.language,
        size_bytes: fileData.size_bytes,
        functions: fileData.tree?.functions?.map(f => ({ name: f.name, line: f.line })) || [],
        classes: fileData.tree?.classes?.map(c => ({ name: c.name, line: c.line })) || [],
        imports: fileData.tree?.imports || [],
        exports: fileData.tree?.exports || [],
        last_indexed: fileData.last_indexed_at,
        enriched: !!fileData.enrichment
      };

      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: err.message, file }, null, 2)
        }]
      };
    }
  }

  async function refreshAllIndexes() {
    const workspaces = workspace.getWorkspaces();
    const results = [];
    
    sendProgress(0, workspaces.length, 'Starting refresh of all indexes...');
    
    for (let i = 0; i < workspaces.length; i++) {
      const { name } = workspaces[i];
      sendProgress(i, workspaces.length, `Refreshing ${name}...`);
      
      try {
        const result = await refreshIndex({ workspace: name });
        const parsed = JSON.parse(result.content[0].text);
        results.push({ workspace: name, status: 'success', ...parsed });
      } catch (err) {
        results.push({ workspace: name, status: 'error', error: err.message });
      }
    }
    
    sendProgress(workspaces.length, workspaces.length, 'Complete');
    
    const summary = {
      total: workspaces.length,
      success: results.filter(r => r.status === 'success').length,
      errors: results.filter(r => r.status === 'error').length,
      results
    };
    
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }

  async function refreshIndex(args) {
    const { workspace: workspaceName } = args;
    const startTime = Date.now();

    sendProgress(5, 100, 'Resolving workspace path...');
    
    const uncPath = workspace.getWorkspacePath(workspaceName);
    const indexFile = getIndexFilePath(workspaceName);

    const lockAcquired = await acquireIndexLock(indexFile);
    if (!lockAcquired) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'ALREADY_RUNNING' }, null, 2) }] };
    }

    try {
      sendProgress(10, 100, 'Loading existing index...');
      
      let index;
      try {
        index = await loadIndex(indexFile);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new Error(`No index found. Run: node scripts/build-index.js --workspace "${workspaceName}"`);
        }
        throw err;
      }

      sendProgress(20, 100, 'Scanning workspace...');

      const currentFiles = new Map();
      await walkWorkspace(uncPath, uncPath, currentFiles);

      sendProgress(40, 100, 'Computing changes...');

      const stats = {
        files_checked: currentFiles.size,
        files_updated: 0,
        files_added: 0,
        files_removed: 0
      };

      // Build path->id map for existing files
      const pathToId = new Map();
      for (const [fileId, fileData] of Object.entries(index.files)) {
        if (fileData.path) {
          pathToId.set(fileData.path, fileId);
        }
      }

      // Remove deleted files
      for (const [fileId, fileData] of Object.entries(index.files)) {
        const filePath = fileData.path || fileId; // Handle old format
        if (!currentFiles.has(filePath)) {
          delete index.files[fileId];
          stats.files_removed++;
        }
      }

      const toUpdate = [];
      for (const [filePath, metadata] of currentFiles) {
        const fileId = pathToId.get(filePath) || generateFileId(workspaceName, filePath);
        const existing = index.files[fileId];
        if (!existing || existing.mtime < metadata.mtime) {
          toUpdate.push({ filePath, fileId, metadata });
          if (existing) {
            stats.files_updated++;
          } else {
            stats.files_added++;
          }
        }
      }

      if (toUpdate.length > 0) {
        sendProgress(50, 100, `Processing ${toUpdate.length} changed files...`);
        
        for (let i = 0; i < toUpdate.length; i++) {
          const { filePath, fileId, metadata } = toUpdate[i];
          const progress = 50 + (i / toUpdate.length) * 40;
          sendProgress(progress, 100, `Processing ${i + 1}/${toUpdate.length}...`);

          try {
            const fullPath = path.join(uncPath, filePath);
            const content = await fs.readFile(fullPath, 'utf-8');
            const contentHash = hash(content);
            const tree = parseFile(content, filePath);
            const embedding = await generateEmbedding(router, filePath, tree);

            index.files[fileId] = {
              id: fileId,
              path: filePath,
              content_hash: contentHash,
              mtime: metadata.mtime,
              last_indexed_at: new Date().toISOString(),
              language: detectLanguage(filePath),
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

      index.file_count = currentFiles.size;
      index.last_refresh = new Date().toISOString();
      stats.duration_ms = Date.now() - startTime;

      sendProgress(95, 100, 'Writing index...');
      await atomicWriteIndex(indexFile, index);
      await releaseIndexLock(indexFile);

      sendProgress(98, 100, 'Reloading index into memory...');
      await reloadIndex(workspaceName);

      sendProgress(100, 100, 'Complete');

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', ...stats }, null, 2) }] };
    } catch (err) {
      await releaseIndexLock(indexFile);
      throw err;
    }
  }

  async function searchFiles(args) {
    const { workspace: workspaceName, glob } = args;
    const index = await loadIndexForWorkspace(workspaceName);

    const regex = globToRegex(glob);
    const matches = Object.values(index.files)
      .filter(fileData => regex.test(fileData.path))
      .map(fileData => ({
        file: fileData.id,
        language: fileData.language,
        size: fileData.size_bytes
      }));

    return { content: [{ type: 'text', text: JSON.stringify({ matches, count: matches.length }, null, 2) }] };
  }

  async function searchKeyword(args) {
    const { workspace: workspaceName, pattern, regex: useRegex = false, limit = 50 } = args;
    const index = await loadIndexForWorkspace(workspaceName);
    const uncPath = workspace.getWorkspacePath(workspaceName);

    const searchRegex = useRegex ? new RegExp(pattern, 'gi') : null;
    const matches = [];

    for (const fileData of Object.values(index.files)) {
      if (matches.length >= limit) break;

      try {
        const fullPath = path.join(uncPath, fileData.path);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const match = useRegex ? searchRegex.test(lines[i]) : lines[i].includes(pattern);
          if (match) {
            const trimmed = lines[i].trim();
            matches.push({
              file: fileData.id,
              line: i + 1,
              content: trimmed.length > 120 ? trimmed.slice(0, 120) + '...' : trimmed,
              language: fileData.language
            });
            if (matches.length >= limit) break;
          }
        }
      } catch (err) {}
    }

    return { content: [{ type: 'text', text: JSON.stringify({ matches, count: matches.length }, null, 2) }] };
  }

  async function searchSemantic(args) {
    const { workspace: workspaceName, query, limit = 10 } = args;
    const index = await loadIndexForWorkspace(workspaceName);

    const queryEmbedding = await generateEmbedding(router, query);

    const results = [];
    for (const fileData of Object.values(index.files)) {
      if (!fileData.embedding) continue;
      
      const similarity = cosineSimilarity(queryEmbedding, fileData.embedding);
      results.push({
        file: fileData.id,
        similarity,
        language: fileData.language,
        size: fileData.size_bytes,
        functions: fileData.tree?.functions?.map(f => f.name) || [],
        classes: fileData.tree?.classes?.map(c => c.name) || []
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, limit);

    return { content: [{ type: 'text', text: JSON.stringify({ results: topResults, count: topResults.length }, null, 2) }] };
  }

  async function searchCode(args) {
    const { workspace: workspaceName, query, limit = 5 } = args;

    const semanticResults = await searchSemantic({ workspace: workspaceName, query, limit: limit * 2 });
    const semantic = JSON.parse(semanticResults.content[0].text).results;

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

  // ========== PUBLIC API ==========

  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    
    getPrompts: () => PROMPTS,
    handlesPrompt: name => PROMPT_NAMES.has(name),
    getPrompt: (name, args) => getPrompt(name, args),
    
    async callTool(name, args) {
      try {
        if (name === 'get_workspace_config') return await getWorkspaceConfig();
        if (name === 'get_file_info') return await getFileInfo(args);
        if (name === 'refresh_index') return await refreshIndex(args);
        if (name === 'refresh_all_indexes') return await refreshAllIndexes();
        if (name === 'get_index_stats') return await getIndexStats(args);
        if (name === 'search_files') return await searchFiles(args);
        if (name === 'search_keyword') return await searchKeyword(args);
        if (name === 'search_semantic') return await searchSemantic(args);
        if (name === 'search_code') return await searchCode(args);
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: err.message, code: err.code || 'SEARCH_ERROR' }, null, 2)
          }]
        };
      }
    },
    
    setProgressCallback: (callback) => { progressCallback = callback; },
    
    // Cache management functions
    clearCache: clearIndexCache,
    reloadIndex,
    
    cleanup: async () => {}
  };
}

// Keep old export for backward compatibility during migration
export { createCodeSearchServer as CodeSearchServer };
