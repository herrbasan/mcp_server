# Workshop MCP — Compact Endpoint Reference

> **Endpoint**: `http://HOST:3100/mcp/compact` (HTTP+SSE) or `http://HOST:3100/sse/compact` (legacy SSE)  
> **Protocol**: MCP JSON-RPC over SSE  
> **One tool**: `tools` — call every agent method via `agent.action`.

The compact endpoint exposes a **single** MCP tool named `tools`. Pass `method` in `agent.action` format and `payload` with the arguments. The orchestrator routes the call to the right agent internally.

```javascript
mcp_workshop_tools({
  method: "agent.action",
  payload: { /* method arguments */ }
})
```

---

## Quick Start

1. **Call this first** to see what you already know:
   ```javascript
   mcp_workshop_tools({ method: "memory.overview" })
   ```

2. **List storage files**:
   ```javascript
   mcp_workshop_tools({ method: "storage.list", payload: { path: "", recursive: false } })
   ```

3. **Read a doc**:
   ```javascript
   mcp_workshop_tools({ method: "documentation.get", payload: { file: "coding-philosophy.md" } })
   ```

---

## Calling Convention

Every compact call uses the same JSON-RPC shape:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "tools",
    "arguments": {
      "method": "memory.recall",
      "payload": { "query": "WebSocket reconnect", "limit": 5 }
    }
  },
  "id": 1
}
```

Response bodies are JSON text inside `content[0].text`:

```json
{
  "content": [{ "type": "text", "text": "{ ... }" }],
  "isError": false
}
```

Parse `content[0].text` to get the actual result object.

---

## Agents & Methods

### MEMORY
Persistent semantic memory. **Store aggressively** — you forget everything between sessions.

| Method | Payload | Purpose |
|--------|---------|---------|
| `memory.overview` | `{ format?: "summary" \| "full" }` | Start here. See clusters, bridges, top nodes. |
| `memory.recall` | `{ query*, limit?, category? }` | Search memories by semantic similarity. |
| `memory.store` | `{ description*, category?, confidence?, data? }` | Save a memory. |
| `memory.get` | `{ id* }` | Get one memory including `data`. |
| `memory.list` | `{ category? }` | Browse memories. |
| `memory.update` | `{ id*, description?, category?, confidence?, data? }` | Edit a memory. |
| `memory.forget` | `{ id* }` | Delete a memory. |
| `memory.dream_generate` | `{ force?: boolean }` | Run memory consolidation manually. |
| `memory.dream_status` | `{}` | Check dreamer state. |
| `memory.dream_inject` | `{ format?: "json" \| "prompt" }` | Get map for prompt injection. |

### BROWSER
Persistent headless browser (Puppeteer) with sessions.

| Method | Payload | Purpose |
|--------|---------|---------|
| `browser.session_create` | `{ viewport?, userAgent?, visible? }` | Create a browser session. |
| `browser.session_list` | `{}` | List active sessions. |
| `browser.session_close` | `{ sessionId* }` | Close a session. |
| `browser.session_metadata` | `{ sessionId* }` | Get session metadata. |
| `browser.goto` | `{ sessionId*, url*, waitFor?, timeout?, retries? }` | Navigate. |
| `browser.click` | `{ sessionId*, selector*, waitAfter?, mode?, retries? }` | Click element. |
| `browser.fill` | `{ sessionId*, fields*: [{selector,value}], submit?, waitAfter?, mode?, retries? }` | Fill form. |
| `browser.scroll` | `{ sessionId*, direction?, amount? }` | Scroll page. |
| `browser.type` | `{ sessionId*, selector?, text?, delay?, keystrokes? }` | Type keystrokes. |
| `browser.content` | `{ sessionId*, mode?: "text" \| "html" \| "markdown" \| "screenshot" }` | Get page content. |
| `browser.evaluate` | `{ sessionId*, script*, waitFor? }` | Run JS in page. |
| `browser.inspect` | `{ sessionId*, selector*, screenshot? }` | Inspect element. |
| `browser.console` | `{ sessionId* }` | Get captured console messages. |
| `browser.wait` | `{ sessionId*, selectors?, text?, urlPattern?, condition?, timeout? }` | Wait for condition. |
| `browser.research` | `{ query*, engines?: ["google" \| "duckduckgo" \| "bing"], max_pages? }` | Quick web research. |

### GIT
GitHub API relay.

| Method | Payload |
|--------|---------|
| `git.read` | `{ owner*, repo*, path?, branch? }` |
| `git.tree` | `{ owner*, repo*, path?, branch? }` |
| `git.log` | `{ owner*, repo*, path?, branch?, limit? }` |
| `git.commit` | `{ owner*, repo*, sha* }` |
| `git.diff` | `{ owner*, repo*, base*, head* }` |
| `git.branches` | `{ owner*, repo*, type?: "branches" \| "tags", limit? }` |
| `git.repo_info` | `{ owner*, repo* }` |
| `git.search_repos` | `{ query*, limit? }` |
| `git.search_code` | `{ query*, limit? }` |
| `git.search_issues` | `{ query*, limit? }` |
| `git.pr_list` | `{ owner*, repo*, state?, limit? }` |
| `git.pr_get` | `{ owner*, repo*, number* }` |
| `git.issue_list` | `{ owner*, repo*, state?, labels?, limit? }` |
| `git.issue_get` | `{ owner*, repo*, number*, comments? }` |
| `git.issue_create` | `{ owner*, repo*, title*, body?, labels?, assignees? }` |

### VISION
Iterative image analysis.

| Method | Payload |
|--------|---------|
| `vision.session_create` | `{ image_url? \| image_data+image_mime_type? }` |
| `vision.session_list` | `{}` |
| `vision.session_get` | `{ session_id* }` |
| `vision.session_close` | `{ session_id* }` |
| `vision.analyze` | `{ session_id*, query?, focus?, include_context? }` |

### LLM
Direct LLM query.

| Method | Payload |
|--------|---------|
| `llm.query` | `{ prompt*, files?: string[], systemPrompt? }` |

### DOCUMENTATION
Query the `mcp_documentation/` and `LLM_Docs` knowledge bases.

| Method | Payload | Purpose |
|--------|---------|---------|
| `documentation.domains` | `{}` | **Start here.** Lightweight domain list. |
| `documentation.list` | `{ domain? }` | Full listing with per-file metadata. |
| `documentation.get` | `{ file*, lines?: [start,end] }` | Read a specific doc. Path: `DomainName/filename.md`. |
| `documentation.query` | `{ question*, domain?, files? }` | LLM-powered search/Q&A/spec alignment. |

### STORAGE
Scoped filesystem under the configured storage root.

| Method | Payload |
|--------|---------|
| `storage.stat` | `{ path* }` |
| `storage.read` | `{ path*, encoding?: "utf8" \| "base64" }` |
| `storage.write` | `{ path*, content*, encoding?: "utf8" \| "base64" }` |
| `storage.list` | `{ path?, recursive? }` |
| `storage.move` | `{ from*, to* }` |
| `storage.delete` | `{ path*, recursive? }` |

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
