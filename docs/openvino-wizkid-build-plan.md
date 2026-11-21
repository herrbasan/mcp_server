# OpenVINO GenAI Qwen3-Embedding-4B F16 on Wizkid — one 120-minute go/no-go

Status: PLAN + HARNESS DESIGN ONLY. Nothing here has been built or run. Revised 2026-11-17.
Sources: `Workshop/memory-refactor-handover.md` (OpenVINO section), parent-supplied research notes.
Staging approved by David: `\\Wizkid\f\DEV\openvino-qual`; execute locally on Wizkid as `F:\DEV\openvino-qual`.

## Goal

One decision: can **native OpenVINO GenAI** serve **Qwen3-Embedding-4B at F16 on an Arc A770** correctly, fast enough, and without a failure in a short run, on **Wizkid**?

- Output: GO / NO-GO / ABORT (inconclusive) plus a report. Not a runtime matrix.
- **Hard budget: ONE 120-minute session covering Phases 0–6.** Any exceeded box stops the plan with the status given per phase.
- Phase 7 is separate (<=45 min), only after GO and David's explicit approval.

## Execution model: everything runs ON Wizkid, from one self-contained bundle

- Qualification on Wizkid needs **no network, no access to this repo, Fatten, Badkid or the lab, and no source checkout.**
- Wizkid does **not** run the HF CPU reference and does **not** fetch data. The conversion host precomputes all references and freezes the thresholds before shipping.
- Transfer = one bundle: model IR + tokenizer + pinned runtime + small data + harness. No production DB, no private corpus.

## Context

- Only usable local setup: Badkid chat + Fatten Arc A770 embeddings (llama.cpp/Vulkan). CPU embeddings are impractical (chat backlog).
- Unresolved: llama.cpp/Vulkan silent state corruption (#1531 observed, #1532 never root-caused).
- Wizkid (music PC) has the same Arc A770. Rust runners do not solve the backend; Rust/`ort` integration is a later decision.

## Hard rules

- Fatten, Badkid chat and production are untouched; no Badkid load that affects chat.
- No cutover, no historical reindex, no collection written.
- No config retry or tuning in any phase. Only a transient file/network **copy** retry is allowed.
- Every artifact pinned and hashed. Every number in the report comes from a saved JSON file.
- The music workload is not disturbed (Phase 0 defines the window).

## Assumptions (unverified)

1. Wizkid is reachable once for the bundle transfer and I may install into an isolated directory without affecting the music software.
2. The Arc driver on Wizkid is recent enough for the OpenVINO GPU plugin.
3. Qwen3-Embedding-4B converts via the Qwen3 path (inferred; Intel lists only 0.6B).
4. GenAI `TextEmbeddingPipeline` supports LAST_TOKEN pooling and L2 normalize for the 4B IR.
5. The ~8 GB F16 IR leaves VRAM headroom on the 16 GB A770 for the target batch/length (unmeasured).
6. R1 (HF CPU float32, 4B) over the corpus is computable on the conversion host within its box. The two near-8192-token items dominate that cost and are unmeasured.
7. The five #82 texts and the golden retrieval snippets can be exported from the lab as plain text before shipping (done on the conversion host, not on Wizkid).
8. nTeligence supports OpenAI-compatible embedding providers and admin Test (per parent). Dimension 2560.

## Bundle design

Built on the conversion host; copied once to Wizkid. All paths inside are **relative to the bundle root**; no absolute source paths anywhere.

```
bundle\
  README.md                 operator steps, exit codes, what is NOT claimed
  MANIFEST.sha256.json      SHA256 + size of every file below except reports\
  thresholds.json           frozen thresholds + config (see below)
  qualify.py                parent harness (subcommands, deadlines, reports)
  worker.py                 inference worker (only process touching OpenVINO)
  selfcheck_cases.json      planted-fault cases for the detector self-check
  requirements-lock.txt     pinned versions + wheel SHA256s
  wheels\                   offline wheels (openvino, openvino-genai, openvino-tokenizers, numpy)
  model\                    F16 IR + converted tokenizer (+ ir-manifest.json)
  corpus\parity-v1.jsonl    {id, kind, text} raw input strings, incl. the five #82 texts
  corpus\retrieval-v1.json  5 queries -> {target_id, distractor_ids[4]} labels
  reference\r1.f32          float32 R1 vectors, row order = corpus order
  reference\r1.meta.json    ids, dim, row order, R1 HF revision, torch/transformers versions, SHA256
  reference\r1-rankings.json  expected retrieval ranking per query from R1
  reference\r2-llamacpp.json  optional: production llama.cpp vectors for the #82 five (ids + hex/f32)
  throughput\profile-v1.json  request-shape profile: [{batch, token_lengths[]}], burst peak, seed
  reports\                  (empty) outputs written here
```

- **Interpreter:** `.\venv\Scripts\python.exe` created from the offline `wheels\`. No network.
- **Data size (estimate, non-model):** corpus < 0.5 MB (two long items ~30 KB each), R1 vectors ~0.35 MB (32 × 2560 × 4 B), profile and labels < 0.1 MB, harness < 0.1 MB. **Total non-model data about 1 MB.** Model IR ~8 GB and runtime wheels ~300 MB dominate; the whole bundle is ~8.5 GB.
- **Correctness data:** a small set of **selected real snippets plus synthetic cases** only. The #82 five and golden retrieval snippets are real text; everything else is synthetic or public.
- **Throughput data:** **sanitized synthetic texts.** `profile-v1.json` stores captured token lengths and batch shapes. At run time the worker builds texts deterministically from a fixed seed and a fixed word list so each text hits the target token count under the shipped tokenizer. No private content is shipped for throughput.

### `thresholds.json` (frozen on the conversion host before shipping)

```
parity_min_cosine_vs_r1: 0.99
retrieval_top1_agreement: all 5 queries
collapse_cosine: 0.9999
norm_tolerance: 1e-3                    (set from the R1 norm spread on the conversion host)
determinism_min_cosine: 0.9999
max_length: 8192
throughput_min_ratio_vs_arrival: 2.0
arrival_rate_texts_per_s: <number>      frozen from captured arrival logs
arrival_baseline_kind: "measured" | "estimate"   (estimate = comparable recorded Fatten throughput; labeled capacity estimate, not proof)
client_timeout_s: <number>              from the VDB/memory callers
stability_load_s: 900
canary_interval_s: 60
deadlines_s: {global:7200, preflight:600, load:300, parity:1500, throughput:600, stability:1200, selfcheck:60}
exit_codes: see below
```

### Conversion-host precompute (inside Phase 1)

- Convert original HF weights to F16 IR + tokenizer. Build `corpus\`, `retrieval-v1.json`, `profile-v1.json`.
- Compute **R1** with HF `transformers` CPU **float32**, last-token pooling + L2 normalize, production prompt format, over the corpus. Compute **reference retrieval rankings** from R1. Freeze `thresholds.json`. Write `MANIFEST.sha256.json`.
- Run `qualify.py selfcheck` on the conversion host as a sanity check of the harness itself.

## Harness design

**One command on Wizkid** (from the bundle root):

```
.\venv\Scripts\python.exe qualify.py all --bundle .
```

Subcommands: `selfcheck`, `preflight`, `load`, `parity`, `throughput`, `stability`, `all` (runs them in that order, stopping at the first non-GO). Each writes `reports\<phase>.json`; `all` also writes `reports\report.json`.

**Process model (so a hang or crash is reported, never unbounded):**

- `qualify.py` is the **parent harness**: pure Python + numpy, never imports OpenVINO.
- It spawns `worker.py` as a child per phase (JSON-lines over stdin/stdout). The worker does the compile and inference.
- The parent enforces the **global deadline** and the **per-phase deadlines** from `thresholds.json`. The worker spawns no children. On expiry, crash, or a closed pipe the parent records the event and terminates only the exact worker PID (`Popen.terminate()`, then `Popen.kill()` after a short grace period); no name-based process kill. A `finally` block guarantees no worker is left running.
- A native worker fault or driver-reset exception is a technical failure. A Python traceback, IPC error or other harness exception is exit 30 unless it is a known model compile/inference error. A deadline expiry or silent hang is **inconclusive**.

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | GO: all gates passed |
| 10 | NO-GO: a technical failure (conversion/numerical/performance/stability, incl. worker crash) |
| 20 | ABORT: deadline/hang/timeout, inconclusive |
| 30 | Harness/setup error: bad args, manifest hash mismatch, missing file, selfcheck failed, wrong interpreter |

The failing gate and failure class (`conversion|numerical|performance|stability|harness`) are in the JSON.

**Reports and privacy**

- Reports identify every input by **id + SHA256 of its text**, never the raw text.
- Reports include: versions, device name, driver, VRAM samples, per-gate numbers, thresholds used, and the `MANIFEST.sha256.json` hash.
- The harness verifies the manifest (every file's SHA256) before any phase and records the verification.

**Harness self-check (`qualify.py selfcheck`, model-free, <1 min, run before model qualification)**

Inject planted cases from `selfcheck_cases.json` into the detector; each must be flagged exactly as expected, and the clean cases must pass:

- wrong-dimension vector, NaN vector, Inf vector, zero-norm vector → each flagged;
- two different texts with **byte-identical** vectors → hard fail A;
- a pair that the planted reference keeps distinct but the candidate collapses (cosine ≥ 0.9999) → hard fail B;
- a legitimate near-duplicate pair that the reference also keeps at ≥ 0.9999 → **not** flagged;
- a healthy set → passes;
- a deliberate worker hang (a worker mode that sleeps) → parent kills it within its deadline and returns exit 20;
- a deliberate worker crash → exit 10 path.

Any mismatch = exit 30 and no model qualification runs.

## Phase 0 — Preflight on Wizkid (10 min)

Done by hand before the bundle exists (the harness is not on Wizkid yet); captured in `preflight-manual.json`.

- Access OK; staging is `\\Wizkid\f\DEV\openvino-qual`, executed locally as `F:\DEV\openvino-qual` (or another approved non-system drive). OS, Arc driver version (`Get-CimInstance Win32_VideoController`), CPU, RAM, free disk.
- **Disk: Wizkid needs runtime ~300 MB + IR ~8 GB + reports, so >=12 GB free.**
- **Conversion host:** default **Wizkid ONLY if free disk >=35 GB** (HF weights + cache + IR + temp) and RAM suffices. Otherwise an explicitly approved host and window is required; **never assume a non-production host exists.** The GGUF is not copied. Badkid chat must not be impacted.
- Music workload: what runs, idle vs active VRAM, qualification window with the music app closed or idle.
- No oneAPI/OVMS/Docker.

**GATE 0:** access OK, >=12 GB free, a conversion host with >=35 GB free permitted, window agreed. Else **ABORT (inconclusive)**, no technical judgment.

## Phase 1 — Build the bundle on the conversion host (35 min)

- Isolated venv; pin versions in `requirements-lock.txt` and download the offline `wheels\` with SHA256s.
- Download **original HF weights** (`Qwen/Qwen3-Embedding-4B`, not GGUF); record revision and SHA256 of every file.
- Convert to F16 IR (flags confirmed against the pinned optimum-intel):

```
optimum-cli export openvino --model Qwen/Qwen3-Embedding-4B --task feature-extraction --weight-format fp16 <out>\model
```

- Convert the tokenizer with `openvino-tokenizers`; confirm special-token/EOS handling matches the HF tokenizer.
- CPU smoke on 3 strings: dim 2560, finite, nonzero.
- Build the corpus, labels, profile; compute R1 and reference rankings; freeze `thresholds.json`; write the manifest; run `selfcheck`.

**Fail class: conversion.** **GATE 1:** bundle complete, hashes written, CPU smoke OK, selfcheck passes. **Conversion fails: STOP = NO-GO.** **Box exceeded (including slow download): STOP = ABORT**, not a technical NO-GO. No other model or runtime.

## Phase 2 — Transfer, verify, load (10 min)

- Copy the bundle to Wizkid (a transient copy retry is allowed). Create `venv` from `wheels\` offline.
- `qualify.py selfcheck`, then `preflight` (manifest verification, `openvino.Core().available_devices` lists `GPU`, device name, driver), then `load` (compile at F16 on GPU, compile time, VRAM after load).

**GATE 2:** manifest matches, selfcheck passes, GPU listed, compiles at F16 with VRAM headroom. Hard failure (no GPU, compile error, OOM) = NO-GO; selfcheck/manifest failure = harness error (30); box exceeded = ABORT.

## Phase 3 — Parity (25 min): `qualify.py parity`

Corpus (`parity-v1.jsonl`, **24–32 items**, frozen): the five #82 inputs; long inputs near 8192 plus one over-length (truncation must be explicit); DE/EN multilingual, short, whitespace-heavy, code; one empty-after-trim (expected explicit error); **retrieval: 5 queries × (1 target + 4 distractors)**.

Pass criteria, all from `thresholds.json`, machine-evaluated against the precomputed R1 (the CPU reference is **not** run on Wizkid):

- Every vector: dim 2560, finite, norm > 0, normalized within `norm_tolerance`.
- **Parity:** cosine vs R1 >= 0.99 for **every** item; retrieval **top-1 agrees with the R1 ranking for all 5 queries**. Below either = NO-GO.
- **Duplicates without false positives:** hard fail A = different texts with byte-identical vectors; hard fail B = a pair R1 keeps distinct (cosine < 0.9999) that OpenVINO collapses (>= 0.9999). A pair at >= 0.9999 in both R1 and OpenVINO is a legitimate near-duplicate, not corruption.
- #1531 signature (per-item cosine near 0.47, inverted discrimination) = hard fail.
- Determinism: corpus twice and batched vs one-by-one, identical inputs >= 0.9999. Reload check: unload/reload, re-embed the #82 five, compare to the first run. If `r2-llamacpp.json` exists, cosine vs R2 is reported (informational; not a gate).

**Fail class: numerical.** **GATE 3:** all pass. Failure = NO-GO; box exceeded = ABORT.

## Phase 4 — Throughput (10 min): `qualify.py throughput`

- Replay the `profile-v1.json` shapes with synthetic seeded texts on the Wizkid GPU only. Record tokens/s, texts/s, p50/p95/p99, peak VRAM, errors.
- **Pass:** sustained texts/s **>= 2.0 ×** `arrival_rate_texts_per_s` **and** p95 request latency < `client_timeout_s`.
- The arrival number is frozen on the conversion host from existing arrival logs. If those logs do not exist, use comparable recorded Fatten throughput and label the result a **capacity estimate, not proof**. If neither exists, Phase 1 is incomplete and ABORTS before shipping; do not invent a baseline. Wizkid never contacts Fatten.
- A full historical backfill is an estimate only, not part of the criterion.

**Fail class: performance.** **GATE 4:** pass. **Correct but slow = STOP = NO-GO.** Box exceeded = ABORT. No tuning.

## Phase 5 — Stability (20 min total, including 15 min of load): `qualify.py stability`

- 15 minutes (`stability_load_s: 900`) of the Phase 4 shapes. **Canaries** every 60 s: the #82 five and five fixed benign corpus items, compared to the Phase 3 vectors (cosine >= `parity_min_cosine_vs_r1`; hard fail A/B on the canary set; non-finite).
- One stress step: a single long request (near `max_length`, large batch) held like a queued request, then canaries immediately.
- Capture Windows display-driver/TDR events for the window (`Get-WinEvent`). A natural GPU reset is a hard fail and a finding; do not induce one.
- Record whether Wizkid was quiescent (music app closed). VRAM churn from other apps is the #1531 trigger.

**Fail class: stability.** **GATE 5:** zero canary failures, no TDR events, stable VRAM. Failure or crash = NO-GO; deadline/hang = ABORT.

**A pass means "no failure observed in a 15-minute run." It is NOT a reliability claim.**

## Phase 6 — Decision report (10 min)

`reports\report.json` plus a short `openvino-qual-report.md` written by hand from it: gates 0–5 with numbers, status (GO / NO-GO / ABORT), the failing class, pinned versions and hashes, driver, host state, unknowns, and what a pass does NOT prove. Phase boxes sum to 120 min (10 + 35 + 10 + 25 + 10 + 20 + 10).

## Phase 7 — ONLY after GO and David's approval: sidecar + E2E (<=45 min, separate)

- Python sidecar on Wizkid using the same pinned runtime (no Rust).
- `POST /v1/embeddings` (OpenAI-compatible: `{model, input: string|string[]}` → `{data:[{index, embedding, object}], model, usage}`); strict validation, 400 on empty/oversized input, no silent truncation.
- `GET /health`: model loaded, device name, dim, uptime, last canary result.
- Bearer-token authentication from a secret file (no token in the repo); bind to the LAN IP. Single worker, bounded queue, 429 when full.
- **Canary mandatory:** the fixed #82 inputs are embedded at start and periodically and compared to the stored reference vectors; a failure fails `/health` and the sidecar refuses to serve.
- Configure the nTeligence provider against Wizkid, run the admin Test, then David's explicit E2E. No production collection is written.

## Rollback and cleanup

Nothing on Fatten/Badkid/production changes, so rollback = delete.

- Wizkid: stop any sidecar/process, remove any task or firewall rule, delete the bundle directory after copying `reports\` out.
- Conversion host: delete the conversion venv and HF cache. Keep `MANIFEST.sha256.json`, `thresholds.json` and the reports.

## Non-goals

- No runtime matrix, no quantization, no llama.cpp debugging, no wrapper rewrite.
- No Fatten change, no automatic provider switch, no historical reindex, no vector-space mixing.
- No claim about the historical cause of stored-vector corruption.
- No soak longer than the 15-minute load.
- No actual implementation in this document; the harness is a design.

## Concerns for review

1. A 15-minute pass cannot detect a rare or slow state-dependent failure (#1531, #27634 class). The sidecar canary is the real defense.
2. The music PC's workload may cause VRAM churn. A dedicated embedding host may be needed before production use; this is a Phase 7 decision.
3. OpenVINO vectors may not be interchangeable with llama.cpp vectors. A cutover would then need a full re-embed, outside this plan.
4. A wrong tokenizer/EOS conversion still yields finite 2560-dim vectors; the frozen R1 is the only guard.
5. **Budget risk:** Phase 1 holds download + conversion + R1 (float32 4B on CPU, including two ~8192-token items) + bundle build in 35 min. R1 cost is unmeasured. If it overruns, the result is ABORT (inconclusive), not NO-GO. Dropping the second long item is the only allowed reduction, decided before freezing the corpus.
6. The frozen thresholds (0.99, 2×, 0.9999) are set before the run and are not adjusted afterward.
7. Unmeasured: VRAM at 8192 tokens × batch, arrival-log availability, Wizkid disk/RAM. Phase 0 stops the plan if the conversion host cannot be identified.
8. A selfcheck-verified detector proves the detector, not the model; the R1 comparison remains the correctness evidence.
