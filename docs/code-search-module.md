# Code Search Module

**Module**: `src/servers/code-search.js`
**Updated**: February 1, 2026

## Design Principles

1. **Robustness over performance** - Index corruption must be impossible, stale data is acceptable
2. **LLM-maintainable code** - Explicit file I/O, no ORMs, simple JSON storage
3. **Atomic operations** - Write temp file + rename, never partial writes
4. **Graceful degradation** - Search works without enrichment, enrichment works without LLM

## Summary

Code search for large codebases (100k+ files). Fast base index via tree-sitter + embeddings. LLM enrichment is query-driven, not upfront.

## Workspace Integration

Indexes are scoped to workspaces defined in the shared `workspaces` config:

```json
{
  "workspaces": {
    "machines": {
      "COOLKID": {
        "D:\\Work": "\\\\COOLKID\\Work",
        "D:\\DEV": "\\\\COOLKID\\DEV"
      }
    }
  }
}
```

Local paths are resolved to UNC paths for file access. Index stored on MCP server at:
`data/indexes/{machine}-{share-name}.json`

**Path Resolution**: Shared utility in `src/lib/workspace.js` handles translation from client local paths to server-accessible UNC paths. Same resolver used by Local Agent module.

See [Local Agent Module](local-agent-module.md) for path resolution algorithm and edge case handling.

## Architecture

### Base Index (Fast, Automatic)

**Phase 1: Tree-sitter Parsing** (~50ms/file)
- Extract: functions, classes, imports, exports, comments
- Build dependency graph from import/export relationships

**Phase 2: Semantic Embedding** (~14ms/file)
- Embed structured metadata: `path + symbols + imports + comments`
- 768-dim vectors for similarity search

**Performance**: 100k files in ~20 minutes

### LLM Enrichment (On-Demand)

Triggered when file appears in search results. NOT part of automatic indexing.

**What it adds**: description, keywords, inferred relationships, confidence score

**Debounce rules**:
- Skip if `now - last_enriched_at < 10 minutes`
- Invalidate if `content_hash` changed since last enrichment
- Stale-while-revalidate: serve cached, refresh in background

**Result**: Only files users actually query get enriched. Most files never touched.

### Index Entry

```javascript
{
  // Base index (always present)
  path: string,               // Relative to workspace root
  content_hash: string,       // SHA-256, for invalidation
  mtime: number,              // File mtime at indexing (ms since epoch)
  last_indexed_at: string,    // ISO timestamp
  language: string,
  size_bytes: number,         // File size for filtering
  tree: {
    functions: [{ name, params, line, end_line, exported }],
    classes: [{ name, methods, line, extends }],
    imports: [{ module, specifiers }],
    exports: string[],
    comments: string[]
  },
  embedding: number[],        // 768-dim
  parse_failed: boolean,      // True if tree-sitter failed (regex fallback used)

  // Enrichment (optional, query-driven)
  enrichment?: {
    last_enriched_at: string,
    content_hash_at_enrichment: string,
    description: string,
    keywords: string[],
    relationships: [{ module, type, reason }],
    confidence: number
  }
}
```

### Index Metadata (Top-Level)

```javascript
{
  version: 2,                    // Schema version for migrations
  workspace: string,             // UNC path to workspace root
  created_at: string,            // ISO timestamp
  last_full_build: string,       // ISO timestamp of last build_index
  last_refresh: string,          // ISO timestamp of last refresh_index
  file_count: number,
  total_size_bytes: number,
  build_in_progress: boolean,    // Lock flag
  files: { [path: string]: IndexEntry }
}
```

## Concurrency & Atomicity

### Write Operations

**Atomic write pattern** (used for ALL index writes):

```javascript
async function atomicWriteIndex(indexPath, data) {
  const tempPath = indexPath + '.tmp.' + Date.now();
  await fs.writeFile(tempPath, JSON.stringify(data));
  await fs.rename(tempPath, indexPath);  // Atomic on same filesystem
}
```

### Concurrent Access

| Scenario | Handling |
|----------|----------|
| Two `refresh_index` calls simultaneously | First one wins (check `build_in_progress` flag). Second returns `{ status: 'ALREADY_RUNNING' }` |
| `refresh_index` during `build_index` | Reject with `{ error: 'FULL_BUILD_IN_PROGRESS' }` |
| Search during refresh | Allowed - search uses in-memory snapshot, refresh writes atomically |
| Crash during write | Temp file orphaned, index file untouched. Cleanup temp files on startup. |

### Lock Implementation

```javascript
async acquireIndexLock(indexPath) {
  const index = await this.loadIndex(indexPath);
  if (index.build_in_progress) {
    const lockAge = Date.now() - new Date(index.lock_acquired_at).getTime();
    if (lockAge > 30 * 60 * 1000) {  // 30 min stale lock
      console.warn('Breaking stale index lock');
    } else {
      return false;  // Lock held
    }
  }
  index.build_in_progress = true;
  index.lock_acquired_at = new Date().toISOString();
  await atomicWriteIndex(indexPath, index);
  return true;
}

async releaseIndexLock(indexPath) {
  const index = await this.loadIndex(indexPath);
  index.build_in_progress = false;
  index.lock_acquired_at = null;
  await atomicWriteIndex(indexPath, index);
}
```

## Tools (5 MCP + 1 CLI)

**CLI Only**:
- `build_index` - Full index creation (tree-sitter + embeddings). Takes ~20-30min for large codebases. Run via `node scripts/build-index.js --workspace "path"`

**MCP Tools**:
1. `refresh_index` - Incremental update (re-indexes only changed files based on mtime). Fast: seconds, not minutes.
2. `get_index_stats` - Health metrics, staleness info, file count

**Search**:
3. `search_files` - Glob pattern matching
4. `search_keyword` - Ripgrep exact/regex
5. `search_semantic` - Vector similarity
6. `search_code` - Multi-modal search, triggers enrichment on top results

**Rationale**: Full indexing is a heavyweight operation (20+ min) that shouldn't be triggered by LLM. Incremental refresh is fast and safe for LLM to call after making changes to a codebase.

## Performance Targets

| Metric | Target |
|--------|--------|
| Base index (100k files) | <30 min |
| Incremental update | <2 min |
| Semantic search | <1s |
| Search + enrichment (cold) | <5s |
| Search + enrichment (cached) | <1s |

## Dependencies

- `tree-sitter` + language grammars
- `ripgrep` (external)
- LM Studio (embeddings + enrichment)

## Edge Cases (Exhaustive)

| Case | Detection | Handling |
|------|-----------|----------|
| Syntax errors | tree-sitter parse fails | Regex fallback, set `parse_failed: true` |
| Binary files | Magic bytes check (first 8KB) | Skip, do not index |
| Symlink loops | Track visited inodes during walk | Skip, log warning |
| Symlink escaping workspace | `fs.realpath()` + validate | Skip, log security warning |
| File deleted during index | `fs.readFile()` throws ENOENT | Remove from index, continue |
| File changed during index | Hash mismatch on verify | Re-read file, retry once |
| LLM unavailable (enrichment) | Router throws | Return results without enrichment, set `enrichment_failed: true` |
| Embedding unavailable | Router throws | For refresh: skip re-embedding, keep old. For build: fail with clear error |
| Very large file (>1MB) | Size check | Truncate to first 100KB for embedding, full file for tree-sitter |
| Non-UTF8 file | Decode error | Skip, log warning |
| Permission denied | `fs.access()` fails | Skip, log warning |
| Index file corrupted | JSON.parse fails | Backup corrupted file, start fresh index |
| Stale lock (>30min) | Lock age check | Break lock, log warning |

## Graceful Degradation Matrix

| Component Down | Behavior |
|----------------|----------|
| LM Studio (embeddings) | `refresh_index`: Skip re-embedding, keep existing vectors. `search_semantic`: Fail with clear error. |
| LM Studio (enrichment) | Return search results without enrichment, flag `enrichment_unavailable: true` |
| Target workspace offline | Fail with SHARE_UNREACHABLE, same as Local Agent |
| Index doesn't exist | Search tools return `{ error: 'NO_INDEX', hint: 'Run: node scripts/build-index.js --workspace "..."' }` |
| Index stale (>7 days) | Search works, include `warning: 'INDEX_STALE', age_days: 12` in response |

## Tool Specifications

### `refresh_index`

```javascript
{
  name: 'refresh_index',
  description: 'Incrementally update index for files changed since last build. Fast (seconds). Call after making code changes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Local path to workspace (e.g., D:\\DEV\\mcp_server)' },
      machine: { type: 'string', description: 'Machine name (optional, uses default)' }
    },
    required: ['path']
  }
}
```

**Algorithm**:
1. Acquire lock (fail if held)
2. Walk workspace, collect `{ path, mtime }` for each file
3. Compare against index: find files where `mtime > indexed_mtime` or `path not in index`
4. For deleted files: remove from index
5. For new/changed files: parse + embed (batched)
6. Atomic write index
7. Release lock

**Response**:
```javascript
{ 
  status: 'success',
  files_checked: 5000,
  files_updated: 23,
  files_added: 5,
  files_removed: 2,
  duration_ms: 3400
}
```

### `get_index_stats`

```javascript
{
  name: 'get_index_stats',
  description: 'Get index health: exists, file count, age, staleness warnings',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Local path to workspace' },
      machine: { type: 'string' }
    },
    required: ['path']
  }
}
```

**Response**:
```javascript
{
  exists: true,
  file_count: 4532,
  last_full_build: '2026-01-28T10:00:00Z',
  last_refresh: '2026-02-01T14:30:00Z',
  age_hours: 4.5,
  stale: false,  // true if >7 days since last refresh
  enriched_files: 127,
  build_in_progress: false
}
```

## Related

- [Local Agent Module](local-agent-module.md) - Autonomous agent using search tools
- [LLM Architecture](llm-architecture.md) - Router and adapter patterns

## Contributors

- **@herrbasan** - Architecture
- **GitHub Copilot** - Documentation
