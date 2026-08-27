# Migrate the nDB memory store to database-as-a-folder

> **Status**: DONE (2026-08-27). Phase 1 (folder cutover) complete — commit 68f6537,
> e2e verified live. Phase 2 (category normalization) complete — 468 docs,
> 175 → 58 categories, integrity verified, dream map regenerated.
> Trash compaction intentionally deferred (policy: never hard-delete; compact
> manually during a server stop if ever needed). Cleanup artifacts
> (`scripts/_verify.mjs`, `%TEMP%\ndb-folder-test`, `data/_backup/`) can be
> removed after a settle period.
>
> This completes the structure already specified (but not implemented) in
> [`memory-ndb-migration-plan.md`](./memory-ndb-migration-plan.md) §2 — that plan
> targeted `data/memories/` (folder format) from the start; the implementation
> landed on a flat file instead.
>
> **Execution log 2026-08-27**:
> - Step 0 sweep ✓ — only runtime consumer: `src/agents/memory/index.js` (via
>   config `dbPath`). Dreaming agent reads via `memoryAgent.memories.iter()`
>   (no path refs). VDB agent couples via nVDB `memory` collection (embeddings
>   keyed by `mem_<id>`), path-independent.
> - Step 1 backup ✓ — `data/_backup/memories-20260827-072033.jsonl` + trash copy.
>   Baselines: live 5484 lines = **1574 docs** (1573 `mem_` + 1 `_meta`);
>   trash 15 lines = 14 tombstones + 1 `_meta` header. NOTE: jsonl is
>   multi-line per doc — doc count is the parity metric, not line count.
> - Step 2 dry-run ✓ — temp copy at `%TEMP%\ndb-folder-test`, verified via
>   `scripts/_verify.mjs` (delete after migration): len 1574, `mem_` 1573,
>   `_meta` 1, deleted 14, `find('id')`=1. `hasIndex('id')` false at open is
>   NORMAL — indexes are built by the memory agent at init.
> - Whole `data/` folder additionally backed up by owner before cutover.

## Goal

Move the nDB memory store from:

```
data/memories.jsonl                ← current (flat)
data/_trash/docs/memories.jsonl    ← its sibling trash
```

to the canonical folder layout:

```
data/memories/
├── data.jsonl                     ← document store (this file is passed to Database.open)
├── _trash/
│   └── docs/data.jsonl            ← soft-deleted memories
└── _files/                        ← created implicitly if buckets are ever used (none today)
```

## Why

- **It's the intended design.** `memory-ndb-migration-plan.md` §2 already specified
  `data/memories/` as the target. The current flat file is a deviation.
- **nDB's canonical convention.** Folder mode is self-contained, portable, per-database
  `_files/`/`_trash/`, and `meta.json`/schema-ready.
- **`_files/` collision risk.** nDB creates `_files/` and `_trash/` as *siblings of the
  `.jsonl`*. Two nDB stores in the same directory share `_files/`. Folder mode keeps each
  store's buckets/trash inside its own directory.

---

## Step 0 — SWEEP: find every nDB consumer (do this first)

The memory agent is the confirmed nDB consumer, but **verify there are no others** before
migrating. There may be additional consumers. From the project root:

```powershell
Get-ChildItem -Recurse -File -Include *.js,*.mjs,*.cjs,*.json |
  Where-Object { $_.FullName -notmatch 'node_modules|\.git|_Archive|logs' } |
  Select-String -Pattern "loadNdb|Database\.open|new Database|memories\.jsonl|require\(.*ndb|from .*ndb"
```

**Distinguish nDB from nVDB** — they are different engines:

| Engine | Marker | Opened how | Migrate? |
|--------|--------|-----------|----------|
| **nDB** | `import { loadNdb } from '.../ndb-loader.js'` | `Database.open(path)` on a **`.jsonl`** file | **Yes** |
| **nVDB** | `loadNvdb` | `new Database(path)` on a **folder** (`data/nvdb`) | **No** — different engine, leave it |

**Known from a prior sweep (2026-08-27)** — re-confirm, don't trust blindly:

- `src/agents/memory/index.js` — **nDB** memory store at `data/memories.jsonl` (line ~76: `Database.open(dbPath, { persistence: 'immediate' })`). **The consumer to migrate.**
- `src/agents/vdb/index.js` — **nVDB** at `data/nvdb` (do not touch).
- `scripts/cleanup-vdb-garbage.js` — **nVDB** (do not touch).
- `scripts/migrate-memories-to-ndb.js` — historical one-shot (already run); update path refs only.
- `config.json` → `agents.memory.dbPath = "data/memories.jsonl"`.

If the sweep finds **other nDB `.jsonl` files under `data/`** that share `data/_trash/`, handle
them together in the same cutover.

---

## Step 1 — Backup (before touching anything)

Copy the live store and its trash to a timestamped backup outside the repo (or a backup dir):

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force "$PWD/data/_backup" | Out-Null
Copy-Item data/memories.jsonl                    "data/_backup/memories-$ts.jsonl"
Copy-Item data/_trash/docs/memories.jsonl        "data/_backup/memories-trash-$ts.jsonl"
```

Record baseline line counts (should match post-cutover):

```powershell
(Get-Content data/memories.jsonl | Where-Object { $_.Trim() -ne '' }).Count
(Get-Content data/_trash/docs/memories.jsonl | Where-Object { $_.Trim() -ne '' }).Count
```

---

## Step 2 — Validate on a throwaway copy (recommended, do not skip)

1. Copy to a temp folder as the target structure:
   ```powershell
   $t = Join-Path $env:TEMP "ndb-folder-test"
   New-Item -ItemType Directory -Force "$t\data\memories\_trash\docs" | Out-Null
   Copy-Item data/memories.jsonl               "$t\data\memories\data.jsonl"
   Copy-Item data/_trash/docs/memories.jsonl   "$t\data\memories\_trash\docs\data.jsonl"
   ```
2. Open it with the **real binding** and confirm parity with the live store. Use the
   memory agent's loader so the native binary resolves exactly as the server uses it:
   ```js
   // scripts/_verify.mjs (temporary — delete after)
   import { loadNdb } from '../src/agents/memory/ndb-loader.js';
   const { Database } = loadNdb();
   const db = Database.open(process.argv[2]);
   const it = db.iter();
   console.log('len      :', db.len());
   console.log('mem_ docs:', it.filter(d => (d._id||'').startsWith('mem_')).length);
   console.log('_meta    :', it.filter(d => (d._id||'').startsWith('_meta')).length);
   console.log('deleted  :', db.deletedIds().length);   // should equal trash doc count
   const m = it.find(d => (d._id||'').startsWith('mem_'));
   if (m) console.log('find(id) :', db.find('id', m.id).length);
   ```
   ```powershell
   node scripts/_verify.mjs "$t\data\memories\data.jsonl"
   ```
   Expected: `len` == live `len`; `_meta` present with `nextId` intact; `deleted` == trash
   doc count; `find('id')` returns 1. Delete the script when done.
   > Do **not** open the live `data/memories.jsonl` for write while the server runs.

---

## Step 3 — Stop the server

The server holds `data/memories.jsonl` open for append; on Windows it **cannot be moved while
running**. Also, changing `dbPath` in `config.json` *before* the file is moved would make a
restart create an **empty** database. Both the config change and the file move must happen
atomically, **while the server is stopped**.

- mcp_server runs as `npm start` → `node src/server.js` on port 3100.
- **Get the owner's go-ahead first** — this is a live service. Do not restart it yourself.

---

## Step 4 — Move the files (server stopped)

```powershell
New-Item -ItemType Directory -Force data/memories/_trash/docs | Out-Null
Move-Item data/memories.jsonl                data/memories/data.jsonl
Move-Item data/_trash/docs/memories.jsonl    data/memories/_trash/docs/data.jsonl
# Remove the now-empty data/_trash (only after confirming nothing else uses it)
Get-ChildItem data/_trash -Recurse -Force   # should be empty
Remove-Item -Recurse -Force data/_trash
```

---

## Step 5 — Update code paths (same cutover, server still stopped)

- `config.json`: `"dbPath": "data/memories.jsonl"` → `"data/memories/data.jsonl"`
- `src/agents/memory/index.js` (~line 76): the fallback default
  `CONFIG.dbPath || 'data/memories.jsonl'` → `CONFIG.dbPath || 'data/memories/data.jsonl'`
- `scripts/migrate-memories-to-ndb.js`: update historical path refs for consistency (cosmetic —
  the script has already been run; it is not part of the runtime).

Do this **in the same step as the file move** — a `dbPath`/file mismatch is the one way to
lose the store.

---

## Step 6 — Start the server

```powershell
npm start
```

Confirm the memory agent init log:
`[Memory] Initialized: <N> memories in nDB at <...>\data\memories\data.jsonl`.

---

## Step 7 — Verify

- `memory_store`, `memory_recall`, `memory_overview`, `memory_list`, `memory_get`,
  `memory_forget` all work.
- A new `memory_store` appends a line to `data/memories/data.jsonl`.
- A `memory_forget` (soft delete) writes a tombstone to `data/memories/_trash/docs/data.jsonl`
  and `memory_restore` brings it back.
- The `id` index is recreated at init (`hasIndex('id')` true after startup).

---

## Step 8 — Cleanup

- Remove the empty `data/_trash/` if Step 4 didn't.
- Keep `data/_backup/` until post-cutover verification passes, then delete it.
- Delete the throwaway `%TEMP%\ndb-folder-test` copy and any temporary `scripts/_verify.mjs`.

---

## Safety rules (non-negotiable)

1. **Live service** — coordinate stop/start with the owner; never restart it yourself.
2. **Atomic config + move** — both happen while stopped. A mismatch creates an empty DB.
3. **Do not touch nVDB** (`data/nvdb`, `loadNvdb`) — it is a different engine, not part of this migration.
4. **Keep the backup** until verification passes.
5. **Sweep first** — confirm the memory agent is the only nDB consumer before moving.

---

# Phase 2 — Database cleanup (planned, NOT yet executed)

Runs AFTER Phase 1 is verified live. Server stopped again for any write pass.

## Census findings (2026-08-27, read-only)

- **1573 mem docs, all `embedded`, 14 tombstones.** Healthy store.
- **Category chaos — the main cleanup target.** ~200 distinct categories with:
  - case variants: `Digital Twin`/`digital-twin`, `Arena`/`arena`, `nVoice`/`nvoice`, `nspeech`/`nSpeech`
  - variant spellings/forms: `bug`/`bug-fix`/`bugs-fixed`/`bug fix`, `Preferences`/`user preference`/`personal preference`
  - junk compounds: `storage, mcp, transport, browser, workaround` (comma lists as categories)
  - Could collapse to ~40 canonical categories. `category` is an indexed field —
    normalization improves `memory.list` filtering and index selectivity.
- **456 docs with no/tiny `data`** — legitimate per design (description-only stores). Not garbage; leave.
- **Suspect junk docs (small review list)**: `json_export_test`, `conversation_meta`,
  4× `probe-result` — eyeball before deciding.
- **Old docs (Jan–Apr, 21 items)** — dreamer already scores these down; no age-based purge.

## Consumers affected by cleanup

| Consumer | Coupling | Cleanup consideration |
|---|---|---|
| memory agent | indexed `category` field | normalization must keep index consistent (update via nDB, not raw file edits) |
| dreaming agent | dream map nodes carry category | force `dream_generate` after normalization so map matches |
| vdb agent | nVDB `memory` collection vectors keyed `mem_<id>` | hard-deletes must purge vectors (init already does this via `deletedIds`); check if vectors carry `category` in payload → patch/re-embed if so |

## Steps

1. Backup `data/memories/` folder (timestamped, same as Phase 1).
2. **Category normalization**: build mapping table (case-fold + variant merge +
   compound-split → one primary tag). SHOW OWNER THE TABLE before running.
   One-shot script rewriting `category` on affected docs (~⅓ of store) via nDB API.
3. **Trash compaction**: `db.compact()` drops the 14 tombstones.
4. **Junk review**: present the ~6 suspect docs for owner yes/no per item.
5. nVDB vector/category check (see table above) — patch or re-embed affected IDs.
6. Force `dream_generate` so the map reflects normalized categories.
7. Verify: doc count unchanged (minus approved junk purges), `memory_recall`/`list`/
   `overview` healthy, category listing sane.

## Phase 3 — commit + closeout

- Commit Phase 1 and Phase 2 as separate commits.
- Update this doc's Status to DONE; update `Agents.md` and
  `nDB/documentation/architecture.md` path references.
- Store outcome in workshop memory; delete `scripts/_verify.mjs`,
  `%TEMP%\ndb-folder-test`, and `data/_backup/` after verification.
