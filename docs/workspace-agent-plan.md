# Forge Agent — Feature Plan

> A git-versioned tool forge where LLMs create, store, and execute custom scripts with access to the Gateway and a unified payload API.

---

## Overview

A single agent — **Forge** — that gives LLM clients the ability to **write, version, and execute custom tools**. Tools are stored as git-versioned ES modules and executed in isolated `worker_threads` workers with real termination, per-call workspace directories, per-tool persistent state, and a unified payload+context API. Eight MCP tools total.

**Key principle**: Forged tools are NOT exposed as MCP endpoints. They live inside the forge and are invoked through `forge_call`. This keeps the MCP tool surface clean while giving the LLM an extensible runtime.

> **⚠️ Before implementing**: Read `docs/workspace-agent-usecase-exploration.md`. It catalogs real-world failure modes across 10 categories — authoring loops, concurrency races, hostile inputs, security in practice, operational crashes, and the LLM's own cognitive blind spots. Each scenario is numbered (e.g. 2.5, 8.1). Use them as north stars for what the forge should handle gracefully, and as pitfalls to design against from day one. Grep for section IDs in code comments to trace design decisions back to the scenarios that drove them.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              MCP Orchestrator                        │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  Forge Agent                                 │    │
│  │  (src/agents/forge/)                         │    │
│  │                                              │    │
│  │  forge_write   ──► data/forge/tools/         │    │
│  │  forge_update  ──► {name}.js (git)           │    │
│  │  forge_read    ◄─── version history          │    │
│  │  forge_delete  ──► soft delete               │    │
│  │  forge_list    ◄─── catalog (incl. manifest) │    │
│  │  forge_history ◄─── git log                  │    │
│  │  forge_rollback──► restore old ver           │    │
│  │                                              │    │
│  │  forge_call ─────► new Worker()              │    │
│  │              resolve payload[]                │    │
│  │              create temp workspace/ dir       │    │
│  │              postMessage({ gatewayPort,       │    │
│  │                           progressPort,       │    │
│  │                           payload,            │    │
│  │                           workspacePath,      │    │
│  │                           toolStatePath,      │    │
│  │                           args })             │    │
│  │              worker.terminate() on timeout    │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Gateway Client (ws://localhost:3400)                │
│  └── connection per worker (MessagePort relay)       │
└──────────────────────────────────────────────────────┘
```

---

## File Layout

```
data/forge/
  .git/                  # git repository — auto-initialized
  tools/
    pdf_to_md.js         # forged tool source
    image_classifier.js
  workspace/             # scratch root
    {uuid}/              # per-call temp subdir (auto-cleaned)
```

---

## Tool Lifecycle

### 1. Write

```javascript
forge_write({
  name: "pdf_to_md",
  description: "Convert PDF to Markdown via vision model",
  packages: ["pdf-parse"],   // optional — must be in allowlist or approved
  args: {
    outputPath: { type: "string", required: true, description: "Where to write .md" }
  },
  code: `
    export default async function(args, ctx) {
      const { outputPath } = args;
      const { gateway, progress, payload, workspacePath } = ctx;

      progress({ message: "Reading PDF...", progress: 10, total: 100 });
      const buf = payload[0];

      progress({ message: "Analyzing...", progress: 50, total: 100 });
      const result = await gateway.chat({
        task: "vision",
        messages: [{ role: "user", content: "Convert this PDF page to markdown. Preserve tables." }]
      });

      progress({ message: "Saving...", progress: 90, total: 100 });
      await fs.writeFile(outputPath, result.content);

      return "Done — " + outputPath;
    }
  `
});
```

Result: file written to `data/forge/tools/pdf_to_md.js`, committed to git. The `args` schema is stored in the tool's manifest for LLM clients to discover.

### 2. Execute — Unified API

```javascript
forge_call({
  name: "pdf_to_md",
  args: { outputPath: "D:\\docs\\out.md" },
  payload: ["D:\\docs\\report.pdf"],
  timeout: 300000   // default 5 min, max 10 min
});
```

**Payload resolution** (parallel, on main thread before worker spawn):
- `"D:\\docs\\report.pdf"` → `fs.readFile()` → `Buffer`
- `"\\\\server\\share\\file.pdf"` → `fs.readFile()` → `Buffer`
- `"https://example.com/file.pdf"` → `fetch()` → `Buffer`

Payload items resolve to `Buffer[]` and are transferred to the worker via `postMessage` (zero-copy for Buffers).

### 3. Iterate

```javascript
forge_update({
  name: "pdf_to_md",
  code: "...improved version...",
  message: "Add table extraction"
});
```

Result: new git commit. Old version accessible via `forge_read({ name: "pdf_to_md", ref: "abc123" })`.

### 4. Rollback

```javascript
forge_rollback({ name: "pdf_to_md", commit: "abc123" });
```

Result: file restored to that commit, new commit made. History is never rewritten.

---

## Worker Thread Execution

Each `forge_call` spawns a dedicated `worker_threads` Worker. This provides:

| Property | Mechanism |
|----------|-----------|
| **Real termination** | `worker.terminate()` — kills infinite loops, blocks, runaway allocations |
| **Event-loop isolation** | A stuck tool never blocks the orchestrator's main thread |
| **Clean reload** | New worker per call — no ESM cache busting needed |
| **Memory isolation** | Worker heap is separate; GC cleans up after terminate |

### Worker Lifecycle

```
forge_call({ name, args, payload, timeout })
  │
  ├─ 1. Resolve payload[] → Buffer[]
  ├─ 2. Create temp workspace dir: data/forge/workspace/{uuid}/
  ├─ 3. Spawn Worker with tool source + Node options
  ├─ 4. Create MessageChannel for gateway relay
  ├─ 5. Create MessageChannel for progress relay
  ├─ 6. worker.postMessage({ gatewayPort, progressPort, payload, workspacePath, toolStatePath, args })
  │
  ├─ On progress message: relay to MCP notifications
  ├─ On result message: resolve with return value
  ├─ On error message: reject with error details
  │
  └─ On timeout: worker.terminate() → clean workspace dir → reject
```

### Context Injection (via MessagePort)

The worker receives context through transferable `MessagePort` objects, not globals:

| Property | Delivery | Description |
|----------|----------|-------------|
| `gateway` | `MessagePort` → proxy | Gateway client relay. Worker gets a proxy object — calls serialize to `MessagePort`, main thread forwards to WebSocket. |
| `progress` | `MessagePort` → forward | `progress({ message, progress, total })` → main thread → MCP notification |
| `payload` | `Buffer[]` transfer | Raw payload buffers (zero-copy transfer) |
| `workspacePath` | string | Absolute path to per-call temp directory (`data/forge/workspace/{uuid}/`) |
| `toolStatePath` | string | Absolute path to per-tool persistent state directory (`data/forge/tools/{name}/state/`) |
| `args` | object | The `args` passed to `forge_call` |

The worker runs a thin bootstrap that instantiates these proxies, does `import(toolPath)`, and calls the default export.

---

## Tool Contract

Every tool has a machine-readable contract — name, description, args schema, and source code. `forge_list` returns the full manifest when called with a tool name, or a summary list when called without one:

```javascript
forge_list()
// → [{ name: "pdf_to_md", description: "...", version: "abc1234", lastModified: "..." }, ...]

forge_list({ name: "pdf_to_md" })
// → {
//   name: "pdf_to_md",
//   description: "Convert PDF to Markdown via vision model",
//   args: {
//     outputPath: { type: "string", required: true, description: "Where to write .md file" }
//   },
//   version: "abc1234",
//   lastModified: "2026-06-07T..."
// }
```

No separate `forge_manifest` tool — `forge_list` is the single discovery surface. The LLM browses the catalog with the summary form, drills into details with `{ name }`.

## Persistent Tool State

`workspacePath` is per-call and ephemeral. A tool that needs to remember things between calls — cache, learned patterns, indexes — has nowhere to write. The solution is simple: a flat per-tool directory.

### Layout

```
data/forge/tools/
  pdf_to_md.js
  pdf_to_md/             # per-tool directory (created on forge_write)
    state/               # persistent state, gitignored
```

The `state/` directory is created on first `forge_write` and auto-added to the forge repo's `.gitignore`. State is never git-committed.

### Access from tools

The worker receives `ctx.toolStatePath` — an absolute path to `data/forge/tools/{name}/state/`. The tool reads/writes files directly:

```js
export default async function(args, ctx) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const cacheFile = path.join(ctx.toolStatePath, 'cache.json');
  const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  // ...
  await fs.writeFile(cacheFile, JSON.stringify(updated));
}
```

No Proxy, no auto-save, no lazy loading. `JSON.parse`/`JSON.stringify` is two lines the LLM writes fluently. The path is all the infrastructure needed.

### State lifecycle

| Event | What happens to state |
|-------|----------------------|
| `forge_write` (new tool) | Empty `state/` dir created |
| `forge_update` (code change) | State preserved as-is |
| `forge_rollback` (old code) | Current state snapshotted to `state/.rollback/{date}/`, then reset to empty. Loud, simple, recoverable. |
| `forge_delete` | State deleted with the tool |

### Concurrency

Multiple parallel calls to the same tool share state. A per-tool mutex serializes writes — reads can be concurrent.

### Why not just let tools write to `data/`?

Without a managed directory, the orchestrator can't clean up on `forge_delete`, can't distinguish "tool state" from random files, and can't snapshot on rollback. A dedicated per-tool `state/` dir keeps state discoverable and manageable with zero abstraction overhead.

## Cross-Session Tool Sharing

**Decision: Global by default.**

Most forged tools are genuinely useful across sessions. The "I have to rebuild `pdf_to_md` every chat" alternative is worse than catalog clutter. Tools persist across all chats. Cleanup via `forge_delete`. If private/session-scoped tools become a need, a `private` flag on `forge_write` is trivial to add later.

---

## MCP Tools (8)

| Tool | Description |
|------|-------------|
| `forge_write` | Create a new tool. Requires `name`, `description`, `code`, optional `args` schema, optional `packages: []`. Commits to git. |
| `forge_update` | Update existing tool source. New commit. Old version stays in history. |
| `forge_read` | Read source code. Optional `ref` to read historical version. |
| `forge_list` | List all tools (summary). Pass `{ name }` to get full manifest with args schema. |
| `forge_delete` | Soft-delete a tool file + its state directory. Commits deletion. Recoverable from history. |
| `forge_call` | Execute a tool by name. Resolves payload, spawns Worker, injects context, enforces timeout. Optional `captureLogs: true` for console capture. |
| `forge_history` | Show git log for a tool (or all tools). |
| `forge_rollback` | Restore tool to a specific commit. New commit, no history rewrite. Current state is snapshotted then reset. |

---

## Git Versioning

- `data/forge/` is a self-contained git repository
- Auto-initialized on first server start (`git init` + `user.name/email` config)
- Every write/update/delete/rollback = one commit
- No branches — linear history on `main`
- The `.git` directory is preserved (not gitignored) so history survives

### Why Git?

| Need | Git Feature |
|------|-------------|
| Version history | `git log` — free |
| Rollback | `git show commit:file` → restore → new commit |
| Diffing | `git diff` between versions |
| Durability | `.git` directory is a complete backup |
| No dependencies | Git is already required for the project |

The forge repo is a nested repo at `data/forge/.git`. The main project's `.gitignore` already covers `data/`, so forge commits won't pollute the orchestrator's git history. This isolation is desirable — the forge is its own versioned artifact.

---

## Timeout & Resource Limits

| Setting | Default | Max | Description |
|---------|---------|-----|-------------|
| `defaultTimeout` | 300000 (5 min) | 600000 (10 min) | Tool execution timeout |
| `maxPayloadSize` | — | 100 MB | Per payload item |
| `maxPayloadItems` | — | 10 | Items in payload array |

Timeout is enforced via `worker.terminate()` — a hard kill that frees the worker's event loop, heap, and all handles. The per-call workspace directory is cleaned up after termination (success or timeout). A `setTimeout` race on the main thread triggers the terminate if the worker hasn't responded.

---

## Security Model

Forge tools run in **dedicated `worker_threads` Workers** with these boundaries:

| Boundary | Mechanism |
|----------|-----------|
| Event-loop + heap isolation | `worker_threads` — separate event loop, separate heap. NOT process isolation — a native crash, OOM, or `process.exit()` from a worker takes down the orchestrator. |
| Hard timeout | `worker.terminate()` — no `Promise.race` soft-timeout |
| Payload pre-resolution | All payload items resolved on main thread before worker spawn |
| No forge admin access | Worker only receives `{ gateway, progress, payload, workspacePath, toolStatePath, args }` — cannot call `forge_write`, `forge_delete`, etc. |
| Workspace isolation | Each call gets `data/forge/workspace/{uuid}/` — cleaned after execution |
| Gateway access | Relayed via `MessagePort` — worker doesn't get raw WebSocket |

### Package allowlist

`forge_write` accepts an optional `packages: ["pdf-parse"]` array. Packages are NOT auto-installed — the forge maintains an allowlist in `config.json`:

```json
{
  "agents": {
    "forge": {
      "allowedPackages": ["pdf-parse", "sharp", "csv-parse", "cheerio"],
      "requireApprovalForNewPackages": true
    }
  }
}
```

On `forge_write` with a package not in the allowlist: the write succeeds but is marked `packagesPending`. The operator approves via `forge_approve_packages({ name })` or by adding to the allowlist. Until approved, `forge_call` rejects with a clear message. This prevents typosquatting and postinstall script abuse from LLM-authored package requests.

Tools can import Node built-ins (`fs`, `path`, `crypto`, etc.) and any npm packages installed in the orchestrator. They cannot access `child_process`, `worker_threads` themselves, or the filesystem outside their workspace directory. This is enforced via the worker's `workerData` and bootstrap — not a full sandbox, but strong enough for LLM-generated code maintained by the same entity that writes the orchestrator.

---

## Stability & Production Concerns

### Concurrency limits

A semaphore limits concurrent `forge_call` executions. Defaults and limits live in `config.json`.

### Startup health checks

On orchestrator boot:
- `git fsck` on the forge repo
- Sweep `data/forge/workspace/` for orphan directories, delete them
- Reap any leaked workers from a prior crash

### Git write queue

All git writes go through a single async queue — predictable latency, no lock contention errors.

### Result size policy

No tool returns >10KB inline. Above that, result saved to workspace, caller gets `{ path, summary, preview }`. Configurable via `maxReturnSize` in `config.json`.

### Rollback snapshot cap

`forge_rollback` snapshots current state to `state/.rollback/{date}/`. Cap: 10 snapshots per tool, oldest evicted first. Configurable in `config.json`.

### Config.json — all tunables in one place

```json
{
  "agents": {
    "forge": {
      "defaultTimeout": 300000,
      "maxTimeout": 600000,
      "maxPayloadSize": 104857600,
      "maxPayloadItems": 10,
      "maxConcurrentCalls": 8,
      "queueTimeout": 30000,
      "maxReturnSize": 10240,
      "maxRollbackSnapshots": 10,
      "allowedPackages": [],
      "requireApprovalForNewPackages": true
    }
  }
}
```

No magic numbers in code. Every tunable has a home in config.

---

## Resolved Design Decisions

1. **Worker threads over child_process**: Real `terminate()`, zero-copy `Buffer`/`MessagePort` transfer, no spawn latency. Workers share the Node binary — event-loop + heap isolation, not process isolation.

2. **Git as storage**: Zero new deps, free history/rollback/diff. Nested repo at `data/forge/.git` keeps forge history out of the main repo.

3. **`forge_call` instead of dynamic MCP registration**: Keeps the MCP surface stable at 8 tools. Forged tools are data, not endpoints.

4. **Payload pre-resolution**: All `payload[]` items resolved on the main thread before worker spawn. No arbitrary filesystem access from inside workers.

5. **Per-call workspace + per-tool state**: `workspacePath` is ephemeral per-call, `toolStatePath` is persistent per-tool. Clean lifecycle separation.

6. **Rollback resets state**: Snapshot to `state/.rollback/{date}/`, then reset. Loud, simple, recoverable. No LLM-authored migration code running against state.

7. **Package allowlist**: No auto-install on `forge_write`. Operator approves new packages. Prevents typosquatting and postinstall abuse.

8. **`forge_list({ name })` merges manifest**: One discovery tool, not two. Pass `{ name }` to get the full args schema.

9. **Cross-session sharing**: Global by default. Tools persist across all chats. Cleanup via `forge_delete`.

10. **All tunables in config.json**: No magic numbers. Timeouts, limits, queue depth, snapshot caps — all in one place.

---

## Deferred Features

These are explicitly deferred until real usage proves they're needed. Each is captured here so the shape is clear when the time comes.

### Embedding-indexed tool discovery

When the catalog exceeds ~20 tools, `forge_list` becomes noisy. The plan: embed a canonical tool-text string per tool, store vectors in `data/forge/.index/`, inject top-K matches into the LLM context before inference turns. A `forge_suggest` tool for explicit semantic search. Design is fully specified in earlier revisions of this document.

### `forge_call` smoke-test options

`captureLogs: true` on `forge_call` captures `console.log`/`warn`/`error` from the worker. A `dryRun: true` option that runs with empty args just to verify the tool loads. Both are thin additions to the existing `forge_call` code path. No separate `forge_test` tool needed.

### Usage tracking in `forge_list`

Augment `forge_list` with `{ calls, lastUsed, avgDurationMs, errorRate }` per tool. Enables pruning dead tools and spotting performance regressions. Trivial to add — just increment counters on `forge_call` and store in per-tool metadata.

### State inspection

`forge_state_info({ name })` — returns `{ size, fileCount, files: [{ name, size }] }`. `forge_reset_state({ name, confirm: true })` with optional `dryRun`. Low priority — `fs.stat` + `rm -rf` from the operator side covers the need until the catalog is large.

### `ctx.state` Proxy

A Proxy over `state.json` that lazy-loads and auto-saves. Saves four lines of `JSON.parse`/`JSON.stringify` per tool. Only worth adding if tools consistently need structured JSON state rather than raw files. Ship `toolStatePath` first, watch what patterns emerge.

### State versioning with `migrate()`

If rollback-with-reset becomes painful (tools losing months of learned state), add `stateSchemaVersion` to the manifest and an optional `migrate(oldState, oldVer, newVer)` function. The forge compares versions on load and calls migrate or resets. Snapshots always precede migration. Only needed once someone actually rolls back across an incompatible state format.

---

## Implementation Order

0. **Internalize usecases** — Read `docs/workspace-agent-usecase-exploration.md`. Understand the failure modes before writing code. Reference scenario IDs in commit messages and code comments.
1. **Forge agent skeleton** — `src/agents/forge/config.json` + `index.js` with git helpers
2. **Git lifecycle** — init repo, write/update/delete/rollback with commits, git write queue
3. **Worker bootstrap** — `src/agents/forge/worker-bootstrap.js` — runs inside each Worker, handles MessagePort setup, imports the tool, calls it
4. **Gateway relay** — `MessagePort`-based proxy from worker to main-thread Gateway client
5. **Progress relay** — wire `progress()` calls through `MessagePort` → MCP notifications
6. **Payload resolution** — local path, UNC path, URL → `Buffer[]` (on main thread, before worker spawn)
7. **`forge_call` execution** — spawn worker, transfer context, enforce timeout with `worker.terminate()`, concurrency semaphore, result size policy
8. **`forge_list` manifest** — summary list + `{ name }` drill-down, store/extract args schemas
9. **Workspace lifecycle** — per-call temp dirs, cleanup on completion/termination, startup orphan sweep
10. **Persistent state** — per-tool `state/` dir, `ctx.toolStatePath`, state mutex, snapshot-on-rollback with cap
11. **Package allowlist** — config.json allowlist, pending-approval flow, operator gate
12. **Startup health checks** — `git fsck`, workspace sweep, worker reaping
13. **Integration tests** — worker lifecycle, gateway relay, progress relay, payload transfer, workspace cleanup, state persistence, rollback snapshot

---

## Rationale: Why Forge Instead of Storage + Sandbox?

The original plan split this across two agents (Storage on nDB, Sandbox via `child_process`). Merged into Forge because:

- **No MCP tool explosion**: Forged tools are NOT MCP endpoints. The client sees 8 forge management tools, not N arbitrary ones.
- **Unified API**: `forge_call` with `args` + `payload` is simpler than coordinating storage reads with sandbox execution.
- **Git is enough**: We don't need nDB's document features — git gives versioning, rollback, and diffing for free with zero new dependencies.
- **`worker_threads` over `child_process`**: Workers share the Node binary and can transfer `Buffer`/`MessagePort` zero-copy. No serialize/deserialize overhead for payload. No process-spawn latency per call. Real `terminate()`.
- **Context injection**: Passing `gateway` via `MessagePort` relay is clean and explicit. In a `child_process`, you'd need `--experimental-permission` flags and stdin/stdout JSON-RPC — heavier and slower.

---

## Related Documents

- `docs/workspace-agent-usecase-exploration.md` — **Read first.** Real-world failure modes and scenarios the forge must handle or defend against.
- `Agents.md` — Orchestrator architecture, Gateway client API, code style
- `README.md` — Agent table (to be updated when Forge ships)
- `src/agent-loader.js` — Auto-discovery of `src/agents/forge/`
- `src/gateway-client.js` — Task-based API relayed to forged tools via MessagePort
