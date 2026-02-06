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
          text: `Let's investigate how "${args.feature}" is implemented in workspace "${args.workspace}":

**Creative Multi-Tool Workflow:**

1. **First, explore structure** (if unfamiliar):
   \`get_file_tree({workspace: "${args.workspace}", max_depth: 2})\`
   
2. **Semantic Discovery** - Find conceptually related code:
   \`search_semantic({workspace: "${args.workspace}", query: "${args.feature} implementation patterns", limit: 15})\`

3. **Keyword Validation** - Verify with exact matches:
   \`search_keyword({workspace: "${args.workspace}", pattern: "${args.feature}", limit: 30})\`

4. **File Pattern Analysis** - Look for naming conventions:
   \`search_files({workspace: "${args.workspace}", glob: "**/*${args.feature.toLowerCase().replace(/\s+/g, '-')}*"})\`

5. **Retrieve Key Files** - Get full source for top 3 semantic matches:
   Use \`retrieve_file\` with the hash IDs from search results

**Workspaces are network shares** - "${args.workspace}" is a mounted share. Use get_file_tree to explore its folder structure first.`
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

const TOOLS = [
  {
    name: 'get_workspace_config',
    description: 'List available workspaces. Scope: external projects only.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_file_info',
    description: 'Get function/class line numbers from hash ID. Use BEFORE retrieve_file.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: '32-char hash ID' } }, required: ['file'] }
  },
  {
    name: 'refresh_index',
    description: 'Update index after code changes',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' } }, required: ['workspace'] }
  },
  {
    name: 'refresh_all_indexes',
    description: 'Update all workspace indexes',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } }
  },
  {
    name: 'get_index_stats',
    description: 'Check index health',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' } }, required: ['workspace'] }
  },
  {
    name: 'search_files',
    description: 'Find files by glob pattern. Scope: external workspaces only.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, glob: { type: 'string', description: 'e.g., src/**/*.js' } }, required: ['workspace', 'glob'] }
  },
  {
    name: 'search_keyword',
    description: 'Text search. Scope: external workspaces only. Use regex=true for patterns.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, pattern: { type: 'string' }, regex: { type: 'boolean' }, limit: { type: 'number' } }, required: ['workspace', 'pattern'] }
  },
  {
    name: 'search_semantic',
    description: 'Semantic search by meaning. Returns hash IDs. Omit workspace to search ALL. Scope: external workspaces only.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
  },
  {
    name: 'search_code',
    description: 'Combined semantic + keyword search',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
  },
  {
    name: 'peek_file',
    description: 'Quick file preview (first N lines)',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, workspace: { type: 'string' }, max_lines: { type: 'number' } }, required: ['query'] }
  },
  {
    name: 'get_context',
    description: 'Get lines around specific line number',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'hash ID' }, line: { type: 'number' }, radius: { type: 'number', description: 'lines before/after' }, workspace: { type: 'string' } }, required: ['file', 'line'] }
  },
  {
    name: 'get_file_tree',
    description: 'Explore directory structure',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, path: { type: 'string' }, max_depth: { type: 'number' } } }
  },
  {
    name: 'get_function_tree',
    description: 'Get function/class outline',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'hash ID' }, workspace: { type: 'string' } }, required: ['file'] }
  },
  {
    name: 'retrieve_file',
    description: 'Get file content by hash ID. Use startLine/endLine for partial read. Scope: external workspaces only.',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'hash ID' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['file'] }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

export function createCodeSearchServer(config, router) {
  const workspace = new WorkspaceResolver(config.workspaces || {});
  const indexPath = config.indexPath || 'data/indexes';
  let progressCallback = null;

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
    if (indexCache.has(workspaceName)) {
      return indexCache.get(workspaceName);
    }
    
    const indexFile = getIndexFilePath(workspaceName);
    const index = await loadIndex(indexFile);
    if (!index.files) {
      throw new Error('Invalid index: no files found');
    }
    
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
        retrieve: "mcp_orchestrator_retrieve_file({ file: 'a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6' })",
        note: "Search returns 32-char hash file IDs - pass these directly to retrieve_file and get_file_info"
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
    
    // If workspace specified, search there; otherwise search all workspaces
    const workspacesToSearch = workspaceName 
      ? [workspaceName]
      : Object.keys(config.workspaces || {});
    
    const searchRegex = useRegex ? new RegExp(pattern, 'gi') : null;
    const matches = [];

    for (const ws of workspacesToSearch) {
      if (matches.length >= limit) break;
      
      try {
        const index = await loadIndexForWorkspace(ws);
        const uncPath = workspace.getWorkspacePath(ws);

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
                  language: fileData.language,
                  workspace: ws
                });
                if (matches.length >= limit) break;
              }
            }
          } catch (err) {}
        }
      } catch (err) {
        console.warn(`[searchKeyword] Failed to search workspace ${ws}:`, err.message);
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ matches, count: matches.length }, null, 2) }] };
  }

  async function searchSemantic(args) {
    const { workspace: workspaceName, query, limit = 10 } = args;
    
    // If workspace specified, search there; otherwise search all workspaces
    const workspacesToSearch = workspaceName 
      ? [workspaceName]
      : Object.keys(config.workspaces || {});
    
    const allResults = [];
    
    for (const ws of workspacesToSearch) {
      try {
        const index = await loadIndexForWorkspace(ws);

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
            workspace: ws,
            functions: fileData.tree?.functions?.map(f => f.name) || [],
            classes: fileData.tree?.classes?.map(c => c.name) || []
          });
        }

        allResults.push(...results);
      } catch (err) {
        console.warn(`[searchSemantic] Failed to search workspace ${ws}:`, err.message);
      }
    }

    allResults.sort((a, b) => b.similarity - a.similarity);
    const topResults = allResults.slice(0, limit);

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

  async function peekFile(args) {
    const { query, workspace: workspaceName, max_lines = 50 } = args;
    
    // If workspace specified, search there; otherwise search all
    const workspacesToSearch = workspaceName 
      ? [workspaceName]
      : Object.keys(config.workspaces || {});
    
    let bestMatch = null;
    
    // Try exact file match first (fast path)
    for (const ws of workspacesToSearch) {
      try {
        const index = await loadIndexForWorkspace(ws);
        
        // Check for exact filename match
        for (const fileData of Object.values(index.files)) {
          if (fileData.path.endsWith(query) || fileData.path.includes(query)) {
            bestMatch = { ...fileData, workspace: ws };
            break;
          }
        }
        if (bestMatch) break;
      } catch (e) {}
    }
    
    // If no exact match, try semantic search
    if (!bestMatch) {
      for (const ws of workspacesToSearch) {
        try {
          const semanticResults = await searchSemantic({ workspace: ws, query, limit: 1 });
          const results = JSON.parse(semanticResults.content[0].text).results;
          if (results.length > 0) {
            const index = await loadIndexForWorkspace(ws);
            bestMatch = { ...index.files[results[0].file], workspace: ws };
            break;
          }
        } catch (e) {}
      }
    }
    
    if (!bestMatch) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `No file found for query: "${query}"` }) }] };
    }
    
    // Retrieve file content
    try {
      const uncPath = workspace.getWorkspacePath(bestMatch.workspace);
      const fullPath = path.join(uncPath, bestMatch.path);
      const content = await fs.readFile(fullPath, 'utf-8');
      const lines = content.split('\n');
      const preview = lines.slice(0, max_lines).join('\n');
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            file_id: bestMatch.id,
            path: bestMatch.path,
            workspace: bestMatch.workspace,
            total_lines: lines.length,
            preview_lines: Math.min(max_lines, lines.length),
            content: preview
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Failed to read file: ${err.message}` }) }] };
    }
  }

  async function getContext(args) {
    const { file, line, radius = 20, workspace: workspaceName } = args;
    
    // Resolve file ID to path
    let fileId, filePath, wsName;
    
    if (file.includes(':')) {
      const parsed = workspace.parseFileId(file);
      wsName = parsed.workspace;
      filePath = parsed.relativePath;
      const index = await loadIndexForWorkspace(wsName);
      const match = Object.values(index.files).find(f => f.path === filePath);
      if (!match) throw new Error(`File not found: ${file}`);
      fileId = match.id;
    } else if (/^[a-f0-9]{32}$/i.test(file)) {
      // Hash ID
      fileId = file;
      // Find which workspace has this file
      for (const ws of Object.keys(config.workspaces || {})) {
        try {
          const index = await loadIndexForWorkspace(ws);
          if (index.files[fileId]) {
            wsName = ws;
            filePath = index.files[fileId].path;
            break;
          }
        } catch (e) {}
      }
      if (!wsName) throw new Error(`File ID not found: ${file}`);
    } else {
      throw new Error('Invalid file ID format');
    }
    
    // Read file and extract context
    const uncPath = workspace.getWorkspacePath(wsName);
    const fullPath = path.join(uncPath, filePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    
    const targetLine = Math.max(1, Math.min(line, lines.length));
    
    let startLine, endLine;
    
    if (radius === 'function') {
      // Find enclosing function boundaries
      const index = await loadIndexForWorkspace(wsName);
      const fileData = index.files[fileId];
      
      if (fileData.tree?.functions) {
        const enclosingFunc = fileData.tree.functions.find(f => 
          f.line <= targetLine && (!f.endLine || f.endLine >= targetLine)
        );
        
        if (enclosingFunc) {
          startLine = enclosingFunc.line;
          endLine = enclosingFunc.endLine || enclosingFunc.line + 50;
        }
      }
    }
    
    // Default to radius if function mode didn't find anything
    if (!startLine) {
      startLine = Math.max(1, targetLine - radius);
      endLine = Math.min(lines.length, targetLine + radius);
    }
    
    const contextLines = lines.slice(startLine - 1, endLine);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          file_id: fileId,
          path: filePath,
          workspace: wsName,
          target_line: targetLine,
          context_range: { start: startLine, end: endLine },
          content: contextLines.join('\n')
        }, null, 2)
      }]
    };
  }

  async function getFileTree(args) {
    const { workspace: workspaceName, path: subPath = '', max_depth = 3 } = args;
    
    // Normalize subPath to use forward slashes for consistent matching
    const normalizedSubPath = subPath ? subPath.replace(/\\/g, '/') : '';
    // Ensure subPath doesn't end with slash for consistent slicing
    const trimSubPath = normalizedSubPath.replace(/\/$/, '');
    
    const workspacesToGet = workspaceName 
      ? [workspaceName]
      : Object.keys(config.workspaces || {});
    
    const result = {};
    
    for (const ws of workspacesToGet) {
      try {
        const index = await loadIndexForWorkspace(ws);
        const tree = {};
        let matchedFileCount = 0;
        
        for (const fileData of Object.values(index.files)) {
          // Normalize file path to forward slashes
          const filePath = fileData.path.replace(/\\/g, '/');
          
          if (trimSubPath) {
            // Check if file is inside the subdirectory (must start with subpath/)
            if (!filePath.startsWith(trimSubPath + '/')) continue;
          }
          
          matchedFileCount++;
          
          const relativePath = trimSubPath ? filePath.slice(trimSubPath.length + 1) : filePath;
          if (!relativePath) continue;
          
          const parts = relativePath.split(/[\\/]/).filter(p => p);
          if (parts.length === 0) continue;
          
          let current = tree;
          for (let i = 0; i < parts.length && i < max_depth; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;
            
            if (isFile) {
              current[part] = { type: 'file', id: fileData.id, size: fileData.size_bytes };
            } else {
              if (!current[part]) current[part] = { type: 'directory', children: {} };
              current = current[part].children;
            }
          }
        }
        
        result[ws] = {
          path: subPath || 'root',
          tree,
          file_count: matchedFileCount
        };
      } catch (err) {
        result[ws] = { error: err.message };
      }
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }]
    };
  }

  async function getFunctionTree(args) {
    const { file, workspace: workspaceName } = args;
    
    let fileId, filePath, wsName;
    
    if (file.includes(':')) {
      // Old format: workspace:path
      const parsed = workspace.parseFileId(file);
      wsName = parsed.workspace;
      filePath = parsed.relativePath;
      const index = await loadIndexForWorkspace(wsName);
      const match = Object.values(index.files).find(f => f.path === filePath);
      if (!match) throw new Error(`File not found: ${file}`);
      fileId = match.id;
    } else if (/^[a-f0-9]{32}$/i.test(file)) {
      fileId = file;
      for (const ws of Object.keys(config.workspaces || {})) {
        try {
          const index = await loadIndexForWorkspace(ws);
          if (index.files[fileId]) {
            wsName = ws;
            filePath = index.files[fileId].path;
            break;
          }
        } catch (e) {}
      }
      if (!wsName) throw new Error(`File ID not found: ${file}`);
    } else {
      throw new Error('Invalid file ID format');
    }
    
    const index = await loadIndexForWorkspace(wsName);
    const fileData = index.files[fileId];
    
    if (!fileData) {
      throw new Error(`File data not found for ID: ${fileId}`);
    }
    
    const functions = fileData.tree?.functions?.map(f => ({
      name: f.name,
      line: f.line,
      signature: f.signature || null
    })) || [];
    
    const classes = fileData.tree?.classes?.map(c => ({
      name: c.name,
      line: c.line,
      methods: c.methods?.map(m => ({ name: m.name, line: m.line })) || []
    })) || [];
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          file_id: fileId,
          path: filePath,
          workspace: wsName,
          language: fileData.language,
          functions,
          classes,
          imports: fileData.tree?.imports?.map(i => i.module) || []
        }, null, 2)
      }]
    };
  }

  async function retrieveFile(args) {
    const { file, startLine, endLine } = args;

    try {
      let fileId, filePath, wsName, uncPath;

      if (file.includes(':')) {
        const parsed = workspace.parseFileId(file);
        wsName = parsed.workspace;
        filePath = parsed.relativePath;
        uncPath = workspace.getWorkspacePath(wsName);
        fileId = null; // Will be resolved from index
      } else if (/^[a-f0-9]{32}$/i.test(file)) {
        fileId = file;
        // Find which workspace has this file
        for (const ws of Object.keys(config.workspaces || {})) {
          try {
            const idx = await loadIndexForWorkspace(ws);
            if (idx.files[fileId]) {
              wsName = ws;
              filePath = idx.files[fileId].path;
              const workspacePath = workspace.getWorkspacePath(wsName);
              uncPath = path.join(workspacePath, filePath);
              break;
            }
          } catch (e) {}
        }
        if (!wsName) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: `File ID not found: ${file}`, hint: 'The file may not be indexed. Try running refresh_index first.' }),
              isError: true
            }]
          };
        }
      } else {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Invalid file ID format. Use 32-char hash or "workspace:path" format' }),
            isError: true
          }]
        };
      }

      await workspace.validatePath(uncPath, wsName);

      const content = await fs.readFile(uncPath, 'utf-8');
      const lines = content.split('\n');

      const actualStart = startLine ? Math.max(1, startLine) : 1;
      const actualEnd = endLine ? Math.min(lines.length, endLine) : lines.length;

      const selectedLines = lines.slice(actualStart - 1, actualEnd);
      const resultContent = selectedLines.join('\n');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            file_id: fileId || file,
            workspace: wsName,
            path: filePath,
            total_lines: lines.length,
            retrieved_lines: selectedLines.length,
            start_line: actualStart,
            end_line: actualEnd,
            size: resultContent.length,
            content: resultContent
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            code: err.code || 'RETRIEVE_ERROR',
            file
          }, null, 2)
        }],
        isError: true
      };
    }
  }

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
        if (name === 'peek_file') return await peekFile(args);
        if (name === 'get_context') return await getContext(args);
        if (name === 'get_file_tree') return await getFileTree(args);
        if (name === 'get_function_tree') return await getFunctionTree(args);
        if (name === 'retrieve_file') return await retrieveFile(args);
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
    
    clearCache: clearIndexCache,
    reloadIndex,
    
    cleanup: async () => {}
  };
}

export { createCodeSearchServer as CodeSearchServer };
