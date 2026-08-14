# Embed Backend Degradation — Evidence (2026-08-14)

**Status:** OPEN — confirmed live, root cause located, unfixed.
**Scope:** MCP Server semantic search (VDB) depends on an embed backend that
produces non-deterministic and duplicate embeddings.

---

## 1. Request chain (fully traced, no fallback routing)

```
mcp_server  (src/embed-client.js, src/gateway-client.js embed*)
  └─ POST http://localhost:3400/v1/embeddings   { input, dimensions }   ← GATEWAY
       └─ LLM Gateway: src/routes/embeddings.js — THIN PROXY, HARDCODED
            EMBED_WRAPPER_URL = http://192.168.0.145:4080/v1/embeddings
            EMBED_MODEL      = Qwen/Qwen3-Embedding-4B-GGUF
            (forwards body verbatim, echoes response)
            └─ Fatten wrapper (192.168.0.145:4080) — THIN PROXY
                 src/server.js handleInference(): resolve model -> ensureModel()
                 -> spawn llama-server instance -> proxyToInstance() raw
                 └─ llama-server (llama.cpp, Qwen3-Embedding-4B)  ← ACTUAL EMBEDDING
```

**Conclusion:** Every hop (gateway, wrapper) is a thin pass-through to a single,
fixed llama-server instance. There is **no fallback routing and no secondary
backend**. The degradation originates in the **llama-server (llama.cpp) embedding
computation itself**.

### Verification — code references (2026-08-14)
- Gateway hardcoded single backend: `D:\DEV\LLM Gateway\src\routes\embeddings.js`
  (constants `EMBED_WRAPPER_URL`, `EMBED_MODEL`; no routing/fallback logic).
- Gateway is the live process on :3400 (PID 22840, `node main.js`, cwd
  `D:\DEV\LLM Gateway`; its `logs/` has the most recent session).
- Wrapper thin proxy: `D:\DEV\llama-cpp-wrapper\src\server.js`
  `handleInference()` → `ensureModel()` → `proxyToInstance()`.
- mcp_server embed client sends `{ input }` only, no model:
  `src/embed-client.js`.

---

## 2. Live evidence (captured 2026-08-14, direct to gateway `/v1/embeddings`)

Reproducible script: `docs/embed-degradation-evidence.mjs`
(auth `Bearer someKey33!!`, model owned by gateway).

### (A) Determinism — same text embedded 5×
Input: `"The quick brown fox jumps over the lazy dog."`

| Pair | cosine | expected |
|------|--------|----------|
| rep0 vs rep1 | 0.4881 | ~1.0000 |
| rep0 vs rep2 | 0.4883 | ~1.0000 |
| rep0 vs rep3 | 0.4883 | ~1.0000 |
| rep0 vs rep4 | 0.4883 | ~1.0000 |

A deterministic embedding model must return ~1.0 for identical input. 0.49
means the first call returns a different vector than subsequent calls — the
model output is unstable across calls.

### (B) Duplicates — distinct texts in a batch return identical vectors
5 distinct sentences, 3 rounds. Identity threshold: cosine > 0.999.

| Round | identical pairs |
|-------|-----------------|
| 1 | text[0] vs text[1] (cosine 1.0000) |
| 2 | text[0] vs text[3], text[1] vs text[4] (1.0000) |
| 3 | text[0] vs text[3] (1.0000) |

Every round produced byte-identical vectors for **unrelated** sentences (e.g.
"quantum physics and pizza recipes" == "The quick brown fox...").

### (C) Corroborating single-call test (earlier same session)
- Same sentence, two single calls → cosine 0.62.
- One batch of 4 → "The quick brown fox..." vs "the attribution problem in AI
  collaboration" → cosine 1.0000 (identical).

### (D) Mechanism: non-deterministic + state-dependent (refined 2026-08-14)
Two controlled experiments:

**D1 — 6 sequential single calls, same text** (pairwise cosine matrix):
```
        rep0  rep1  rep2  rep3  rep4  rep5
rep0   1.000 0.485 0.488 0.488 0.488 0.488
rep1   0.485 1.000 0.999 0.999 0.999 0.999
rep2   0.488 0.999 1.000 1.000 1.000 1.000
...    (rep2..rep5 all 1.000 with each other)
```
First call (rep0) is a unique/wrong vector; subsequent calls are identical.
→ **first-request-after-(re)load anomaly.**

**D2 — same batch of 5 distinct texts, 3 sequential rounds**:
- Cross-batch determinism per item (round0 vs round1, round0 vs round2):
  - text[0]: 1.000 / 1.000  (stable)
  - text[1]: 0.484 / 0.484
  - text[2]: 0.354 / 0.514
  - text[3]: 0.288 / 0.288
  - text[4]: 0.484 / 0.286
- Within-batch: round0 no duplicates; round1 & round2 text[1] vs text[3]
  identical.

→ **most inputs are NOT deterministic across calls (0.28–1.0), and distinct
texts collapse to identical vectors within a batch.** This is worse than a
warmup bug: the output is unstable and state-dependent.

---

## 2b. Backend config + version (captured 2026-08-14)

llama-server build **9986** (`dist/universal/llama-server.exe`).
**Model in use: `Qwen3-Embedding-4B-f16.gguf` (full precision FP16, NOT quantized)** —
verified from the spawn log (`Spawning llama-server: Qwen3-Embedding-4B-f16.gguf`).
The wrapper resolves the highest-precision variant in the model dir; we run the
full model, not a Q4_K_M quant.

Embed model override (Fatten wrapper `models.json`):
```json
"qwen/qwen3-embedding-4b-gguf": {
  "ctxSize": 32768, "gpuLayers": 99, "embedding": true,
  "pooling": "last", "flashAttention": false, "ubatchSize": 2048
}
```
- `gpuLayers: 99` → fully GPU-offloaded (CUDA). llama.cpp has open issues for
  Qwen3-Embedding on CUDA returning corrupted/NaN embeddings where CPU is
  correct (#26044) and `--embedding` corrupted-data quality decline (#26282).
- `pooling: "last"` + batch handling is a suspect for the within-batch
  identical-vector collapses.

---

## 3. Impact on the VDB index (mcp_server)

Spurious score-1.0 matches in semantic search. The storage index contains
chunks persisted with duplicate/degenerate vectors (identical vector across
unrelated files), and query embeddings can collide with them:
- `blog/posts/the-attribution-problem.md#3`
- `blog/attic/2026-06-05-model-portraits.md`
- `sessions/chat_1785098280835_fi7gi584.json#26`
(indexed on different days — 08-09/08-10/08-12 — yet byte-identical vectors.)

Garbage query `"zzqxqwbv pyxnnrkl gdqcv zzzzz garbage nonsense"` returns these
at cosine 1.0. Next legitimate match ~0.60. So bad vectors dominate results.

---

## 4. Why previous rework did not fix this

The 2026-08-04 rework addressed **reliability**, not **correctness**:
- embed-client timeout tiers (foreground 15s / batch 30s / background 5 min)
- abort propagation / slot draining (llama.cpp wedge class)
- removed `model` field from client payload

None of these change what llama-server outputs. The embedding **quality /
stability** bug in the llama-server layer was never touched.

---

## 5. Open items / suggested fixes

1. ~~Root cause investigation~~ → **RESOLVED 2026-08-14 — see section 6.**
2. Immediate data cleanup: re-embed the 3 degenerate chunks now that the
   backend is deterministic.
3. Defensive guard (mcp_server): reject near-duplicate/degenerate embeddings at
   VDB write time so bad vectors cannot re-enter the index.

---

## 6. Root cause + fix CONFIRMED (2026-08-14)

**Root cause: `parallelSlots: 4` in embedding mode.** The Fatten wrapper
`models.json` overrode the embed models with `parallelSlots: 4`, so llama-server
ran with `--parallel 4`. In embedding mode, multiple server slots cause KV/slot
state corruption → non-deterministic output + duplicate vectors.

**Fix applied (Fatten wrapper `models.json`):**
```
qwen/qwen3-embedding-0.6b/4b/8b-gguf: parallelSlots 4 -> 1
```
Backup: `models.json.bak-20260814-parallel4`. Wrapper auto-respawns the
instance on config mismatch (next request picked up the change).

**Verification (re-ran the same tests after the change):**

Determinism — same text, 6 sequential single calls (pairwise cosine):
```
Before (parallel 4):  rep0=0.485, reps1-5=1.0   (first-call anomaly)
After  (parallel 1):  ALL = 0.999 - 1.000       (deterministic)
```

Batch — 5 distinct texts, 3 rounds:
```
Before (parallel 4):  duplicates in every round; cross-batch 0.28-1.0 (unstable)
After  (parallel 1):  NO duplicates; cross-batch ALL ~1.000 (stable)
```

**Conclusion:** `--parallel 4` in llama-server embedding mode was the sole
cause of the degradation. `parallelSlots: 1` fully resolves non-determinism and
duplicate vectors. Recommend keeping `parallelSlots: 1` permanently for embed
models (a batch is still processed within one slot; parallel>1 only adds
concurrent-request slots that corrupt embeddings).

**Remaining:** re-embed the 3 degenerate storage chunks so search no longer
returns the spurious score-1.0 matches.
