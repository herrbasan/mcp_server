# VDB Agent — Design Spec & Improvement Notes

**Date:** 2026-07-04 (updated after quality overhaul)  
**Scope:** `src/agents/vdb/`, nVDB integration, embedding pipeline, RAG search for storage/documentation.

---

## 1. What it does

The VDB agent provides vector-backed retrieval for files in the MCP server's watched directories:

- **Storage collection** — `D:\MCP_Storage` (and its UNC alias) plus any configured storage root.
- **Documentation collection** — `D:\DEV\LLM_Docs\Documentation` and the local `mcp_documentation/` folder.
- **Memory collection** — reserved for a future migration of the memory agent.

It embeds text chunks using the local LLM Gateway (`http://localhost:3400/v1/embeddings`, Qwen3-Embedding-4B, 2560 dims) and stores them in nVDB (`src/nVDB`), an embedded Rust vector database with Node napi bindings.

Exposed tools:

| Tool | Purpose |
|------|---------|
| `vdb_search` | Vector search across collections with optional folder/domain/extension filters. |
| `vdb_status` | Report initialization state, config, collection doc counts, last scan stats. |
| `vdb_trigger_scan` | Run the scanner immediately. |
| `vdb_build_index` | Build/rebuild the HNSW approximate index for configured collections. |

Internal API (`searchDocuments`) is used by the documentation agent for RAG-style queries and by the storage agent for `storage_search`.

---

## 2. Current design

### 2.1 Chunking

- Max chunk size: **1024 tokens** (configurable).
- Overlap: **128 tokens**.
- Ratio: ~2.5 chars per token.
- Only text files with configured extensions are indexed.
- Files larger than `maxFileSizeBytes` (default 10 MB) are skipped.
- **Garbage filter** (`isGarbageChunk` / `isGarbageFile` in `chunker.js`): rejects chunks/files that are filler (single char >50%), hex dumps (>30% hex runs), binary (>15% non-printable), or too short (<32 chars). Applied at both file level (whole-file skip) and per-chunk level (individual bad chunks dropped from mixed files).

### 2.2 Embedding pipeline

- Direct HTTP `POST` to `gateway.httpUrl/v1/embeddings`.
- Batch caps: **29k tokens** AND **max 32 texts** per batch.
- Batches are submitted sequentially with a **100 ms delay** between them to avoid flooding the local endpoint.
- Single retry only for network-level errors (timeout, ECONNRESET, fetch failed).
- Defensive split-on-fallback if a batch still fails.
- Generous 5-minute timeout per embedding request (deadlock guard, not a performance target).

### 2.3 Scanning

- Runs every **5 minutes** (`scanIntervalMinutes`).
- Processes files in groups of **100** (`filesPerGroup`) to bound memory.
- Skips files whose mtime and **actual file size** (`stat.size`) match the saved scan index.
- Deletes old chunk entries before re-indexing an updated file.
- **Content-hash dedup**: scan index carries a `hashToDoc` map. Files with identical content to an already-indexed file are recorded as aliases (`duplicateOf` field, `chunks: 0`) — no vectors stored. Dedup works both cross-scan (via `hashToDoc`) and within-scan (via `scanHashes` Map).
- **Garbage rejection**: files/chunks rejected by the garbage filter are skipped. If the file was previously indexed, old vectors are deleted. If it has no scan-index entry, `deleteOrphanChunks` sweeps the DB for legacy vectors.
- **Compacts** the collection after each scan to merge segments and physically remove deleted docs. **Does NOT flush before compacting** — flush destroys memtable tombstones before compaction can apply them.
- Per-scan **30-minute timeout**; if a scan hangs longer than that, the lock is released and the next interval can start fresh.

### 2.4 Search

- Exact cosine similarity search by default.
- Optional HNSW approximate search via `approximate: true` (requires `vdb_build_index`).
- Supports filters on `folder` (storage), `domain` (documentation), and `extension`.
- **Per-collection top-K with min-max normalization**: each collection is searched separately (over-fetched at `top_k * 3`), scores normalized to [0,1] within the collection, then merged by normalized score. This makes cross-collection results comparable — a documentation match at 0.55 (near collection max) can compete with a storage match at 0.95.
- **Per-file diversity cap**: max 3 chunks per source file in results (`MAX_CHUNKS_PER_FILE`), preventing one long document from dominating.
- **Content-hash dedup at search time**: results with the same `contentHash + splitIdx` are deduplicated, hiding duplicate vectors from legacy indexing.
- Results are **deduplicated by chunk ID** at the application layer.
- Optional `include_content` slices the source file by `charOffset + tokEst` (O(1)), with legacy fallback to re-chunking.

---

## 3. Bugs fixed (2026-07-04 quality overhaul)

Six bugs were found and fixed in a single session:

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| 1 | No garbage filter | Filler files (`aaaa...`), hex dumps, binary content indexed | `isGarbageChunk` / `isGarbageFile` in `chunker.js`; file-level + per-chunk filtering |
| 2 | No content-hash dedup | 4 copies of same 122KB file indexed separately | `hashToDoc` map in scan index + `scanHashes` within-scan tracking |
| 3 | Raw cross-collection score sorting | Documentation answers (0.55) drowned by storage matches (0.97) | Per-collection min-max normalization + per-file diversity cap (max 3) |
| 4 | `coll.stats?.()` called as function | Compaction silently failed every scan | Changed to `coll.stats \|\| {}` (stats is a getter) |
| 5 | `flush()` before `compact()` | Tombstones destroyed before compaction could apply them | Removed flush; compact reads tombstones from memtable directly |
| 6 | Size mismatch (chunk sum vs `stat.size`) | 516/551 files re-embedded on every scan | Store `stat.size` (actual file size) in scan index |

## 4. Known limitations / remaining work

### 4.1 nVDB delete semantics

**Problem:** nVDB's `exact_search` scans segments without applying memtable delete markers. Re-indexed files can appear as duplicate results until compaction runs.  
**Current mitigation:** Deduplicate at the application layer + compact after every scan (now working correctly).  
**Better fix:** Patch nVDB `exact_search` to check the memtable's deleted-id set when scanning segments.

### 4.2 Backfill throughput vs. endpoint politeness

**Problem:** With >100k files the initial backfill is slow. The pipeline is intentionally sequential and polite.  
**Current mitigation:** 100-file groups, 100 ms inter-batch delay, 32-text/29k-token caps.  

### 4.3 Approximate index not built automatically

**Problem:** `vdb_build_index` must be called manually. At 1.5k+ docs, exact search still works but is O(N).  
**Potential improvement:** Build the HNSW index automatically after a successful scan when doc count exceeds a threshold.

### 4.4 Memory collection not implemented

**Problem:** `memory` is defined as a collection but not populated.  
**Planned work:** Migrate memory storage from JSON file to nVDB vectors.

### 4.5 UNC path handling

**Current state:** VDB payload stores the local `absolutePath`. Storage and forge agents translate UNC ↔ local. This is consistent but should be documented for LAN clients.

### 4.6 Error reporting

**Problem:** `scanCollection` counts a whole group as failed if embedding fails.  
**Potential improvement:** Mark individual files as failed and continue with the rest of the group.

---

## 5. Operational notes

- Restart the server after changing `config.json` VDB settings.
- `data/nvdb` holds the vector database; `data/nvdb/scan-index.json` tracks indexed file metadata (including `hashToDoc` dedup map).
- Wipe both to force a full re-index.
- Scans should be fast for unchanged files (mtime + size skip). First scan after code changes may re-embed files whose scan-index entries have stale sizes.
- `scripts/cleanup-vdb-garbage.js` — one-shot cleanup script for removing orphaned vectors. Server must be stopped.

---

## 6. Files involved

- `src/agents/vdb/index.js` — main agent logic (scanning, indexing, search, compaction).
- `src/agents/vdb/chunker.js` — text chunking + garbage detection (`isGarbageChunk`, `isGarbageFile`).
- `src/agents/vdb/nvdb-loader.js` — native module loader.
- `src/agents/vdb/config.json` — tool schemas.
- `config.json` — runtime config under `agents.vdb`.
- `src/server.js` — compact endpoint tool registration.
- `src/agents/documentation/index.js` — RAG consumer.
- `src/agents/storage/index.js` + `config.json` — `storage_search` consumer.
- `scripts/cleanup-vdb-garbage.js` — one-shot orphan vector cleanup (server must be stopped).
- `src/nVDB/src/` — Rust vector database (compaction, search, memtable, segments).
