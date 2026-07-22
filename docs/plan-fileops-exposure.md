# fileops → storage agent tool exposure (v1, 2026-07-22)

**READ THIS FIRST if you are the model executing this spec.**

Execution spec. Every design decision is made. Carry out the steps EXACTLY, in
order, verifying each acceptance check. Do NOT add features, rename anything,
restructure response shapes, or improvise. If a step is impossible as written,
stop and report — do not improvise a different design.

You are MODIFYING two existing files and MUST touch nothing else:
- `D:\DEV\mcp_server\src\agents\storage\index.js`
- `D:\DEV\mcp_server\src\agents\storage\config.json`

Do NOT modify `src/lib/fileops.js` — it is done and tested. If you believe it
has a bug, STOP and report; do not patch around it.

Project conventions: vanilla Node ES modules, zero new npm deps, 4-space
indent, single quotes, semicolons, camelCase. Fail loud. The storage agent's
existing exports and behavior MUST keep working — this is purely additive.

---

## 1. Context you need (read these first)

- `D:\DEV\mcp_server\src\agents\storage\index.js` — the file you're editing.
  Note: module-level `let STORAGE_ROOT`, `TRANSLATOR`, `PUBLIC_URL`, and
  `initConfig()` / `init()` pattern, plus `result(ok, op, path, data)` and
  `toMcp()` response shapers, plus the `INLINE_BYTE_LIMIT` read behavior.
- `D:\DEV\mcp_server\src\agents\storage\config.json` — tool schemas.
- `D:\DEV\mcp_server\src\lib\fileops.js` — the engine. Read its exported
  factory `createFileOps({ root, translator, keepVersions })` and the exact
  signatures of: `copy`, `append`, `readWindow`, `grep`, `batch`, `history`,
  `restore`, `write`, `read`. Do not reimplement any of this logic.

How tools are dispatched (existing mechanism, do not change): the agent
loader calls exported async functions named after the tools in config.json.
Each tool function takes one `args` object and returns an MCP-shaped
`{ content: [{ type: 'text', text }] }` via the existing `result()` helper.

---

## 2. Wire the engine into the agent

In `index.js`:

1. Import the factory at the top:
   `import { createFileOps } from '../../lib/fileops.js';`

2. Add a module-level `let OPS;` next to the existing `let STORAGE_ROOT;`.

3. At the END of `initConfig(agentConfig)` (after `STORAGE_ROOT`, `TRANSLATOR`
   are set), construct the engine:
   ```javascript
   OPS = createFileOps({
       root: STORAGE_ROOT,
       translator: TRANSLATOR,
       keepVersions: agentConfig.keepVersions ?? 10
   });
   ```
   Do NOT construct it anywhere else. Do NOT create a second instance.

Acceptance: `node --check src/agents/storage/index.js` exits 0.

---

## 3. Add the new tool functions (all additive, all delegate to OPS)

Each function follows the existing house pattern: validate required args
(throw if missing), log via `logger.info`, call the engine, wrap via
`result(true, '<tool_name>', userPath, data)`. Keep logging style consistent
with the surrounding functions. Engine errors propagate (they're already
loud) — do NOT wrap in try/catch.

### storage_copy
`args: { from, to, overwrite? }` → `OPS.copy(from, to, { overwrite: !!args.overwrite })`.
Return `result(true, 'storage_copy', `${from} -> ${to}`, engineResult)`.

### storage_append
`args: { path, content, encoding? }` → `OPS.append(path, content, { encoding })`.
Require `path` and `content` (throw if missing). Return result with `{ size }`.

### storage_grep
`args: { path, pattern, maxMatches?, context?, ignoreCase? }` →
`OPS.grep(path, pattern, { maxMatches, context, ignoreCase })`.
Require `path` and `pattern`. Return result with `{ matches, truncated }`.

### storage_batch
`args: { ops, onError? }` → `OPS.batch(ops, { onError })`.
Require `ops` to be a non-empty array (throw otherwise). Return
`result(true, 'storage_batch', '', { results })`.

### storage_history
`args: { path }` → `OPS.history(path)`. Require `path`. Return `{ versions }`.

### storage_restore
`args: { path, steps? }` → `OPS.restore(path, { steps: args.steps ?? 1 })`.
Require `path`. Return `{ restored, from }`.

### Modify storage_read (small additive change)
Add optional `offset`, `length`, `head`, `tail` to args. When ANY of them is
present, delegate to `OPS.readWindow(path, { offset, length, head, tail })`
and return its `{ content, size, window }` via result() — SKIPPING the entire
existing inline/URL-pointer branch. When none are present, keep the existing
behavior byte-for-byte identical. Validate: exactly one window mode must be
specified; if `offset` is given, `length` is required. Do not remove or alter
the existing maxReadSize / INLINE_BYTE_LIMIT logic for the non-window path.

---

## 4. Register schemas in config.json

Add one entry per new tool to the `tools` array, matching the existing schema
style (name, description, inputSchema with type/properties/required).
Descriptions must state the context-saving behavior plainly so an LLM picks
the right tool:

- `storage_copy`: "Copy a file or directory within storage, server-side.
  Content never enters your context — prefer this over read+write for duplicating
  or staging files. Refuses to overwrite unless overwrite:true."
- `storage_append`: "Append content to a file (creates it if missing). O(1) —
  the existing file is NOT read into context. Use for logs, journals, growing notes."
- `storage_grep`: "Search file contents with a regex, server-side. Returns only
  matching lines (path, line number, text, optional context lines) — file bodies
  never enter your context. The primary way to find text in storage. Skips binary
  and >50MB files. Set context:N for surrounding lines."
- `storage_batch`: "Run multiple storage operations in ONE call. ops is an array
  of {op, ...args} where op is a storage op name (stat, read, write, list, move,
  remove, copy, append, readWindow, grep, hash, snapshotDir). Executes in order,
  returns per-op results. onError:'collect' (default) runs all; 'abort' stops at
  first failure. Use this for multi-step reorganizations instead of many calls."
- `storage_history`: "List prior versions of a file (newest first). Every
  mutating storage op auto-snapshots the prior state, so recent history is
  recoverable. Returns versions with version number, op, size, modified."
- `storage_restore`: "Restore a file to a previous version (steps back through
  history, default 1). The current state is snapshotted first, so a restore is
  itself undoable."
- Update the existing `storage_read` description: append "Optional windowed
  read: pass offset+length (byte window), head (first N lines), or tail (last N
  lines) to read only part of a file — strongly prefer tail for logs instead of
  reading whole files."
- Update the existing `storage_read` inputSchema: add optional `offset`,
  `length`, `head`, `tail` number properties (not required).

For the new schemas, required fields:
- storage_copy: ["from", "to"]; optional boolean `overwrite`.
- storage_append: ["path", "content"]; optional enum `encoding` utf8|base64.
- storage_grep: ["path", "pattern"]; optional numbers `maxMatches`, `context`,
  boolean `ignoreCase`.
- storage_batch: ["ops"]; optional enum `onError` collect|abort.
- storage_history: ["path"].
- storage_restore: ["path"]; optional number `steps`.

Acceptance: `node -e "JSON.parse(require('fs').readFileSync('src/agents/storage/config.json','utf8')); console.log('json ok')"` prints `json ok`.

---

## 5. Verify (do not skip)

1. `node --check src/agents/storage/index.js` → exit 0.
2. JSON validity check on config.json (command in §4) → `json ok`.
3. A scratch ESM script (run it, then DELETE it) that imports the storage
   agent module and asserts the new functions are exported functions:
   `storage_copy`, `storage_append`, `storage_grep`, `storage_batch`,
   `storage_history`, `storage_restore`. Note: the module's `init` requires a
   context; do NOT call init — only assert the exports exist as functions.
   Import via a `file://` URL on Windows.

---

## 6. Explicitly OUT OF SCOPE (do not build)

- `storage_writeFromUrl` — deliberately withheld pending a user decision on
  `allowedPrefixes` config. Do NOT expose it. Do NOT add it to config.json.
- Do NOT change existing tool behavior beyond the storage_read window addition.
- Do NOT touch the forge agent, vdb, dreaming, or any other file.
- Do NOT remove the old inline code paths in storage_read.
- No locking, no new dependencies, no config.json root changes.

## 7. Report back

- Diff summary per file (functions added, lines changed).
- Output of the two acceptance commands (node --check, JSON parse).
- Confirmation the export-assertion scratch script passed, and that you deleted it.
- Any deviations (should be none).
