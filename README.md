# MCP Server Orchestrator

A centralized Model Context Protocol (MCP) server that hosts multiple domain-specific agents and exposes a single unified interface to clients via Server-Sent Events (SSE).

## Features

- **Agent architecture** — domain-specific modules (browser, docs, github, inspector, llm, memory, research, vision) that own their own state and tools
- **LLM Gateway integration** — thin WebSocket client to an external LLM Gateway at localhost:3400
- **Browser automation** — persistent Puppeteer browser with session management for web research and scraping
- **Semantic memory** — vector embedding-based recall across sessions
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
| `.env` | Secrets and runtime endpoints (`GATEWAY_URL`, `GATEWAY_HTTP_URL`, `GIT_TOKEN`, `MAX_MEMORY_CHARS`) |
| `config.json` | Non-secret settings: agent options, port binding |

---

## Agents

| Agent      | Tools | Description |
|------------|-------|-------------|
| `browser`  | `browser_session_create`, `browser_session_goto`, `browser_session_click`, … (14 tools) | Persistent Puppeteer browser with session management |
| `docs`     | `get_philosophy`, `get_orchestrator_doc` | Access `mcp_documentation/` files |
| `github`   | `git_read_file`, `git_list_tree`, `git_log`, `git_get_commit`, `git_diff`, `git_list_branches`, `git_search_repos`, `git_search_code`, `git_search_issues`, `git_repo_info`, `git_pr_list`, `git_get_pr`, `git_issue_list`, `git_get_issue`, `git_create_issue` (15 tools) | GitHub repo relay — browse code, history, PRs, issues from any repo |
| `inspector`| `inspect_code` | LLM-based code review with file loading |
| `llm`      | `query_model` | Direct LLM queries via Gateway |
| `memory`   | `memory_store`, `memory_recall`, `memory_get`, `memory_forget`, `memory_list`, `memory_update` | Semantic vector memory |
| `research` | `research_topic` | Multi-phase web research pipeline |
| `vision`   | `vision_create_session`, `vision_analyze`, `vision_list_sessions`, `vision_get_session`, `vision_close_session` | Iterative image analysis with drill-down |

---

## License
MIT