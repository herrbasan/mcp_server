# MCP Server Workshop

A centralized Model Context Protocol (MCP) server that hosts multiple domain-specific agents and exposes a single unified interface to clients via Server-Sent Events (SSE).

## Features

- **Agent architecture** — domain-specific modules (browser, docs, github, inspector, llm, memory, research, vision) that own their own state and tools
- **LLM Gateway integration** — thin WebSocket client to an external LLM Gateway at localhost:3400
- **Browser automation** — persistent Puppeteer browser with session management for web research and scraping
- **Semantic memory** — vector embedding-based recall across sessions
- **Dreaming system** — hourly autonomous memory consolidation into a structured Map with clusters, bridges, and progressive compression
- **GitHub relay** — browse code, history, PRs, issues from any GitHub repo without local checkout
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

### 3. Configure environment (continued)

Model routing is handled by the LLM Gateway. See the Gateway's configuration for task-to-model mapping.

### 4. Run the storage and retrieval services

The MCP server talks to two standalone Rust services over localhost HTTP — no native `.node` addons or ONNX runtimes live in Node:

- **`ndb serve`** (`http://127.0.0.1:8323`, configured under `ndb` in `config.json`) — System of Record for `memories`, `notepad`, and `codereview`:
  ```bash
  ndb serve --config <path-to-ndb-serve.json>
  ```
- **`nvdb serve`** (`http://127.0.0.1:3510`, configured under `agents.vdb.serviceUrl`) — hybrid lexical/vector/rerank search for `storage` and `memory`:
  ```bash
  nvdb serve --dir <index-path> --host 127.0.0.1 --port 3510 --reranker-model <modelDir>
  ```

Start both before the server. It aborts at startup if either service is unreachable, a required DB is unmounted, or reranking is enabled while `nvdb serve` has no loaded reranker. Details: `documentation/tools/vdb.md`, `documentation/tools/memory.md`, `documentation/tools/notepad.md`.

### 5. Start the server

```bash
npm start
```

The MCP endpoint is available at `http://<HOST>:<PORT>/sse/compact` (SSE) or `http://<HOST>:<PORT>/mcp/compact` (streamable HTTP). Both serve the single unified `tools` tool — all agent methods are invoked through it via `agent.action` routing.

### 6. Connect a client

In VS Code `mcp.json`:

```json
{
    "servers": {
        "workshop": {
            "type": "sse",
            "url": "http://localhost:3100/sse/compact"
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
   MCP Workshop  (src/server.js)
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
| `.env` | Secrets and runtime endpoints (`GATEWAY_URL`, `GATEWAY_HTTP_URL`, `GIT_TOKEN`, `MAX_MEMORY_CHARS`) |
| `config.json` | Non-secret settings: agent options, port binding |

---

## Agents

| Agent      | Tools | Description |
|------------|-------|-------------|
| `browser`  | `browser_session_create`, `browser_session_goto`, `browser_session_click`, … (14 tools) | Persistent Puppeteer browser with session management |
| `documentation` | `documentation_list`, `documentation_get`, `documentation_query` | Browse and query LLM_Docs knowledge base with LLM-powered Q&A |
| `dreaming` | `dream_generate`, `dream_status`, `dream_inject` | Autonomous memory consolidation into structured Map |
| `forge`    | `forge_write`, `forge_update`, `forge_read`, `forge_list`, `forge_delete`, `forge_call`, `forge_history`, `forge_rollback`, `forge_help` (9 tools) | Git-versioned tool forge — LLMs create, version, and execute custom tools in isolated worker_threads with Gateway access |
| `github`   | `git_read_file`, `git_list_tree`, `git_log`, `git_get_commit`, `git_diff`, `git_list_branches`, `git_search_repos`, `git_search_code`, `git_search_issues`, `git_repo_info`, `git_pr_list`, `git_get_pr`, `git_issue_list`, `git_get_issue`, `git_create_issue` (15 tools) | GitHub repo relay — browse code, history, PRs, issues from any repo |
| `inspector`| `inspect_code` | LLM-based code review with file loading |
| `llm`      | `query_model` | Direct LLM queries via Gateway |
| `memory`   | `memory_store`, `memory_recall`, `memory_get`, `memory_forget`, `memory_list`, `memory_update`, `memory_overview` | Semantic vector memory |
| `print`    | `print_render`, `print_preview` | MD-Blocks → PDF via nui_wc2, semantic page breaks, exact PDF page previews |
| `research` | `research_topic` | Multi-phase web research pipeline |
| `vision`   | `vision_create_session`, `vision_analyze`, `vision_list_sessions`, `vision_get_session`, `vision_close_session` | Iterative image analysis with drill-down |

---

## License
MIT