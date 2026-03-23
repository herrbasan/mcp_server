# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MCP Server Orchestrator** - A centralized MCP (Model Context Protocol) server running as an independent HTTP service. It acts as a meta-MCP with nested agent modules (browser, codebase, docs, inspector, llm, memory, research).

## Commands

```bash
npm start       # node src/server.js (production)
npm run dev      # node --watch src/server.js (development with auto-reload)
```

**Environment**: Configure via `.env` file. Sensitive config (endpoints, API keys) goes in `.env`; non-sensitive settings (models, timeouts) go in `config.json`.

## Architecture

### Server Entry Point
- [src/server.js](src/server.js) - Express server on port 3100 (configurable via PORT env var)
- Two MCP transports: Streamable HTTP (`/mcp`) for modern clients, Legacy SSE (`/sse` + `/message`) for VS Code Copilot
- Admin API endpoints under `/api/` (localhost-only): `GET /api/tools`, `POST /api/tools/call`, `GET/PATCH /api/config`

### Agent Plugin System
- [src/agent-loader.js](src/agent-loader.js) - Auto-discovers and loads agents from `src/agents/*/`
- Each agent is a directory with `config.json` + `index.js` + optional `prompts/*.txt`
- Agents are topologically sorted by `dependsOn` config, initialized in order, shut down in reverse
- Agents export named tool handlers; `adminOnly: true` in config restricts tools to localhost

### Agent Directories
| Agent | Purpose |
|-------|---------|
| `src/agents/browser/` | Persistent Puppeteer browser with page pooling |
| `src/agents/codebase/` | nDB vector database + search/indexing tools |
| `src/agents/docs/` | Documentation tools |
| `src/agents/inspector/` | LLM-based code analysis (inspect_code tool) |
| `src/agents/llm/` | LLM router connecting to local (LM Studio/Ollama) or cloud (Gemini) providers |
| `src/agents/memory/` | Semantic memory with embedding-based recall |
| `src/agents/research/` | Web research with Google/DuckDuckGo search + content extraction |

### LLM Router
- [src/router/](src/router/) - Pure functional multi-provider orchestrator
- Providers: LM Studio (local), Ollama (local), Gemini (cloud)
- Task-based routing: `query`, `inspect`, `analysis`, `synthesis`, `embedding`
- Auto-compaction for prompts exceeding context window

### Key Context Objects

**`globalContext`** (server.js:43):
```javascript
{ gateway, agents: Map<name, instance>, prompts: Map<name, object>, config }
```

**`requestContext`** passed to tool handlers:
```javascript
{ ...globalContext, progress: (msg, current, total) => {}, prompts: {...} }
```

## File Referencing

**Only absolute paths supported** in code analysis tools:
- Windows: `D:\Work\Project\file.js`
- UNC: `\\server\share\file.js`

Relative paths and hash IDs are not supported.

## Documentation

- [mcp_documentation/orchestrator.md](mcp_documentation/orchestrator.md) - Main tools guide
- [mcp_documentation/coding-philosophy.md](mcp_documentation/coding-philosophy.md) - Design philosophy

Access via MCP tools: `mcp_orchestrator_list_documents()`, `mcp_orchestrator_get_documentation()`

## Code Style

- **Vanilla JavaScript** (ES modules) - No TypeScript
- **Lean/simple/fast** - Minimal abstractions, direct implementations
- **Code optimized for LLMs** - Flat structures over deep hierarchies, explicit state over hidden `this.*` properties
- **No unnecessary complexity** - Prefer inline code when faster

## Dependencies

Key packages: `express`, `puppeteer`, `@modelcontextprotocol/sdk`, `@mozilla/readability`, `jsdom`, `zod`, `jose` (JWT)
