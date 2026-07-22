# fileops — Implementation Spec (v1, 2026-07-22)

**READ THIS FIRST if you are the model executing this spec.**

This is an execution spec, not a design discussion. Every design decision is
already made. Your job is to carry out the steps below EXACTLY, in order,
verifying each acceptance check before moving on. Do NOT add features, rename
anything, restructure the output shape, or "improve" the design. If a step is
genuinely impossible as written, stop and report — do not improvise a
different design.

Project conventions that apply here (from the repo's prime directive):
- Vanilla Node.js, ES modules (`import`/`export`), zero new npm dependencies.
- 4-space indent, single quotes, semicolons, camelCase.
- Fail loud: invalid input throws immediately with a message naming what was
  missing/invalid. No fallbacks, no defaults for required values, no silent
  catches. `try/catch` only where the failure is genuinely external (fs, net)
  and must be rethrown with context.
- No comments narrating what code does; structural section markers only.

---

## 1. What you are building

A single shared file-operations module for the MCP server, consumed later by
the storage agent, forge worker, vdb, and dreaming. It confines all paths to
a root, performs operations server-side so bytes never cross the LLM context,
and versions every mutation with hardlink snapshots for cheap undo.

Files to create (all new — none exist yet):

```
D:\DEV\mcp_server\src\lib\fileops.js        — the module
D:\DEV\mcp_server\tests\fileops.test.js     — node:test suite
D:\DEV\mcp_server\tests\fileops.bench.js    — manual benchmark script
```

Run tests with: `node --test D:\DEV\mcp_server\tests\fileops.test.js`
Run bench with:  `node D:\DEV\mcp_server\tests\fileops.bench.js`

Existing code you MUST reuse (do not reimplement):
- `D:\DEV\mcp_server\src\agents\storage\path-translator.js`
  exports `createPathTranslator({ localRoot, uncShare })` →
  `{ toLocal, toUnc, isUnc, localRoot, uncShare }`. Import it for UNC handling.

---

## 2. Module construction

`createFileOps({ root, translator = null, keepVersions = 10 })` returns a
frozen object of async functions. NO module-level mutable state — each caller
constructs its own instance. Two instances with different roots must not
interfere (tested).

```javascript
import { createFileOps } from '../src/lib/fileops.js';
const ops = createFileOps({ root: 'D:\\MCP_Storage', translator });
```

On construction: `root` is required (throw if missing); `fs.mkdirSync(root,
{ recursive: true })`; precompute `REAL_ROOT = fs.realpathSync(root)`.

---

## 3. Internal helpers (not exported)

### 3.1 `resolve(userPath)` — confinement, the one thing that must be bulletproof

Lifted from the storage agent's proven `safeResolve`. Same algorithm:

1. Throw if `typeof userPath !== 'string'`.
2. If `translator` is set, `userPath = translator.toLocal(userPath)`.
3. `resolved = path.isAbsolute(p) ? p : path.resolve(root, p)`.
4. Walk up from `resolved` to the nearest existing ancestor, collecting the
   not-yet-created tail segments. `realpath` that ancestor, rejoin the tail.
   (This allows writes to new nested paths while still catching symlink escapes.)
5. If result !== REAL_ROOT and not under `REAL_ROOT + path.sep`,
   throw `Path escapes root: <userPath>`.
6. Return the real absolute path.

Also `rel(absPath)` → root-relative path with `path.sep` replaced by `/`.

### 3.2 `snapshot(targetRel, op)` — versioning (see §5)

### 3.3 `atomicWrite(targetAbs, buffer)` — temp + rename, never in-place

Write buffer to `<targetAbs>.fileops-tmp-<pid>-<counter>` in the same
directory, then `fs.renameSync(tmp, targetAbs)`. Rename swaps the inode, so
any hardlinked versions keep the OLD bytes. This is mandatory — an in-place
truncate would corrupt every version sharing the inode.

### 3.4 Glob matching

Implement a tiny matcher, no dependency: convert a glob pattern to RegExp.
Support `*` (any chars except `/`), `**` (any chars including `/`), `?`
(single char). Escape all other regex metacharacters. This is ~15 lines.

---

## 4. Public API — exact signatures and return shapes

All functions are async. All throw on invalid input (missing required arg,
wrong type). All paths in inputs/outputs are root-relative (forward slashes in
output). "mutating" ops call `snapshot()` first per §5.

### Existing-parity
- `stat(path)` → `{ exists, type: 'file'|'dir', size, modified }`.
  Missing path → `{ exists: false }` (not an error).
- `read(path, { encoding = 'utf8' } = {})` → `{ content, size }`.
  encoding `'utf8'` | `'base64'`. Directory → throw.
- `write(path, content, { encoding = 'utf8', overwrite = false } = {})` → `{ size }`.
  Creates parent dirs. If target exists and `overwrite !== true`, throw
  `write: target exists, pass overwrite:true`. Uses `atomicWrite`. Mutating.
- `list(path = '', { recursive = false, pattern = null } = {})` → `{ entries }`.
  Each entry `{ name, type, size, modified, path }` (path root-relative).
  `pattern` filters by glob on the root-relative path. Skip `.versions/`,
  `node_modules/`, `.git/` always. Iterative stack, never recursion.
- `move(from, to)` → `{ from, to, type }`. Throw if destination exists.
  Mutating (snapshot source, op tag `move`).
- `remove(path, { recursive = false } = {})` → `{ deleted: true }`.
  Non-empty dir without `recursive: true` → throw. Mutating (snapshot first).

### New primitives
- `copy(from, to, { overwrite = false } = {})` → `{ from, to, size }`.
  File: `fs.copyFile`. Dir: `fs.cp(src, dest, { recursive: true })`.
  Existing target without `overwrite: true` → throw. Mutating when overwriting.
- `append(path, content, { encoding = 'utf8' } = {})` → `{ size }`.
  Creates file if missing. If existing file has `stat.nlink > 1` (hardlinked
  versions exist), first break sharing: copy live → temp → rename over live,
  THEN append. See §5 rule 2. Mutating.
- `readWindow(path, opts = {})` → `{ content, size, window }`.
  Modes (exactly one): `{ offset, length }` byte window via positioned read
  (`fs.promises.read` with position); `{ head: N }` first N lines;
  `{ tail: N }` last N lines (seek from EOF in 64 KB chunks, never slurp).
  `window` echoes the mode used. No mode → throw.
- `grep(path, pattern, { maxMatches = 100, context = 0, ignoreCase = false } = {})`
  → `{ matches: [{ path, line, text, before?, after? }], truncated }`.
  `pattern` is a regex source STRING (compile internally; add `i` if
  ignoreCase). Streams line-by-line via `readline` over `createReadStream` —
  never load whole files. Walks dirs recursively (same skips as `list`).
  Stop after `maxMatches`, set `truncated: true`. Skip files > 50 MB (log and
  continue). `context: N` attaches N lines before/after each match.
- `batch(opsList, { onError = 'collect' } = {})` → `{ results }`.
  `opsList`: array of `{ op, ...args }` where `op` is one of the public
  function names. Execute SEQUENTIALLY in order. Each result
  `{ op, ok: true, ...returnValue }` or `{ op, ok: false, error }`.
  `onError: 'collect'` (default) continues after failures; `'abort'` stops at
  first failure (remaining ops omitted from results). Unknown op name → that
  item is `ok:false` with error, does not throw the batch.
- `writeFromUrl(path, url, { allowedPrefixes = [], overwrite = false } = {})`
  → `{ size, mime }`.
  Throw unless `url` starts with one of `allowedPrefixes` (empty list → throw
  `writeFromUrl: no allowedPrefixes configured`). `fetch(url)`, throw on
  `!res.ok`, stream body to temp file, then rename into place (atomic).
  Mutating. MIME from response `content-type` header.
- `hash(path, { algo = 'sha256' } = {})` → `{ hash, size }`.
  Stream through `crypto.createHash`, hex digest.
- `snapshotDir(path)` → `{ files: { [relPath]: { size, mtimeMs } } }`.
  Manifest of a subtree. `diffSnapshots(before, after)` →
  `{ added: [], removed: [], modified: [] }` (relPaths). These two absorb
  forge's private helpers.

### Versioning ops
- `history(path)` → `{ versions: [{ version, op, size, modified }] }`,
  newest first. No versions → `{ versions: [] }`.
- `restore(path, { steps = 1 } = {})` → `{ restored, from }`.
  Snapshot CURRENT state first (op tag `restore`), then copy the chosen
  version's bytes over the live file via atomicWrite. `steps` counts back
  through `history`. `steps` > available versions → throw.

---

## 5. Versioning rules (hardlink snapshots)

Versions live at `<root>/.versions/<mirrored-relative-path>/<stamp>_<op>`
where `<stamp>` is `new Date().toISOString()` with `:` and `.` replaced by
`-` (filesystem-safe, sorts chronologically).

`snapshot(targetRel, op)`:
1. Resolve live path. If it doesn't exist, return (nothing to preserve).
2. Compute version path, `mkdirSync` its parent.
3. `fs.linkSync(live, versionPath)` — hardlink. One syscall, zero bytes.
   On `EXDEV` (cross-device, only possible if root spans volumes): fall back
   to `fs.copyFileSync` and log a warning. Never silent.
4. Prune: list the version dir, if more than `keepVersions` entries, delete
   oldest (by name sort) until at the limit.

Correctness invariants (tested):
- Every mutation goes through `atomicWrite` (new inode) — versions keep old bytes.
- `append` on a file with `nlink > 1` breaks sharing BEFORE appending.
- `restore` snapshots current state first, so undo is undoable.
- `.versions/` is skipped by `list`, `grep`, `snapshotDir`.

---

## 6. Steps to execute, in order

### Step 1 — scaffolding + confinement
Create `src/lib/fileops.js` with `createFileOps`, `resolve`, `rel`, and ONLY
`stat`, `read`, `write`, `list` implemented (write uses atomicWrite; no
versioning wired yet).

Acceptance: a scratch script constructs an instance on a temp dir, writes a
file, reads it back, lists it, and `resolve('../../etc')` throws.

### Step 2 — remaining primitives
Add `move`, `remove`, `copy`, `append`, `readWindow`, `grep`, `hash`,
`snapshotDir`, `diffSnapshots`. No versioning yet (append's nlink rule is
inert until snapshots exist — implement it anyway).

Acceptance: scratch script exercises each once against a temp dir.

### Step 3 — versioning
Add `.versions/` handling, `snapshot()`, pruning, `history`, `restore`, and
wire `snapshot()` into every mutating op per the matrix in §5. Wire the
overwrite guards per §4.

Acceptance: scratch script — write v1, overwrite with v2, `history` shows 1
version, `restore` brings back v1's exact bytes, and the pre-restore v2 state
is itself in history.

### Step 4 — `batch` + `writeFromUrl`
Add both. `writeFromUrl` tested against a local `http.createServer` in the
test file (never the network).

Acceptance: batch of mixed ops returns per-op results; a failing op in
`collect` mode doesn't stop the rest; `writeFromUrl` rejects a URL not in
`allowedPrefixes`.

### Step 5 — full test suite
Write `tests/fileops.test.js` using `node:test` + `node:assert/strict`.
Every test uses a fresh `fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-'))`
root and cleans up after itself. Cover, at minimum:

- confinement: `../` escape throws; absolute path outside root throws;
  symlink pointing outside root throws; UNC-form path translates when a
  translator is configured (construct a real `createPathTranslator` with a
  fake share); write to not-yet-created nested path works.
- write/overwrite guard: overwrite without flag throws.
- copy: file, dir, refuse-overwrite, overwrite:true.
- append: creates missing file; appends to existing; after a snapshot exists
  (nlink>1) the VERSION's bytes are unchanged after append.
- readWindow: offset/length; head N; tail N on a 10,000-line generated file;
  tail larger than file.
- grep: matches across nested files; maxMatches sets truncated; context
  lines; no-match returns empty; `.versions/` content is not searched.
- batch: all-ok; collect-on-error partial results; abort-on-error stops;
  unknown op name is per-item failure.
- writeFromUrl: serves from in-test http server; prefix rejection.
- hash: deterministic; changes when content changes.
- list glob: `*.md` top-level; `**/*.md` recursive; `.versions` excluded.
- versioning: snapshot → modify → version bytes intact; retention prunes to
  keepVersions; restore round-trip; restore-of-restore.
- isolation: two instances on different roots, operations don't cross.

Acceptance: `node --test` exits 0.

### Step 6 — benchmark
Write `tests/fileops.bench.js`: copy a 100 MB file, grep a 50 MB generated
file, batch of 1000 small writes vs 1000 individual `write` calls. Print
timings to stdout.

Acceptance: runs to completion, prints numbers. No threshold assertions —
this is a reporting tool.

### Step 7 — report
Report: files created, test count and pass count, bench numbers, any
deviations from this spec (there should be none).

---

## 7. Explicit non-goals (do not build)

- No MCP tool schemas, no agent wiring. That's a later step, separately specced.
- No chunk-level/content-addressed dedup. Hardlinks only.
- No journaling of operations (the version snapshots ARE the history).
- No locking/concurrency control beyond atomic rename.
- No support for watching, streaming tail -f, or partial-line reads.
- Do not modify `path-translator.js` or any existing agent file.
