# 🧠 Dreaming System Specification v2.0

## 1. Overview
The **Dreaming System** is an autonomous background process that consolidates the LLM's memory bank into a weighted, connected graph (the **"Map"**). This Map provides immediate, high-fidelity contextual grounding for new sessions, eliminating the "reconstruction tax" where the model must guess context from fragmented memories.

**Core Value:** Gives the model *"permission to stop guessing"* by providing topology, priority, and relationships upfront — while actively encouraging live recall for anything newer than the map covers.

**Design Principles:**
- **LLM-first analysis**: No dumb heuristic pre-filters. The LLM reads and understands content directly.
- **Progressive compression**: Memories lifecycle from full representation → summary → title-only based on connection momentum.
- **Connection momentum**: Gaining connections = promotion. Losing connections = gradual demotion. Never delete — just compress.
- **Budget-aware**: Multi-pass distillation handles arbitrarily large memory banks within context window limits.

---

## 2. Architecture

```
Phase 1: Distillation (LLM-powered, multi-pass if needed)
┌─────────────────────────────────────────────────────────┐
│  [Memory Bank] ──▶ [Chunker] ──▶ [Distiller Agent] ──▶ │
│                                       ▲                 │
│  [Previous Distillate] ──(cache)──────┘                 │
│                                       │                 │
│                          [Distillate: condensed history] │
└─────────────────────────────────────────────────────────┘

Phase 2: Dreaming (LLM-powered, single pass)
┌─────────────────────────────────────────────────────────┐
│  [Distillate] + [Full Recent Memories] ──▶ [Dreamer] ──▶│
│  [Previous Map] ──(connection momentum)──────┘          │
│                                       │                 │
│                              [Map JSON v3.0]            │
└─────────────────────────────────────────────────────────┘

Phase 3: Injection
┌─────────────────────────────────────────────────────────┐
│  [Session Init] ◀──(inject map)── [dream_map.json]      │
│  + directive: "recall memories newer than map timestamp" │
└─────────────────────────────────────────────────────────┘
```

### Components
| Component | Role |
|-----------|------|
| **Chunker** | Splits memory bank into context-window-sized chunks for multi-pass distillation. |
| **Distiller Agent** | LLM that condenses memory chunks into dense thematic summaries. Incremental — only re-processes changed memories. |
| **Dreamer Agent** | LLM that analyzes distilled history + full recent memories, applies connection momentum from previous map, and produces the Map. |
| **Map Storage** | Persistent JSON file (`/data/dream_map.json`) + distillate cache (`/data/dream_distillate.json`). |
| **Injector** | Middleware that loads the Map into the system prompt on session start, with a recall directive for post-map memories. |

---

## 3. Data Flow

### Phase 1: Distillation
1. **Input:** Full memory bank + previous distillate cache.
2. **Delta detection:** Compare memory timestamps against distillate cache. Identify new/updated memories since last distillation.
3. **Chunking:** If total content exceeds context window (~1M tokens), split into overlapping thematic chunks.
4. **Distillation passes:** For each chunk, the Distiller reads full content and produces dense summaries preserving key facts, decisions, gotchas, and relationships.
5. **Merge:** Combine new distillate with cached distillate. Older unchanged sections are reused verbatim.
6. **Output:** Condensed representation of entire memory bank that fits within a single context window.

### Phase 2: Dreaming
1. **Input:**
   - Distillate from Phase 1 (full history, condensed).
   - Full text of all memories created/updated since last dream (no compression on recent).
   - Previous Map (for connection momentum).
2. **Processing:**
   - **Connection momentum:** Compare each node's connections against previous map. Positive delta = score boost. Negative delta across consecutive dreams = progressive demotion.
   - **Clustering:** Group nodes by theme; identify hubs.
   - **Bridge Detection:** Find high-value cross-cluster links.
   - **Wildcard Selection:** Inject 5 random/dormant nodes for "mental drift".
   - **Progressive compression:** Nodes with sustained connection loss get compressed (full → summary → title-only).
   - **Self-Reflection:** Dreamer notes uncertainties, missing links, or areas where live recall is recommended.
3. **Output:** Map JSON v3.0 (see Section 5).

### Phase 3: Injection
1. **Storage:** Write `/data/dream_map.json`. Rotate backup to `/data/dream_maps/`.
2. **On session start:** Load map, inject into system prompt with coverage cutoff timestamp.
3. **Recall directive:** Map includes `meta.coverage_cutoff` — any memory newer than this is not reflected, and the model should use live recall for those.

---

## 4. Connection Momentum & Progressive Compression

### Connection Momentum
Each node tracks its connection count across dreams. The delta drives promotion/demotion:

$$\Delta_c = |connections_{current}| - |connections_{previous}|$$

| Delta | Effect |
|-------|--------|
| $\Delta_c > 0$ | **Promotion**: Score boost of $+0.05 \times \Delta_c$. Memory is gaining relevance. |
| $\Delta_c = 0$ | **Stable**: No change. |
| $\Delta_c < 0$ | **Demotion**: Score penalty of $-0.03 \times |\Delta_c|$. Memory is losing connections. |

### Progressive Compression
Nodes that lose connections across consecutive dreams are progressively compressed:

| State | Condition | Representation in Map |
|-------|-----------|----------------------|
| **Full** | Active or recently promoted. | Full node with all fields: type, summary, category, score, connections, cluster. |
| **Summary** | 2+ consecutive dreams with negative $\Delta_c$. | Reduced to summary + category + score. No connections array. |
| **Title-only** | 4+ consecutive dreams with negative $\Delta_c$. | Only `id`, `title`, `category`. Minimal footprint. |

### Re-promotion
A title-only or summary node that gains a new connection is immediately promoted back to **Full** representation. This creates a natural lifecycle:

```
New memory → Full → (loses connections) → Summary → (keeps losing) → Title-only
                                    ↑                                    │
                                    └──── (gains connection) ─────────────┘
```

### Wildcard Selection
- 5 nodes injected per dream.
- **80% Random:** Drawn uniformly from full pool (including compressed nodes).
- **20% Dormant:** Nodes not surfaced in last 3 dreams.
- Purpose: Simulate "mental drift" and enable accidental context collisions that can trigger re-promotion.

---

## 5. Output Format (Map JSON v3.0)

```json
{
  "meta": {
    "version": "3.0",
    "generated_at": "ISO-8601",
    "coverage_cutoff": "ISO-8601",
    "distillate_stats": {
      "total_memories": 0,
      "distilled_chunks": 0,
      "cache_hit_ratio": 0.0
    },
    "dreamer_reflection": "String noting uncertainties, missing bridges, low-confidence boundaries, and areas where live recall is recommended.",
    "delta": {
      "new_connections": [ [id1, id2], ... ],
      "decayed_nodes": [ id, ... ],
      "surging_nodes": [ id, ... ],
      "promoted": [ id, ... ],
      "demoted": [ id, ... ],
      "compressed_to_summary": [ id, ... ],
      "compressed_to_title": [ id, ... ]
    }
  },
  "clusters": [
    { "id": "c1", "name": "Cluster Name", "hub_id": id, "desc": "Brief description" }
  ],
  "bridges": [
    { "from_id": id, "to_id": id, "reason": "Explanation of cross-cluster link" }
  ],
  "wildcards": [
    { "id": id, "summary": "Short text", "reason": "random" | "dormant" }
  ],
  "nodes": [
    {
      "id": id,
      "state": "full" | "summary" | "title",
      "type": "law" | "solved" | "active" | "preference" | "philosophy" | "context" | "humor" | "identity",
      "summary": "<10 words",
      "category": "string",
      "score": 0.0-1.0,
      "connections": [ id, ... ],
      "cluster_id": "cX",
      "is_bridge": false,
      "momentum": { "delta": 0, "consecutive_decay": 0 }
    }
  ],
  "recall_directive": "Memories created or updated after {coverage_cutoff} are not reflected in this map. Use memory_recall for recent context."
}
```

**Node field availability by state:**

| Field | `full` | `summary` | `title` |
|-------|--------|-----------|---------|
| `id` | ✅ | ✅ | ✅ |
| `state` | ✅ | ✅ | ✅ |
| `type` | ✅ | ✅ | ❌ |
| `summary` | ✅ | ✅ | ❌ |
| `category` | ✅ | ✅ | ✅ |
| `score` | ✅ | ✅ | ❌ |
| `connections` | ✅ | ❌ | ❌ |
| `cluster_id` | ✅ | ❌ | ❌ |
| `is_bridge` | ✅ | ❌ | ❌ |
| `momentum` | ✅ | ✅ | ❌ |

---

## 6. Execution Triggers

| Trigger | Condition | Action |
|---------|-----------|--------|
| **Scheduled** | Every 1 hour (configurable). | Run full pipeline (distill + dream) in background. |
| **Event-Driven** | >10 new memories or >5 memory updates since last dream. | Run full pipeline immediately. |
| **Manual** | User runs `/dream` or calls `dream_generate()`. | Run full pipeline synchronously. |
| **Session Start** | No map exists or map is >2h old. | Run pipeline before injecting context. |

---

## 7. Integration Points

### IDE / Chat Interface
- On session init, check `/data/dream_map.json`.
- If valid and <2h old, inject into system prompt:
  ```
  [MEMORY MAP v3.0 — generated {meta.generated_at}]
  Coverage cutoff: {meta.coverage_cutoff}
  { ... map JSON ... }
  
  DIRECTIVE: Memories created/updated after {coverage_cutoff} are not in this map. Use memory_recall for recent context.
  ```
- If missing/stale, trigger pipeline, wait for completion, then inject.

### CLI / Automation
- `node dream.js --run` → Full pipeline (distill + dream) and exit.
- `node dream.js --distill` → Run distillation phase only.
- `node dream.js --dream` → Run dream phase only (uses cached distillate).
- `node dream.js --watch` → Run on schedule + memory change events.

### Storage
- Map: `/data/dream_map.json`
- Distillate cache: `/data/dream_distillate.json`
- Backups: Keep last 5 map versions in `/data/dream_maps/` for rollback.

---

## 8. Implementation Checklist

### Phase 1: Distillation
- [ ] Create `dream.js` module with pipeline orchestration.
- [ ] Implement memory chunker (split by token budget with overlap).
- [ ] Implement distillation prompt for Distiller Agent.
- [ ] Implement distillate cache (read/write/merge with previous).
- [ ] Implement incremental distillation (only re-process changed memories).

### Phase 2: Dreaming
- [ ] Implement Dreamer Agent prompt (reads distillate + recent full memories).
- [ ] Implement connection momentum tracking (delta calculation across dreams).
- [ ] Implement progressive compression logic (full → summary → title).
- [ ] Implement re-promotion on new connections.
- [ ] Implement wildcard selector (random + dormant bias).
- [ ] Implement bridge detection (cross-cluster scoring).
- [ ] Implement self-reflection output.

### Phase 3: Integration
- [ ] Create `inject_map()` middleware for session init.
- [ ] Add recall directive generation (coverage_cutoff timestamp).
- [ ] Add `/dream` command to CLI.
- [ ] Set up hourly scheduler + event triggers.
- [ ] Add map versioning and backup rotation (5 versions).

---

## 9. Validation & Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Context Grounding** | Model reports "permission to stop guessing" | Post-session survey / self-report. |
| **Map Freshness** | <1h old at session start | Timestamp check on `meta.generated_at`. |
| **Bridge Density** | ≥3 cross-cluster bridges per dream | Count `bridges` array length. |
| **Wildcard Diversity** | 80% random, 20% dormant | Analyze `wildcards` reason distribution. |
| **Reflection Quality** | Dreamer notes ≥1 uncertainty | Check `meta.dreamer_reflection` content. |
| **Compression Ratio** | 40-60% of nodes in summary/title state | Count `node.state` distribution. |
| **Re-promotion Rate** | ≥1 re-promotion per dream | Count `meta.delta.promoted` entries. |
| **Distillation Cache Hit** | ≥70% cache reuse | Check `meta.distillate_stats.cache_hit_ratio`. |
| **Pipeline Duration** | <5 minutes end-to-end | Measure wall clock time. |

---

*Spec v2.0 — Redesigned with LLM-first analysis, connection momentum, and progressive compression. Ready for implementation.*