# Memory System — memory + dreaming agents

Reference documentation for the persistent memory system. Last verified
2026-11-22 against `src/agents/memory/index.js`, `src/agents/dreaming/index.js`,
both agents' `config.json`, and the vdb agent's nVDB v2 HTTP surface at `main`
(`24ac535`). Since Phase 2a of the nDB v2 cutover the memory store is reached
over HTTP from a resident `ndb serve` — there is no napi addon in the memory
path (`src/lib/ndb-client.js`). Phase 4a (nDB `seq` change feed → nVDB
watermark, pinned-snapshot auto-rebuild) landed 2026-11-22.

## What it is

Cross-session semantic memory for every platform (VS Code, chat app, CI).
Two cooperating agents:

- **memory** (`src/agents/memory/`) — the store: write/read/update/delete
  individual memories, hybrid semantic+lexical recall, and the knowledge-map
  overview. Depends on the vdb agent.
- **dreaming** (`src/agents/dreaming/`) — the consolidator: every 15 minutes,
  compresses all memories into a structured Map (clusters, bridges, node
  scores, wildcards). Exposed under the **`memory.dream_*`** method namespace —
  there is no `dream.*` namespace.

Session-start ritual: `memory.overview` (the map) → `memory.recall` for depth.
Session-end ritual: `memory.store` aggressively — over-storing is the design;
dreaming deduplicates and organizes.

## Two-database architecture

| Store | Path | Role |
|---|---|---|
| **nDB** (document store) | `memories` DB mounted by `ndb serve` (`ndb.serviceUrl`, default `http://127.0.0.1:8323`) | Memory metadata: id, description, category, confidence, timestamp, data, embedStatus. Append-only JSONL, immediate persistence, soft-delete via tombstones. The on-disk folder belongs to the serve, not this repo. |
| **nVDB** (vector index) | `memory` collection in the shared `nvdb serve` (`agents.vdb.serviceUrl`, default `http://127.0.0.1:3510`) | One vector per memory (embeds description + data). Hybrid (dense + BM25F) and Level-2 reranked. There is no addon in Node: memory receives the vdb agent's HTTP client via `dependsOn: "vdb"` plus the effective `embeddingPath`, `queryInstruct`, `fuzzyEdits`, `relevanceFloor`, `rerankerLoaded`, `hybrid` and `rerank` settings. The collection's on-disk location belongs to the serve, not this repo. |

- **Vector space**: 2560-dim `qwen3-embedding-4b`, embedded through
  `agents.vdb.embeddingPath` (`/v1/embeddings`, hosted on Fatten / nBed) for
  every call — store, update, heal, recall query. The route must serve the
  model that produced the index's vectors; a different model is a different
  vector space and would silently poison the index. Query text is prefixed with
  the Qwen3 Instruct (`agents.vdb.queryInstruct`) via `formatQueryForEmbedding`.
- **Document written per memory** (`memoryToV2Doc`): a full nVDB v2 document —
  `id` = `parent_id` = `mem_<n>`, `chunk_index: 0`, `kind: 'memory'`,
  `title` = description, `path` = `memory/<n>`, `body` = description + data,
  `acl` = principals, `metadata { memId, category, confidence }`, 1 KB
  `excerpt`, plus `content_hash` / `envelope_hash` from `v2-hash.js`. The
  embedded text is description + data capped at `maxMemoryChars`.
- **Init**: `createNdbClient(ndb.serviceUrl)` → `GET /health`; the configured DB
  (`ndb.dbs.memories`, overridable via `agents.memory.dbName`) must be listed in
  `health.dbs` or init throws naming the URL and the DB. Then the `id`,
  `category`, `embedStatus` hash indexes are created (idempotent), and the
  `_meta` doc (`nextId` allocator) is located — created if the DB is empty.
- **Incremental index sync** (`syncMemoryIndex({ forceRebuild })`, run at init,
  after every store/update/forget, and on a light periodic timer): drains
  `GET /v2/dbs/memories/changes?since=&limit=` in 500-event batches,
  deduplicating each batch by `_id` (highest `seq` wins) and skipping
  non-`mem_*` docs, then commits to nVDB **before** persisting the collection
  watermark (`POST /v2/collections/memory/watermark`). Normal restarts are
  O(changes); a full scan only happens on a rebuild.
- **Watermark / rebuild**: the watermark is `{ source_epoch_uuid, synced_seq }`.
  A missing watermark, a changed `source_epoch_uuid`, a degraded watermark, a
  `409 cursor_expired` (compaction replayed away the gap) or
  `forceRebuild: true` all trigger the **pinned-snapshot rebuild** — page
  through `GET /v2/dbs/memories/snapshot?snapshot_id=` for one frozen state,
  hash-diff against `fingerprints` so unchanged documents keep their vectors,
  upsert/delete in 250-doc chunks, set the watermark to the snapshot's
  `watermark_seq`, then catch up incrementally if the journal moved on. A
  same-epoch watermark with `synced_seq > last_seq` is a **loud invariant
  violation**, never silently repaired.
- Legacy `data/memories.json` (37MB, inline embeddings) is a cold backup only —
  never read or written at runtime.

Memory document shape (nDB, prefix `mem_`):

```json
{ "id": 3862, "description": "...", "category": "notes", "confidence": 0.5,
  "timestamp": "ISO", "embedStatus": "pending|embedded", "data": "..." }
```

IDs are monotonic (allocated from a `_meta` document's `nextId`) — **ID order
is time order**. `data` is optional extended content, visible only via
`memory.get` and hidden from listings.

## Tools — memory agent

Exposed as `memory.store`, `memory.recall`, `memory.get`, `memory.forget`,
`memory.list`, `memory.update`, `memory.overview`, `memory.embed_heal`
(legacy names `memory_store`… also work via the server's compact→legacy map).

| Tool | Args | Notes |
|---|---|---|
| `memory.store` | `description*`, `category?` (default `notes`), `confidence?` 0–1 (default 0.5, clamped), `data?` | Returns immediately — embedding runs detached. Visible to recall within seconds. Alias: `memory_remember`. |
| `memory.recall` | `query*`, `limit?` (default 5), `category?`, `search?` | Hybrid search, see below. `search` selects layers for one request (same keys as `vdb.search`); the reply's first line names the mode that ran. |
| `memory.get` | `id*` | Full memory incl. `data` payload. `#123` and `"123"` both accepted. |
| `memory.forget` | `id*` | Soft-delete in nDB (tombstone) + vector removed from nVDB + flush both. |
| `memory.list` | `category?`, `limit?` (positive int), `sort?` `newest\|oldest` | Filtering, sort and limit run in Rust (`POST /query`, filter `id: {$exists: true}` keeps out the `_meta` doc); without `limit` it pages 1000 at a time. Returns id+description+category only, never `data`. |
| `memory.update` | `id*`, then any of `description/category/confidence/data` | Prefer over forget+store (keeps ID history). All field changes go out as **one atomic `PATCH`** (single journal record; a failing path aborts the batch). Re-embeds detached if description or data changed. `data: null` removes the field. Timestamp refreshed. |
| `memory.overview` | `format?` `clusters\|summary\|full` (default `summary`) | Renders `data/dream_map.json`; also triggers background embed self-heal (rate-limited 1 pass/min, 10 embeds/pass) when pending memories exist. |
| `memory.embed_heal` | `batchLimit?` (default 50) | Force re-embedding of memories stuck at `embedStatus: 'pending'`. Stops at first failure. |

### Embedding pipeline (detached by design)

`embedText` concatenates `description + ' ' + data`, truncates at
`maxMemoryChars` (config `agents.memory.maxMemoryChars`, **6000**), and embeds
via the gateway in **background** mode — a hung embed provider never blocks the
tool response. Success → vector inserted, `embedStatus: 'embedded'`. Failure →
`embedError` recorded; the overview self-heal or `memory.embed_heal` retries
later.

### Recall (hybrid, reranked — one path)

`memory.recall` has exactly one retrieval path (the old vector-only rollback
mode is gone). Per recall:

1. `resolveSearchOptions` selects lanes, weights and profile (adaptive
   query-shape RRF — see
   [vdb.md](vdb.md#adaptive-query-shape-rrf-search-optionsjs)).
2. Query embedded through `agents.vdb.embeddingPath` (`/v1/embeddings`,
   `qwen3-embedding-4b`, 2560-dim) with the Qwen3 Instruct prefix, truncated
   at 6000 chars. If the embed fails, recall drops to the lexical lane with a
   `⚠` header naming the error; an explicitly dense-only request throws
   instead.
3. One `POST /v2/collections/memory/hybrid_search` with `text = query`,
   `candidate_k` 200, `rrf_k` 20, `fuzzy_edits` 1, per-document diversity on
   `parent_id` (`group_by_parent: { max_per_parent: 2 }`), a native promoted
   `category` filter when `category` is given, and
   `top_k = max(limit × 3, rerank ? effectiveShortlist : limit, 20)`.
4. Hits hydrate from nDB in **one** `POST /docs/mget` batch (deduplicated, chunked
   at 1000 ids); tombstoned/missing docs are dropped before reranking.
5. When a reranker is loaded, `POST /v2/collections/memory/level2` scores the
   shortlist — `max(limit, agents.vdb.rerank.shortlist)` (12) unless the
   request passes `search.shortlist` — at the adaptive `rerank_weight` (0.2
   for `exact-id` / `exact-short`, 0.6 otherwise) with `relevance_floor`
   0.05.
6. **The nVDB order is kept** — confidence is displayed, never used to
   reorder. The printed percentage is the **cross-encoder relevance score**,
   not a similarity and not a rank position; rows past the rerank shortlist
   print `n/a`.

**Rejection.** If the reranker ran and the best score in the set is below
`agents.vdb.relevanceFloor` (0.05), recall answers "No relevant memories" and
lists the candidates as low-relevance evidence. Dense-only and lexical-only
runs cannot reject — no calibrated signal exists. Per-row suppression is not
applied because weak single-token queries overlap legitimate paraphrases.

`memory.recall` also accepts `search` — per-request layer switches
(`dense`, `lexical`, `diversity`, `rerank`, `adaptive` + `rrfK`, `candidateK`,
`vectorWeight`, `lexicalWeight`, `maxPerDocument`, `shortlist`,
`rerankWeight`) for A/B runs. The handler accepts it even though the agent's
advertised schema does not list it. Memory's diversity group field is
`parent_id` (= the memory id). The reply's first line names the mode that ran;
invalid selections throw rather than falling back. Full semantics:
[vdb.md](vdb.md#per-request-layer-selection-ab).

**Output**: the top `limit` entries (`[#id] [category] 87.3% (vec#1/lex#4)
conf:0.9 [has data]`), plus an `--- also found ---` one-line tier for further
hits whose rerank score is ≥ `SCORE_FLOOR` (0.35).

The shared embed client (`src/embed-client.js`) guards every vector: non-finite
or zero-norm vectors are rejected, and a byte-identical vector reused for a
different input is rejected even across separate requests. Rejected stores
remain `embedStatus: 'pending'` for the normal self-heal path rather than
persisting a known-bad vector.

**Degradation ladder**: no nvdb serve client → the `limit` most recent memories
with a `⚠` header naming the reason → if the store is empty, a "topic is new"
hint. Query-embed failure → lexical lane only (above). Recall never hard-fails
on provider outages.

### Overview output tiers

- `clusters` — cluster names + hubs + counts only (lightest; enough to pick a
  recall query).
- `summary` (default) — TL;DR (top-3 clusters, bridge count), dreamer
  reflection, map delta, The Between top-5, clusters (max 20, desc truncated
  160 chars), bridges (max 20), wildcards, top 5 nodes per cluster, coverage
  cutoff directive.
- `full` — all nodes grouped by cluster with scores/bridges/momentum arrows.

Size guards come from issue #14 (a 242KB summary defeated its purpose):
`SUMMARY.maxClusters = 20`, `maxBridges = 20`, `clusterDescChars = 160`.
If `data/dream_map.json` doesn't exist yet: guidance text pointing at
`dream_generate`.

## Tools — dreaming agent (`memory.dream_*`)

| Tool | Args | Notes |
|---|---|---|
| `memory.dream_generate` | `force?` (default false) | Runs the pipeline now. Skips (with reason) if map is fresh (<30 min), no memories, no changes since last dream, or already running. |
| `memory.dream_status` | — | Map age/nodes/clusters, distillate cache state, pipeline phase, last run, interval, context budget, memory bank count. |
| `memory.dream_inject` | `format?` `json\|prompt` (default `prompt`) | The map as raw JSON or as a system-prompt-ready text block. |

### Schedule & files

- Config `agents.dreaming`: `intervalMinutes: 15`, `contextBudget: 800000`
  (tokens), `autoStart: true`, `distillerTask`/`dreamerTask: 'query'`,
  `serendipity { enabled, wildcardBoost: 3, resurfaceThresholdCycles:
  5, resurfaceChance: 0.3, scoreJitter: 0.05, scoreFloor: 0.15, jitterCeiling:
  0.80, seed: null }`.
- First run: forced, 10 s after init. Then every 15 min unforced (freshness
  gate 30 min).
- Files: `data/dream_map.json` (current), `data/dream_distillate.json`
  (compression cache), `data/dream_maps/` (backups, keep last 5),
  `data/dream_raw_output*.json` (parse-failure debug dumps). The map is also
  served at `GET /memory/map.json`.

### Pipeline stages

1. Load memories via `memoryAgent.memories.iter()`; prune map nodes/wildcards
   whose memory ids no longer exist.
2. Recent set = memories newer than the last map's `generated_at`
   (first-ever run: last 50).
3. **Distill** (prompt `prompts/distiller.txt`): compress memories to
   `[#ID] …` plain text. Incremental — unchanged memories reuse the cached
   distillate (cache hit ratio reported); chunked to fit
   `contextBudget − prompt − 2000` tokens; `temperature 0.3`.
4. **Dream** (prompts `dreamer.txt` full / `dreamer-delta.txt` delta):
   delta mode sends the compact current map + only new memories
   (`maxTokens 16000`); full mode sends distillate + recent (`maxTokens
   64000`). Both `temperature 0.3, enableThinking: false`, output must be
   valid JSON (map or `{cluster_changes, bridge_changes, node_changes}` +
   `wildcards` + `recall_directive`).
5. **Lenient parse** (`parseJsonLenient`, tested in
   `tests/dream-parse-lenient.test.js`): strip fences → brace-depth extraction
   → comment/trailing-comma stripping → unquoted-key repair → inner-quote
   escaping (≤20 guided rounds) → truncation recovery → last-resort
   nodes-array salvage.
6. **Merge delta**: clusters merge (not replace), bridge/node ops apply,
   wildcards replace; then `sanitizeBridges` (no self-loops, dead endpoints,
   duplicate or intra-cluster pairs; one per cluster-pair) and
   `sanitizeClusters` (heal missing hub/name from members, drop husks).
7. **Compact** if map > 120000 tokens: keep hubs/bridge-endpoints/wildcards/
   score ≥ 0.5; score ≥ 0.25 → title-only; < 0.25 dropped.
8. **Serendipity**: score floor 0.15; decayed nodes (≥5 consecutive decay
   cycles) resurface with 30% chance lifted to `min(0.35, score+0.10)`;
   3 random low-score (<0.35) nodes wildcard-boosted; ±0.05 jitter for scores
   in [0.15, 0.80]. Seeded RNG (`seed: null` = random each run).
9. **The Between enforcement** (spec:
   `documentation/Workshop/the-between-spec.md` in storage): category
   `the-between` nodes locked to cluster `c_between`, first-person `I (…)
   [substrate]` register, doer-language lint, summary compression floor.
   Runs pre-dreamer and post-serendipity.
10. No dream-entry write (removed 2026-10-18, #66 — the #24 gate could not
    hold: routine compaction + ordinary edge growth fire every run) → backup
    rotate → save map. The tending record stays in `meta.activity` + logs.

## Config keys

| Key | Default / value | Effect |
|---|---|---|
| `ndb.serviceUrl` | `http://127.0.0.1:8323` | `ndb serve` the memory store talks to. |
| `ndb.dbs.memories` | `memories` | Mounted DB name holding memory documents. |
| `agents.memory.ndbUrl` | (unset) | Per-agent override of `ndb.serviceUrl` (tests). |
| `agents.memory.dbName` | (unset) | Per-agent override of `ndb.dbs.memories` (tests). |
| `agents.memory.maxMemoryChars` | 6000 | Embed input truncation. |
| `agents.memory.syncIntervalMinutes` | 5 | Periodic `syncMemoryIndex()` catch-up for out-of-band `ndb` writes; `0` disables (init + write-through still run). |
| `agents.dreaming.intervalMinutes` | 15 | Dream cadence. |
| `agents.dreaming.contextBudget` | 800000 | Distill+dream token budget. |
| `agents.dreaming.autoStart` | true | Schedule automatically. |
| `agents.dreaming.serendipity.*` | see above | Wildcard/resurface/jitter knobs. |

## Behaviors worth knowing

- **Over-store by design.** Redundancy is fine — dreaming consolidates.
- **Store never blocks**: embedding is fire-and-forget; a dead embed provider
  degrades recall to lexical/recency but never errors the write.
- **`memory.recall` is the paid path** for detail; overview tiers are
  deliberately capped to stay cheap.
- Recency gap: the map lags dreaming cadence (~15 min + 4-day topology lag in
  practice); always recall for fresh work.
