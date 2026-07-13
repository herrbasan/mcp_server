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
mcp_workshop_tools({ method: "documentation.get", payload: { file: "Workshop/workshop.md" } })
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

If you run the workshop via a process manager, set:
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
5. Restart the workshop and reconnect the client.

---

## Forge — Persistent Custom Tool Catalog

Forge lets you write custom tools that persist across sessions. Use `agent.action` methods like `forge.list`, `forge.write`, `forge.update`, `forge.call`, and `forge.rollback`.

**This changes your default workflow:**

**At the start of every task, call `forge.list`.** Tools from past sessions are still there. A catalog of pre-built capabilities — codebase analyzers, data transformers, report generators — that you don't have to rewrite. You are not starting from zero. The tool you need might already exist.

**When you solve a problem you'll face again, `forge.write` it.** Don't let the work evaporate when the session ends. A one-shot script dies with the chat. A forged tool becomes permanent infrastructure. The next session — yours or another model's — picks it up from `forge.list`.

Call `forge.help` for the full authoring guide with the `ctx` API reference. Quick reference:

| `ctx` field | What it is | Lifetime |
|-------------|-----------|----------|
| `ctx.gateway.chat(...)` | Full LLM Gateway (same as you). Accepts `{ task?, model?, messages, systemPrompt?, ... }` — `task` resolves the Gateway's default for that task, `model` pins a specific Gateway model id (e.g. `'badkid-llama-chat'`). Omit both for full default routing. | Per-call proxy |
| `ctx.gateway.listModels(type?)` | Lists models available on the Gateway. Use to discover valid `model` ids before passing one to `chat`. `type` filter: `'chat'` or `'embedding'`. | Per-call proxy |
| `ctx.progress(...)` | Real-time progress to client | Per-call relay |
| `ctx.payload` | `Buffer[]` from file paths/URLs | Resolved before tool runs |
| `ctx.storagePath` | Persistent output dir | Survives, user-visible |
| `ctx.toolStatePath` | Persistent state (caches, indexes) | Survives, gitignored |
| `ctx.workspacePath` | Ephemeral temp dir | Deleted after call |

**`forge_call` args** (top-level caller surface):
- `name` — tool to execute (required)
- `args` — passed to the tool
- `payload` — file paths/URLs → `ctx.payload` Buffers
- `timeout` — ms (default 300000, max 600000)
- `model` — optional Gateway model id. When set, ALL `ctx.gateway.chat()` calls inside the tool route through this model unless the tool overrides per-call with its own `model` or non-default `task`. **Compatibility rule: tool authors should write model-agnostic tools** (omit `task` and `model` from chat calls) so the caller's pinned model takes effect. Hardcoding model ids in tools breaks portability.

**Workflow:**
1. `forge.list` — what's in the catalog?
2. `forge.write` — need something new? Build it. Git-versioned from the first commit.
3. `forge.call` — execute in isolated `worker_thread`. Timeout kills runaways.
4. `forge.update` — iterate. Every version saved. `forge.rollback` to undo.
5. `forge.list` — your tool is now permanent. Next session finds it.

**Existing tools you wrote**: `codebase_summary` — feed it a directory + focus, get an architectural analysis from the Gateway, saved to storage.
