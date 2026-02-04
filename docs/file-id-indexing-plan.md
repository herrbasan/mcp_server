# File ID-Based Indexing Refactor Plan

**Status**: Planned - To be implemented after centralizing index building code

## Problem
Currently, LLMs must use full file paths like `"BADKID-DEV:mcp_server/src/http-server.js"` which are:
- Long and error-prone to copy
- Easy to mistype/abbreviate
- Inconsistent across different contexts

## Solution
Add **persistent, stable file IDs** to the index that are short and unambiguous.

## Current Architecture Issues
1. **Duplicate indexing logic**: 
   - `scripts/build-index.js` - Initial index creation
   - `src/servers/code-search/server.js:refreshIndex()` - Incremental updates
   - Same logic in two places = maintenance burden

2. **No shared indexing utilities**: Each implements its own:
   - File walking
   - Metadata extraction
   - Tree parsing
   - Embedding generation
   - Index structure creation

## Step 1: Centralize Indexing Code

### Create `src/servers/code-search/indexer.js`
Shared module with:
```javascript
export class Indexer {
  constructor(router, workspace) { ... }
  
  // Core indexing functions
  async indexFile(filePath, existingHash) { ... }
  async walkWorkspace(basePath) { ... }
  async generateEmbedding(content, metadata) { ... }
  parseFileTree(content, language) { ... }
  
  // ID generation
  generateFileId(workspace, relativePath) {
    // Stable hash: "a3f2b1" (6 chars)
    const str = `${workspace}:${relativePath}`;
    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 6);
  }
}
```

### Update Both Indexing Paths
1. **build-index.js**: Use `Indexer` class
2. **refreshIndex()**: Use `Indexer` class
3. **Same logic everywhere**: No drift, easier maintenance

## Step 2: Add File IDs to Index

### Index Structure Changes
```javascript
// OLD
index.files = {
  "src/http-server.js": { path: "src/http-server.js", ... }
}

// NEW
index.files = {
  "a3f2b1": {
    id: "a3f2b1",
    workspace: "BADKID-DEV",
    path: "src/http-server.js",
    file: "BADKID-DEV:src/http-server.js",  // Keep for compatibility
    // ... rest of metadata
  }
}

// Add reverse lookup
index.fileIdMap = {
  "BADKID-DEV:src/http-server.js": "a3f2b1",
  "src/http-server.js": "a3f2b1"  // Also map relative path
}
```

### ID Properties
- **Stable**: Same file = same ID across sessions
- **Short**: 6 hex chars = ~16M unique IDs per workspace
- **Deterministic**: Hash of `${workspace}:${path}`
- **Unique**: Collision chance negligible for typical projects

## Step 3: Update All Tools to Use IDs

### Code Search Tools
```javascript
// search_files, search_semantic, search_keyword
return {
  matches: [{
    id: "a3f2b1",  // PRIMARY identifier
    file: "BADKID-DEV:src/http-server.js",  // Keep for backward compat
    path: "src/http-server.js",
    // ... other fields
  }]
}

// get_file_info
return {
  id: "a3f2b1",
  file: "BADKID-DEV:src/http-server.js",
  // ... metadata
}

// retrieve_file - Accept BOTH
async function retrieveFile(args) {
  const fileRef = args.file || args.id;  // Accept both
  const fileId = resolveToFullPath(fileRef);  // ID → full path
  // ... retrieve logic
}

function resolveToFullPath(input) {
  // If it's a 6-char hex ID, lookup in index
  if (/^[a-f0-9]{6}$/i.test(input)) {
    return index.files[input]?.file;
  }
  // Otherwise assume it's already a full path
  return input;
}
```

### Local Agent Changes
```javascript
// Step 1: Metadata includes IDs
const metadata = fileInfos.map(f => ({
  id: f.id,  // "a3f2b1"
  path: f.path,  // "src/http-server.js" (for readability)
  functions: f.functions,
  // ...
}));

// Step 2: Planning prompt
const planningPrompt = `...
Use file IDs from metadata (e.g., "a3f2b1") - short and unambiguous.

Example plan:
[
  { "file": "a3f2b1", "startLine": 10, "endLine": 50, "reason": "..." }
]
`;

// Step 3: Retrieval maps ID → full path
const chunks = await Promise.all(
  plan.map(item => {
    const fullPath = index.files[item.file]?.file;
    return codeSearch.callTool('retrieve_file', {
      file: fullPath,
      startLine: item.startLine,
      endLine: item.endLine
    });
  })
);
```

## Benefits

### For LLMs
- **Easy to reference**: "a3f2b1" vs "BADKID-DEV:mcp_server/src/http-server.js"
- **No typos**: Short hex strings are unambiguous
- **Token efficient**: 6 chars vs 40+ chars

### For System
- **Stable references**: IDs don't change even if file moves (within workspace)
- **Faster lookups**: Direct hash map access
- **Cleaner APIs**: Tools accept simple IDs

### For Maintenance
- **Single indexing codebase**: No duplicate logic
- **Easier testing**: Shared utilities
- **Consistent behavior**: Same code = same results

## Migration Strategy

1. **Phase 1**: Centralize indexing code (no breaking changes)
   - Extract `Indexer` class
   - Update `build-index.js` to use it
   - Update `refreshIndex` to use it
   - Test that indexes are identical

2. **Phase 2**: Add IDs to index (backward compatible)
   - Add `id` field to file entries
   - Add `fileIdMap` reverse lookup
   - Keep existing `file` paths
   - All tools return BOTH id and file path

3. **Phase 3**: Update tools to accept IDs
   - `retrieve_file` accepts ID or path
   - Other tools accept ID or path
   - Planning prompt uses IDs
   - Full backward compatibility

4. **Phase 4**: Deprecate path-only usage (optional)
   - Prefer IDs in examples
   - Update documentation
   - Eventually remove path-only support

## Files to Modify

### Core Indexing
- [ ] `src/servers/code-search/indexer.js` (NEW - shared utilities)
- [ ] `scripts/build-index.js` (use Indexer)
- [ ] `src/servers/code-search/server.js` (use Indexer in refreshIndex)

### Tools
- [ ] `src/servers/code-search/server.js` (return IDs, accept IDs)
- [ ] `src/servers/local-agent.js` (use IDs in planning)

### Index Format
- [ ] Add migration for existing indexes (add IDs to existing entries)

## Testing Plan

1. **Unit tests**: ID generation (deterministic, unique)
2. **Integration tests**: Build index with IDs
3. **Backward compat**: Old clients still work with full paths
4. **Agent tests**: Planning with IDs works correctly

## Timeline Estimate

- Centralize indexing: ~2-4 hours
- Add IDs to index: ~1-2 hours
- Update tools: ~2-3 hours
- Testing: ~1-2 hours
- **Total: ~6-11 hours**

## Notes

- Keep this plan until implementation
- IDs should be lowercase hex for consistency
- Consider adding `createdAt` timestamp to track when ID was first assigned
- May want to track file renames (same ID, new path) in future
