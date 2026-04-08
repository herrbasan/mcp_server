# MCP Server Orchestrator

A centralized Model Context Protocol (MCP) server that hosts multiple domain-specific agents and exposes a single unified interface to clients via Server-Sent Events (SSE).

## Features

- **Agent architecture** — domain-specific modules (browser, codebase, docs, inspector, llm, memory, nui_docs, research, vision) that own their own state and tools
- **LLM Gateway integration** — thin WebSocket client to an external LLM Gateway at localhost:3400
- **Codebase indexing** — semantic code search via nIndexer service (nDB vector database on port 3666)
- **Browser automation** — persistent Puppeteer browser with session management for web research and scraping
- **Semantic memory** — vector embedding-based recall across sessions
- **NUI Docs** — documentation access for the NUI web component library
- **Vision analysis** — iterative image analysis with drill-down focus capability

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
    "embed":     "nomic-embed-text-v2-moe",
    "vision":    "kimi-chat"
}
```

| Task key    | Used by                                     | Recommended model type      |
|-------------|---------------------------------------------|-----------------------------|
| `query`     | `query_model` tool                          | General-purpose chat model  |
| `inspect`   | `inspect_code` tool                         | Code-capable chat model     |
| `synthesis` | `research_topic`                            | Long-context chat model     |
| `analysis`  | Research evaluation phase                   | Fast reasoning model        |
| `embed`     | `memory_remember`, `memory_recall`, code indexing (via Gateway HTTP) | Text embedding model        |
| `vision`    | `vision_analyze` tool                                     | Vision-language model       |

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
| `browser`  | `browser_session_create`, `browser_session_goto`, `browser_session_click`, … (14 tools) | Persistent Puppeteer browser with session management |
| `codebase` | `index_codebase`, `search_codebase`, `search_keyword`, `search_semantic`, `grep_codebase`, `get_file`, `get_file_info`, `analyze_codebase`, … (18 tools) | nDB-powered semantic code search via nIndexer |
| `docs`     | `get_philosophy`, `get_orchestrator_doc` | Access `mcp_documentation/` files |
| `inspector`| `inspect_code` | LLM-based code review with file loading |
| `llm`      | `query_model` | Direct LLM queries via Gateway |
| `memory`   | `memory_remember`, `memory_recall`, `memory_forget`, `memory_list`, `memory_update` | Semantic vector memory |
| `nui_docs` | `nui_list_components`, `nui_get_component`, `nui_get_guide`, `nui_get_reference`, `nui_get_css_variables`, `nui_get_icons` | NUI web component library docs |
| `research` | `research_topic` | Multi-phase web research pipeline |
| `vision`   | `vision_create_session`, `vision_analyze`, `vision_list_sessions`, `vision_get_session`, `vision_close_session` | Iterative image analysis with drill-down |

---

## License
MIT