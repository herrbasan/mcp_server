# Storage System — storage agent

Reference documentation for the scoped filesystem storage. Last verified
2026-09-22 against `src/agents/storage/index.js`, `src/agents/storage/config.json`,
`src/lib/fileops.js`, and root `config.json`.

## What it is

A persistent, root-confined file store under one directory — the shared
notebook every platform (VS Code, chat app, forge workers) reads and writes.
18 file tools + 3 MCP-resource bridge tools + an HTTP REST surface, all
backed by a single file-operations engine (`fileops`, documented separately
in `documentation/fileops.md`).

Config (root `config.json` → `agents.storage`):

| Key | Effective value | Effect |
|---|---|---|
| `root` | `D:\MCP_Storage` | Storage root; every path is confined under it. |
| `uncShare` | `\\BADKID\Stuff\MCP_Storage` | UNC ↔ local path translation for LAN callers. |
| `publicUrl` | `http://192.168.0.100:3100` | (Present; pointer responses deliberately stay relative — clients prepend their own origin.) |
| `maxReadSize` | 10 MB (10485760) | Above: pointer/truncated response instead of inline content. |
| `maxWriteSize` | 100 MB (104857600) | Writes and PUT uploads above this are rejected (413 on HTTP). |

## Path handling

- **Confinement**: every path resolves through `safeResolve` — relative paths
  against the root, ancestor-walk + `realpath` so not-yet-created paths work
  while symlink escapes throw `Path escapes storage root`. Escapes **throw**,
  never clamp.
- **Root aliases**: `/`, `\`, `*`, `/*` all mean the storage root itself;
  leading slashes on subpaths are stripped.
- **UNC translation** (`path-translator.js`): `\\BADKID\Stuff\MCP_Storage\x` ↔
  `D:\MCP_Storage\x` (exact prefix, case-insensitive) before resolution —
  without it UNC segments silently nest as literal directories. Unrelated UNC
  paths pass through unchanged; no implicit access to other shares.
- **Ghost-char detection**: listings flag invisible/problematic filename
  characters (zero-width, BOM, bidi, C0/C1, Private Use) with
  `nameWarning: invisible char(s): U+…` — copied names that silently drop
  these characters cause phantom ENOENT.

## Response contracts (issue #12 — read this before wrapping results)

- **utf8 reads return raw text, not JSON.** The file content IS the tool
  result, verbatim. A JSON object response is a *pointer*, not content:
  - `inline: false` + `path: "/storage/…"` → fetch that path over HTTP
    (prepend your MCP server origin).
  - `truncated: true` → file exceeds `maxReadSize`; page through with
    offset+length windows.
- **64 KB inline threshold** (`INLINE_BYTE_LIMIT`): utf8 files above it are not
  inlined (the MCP transport dies around 400 KB) — you get the pointer
  response instead. base64 results always stay wrapped in a JSON envelope.
- **Self-verification**: every mutating op re-stats the disk after the engine
  returns and includes `verified: true, size, mtime`. `ok: true` means the
  bytes are provably on disk; a mismatch throws instead of lying.
- Every tool returns `{ content: [{ type: 'text', text }], isError? }`.

## Tool catalog

### Read

| Tool | Args | Behavior |
|---|---|---|
| `storage.stat` | `path?` | exists/type/size/modified. Defaults to root. |
| `storage.read` | `path*`, `encoding?` utf8\|base64, window: `offset`+`length` (bytes) OR `head` N OR `tail` N (mutually exclusive; `offset` requires `length`) | Raw text for utf8 (full file ≤64 KB, windowed text always raw). Directory read throws. |
| `storage.readMany` | `paths*: string[]` | Bulk read, one call. Delimited `════` plain-text stream; per-file errors and too-large pointers inline (`✗` error / `△` pointer). |
| `storage.list` | `path?`, `recursive?`, `detail?` compact\|full | Compact (default): one line per entry, human sizes, `✓` marks dirs containing an `Agents.md` briefing (read it first — directory-specific instructions), 2000-entry cap with TRUNCATED flag. `full`: JSON with ISO timestamps. Recursive renders grouped by subdirectory. |
| `storage.recent` | `path?`, `limit?` (default 20, max 200), `ignoreDirs?` (default `['nvdb','forge','temp','_trash']`) | N most recently modified files — "what was recently worked on". |
| `storage.search_file` | `query*`, `path?`, `limit?` (default 20, max 200) | Find by NAME (exact basename first `=`, substring `~`). No embeddings. |
| `storage.search` | `query*`, `folder?`, `extension?`, `top_k?` (default 10), `include_content?` | Semantic content search via the vdb agent (`storage` collection). |
| `storage.grep` | `path?`, `pattern*` (JS regex), `maxMatches?`, `context?` (lines), `ignoreCase?` | Line matches + truncated flag. |
| `storage.find` | `path?`, `marker*` (aliases `oldString`, `pattern`), `occurrence?` | Probe: does this exact string exist? Returns found/count/line/offset/snippet — content never enters context. Pre-flight for `storage.replace`. |

### Write / modify

| Tool | Args | Behavior |
|---|---|---|
| `storage.write` | `path*`, `content*`, `encoding?` | **Full-file replacement only** — `content` must be the ENTIRE file. Atomic (temp+rename), snapshots prior content. |
| `storage.import` | `files*: [{path, content, encoding?}]` | Bulk write, one call, all entries validated BEFORE touching disk. Each file individually verified. Use for 2+ writes. |
| `storage.append` | `path*`, `content*`, `encoding?` | O(1) append; cannot destroy prior content (no snapshot needed). |
| `storage.replace` | `path*`, `marker*` (alias `oldString`), `replacement*` (alias `newString`), `occurrence?` first\|last\|all | Targeted marker swap, server-side, line-ending-agnostic multi-line markers. Marker-not-found errors are diagnostics: file size, closest anchor, line number, nearby snippet. |
| `storage.batch` | `ops*: [{op, …args}]`, `onError?` collect\|abort | Mixed ops in one atomic call. |
| `storage.move` | `from*`, `to*` | Rename/relocate. Refuses to overwrite. |
| `storage.copy` | `from*`, `to*`, `overwrite?` | Copies; snapshots destination's prior content when overwriting. |
| `storage.delete` | `path*`, `recursive?` (required for non-empty dirs), `trash?` | Default PERMANENT. `trash: true` → soft delete to `_trash/<timestamp>/<original-path>` (VDB-excluded, still listable/readable), returns `trashPath` + `restorableVia`. |
| `storage.restore` | `path*` (inside `_trash`) | Undoes a trash. Destination collision → `.restored-<ts>` suffix, never overwrites. |

Editing cheatsheet: targeted edit = `replace` (pre-flight `find`) · append =
`append` · full rewrite = `write` · bulk = `import`/`readMany`/`batch`.

### MCP resources bridge

`storage.resources_list` / `storage.resources_read` / `storage.resources_templates`
expose the MCP resource provider (`storage://<relative-path>` URIs) as regular
tools for clients that only speak `tools/call`.

## Snapshots & trash (recovery model)

- Every destructive op copies the target's prior content to
  `<root>/.backups/<mirrored-path>.<timestamp>[-NN]` BEFORE mutating — plain
  copies, last 10 per path (`SNAPSHOTS_KEEP`), same-second writes get a
  zero-padded counter. Mutating responses return `previousVersion` (backup
  path or null). `.backups/` is excluded from list/grep/recursion/VDB.
- **Directories are never snapshotted** (unbounded) — directory deletes log a
  loud warn and are unrecoverable.
- `_trash/` entries are not snapshotted — the trash entry IS the backup.

## REST API (same server, port 3100)

- `GET /storage` — root listing JSON.
- `GET /storage/<path>` — streams file content with mime guessing; directories
  return a listing JSON. 403 on confinement errors, 404 when missing.
- `PUT /storage/<path>` — raw binary upload (any Content-Type), streamed to a
  temp file then atomically renamed. Enforces `maxWriteSize` with 413.
  Bypasses MCP JSON-RPC transport limits — the right channel for large blobs.

The VDB agent indexes the storage root for `storage.search` (5-minute scan
cycle; see `documentation/tools/vdb.md`).

## Forge interplay

Forge tool outputs land at `<root>/forge/<tool-name>/` and are listed in the
`forge.call` response as `_outputs` (each with a `path` for `storage.read`, a
relative HTTP `url`, and a `uncPath` for direct SMB when `uncShare` is
configured). `<root>/temp/` is a scratch area excluded from the VDB index —
use it for rollback checkpoints (copy before risky edit, copy back to undo).
