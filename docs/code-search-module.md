# Code Search Module - Development Plan

**Status**: Planning (Tree-sitter + Agentic LLM Architecture)
**Module**: `src/servers/code-search.js`
**Updated**: January 21, 2026

## Executive Summary

Intelligent code search for large codebases (100k+ files) using tree-sitter parsing, semantic embeddings, and agentic LLM descriptions. Enables developers to find relevant code via natural language queries, filename patterns, keywords, or semantic similarity.

**Key Innovation**: LLM analyzes code structure and retrieves sections surgically - no context window limits, handles files of any size.

## Goals & Non-Goals

**Goals**:
- Fast semantic code search (sub-second for 100k files)
- Intelligent file descriptions without reading all code
- Multi-modal search (filename, keyword, semantic, agent-orchestrated)
- Incremental indexing (update on file changes)
- 100% local (no external APIs)

**Non-Goals**:
- Full code understanding or refactoring
- Real-time indexing (batch processing acceptable)
- Type inference or control flow analysis
- Multi-tenant support (single-server for now)

## Architecture

### Three-Phase Indexing

**Phase 1: Tree-sitter Parsing** (50ms/file)
- Extract AST: functions, classes, imports, exports, comments, strings
- Build dependency graph from import/export relationships
- Binary detection, ignore patterns

**Phase 2: Semantic Embedding** (14ms/file)
- Embed structured metadata (not raw code) for better semantic capture
- Input: `path + symbols + imports + comments`

**Phase 3: Agentic Description** (2.5s/file, parallelizable 10x)
- LLM receives tree + path context
- Tools: `get_lines()`, `get_function_body()` for surgical code retrieval
- Generates: description, keywords, inferred relationships

**Performance**: 100k files in ~2.5 hours (parallel), ~9 hours (sequential)

### Data Flow

```
Code Files → Tree-sitter Parser → Structured Metadata
                                         ↓
                           Embedding Model → Semantic Vectors
                                         ↓
                           LLM (agentic) → Descriptions & Keywords
                                         ↓
                                   Index (JSON)
                                         ↓
                           Query → Search Tools → Results
```

### Core Components

**Indexer**: Builds/updates index (tree + embed + describe)
**Search Service**: Direct searches (files, keywords, semantic, context)
**Agent**: Multi-modal orchestration with LLM synthesis
**Index Store**: In-memory with atomic disk persistence

## Tools (7)

**Indexing** (2):
1. `build_index` - Create/update index (tree-sitter + embeddings + descriptions)
2. `get_index_stats` - Health metrics, staleness detection

**Search** (4):
3. `search_files` - Glob pattern matching (instant)
4. `search_keyword` - Ripgrep exact/regex search
5. `search_semantic` - Vector similarity (cosine)
6. `get_file_context` - Retrieve function with imports/exports/dependencies

**Orchestration** (1):
7. `search_code` - Agent combines all methods + synthesizes results

## Query Structures

**Note**: TypeScript notation used for documentation only. Implementation in vanilla JavaScript (ES modules).

### Common Parameters
```typescript
{
  paths: string[]          // Workspace roots to search
  max_results?: number     // Limit results (default: 20)
}
```

### Indexing Queries
```typescript
build_index: {
  paths: string[]
  incremental?: boolean    // Only re-index changed files
  include_descriptions?: boolean
  parallelism?: number     // Concurrent workers (default: 10)
}

get_index_stats: {
  paths: string[]
}
```

### Search Queries
```typescript
search_files: {
  pattern: string          // Glob pattern: "*auth*.js"
  paths: string[]
}

search_keyword: {
  query: string
  paths: string[]
  is_regex?: boolean
}

search_semantic: {
  query: string           // Natural language: "JWT validation"
  paths: string[]
  threshold?: number      // Min similarity (default: 0.70)
}

get_file_context: {
  file: string            // Absolute path
  function_name?: string  // Extract specific function
  line_range?: [number, number]
}

search_code: {
  query: string           // "How does login work?"
  paths: string[]
  max_files?: number      // Files to analyze (default: 5)
}
```

## Data Formats

### Index Entry
```typescript
{
  metadata: {
    size: number
    mtime: string         // ISO timestamp
    content_hash: string  // SHA-256
    language: string
    git_blame?: string
  }
  
  tree: {
    functions: Array<{
      name: string
      params: string[]
      line: number
      end_line: number
      async?: boolean
      exported?: boolean
    }>
    
    classes: Array<{
      name: string
      methods: string[]
      line: number
      extends?: string
    }>
    
    imports: Array<{
      module: string
      specifiers: string[]
    }>
    
    exports: string[]
    comments: string[]
    strings: string[]      // Literals from code
  }
  
  embedding: number[]      // 768-dim vector
  
  ai_analysis?: {
    description: string
    keywords: string[]
    relationships: Array<{
      module: string
      type: "depends_on" | "provides" | "calls"
      reason: string
    }>
    confidence: number     // 1-10
  }
}
```

### Search Results
```typescript
// Semantic search
{
  results: Array<{
    file: string
    similarity: number
    description: string
    symbols: {
      functions: string[]
      exports: string[]
    }
  }>
}

// Agent search
{
  summary: string         // LLM synthesis
  files: Array<{
    path: string
    relevance: number
    role: string
    functions: Array<{
      name: string
      code: string
      imports: string[]
    }>
  }>
  dependency_graph: Record<string, string[]>
}
```

## Index Structure

Stores per-file:
- **metadata**: size, mtime, content hash, language, git blame
- **tree**: functions, classes, imports, exports, comments (tree-sitter output)
- **embedding**: 768-dim vector from structured metadata
- **ai_analysis**: description, keywords, relationships, confidence (LLM-generated)
- **dependency_graph**: import/export edges

**Storage**: `data/code-index.json` (~4KB/file, ~400MB for 100k files)
**Runtime**: Fully in-memory, atomic saves (temp file + rename)

## Agentic LLM Strategy

**No Context Window Limits**: LLM sees tree structure, retrieves code surgically as needed (typically 0-500 tokens vs 5k-40k for full files).

**Decision Flow**:
- **70% of files**: Tree + comments sufficient → immediate description
- **25% of files**: Retrieve 1-2 functions to verify
- **5% of files**: Complex, retrieve multiple sections

**Output**: Description (1-2 sentences), keywords, inferred relationships, confidence (1-10)

## Configuration

Key settings in `config.json`:
- **parsing**: tree-sitter languages, extract comments/strings, max file size
- **embedding**: model, endpoint, batch size, embed from tree (not raw code)
- **ai_descriptions**: model (gemma-3-12b), allow retrieval, parallelism (10x), timeout
- **ignore_patterns**: `.git`, `node_modules`, `dist`, `*.min.js`
- **search**: semantic threshold (0.70), max results, ripgrep command

## Performance Targets

| Metric | Target |
|--------|--------|
| Indexing (100k files) | <3 hours (parallel) |
| Incremental update | <2 minutes |
| Filename search | <50ms |
| Keyword search | <3s |
| Semantic search | <1s |
| Agent search | <10s |
| Memory footprint | <500MB |

## Dependencies

**Required**:
- `tree-sitter` + language grammars (JS, Python, Go, Rust, Java, TS)
- `ripgrep` (external binary, not bundled)

**Optional**:
- LM Studio (embeddings + LLM descriptions)

## Security

- **Input sanitization**: Block path traversal, shell metacharacters, query length limits
- **Path validation**: Restrict to allowed workspace roots
- **Read-only**: No writes/deletes via search tools
- **Ripgrep safety**: Process timeout (30s), delegate regex handling

## Error Handling

Standard format: `{error: {code, message, data}}`

Critical codes: `INDEX_NOT_FOUND`, `TREE_PARSE_FAILED`, `LLM_UNAVAILABLE`, `RIPGREP_TIMEOUT`, `PATH_OUTSIDE_WORKSPACE`

## Implementation Phases

**Phase 1**: Core infrastructure (tree-sitter parsers, file traversal, index structure)
**Phase 2**: Parsing & embedding (extract metadata, generate vectors, build dependency graph)
**Phase 3**: Agentic descriptions (LLM prompting, surgical retrieval, parallel generation)
**Phase 4**: Search tools (direct + agent orchestration)
**Phase 5**: Integration & testing (wire into MCP server, benchmarks, incremental indexing)

## Edge Cases

- **Large files**: Surgical retrieval handles unlimited size
- **Syntax errors**: Fall back to regex extraction, mark `parse_failed: true`
- **Symlink loops**: Track visited paths, abort on cycles
- **Binary files**: Magic byte detection, skip parsing
- **LLM unavailable**: Gracefully degrade (use cached descriptions or embeddings-only mode)

## Contributors

- **@herrbasan** - Architecture
- **GitHub Copilot (Claude Sonnet 4.5)** - Documentation
