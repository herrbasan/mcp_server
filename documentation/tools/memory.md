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
| **nVDB** (vector index) | `data/nvdb/`, collection `memory` | One vector per memory (embeds description + data). Cosine search. Owned by the vdb agent; memory accesses it via `dependsOn: "vdb"` → `getCollection('memory')`. |

- `EMBEDDING_DIM = 2560` (must match vdb agent + gateway embed model).
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
| `memory.recall` | `query*`, `limit?` (default 5), `category?` | Hybrid search, see below. |
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

### Hybrid recall (semantic + lexical)

Two legs run on every `memory.recall`:

1. **Semantic**: query embedded (foreground, truncated to 6000 chars) →
   nVDB cosine search, over-fetched at `topK = max(limit × 5, 25)` to give the
   summary tier headroom.
2. **Lexical** (nDB text indexes, runs regardless of embed health): whole-token
   AND over the query's content words (≥3 chars, deduped, max 8 tokens) across
   `description` and `data`; if strict AND finds nothing, narrows on leading
   token subsets (6 → 4 tokens). **Never single-token OR** — common words
   match hundreds of docs and drown the ranking. Capped at `LEXICAL_MAX_DOCS = 50`.

Ranking merge constants:

| Constant | Value | Meaning |
|---|---|---|
| `LEXICAL_BOOST` | 0.10 | Added to semantic score of docs that ALSO match lexically (strongest relevance signal). |
| `LEXICAL_BASE` | 0.45 | Synthetic score for lexical-only docs (semantic missed). |
| `SCORE_FLOOR` | 0.35 | Minimum score for the compact "also found" second tier. |
| confidence weight | `score × (0.7 + confidence × 0.3)` | Final sort key. |

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
  `dreamerLabel: 'gemini-4-12b-dreamer on Badkid'` (required — init throws if
  empty), `serendipity { enabled, wildcardBoost: 3, resurfaceThresholdCycles:
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
10. Gate `isNonTrivialDream` (edges/bridges/clusters added or anything
    compressed) → the dreamer files its own log entry via `memory.store`
    (category `the-between`, confidence 0.6) → backup rotate → save map.

## Config keys

| Key | Default / value | Effect |
|---|---|---|
| `agents.memory.dbPath` | `data/memories/data.jsonl` | nDB location. |
| `agents.memory.maxMemoryChars` | 6000 | Embed input truncation. |
| `agents.dreaming.intervalMinutes` | 15 | Dream cadence. |
| `agents.dreaming.contextBudget` | 800000 | Distill+dream token budget. |
| `agents.dreaming.autoStart` | true | Schedule automatically. |
| `agents.dreaming.dreamerLabel` | (set, required) | Substrate tag for the dreamer's the-between entries. |
| `agents.dreaming.serendipity.*` | see above | Wildcard/resurface/jitter knobs. |

## Behaviors worth knowing

- **Over-store by design.** Redundancy is fine — dreaming consolidates.
- **Store never blocks**: embedding is fire-and-forget; a dead embed provider
  degrades recall to lexical/recency but never errors the write.
- **`memory.recall` is the paid path** for detail; overview tiers are
  deliberately capped to stay cheap.
- Recency gap: the map lags dreaming cadence (~15 min + 4-day topology lag in
  practice); always recall for fresh work.
