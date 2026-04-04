# MCP Server Orchestrator

A centralized Model Context Protocol (MCP) server that hosts multiple domain-specific agents and exposes a single unified interface to clients via Server-Sent Events (SSE).

## Features

- **Agent architecture** — domain-specific modules (browser, codebase, memory, research, inspector) that own their own state and tools
- **LLM Gateway integration** — thin WebSocket client to an external LLM Gateway; no model providers embedded
- **Codebase indexing** — semantic code search via nDB vector database
- **Browser automation** — persistent Puppeteer browser for web research and scraping
- **Semantic memory** — vector embedding-based recall across sessions

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and set the gateway endpoints:

```env
GATEWAY_URL=ws://localhost:3400/v1/realtime
GATEWAY_HTTP_URL=http://localhost:3400
```

### 3. Configure models

Open `config.json` and set the model names in the `models` section. Each key maps a task type to the model identifier your LLM Gateway expects.

```json
"models": {
    "query":     "qwen2.5-coder-14b",
    "inspect":   "qwen2.5-coder-14b",
    "synthesis": "qwen2.5-coder-14b",
    "analysis":  "qwen2.5-coder-14b",
    "embed":     "nomic-embed-text-v2-moe"
}
```

| Task key    | Used by                                     | Recommended model type      |
|-------------|---------------------------------------------|-----------------------------|
| `query`     | `query_model` tool                          | General-purpose chat model  |
| `inspect`   | `inspect_code` tool                         | Code-capable chat model     |
| `synthesis` | `research_topic`, `reflect_on_session`      | Long-context chat model     |
| `analysis`  | Research evaluation phase                   | Fast reasoning model        |
| `embed`     | `memory_remember`, `memory_recall` (via Gateway HTTP)     | Text embedding model        |

Model names must match what your LLM Gateway recognizes. All keys fall back to `process.env.DEFAULT_MODEL` and then `'default'` if unset.

### 4. Start the server

```bash
npm start
```

The MCP SSE endpoint is available at `http://<HOST>:<PORT>/sse`.

### 5. Connect a client

In VS Code `mcp.json`:

```json
{
    "servers": {
        "orchestrator": {
            "type": "sse",
            "url": "http://localhost:3100/sse"
        }
    }
}
```

---

## Architecture

```
Client (VS Code / CLI)
        | SSE (custom transport)
        v
   MCP Orchestrator  (src/server.js)
        | WebSocket
        v
   LLM Gateway  (external — localhost:3400)
```

**Key files:**

| File | Purpose |
|------|---------|
| `src/server.js` | Express + custom SSE transport, JSON-RPC routing |
| `src/agent-loader.js` | Scans `src/agents/`, auto-loads prompts, init/shutdown lifecycle |
| `src/gateway-client.js` | WebSocket + HTTP client to the LLM Gateway |
| `src/agents/` | One folder per agent domain |

**Configuration:**

| File | Contents |
|------|----------|
| `.env` | Secrets and runtime endpoints (`GATEWAY_URL`, `GATEWAY_HTTP_URL`, `MAX_MEMORY_CHARS`) |
| `config.json` | Non-secret settings: model names per task, agent options, port binding |

---

## Agents

| Agent      | Tools | Description |
|------------|-------|-------------|
| `browser`  | *(shared service)* | Persistent Puppeteer browser pool |
| `codebase` | `index_codebase`, `search_codebase`, `list_codebases`, … | nDB-powered semantic code search |
| `docs`     | `get_documentation`, `list_documents`, `read_document` | Access `mcp_documentation/` files |
| `inspector`| `inspect_code` | LLM-based code review with file loading |
| `llm`      | `query_model`, `get_query_status` | Direct LLM queries (async by default) |
| `memory`   | `memory_remember`, `memory_recall`, `memory_forget`, `memory_list`, `memory_update`, `reflect_on_session`, `apply_reflection_changes` | Semantic vector memory |
| `research` | `research_topic` | Multi-phase web research pipeline |

---

## License
MIT