# Memory System — memory + dreaming agents

Reference documentation for the persistent memory system. Last verified
2026-09-22 against `src/agents/memory/index.js`, `src/agents/dreaming/index.js`,
and both agents' `config.json`.

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
| **nDB** (document store) | `data/memories/data.jsonl` | Memory metadata: id, description, category, confidence, timestamp, data, embedStatus. Append-only JSONL, immediate persistence, soft-delete via tombstones. |
| **nVDB** (vector index) | `data/candidates/wizkid-hybrid-rerank/nvdb`, collection `memory` | One vector per memory (embeds description + data). Hybrid (dense + BM25) and reranked. Owned by the vdb agent; memory accesses it via `dependsOn: "vdb"` → `getCollection('memory')`, `embeddingPath`, `reranker`, `hybrid`, `rerank`. |

- `EMBEDDING_DIM = 2560` (must match vdb agent + the index's vector space).
- **Vector space**: memory embeds through `agents.vdb.embeddingPath`
  (`/v1/embeddings`, llama-based Qwen3-Embedding-4B) for every call — store,
  update, heal, recall query. The route must serve the model that produced the
  index's vectors; a different model is a different vector space and would
  silently poison the index. The shared client rejects any path that is not
  `/v1/embeddings…`.
- **Payload written per memory**: `{ id, description, data, content }` —
  `content` is the exact embedded text (description + data, capped), which is
  what the reranker scores and the lexical lane reads.
- nDB indexes: `id`, `category`, `embedStatus` + full-text indexes on
  `description` and `data` (nDB v1.3).
- **Init fail-fast probe**: memory opens a throwaway in-memory nDB and verifies
  the delta-op index fix (v1.3, commit 0ea6afd). A stale nDB binary throws at
  startup ("rebuild the nDB submodule") rather than silently poisoning
  pending-memory lookups.
- Init also cleans **orphaned vectors**: soft-deleted nDB docs whose vectors
  lingered in nVDB are removed and flushed.
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
| `memory.list` | `category?`, `limit?` (positive int), `sort?` `newest\|oldest` | Chronological ID order; returns id+description+category only, never `data`. |
| `memory.update` | `id*`, then any of `description/category/confidence/data` | Prefer over forget+store (keeps ID history). Re-embeds detached if description or data changed. `data: null` removes the field. Timestamp refreshed. |
| `memory.overview` | `format?` `clusters\|summary\|full` (default `summary`) | Renders `data/dream_map.json`; also triggers background embed self-heal (rate-limited 1 pass/min, 10 embeds/pass) when pending memories exist. |
| `memory.embed_heal` | `batchLimit?` (default 50) | Force re-embedding of memories stuck at `embedStatus: 'pending'`. Stops at first failure. |

### Embedding pipeline (detached by design)

`embedText` concatenates `description + ' ' + data`, truncates at
`maxMemoryChars` (config `agents.memory.maxMemoryChars`, **6000**), and embeds
via the gateway in **background** mode — a hung embed provider never blocks the
tool response. Success → vector inserted, `embedStatus: 'embedded'`. Failure →
`embedError` recorded; the overview self-heal or `memory.embed_heal` retries
later.

### Recall (hybrid, reranked)

Two retrieval modes, chosen by `agents.vdb.hybrid.enabled`:

**Hybrid mode (production).** One nVDB call per recall:

1. Query embedded through the index's route (foreground, truncated to 6000 chars).
2. `hybridSearch` / `hybridSearchReranked` with `text = query`, dense + BM25
   lanes fused at `rrfK`, `candidateK`, per-document diversity on `id`,
   over-fetched at `topK = max(limit × 5, 25)`.
3. When a reranker is loaded, the top `shortlist` (10) are scored by the ONNX
   cross-encoder on payload field `content` and re-fused at `weight` 0.2.
4. Hits join nDB by `_id`; **the nVDB order is kept** — confidence must not
   reorder the measured ranking (it is still displayed). The printed percentage
   is the **cross-encoder relevance score**, not a similarity and not a rank
   position: RRF puts the reranked head on one scale (`~1/61`) and the unscored
   tail on another (`~1/11`), and rank position says nothing about whether a
   result is relevant. Rows past the rerank shortlist have no measured
   relevance and print `n/a`.

**Rejection.** If the reranker ran and the best score in the set is below
`agents.vdb.relevanceFloor` (0.02), recall answers "No relevant memories" and
lists the candidates as low-relevance evidence. Measured: nonsense queries max
at 0.0089, the weakest verified real match is 0.0453. Dense-only and
lexical-only runs cannot reject — no calibrated signal exists. Per-row
suppression is not applied because weak single-token queries overlap legitimate
paraphrases (`set` 0.160 vs German `0.139`).

`memory.recall` also accepts `search` — per-request layer switches
(`dense`, `lexical`, `diversity`, `rerank` + `rrfK`, `candidateK`,
`vectorWeight`, `lexicalWeight`, `maxPerDocument`, `shortlist`,
`rerankWeight`) for A/B runs. Memory's diversity group field is `id`. The
reply's first line names the mode that ran; invalid selections throw rather
than falling back. Full semantics: [vdb.md](vdb.md#per-request-layer-selection-ab).

#### Query echo — source intent (2026-11-20)

A memory whose text contains the **whole query verbatim** is a record *about*
the query — a verification run, a status log — not an answer to it. Such a
record is demoted by `agents.memory.queryEchoPenalty` (default `0.5`) and marked
`·echo`; it is never removed.

Measured case: the query `Prototype Fund 47.5k application November 30 funding`
was quoted verbatim inside verification memory #7137, which therefore ranked 1
in **every** mode — full hybrid+rerank, dense-only and lexical-only — above
#6830, the funding memory that answers it. The cross-encoder rejects the echo
(0.0007 against #6830's 0.62), but RRF cannot express a 700× margin: every
candidate below #6830 scores inside a ~1e-5 noise band (0.000866 … 0.000187), so
the echoed record's rank there is arbitrary and raising the rerank weight only
moves a coin-flip tie (`w=0.5` leaves a 0.0004 gap; a shift inside the noise
band flips it back). The echo itself is categorical — exactly one candidate
matches — so it is tested directly instead of re-weighting the lane.

Minimum probe length is 4 tokens (shorter strings are ordinary vocabulary, not
a quotation). Golden: `npm run gate:nvdb` asserts #6830 rank 1 and that the
demoted record is still returned.
5. The nDB full-text leg still runs and appends any doc the index never returned,
   marked `·lex` at `LEXICAL_BASE` — it only surfaces when the index returns
   fewer than `limit` hits.

**Vector-only mode (rollback).** Cosine search over one collection and the
original ranking merge — `LEXICAL_BOOST` for docs found by both legs, then a
`score × (0.7 + confidence × 0.3)` sort.

The nDB **lexical leg** (both modes, runs regardless of embed health):
whole-token AND over the query's content words (≥3 chars, deduped, max 8 tokens)
across `description` and `data`; if strict AND finds nothing, narrows on leading
token subsets (6 → 4 tokens). **Never single-token OR** — common words match
hundreds of docs and drown the ranking. Capped at `LEXICAL_MAX_DOCS = 50`.

All memory embeddings pass through the shared client's integrity guard:
non-finite/zero-norm vectors are rejected, and a byte-identical vector reused
for a different input is rejected even across separate requests. A startup
tracker also guards against collisions with vectors already stored for other
active memories, including after process restarts. Rejected stores remain
pending for the normal self-heal path rather than persisting a known-bad vector.

Ranking merge constants:

| Constant | Value | Meaning |
|---|---|---|
| `LEXICAL_BOOST` | 0.10 | Vector-only mode: added to the semantic score of docs that ALSO match lexically. |
| `LEXICAL_BASE` | 0.45 | Synthetic score for lexical-only docs (semantic missed). |
| `SCORE_FLOOR` | 0.35 | Minimum score for the compact "also found" second tier. |
| confidence weight | `score × (0.7 + confidence × 0.3)` | Final sort key — **vector-only mode only**. |

Output: top `limit` entries with descriptions (`[#id] [category] 87.3% ·lex
conf:0.9 [has data]`), plus an `--- also found ---` one-line tier for hits ≥
SCORE_FLOOR. Tombstoned vectors lingering in nVDB are skipped (DB.get throws →
caught → continue).

Degradation ladder (embed provider down): lexical results returned with a ⚠
header naming the real error → if no lexical hits either, the `limit` most
recent memories → if store empty, a "topic is new" hint. Recall never hard-fails
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
| `agents.memory.dbPath` | `data/memories/data.jsonl` | nDB location. |
| `agents.memory.maxMemoryChars` | 6000 | Embed input truncation. |
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
