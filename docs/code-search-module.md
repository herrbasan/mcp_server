# Code Search Module

**Module**: `src/servers/code-search.js`
**Updated**: January 27, 2026

## Summary

Code search for large codebases (100k+ files). Fast base index via tree-sitter + embeddings. LLM enrichment is query-driven, not upfront.

## Workspace Integration

Indexes are scoped to workspaces defined in the shared machine/share config:

```json
{
  "localAgent": {
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
`data/indexes/{workspace-name}.json`

**Path Resolution**: Shared utility in `src/lib/workspace.js` handles translation from client local paths to server-accessible UNC paths. Longest prefix match ensures specific shares override general ones.

See [Local Agent Module](local-agent-module.md) for path resolution details.

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
  content_hash: string,       // SHA-256, for invalidation
  last_indexed_at: string,    // ISO timestamp
  language: string,
  tree: {
    functions: [{ name, params, line, end_line, exported }],
    classes: [{ name, methods, line, extends }],
    imports: [{ module, specifiers }],
    exports: string[],
    comments: string[]
  },
  embedding: number[],        // 768-dim

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

## Tools (6)

**Indexing**:
1. `build_index` - Create/update base index (tree-sitter + embeddings)
2. `get_index_stats` - Health metrics, staleness info

**Search**:
3. `search_files` - Glob pattern matching
4. `search_keyword` - Ripgrep exact/regex
5. `search_semantic` - Vector similarity
6. `search_code` - Multi-modal search, triggers enrichment on top results

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

## Edge Cases

- **Syntax errors**: regex fallback, mark `parse_failed: true`
- **Binary files**: magic byte detection, skip
- **Symlink loops**: track visited paths
- **LLM unavailable**: return results without enrichment
- **Active editing**: 10-min debounce prevents thrashing

## Related

- [Local Agent Module](local-agent-module.md) - Autonomous agent using search tools
- [LLM Architecture](llm-architecture.md) - Router and adapter patterns

## Contributors

- **@herrbasan** - Architecture
- **GitHub Copilot** - Documentation
