# VDB — Vector Database agent (nVDB v2 over `nvdb serve`)

Reference documentation for semantic indexing and search. Last verified
2026-11-22 against `src/agents/vdb/` (`index.js`, `v2-client.js`,
`storage-connector.js`, `search-options.js`, `merge.js`, `v2-hash.js`,
`relevance.js`, `chunker.js`), `src/agents/memory/index.js`, root `config.json`
and `package.json` at `main` (`24ac535`).

## What it is

Retrieval runs on a standalone `nvdb serve` process, reached over localhost
HTTP at `agents.vdb.serviceUrl` (default `http://127.0.0.1:3510`).
`src/agents/vdb/v2-client.js` is a thin HTTP/1.1 client: any non-2xx response
throws `NvdbHttpError` with the server's status and structured `code` — no
retries, no silent fallbacks, and an unreachable serve names the URL in the
error.

**There is no vector engine in this repository.** No `.node` addon, no NAPI
load path, no ONNX runtime inside Node — the cross-encoder runs inside
`nvdb serve` and only its scores cross the HTTP boundary. `package.json` has no
database or inference dependency for retrieval; the `nDB/` submodule serves the
memory *document* store only.

The shared `nvdb serve` also hosts the chat app's `chat` collection.
`mcp_server` creates and uses exactly two collections:

| Collection | Filled by | Contents |
|---|---|---|
| `storage` | storage connector (this agent) | Chunk documents of text files under `agents.storage.root`. |
| `memory` | memory agent | One document per memory, `category` promoted as a native filter field. |

### Startup contract

1. `GET /health` must answer `ok`, otherwise `init` throws naming
   `agents.vdb.serviceUrl`.
2. With `agents.vdb.rerank.enabled: true`, health must report
   `reranker_loaded: true`; otherwise startup aborts loudly
   (`Start nvdb serve with --reranker-model.`). Serving without the reranker
   would be a different, unmeasured system.
3. Both collections are created idempotently with `store_excerpt: true`, a
   2560-dim cosine vector lane (`model_version: agents.vdb.modelVersion`,
   `flat_search_cutoff: 50000`), and — for `memory` — a promoted `category`
   field.
4. With `agents.vdb.autoSync` and `storageConnector` present, a storage sync
   timer runs every `scanIntervalMinutes` (5). **No sync runs at init**;
   `vdb.trigger_scan` is the manual entry point.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `vdb.search` | `query*`, `collections?` (default `['storage','memory']`), `folder?` (first path segment, storage only), `extension?` (`md`, `.md`, `MD`), `top_k?` (default 10), `include_content?`, `search?` | Ranked results across collections with `collection`, `path`, `title`, `folder`, `rrfScore`, `rerankScore`, lane scores/ranks. The reply's first line is the effective mode (`mode: layers=… profile=… rrfK=… candidateK=… …`). Rejection replaces the list with "No relevant vdb matches" plus the candidate evidence. |
| `vdb.status` | — | `GET /health` + collection list + a pending-embedding sample per collection, `syncInProgress`, `lastSync` (files, chunks, upserted, deleted, unchanged, attached/stale counts, duration). |
| `vdb.trigger_scan` | — | Runs one storage sync now: enumerate → BLAKE3 envelope diff → upsert/delete → commit → drain pending embeddings. Returns the sync stats; refuses (returns `skipped`) when a sync is already running. |
| `vdb.build_index` | — | Commits every collection. v2 needs no HNSW build — the serve scans flat SIMD below `flat_search_cutoff` and uses its own index above it. |

An exported internal `searchDocuments(...)` is what `storage.search` uses;
`describeSearchRequest` / `describeRejection` build the reply's mode line and
rejection text.

## Storage sync pipeline (`storage-connector.js`)

1. **Enumerate** the storage root with `fs.promises.readdir`. No blocking I/O
   storm: every 50 ms of work yields with `setImmediate`.
2. **Filter**: extension must be in `agents.vdb.textExtensions`; names in
   `agents.vdb.ignore` and per-directory `.nvdb_ignore` patterns (name, `*`,
   simple `*`/`?` globs) are skipped, as are dot-files; files above
   `maxFileSizeBytes` (10 MB) are skipped.
3. **Chunk** with `chunker.js` — structure-aware: heading-led blocks first,
   then blank-line paragraphs, and only a block larger than the cap falls back
   to a hard char window (newline/space break preferred). Sizes:
   `chunkMaxTokens` (1024) × `chunkTokCharsRatio` (2.5) ≈ 2560 chars per chunk,
   `chunkOverlapTokens` (128) × 2.5 ≈ 320 chars overlap on hard splits. Every
   chunk carries exact `charOffset` / `charLen`.
4. **Build documents** (`id`, `parent_id`, `chunk_index`, `kind`, `title`,
   `name`, `path`, `headings`, `categories`, `tags`, `body`, `folder`, `ext`,
   `mime`, `status`, timestamps, `acl: principals`, `metadata {charOffset,
   charLen, splitIdx, isLastChunk}`, 1 KB `excerpt`). `id` is
   `<relPath>#<chunkIndex>`, `parent_id` is the relative path, `title` comes
   from YAML frontmatter `title`, else the first H1, else the filename.
5. **Diff by envelope hash**: `v2-hash.js` is a dependency-free BLAKE3 +
   canonical-JSON implementation that mirrors the Rust
   `compute_content_hash` / `compute_envelope_hash` (golden-tested by
   `tests/v2-hash.test.mjs`). Documents whose `envelope_hash` matches the
   server's `GET /v2/collections/:name/fingerprints` entry are skipped.
6. **Write without vectors**: changed documents are upserted in 200-document
   batches with `commit: false`; ids that vanished from disk are deleted the
   same way; one `commit` at the end. The index is at once lexically complete
   and vector-pending.
7. **Drain pending embeddings**: `GET
   /v2/collections/storage/pending_embeddings` (pages of ≤128, up to 500 per
   pass) → re-read the source file and rebuild the chunk → verify its
   `content_hash` still matches (stale/missing sources are skipped, not
   embedded) → `gateway.embedBatch` (batches of `maxBatchTexts`, 8) →
   `POST /v2/collections/storage/attach_vectors` with a compare-and-set on
   `content_hash`, so a file that changed mid-drain cannot get a foreign
   vector.

`lastSync` reports `{ files, chunks, upserted, deleted, unchanged, attached,
staleSkipped, missingSkipped, durationMs }`.

## Search path

1. **Query embedding** (dense lane on): `formatQueryForEmbedding` prepends
   `agents.vdb.queryInstruct` (`Given a web search query, …`), then
   `gateway.embed(..., { path: agents.vdb.embeddingPath })` → Gateway
   `POST /v1/embeddings` serving `qwen3-embedding-4b` (2560-dim, hosted on
   Fatten / nBed).
2. **Per collection, concurrently** (`Promise.all`):
   `POST /v2/collections/:name/hybrid_search` with the lexical text,
   `candidate_k` 200, `rrf_k` 20, `fuzzy_edits` 1, the resolved lane weights,
   `group_by_parent { max_per_parent: 2 }` when diversity is on, and native
   columnar `filters { folder, ext }` for `storage`.
3. **Level-2 rerank** per collection when rerank is on (see below).
4. **Merge** across collections (`merge.js`, see below).
5. `include_content` re-derives the exact chunk text from disk through the
   connector.
6. `assessRelevance` turns the result set into a rejection when the best
   cross-encoder score sits below the floor.

### Adaptive query-shape RRF (`search-options.js`)

`agents.vdb.hybrid` supplies the defaults — `rrfK: 20`, `candidateK: 200`,
`maxPerDocument: 2`, `diversityField: parent_id` — and `adaptive: true` lets
the query shape pick the lane weights for that request:

| Profile | When | `lexicalWeight` | `vectorWeight` | `rerankWeight` |
|---|---|---|---|---|
| `exact-id` | one token that is a hash, filename/path, or code symbol | 1.0 | 0.2 | 0.2 |
| `exact-short` | ≤2 tokens with a hash or file/path token | 1.0 | 0.3 | 0.2 |
| `mixed-exact` | prose containing an exact token or a quoted phrase | 0.5 | 1.0 | 0.6 |
| `single-term` | one plain token | 0.8 | 1.0 | 0.6 |
| `semantic` | everything else (prose, questions, typos, cross-lingual) | 0.3 | 1.0 | 0.6 |

Pure identifiers let the lexical lane lead; prose keeps both lanes strong.
`rrfK` stays 20 in every profile.

**Precedence**: classification only runs while both lanes are on and the query
is non-empty. An explicit per-request `search` override always wins — passing
`vectorWeight`, `lexicalWeight`, `rrfK` or `rerankWeight` marks the run
`profile: explicit`, and `adaptive: false` keeps the config weights
(`profile: static`).

### Level-2 reranking

`POST /v2/collections/:name/level2` runs the ONNX cross-encoder inside
`nvdb serve` over the fused shortlist and returns its score per hit.

- `shortlist`: when the caller passes `search.shortlist` that exact value is
  used; otherwise the effective shortlist is `max(top_k, agents.vdb.rerank
  .shortlist)` — with `top_k` 10 and `shortlist` 12, twelve candidates.
- `rerank_weight`: the adaptive profile weight (0.2 for `exact-id` /
  `exact-short`, 0.6 otherwise); config default `0.6`.
- `relevance_floor`: `agents.vdb.relevanceFloor` (0.05) is sent with every
  request.

The displayed percentage is the **cross-encoder score**, never a rank position.
Rows past the rerank shortlist carry no measured relevance and report none.

### Filters (`folder`, `extension`)

Both are now **native** `hybrid_search` filters for the `storage` collection
(the documents carry `folder` and `ext` fields), not a client-side pass over an
over-fetched set:

- `extension` is trimmed, one leading dot removed, must be alphanumeric, and is
  lowercased — `md`, `.md`, `MD` are the same request; junk (`md.`, `..md`,
  empty) throws.
- `folder` is trimmed of leading/trailing slashes and must not be empty; it
  matches the document's first path segment.
- `memory` documents have no `folder`/`ext`, so those filters apply to the
  `storage` collection only.

### Relevance and rejection

`src/agents/vdb/relevance.js` owns the confidence gate:

- Floor from `agents.vdb.relevanceFloor` (effective 0.05; the code default is
  0.02 when the key is absent). A value outside `(0, 1)` throws.
- **Set-level rejection**: when reranking ran and the best cross-encoder score
  in the set is below the floor, the answer is an explicit "no relevant
  matches" with the candidates listed as low-relevance evidence — not a ranked
  list. Applies to `vdb.search`, `storage.search` and `memory.recall`.
- **No rejection without a reranker**: dense-only and lexical-only runs have no
  calibrated signal, so they report no confidence instead of guessing one.
- **No per-row suppression**: weak single-token queries overlap legitimate
  paraphrases, so rows below the floor stay visible with their true near-zero
  percentage.

## Multi-collection merge (`merge.js`)

`searchDocuments` embeds the query once and queries every requested collection
concurrently. The merge decides only **how collections interleave**:

- **A collection's own order is authoritative.** Rows arrive in
  `nvdb serve`'s blended order; 1-based `rank` is `index + 1` inside that list.
  Re-sorting one collection's rows by raw score promoted a lower-ranked doc
  above its own collection's winner (caught on
  `documentation/Workshop/Agents_Prime.md`, 2026-11-22).
- **Rank prior with collection strength**:
  `mergeScore = 1/(5 + rank) × (0.35 + 0.65 × strength)`, where `strength` is
  the collection's best rerank score clamped to `0…1`. A strong collection
  takes several top slots before a weak one contributes; ties fall back to
  strength, then rank, then `rerankScore`. Without a reranker
  (`rerankActive: false`) `mergeScore = 1/(5 + rank)` and ties use `rrfScore`.
- **Rejected collections are dropped** when any other collection has accepted
  hits, so rejected junk never appears next to real matches. When *every*
  collection was rejected the rows are preserved so the rejection has
  evidence. A single collection (or a single survivor) returns its rows
  verbatim, cut at `top_k`.

Coverage: `tests/vdb-merge.test.mjs` (run by `npm run test:v2`);
`node scripts/eval-realworld-e2e.mjs` exercises the multi-collection path
end-to-end.

## Per-request layer selection (A/B)

`vdb.search` and `storage.search` (and the `memory.recall` handler) accept
`search` — an override object applied to that one request; config stays the
default. The effective mode is the first line of the reply, so an A/B run is
attributable from the transcript.

```json
{ "rerank": false }
{ "dense": true, "lexical": false }
{ "adaptive": false }
{ "rrfK": 30, "candidateK": 400, "rerankWeight": 0.5 }
```

| Key | Type | Layer / knob |
|---|---|---|
| `dense` | bool | vector lane |
| `lexical` | bool | BM25F lane over the index's lexical fields |
| `diversity` | bool | per-parent cap inside the native call (`group_by_parent`) |
| `rerank` | bool | Level-2 ONNX cross-encoder over the fused shortlist |
| `adaptive` | bool | query-shape weight selection |
| `rrfK`, `candidateK`, `vectorWeight`, `lexicalWeight`, `maxPerDocument`, `shortlist`, `rerankWeight` | numbers | the knobs those layers use |

Semantics worth knowing:

- **`dense: false` never calls the embedder.** The native call is told
  `dense: false`; lexical-only therefore keeps working while the embedding
  service is down.
- **Strict, never silent.** Unknown keys, wrong types, out-of-range numbers,
  `dense: false + lexical: false`, a zero weight on an enabled lane, a
  `diversity` request on a collection without a group field, or `rerank: true`
  with no reranker loaded all throw with the reason. A request never quietly
  runs the default search.
- Layer selection requires `agents.vdb.hybrid.enabled`.

## Config (`agents.vdb`, effective)

```json
{
  "enabled": true,
  "serviceUrl": "http://127.0.0.1:3510",
  "principals": ["default"],
  "modelVersion": "qwen3-embedding-4b",
  "embeddingPath": "/v1/embeddings",
  "queryInstruct": "Given a web search query, retrieve relevant passages that answer the query",
  "fuzzyEdits": 1,
  "relevanceFloor": 0.05,
  "autoSync": true,
  "scanIntervalMinutes": 5,
  "embeddingDim": 2560,
  "chunkMaxTokens": 1024,
  "chunkOverlapTokens": 128,
  "chunkTokCharsRatio": 2.5,
  "maxFileSizeBytes": 10485760,
  "maxBatchTexts": 8,
  "ignore": ["forge", "temp", "_trash", ".backups", "charts", "prints", "item.json", "meta.json"],
  "hybrid": { "enabled": true, "adaptive": true, "rrfK": 20, "candidateK": 200,
              "lexicalWeight": 0.3, "vectorWeight": 1.0,
              "diversityField": "parent_id", "maxPerDocument": 2 },
  "rerank": { "enabled": true, "shortlist": 12, "weight": 0.6 }
}
```

The collection storage location belongs to the serve (`nvdb serve --dir …`),
not to this repo. `data/nvdb/` and `data/candidates/` are leftovers from the v1
and snapshot-index eras; nothing in the running agent reads them.

## Verification

| Command | Covers |
|---|---|
| `npm run test:v2` | `tests/v2-hash.test.mjs` (BLAKE3/envelope golden vectors), `tests/search-options.test.mjs` (layer resolution, adaptive profiles, strict errors), `tests/vdb-merge.test.mjs` (rank-preserving merge, rejected-collection drop), `tests/nvdb-v2-e2e.test.mjs` (full local `nvdb.exe serve --reranker-model` E2E). |
| `node scripts/eval-hybrid-fusion.mjs` | Live golden-query fusion benchmark against the running serve. |
| `node scripts/eval-realworld-e2e.mjs` | Multi-collection end-to-end quality run. |
| `node scripts/eval-reranker-ablation.mjs` | Rerank lane ablation against the running serve. |
| `node scripts/eval-reranker-sweep.mjs` | Rerank weight/profile sweep against the running serve. |

## Consumers

- `storage.search` — semantic file content search (`storage` collection).
- memory agent — `dependsOn: "vdb"`, receives the HTTP client and the effective
  `embeddingPath`, `queryInstruct`, `fuzzyEdits`, `relevanceFloor`,
  `rerankerLoaded`, `hybrid` and `rerank` settings, and searches the `memory`
  collection directly.
