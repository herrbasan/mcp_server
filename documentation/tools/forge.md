# Forge — custom tool forge

Reference documentation for authoring and executing versioned custom tools.
Last verified 2026-09-22 against `src/agents/forge/index.js`,
`worker-bootstrap.js`, `config.json`, and root `config.json`.

## What it is

A git-versioned tool workshop: write ES-module tools, every change is a
commit, and execution happens in an isolated `worker_thread` with gateway
access. Tools survive restarts and sessions — this is the permanent tool
catalog beyond the built-in agents.

## Layout

```
data/forge/                     git repo (auto-init, .gitignore: tools/*/state/, workspace/)
  tools/<name>.js               tool source (ES module)
  tools/<name>.manifest.json    contract: description, args, packages, timestamps
  tools/<name>/state/           persistent per-tool state (unversioned)
  tools/<name>/state/.rollback/ rollback snapshots (keep 10)
  workspace/<uuid>/             ephemeral per-call scratch (deleted after; orphan-swept at boot)
<storageRoot>/forge/<name>/     user-visible persistent outputs (D:\MCP_Storage\forge\…)
```

## Tools (10)

| Tool | Args | Notes |
|---|---|---|
| `forge.write` | `name*`, `description*`, `code*`, `args?` (JSON schema), `packages?` | Name `/^[a-z][a-z0-9_]{0,63}$/` + reserved-word blocklist. Packages checked against `allowedPackages`; unknown → `packagesPending` until approval (`requireApprovalForNewPackages: true`). |
| `forge.update` | `name*`, `code*`, `message?`, `args?`, `description?` | New commit; history preserved. |
| `forge.read` | `name*`, `ref?` | Current or `git show <ref>` source. |
| `forge.list` | `name?` | Summary list, or full manifest + version hash for one tool. |
| `forge.delete` | `name*` | Soft delete (commits the removal — recoverable via rollback). |
| `forge.call` | `name*`, `args?`, `payload?` (≤10 file paths/URLs → Buffers), `timeout?`, `model?` | Executes in a worker. See below. |
| `forge.stop` | `callId?` / `name?` / `all?` | No args = list running calls. Kills child process trees, then workers. |
| `forge.history` | `name?`, `limit?` (20) | `{hash, date, message}` per commit. |
| `forge.rollback` | `name*`, `commit*` | State snapshotted → source restored → state reset → commit. |
| `forge.help` | — | Embedded authoring guide (ctx API, gateway methods, local services). Call it before writing your first tool. |

## Execution model

- **Worker isolation**: source is written to a temp `.mjs`, dynamically
  imported inside a `worker_thread`, temp unlinked. `resourceLimits`:
  512 MB old-gen / 128 MB young-gen. Unhandled rejections exit(1); a crash
  (exit without result) rejects with diagnostics — a call never resolves
  undefined.
- **Timeouts** (idle-based — armed after the worker posts `ready`, reset on
  ANY worker activity: progress, relay traffic, logs; implemented with a
  `setImmediate` loop, deliberately not `setTimeout`, so main-thread load
  can't kill healthy workers):
  - default idle 300 000 ms; caller `timeout` accepted up to
    **`maxTimeout: 600 000`** (config; code default 900 000 is overridden).
  - backstops: 60 s boot guard, 30 min absolute hard cap (never reset).
- **Concurrency**: 8 simultaneous calls (semaphore); queue admission times
  out at 30 s.
- **Payloads**: each item ≤ 100 MB, ≤ 10 items. Paths/URLs resolved to
  Buffers on the main thread before spawn; HTTP fetch 30 s cap; storage-root
  relative paths resolve against `D:\MCP_Storage`. UNC paths translated.
- **Returns**: `{ result, _diagnostics: {callId, durationMs, …},
  _outputs: [{name, path (storage.read-ready), url, uncPath?, size}],
  _logs: [{level,message}] (console always captured), _warning/_note }`.
  Serialized results over `maxReturnSize` (10 KB) are written to
  `<storagePath>/result-<ISO>.json` and replaced by a pointer + 500-char
  preview.
- **Child processes**: `ctx.spawn` registers PIDs; EVERY settle path
  (including success) kills still-running children (`taskkill /T /F` on
  Windows) — deliberate per issue #43, daemons don't outlive their call.
- **Nesting**: `ctx.mcp` lets a tool call workshop tools; depth capped at 3.

## Tool-side context (`ctx`)

`{ gateway, browser|null, mcp|null, progress, spawn, payload (Buffer[]),
workspacePath (ephemeral), toolStatePath (persistent), storagePath
(persistent, user-visible), fileops, args }`.

**Model routing** precedence (highest wins): per-call `model` in
`ctx.gateway.chat()` → per-call non-default `task` → worker `defaultModel`
(pinned via `forge.call`'s `model` arg) → gateway task default. Author tools
with NEITHER `task` NOR `model` so caller pins work. `ctx.gateway.listModels()`
discovers IDs at runtime — never hardcode.

## Config (`agents.forge`, effective)

`defaultTimeout: 300000`, `maxTimeout: 600000`, `maxPayloadSize: 100 MB`,
`maxPayloadItems: 10`, `maxConcurrentCalls: 8`, `queueTimeout: 30000`,
`maxReturnSize: 10240`, `maxRollbackSnapshots: 10`, `allowedPackages: []`,
`requireApprovalForNewPackages: true`. Also reads `agents.storage.root` +
`uncShare` (outputs + translator). Relay timeouts main↔worker: gateway chat
330 s / embed 90 s / listModels 30 s / browser 120 s / mcp 300 s.

## Known flags

- `captureLogs` appears in the server catalog line but is not a real arg —
  console capture is always on.
- Related open issues: #37 (worker OOM aborts the whole process),
  #40 (semaphore leak on queue timeout), #43 (verified fixed behavior:
  child tree-kill), #39 (toolStatePath location), #38 (spawn doc honesty).
