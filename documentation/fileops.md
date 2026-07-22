# fileops — Shared File-Operations Layer

Reference documentation for the `fileops` module: what it is, how it's wired,
and the contracts consumers rely on. Last verified 2026-07-22 (E2E green).

## What it is

A single shared file-operations engine for the MCP server process. One module,
one root-confinement implementation, one set of tests. Agents construct their
own instance via a factory — no module-level mutable state, so multiple
independent instances coexist (e.g. one for storage, one for documentation).

Design rule: **bytes never cross a boundary they don't need to.** If the LLM
doesn't need to *see* content, the operation happens server-side with zero
context involvement.

## Location & entry point

```
src/lib/fileops.js          — the module (ES module)
tests/fileops.test.js       — node:test suite (55 tests)
tests/fileops.bench.js      — manual benchmark
```

```javascript
import { createFileOps } from '../lib/fileops.js';
const ops = createFileOps({ root, translator = null, keepVersions = 10 });
```

- `root` (required): all paths are confined under this directory.
- `translator` (optional): a `createPathTranslator` instance for UNC ↔ local
  translation (from `src/agents/storage/path-translator.js`).
- `keepVersions` (default 10): per-path version retention.

Run tests: `node --test tests/fileops.test.js`
Run bench: `node tests/fileops.bench.js`

## Confinement

Every public function resolves paths through an internal `resolve()`:

1. `translator.toLocal()` if a translator is configured.
2. Relative paths resolve against `root`; absolute paths stay absolute.
3. Walk up to nearest existing ancestor, `realpath` it, rejoin the
   not-yet-created tail (allows writes to new paths while catching symlink escapes).
4. Reject anything outside `realpath(root)` with `Path escapes root`.

Escapes **throw** — no silent clamping.

## Versioning (hardlink snapshots)

Every mutating op auto-snapshots the target's prior state before mutating.

```
<root>/.versions/<mirrored-relative-path>/<ISO-timestamp>_<op>
```

- Snapshot = `fs.linkSync` (hardlink). One syscall, zero bytes. NTFS inode
  refcount is the GC — deleting a version frees space only when last link.
- Retention: last `keepVersions` per path; prune oldest on write.
- `.versions/` is excluded from `list`, `grep`, `snapshotDir`, and vdb indexing.
- Cross-device (`EXDEV`): falls back to real copy + logs a warning. Never silent.

### Two correctness invariants

1. **Atomic writes (temp + rename, never in-place truncate).** The live file and
   its versions share an inode; truncating would corrupt every version. `write`
   = write to temp in same dir → `rename` over target (new inode, old stays with
   version). Crash-safe as a bonus.
2. **append breaks sharing first.** If `stat.nlink > 1`, the live file is copied
   onto itself (temp+rename) to break the hardlink before appending. One copy per
   version cycle, not per append.

### Auto-snapshot matrix

| op      | snapshots | what                                    |
|---------|-----------|-----------------------------------------|
| write   | yes       | prior content of target (if exists)     |
| append  | yes       | prior content (after inode-break)       |
| copy    | yes       | prior content of target (if overwrite)  |
| move    | yes       | source entry (op tag `move`)            |
| remove  | yes       | the file itself before unlink           |
| restore | yes       | current state (tag `restore`)           |
| batch   | per-item  | each mutating item snapshots itself     |

## API surface

All functions async. All throw on invalid input. Paths in results are
root-relative with forward slashes.

**Read/metadata**
- `stat(path)` → `{ exists, type, size, modified }` (missing → `{ exists: false }`)
- `read(path, { encoding })` → `{ content, size }`
- `readWindow(path, { offset,length } | { head } | { tail })` → `{ content, size, window }`.
  Exactly one mode. `tail` seeks from EOF in 64KB chunks (never slurps).
- `list(path = '', { recursive, pattern })` → `{ entries }`. Glob `pattern`
  (`*`, `**`, `?`). Skips `.versions/`, `node_modules/`, `.git/`.
- `hash(path, { algo = 'sha256' })` → `{ hash, size }` (streamed).
- `grep(path, pattern, { maxMatches = 100, context = 0, ignoreCase })` →
  `{ matches: [{ path, line, text, before?, after? }], truncated }`. Streams
  line-by-line, skips files >50MB. Returns matches only — bodies stay server-side.
- `history(path)` → `{ versions: [{ version, op, size, modified }] }` newest first.
- `snapshotDir(path)` → `{ files: { rel: { size, mtimeMs } } }`;
  `diffSnapshots(before, after)` → `{ added, removed, modified }`.

**Mutations**
- `write(path, content, { encoding, overwrite = false })` → `{ size }`.
  Atomic. Requires `overwrite: true` if target exists.
- `append(path, content, { encoding })` → `{ size }`. O(1), breaks sharing first.
- `copy(from, to, { overwrite = false })` → `{ from, to, size }`. File or dir.
- `move(from, to)` → `{ from, to, type }`. Refuses overwrite.
- `remove(path, { recursive = false })` → `{ deleted: true }`.
- `restore(path, { steps = 1 })` → `{ restored, from }`. Snapshots current first
  (undo is undoable).
- `batch(opsList, { onError = 'collect' })` → `{ results }`. Sequential, per-op
  result capture. `onError: 'abort'` stops at first failure. **Args route by
  name via a per-op dispatch table — never positionally.**

**Held back**
- `writeFromUrl(path, url, { allowedPrefixes, overwrite })` — implemented in the
  engine but NOT exposed as a tool. Parked pending the auth/session proxy
  (network-egress surface). Do not expose without an allowlist decision.

## How storage agent uses it (current, debt-free)

`src/agents/storage/index.js` constructs one `OPS = createFileOps(...)` in
`initConfig`. **Every storage op routes through it** — no parallel legacy fs
paths for mutations:

| Tool | Engine call | Notes |
|------|-------------|-------|
| storage_stat | `OPS.stat` | |
| storage_list | `OPS.list` | normalizes `modified` to ISO |
| storage_write | `OPS.write(..., { overwrite: true })` | preserves historical silent-overwrite contract, now versions + atomic |
| storage_move | `OPS.move` | |
| storage_delete | `OPS.remove` | |
| storage_read | `OPS.readWindow` (window args) / legacy inline (no window) | non-window path is agent-level MCP transport policy (INLINE_BYTE_LIMIT, PUBLIC_URL pointer) — correctly stays in agent |
| storage_copy/append/grep/batch/history/restore | corresponding `OPS.*` | new tools |

`safeResolve`/`safeRel` remain only for `storage_read`'s non-window path and
the `/storage` REST endpoint. That is correct separation, not debt.

## Compact-endpoint routing (gotcha)

Registering a tool in the storage agent's `config.json` is NOT enough to reach
it via the compact endpoint (the single `workshop` tool). The compact endpoint
translates `storage.action` → `storage_action` through a static
`COMPACT_TO_LEGACY` map in `src/server.js`. **A new storage tool needs three
registrations:** (1) agent `config.json` schema, (2) agent `index.js` handler
export, (3) `COMPACT_TO_LEGACY` entry in `server.js`. Missing (3) →
`Unknown method` even though the tool is correctly registered.

## Verified state (2026-07-22)

- 55 node:test tests green (54 pass, 1 symlink env-skip on Windows without dev mode).
- Bench: copy 100MB = 29ms; grep 50MB/610k lines = 167ms; 1000 writes ≈ 705ms
  (fs-bound — batch vs individual identical; batch's value is orchestration, not disk).
- E2E via workshop MCP tools: copy, grep, append, windowed read, batch
  (collect + named-arg routing), write-overwrite versioning, restore round-trip
  (undo-is-undoable), move, delete — all green.
