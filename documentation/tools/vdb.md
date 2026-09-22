# VDB — Vector Database agent (nVDB)

Reference documentation for semantic indexing and search. Last verified
2026-09-22 against `src/agents/vdb/index.js`, `chunker.js`,
`context-enhancer.js`, `nvdb-loader.js`, and root `config.json`.

## What it is

Embedded vector search over storage files and memories, backed by the nVDB
native module (Rust, submodule `nVDB/`). Watches the storage root, chunks
text files, enriches them with LLM-generated metadata, embeds them through
the gateway, and serves cosine similarity search. Also owns the `memory`
collection the memory agent writes into.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `vdb.search` | `query*`, `collections?` [`storage`,`memory`], `folder?` (top-level storage folder), `extension?` (e.g. `.md`), `top_k?` (default 10), `approximate?`, `include_content?` | Ranked results: path, score, normalizedScore, folder, contentHash, chunk coordinates; `include_content` slices the exact chunk text from disk. **Filename-like queries bypass embeddings** (query contains `\` or matches `^\S+\.[a-z0-9]{1,8}$`) → substring match over indexed paths, exact names first, cap 20. |
| `vdb.status` | — | JSON: availability, full effective config, per-collection stats (docs, segments, hasIndex, watched), lastScanAt, isScanning, lastScanStats. |
| `vdb.trigger_scan` | — | Synchronous re-scan with progress. Returns added/updated/removed/skipped/errors (pending if interrupted). |
| `vdb.build_index` | `collections?` | Flush + rebuild HNSW approximate index per collection. |

An exported internal `searchDocuments(...)` (not advertised as a tool) is what
`storage.search` and other agents call.

## Collections

| Collection | Filled by | Contents |
|---|---|---|
| `storage` | vdb scan cycle | Chunk embeddings of text files under `agents.storage.root` (default: whole `D:\MCP_Storage`). |
| `memory` | memory agent | One vector per memory. Pre-opened here, never scanned by this agent. |
| `__enhancement_cache` | vdb internally | Zero-vector doc cache of LLM context-enhancement results, keyed by content hash. |

## Indexing pipeline (scan cycle)

1. **Schedule**: `setInterval` every `scanIntervalMinutes` (**5**); initial scan
   2 s after init; a scan-timeout guard (30 min) force-releases hung scans.
2. **Enumerate** watched files: walk the storage root. Config
   `watch.storage.enabled: true`. Per-directory `.nvdb_ignore` files (patterns:
   name, `*`, simple `*`/`?` globs) merge with config-level
   `ignore: ["forge","temp","_trash",".backups"]`. Only `textExtensions`
   (.md .txt .json .js .mjs .css .html .htm .log .yaml .yml .xml .csv .tsv
   .sql); files > 10 MB (`maxFileSizeBytes`) skipped.
3. **Change detection**: SHA-256 per file, every scan — mtime deliberately
   ignored (sync tools defeat it). Unchanged → skip.
4. **Dedup**: identical content stored once; later copies become aliases
   (`duplicateOf`), never embedded.
5. **Chunk** (structure-aware): heading-led blocks first, then blank-line
   paragraphs, then hard char windows with newline/space break preference.
   maxChars = `chunkMaxTokens (1024) × chunkTokCharsRatio (2.5)` = 2560;
   overlap = `chunkOverlapTokens (128) × 2.5` = 320 chars.
6. **Context enhancement** (enabled): per file, gateway `predict` with task
   `local` (temperature 0.3, maxOutputTokens 1536, 30 s timeout) produces
   `{summary, keywords, entities, docType}`, cached by content hash. The
   header `[Type: … | Keywords: … | Summary: …]` is prepended to chunk text
   **for embedding only**. Input truncation `headmidtail` at 60 000 chars.
   Failures are best-effort (metadata flags `contextEnhanced: false`).
7. **Embed in batches**: via `gateway.embedBatchBackground` (background tier).
   Batches capped by `batchTokenLimit` 29 000 est. tokens (len/2.5) and
   `maxBatchTexts: 4` (config override; code default 32), 100 ms delay between
   batches, 100 files per group. Degenerate-vector guards (non-finite /
   zero-norm² / duplicate first-8-dims within batch) reject. Network-class
   errors abort the scan (retry next cycle); others retry once with a
   recursive half-split fallback.
8. **Persist**: `coll.insert(docId, vector, payload)`. docId
   `<collection>:<relPath>` (+`#i` per chunk). Scan index at
   `data/nvdb/scan-index.json` records path, contentHash, mtime, size, chunk
   count, indexedAt, metadata per file.
9. **Compaction** after each collection: deleted files pruned, then
   `coll.compact()` (deliberately without flush — tombstones must stay in the
   memtable).
10. **Main-thread yielding**: `setImmediate` every 50 ms of synchronous work —
    scans never block the server's tool loop.

## Search mechanics

Query embedded foreground (dim validated 2560) → per-collection cosine search
with over-fetch `fetchK = max(top_k × 3, 30)` → **min-max score normalization
per collection** before merging (cross-collection comparability) → dedup by id
and by `contentHash#splitIdx`, per-file cap 3 chunks → sort by
normalizedScore → cut at `top_k`.

## Config (effective, `agents.vdb`)

`enabled: true`, `dbPath: 'data/nvdb'`, `scanIntervalMinutes: 5`,
`scanTimeoutMinutes: 30`, `embeddingDim: 2560`, `chunkMaxTokens: 1024`,
`chunkOverlapTokens: 128`, `chunkTokCharsRatio: 2.5`,
`maxFileSizeBytes: 10 MB`, `batchTokenLimit: 29000`, `maxBatchTexts: 4`,
`filesPerGroup: 100`, `maxRetries: 1`, `batchDelayMs: 100`,
`ignore: ["forge","temp","_trash",".backups"]`,
`contextEnhancement: { enabled, task: 'local', maxInputChars: 60000,
maxOutputTokens: 1536, temperature: 0.3, truncation: 'headmidtail' }`,
`watch.storage.enabled: true`.

## Binary loading

`nvdb-loader.js` searches `nVDB/target/release/`, then `nVDB/napi/`, then a
dev fallback path; platform map win32/darwin/linux × x64/arm64; stages the
binary into `nVDB/napi/` (including the legacy `index.<platform>.node` name).

## Consumers

- `storage.search` — semantic file content search (`storage` collection).
- memory agent — `dependsOn: "vdb"`, uses `getCollection('memory')` +
  `embeddingDim` for its recall leg.
