# Storage Agent — Scoped Filesystem Tools

> A filesystem *is* a database. The storage agent exposes a small, robust set of
> filesystem operations confined to a storage root. No blobs, no content addressing,
> no versioning layer — just files and directories the LLM and the user can both see.

---

## Why this exists

The storage agent is a **smart notebook** for the LLM: a bounded filesystem where it
can create, organize, and maintain documents, projects, and generated artifacts.

Typical uses:

- Maintain a personal wiki or blog (`blog/2026-06-20-idea.md`)
- Keep running notes and plans (`notes/`, `plans/`)
- Store outputs from forged tools (converted media, exports, reports)
- Build simple structured datasets where the LLM itself maintains the index
  (`index.json`, `manifest.json`)

The user interacts with the same files directly — in Explorer, in an editor, via
grep. The LLM interacts through the storage tools. The filesystem is the shared
ground truth.

### What this is NOT

- **Not a versioning system.** If history is needed for specific things, that's git
  (as Forge uses). The storage agent does not solve versioning globally.
- **Not a deduplicating blob store.** Distinct artifacts are distinct files. Disk
  hygiene is handled by a simple size/age sweep if ever needed.
- **Not a database with built-in queries.** There are no tags, no indexes, no full-text
  search in the agent. If the LLM wants fast lookup, it maintains an `index.json`
  or similar file itself — which is trivial because it has read/write access.
- **Not magic.** Files are normal files. The LLM is responsible for deciding on
  structure, naming, and organization.

---

## Architecture

```
data/storage/              ← the storage root (configurable)
  blog/
    2026-06-20-idea.md
    2026-06-21-storage-spec.md
  notes/
    random-thoughts.md
    book-list.md
  plans/
    2026-q3-goals.md
  exports/
    report.pdf
    q4-data.csv
  index.json               ← maintained by the LLM if desired
```

The agent is a thin wrapper around `fs` with one critical responsibility: **path
confinement**. Every operation resolves the requested path against the storage root
and rejects anything that escapes it.

### Agent layout

```
src/agents/storage/
  config.json     ← tool definitions + input schemas
  index.js        ← handlers + path confinement logic
```

Registered via the standard agent loader. No dependencies, no native modules, no
external services.

---

## Path Confinement (the one thing that matters)

All tools accept a `path` parameter relative to the storage root. Before any
filesystem operation, the path is resolved and verified to be inside the root:

```js
function safeResolve(userPath) {
    const resolved = path.resolve(STORAGE_ROOT, userPath);
    const realRoot = fs.realpathSync(STORAGE_ROOT);
    const realTarget = fs.realpathSync(resolved);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        throw new Error(`Path escapes storage root: ${userPath}`);
    }
    return realTarget;
}
```

This blocks:
- `../` traversal (`../../etc/passwd`)
- Absolute paths (`/etc/passwd`, `C:\Windows\system32`)
- Symlinks pointing outside the root, whether on the final component or on an
  intermediate directory

`fs.realpathSync` resolves the entire path, including any symlinked directories,
and the result is checked against the real path of the storage root. This is the
only robust way to guarantee confinement on both Unix and Windows.

---

## Tools (6)

### `storage_stat({ path })`

Check whether a path exists and what type it is, without reading content.

- `path` — relative path within storage root

Returns: `{ exists: true, type: "file" | "dir", size, modified, path }` or
`{ exists: false, path }`.

This lets the LLM probe structure without catching read errors or listing parent
directories. Useful before writes, moves, or index maintenance.

### `storage_read({ path, encoding? })

Read a file. Returns contents as text (default) or base64 (for binaries).

- `path` — relative path within storage root
- `encoding` — `"utf8"` (default) or `"base64"`

**Size guard:** Files above a configurable threshold (default: 10 MB) return a
metadata pointer `{ path, size, truncated: true }` instead of inline content. The
LLM should not pull 100 MB files into a tool result payload.

Returns: `{ content, encoding, size }` or `{ path, size, truncated }` if oversized.

### `storage_write({ path, content, encoding? })`

Write a file. Creates parent directories automatically. Overwrites existing files.

- `path` — relative path within storage root
- `content` — file content (string for utf8, base64 string for binary)
- `encoding` — `"utf8"` (default) or `"base64"`

Returns: `{ path, size }` — the absolute filesystem path and bytes written.

The returned `path` is the **absolute filesystem path** (e.g.
`D:\DEV\mcp_server\data\storage\conversions\report.mp3`). This is what the LLM hands
to the user. The user can open it directly.

### `storage_list({ path?, recursive? })`

List a directory. Returns entries with name, type (`file`/`dir`), size, and
modified time.

- `path` — directory to list (default: root)
- `recursive` — if true, lists all descendants as a flat path list (default: false)

Returns: `{ entries: [{ name, type, size, modified, path }] }`

Entry `path` values are **relative to the storage root**, consistent with tool
inputs. The LLM can pass them directly into another storage call.

### `storage_move({ from, to })

Rename or move a file or directory. Preserves contents. Throws if the destination
already exists (file or directory). The LLM must explicitly delete first if it
wants to replace something.

- `from` — source path within storage root
- `to` — destination path within storage root

Returns: `{ from, to, type }`

### `storage_delete({ path, recursive? })`

Delete a file or directory.

- `path` — target within storage root
- `recursive` — required to delete non-empty directories (default: false). If
  false and target is a non-empty dir, throws.

Returns: `{ path, deleted: true }`

**No trash, no soft delete.** Deletion is permanent. The LLM is trusted not to
delete without reason. If recovery is ever needed, that's what OS-level backup or
git is for.

---

## Operation Result Contract

Every tool returns a **structured result** that makes success and failure
unambiguous to the LLM. All results follow this shape:

```json
{
  "ok": true,
  "op": "storage_write",
  "path": "blog/2026-06-20-idea.md",
  "absPath": "D:\\DEV\\mcp_server\\data\\storage\\blog\\2026-06-20-idea.md",
  "size": 1234,
  "error": null
}
```

Or on failure:

```json
{
  "ok": false,
  "op": "storage_write",
  "path": "blog/2026-06-20-idea.md",
  "absPath": "...",
  "size": null,
  "error": "EBUSY: resource busy or locked, open '...'"
}
```

### Why this shape

- **`ok`** — boolean the LLM can branch on immediately. No need to inspect nested
  `isError` fields or parse text.
- **`op`** — the operation name, so a chained sequence is easy to reason about.
- **`path` + `absPath`** — both the requested relative path and the resolved
  absolute path. The LLM can report either; the user gets a real filesystem path.
- **`error`** — the raw Node.js error message. If another process holds the file
  (`EBUSY`), permissions fail (`EACCES`), or the disk is full (`ENOSPC`), the LLM
  sees exactly why.

### Failure handling philosophy

Per project philosophy, **failures are not swallowed**. The handler lets Node.js
errors propagate, but wraps them in the result contract above so the LLM gets a
clean, actionable signal. No retry loops, no silent fallbacks, no "unknown error".

The LLM can then decide what to do: retry, ask the user, rename the file, or
inspect the directory.

---

## Robustness Rules

These are the design constraints that make the simple tools safe enough to expose
to an autonomous LLM:

### 1. Path confinement is non-negotiable
Every tool calls `safeResolve()` before touching the filesystem. No exceptions, no
"trusted" bypass paths. The storage root is the only world these tools know.

### 2. Fail loud, fail fast
Per project philosophy: no defensive try/catch, no silent fallbacks. If a write
fails (disk full, permissions), the error propagates. The LLM sees the real error
and can reason about it.

### 3. Size limits on read
`storage_read` refuses to inline files above the threshold. This prevents a 200 MB
video from being pulled into an MCP result payload and blowing up context. The LLM
gets a pointer, not the bytes.

### 4. No silent overwrites
`storage_write` can overwrite an existing file (normal filesystem behavior), but
`storage_move` refuses to overwrite any existing destination. The LLM must
delete the target first if it wants to replace it. This removes ambiguity about
whether a move replaced a file, a directory, or failed partway through.

### 5. Recursive delete requires explicit opt-in
`storage_delete` on a directory requires `recursive: true`. This is a speed bump,
not a permission system — the LLM can still pass it — but it forces a deliberate
choice rather than a default that nukes a folder.

### 6. Parent directories are auto-created
`storage_write` runs `fs.mkdir({ recursive: true })` on the parent before writing.
The LLM shouldn't need a separate "create directory" call just to write a file.
Empty directories are created as a side effect and persist naturally.

### 7. Direct writes
`storage_write` writes directly to the target path. There is no temp-file dance
and no rename. This is simpler and avoids cross-platform atomicity edge cases.
A crash during a write can leave a partially written file, but the LLM will see
the failure and can rewrite. For a local notebook used by one person, this is
the right tradeoff: robustness through simplicity and clear status, not through
complex atomic machinery.

---

## Configuration

In `config.json`:

```json
{
  "agents": {
    "storage": {
      "root": "data/storage",
      "maxReadSize": 10485760,
      "maxWriteSize": 104857600
    }
  }
}
```

- `root` — storage root path, relative to project root or absolute (default: `data/storage`)
- `maxReadSize` — byte threshold above which `storage_read` returns a pointer
  instead of inline content (default: 10 MB)
- `maxWriteSize` — byte threshold above which `storage_write` refuses the write
  to prevent disk-filling (default: 100 MB)

The root directory is created on agent init if it doesn't exist.

### Lock contention and external tools

Because the user may have files open in an editor, `storage_write` can encounter
`EBUSY`. The agent fails immediately and returns the exact error:

```
EBUSY: resource busy or locked, open 'D:\DEV\mcp_server\data\storage\notes\book-list.md'
```

There is no retry loop. The LLM sees the real reason and decides what to do:
ask the user to close the file, write to a different path, or try again. This is
simpler than a timeout-based retry and keeps failure behavior predictable.

### Absolute path exposure

The result contract returns `absPath` (e.g. `D:\DEV\mcp_server\data\storage\...`).
This is intentional: the user can open the file directly in their editor or
Explorer. In a hosted or multi-tenant deployment, this may leak internal server
layout and should be replaced with a virtual path or download URL. For local,
single-user orchestrator use, the tradeoff is correct.

---

## Relationship to Forge

Forge uses git for tool source versioning and temp directories for per-call
workspaces. The storage agent is **orthogonal** — it's for durable artifacts the
LLM produces for the user, not for Forge's internal execution state.

A Forge tool that produces an output file can write it to the storage root (either
directly via `fs` if it has the path, or by returning the bytes and letting the LLM
call `storage_write`). The LLM then returns the storage path to the user.

---

## What was considered and rejected

### Custom content-addressed VFS (the original exploration doc)
Proposed `blobs/{hash}`, directory node serialization, `versions.json`, GC. Rejected
because it reinvented git's object model without git's durability tooling, and
solved problems (dedup, versioning, empty dirs) that the actual usecase doesn't have.

### nDB file buckets
nDB's SHA-256 dedup and GC are excellent, but file buckets store binaries as
hash-named files (`a1b2c3d4.mp3`) inside a content-addressed store. The user can't
open "the report" — they'd need an export step. For a usecase where the whole point
is "give me a path I can open," this is the wrong abstraction.

### Tagged blob store (KV with dedup)
A middle ground: flat key-value store with content-addressed blobs and tag-based
retrieval. Rejected because it still hides files behind an API when the filesystem
already gives us human-named, browsable, directly-openable files for free.
