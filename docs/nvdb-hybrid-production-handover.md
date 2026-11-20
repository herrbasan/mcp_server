# nVDB Hybrid + Rerank — Production Handover

Date: 2026-11-19
Status: **wired into production code; ONE operator step left — swap the `.node`.**
The retrieval path (`src/agents/vdb/index.js`, `src/agents/memory/index.js`,
`src/embed-client.js`, `config.json`) now runs hybrid + rerank against the
candidate index. The installed addon is still the old build, so the service
will REFUSE to start (`process.exit(1)` from agent init: "addon exports no
Reranker") until step 1 below is done. That is the intended fail-loud.

Golden gate: `npm run gate:nvdb` (copies the index, loads the addon the way the
service does, runs the real agents, exits non-zero on failure). Last run
2026-11-19 22:14: PASS — storage exact title rank 1, memory #6830 rank 1,
381 ms storage / 287 ms memory.

Known gap at the moment of cutover: the candidate storage collection is a
snapshot (built 2026-11-19 21:27). Storage files written or changed after that
are not in it. Memory does not have this gap — any memory missing from the
bound collection is queued as `embedStatus: pending` at init and re-embedded by
the normal self-heal (20 such memories existed at cutover). A storage delta
ingest path is the next chain.

Target: make the new nVDB hybrid/rerank path the actual `mcp_server` retrieval path.

## Read this first

Do not build another sidecar demonstration. The user asked for the new nVDB
feature **in production**, as the test of whether it works.

Production is currently unchanged:

- old `nvdb-node.win32-x64-msvc.node` still loaded;
- production index is still `data/nvdb`;
- VDB and memory retrieval still use vector-only search;
- no reranker is active in the service.

## Implemented nVDB work

Local nVDB branch: `feature/hybrid-retrieval`

Commits:

- `2e5b937` — hybrid retrieval and optional ONNX reranker
- `6d3605c` — NAPI `Reranker`, `hybridSearchReranked`, score diagnostics
- `609995c` — rank-fusion fix and licensed-model manifest

Implemented:

- native BM25 over weighted payload fields;
- dense + lexical RRF (`rrfK` configurable, production candidate uses `10`);
- per-document diversity;
- optional ONNX CPU reranker;
- weighted reciprocal-rank fusion between hybrid order and reranker order;
- `rrfScore`, `rerankScore`, lane ranks in results.

Tests: full nVDB suite passes (118 core + integration/doc tests).

## Licensed production candidate

Use only this model for production:

- `atelasi/multilingual-reranker-small`
- Apache-2.0
- INT8 ONNX, 64-token context
- model dir:
  `D:\DEV\mcp_server\src\nVDB\models\reranker\atelasi-multilingual-reranker-small`
- tracked manifest: `README.md` in that directory
- binaries are Git-ignored.

SHA-256:

- model: `F913154682468BFE92D6A7E02ED4E994E548C112FDDC74452B573B17C949046E`
- tokenizer: `7925F638B5444897EFE3B4608EED56C1652F0ED39C2662C8302DE1BC264C6088`

**Never deploy the unlicensed `Slite/mmarco-mMiniLMv2-L6` model.** It is
development-only and its upstream licence is undeclared.

## Candidate production index

Ready-to-use hybrid index:

`D:\DEV\mcp_server\data\candidates\wizkid-hybrid-rerank\nvdb`

Contents:

- `storage`: 2,055 files / 21,047 vectors, plus `path`, `title`, `content`
  lexical fields;
- `memory`: 4,931 vectors, plus `description`, `data`, `content` lexical fields;
- vectors are the same clean candidate vectors, no re-embedding needed; they were
  produced by the llama-based Qwen3-Embedding-4B service (`/v1/embeddings`).

Old production index `data/nvdb` remains the rollback index. Do not delete or
mutate it.

**Vector-space rule:** the candidate index's vectors come from the llama-based
**Qwen3-Embedding-4B** service, which is what `/v1/embeddings` serves (verified
2026-11-20: `model=Qwen/Qwen3-Embedding-4B-GGUF`, dim 2560, L2-normalized).
Production therefore uses the default route:

```
POST http://localhost:3400/v1/embeddings
```

`/v1/embeddings/wizkid` is the *same model* on the OpenVINO/Wizkid machine — a
different server, not a different space — so switching between them is a config
edit, not a re-index. What must never happen is pointing `embeddingPath` at a
route serving a different embedding model: the query vector would live in a
foreign space and every score would be confident nonsense.

## Measured quality/latency

Fair evaluation: 160 labeled real-corpus cases; misses count as failures.

Baseline hybrid (`rrfK=10`):

- MRR `0.7907`
- top-1 `112`

Apache reranker, 64-token context, top-10, fusion weight `0.2`:

- MRR `0.8148`
- top-1 `119`
- 17 improvements / 2 regressions
- full query latency approximately p50 148 ms, p95 232 ms
- reranker adds approximately 90–110 ms

The quality gain is real. The latency cost is also real. Production is the test.

## Exact production changes required

### 1. NAPI binary — **staged, no manual copy needed**

The rerank build (`cargo build --manifest-path src/nVDB/napi/Cargo.toml --release
--features rerank-onnx`) is staged at the path the loader prefers:

```
src/nVDB/target/release/nvdb-node.win32-x64-msvc.node   (26 MB, rerank-onnx)
```

The loader resolves env → `target/release/` → `napi/`, and loads directly. The
old addon in `napi/nvdb-node.win32-x64-msvc.node` (904 KB) is therefore
untouched and IS the rollback.

Consequences:

- **A restart alone activates everything** — stop `mcp_server`, start it. No
  file copy while the service holds the lock.
- **The old addon can no longer boot the service.** `vdb.init` throws
  ("addon exports no Reranker") and the loader calls `process.exit(1)`. That is
  intentional: serving without the reranker would be a different, unmeasured
  system.
- Rollback = delete the staged file (or set `agents.vdb.rerank.enabled: false`,
  which needs no index change), then restart.

No agent may restart the service. User controls lifecycle.

### 2. Node loader — **done**

`src/agents/vdb/nvdb-loader.js` `require`s the addon path directly, exports
`Reranker`, and no longer copies a binary into `nVDB/napi/` (that copy would
have overwritten the rollback backup at startup). `vdb.status` reports the
loaded `nativePath`. `NODE_NVDB_NATIVE_PATH` overrides the search order.

### 3. Query embedding route — **done**

`src/embed-client.js` takes `opts.path` (must start with `/v1/embeddings`);
`agents.vdb.embeddingPath = "/v1/embeddings"` (the llama-based Qwen3 service
that produced the vectors) is passed by both agents
for every embed (query, batch, background, memory store/update/heal). No
provider fallback; 429/503 stay explicit.

### 4. VDB agent — **done**

`src/agents/vdb/index.js`: `snapshot: true` (no scan/compaction/enhancement
cache), hybrid with `rrfK=10`, lexical weight 1.0, `diversity('path', 2)`,
reranker on `content` with shortlist 10 / weight 0.2. Payload schema of the
snapshot (`path`/`title`/`content`) is read as-is; `folder`/`extension` filters
are applied client-side because the snapshot has no such payload fields.

Ordering note — **do not re-sort hybrid results by raw score**: the reranked
head keeps scores around `1/61` while the unscored tail keeps lane-RRF scores
around `1/11`, so a numeric sort promotes the tail above the head. The agent
derives `normalizedScore` from native order instead.

### 5. Memory agent — **done**

`src/agents/memory/index.js`: hybrid recall through the same reranker,
`groupBy: 'id'`, shortlist 10, weight 0.2, rerank text field `content`. New
memories are written with `{ id, description, data, content }` so the lexical
lane and reranker see them. nVDB order is preserved (confidence is displayed,
not used to reorder); the nDB full-text leg remains as the explicit degraded
path when embedding is unavailable.

### 6. Configuration — **done**

See `agents.vdb.{snapshot,embeddingPath,hybrid,rerank}` in `config.json`.
Rerank enabled with a missing model/tokenizer, or an addon without the
`rerank-onnx` feature, aborts startup.

### 7. Golden gate before accepting production — **automated**

```powershell
npm run gate:nvdb
```

Copies the candidate index to `data/temp/nvdb-gate/`, runs the real agents,
checks: exact title in top 3, memory #6830 in top 3, reranked head not
re-sorted, `include_content`, folder filter, and prints latency. Exits non-zero
on failure. Last run: PASS.

The 160-case MRR replay (`scripts/memory-lab-phase0.mjs` /
`compare-memory-lab-storage-candidate.mjs`) remains the reference measurement —
MRR 0.8148, top-1 119, 17 improvements / 2 regressions.

### 8. Per-request layer selection (A/B) — **done**

`vdb.search`, `storage.search` and `memory.recall` accept `search`:

```json
{ "rerank": false }
{ "dense": true, "lexical": false }
{ "rrfK": 30, "rerankWeight": 0.5 }
```

Keys: `dense`, `lexical`, `diversity`, `rerank` (booleans) plus `rrfK`,
`candidateK`, `vectorWeight`, `lexicalWeight`, `maxPerDocument`, `shortlist`,
`rerankWeight`. The reply's first line names the effective mode; invalid or
impossible selections throw. Both lanes still run natively — a single-lane
request drops the other lane and orders by the kept lane's rank (or keeps the
rerank order). `src/agents/vdb/search-options.js`.

First measurement on the real index (`Consciousness Is the Record`): all layers
and dense-only put the record file at rank 4-5 or absent, **lexical-only puts
it at 1-3** — the exact-title signal is carried by BM25, not the dense lane.

### 9. Prototype Fund source-intent regression — **fixed**

Reported 2026-11-20: `Prototype Fund 47.5k application November 30 funding`
returned **#7137 rank 1** and #6830 rank 2 in every mode — full hybrid+rerank,
dense-only and lexical-only. #7137 is a verification record that quotes the
query verbatim in its `data`; both lanes read that as a perfect match.

Measured, before the fix (copy of the live index, real embedder):

| knob | #6830 rank | notes |
|---|---|---|
| full, rerank weight 0.2 (config) | 2 | #7137 rank 1 |
| full, weight 0.5 | 1 | margin 0.0004 |
| full, weight 0.8 | 1 | but it flips the storage golden's top doc v2 → record |
| no rerank | 2 | |
| dense only | 2 | |
| lexical only | 2 | (#6956 first) |
| rerank on `description`, w=0.2 | 1 | |

The reranker knows: **#6830 scores 0.6214; everything else sits in a 0.000866 …
0.000187 band.** #7137 is inside that noise (0.000674, rank 4), so its position
there is arbitrary — a weight change only moves a coin-flip tie, and `w=0.8`
costs the storage golden.

Fix: **query-echo demotion, not a re-weight.** A memory containing the whole
query verbatim (≥4 tokens, normalized substring) is a record *about* the query;
it is multiplied by `agents.memory.queryEchoPenalty` (0.5), marked `·echo`, and
kept. Exactly one candidate matches, so the signal is categorical and stable.

Result: #6830 rank 1 (95.8%), #7137 falls into the also-found tier as `·echo`.
No memory was edited or deleted; embeddings, provider and wrapper untouched.

Gate now asserts this golden: `Prototype Fund: #6830 rank 1`, the echoed record
is not rank 1, it is still returned, and the marker is present.

### 11. R3 extension filters — **fixed**

Report cluster R3: `extension: ".md"` returned zero everywhere (`md` was
turned into `..md`), and a client-side filter could empty one lane while
another returned hits — two identical requests even disagreed (5 vs 0).

- `md`, `.md`, `MD`, ` .MD ` are now one request; `md.`, `..md`, `''`, `'.'`,
  `-md` throw a documented error instead of returning zero. `folder` is
  trimmed and a `..` segment throws.
- A filtered request fetches `max(top_k*3, candidateK)` candidates before the
  client-side filter (it used to filter a 30-row cut, and the cut follows a
  near-tie rerank order, which made the membership unstable).

Gate: spelling equivalence, "only matches", "never invents a hit", folder+
extension, five rejections — all three lanes. Measured boundary: `dense-only +
md` is empty for `A Little Religion v6 final` because that lane's raw 800 rows
contain zero `.md`; dense coverage, not a filter defect.

### 13. R1 relevance rejection — **fixed**

Report cluster R1: nonsense queries returned unrelated records displayed at
100% confidence (memory `100.0 / 95.8 / 91.7%`, storage `1.00 / 0.966 / 0.931`)
and near-zero rerank scores suppressed nothing.

The displayed number is now the **cross-encoder score**, never rank position.
When reranking ran and the best score in the set is below
`agents.vdb.relevanceFloor` (default `0.02`), the tool answers "no relevant
matches" and lists the candidates as low-relevance evidence.

Measured before choosing the floor (real corpus, copy of the live index):

| class | best rerank score |
|---|---|
| nonsense, 1–4 tokens (3 queries) | 0.0003 … 0.0089 |
| weakest verified real match (German storage paraphrase, top_k=10) | 0.0453 |
| typical real match | 0.62 … 0.995 |

Dense cosine does not discriminate (~0.43–0.76 for noise *and* real), and BM25
is worse than useless as a gate (`radiator` scored 31.7 on an unrelated doc).
Weak single-token queries overlap real paraphrases (memory `set` 0.160 vs
German legit 0.139), which is why **no per-row cutoff** and **no cutoff outside
the reranked path** is applied.

Gate: three nonsense queries rejected in storage and memory with no `100.0%`
in the output; `nConvert`, the exact title, `Prototype`, `nui_wc2` and a German
paraphrase kept; the rejection boundary at shallow depth is printed.

### 14. Rollback

Keep:

- backup of old `.node`;
- old `data/nvdb`;
- old config;
- old Fatten embed route.

Rollback = stop service, restore `.node`, restore config/index paths, restart.
No data deletion is required.

## Current running test endpoint

`node scripts/nvdb-hybrid-test-server.mjs`

- `http://127.0.0.1:3197/health`
- `http://127.0.0.1:3197/search?lane=storage&q=Consciousness%20Is%20the%20Record&k=10`

This uses:

- test addon `src/nVDB/target/release/nvdb-hybrid-rerank-test.node`;
- candidate hybrid index;
- Apache licensed model, 64-token context, `rrfK=10`, fusion weight `0.2`.

It is only a validation surface, not production.

## Workspace safety

- preserve all unrelated dirty work in `mcp_server` and `nTeligence/nConvert`;
- never pull/reset/clean over local changes;
- do not restart production services;
- do not deploy the unlicensed L6 model;
- do not mix vector spaces.

## Definition of done

Production `mcp_server` starts with the rebuilt nVDB binary, serves VDB and
memory search from the hybrid candidate index using Wizkid embeddings, applies
the Apache reranker, passes the golden gate, and can be rolled back by restoring
the old binary/index/config.
