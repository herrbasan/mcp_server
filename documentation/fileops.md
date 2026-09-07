# fileops — Shared File-Operations Layer

Reference documentation for the `fileops` module: what it is, how it's wired,
and the contracts consumers rely on. Last verified 2026-09-07 (snapshot +
temp-cleanup engine tests green).

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
tests/fileops-snapshot.test.js — snapshot + temp-cleanup tests (13 tests)
tests/fileops.bench.js      — manual benchmark
```

```javascript
import { createFileOps } from '../lib/fileops.js';
const ops = createFileOps({ root, translator = null });
```

- `root` (required): all paths are confined under this directory.
- `translator` (optional): a `createPathTranslator` instance for UNC ↔ local
  translation (from `src/agents/storage/path-translator.js`).
- Snapshot retention is a module constant (`SNAPSHOTS_KEEP = 10`), not a
  factory option.

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

## Snapshots (copy-before-mutate, issue #26)

Every destructive op preserves the target's prior content BEFORE mutating:

```
<root>/.backups/<mirrored-relative-path>.<YYYY-MM-DDTHH-mm-ss>[-NN]
```

- Plain copies (`copyFileSync`), not hardlinks — the hardlink `.versions/`
  machinery was removed in adca6b4 (2026-08-13) in favor of model-owned
  rollback, which failed with near data loss on 2026-09-03. Issue #26
  restored automatic snapshots in the chat app's `.backups/` shape so ALL
  platforms (chat app, MCP tools, forge workers) share one recovery layout.
- Same-second writes get a zero-padded counter suffix (`-01`, `-02`, …).
  WITHOUT this, a batch loop's later snapshot overwrites the earlier one —
  destroying the pre-write state the feature exists to preserve.
- Retention: last 10 snapshots per path (`SNAPSHOTS_KEEP`); prune oldest on
  write. Prune is best-effort — a failed prune never fails the write.
- `.backups/` is excluded from `list`, `grep`, `snapshotDir`, walk-based
  recursion (SKIP_DIRS), and VDB indexing (config `agents.vdb.ignore`).
  Direct reads by explicit path still work.
- Mutating functions return `previousVersion`: the backup's root-relative
  path, or `null` when nothing was preserved (new file / directory /
  backup-internal target). Surfaces in storage_write / storage_replace /
  storage_delete / storage_copy responses.
- Directories are NEVER snapshotted (unbounded size). Directory deletes log
  a loud warn in the storage agent.
- `_trash/` entries are not snapshotted — soft delete is itself the backup.

### Snapshot matrix

| op      | snapshots | what                                     |
|---------|-----------|------------------------------------------|
| write   | yes       | prior content of target (if exists)      |
| append  | no        | append cannot destroy prior content      |
| replace | yes       | prior content of target                  |
| copy    | yes       | prior content of target (overwrite only) |
| move    | no        | relocates content, never destroys        |
| remove  | yes       | the file itself before unlink (files)    |
| batch   | per-item  | each mutating item routes through above  |

### Two correctness invariants

1. **Atomic writes (temp + rename, never in-place truncate).** `write` =
   write to temp in same dir → `rename` over target. Crash-safe; readers
   never see a half-written file.
2. **Failed rename never leaks the temp file (issue #28).** `atomicWrite`
   unlinks the temp on any rename failure, then rethrows the ORIGINAL error
   — cleanup must not swallow the failure, and the failure must not leave
   `.fileops-tmp-*` litter in the target directory.

## API surface

All functions async. All throw on invalid input. Paths in results are
root-relative with forward slashes.

**Read/metadata**
- `stat(path)` → `{ exists, type, size, modified }` (missing → `{ exists: false }`)
- `read(path, { encoding })` → `{ content, size }`
- `readWindow(path, { offset,length } | { head } | { tail })` → `{ content, size, window }`.
  Exactly one mode. `tail` seeks from EOF in 64KB chunks (never slurps).
- `list(path = '', { recursive, pattern })` → `{ entries }`. Glob `pattern`
  (`*`, `**`, `?`). Skips `.backups/`, `node_modules/`, `.git/`.
- `hash(path, { algo = 'sha256' })` → `{ hash, size }` (streamed).
- `grep(path, pattern, { maxMatches = 100, context = 0, ignoreCase })` →
  `{ matches: [{ path, line, text, before?, after? }], truncated }`. Streams
  line-by-line, skips files >50MB. Returns matches only — bodies stay server-side.
- `snapshotDir(path)` → `{ files: { rel: { size, mtimeMs } } }`;
  `diffSnapshots(before, after)` → `{ added, removed, modified }`.

**Mutations**
- `write(path, content, { encoding, overwrite = false })` → `{ size }`.
  Atomic. Requires `overwrite: true` if target exists.
- `append(path, content, { encoding })` → `{ size }`. O(1), breaks sharing first.
- `replace(path, marker, replacement, { occurrence = 'first' })` →
  `{ size, replacements }`. Server-side marker swap — the large-file edit path.
  Byte-exact string match (not regex). `occurrence`: `'first'` | `'last'` |
  `'all'`. Throws if marker absent (fail loud) or replacement is identical to
  marker. Reads whole file into memory — fine for text docs, not for binaries.
- `copy(from, to, { overwrite = false })` → `{ from, to, size }`. File or dir.
- `move(from, to)` → `{ from, to, type }`. Refuses overwrite.
- `remove(path, { recursive = false })` → `{ deleted: true, previousVersion }`.
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
| storage_write | `OPS.write(..., { overwrite: true })` | preserves historical silent-overwrite contract; snapshots + atomic |
| storage_move | `OPS.move` | |
| storage_delete | `OPS.remove` | files snapshotted; dirs warned, not snapshotted |
| storage_read | `OPS.readWindow` (window args) / legacy inline (no window) | non-window path is agent-level MCP transport policy (INLINE_BYTE_LIMIT, PUBLIC_URL pointer) — correctly stays in agent |
| storage_copy/append/replace/grep/batch | corresponding `OPS.*` | mutating ops return `previousVersion` |

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

## Verified state (2026-09-07)

- `tests/fileops-snapshot.test.js`: 13/13 green — snapshots for
  write/replace/remove/copy-overwrite, retention (10 per path),
  same-second collision counter, `.backups` exclusion, failed-rename temp
  cleanup + error surfacing.
- `tests/fileops.test.js`: 54 pass, 1 symlink env-skip (Windows without dev mode).
- Live-server smoke (storage_write/replace/delete via workshop tools
  returning `previousVersion`) lands on next server restart.
