# Forge — custom tool forge

Reference documentation for authoring and executing versioned custom tools.
Last verified 2026-09-26 against `src/agents/forge/index.js`,
`worker-bootstrap.js`, `deny-hooks.mjs`, `config.json`, and root `config.json`.

## What it is

A git-versioned tool workshop: write ES-module tools, every change is a
commit, and execution happens in an isolated child process with gateway
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
<storageRoot>/forge/.vendor/<name>/  durable tool-owned non-output artifacts (binaries, models)
```

## Tools (10)

| Tool | Args | Notes |
|---|---|---|
| `forge.write` | `name*`, `description*`, `code*`, `args?` (JSON schema), `packages?` | Name `/^[a-z][a-z0-9_]{0,63}$/` + reserved-word blocklist. Packages checked against `allowedPackages`; unknown → `packagesPending` until approval (`requireApprovalForNewPackages: true`). |
| `forge.update` | `name*`, `code*`, `message?`, `args?`, `description?` | New commit; history preserved. |
| `forge.read` | `name*`, `ref?` | Current or `git show <ref>` source. |
| `forge.list` | `name?` | Summary list, or full manifest + version hash for one tool. |
| `forge.delete` | `name*` | Soft delete (commits the removal — recoverable via rollback). Refuses while a **live call** of that tool exists: it would delete the state and storage directories out from under the running process. |
| `forge.call` | `name*`, `args?`, `payload?` (≤10 file paths/URLs → Buffers), `timeout?`, `model?` | Executes in its own process. See below. |
| `forge.stop` | `callId?` / `name?` / `all?` | No args = list running calls. Kills the tool's process tree (`taskkill /T /F`), which covers every `ctx.spawn` child. |
| `forge.history` | `name?`, `limit?` (20) | `{hash, date, message}` per commit. |
| `forge.rollback` | `name*`, `commit*` | State snapshotted → source restored → state reset → commit. Also refuses while a live call exists — `resetState` wipes the live tool's `toolStatePath`. |
| `forge.help` | — | Embedded authoring guide (ctx API, gateway methods, local services). Call it before writing your first tool. |

## Execution model

- **Process isolation**: source is written to a temp `.mjs`, dynamically
  imported inside a forked **child process**, temp unlinked. The process gets
  `--max-old-space-size=512`.
  This replaced `worker_threads` deliberately: a V8 heap-limit failure inside a
  worker thread aborts the *whole server* even with `resourceLimits` set —
  reproduced in `data/_test/forge-oom-probe.cjs` (object churn, exit 134,
  `FATAL ERROR: Reached heap limit`). A child owns its address space, so a tool
  that blows its heap fails one call and nothing else. Unhandled rejections
  exit(1); a crash (exit without result) rejects with diagnostics — a call never
  resolves undefined.
- **Timeouts** (idle-based — armed after the tool process reports `ready`, reset
  on ANY activity: progress, relay traffic, logs; implemented with a
  `setImmediate` loop, deliberately not `setTimeout`, so main-thread load can't
  kill healthy processes):
  - default idle 300 000 ms; caller `timeout` accepted up to
    **`maxTimeout: 600 000`** (config; code default 900 000 is overridden).
  - backstops: 60 s boot guard, 30 min absolute hard cap (never reset).
  - the kill is `child.kill('SIGKILL')` — an OS signal, with no promise to await.
    `worker.terminate()` could be left unresolved forever by a process blocked in
    a kernel wait (`data/_test/forge-terminate-uninterruptible.cjs`, dead-SMB
    case), so the caller was rejected first and could never be held up by the kill.
- **Concurrency**: 8 simultaneous calls (semaphore); queue admission times
  out at 30 s. A call cancelled while queued releases its slot immediately.
- **Payloads**: each item ≤ 100 MB, ≤ 10 items, **and ≤ 256/512 MB total across
  all in-flight calls** (`maxTotalPayloadBytes`, default 512 MB). The per-item
  limits alone admitted `10 × 100 MB × 8 = ~8 GB` of Buffers on the main
  thread. Resolution is two-phase: validate and size everything (async `stat`),
  reserve the total against the global budget, then read. URLs reserve the
  per-item ceiling pessimistically and are corrected to the real size after the
  fetch. Paths/URLs are resolved to Buffers on the main thread before spawn;
  HTTP fetch 30 s cap; storage-root relative paths resolve against
  `D:\MCP_Storage`; UNC paths translated. Refusal is loud and names the numbers.
- **Returns**: `{ result, _diagnostics: {callId, durationMs, logCount,
  droppedLogLines, outputsTruncated, …}, _outputs: [{name, path
  (storage.read-ready), url, uncPath?, size}], _logs: [{level,message}]
  (console always captured), _warning/_note/_logsNote/_outputsNote }`.
  Serialized results over `maxReturnSize` (10 KB) are written to
  `<storagePath>/result-<ISO>-<callId>.json` (the callId suffix prevents
  same-millisecond collisions) and replaced by a pointer + 500-char preview.
  Log capture is bounded: lines are truncated to `maxLogLineChars` before the
  IPC write, at most `maxLogEntries` are forwarded, and the rest are counted and
  reported. A time-based keepalive keeps a chatty tool looking alive so it is
  not idle-killed for silence.
- **`_outputs` walk**: bounded at `maxSnapshotDepth` (4). Deeper files are
  omitted **and reported** via `_diagnostics.outputsTruncated`; the before-walk
  is skipped entirely when the tool's storage dir was empty at call start.
- **Child processes**: `ctx.spawn` registers PIDs; EVERY settle path (including
  success) kills still-running children — deliberate per issue #43, daemons
  don't outlive their call. Importing `child_process` or `worker_threads` from
  tool code is refused at load time by a module-resolution hook
  (`deny-hooks.mjs`). Boundary: the hook intercepts ESM resolution, so a
  static/dynamic/concatenated import is caught but
  `createRequire(...)('child_process')` is not — a guardrail, not a sandbox.
- **Nesting**: `ctx.mcp` lets a tool call workshop tools; depth capped at 3.
  When the parent call is torn down (cancel, timeout, stop) its relay context is
  aborted, so a nested `forge.call` stops its own process too.

## Tool-side context (`ctx`)

`{ gateway, browser|null, mcp|null, progress, spawn, payload (Buffer[]),
workspacePath (ephemeral), toolStatePath (persistent, small state only),
storagePath (persistent, user-visible outputs), toolVendorPath (persistent,
durable non-output artifacts such as a vendored binary), fileops, args }`.

`toolVendorPath` lives at `<storageRoot>/forge/.vendor/<name>` — outside the
source checkout (so a re-clone cannot destroy it) and outside `storagePath`
(so a tool's own artifacts never appear in `_outputs`). It is visible to
storage tools as one dot-directory and is not vector-indexed.

**Model routing** precedence (highest wins): per-call `model` in
`ctx.gateway.chat()` → per-call non-default `task` → worker `defaultModel`
(pinned via `forge.call`'s `model` arg) → gateway task default. Author tools
with NEITHER `task` NOR `model` so caller pins work. `ctx.gateway.listModels()`
discovers IDs at runtime — never hardcode.

## Config (`agents.forge`, effective)

`defaultTimeout: 300000`, `maxTimeout: 600000`, `maxPayloadSize: 100 MB`,
`maxPayloadItems: 10`, `maxTotalPayloadBytes: 512 MB`, `maxConcurrentCalls: 8`,
`queueTimeout: 30000`, `maxReturnSize: 10240`, `maxRollbackSnapshots: 10`,
`maxSnapshotDepth: 4`, `maxLogEntries: 1000`, `maxLogLineChars: 4000`,
`allowedPackages: []`, `requireApprovalForNewPackages: true`. Also reads
`agents.storage.root` + `uncShare` (outputs + translator). Relay timeouts
main↔tool: gateway chat 330 s / embed 90 s / listModels 30 s / browser 120 s /
mcp 300 s. Git subprocesses carry a 30 s timeout, and a stale `.git/index.lock`
older than twice that is cleared once (a crashed git must not brick the forge).

## Known flags

- `captureLogs` appears in the server catalog line but is not a real arg —
  console capture is always on.
- `forge.update` is NOT guarded against live calls: the running process holds its
  source in memory, so a mid-call update only changes what the *next* call runs.
- Cancelling a call stops the in-flight upstream `GATEWAY_CLIENT.chat` only if the
  gateway client gains an abort API; today that one call is allowed to finish
  (bounded), because the worker's relay promise is on the main thread and the
  gateway client creates its own internal AbortController.
- Related open issues: #39 (toolStatePath vs toolVendorPath — partially addressed
  by `toolVendorPath`), #50 (git queue — fixed), #37 (process isolation — fixed).
