# Code Search Benchmarks

Performance tests to validate design assumptions before implementation.

## Tests

### 1. Filesystem Scan (`benchmark-filesystem-scan.js`)
Measures speed of recursive directory traversal with filtering.

**What it tests:**
- Recursive directory walking
- Blacklist filtering (node_modules, .git, etc.)
- Binary file detection (magic bytes)
- File readability checks

**Run:**
```bash
node test/benchmark-filesystem-scan.js [path]
node test/benchmark-filesystem-scan.js d:\DEV\mcp_server
```

**Expected output:**
- Files/second throughput
- Filtering effectiveness
- Average time per file

---

### 2. Embedding Creation (`benchmark-embeddings.js`)
Measures embedding generation performance via LM Studio.

**What it tests:**
- Single embedding latency
- Batch embedding throughput (10 files)
- Large batch performance (50 files)
- Extrapolation to 100k files

**Requirements:**
- LM Studio running on http://localhost:1234
- nomic-embed-text-v1.5 model loaded
- `.env` file with `LM_STUDIO_HTTP_ENDPOINT`

**Run:**
```bash
node test/benchmark-embeddings.js [path]
node test/benchmark-embeddings.js d:\DEV\mcp_server
```

**Expected output:**
- Single: ~50-100ms
- Batch (10): ~20-40ms per file
- Large (50): ~15-30ms per file
- 100k estimate: ~15-25 minutes

---

### 3. Code Mapping (`benchmark-code-mapping.js`)
Measures LLM-based code summarization + embedding.

**What it tests:**
- LLM code summary generation (2-3 sentences)
- Embedding of summaries
- End-to-end pipeline performance
- Extrapolation to 100k files

**Requirements:**
- LM Studio WebSocket endpoint (ws://localhost:1234)
- hermes-3-llama-3.1-8b model loaded
- nomic-embed-text-v1.5 for embeddings
- `.env` file with both endpoints

**Run:**
```bash
node test/benchmark-code-mapping.js [path]
node test/benchmark-code-mapping.js d:\DEV\mcp_server
```

**Expected output:**
- LLM summary: ~1000-3000ms per file
- Embedding: ~50-100ms per file
- Total: ~1-3 seconds per file
- 100k estimate: ~30-80 hours (sequential)

**Note:** This is intentionally sequential. Real implementation would batch LLM calls and parallelize, reducing time by 10-20x.

---

## Usage

```bash
# Test all three in sequence
node test/benchmark-filesystem-scan.js d:\DEV\mcp_server
node test/benchmark-embeddings.js d:\DEV\mcp_server
node test/benchmark-code-mapping.js d:\DEV\mcp_server

# Or test on different codebases
node test/benchmark-filesystem-scan.js C:\Projects\large-repo
```

## Results

### Test 1: Filesystem Scan (D:\DEV)
**Actual Performance:**
- Total entries: 107,512 (after blacklist filtering)
- Readable files: 59,146
- Duration: 5.6 seconds
- **Throughput: 10,534 files/second**
- Avg per file: 0.09ms

**Extrapolation:**
- 100k files: ~9.5 seconds
- 500k files: ~47 seconds
- 1M files: ~95 seconds

**Conclusion:** ✅ Filesystem traversal is NOT the bottleneck. Far faster than expected.

---

### Test 2: Embedding Creation (D:\DEV)
**Actual Performance (text-embedding-nomic-embed-text-v2-moe):**
- Single: 2,063ms (don't use single calls)
- Batch (10): 25.28ms per file
- Batch (50): 14.64ms per file
- **Best throughput: 14.64ms per file** (large batches)

**Extrapolation:**
- 100k files: ~42.1 minutes (batch-10)
- 100k files: ~24.4 minutes (batch-50, optimal)

**Conclusion:** ✅ Embedding creation is viable. Larger batches = better performance. 8k context model is 2x slower than v1.5 but crucial for code files.

---

### Test 3: Code Mapping with LLM (D:\DEV, 10 files)
**Actual Performance:**
- LLM summary generation: ~2,500-3,000ms per file
- Embedding of summary: ~10-12ms per file
- **Total: ~2.5-3 seconds per file**

**Extrapolation:**
- 100k files sequential: ~69-83 hours (2.9-3.5 days)
- With 10x parallelization: ~7-8 hours
- With batching: Still impractical for bulk indexing

**Conclusion:** ❌ LLM code mapping is too slow for initial indexing. Use direct file embeddings instead. LLM summaries only viable for incremental updates or post-search refinement.

**UPDATE - Deep Mapping with Qwen3-vl-8b:**
- Model: qwen/qwen3-vl-8b (262K context, in VRAM)
- Success rate: 7/7 files (100% valid JSON)
- Avg mapping time: 9,197ms (~9.2 seconds per file)
- Avg embedding: 13ms
- Total: ~9.2 seconds per file
- Extracted: 97 keywords, 33 functions, 8 classes across 7 files

**Extrapolation:**
- 100k files sequential: ~256 hours (10.7 days)
- With 10x parallelization: ~26 hours
- With 20x parallelization: ~13 hours

**Conclusion:** ✅ Deep mapping is VIABLE for selective/on-demand enhancement:
- Pre-map frequently accessed files
- Map files on-demand when user searches specific areas
- Use as optional enhancement layer over direct embeddings
- Perfect for smart-RAG systems with targeted deep analysis

---

## Design Validation

These tests validate key assumptions from [docs/code-search-module.md](../docs/code-search-module.md):

1. **Filesystem scan**: ~10,000 files/second → 100k files in ~10 seconds ✅ (10x faster than expected!)
2. **Embedding creation**: ~20ms/file batched → 100k files in ~15-20 minutes ⏳ (pending Test 2)
3. **Code mapping**: ~1-3s/file sequential → impractical for 100k files ⏳ (pending Test 3)

**Conclusion:** Direct file embedding (approach #2) is viable. LLM-based code mapping (approach #3) requires batching/parallelization or should be limited to semantic search results only.
