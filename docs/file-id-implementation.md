# File ID System Implementation

## Overview
Replaced verbose "workspace:path" file identifiers with stable 32-character SHA256 hashes to improve LLM ergonomics and token efficiency.

## Changes Summary

### 1. Centralized Indexer (`src/servers/code-search/indexer.js`)
**New file** - 199 lines

Extracted common indexing utilities from build-index.js and server.js:
- `generateFileId(workspace, filePath)` - Creates 32-char SHA256 hash
- `parseFile(content, filePath)` - Extract functions, classes, imports
- `walkWorkspace(basePath, currentPath, files)` - Recursive directory scanning
- `generateEmbeddingText(filePath, tree)` - Build embedding input text
- `writeIndexStreaming(filePath, index)` - Stream large indexes to avoid "Invalid string length"
- `atomicWriteIndex(indexFile, data)` - Safe atomic writes
- `loadIndex(indexFile)` - Load index from disk
- `detectLanguage(filePath)` - File extension → language mapping

**Key Implementation**:
```javascript
export function generateFileId(workspace, filePath) {
  const fileKey = `${workspace}:${filePath}`;
  return createHash('sha256').update(fileKey).digest('hex').slice(0, 32);
}
```

### 2. Build Index Script (`src/servers/code-search/build-index.js`)
**Modified** - 449 → 285 lines (-164 lines, -37%)

Changes:
- Import centralized utilities from indexer.js
- Removed duplicate functions (parseFile, walkWorkspace, detectLanguage, writeIndexStreaming)
- Updated index structure to use file IDs as keys
- Each file entry now includes `id` field with 32-char hash

**New Index Structure**:
```json
{
  "files": {
    "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6": {
      "id": "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6",
      "path": "src/http-server.js",
      "content_hash": "...",
      "tree": {...},
      "embedding": [...]
    }
  }
}
```

### 3. Code Search Server (`src/servers/code-search/server.js`)
**Modified** - 895 → 789 lines (-106 lines, -12%)

Changes:
- Import centralized utilities from indexer.js
- Removed duplicate functions (detectLanguage, parseFile, walkWorkspace, writeIndexStreaming, atomicWriteIndex, loadIndex)
- Removed orphaned incomplete `loadIndexForWorkspace` at line 68
- Updated `refreshIndex()` to:
  - Generate file IDs for all files
  - Build path→ID map for existing files (backward compatibility)
  - Store files keyed by ID with both `id` and `path` fields
- Updated all search functions to:
  - Iterate `Object.values(index.files)` instead of `Object.entries()`
  - Return file IDs in results (not workspace:path format)
- Updated `getFileInfo()` to:
  - Accept both hash IDs and old "workspace:path" format
  - For hash IDs: search all workspaces to find matching file
  - For old format: generate hash ID and look up by ID or path (migration support)

**Tool Output Changes**:
- `search_files` → Returns `{ file: "a3f2b1...", language: "javascript", size: 12345 }`
- `search_keyword` → Returns `{ file: "a3f2b1...", line: 42, content: "...", language: "..." }`
- `search_semantic` → Returns `{ file: "a3f2b1...", similarity: 0.87, functions: [...], classes: [...] }`
- `get_file_info` → Accepts hash ID or workspace:path, returns full metadata with `id`, `workspace`, `path`

### 4. Local Agent (`src/servers/local-agent.js`)
**Modified** - 448 → 482 lines (+34 lines, +8%)

Changes:
- Updated `retrieveFile()` to accept both formats:
  - Hash ID: Call `get_file_info` to resolve workspace + path, then retrieve file
  - Old format: Use existing workspace.resolveFileId logic
- Return structure includes `workspace` and `path` for context

**New Behavior**:
```javascript
// Old format still works
retrieveFile({ file: "BADKID-DEV:src/file.js" })

// New format
retrieveFile({ file: "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6" })
// → Calls get_file_info(hash) → Gets workspace + path → Retrieves file
```

## Migration Strategy

### Backward Compatibility
All components handle both old and new formats:
- **Search tools**: Work with any index (old path-keyed or new ID-keyed)
- **get_file_info**: Accepts hash IDs or workspace:path
- **retrieve_file**: Accepts hash IDs or workspace:path
- **refreshIndex**: Migrates old indexes to new format incrementally

### Index Migration
Existing indexes are **automatically migrated** on first `refresh_index`:
1. Old index keyed by path: `{ "src/file.js": {...} }`
2. refreshIndex builds path→ID map: `{ "src/file.js": "a3f2b1..." }`
3. New entries use ID as key: `{ "a3f2b1...": { id: "a3f2b1...", path: "src/file.js", ... } }`
4. Search functions iterate by value, so work with both formats

No manual migration needed - just run `refresh_index` or `refresh_all_indexes`.

## Benefits

### Token Efficiency
- **Old**: `BADKID-DEV:mcp_server/src/servers/code-search/server.js` (56 chars)
- **New**: `a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6` (32 chars)
- **Savings**: 43% shorter for typical paths

### LLM Ergonomics
- Shorter IDs fit better in LLM responses
- No truncation issues ("BADKID-DEV:mcp_server/..." → "BADKID-DEV:...")
- Stable references (hash never changes for same workspace:path)

### Code Quality
- **Eliminated duplication**: 270 lines of shared code centralized
- **Single source of truth**: indexer.js for all indexing logic
- **Easier maintenance**: Changes to indexing logic only in one place

## Collision Safety

32-character SHA256 provides:
- **Collision probability**: ~0% for any realistic codebase size
- **Birthday paradox at 1M files**: 2.9 × 10⁻²⁹ (effectively zero)
- **Simple code**: No collision detection needed

Formula: P(collision) ≈ n² / (2 × 16³²) where n = number of files

## Testing

Run these commands to verify:
```bash
# Rebuild all indexes with new format
node src/servers/code-search/build-index.js --all --force

# Test search returns hash IDs
# (via MCP after server restart)
search_semantic({ workspace: "BADKID-DEV", query: "HTTP server" })
# → Returns files with 32-char hash IDs

# Test retrieve with hash ID
retrieve_file({ file: "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6" })
# → Returns file content with workspace and path context
```

## Implementation Details

### File ID Generation
- **Input**: `${workspace}:${path}` (e.g., "BADKID-DEV:src/file.js")
- **Algorithm**: SHA256 hash, first 32 hex characters
- **Output**: Stable, deterministic, collision-free identifier

### Index Structure Changes
**Before**:
```json
{
  "files": {
    "src/http-server.js": {
      "path": "src/http-server.js",
      "content_hash": "...",
      ...
    }
  }
}
```

**After**:
```json
{
  "files": {
    "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6": {
      "id": "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6",
      "path": "src/http-server.js",
      "content_hash": "...",
      ...
    }
  }
}
```

### Search Tool Updates
All search tools now return file IDs:
- `search_files` - Glob pattern matching
- `search_keyword` - Exact text/regex search
- `search_semantic` - Embedding-based semantic search
- `search_code` - Multi-modal search

**Example Output**:
```json
{
  "results": [
    {
      "file": "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6",
      "similarity": 0.87,
      "language": "javascript",
      "size": 12345,
      "functions": ["handleRequest", "sendResponse"],
      "classes": ["StreamableHTTPServerTransport"]
    }
  ]
}
```

## Performance Impact

- **Index building**: Same speed (hash generation is O(1) constant time)
- **Search**: Slightly faster (no workspace:path string construction)
- **File retrieval**: Extra lookup for hash IDs (one get_file_info call)
- **Index size**: ~32 bytes overhead per file (negligible)

## Future Improvements

1. **Workspace hint parameter**: Add optional workspace to retrieve_file to skip get_file_info lookup
2. **In-memory ID→path cache**: Speed up hash ID resolution
3. **Index version bump**: Change version to 3 to force full rebuild
4. **ID→path lookup table**: Separate index section for O(1) reverse lookups
