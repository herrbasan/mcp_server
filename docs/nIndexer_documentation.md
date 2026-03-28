# nIndexer Documentation

## Overview

A WebSocket-first microservice for vector-based semantic search, keyword indexing, and file analysis of codebases. Built with native Node.js (no external dependencies).

---

## Quick Start

```bash
# Start the server
node src/server.js

# Server runs at:
# - HTTP: http://localhost:3666 (health check only)
# - WebSocket: ws://localhost:3666
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Client (MCP Orchestrator)               │
└─────────────────────────────┬───────────────────────────────┘
                              │ WebSocket / JSON-RPC
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               nIndexer WebSocket Server                     │
│                     (src/server.js)                         │
│                                                             │
│  HTTP Server ───► Health Check (/health)                   │
│  WebSocket ──────► JSON-RPC Router (src/api/router.js)     │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              CodebaseIndexingService                        │
│                  (src/services/)                            │
│                                                             │
│  Indexer ──────► nVDB (Rust vector DB)                     │
│  Metadata ────► SimpleMetadataStore (JSON)                 │
│  Grep ────────► ripgrep process                            │
│  LLM ─────────► LLM Gateway (HTTP/WS)                      │
└─────────────────────────────────────────────────────────────┘
```

---

## WebSocket API

### Connection

```
ws://localhost:3666
```

### Protocol

JSON-RPC 2.0 over WebSocket.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "method": "tool_name",
  "params": { ... }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "result": { ... }
}
```

**Error Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "unique-id",
  "error": {
    "code": -32000,
    "message": "Error description"
  }
}
```

---

## Tools Reference

### Indexing

#### `index_codebase`
Index a new codebase for semantic search.

```json
{
  "name": "my-project",
  "source": "//server/share/path/to/project",
  "analyze": false
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Codebase identifier |
| `source` | string | Yes | UNC path or absolute local path |
| `analyze` | boolean | No | Run LLM analysis after indexing (default: false) |

**Response:**
```json
{
  "name": "my-project",
  "source": "//server/share/path/to/project",
  "indexed": 125,
  "errors": 0,
  "duration": 10135,
  "rate": 12.33,
  "analysis": null
}
```

---

#### `refresh_codebase`
Incrementally update a codebase's index.

```json
{
  "name": "my-project",
  "analyze": false
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Codebase name |
| `analyze` | boolean | No | Re-run LLM analysis if stale |

---

#### `remove_codebase`
Remove a codebase from the index. Moved to `data/trash/` by default (can be recovered).

```json
{
  "name": "my-project",
  "permanent": false
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Codebase name |
| `permanent` | boolean | No | If `true`, permanently delete. If `false` (default), move to `data/trash/` |

---

### Search

#### `search` (hybrid)
Combined semantic + keyword search. **Recommended for most queries.**

```json
{
  "codebase": "my-project",
  "query": "authentication middleware",
  "strategy": "hybrid",
  "limit": 10
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `codebase` | string | Yes | Codebase name (supports partial match) |
| `query` | string | Yes | Search query |
| `strategy` | string | No | `hybrid` (default), `semantic`, `keyword` |
| `limit` | number | No | Max results (default: 10) |
| `filter` | object | No | `{ "language": "javascript" }` |

**Response:**
```json
{
  "results": [
    {
      "file": "my-project:src/auth/middleware.js",
      "path": "src/auth/middleware.js",
      "score": 0.87,
      "semanticScore": 0.9,
      "keywordScore": 0.7,
      "language": "javascript",
      "functions": ["authenticate", "authorize"],
      "classes": []
    }
  ],
  "count": 1,
  "strategy": "hybrid"
}
```

---

#### `search_semantic`
Pure embedding-based semantic search. Best for concept queries.

```json
{
  "codebase": "my-project",
  "query": "how is authentication implemented?",
  "limit": 10
}
```

---

#### `search_keyword`
Fast indexed keyword search. Best for exact matches on names.

```json
{
  "codebase": "my-project",
  "query": " authenticate",
  "limit": 20,
  "searchContent": true
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `searchContent` | boolean | No | Search file content (default: true) |

---

#### `grep_codebase`
Live regex search using ripgrep. Always current (reads filesystem).

```json
{
  "codebase": "my-project",
  "pattern": "function.*auth",
  "regex": true,
  "limit": 50,
  "maxMatchesPerFile": 5
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `pattern` | string | Yes | Search pattern |
| `regex` | boolean | No | Use regex (default: true) |
| `caseSensitive` | boolean | No | Case sensitive (default: false) |
| `pathPattern` | string | No | Filter by path glob |
| `maxMatchesPerFile` | number | No | Max matches per file (default: 5) |

---

#### `search_all_codebases`
Search across all indexed codebases at once.

```json
{
  "query": "websocket handler",
  "strategy": "hybrid",
  "limit": 20,
  "perCodebaseLimit": 5
}
```

---

### File Operations

#### `get_file`
Read file content with staleness check.

```json
{
  "codebase": "my-project",
  "path": "src/main.js"
}
```

**Response:**
```json
{
  "content": "// file content...",
  "stale": false,
  "lastIndexed": "2026-03-27T10:00:00.000Z"
}
```

---

#### `get_file_info`
Get file structure (functions, classes, imports).

```json
{
  "codebase": "my-project",
  "path": "src/main.js"
}
```

**Response:**
```json
{
  "file": "my-project:src/main.js",
  "path": "src/main.js",
  "mtime": "2026-03-26T15:30:00.000Z",
  "size": 1523,
  "language": "javascript",
  "functions": ["main", "init"],
  "classes": ["App"],
  "imports": ["fs", "path"]
}
```

---

#### `get_file_tree`
List files in a directory.

```json
{
  "codebase": "my-project",
  "path": "src"
}
```

---

### Analysis

#### `analyze_codebase`
Run LLM analysis to generate project description.

```json
{
  "name": "my-project"
}
```

**Response:**
```json
{
  "name": "my-project",
  "analyzed": true,
  "description": "A stateless API gateway...",
  "duration": 28951,
  "filesAnalyzed": 25
}
```

---

#### `get_codebase_description`
Get LLM-generated description with staleness check.

```json
{
  "name": "my-project"
}
```

**Response:**
```json
{
  "name": "my-project",
  "hasAnalysis": true,
  "stale": false,
  "description": "A stateless API gateway...",
  "purpose": "Routes requests to provider-specific adapters...",
  "insights": {
    "architecture": "modular",
    "techStack": ["nodejs", "express"],
    "keyConcepts": ["API gateway", "adapter pattern"],
    "coreModules": ["model-routing", "adapter-registry"]
  },
  "keyFiles": {
    "high": ["README.md", "src/main.js"],
    "medium": ["src/config.js"],
    "low": ["tests/*.test.js"]
  },
  "entryPoints": ["src/main.js", "src/server.js"],
  "analyzedAt": "2026-03-27T17:14:11.755Z"
}
```

---

#### `get_prioritized_files`
Get files ordered by importance.

```json
{
  "name": "my-project"
}
```

---

### Maintenance

#### `check_codebase_status`
Check staleness status of a codebase.

```json
{
  "codebase": "my-project"
}
```

**Response:**
```json
{
  "codebase": "my-project",
  "totalFiles": 125,
  "staleFiles": 3,
  "missingFiles": 0,
  "lastIndexed": "2026-03-27T10:00:00.000Z"
}
```

---

#### `run_maintenance`
Run maintenance with configurable options for indexing and analysis.

```json
{
  "codebase": "my-project",
  "reindex": "if_missing",
  "analyze": true
}
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `codebase` | string | No | Specific codebase to maintain (omit for all) |
| `reindex` | string | No | Reindex mode: `"if_missing"` (build if not exists), `"changed"` (update existing), `"always"` (rebuild), `null` (check only) |
| `analyze` | boolean | No | Run LLM analysis after indexing/changes (default: false) |

**Reindex Modes:**
- `null` (default) - Check for changes only. If codebase doesn't exist, return error.
- `"if_missing"` - Check for changes; if codebase not indexed, build from `data/codebases.json` source.
- `"changed"` - Check for changes and update only (like refresh).
- `"always"` - Force rebuild of existing index.

**Orphaned Codebases:**
If an indexed codebase is no longer in `data/codebases.json`, it will be automatically moved to `data/trash/`.

**Common Usage Patterns:**

```json
// Smart maintenance: build if missing, check changes if exists, analyze after
{
  "codebase": "my-project",
  "reindex": "if_missing",
  "analyze": true
}

// Quick sync: only check and update changed files
{
  "codebase": "my-project",
  "reindex": "changed"
}

// Full rebuild with analysis
{
  "codebase": "my-project",
  "reindex": "always",
  "analyze": true
}
```

Omit `codebase` to run on all codebases in `data/codebases.json`.

---

#### `get_maintenance_stats`
Get maintenance statistics.

```json
{}
```

---

### Utility

#### `ping`
Health check ping.

```json
{}
```

**Response:**
```json
{ "pong": true, "timestamp": 1774630226437 }
```

---

#### `list_codebases`
List all indexed codebases.

```json
{}
```

**Response:**
```json
[
  {
    "name": "llm_gateway",
    "source": "//BADKID/Stuff/DEV/LLM Gateway",
    "files": 125,
    "lastIndexed": "2026-03-27T17:04:35.738Z",
    "status": "current",
    "hasAnalysis": true
  }
]
```

---

## Configuration

### `data/codebases.json`

Defines codebases to index.

```json
{
  "codebases": {
    "my-project": "//server/share/path/to/project",
    "other-project": "d:/projects/other"
  }
}
```

### `config.json`

Service configuration.

```json
{
  "service": {
    "host": "localhost",
    "port": 3666
  },
  "storage": {
    "dataDir": "./data/codebases"
  },
  "indexing": {
    "embeddingDimension": 768,
    "maxFileSize": 1048576,
    "ignorePatterns": ["node_modules", ".git", "dist"],
    "batchSize": 25
  },
  "maintenance": {
    "enabled": true,
    "intervalMs": 3600000
  },
  "llm": {
    "gatewayWsUrl": "ws://localhost:3400/v1/realtime",
    "gatewayHttpUrl": "http://localhost:3400",
    "embedModel": "lmstudio-embed",
    "models": {
      "query": "glm5-chat",
      "analysis": "glm5-chat"
    }
  }
}
```

---

## Example Client (JavaScript)

```javascript
const ws = new WebSocket('ws://localhost:3666');

ws.onopen = () => {
  // Search example
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: '1',
    method: 'search',
    params: {
      codebase: 'llm_gateway',
      query: 'websocket connection handling',
      limit: 5
    }
  }));
};

ws.onmessage = (e) => {
  const response = JSON.parse(e.data);
  if (response.result) {
    console.log('Results:', response.result);
  } else if (response.error) {
    console.error('Error:', response.error);
  }
};
```

---

## Example Client (Python)

```python
import asyncio
import json
import websockets

async def main():
    uri = "ws://localhost:3666"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": "1",
            "method": "list_codebases",
            "params": {}
        }))
        response = await ws.recv()
        print(json.loads(response))

asyncio.run(main())
```

---

## HTTP Endpoints

### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3666/health
```

**Response:**
```json
{
  "status": "ok",
  "service": "nIndexer",
  "version": "1.0.0",
  "timestamp": "2026-03-27T17:00:00.000Z"
}
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| `-32600` | Invalid Request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32700` | Parse error |
| `-32000` | Service error (with message) |

---

## Dependencies

**None.** Uses only Node.js built-in modules:
- `http` - HTTP server
- `crypto` - WebSocket handshake
- `fs` - File system access
- `path` - Path manipulation
- `WebSocket` - Native WebSocket (Node.js 21+)
- `fetch` - Native fetch (Node.js 21+)

### External Services Required

1. **LLM Gateway** (port 3400) - For embeddings and analysis
2. **nVDB** - Rust vector database (compiled binary included)

---

## Project Structure

```
nIndexer/
├── src/
│   ├── server.js              # WebSocket/HTTP server
│   ├── api/
│   │   └── router.js         # JSON-RPC message routing
│   ├── services/
│   │   ├── indexing.service.js    # Main service
│   │   ├── indexer.service.js     # File walking, embedding
│   │   ├── search-router.service.js # Hybrid search
│   │   ├── grep.service.js        # ripgrep integration
│   │   ├── metadata.service.js    # JSON metadata store
│   │   └── ...
│   ├── llm-client.js          # LLM Gateway client
│   └── config.js              # Config loader
├── nVDB/                      # Rust vector DB (submodule)
├── data/
│   ├── codebases/             # Indexed data (gitignored)
│   └── codebases.json         # Codebase definitions
└── config.json                # Service config
```

---

## CLI Usage

```bash
# Start server
node src/server.js

# Development mode (auto-reload)
npm run dev

# Or with npm
npm start
```
