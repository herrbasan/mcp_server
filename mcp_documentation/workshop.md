# Workshop MCP — Reference

> **Endpoint**: `http://HOST:3100/mcp/compact` (HTTP+SSE) or `http://HOST:3100/sse/compact` (legacy SSE)  
> **Protocol**: MCP JSON-RPC over SSE  
> **One tool**: `tools` — call every agent method via `agent.action`.

## Usage Reference

**The canonical usage guide is the tool description itself.** When you connect, the `tools/list` response includes full documentation for every method — what it does, when to use it, parameter schemas, and gotchas. Read it.

Quick examples:

```javascript
mcp_workshop_tools({ method: "memory.overview" })                         // Always first
mcp_workshop_tools({ method: "memory.recall", payload: { query: "..." } }) // Search memories
mcp_workshop_tools({ method: "documentation.get", payload: { file: "coding-philosophy.md" } })
mcp_workshop_tools({ method: "storage.list", payload: {} })
```

### Response format

Every call returns `{ content: [{ type: "text", text: "..." }], isError: false }`.
The actual result is in `content[0].text`. On error, `isError` is `true`.

---

## Client Configuration

### VS Code `mcp.json`

For the compact endpoint (recommended):

```json
{
  "inputs": [],
  "servers": {
    "workshop": {
      "type": "http",
      "url": "http://localhost:3100/mcp/compact"
    }
  }
}
```

For SSE (legacy or clients that require it):

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

### nPM / Process Manager

If you run the orchestrator via a process manager, set:
- **Path**: `D:\DEV\mcp_server\src`
- **Executable**: `node`
- **Arguments**: `server.js`

The server now loads `config.json` from the project root (`D:\DEV\mcp_server`), so the working directory no longer needs to be the project root.

---

## Important Rules

1. **Start with `memory.overview`**. You forget everything between sessions.
2. **Store aggressively**. The dreaming system deduplicates and compresses later.
3. **Use absolute file paths** for `inspect_code` and `llm.query` `files`.
4. **Tool handlers return `{ content: [{ type: "text", text: "..." }] }`**. Plain objects cause `r.content is not iterable` errors on the client.
5. **Restart + reconnect** after adding a new agent. Tool lists are built at startup and may be cached by the client.

---

## Adding a New Tool

1. Create `src/agents/<name>/` with `config.json` and `index.js`.
2. Add `agents.<name>` defaults to `config.json` if needed.
3. Wire `agent.action` methods into `COMPACT_TOOL.description` in `src/server.js`.
4. Add `agent.action` → `legacy_tool_name` mappings to `COMPACT_TO_LEGACY` in `src/server.js`.
5. Restart the orchestrator and reconnect the client.
