# Code Search Module - Gemma 3 Benchmark Results

**Date**: January 20, 2026
**Status**: Validated with Gemma 3 12B

## Executive Summary

Gemma 3 12B is the **clear winner** for code-search deep mapping:
- ✅ **100% success rate** (10/10 real files)
- ✅ **4.0s average** per file (range: 1.2s-5.9s)
- ✅ **2.3x faster than Qwen3** (was 9.2s/file)
- ✅ **Valid structured JSON** with actual extracted data
- ✅ **Quality extraction**: Functions with role descriptions, classes, keywords

## Benchmark Results

### Test Configuration
- **Model**: `google/gemma-3-12b` (32k context window)
- **Files**: 10 real JavaScript files from mcp_server project
- **Sizes**: 120-580 lines per file
- **Complexity**: Varied (simple frontend, complex server logic, tests)

### Performance (10 files)

| Metric | Value |
|--------|-------|
| Valid JSON | 10/10 (100%) |
| Avg deep mapping | 4,014ms |
| Avg embedding | 12ms |
| Total avg | 4,026ms |
| Functions extracted | 41 |
| Classes extracted | 12 |
| Keywords extracted | 139 |

### Individual File Performance

| File | Time | Functions | Classes |
|------|------|-----------|---------|
| logger.js | 5,433ms | 7 | 1 |
| generic.js | 1,544ms | 2 | 1 |
| google-search.js | 3,697ms | 4 | 1 |
| index.js | 4,034ms | 3 | 3 |
| code-analyzer.js | 4,761ms | 5 | 1 |
| logs.js | 1,235ms | 3 | 0 |
| web-start.js | 5,299ms | 5 | 3 |
| benchmark-filesystem-scan.js | 3,586ms | 2 | 0 |
| quick-test-marker.js | 4,696ms | 3 | 1 |
| test-comprehensive.js | 5,855ms | 7 | 1 |

### Extrapolation to 100k Files

**Embeddings only** (recommended start):
- 14.64ms/file × 100k = 24.4 minutes
- Enables semantic search immediately

**Full deep mapping**:
- 4.0s/file × 100k = 400,000s = 111 hours = ~4.6 days
- With 10x parallelization: ~11.2 hours

**Hybrid approach** (best of both):
- Phase 1: Embeddings for all (24 mins)
- Phase 2: Deep map top 1k files on-demand (~67 mins)
- Total: <2 hours for production-ready index

## Comparison: Models Tested

| Model | Speed | Success | Data Quality | Notes |
|-------|-------|---------|--------------|-------|
| **Gemma 3 12B** | **4.0s** | **100%** ✅ | **Excellent** | Uses ```json fences naturally |
| Qwen3-vl-8b (VRAM) | 9.2s | 100% ✅ | Excellent | 2.3x slower, needs VRAM |
| Qwen3-vl-8b (RAM) | 52s | 100% ✅ | Excellent | 13x slower, unusable |
| Nemotron 3 nano | ~1.5s | 25%* | Poor* | Fast but unreliable |
| DeepSeek R1 | N/A | 0% ❌ | N/A | Infinite thinking, no output |

*Nemotron: Valid JSON but mostly returned empty schemas or wrong data

## Architecture Decision

### Chosen: Single-Tier with Progressive Enhancement

**Rationale**: Gemma 3 is fast enough (~4s/file) that we don't need complex two-tier architecture.

**Approach**:
1. **Start**: Index with embeddings only (24 mins for 100k files)
2. **Query**: Use semantic search on embeddings (<500ms)
3. **Enhance**: Deep map top results on-demand (4s each)
4. **Cache**: Store deep maps permanently (content-hash keyed)
5. **Optional**: Bulk deep map important files overnight

**Benefits**:
- Simple implementation (no tier management)
- Fast time-to-value (embeddings in 24 mins)
- Progressive enhancement (better over time)
- Gemma 3 handles both semantic search AND deep mapping

## Sample Deep Map Output

```json
{
  "functions": [
    {
      "name": "constructor",
      "role": "Initializes a Logger instance."
    },
    {
      "name": "addListener",
      "role": "Adds a listener function to the logger's listeners set."
    },
    {
      "name": "notifyListeners",
      "role": "Calls each registered listener with a log entry, handling potential errors during execution."
    },
    {
      "name": "log",
      "role": "Creates and adds a new log entry to the logs array, notifies listeners, and returns the entry."
    }
  ],
  "classes": [
    {
      "name": "Logger",
      "role": "Manages log entries and notifies registered listeners of new logs."
    }
  ],
  "keywords": [
    "logger", "listeners", "log entry", "notification",
    "error handling", "event system", "observer pattern"
  ],
  "purpose": "Provides a centralized logging system with listener notification for event-driven architectures."
}
```

**Quality**: Functions include role descriptions (not just names), keywords are semantic (not just tokens), purpose provides context.

## Implementation Recommendations

### Phase 1: Embeddings-Only (Week 1)
- [x] Filesystem scanner (validated: 10k+ files/sec)
- [x] Embedding generation (validated: 14.64ms/file)
- [ ] Semantic search (cosine similarity)
- [ ] Basic file retrieval

### Phase 2: Deep Mapping (Week 2)
- [x] Gemma 3 integration (validated: 100% success)
- [x] JSON extraction (validated: robust parsing)
- [ ] Content-hash change detection
- [ ] Progressive enhancement logic

### Phase 3: Query Tools (Week 3)
- [ ] search_code tool (semantic + keyword)
- [ ] get_file_context tool (with deep map)
- [ ] build_index tool (embeddings + optional deep)
- [ ] get_index_stats tool

### Configuration

```json
{
  "code_search": {
    "enabled": true,
    "model": "google/gemma-3-12b",
    "embedding_model": "text-embedding-nomic-embed-text-v2-moe",
    "index_path": "data/code-index.json",
    "deep_mapping": {
      "enabled": true,
      "on_demand": true,
      "batch_size": 10
    }
  }
}
```

## Conclusion

**Gemma 3 12B enables a simple, fast, reliable code-search implementation:**
- No need for complex two-tier architecture
- 100% extraction reliability vs 25% with nemotron
- 2.3x faster than Qwen3 (only viable alternative)
- Natural JSON output (uses markdown code fences)
- 32k context handles large files

**Action**: Proceed with implementation using Gemma 3 as the deep mapping model.
