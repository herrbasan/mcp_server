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

**Phase 1: Static Analysis (tree-sitter)**
- Parse every file into Abstract Syntax Tree (AST)
- Extract structured metadata: functions, classes, imports, exports, comments, string literals
- Build dependency graph from import/export relationships
- Detect binary files, respect ignore patterns
- **Performance**: 50ms per file, 100k files in ~1.4 hours

**Phase 2: Semantic Embedding**
- Generate embeddings from **structured metadata**, not raw code
- Embedding input: file path + exported symbols + imports + comments + keywords
- Creates semantic vectors optimized for search relevance
- **Performance**: 14ms per file, 100k files in ~23 minutes

**Phase 3: Agentic Description (LLM with surgical retrieval)**
- LLM receives: file path, tree-sitter metadata, path context hints
- LLM has tools to retrieve specific code sections on-demand (functions, line ranges)
- LLM generates: concise description, keywords, inferred relationships
- **No context window limits**: LLM reads only what it needs (typically 0-500 tokens)
- **Performance**: 2.5s per file (average), parallelizable 10x, ~7 hours for 100k files

**Total indexing time**: ~9 hours sequential, ~2.5 hours with 10x parallelization

### Query Architecture

**Direct Search Tools** (fast, deterministic):
- Filename/path search via indexed tree
- Keyword search via ripgrep
- Semantic search via vector similarity
- Symbol lookup via tree-sitter index

**Agent Tool** (intelligent orchestration):
- Multi-modal retrieval: combines semantic + keyword + graph traversal
- Selects top 5-10 most relevant files
- Extracts complete functions with imports/exports
- Returns synthesized understanding with code context

### Design Principles

1. **Static Analysis First**: Extract everything possible without AI (faster, deterministic)
2. **Embeddings from Structure**: Semantic vectors from metadata, not syntax
3. **Surgical LLM Usage**: AI reads code selectively, not wholesale
4. **Progressive Enhancement**: Basic search works without LLM descriptions
5. **Actionable Results**: Return complete code sections, not just pointers

## Tools (7 total)

### Indexing Tools (2)

#### 1. `build_index`
Build complete code index using tree-sitter, embeddings, and optional LLM descriptions.

**Input**:
```json
{
  "paths": ["/path/to/project"],
  "incremental": true,
  "include_descriptions": true,
  "parallelism": 10
}
```

**Output**:
```json
{
  "stats": {
    "files_parsed": 15234,
    "files_updated": 23,
    "embeddings_created": 15234,
    "descriptions_generated": 15234,
    "dependency_edges": 8456,
    "duration_ms": 9000000,
    "index_size_mb": 420
  }
}
```

**Behavior**:
- Walk directories, respect ignore patterns
- Parse each file with tree-sitter (extract functions, imports, exports, comments)
- Create embeddings from structured metadata
- Optionally generate LLM descriptions (agentic retrieval)
- Build import/export dependency graph
- Store results in memory-mapped index
- Incremental mode: only re-process files with changed mtime or content hash

**Performance**:
- Sequential: ~9 hours for 100k files
- Parallel (10x): ~2.5 hours for 100k files
- Incremental: ~1-2 minutes for typical changes

---

#### 2. `get_index_stats`
Get index statistics and health metrics.

**Input**:
```json
{
  "paths": ["/path/to/project"]
}
```

**Output**:
```json
{
  "indexed_at": "2026-01-21T10:30:00Z",
  "files_count": 15234,
  "trees_parsed": 15234,
  "embeddings_count": 15234,
  "descriptions_count": 15234,
  "dependency_edges": 8456,
  "staleness": "current",
  "index_health": "good",
  "storage_mb": 420,
  "paths": ["/path/to/project"]
}
```

**Behavior**:
- Returns index metadata without loading full index
- Shows staleness (files changed since last index)
- Diagnostic tool for troubleshooting

---

### Direct Search Tools (4)

#### 3. `search_files`
Fast filename/path search using indexed tree.

**Input**:
```json
{
  "pattern": "*auth*.js",
  "paths": ["/path/to/project"],
  "max_results": 50
}
```

**Output**:
```json
{
  "files": [
    "/path/to/project/src/auth/login.js",
    "/path/to/project/src/middleware/auth.js",
    "/path/to/project/test/auth.test.js"
  ],
  "total": 3
}
```

**Behavior**:
- Glob pattern matching on indexed paths
- Instant (index lookup)
- Use when filename is approximately known

---

#### 4. `search_keyword`
Fast keyword search with ripgrep (exact matches).

**Input**:
```json
{
  "query": "validateJWT",
  "paths": ["/path/to/project"],
  "is_regex": false,
  "max_results": 20
}
```

**Output**:
```json
{
  "results": [
    {
      "file": "/path/to/project/src/auth.js",
      "line": 42,
      "match": "async function validateJWT(token) {",
      "context": {
        "before": ["import jwt from 'jsonwebtoken';", ""],
        "after": ["  if (!token) throw new Error('Missing token');", "  const decoded = jwt.verify(token, SECRET_KEY);"]
      }
    }
  ],
  "total": 1,
  "duration_ms": 234
}
```

**Behavior**:
- Uses ripgrep for fast exact matching
- Returns line numbers with surrounding context
- Supports regex patterns
- Respects ignore patterns

---

#### 5. `search_semantic`
Semantic search using embeddings (finds conceptually similar code).

**Input**:
```json
{
  "query": "JWT token validation and expiry checking",
  "paths": ["/path/to/project"],
  "max_results": 10
}
```

**Output**:
```json
{
  "results": [
    {
      "file": "/path/to/project/src/auth/jwt.js",
      "similarity": 0.89,
      "description": "JWT token validation and refresh with expiry checking",
      "symbols": {
        "functions": ["validateJWT", "refreshToken"],
        "exports": ["validateJWT", "refreshToken"]
      }
    },
    {
      "file": "/path/to/project/src/middleware/verify-token.js",
      "similarity": 0.82,
      "description": "Express middleware that authenticates requests by validating JWT tokens",
      "symbols": {
        "functions": ["authenticate"],
        "exports": ["authenticate"]
      }
    }
  ]
}
```

**Behavior**:
- Embeds query using same model as indexing
- Cosine similarity search over file embeddings
- Returns files with similarity scores above threshold (0.70)
- Fast: ~100-500ms for 100k files (in-memory vector search)

---

#### 6. `get_file_context`
Retrieve specific code section with full context (imports, exports, dependencies).

**Input**:
```json
{
  "file": "/path/to/project/src/auth.js",
  "function_name": "validateJWT"
}
```

**Output**:
```json
{
  "file": "/path/to/project/src/auth.js",
  "function": {
    "name": "validateJWT",
    "start_line": 42,
    "end_line": 58,
    "code": "async function validateJWT(token) {\n  if (!token) throw new Error('Missing token');\n  const decoded = jwt.verify(token, SECRET_KEY);\n  if (decoded.exp < Date.now() / 1000) throw new Error('Token expired');\n  return decoded.userId;\n}",
    "signature": "async function validateJWT(token)",
    "exported": true
  },
  "imports": [
    "import jwt from 'jsonwebtoken';",
    "import { SECRET_KEY } from '../config';"
  ],
  "exports": ["validateJWT", "refreshToken"],
  "dependencies": {
    "imports_from": ["jsonwebtoken", "../config"],
    "imported_by": ["../routes/auth.js", "../middleware/verify.js"]
  },
  "metadata": {
    "language": "JavaScript",
    "git_blame": "user@example.com",
    "last_modified": "2026-01-15T14:30:00Z"
  }
}
```

**Behavior**:
- Extract complete function from tree-sitter index
- Include file-level imports/exports
- Show dependency relationships from graph
- Return executable code snippet with all necessary context

---

### Agent Tool (1)

#### 7. `search_code`
LLM-orchestrated intelligent code search combining all retrieval methods.

**Input**:
```json
{
  "query": "How does the login authentication work? Show me the complete flow",
  "paths": ["/path/to/project"],
  "max_files": 5
}
```

**Output**:
```json
{
  "summary": "Login authentication uses JWT tokens. Flow: 1) User submits credentials to /login endpoint (routes/auth.js), 2) Password validated with bcrypt in userService.js, 3) JWT token generated with 1h expiry in auth/jwt.js, 4) Token verified on subsequent requests by middleware/verify-token.js. No session storage, stateless auth.",
  
  "files": [
    {
      "path": "/path/to/project/src/routes/auth.js",
      "relevance": 0.95,
      "role": "Entry point - handles /login POST request",
      "description": "Express routes for authentication endpoints with validation middleware",
      "functions": [
        {
          "name": "handleLogin",
          "code": "export async function handleLogin(req, res) { ... }",
          "imports": ["User from ../models", "comparePassword from ../utils/crypto", "generateJWT from ../auth/jwt"]
        }
      ]
    },
    {
      "path": "/path/to/project/src/auth/jwt.js",
      "relevance": 0.92,
      "role": "JWT generation and validation",
      "description": "JWT token validation and refresh with expiry checking",
      "functions": [
        {
          "name": "generateJWT",
          "code": "export function generateJWT(payload) { ... }",
          "imports": ["jwt from jsonwebtoken", "SECRET_KEY from ../config"]
        },
        {
          "name": "validateJWT",
          "code": "export function validateJWT(token) { ... }",
          "imports": ["jwt from jsonwebtoken", "SECRET_KEY from ../config"]
        }
      ]
    }
  ],
  
  "dependency_graph": {
    "routes/auth.js": ["models/User", "utils/crypto", "auth/jwt"],
    "auth/jwt": ["config"],
    "utils/crypto": []
  },
  
  "duration_ms": 4234
}
```

**Behavior**:
- **Phase 1: Multi-modal search** - Combine semantic search, keyword search, and path analysis to identify top 20-50 candidate files
- **Phase 2: Ranking** - Use dependency graph, file descriptions, and relevance scores to select top 5-10 files
- **Phase 3: Extraction** - Retrieve complete function code with imports/exports from selected files
- **Phase 4: Synthesis** - LLM analyzes all code sections and generates comprehensive summary

**Performance**: ~4-7s for 100k file codebase

---

## Index Structure

**Storage**: JSON file at `data/code-index.json` (in-memory with atomic persistence)

**Format**:
```json
{
  "version": 3,
  "indexed_at": "2026-01-21T10:30:00Z",
  "paths": {
    "/path/to/project": {
      "files": {
        "/absolute/path/file.js": {
          "metadata": {
            "size": 2048,
            "mtime": "2026-01-21T09:15:00Z",
            "content_hash": "sha256:abc123...",
            "language": "JavaScript",
            "binary": false,
            "git_blame": "user@example.com"
          },
          
          "tree": {
            "functions": [
              {
                "name": "validateJWT",
                "params": ["token"],
                "line": 42,
                "end_line": 58,
                "async": true,
                "exported": true,
                "signature": "async function validateJWT(token)"
              }
            ],
            "classes": [
              {
                "name": "AuthService",
                "methods": ["login", "logout", "refresh"],
                "line": 60,
                "extends": null
              }
            ],
            "imports": [
              {
                "module": "jsonwebtoken",
                "specifiers": ["verify", "sign"],
                "line": 1
              },
              {
                "module": "../config",
                "specifiers": ["SECRET_KEY"],
                "line": 2
              }
            ],
            "exports": ["validateJWT", "refreshToken", "AuthService"],
            "comments": [
              "Validates JWT tokens and checks expiry"
            ],
            "strings": ["Bearer ", "Invalid token", "Token expired"]
          },
          
          "embedding": [0.123, -0.456, ...],
          
          "ai_analysis": {
            "generated_at": "2026-01-21T10:35:00Z",
            "model": "google/gemma-3-12b",
            "description": "JWT token validation and refresh functionality using jsonwebtoken library with secret key from config.",
            "keywords": ["jwt", "auth", "token", "validate", "refresh", "bearer"],
            "inferred_relationships": [
              {
                "module": "config",
                "type": "depends_on",
                "reason": "Imports SECRET_KEY for token signing"
              }
            ],
            "confidence": 9,
            "exploration_stats": {
              "sections_retrieved": 1,
              "tokens_read": 450,
              "duration_ms": 3200
            }
          }
        }
      },
      "dependency_graph": {
        "/absolute/path/file.js": {
          "imports": ["/absolute/path/config.js"],
          "imported_by": ["/absolute/path/routes/auth.js", "/absolute/path/middleware/verify.js"]
        }
      },
      "stats": {
        "total_files": 15234,
        "total_size": 52428800,
        "trees_parsed": 15234,
        "embeddings_created": 15234,
        "ai_analyzed": 15234
      }
    }
  }
}
```

**Key Components**:

1. **metadata**: File-level information (size, timestamps, hashes, git data)
2. **tree**: Tree-sitter extracted structure (functions, classes, imports, exports, comments, literals)
3. **embedding**: Semantic vector (768-dim float array) created from structured metadata
4. **ai_analysis**: LLM-generated description with keywords and relationships
5. **dependency_graph**: Import/export relationships for graph traversal

**Index Size Estimates**:
- Basic metadata: ~200 bytes/file
- Tree structure: ~500 bytes/file
- Embedding: ~3KB/file (768 floats × 4 bytes)
- AI analysis: ~300 bytes/file
- **Total**: ~4KB per file
- **100k files**: ~400MB index size

**Runtime Model**:
- Load entire index into memory on startup (~1-2s for 400MB)
- All searches operate in-memory (sub-second)
- Incremental updates modify in-memory index
- Atomic save to disk (temp file + rename, crash-safe)
- Auto-save on changes, periodic checkpoints

## Agentic LLM Description Generation

### Strategy

**Goal**: Generate semantic descriptions from file structure without reading entire files, enabling unlimited file size support.

**Approach**: LLM acts as analyst with retrieval tools - sees tree-sitter metadata and retrieves code sections surgically as needed.

### LLM Context

**Initial prompt includes**:
- File path with directory context hints (e.g., `src/auth/` suggests authentication)
- Tree-sitter metadata: functions, classes, imports, exports, comments, string literals
- Path-based semantic hints (e.g., `test/` → test file, `utils/` → utilities)

**Available tools**:
- `get_lines(start, end)`: Retrieve specific line range
- `get_function_body(name)`: Retrieve complete function code
- `get_class_body(name)`: Retrieve complete class code

**Expected output**:
```json
{
  "description": "1-2 sentence description of file's purpose and functionality",
  "keywords": ["relevant", "searchable", "terms"],
  "inferred_relationships": [
    {"module": "dependency", "type": "depends_on|provides|calls", "reason": "why relationship exists"}
  ],
  "confidence": 1-10
}
```

### Decision Flow

1. **Tree-only (70% of files)**: Structure + comments + imports sufficient → generate description immediately
2. **Verify (25% of files)**: Ambiguous purpose → retrieve 1-2 key functions to confirm
3. **Explore (5% of files)**: Complex logic → retrieve multiple sections to understand behavior

### No Context Window Limits

**Traditional approach**: Load entire file (fails at 24k tokens)
**Agentic approach**: Load only what's needed (typically 0-500 tokens)

**Example - 2000 line file**:
- Tree shows 37 functions across multiple domains
- LLM identifies it as "monolithic handler file"
- Retrieves 3 representative functions (~200 lines total)
- Generates: "Comprehensive API handler covering authentication, user management, and OAuth with 37 endpoints"
- **Tokens read**: ~1200 (vs 40k for full file)

### Batch Optimization

Instead of 1 file per LLM call, process multiple files when applicable:
- Files with similar patterns (same directory, similar imports)
- Can batch tree analysis when descriptions don't require code retrieval
- Reduces LLM overhead for simple files

### Performance Characteristics

**Average per file**:
- Tree-only: ~1.5s (LLM generates from structure)
- With retrieval: ~2.5s (1-2 function retrievals)
- Complex exploration: ~4s (multiple retrievals)

**Parallelization**:
- 10x concurrent LLM calls
- 100k files: ~7 hours → ~2.5 hours with parallelism

### Confidence Scoring

LLM self-assesses confidence (1-10):
- **9-10**: Strong signals (clear function names, good comments, obvious imports)
- **7-8**: Inferred from patterns (typical conventions, standard libraries)
- **5-6**: Ambiguous (generic names, minimal comments, needed code retrieval)
- **<5**: Complex or unusual patterns (rare)

Track confidence scores to identify files needing better documentation.

### Relationship Inference

LLM can infer semantic relationships beyond syntax:
- Import dependencies → "uses for purpose X"
- Export patterns → "provides Y to consumers"
- Naming conventions → "part of Z subsystem"
- File location → "integrates with W module"

Enriches dependency graph with semantic meaning.

## Configuration

**`config.json`**:
```json
{
  "code-search": {
    "enabled": true,
    "index_path": "data/code-index.json",
    
    "parsing": {
      "tree_sitter_enabled": true,
      "languages": ["javascript", "typescript", "python", "go", "rust", "java"],
      "extract_comments": true,
      "extract_strings": true,
      "max_file_size": 10485760
    },
    
    "embedding": {
      "model": "text-embedding-nomic-embed-text-v2-moe",
      "endpoint": "http://localhost:12345/v1/embeddings",
      "batch_size": 100,
      "embed_from_tree": true
    },
    
    "ai_descriptions": {
      "enabled": true,
      "model": "google/gemma-3-12b",
      "endpoint": "ws://localhost:12345",
      "allow_code_retrieval": true,
      "max_retrieval_sections": 5,
      "timeout_ms": 10000,
      "parallelism": 10
    },
    
    "ignore_patterns": [
      ".git", "node_modules", "dist", "build", ".next",
      "__pycache__", ".vscode", "coverage", "*.min.js",
      "*.bundle.js", "package-lock.json"
    ],
    
    "allowed_extensions": [
      ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
      ".py", ".pyw",
      ".go",
      ".rs",
      ".java",
      ".sh", ".bash", ".zsh",
      ".md", ".txt", ".mdx",
      ".json", ".yaml", ".yml", ".toml"
    ],
    
    "indexing": {
      "incremental_mode": true,
      "build_dependency_graph": true,
      "auto_save_interval_ms": 300000,
      "max_workers": 10
    },
    
    "search": {
      "max_results_per_mode": 20,
      "max_files_returned": 10,
      "semantic_threshold": 0.70,
      "timeout_ms": 30000,
      "ripgrep_command": "rg"
    },
    
    "agent": {
      "enabled": true,
      "max_files_analyzed": 5,
      "include_dependency_graph": true,
      "extract_full_functions": true,
      "timeout_ms": 30000
    },
    
    "safety": {
      "max_symlink_depth": 10,
      "sanitize_queries": true,
      "allowed_workspace_roots": []
    }
  }
}
```

---

## Security

### Input Sanitization

**Threat Model**: MCP clients (VS Code Copilot) are semi-trusted - prevent accidental code injection, not sophisticated attacks.

**Query Sanitization**: 
- Block path traversal patterns (`../`, `..\`)
- Block shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`)
- Limit query length (10k chars max)
- Trim whitespace

**Path Sanitization**:
- Resolve to absolute paths
- Ensure within allowed workspace roots
- No access outside configured boundaries
- Configurable workspace root whitelist

**Regex Injection**:
- Delegate to ripgrep (built-in catastrophic backtracking protection)
- Process timeout: 30s max
- No client-side regex compilation

**LLM Prompt Injection**:
- System prompts are server-controlled
- File content treated as data, not instructions
- No dynamic prompt construction from user input
- Tree-sitter output is structured data, not executable

**File Access Control**:
- Read-only operations (no writes/deletes)
- Respect `.gitignore` and custom ignore patterns
- Symlink dereferencing with cycle detection
- Binary file detection (magic bytes)

## Error Handling

All tools return errors in standard format with actionable codes:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "data": {"context": "specific details"}
  }
}
```

**Key Error Codes**:

| Code | Meaning | Resolution |
|------|---------|------------|
| `INDEX_NOT_FOUND` | Path not indexed | Call `build_index` first |
| `INDEX_STALE` | Files changed since indexing | Re-run incremental index |
| `FILE_NOT_FOUND` | File doesn't exist | File deleted after indexing |
| `FILE_BINARY` | Binary file, not readable | Cannot extract code |
| `TREE_PARSE_FAILED` | Tree-sitter parsing failed | Syntax error or unsupported language |
| `RIPGREP_NOT_FOUND` | ripgrep not installed | Install `rg` command |
| `RIPGREP_TIMEOUT` | Search exceeded timeout | Reduce scope or increase timeout |
| `LLM_UNAVAILABLE` | LLM not responding | Check LM Studio connection |
| `LLM_TIMEOUT` | LLM call exceeded timeout | Increase timeout or reduce parallelism |
| `QUERY_TOO_LONG` | Query exceeds limit | Shorten search query |
| `PATH_TRAVERSAL_DETECTED` | Path contains `../` | Security violation |
| `PATH_OUTSIDE_WORKSPACE` | Path not in allowed roots | Access denied |
| `SYMLINK_LOOP` | Circular symlink detected | Fix symlink chain |

---

## Dependencies

**Required**:
- `tree-sitter` - Universal parser (AST extraction)
- `tree-sitter-javascript`, `tree-sitter-python`, etc. - Language grammars
- `ripgrep` (`rg`) - Fast keyword search (external binary)

**Optional**:
- LM Studio - Embedding model and LLM descriptions
- Git - Blame information and change detection

**Performance Notes**:
- Tree-sitter: Native C bindings, minimal overhead
- Ripgrep: Must be installed separately, not bundled
- LLM: Parallelizable, 10x recommended for indexing

---

## Performance Targets

### Service Level Objectives (SLOs)

**Indexing** (100k files):
- Tree parsing: ~1.4 hours (50ms/file)
- Embedding creation: ~23 minutes (14ms/file, batched)
- AI descriptions: ~7 hours sequential, ~2.5 hours parallel (10x)
- **Total**: ~9 hours sequential, ~2.5 hours parallel

**Incremental Updates**:
- Changed files only: ~1-2 minutes for typical changes
- Content hash detection: Skip unchanged files

**Query Latency** (P50 / P95):
- `search_files`: <10ms / <50ms (index lookup)
- `search_keyword`: <500ms / <3s (ripgrep)
- `search_semantic`: <300ms / <1s (in-memory vector search)
- `get_file_context`: <100ms / <500ms (tree index lookup)
- `search_code` (agent): <5s / <10s (multi-phase orchestration)

**Resource Limits**:
- Memory: ~400MB index footprint (100k files)
- Storage: ~400MB disk space
- GPU VRAM: ~8GB (shared: Gemma 3 + embedding model)

**Scalability**:
- 10k files: ~15 minutes indexing, instant search
- 100k files: ~2.5 hours indexing (parallel), sub-second search
- 1M files: ~25 hours indexing (parallel), ~2-3s search

---
    const data = readFileSync(this.indexPath, 'utf-8');
    this.index = JSON.parse(data);
    console.log(`Loaded index: ${this.getFileCount()} files`);
  } catch (err) {
    console.log('No index found, starting fresh');
    this.index = { version: 2, indexed_at: null, paths: {} };
  }
}
```

#### Index Saving (Atomic, Crash-Safe)
```javascript
async saveIndex() {
  const tmpPath = `${this.indexPath}.tmp`;
  const json = JSON.stringify(this.index, null, 2);
  
  await writeFile(tmpPath, json, 'utf-8');
  await rename(tmpPath, this.indexPath); // Atomic
  
  // On crash: either old index intact or new index complete, never corrupted
}
```

#### Function Extraction (Regex-Based, Fast)
```javascript
function extractFunctions(fileContent, functionName) {
  // Matches: function name(...) { ... }, const name = (...) => { ... }, async function name...
  const patterns = [
    new RegExp(`(async\\s+)?function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`, 'g'),
    new RegExp(`const\\s+${functionName}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>`, 'g')
  ];
  
  for (const pattern of patterns) {
    const match = pattern.exec(fileContent);
    if (match) {
      const start = match.index;
      const end = findMatchingBrace(fileContent, start);
      return {
        start,
        end,
        code: fileContent.slice(start, end),
        line: countLines(fileContent.slice(0, start))
      };
    }
  }
  return null;
}
```

#### Import Extraction (Regex)
```javascript
function extractImports(fileContent) {
  const imports = [];
  const importRegex = /^import\s+.*?from\s+['"]([^'"]+)['"];?$/gm;
  const requireRegex = /const\s+.*?=\s+require\(['"]([^'"]+)['"]\)/g;
  
  let match;
  while ((match = importRegex.exec(fileContent)) !== null) {
    imports.push(match[0].trim());
  }
  while ((match = requireRegex.exec(fileContent)) !== null) {
    imports.push(match[0].trim());
  }
  
  return imports.slice(0, 10); // Limit to top 10 importsth, visited = new Set()) {
  const realPath = await fs.realpath(rootPath);
  
  if (visited.has(realPath)) {
    throw new Error({ code: 'SYMLINK_LOOP', path: rootPath });
  }
  
  visited.add(realPath);
  // Continue traversal...
}
```

---

## Implementation Plan

### Phase 1: Core Infrastructure
- [ ] Create `src/servers/code-search.js` skeleton
- [ ] Implement file tree indexing (metadata only, inline binary detection)
- [ ] Add symlink loop detection (visited set)
- **Initial index** | <2 min | <20 min | <3 hours |
| **Incremental index** | <10s | <2 min | <20 min |
| **Semantic search** | <100ms | <500ms | <2s |
| **Keyword search** | <50ms | <500ms | <5s |
| **Agent (full)** | <3s | <6s | <15s |

## Implementation Plan

### Phase 1: Core Infrastructure
- Set up tree-sitter with language grammars (JavaScript, Python, TypeScript, Go, Rust, Java)
- Implement file traversal with ignore patterns and symlink detection
- Create in-memory index structure with atomic persistence
- Binary file detection via magic bytes

### Phase 2: Parsing & Embedding
- Build tree-sitter parser for each supported language
- Extract functions, classes, imports, exports, comments, string literals
- Generate embeddings from structured metadata (not raw code)
- Implement batched embedding creation (100 files/batch)
- Build dependency graph from import/export relationships

### Phase 3: Agentic Descriptions
- Design LLM prompting strategy with retrieval tools
- Implement surgical code retrieval (get_lines, get_function_body)
- Create parallel description generation (10x workers)
- Add confidence scoring and relationship inference
- Handle files of any size via selective retrieval

### Phase 4: Search Tools
- Implement direct search tools (files, keywords, semantic, context)
- Integrate ripgrep for keyword search
- Build in-memory vector similarity search
- Create agent orchestration tool (multi-phase retrieval + synthesis)

### Phase 5: Integration & Testing
- Wire into MCP server (`http-server.js`)
- Add configuration to `config.json`
- Implement incremental indexing (content hash detection)
- Performance benchmarks on real codebases (10k, 100k files)
- Memory profiling and optimization

---

## Edge Cases

### Large Files
- **Challenge**: Files with >100k lines
- **Solution**: Tree-sitter handles large files efficiently, LLM retrieves surgically (no context limit)

### Minified/Generated Code
- **Challenge**: Webpack bundles, compiled output
- **Solution**: Mark as low-priority in index, exclude from descriptions, still searchable by filename/path

### Syntax Errors
- **Challenge**: Tree-sitter parsing fails on invalid syntax
- **Solution**: Fall back to regex-based extraction, mark file as `parse_failed: true`, still index metadata

### Symlink Loops
- **Challenge**: Circular symlinks cause infinite recursion
- **Solution**: Track visited paths with Set, abort on cycles, configurable max depth

### Encoding Issues
- **Challenge**: Non-UTF-8 files
- **Solution**: Default UTF-8, try common encodings on failure, mark as binary if all fail

### Concurrent Index Updates
- **Challenge**: Multiple indexing operations
- **Solution**: Single index manager per server, queue concurrent requests, atomic saves

### Stale Index
- **Challenge**: Files changed since indexing
- **Solution**: Content hash comparison, incremental re-indexing, TTL warnings

---

## Notes

**Technology Choices**:
- **Tree-sitter**: Universal parser, battle-tested, 40+ languages, minimal overhead
- **Ripgrep**: Industry standard for code search, must be installed separately
- **LM Studio**: Local LLM infrastructure, supports parallel requests
- **Gemma 3**: Chosen for structured output reliability and speed

**Platform Support**:
- Cross-platform (Windows, Linux, macOS)
- Network paths supported (UNC paths on Windows)
- Symlink handling with cycle detection

**Integration Points**:
- MCP server notification system for progress updates
- Existing embedding model (shared with memory system)
- Existing LM Studio WebSocket infrastructure

---

## Contributors

- **@herrbasan** - Architecture and design
- **GitHub Copilot (Claude Sonnet 4.5)** - Planning and documentation

