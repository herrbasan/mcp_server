# WebAdmin API Reference

The MCP server exposes a REST API at `/api/*` exclusively for the WebAdmin application.
All `/api/*` endpoints are **localhost-only** — requests from any non-loopback address receive `403 Forbidden`.

**Base URL**: `http://localhost:3100`

---

## Security Model

No token auth is required. Security is enforced by loopback binding only (`req.socket.remoteAddress` must be `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`). Both the MCP server and the WebAdmin run on the same machine — this is intentional and sufficient.

**Never expose port 3100 to the external network** if you want to preserve this guarantee.

---

## Tool Scoping

Tools are split into two categories:

| Category | Exposed via MCP `tools/list`? | Callable via `/api`? |
|---|---|---|
| Public tools | ✅ Yes | ✅ Yes |
| Admin-only tools | ❌ No | ✅ Yes |

### Current Admin-Only Tools (codebase management)

| Tool | Description |
|---|---|
| `index_codebase` | Index a new codebase for semantic search |
| `refresh_codebase` | Incremental refresh of a codebase index |
| `remove_codebase` | Remove a codebase and all its data |
| `analyze_codebase` | Run LLM analysis to generate project description |
| `run_maintenance` | Manually trigger maintenance cycle |
| `get_maintenance_stats` | Get maintenance statistics and status |

Admin-only tools are flagged with `"adminOnly": true` in the agent's `config.json`. The loader automatically separates them from the public tool list.

---

## Endpoints

### `GET /api/tools`

Returns all tools — both public and admin-only. Each admin-only tool has `adminOnly: true`.

**Response**:
```json
{
  "tools": [
    { "name": "search_codebase", "description": "...", "inputSchema": { ... } },
    { "name": "index_codebase", "adminOnly": true, "description": "...", "inputSchema": { ... } }
  ]
}
```

---

### `POST /api/tools/call`

Call any tool by name, including admin-only tools.

**Request**:
```json
{
  "name": "index_codebase",
  "args": {
    "name": "MyProject",
    "space": "BADKID-DEV",
    "project": "MyProject"
  }
}
```

**Response**: MCP tool result object:
```json
{
  "content": [{ "type": "text", "text": "..." }],
  "isError": false
}
```

**Examples**:

List codebases:
```json
POST /api/tools/call
{ "name": "list_codebases", "args": {} }
```

Index a new codebase:
```json
POST /api/tools/call
{ "name": "index_codebase", "args": { "name": "SoundApp", "space": "COOLKID-Work", "project": "SoundApp" } }
```

Refresh a codebase:
```json
POST /api/tools/call
{ "name": "refresh_codebase", "args": { "name": "SoundApp" } }
```

Remove a codebase:
```json
POST /api/tools/call
{ "name": "remove_codebase", "args": { "name": "SoundApp" } }
```

Run LLM analysis:
```json
POST /api/tools/call
{ "name": "analyze_codebase", "args": { "name": "SoundApp" } }
```

Get codebase description:
```json
POST /api/tools/call
{ "name": "get_codebase_description", "args": { "name": "SoundApp" } }
```

Run maintenance:
```json
POST /api/tools/call
{ "name": "run_maintenance", "args": {} }
```

---

### `GET /api/config`

Returns the full `config.json` as JSON.

**Response**:
```json
{
  "orchestrator": { "name": "mcp-orchestrator", "version": "2.0.0", "host": "0.0.0.0", "port": 3100 },
  "gateway": { "wsUrl": "ws://localhost:3400/v1/realtime", "httpUrl": "http://localhost:3400" },
  "models": {
    "query": "glm-chat",
    "inspect": "glm-chat",
    "synthesis": "glm-chat",
    "analysis": "glm-chat",
    "embed": "lmstudio-embed"
  },
  "spaces": { ... },
  "agents": { ... }
}
```

---

### `PATCH /api/config`

Deep-merges a partial update into `config.json`. Persists to disk immediately and live-updates the running server's config.

Only the keys you provide are changed — all other keys are preserved.

**Request**: Any subset of the config structure.

**Response**:
```json
{ "ok": true, "config": { ...full updated config... } }
```

**Examples**:

Update model assignments:
```json
PATCH /api/config
{
  "models": {
    "query": "qwen2.5-coder-14b",
    "analysis": "qwen2.5-coder-14b"
  }
}
```

Update gateway URL:
```json
PATCH /api/config
{
  "gateway": { "httpUrl": "http://localhost:3401" }
}
```

Update codebase maintenance interval:
```json
PATCH /api/config
{
  "agents": {
    "codebase": {
      "maintenance": { "intervalMs": 7200000 }
    }
  }
}
```

---

## Config Structure Reference

```json
{
  "orchestrator": {
    "name": "string",
    "version": "string",
    "host": "string",   // binding host (0.0.0.0 for network access)
    "port": 3100
  },
  "gateway": {
    "wsUrl": "ws://localhost:3400/v1/realtime",
    "httpUrl": "http://localhost:3400"
  },
  "models": {
    "query": "string",      // tool: query_model
    "inspect": "string",    // tool: inspect_code
    "synthesis": "string",  // tool: research_topic
    "analysis": "string",   // search analyze:true, analyze_codebase
    "embed": "string"       // embeddings (memory, codebase indexing)
  },
  "spaces": {
    "SPACE_NAME": ["\\\\UNC\\path", "D:\\local\\path"]
  },
  "agents": {
    "browser": {
      "timeout": 30000,
      "idleTimeout": 300000,
      "viewport": { "width": 1280, "height": 1800 },
      "userDataDir": "data/chrome-profile"
    },
    "memory": {
      "storePath": "data/memories.json"
    },
    "research": {
      "maxPages": 10,
      "timeout": 300000,
      "searchEngines": ["google", "duckduckgo"]
    },
    "codebase": {
      "dataDir": "data/codebases",
      "embeddingDimension": 768,
      "maxFileSize": 1048576,
      "maintenance": {
        "enabled": true,
        "intervalMs": 3600000,
        "autoRefresh": true,
        "staleThresholdMs": 300000
      }
    }
  }
}
```

---

## Notes for WebAdmin Implementation

- **Long-running operations** (`index_codebase`, `refresh_codebase`, `analyze_codebase`) block until complete. Consider calling them from a background job with polling, or stream progress via the MCP SSE transport if needed.
- **`list_codebases`** returns index metadata including file count, last indexed timestamp, and whether LLM analysis is available/stale.
- **Spaces** (`GET /api/config` → `spaces`) are used to resolve short project paths. The UI should let the user pick a space + project name rather than requiring an absolute path.
- The `models` config keys map directly to gateway model IDs. The WebAdmin UI for model selection should fetch available models from the gateway separately (gateway API at `config.gateway.httpUrl`).
