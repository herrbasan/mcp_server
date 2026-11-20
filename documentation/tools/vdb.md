# VDB — Vector Database agent (nVDB)

Reference documentation for semantic indexing and search. Last verified
2026-11-19 against `src/agents/vdb/index.js`, `chunker.js`,
`context-enhancer.js`, `nvdb-loader.js`, and root `config.json`.

## What it is

Embedded vector search over storage files and memories, backed by the nVDB
native module (Rust, submodule `nVDB/`). In its default mode it watches the
storage root, chunks text files, enriches them with LLM-generated metadata,
embeds them through the gateway, and serves cosine similarity search. It also
owns the `memory` collection the memory agent writes into.

**Production mode (2026-11-19) is a snapshot index with hybrid retrieval and a
reranker** — see *Production retrieval* below. Scanning is off there.

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
   batches, 100 files per group. The shared embed client rejects non-finite /
   zero-norm vectors and byte-identical vectors reused for different inputs,
   including across separate single/batch requests and against vectors already
   stored for active scan-index chunks; existing inputs are reconstructed lazily
   from the configured storage root on a collision. Batch responses are mapped
   by their required OpenAI `index`. The VDB adds a duplicate first-8-dims
   within-batch guard. Network-class
   errors abort the scan (retry next cycle); others retry once with a
   recursive half-split fallback. After every successful batch, each file whose
   complete chunk set has arrived is persisted immediately; a later network
   failure therefore leaves earlier files indexed. The error names the exact
   persisted count and pending file list instead of discarding the whole group.
8. **Persist**: `coll.insert(docId, vector, payload)` per completed file, not
   all-or-nothing per 100-file group. docId
   `<collection>:<relPath>` (+`#i` per chunk). Scan index at
   `data/nvdb/scan-index.json` records path, contentHash, mtime, size, chunk
   count, indexedAt, metadata per file.
9. **Compaction** after each collection: deleted files pruned, then
   `coll.compact()` (deliberately without flush — tombstones must stay in the
   memtable).
10. **Main-thread yielding**: `setImmediate` every 50 ms of synchronous work —
    scans never block the server's tool loop.

## Search mechanics

Query embedded foreground (dim validated 2560) → per-collection search with
over-fetch `fetchK = max(top_k × 3, 30)` → **min-max score normalization per
collection** before merging (cross-collection comparability) → dedup by id and
by `contentHash#splitIdx`, per-file cap 3 chunks → sort by normalizedScore →
cut at `top_k`.

## Production retrieval — snapshot index, hybrid, rerank

`agents.vdb.dbPath` points at a fixed candidate index
(`data/candidates/wizkid-hybrid-rerank/nvdb`). Three config switches make it
what it is:

| Setting | Value | Effect |
|---|---|---|
| `snapshot` | `true` | No scanner, no initial scan, no compaction, no `__enhancement_cache`, no context enhancer. The index is a fixed artifact; `vdb.trigger_scan` refuses with an explanation instead of re-embedding it. |
| `embeddingPath` | `/v1/embeddings/wizkid` | Every embed this agent issues (query, batch, background) goes to that Gateway route. The index's vectors came from it; another route is a different vector space. |
| `hybrid` | see below | Dense + BM25 lanes fused by RRF, per-document diversity. |
| `rerank` | see below | ONNX cross-encoder over the hybrid shortlist. |

```json
"hybrid": { "enabled": true, "rrfK": 10, "candidateK": 200, "vectorWeight": 1.0,
            "lexicalWeight": 1.0, "diversityField": "path", "maxPerDocument": 2 },
"rerank": { "enabled": true, "modelPath": "...\\atelasi-multilingual-reranker-small\\model.onnx",
            "tokenizerPath": "...\\tokenizer.json", "textField": "content",
            "maxLength": 64, "batchSize": 10, "shortlist": 10, "weight": 0.2 }
```

- **Reranker fails loudly at startup.** A missing `model.onnx`/`tokenizer.json`,
  or an addon built without `--features rerank-onnx` (no `Reranker` export),
  aborts `vdb.init` with the path or the feature name. Serving without the
  reranker would be a different, unmeasured system.
- **Ordering is the native call's.** `hybridSearchReranked` returns the
  reranked head first and the unscored tail after it, but the tail keeps its
  larger raw RRF score — so `searchDocuments` must NOT re-sort by raw score in
  hybrid mode. It derives `normalizedScore` from rank position instead;
  re-sorting by score promoted the tail over the head (caught by the golden
  gate, 2026-11-19).
- **Snapshot payload schema is the builder's**, not the scanner's:
  `{ path, title, content }` per chunk (memory: `{ id, description, data,
  content }`). Consequences:
  - `include_content` returns `payload.content` (the exact embedded chunk).
  - `absolutePath` is resolved from `payload.path` under `agents.storage.root`.
  - `splitIdx` comes from the `#N` id suffix.
  - `folder` / `extension` filters cannot use an nVDB payload filter (those
    fields do not exist) — they are applied client-side over the over-fetched
    result set.
- **Known upstream shape**, left as is: reranked `score` is a fusion against
  nVDB's fixed k=60, while lane fusion uses `rrfK`, and results past the
  rerank shortlist keep their lane score. Raw scores are therefore **not
  monotonic across the shortlist boundary** — never sort or threshold on them.
  `normalizedScore` and memory's recall percentage both come from rank position.

## Per-request layer selection (A/B)

`vdb.search` and `storage.search` accept `search` — an override object applied
to that one request (config stays the default). The effective mode is the first
line of the reply, so an A/B run is attributable from the transcript.

```json
{ "rerank": false }
{ "dense": true, "lexical": false }
{ "rrfK": 30, "candidateK": 400, "rerankWeight": 0.5 }
```

| Key | Type | Layer it switches |
|---|---|---|
| `dense` | bool | vector lane |
| `lexical` | bool | BM25 lane over the index's lexical fields |
| `diversity` | bool | per-document cap inside the native call |
| `rerank` | bool | ONNX cross-encoder over the fused shortlist |
| `rrfK`, `candidateK`, `vectorWeight`, `lexicalWeight`, `maxPerDocument`, `shortlist`, `rerankWeight` | numbers | the knobs those layers use |

Semantics worth knowing:

- **Both lanes always run natively.** A single-lane request fetches headroom
  (`fetchK × 4`), drops the other lane's hits, and orders by the kept lane's
  rank — or keeps the fused rerank order when reranking is on, because that
  order is the measured artifact. The query is still embedded when
  `dense: false`, so latency is not "lexical-only cheap".
- **Strict, never silent.** Unknown keys, wrong types, out-of-range numbers,
  `dense: false + lexical: false`, a zero weight on an enabled lane, or
  `rerank: true` with no reranker loaded all throw with the reason. A request
  never quietly runs the default search.
- Layer selection needs `agents.vdb.hybrid.enabled`; on the vector-only index
  (`data/nvdb`) passing `search` is an error.

Gate coverage: `npm run gate:nvdb` runs the same query through five modes
(all / no rerank / dense only / lexical only / no diversity), asserts lane
membership and rerank presence per mode, and checks that five invalid
selections are rejected.

## Config (effective, `agents.vdb`)

`enabled: true`, `dbPath: 'data/candidates/wizkid-hybrid-rerank/nvdb'`,
`indexPath: null`, `snapshot: true`, `embeddingPath: '/v1/embeddings/wizkid'`,
`scanIntervalMinutes: 5`, `scanTimeoutMinutes: 30`, `embeddingDim: 2560`,
`chunkMaxTokens: 1024`, `chunkOverlapTokens: 128`, `chunkTokCharsRatio: 2.5`,
`maxFileSizeBytes: 10 MB`, `batchTokenLimit: 29000`, `maxBatchTexts: 4`,
`filesPerGroup: 100`, `maxRetries: 1`, `batchDelayMs: 100`,
`ignore: ["forge","temp","_trash",".backups"]`,
`contextEnhancement: { enabled, task: 'local', maxInputChars: 60000,
maxOutputTokens: 1536, temperature: 0.3, truncation: 'headmidtail' }`,
`watch.storage.enabled: true` (search target only — no scan in snapshot mode).

Rollback index: `data/nvdb` (old `.node` + old config paths).

## Binary loading

`nvdb-loader.js` resolves the addon and `require`s it **directly** — it no
longer copies anything into `nVDB/napi/` (that copy silently replaced a staged
binary, and would have destroyed a rollback file at startup). Search order:

1. `NODE_NVDB_NATIVE_PATH` (explicit override; a missing file is an error)
2. `src/nVDB/target/release/nvdb-node.<platform>.node`
3. `src/nVDB/napi/nvdb-node.<platform>.node`
4. `D:\SRV\LLM-Gateway-Chat\lib\nvdb\napi\nvdb-node.<platform>.node`

It exports `Database`, `Collection`, `FilterBuilder`, `Reranker` (null when the
addon lacks the feature) and `nativePath`. `vdb.status` reports the loaded
`nativePath` — that is how you tell which binary the service actually has.

## Consumers

- `storage.search` — semantic file content search (`storage` collection).
- memory agent — `dependsOn: "vdb"`, uses `getCollection('memory')`,
  `embeddingDim`, `embeddingPath`, `reranker`, `hybrid` and `rerank` for its
  recall leg (vector-only and hybrid both supported).
