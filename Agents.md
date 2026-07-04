# MCP Server Workshop — LLM Briefing

**Project**: `mcp_server` (herrbasan/mcp_server)
**Purpose**: Centralized MCP server running as an independent HTTP service. Meta-MCP with nested agent modules.
**Prime directive**: `mcp_documentation/Agents_Prime.md` — read this first on every session.
**Tool reference**: `mcp_documentation/workshop.md` — full tool catalog and usage patterns.

## Architecture

- **Entry point**: `src/server.js` — HTTP server on port 3100.
- **Transport**: Per-session SSE mapped by `sessionId`.
- **Gateway client**: `src/gateway-client.js` — WebSocket to central LLM Gateway at localhost:3400.
- **Agents**: `src/agents/` — browser, documentation, dreaming, forge, github, inspector, llm, memory, research, storage, vision.
- **Loader**: `src/agent-loader.js` — loads agents and registers tools.
- **Config**: `config.json` (non-sensitive) + `.env` (sensitive).

## Important Conventions

- **Vanilla JS only** (ES modules). No TypeScript. No unnecessary abstractions.
- **Fail fast, fail loud**: no silent fallbacks, no defensive defaults.
- **Use IDE file tools** for edits; do not use terminal scripts to modify files.
- **Absolute paths only** for file references in tools (`D:\...` or `\\server\share\...`).
- **Local git state wins**: never pull/fetch/rebase/merge/reset/checkout over uncommitted changes without explicit user approval.

## MCP Endpoints

- **`/mcp/compact`** — primary. Single `tools` tool routes all agent methods via `agent.action` (e.g. `storage.write`, `memory.recall`).
- **`/mcp`** — legacy. Exposes every tool separately; kept for backward compatibility.

## Adding a New Tool

1. Create agent under `src/agents/<name>/`:
   - `config.json` with `agent`, `description`, `tools[]`
   - `index.js` exporting `init(context)` + one handler per tool
2. Add defaults to `config.json` under `agents.<name>` if needed.
3. Wire into `src/server.js`:
   - Add methods to `COMPACT_TOOL` description.
   - Add `agent.action` → `legacy_tool_name` mappings in `COMPACT_TO_LEGACY`.
4. Restart server and reconnect client.

## Tool Handler Return Format

All handlers must return:

```javascript
{ content: [{ type: 'text', text: '...' }], isError: false }
```

Plain objects cause compact-endpoint clients to fail with `r.content is not iterable`.

## Gateway Client

Use task-based routing. Examples:

```javascript
const gateway = createGatewayClient(wsUrl, httpUrl);
await gateway.chat({ task: 'query', messages: [...], systemPrompt: '...' });
await gateway.embedText('query');
```

Model routing is handled by the Gateway. Do not rely on a `models` section in `config.json`.

## Key Directories

- `src/` — server, gateway client, agent loader, agents.
- `src/agents/` — agent implementations.
- `mcp_documentation/` — curated docs served by the documentation agent.
- `docs/` — working documents (plans, handovers, notes).
- `data/` — runtime data: memories, dream maps, forge tools, storage.
- `tests/` — benchmarks and quick tests.
- `_Archive/` — archived modules and old plans.

## Running

```bash
npm start       # production
npm run dev     # watch mode
```

Bind `HOST=0.0.0.0` in `.env` for remote access.

## Useful Links

- Prime directive: `mcp_documentation/Agents_Prime.md`
- Tool reference: `mcp_documentation/workshop.md`
- LLM Gateway WebSocket API: `docs/LLM_GATEWAY_WEBSOCKET_API.md`
- LLM Gateway REST API: `docs/LLM_GATEWAY_REST_API.md`
