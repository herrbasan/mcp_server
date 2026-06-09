# Dreaming System Prompts v2.0

This file documents the prompts used by the Dreaming System. The actual prompts live in `src/agents/dreaming/prompts/`.

## Distiller Prompt (`prompts/distiller.txt`)

The Distiller compresses memory batches into dense summaries. It runs during Phase 1 of the pipeline.

**Key behaviors:**
- Preserves ALL factual content — compresses prose, never facts
- Groups related memories into thematic paragraphs
- Always references memories by `#ID`
- Never invents or infers content
- Output is plain text (no JSON, no markdown)

**Input:** A batch of memories formatted as `[#ID] [category] conf:X\ndescription\nExtended: data`

**Output:** Condensed text with `[#ID]` references

---

## Dreamer Prompt (`prompts/dreamer.txt`)

The Dreamer analyzes distilled + recent memories and produces the Map JSON v3.0. It runs during Phase 2.

**Key behaviors:**
- Reads ALL provided content (distilled history + full recent memories)
- Clusters memories into thematic groups with hubs
- Scores nodes based on recency, connectivity, significance, and connection momentum
- Detects cross-cluster bridges
- Applies progressive compression (full → summary → title-only)
- Re-promotes compressed nodes that gain new connections
- Selects 5 wildcards (4 random + 1 dormant)
- Self-reflects on uncertainties and areas needing live recall

**Input sections:**
1. `=== DISTILLED HISTORY ===` — Condensed older memories from the Distiller
2. `=== FULL RECENT MEMORIES ===` — Complete text of memories since last dream
3. `=== PREVIOUS MAP ===` — Connection data from previous map for momentum tracking

**Output:** Map JSON v3.0 (see spec Section 5 for full schema)

### Connection Momentum

The Dreamer receives the previous map's connection data and computes deltas:
- Positive delta → score boost (+0.05 per new connection)
- Negative delta → score penalty (-0.03 per lost connection)
- Consecutive negative deltas → progressive compression

### Progressive Compression States

| State | Condition | Fields Present |
|-------|-----------|---------------|
| `full` | Active or promoted | All fields |
| `summary` | 2+ dreams with negative delta | id, state, type, summary, category, score, momentum |
| `title` | 4+ dreams with negative delta | id, state, category only |

---

## Pipeline Flow

```
1. Load all memories from memory agent
2. Split into "recent" (since last dream) and "older"
3. Phase 1: Distill older memories (multi-pass if needed, cached incrementally)
4. Phase 2: Dream on distillate + recent + previous map → Map JSON v3.0
5. Save map + rotate backups
```

See `docs/memory_dreaming_spec.md` for the full specification.