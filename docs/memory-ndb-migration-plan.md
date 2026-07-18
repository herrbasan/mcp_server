# Memory System Migration Plan: JSON → nDB + nVDB

> **Status**: ✅ COMPLETED — 2026-07-18
> **Date**: 2026-07-18
> **Goal**: Migrate the memory store from a single 37MB `memories.json` file to nDB (document store) + nVDB (vector index), mirroring the proven architecture used by the LLM Gateway Chat app.

---

## 1. Problem Statement

The current memory system stores everything — metadata + 2560-dim embedding vectors — inline in a single JSON file (`data/memories.json`, 37MB, 475 memories). This causes:

- **Full-file rewrite on every mutation.** `saveMemories()` serializes and writes all 37MB for every `memory_store`, `memory_update`, `memory_forget`. This is O(N) I/O that grows linearly.
- **JS-side cosine similarity.** `memory_recall` loops over all 475 embeddings computing cosine similarity in JavaScript. nVDB does this natively in Rust with HNSW approximation.
- **No indexed queries.** `memory_list(category)` and `memory_embed_heal` do linear `.filter()` / `.find()` scans over the full array.
- **Destructive deletes.** `memory_forget` splices the array — no recovery path.
- **Heap pressure.** The entire 37MB is loaded into the V8 heap at startup and stays there.

The embedding vectors account for ~90% of the file size (475 × 2560 floats × ~20 chars/float ≈ 24MB). The metadata alone is ~3-4MB.

---

## 2. Target Architecture

Two databases, each doing what it's best at:

```
data/memories/                    ← new nDB database (folder format)
├── meta.json                     ← schema, indexes
├── data.jsonl                    ← append-only document store
├── _trash/                       ← soft-deleted memories (recoverable)
└── _files/                       ← (unused, but part of nDB folder format)

data/nvdb/                        ← existing nVDB database (already exists)
└── (memory collection already reserved in COLLECTIONS.memory)
```

### Document schema (nDB)

Each memory is one nDB document:

```json
{
  "_id": "mem_782",
  "id": 782,
  "description": "ROOT CAUSE of 'MCP stream ended without response'...",
  "category": "bug fix",
  "confidence": 0.95,
  "data": null,
  "timestamp": "2026-07-18T06:55:23.000Z",
  "embedStatus": "embedded",
  "embedError": null
}
```

- `_id`: nDB's internal ID, prefixed `mem_` for namespace clarity.
- `id`: the integer memory ID (preserved for backward compatibility — all existing references use `#782`).
- `embedStatus`: `"embedded"` | `"pending"` (replaces the null-embedding check).
- `embedError`: error message if embedding failed (replaces the `embedError` field on the memory object).
- **No `embedding` field** — vectors live only in nVDB.

### Vector record (nVDB)

The `memory` collection (already reserved in `src/agents/vdb/index.js` line 38) stores:

- **key**: `"mem_782"` (matches the nDB `_id`)
- **vector**: the 2560-dim embedding
- **payload**: `{"id": 782}` (minimal — just enough to join back to nDB)

### Indexes (nDB)

Created at init time:

- `createIndex('category')` — accelerates `memory_list(category)`.
- `createBTreeIndex('id')` — accelerates `memory_get(id)` if the HashMap `_id` lookup isn't sufficient (it should be, but the BTree gives us range scans for free).
- `createIndex('embedStatus')` — accelerates `memory_embed_heal` (find all `"pending"`).

---

## 3. Search Flow (memory_recall)

```
1. embed(query) via gateway.embed()           → queryVector [2560 floats]
2. nVDB: coll.search({vector: queryVector, topK: limit * 3})
                                               → [{id: "mem_782", score: 0.87}, ...]
3. nDB: for each hit, db.get(hit.id)           → full memory document
4. Apply confidence weighting: score * (0.7 + conf * 0.3)
5. Sort by weighted score, dedup, slice to limit
6. Format and return
```

This replaces the current JS cosine loop with native Rust HNSW search. The nDB join is O(1) HashMap lookup per hit.

**Fallback**: if nVDB is unavailable or embed fails, degrade to recency (same as current behavior) — `db.iter()` sorted by timestamp, sliced to limit.

---

## 4. Tool-by-Tool Changes

### 4.1 `memory_store`

**Current**: embed → push to array → `saveMemories()` (rewrites 37MB).

**After**:
1. Embed the description+data via gateway.
2. Assign next ID (see §5 ID management).
3. `db.insertWithPrefix('mem_', {id, description, category, confidence, data, timestamp, embedStatus, embedError})`.
4. If embedding succeeded: `coll.insert("mem_" + id, vector, JSON.stringify({id}))`.
5. Return success message.

No full-file rewrite. nDB appends one JSONL line. nVDB inserts one vector.

### 4.2 `memory_recall`

**Current**: embed query → JS cosine loop over all memories → sort → slice.

**After**: see §3 search flow above.

### 4.3 `memory_get`

**Current**: `.find(m => m.id === id)` — O(N) linear scan.

**After**: `db.get("mem_" + id)` — O(1) HashMap lookup. Falls back to `db.query({id: id})` if the `_id` format isn't `mem_{id}` (defensive, but shouldn't happen).

### 4.4 `memory_list`

**Current**: `.filter(m => m.category === category)` — O(N) scan.

**After**: 
- With category: `db.find('category', category)` — uses hash index, O(1) lookup.
- Without category: `db.iter()` — returns all documents.
- Format identically to current output.

### 4.5 `memory_update`

**Current**: mutate object in array → re-embed if text changed → `saveMemories()` (rewrites 37MB).

**After**:
1. `db.get("mem_" + id)` to fetch current document.
2. If description/data changed: re-embed, then `coll.insert("mem_" + id, newVector, ...)` (nVDB upserts on key collision).
3. `db.update("mem_" + id, updatedDoc)` — or use `db.set()` for delta patches on individual fields.
4. Return success.

### 4.6 `memory_forget`

**Current**: `.splice(idx, 1)` → `saveMemories()` — destructive, no recovery.

**After**:
1. `db.delete("mem_" + id)` — soft delete (tombstone). Recoverable via `db.restore()`.
2. `coll.delete("mem_" + id)` — remove vector from nVDB.
3. Return success.

### 4.7 `memory_embed_heal`

**Current**: `.filter(m => !m.embedding)` — scans full array for null embeddings.

**After**: `db.find('embedStatus', 'pending')` — uses hash index, O(1). For each, re-embed and `db.set(id, 'embedStatus', 'embedded')`.

### 4.8 `memory_overview`

**Current**: reads `dream_map.json` + checks for null embeddings.

**After**: same, but the pending-embed count comes from `db.find('embedStatus', 'pending').length`.

---

## 5. ID Management

**Current**: `memories.nextId++` — a counter stored in the JSON root object.

**After**: nDB has no built-in auto-increment. Two options:

- **Option A (recommended)**: Store a `_meta` document in nDB with `_id: "_meta"`, field `nextId`. Read it on init, increment on store. One extra HashMap lookup per store — negligible.
- **Option B**: Derive next ID from `db.iter()` max — O(N) on every store. Rejected: defeats the purpose.

We use Option A. The migration script seeds `_meta.nextId` from the current `memories.nextId` value (782).

---

## 6. Dreaming Agent Compatibility

The dreaming agent (`src/agents/dreaming/index.js`) accesses memories via:

```javascript
const allMemories = memoryAgent?.memories?.memories;
```

This is a direct reference to the in-memory array. After migration, the memory agent's `init()` will expose:

```javascript
return {
  memories: {
    get memories() { return db.iter(); }  // getter — fresh array on each access
  }
};
```

Or more explicitly, a method:

```javascript
return {
  memories: {
    iter: () => db.iter(),      // for dreaming agent
    get: (id) => db.get(id),    // for targeted lookups
    count: () => db.len()
  }
};
```

The dreaming agent would be updated to call `memoryAgent.memories.iter()` instead of `memoryAgent.memories.memories`. This is a **one-line change** in `src/agents/dreaming/index.js` line 481:

```javascript
// Before:
const allMemories = memoryAgent?.memories?.memories;
// After:
const allMemories = memoryAgent?.memories?.iter?.() || memoryAgent?.memories?.memories;
```

The fallback keeps backward compatibility if the memory agent hasn't been migrated yet.

**Key concern**: `db.iter()` returns a fresh array of document objects. The documents no longer have an `embedding` field, but the dreaming agent never reads embeddings — it only reads `id`, `description`, `category`, `confidence`, `data`, `timestamp`. All present.

---

## 7. New File: `src/agents/memory/ndb-loader.js`

Mirrors `src/agents/vdb/nvdb-loader.js`. Loads the nDB native binary from the submodule.

```
src/agents/memory/
├── config.json      ← updated (storePath → dbPath)
├── index.js         ← rewritten (nDB + nVDB instead of JSON)
└── ndb-loader.js    ← new (binary loader)
```

The loader:
1. Finds the nDB native binary (`nDB/napi/ndb-node.win32-x64-msvc.node` or platform equivalent).
2. Loads the `Database` class from `nDB/napi/index.js`.
3. Caches the module.

---

## 8. Config Changes

### `config.json`

```json
"agents": {
  "memory": {
    "dbPath": "data/memories",
    "nvdbCollection": "memory",
    "embeddingDim": 2560,
    "maxMemoryChars": 6000
  }
}
```

- `dbPath`: nDB database folder (relative to project root).
- `nvdbCollection`: name of the nVDB collection to use (must match `COLLECTIONS` in vdb agent).
- `embeddingDim`: must match the VDB agent's `embeddingDim` and the gateway's embedding model.
- `storePath` (`data/memories.json`): **removed** — the JSON file stays on disk as a cold backup but is no longer read or written.

### `src/agents/memory/config.json`

No schema changes to tool definitions. The `inputSchema` for each tool stays identical — this is a pure storage-layer migration, invisible to callers.

---

## 9. Migration Script

One-time script: `scripts/migrate-memories-to-ndb.js`

**Read-only on the source** — does not modify `memories.json`. Creates the nDB database and populates nVDB.

### Steps:

1. Read `data/memories.json` (the 37MB file).
2. Open nDB at `data/memories/` (creates the folder structure).
3. Create indexes: `category`, `embedStatus`, BTree on `id`.
4. Insert `_meta` document: `{_id: "_meta", nextId: memories.nextId}`.
5. For each memory in `memories.memories`:
   a. Build the nDB document (strip the `embedding` field, add `embedStatus`).
   b. `db.insertWithPrefix('mem_', doc)`.
   c. If the memory has a valid embedding: `coll.insert("mem_" + id, embedding, JSON.stringify({id}))`.
   d. If not: set `embedStatus: "pending"`.
6. Flush both databases.
7. Print verification stats: document count, vector count, pending count.

### Verification:

After migration, the script prints:
```
Migration complete:
  nDB documents: 475
  nVDB vectors:  470 (5 pending — no embedding)
  nextId:        782
  Categories:    bug fix:45, infrastructure:120, ...
```

The operator then manually verifies:
- `memory_recall("test query")` returns results.
- `memory_get(781)` returns the last memory.
- `memory_list("bug fix")` returns the right category.

**Only after verification** does the operator restart the server with the new memory agent code.

---

## 10. Rollback Plan

If anything goes wrong:

1. The original `memories.json` is untouched (migration script is read-only on source).
2. The external backup exists at `D:\DEV\mcp_server_backups\memories_2026-07-18_06-59-40\`.
3. Revert the memory agent code (`git checkout`).
4. Delete `data/memories/` (the nDB database folder).
5. Restart the server.

The nVDB `memory` collection can be left in place — it's harmless if unused.

---

## 11. Implementation Order

| Step | What | Risk | Reversible? |
|------|------|------|-------------|
| 1 | Write `ndb-loader.js` | None | Yes — new file, not wired |
| 2 | Write migration script | None — read-only on source | Yes — delete output |
| 3 | Run migration script | None — creates new DB, doesn't touch old | Yes — delete `data/memories/` |
| 4 | Verify migrated data | None — read-only checks | N/A |
| 5 | Rewrite `memory/index.js` | **Medium** — core agent | Yes — git revert |
| 6 | Update dreaming agent (1 line) | Low — fallback compatible | Yes — git revert |
| 7 | Update `config.json` | Low | Yes — git revert |
| 8 | Restart server, smoke test | **Cutover** | Yes — rollback to step 5 |
| 9 | Update `Agents.md`, docs | None | Yes |

Steps 1-4 are completely safe — they create new files without touching anything live. The cutover happens at step 8. If it fails, steps 5-7 are reverted and the server restarts with the old code reading the old JSON.

---

## 12. What Does NOT Change

- **Tool schemas** — all `inputSchema` definitions stay identical. Callers see no difference.
- **Tool names** — `memory_store`, `memory_recall`, etc. all keep their names.
- **MCP routing** — `COMPACT_TO_LEGACY` mappings unchanged.
- **Dreaming prompts** — the distiller and dreamer prompts read memory text, not storage details.
- **The `memory` collection in nVDB** — already reserved in `COLLECTIONS` (vdb/index.js line 38). The VDB agent's scanner won't touch it (it's not in `CONFIG.watch`).
- **Embedding model** — still Qwen3-Embedding-4B via the gateway. No change to the embed pipeline.
- **`memories.json`** — stays on disk as a cold backup. Not deleted.

---

## 13. Open Questions

1. **nVDB collection sharing**: The VDB agent owns the nVDB `Database` instance. The memory agent needs access to the `memory` collection. Options:
   - **A**: Memory agent opens its own nVDB `Database` instance pointing at the same `data/nvdb/` path. nVDB may not support two concurrent `Database` instances on the same path.
   - **B**: Memory agent gets a reference to the VDB agent's `Database` instance via `context.agents.get('vdb')` and calls `getCollection('memory')`. This is the clean approach — the VDB agent already manages the nVDB lifecycle.
   - **C**: Memory agent owns its own separate nVDB database at `data/memories/nvdb/`. Fully isolated, no sharing. Simplest but means two nVDB instances.
   - **Recommendation**: Option B. The VDB agent already has the infrastructure. Add a method like `vdbAgent.getCollection('memory')` or expose the `DATABASE` instance.

2. **Embedding dimension source**: Should the memory agent hardcode 2560, read it from config, or query the VDB agent? Recommendation: read from `config.agents.memory.embeddingDim`, defaulting to the VDB agent's `embeddingDim`.

3. **Compaction**: nDB's JSONL grows with every update. Should we compact periodically (e.g., on shutdown, or when file size exceeds a threshold)? The chat app compacts on a timer. Recommendation: compact on shutdown and add a `memory_compact` admin tool.
