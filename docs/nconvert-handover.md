# nConvert — current state

**As of 2026-11-09 · engine 0.10.2 · everything below is committed and pushed**
(`herrbasan/nConvert` `b7f16d3`, `herrbasan/mcp_server` `01023d7`).

Ingest makes **no provider calls** in its default configuration: born-digital PDFs are
read from glyph geometry, scans by two ONNX models on the CPU, structure by the local
VLM, summaries by the local VLM. Cloud is opt-in, one target at a time.

Superseded session narratives live in git history; the durable decisions, numbers and
traps are consolidated here.

## Verify first (2 minutes)

```bash
npm run test:nconvert        # 84 Rust tests + 7 JS suites + 79-file Tika corpus
node nConvert/napi/setup.js  # rebuild + stage the addon (see the EBUSY trap)
```

Then over MCP: `nconvert.capabilities` should show `nconvert 0.10.2`,
`deep.ocr: true`, `deep.visionFallbackModels: []`, `summary.models: ["badkid-llama-chat"]`.
`nconvert.items` reports the registry size, not the page size (fixed 2026-11-09).

## Three reading paths

| input | reader | cost | measured |
|---|---|---|---|
| born-digital PDF | PDFium glyphs → `pdf_layout` geometry | CPU, no model | 353 pages, 4 s, 265 headings, 41 tables, 0 provider calls |
| scan (page carries its own image) | PP-DocLayout v2 + PP-OCRv6 (`src/ocr.rs`, `ort`) | ~1.2 s/page, zero VRAM | DKV certificate: 18/18 facts, both tax tables, `325,50 EUR` |
| ambiguity | local VLM, advisory | ~3.1 s/page, GPU | only where OCR + geometry cannot decide |

Scan detection is a measurement, not a guess: a page whose assets include
`page-NNN-img-*` never had a text layer of its own — the embedded one is an older OCR
of the same pixels and is discarded by policy.

## Architecture

```
src/server.js                 HTTP + MCP (compact + SSE) + REST/SSE for the queue
src/agent-loader.js           loads every src/agents/<name>/ with a config.json
src/agents/nconvert/
  index.js                    tools, deep pipeline, artefact assembly, reuse
  queue.js                    bounded lanes, step model, restart-safe FIFO (data/nconvert/jobs.json)
  native-process-pool.js      persistent worker processes (16), one task each
  native-worker.js            runs convert | render | ocr in a worker
nConvert/                     Rust core (git submodule)
  src/convert.rs              dispatch, options, limits, envelope
  src/pdf_layout.rs           measured structure from glyph geometry (no model)
  src/ocr.rs                  scan path: regions + text over ort (CPU)
  src/render.rs               PDFium rasterization + text search (page coordinates)
  src/emit.rs                 the single MD-Blocks emitter
nConvert/napi/src/lib.rs      AsyncTasks: convert, renderPages, searchText, ocrPage
```

Models live **outside the repo** under the storage root: `models/ocr/`
(`pp_doc_layoutv2.onnx` 204 MB, `PP-OCRv6_det_small.onnx` 9.5 MB,
`PP-OCRv6_rec_small.onnx` 20.3 MB, `ch_ppocr_mobile_v2.0_cls_mobile.onnx` 0.6 MB —
the classifier is staged but not wired).

## Decisions (date · decision · reason)

- **2026-11-07 · P0 — the coverage guard is a diagnostic, not a gate.** A chunk that
  measures low ships as the model read it, with the gap recorded. The old gate threw
  away a page the model had already read and still reported `coverage: 100%`.
- **2026-11-07 · P1 — born-digital structure is measured, not guessed.** PDFium glyph
  boxes → lines, blocks, columns, headings, tables. No model, no provider call.
- **2026-11-09 · P2/M5 — scans are read locally.** PP-DocLayout v2 for regions,
  PP-OCRv6 for text, both ONNX on the CPU, assembled into structure: tables rebuilt by
  row/column clustering, two-line headers merged, page numbers and decorative images
  dropped, orphan lines appended — **no text is ever dropped**.
- **2026-11-08 · one vision target, no chain.** The retry used to rotate providers, so a
  coverage miss on a ~5 s local chunk became a ~50 s cloud reasoning call that sometimes
  returned nothing. `visionFallbackModels: []`, default local.
- **2026-11-08 · thinking off for perception and summaries** (`reasoningEffort: 'none'`).
  `enableThinking: false` alone does **not** reach a model whose Gateway config pins
  `reasoning_effort` — effort outranks the boolean.
- **2026-11-08 · summaries on the local model.** Measured 3.4 s vs 4.0 s cloud on the
  353-page handbook, with longer, better-structured output; the cloud path also stopped
  truncating mid-word once effort was off.
- **2026-11-09 · `nconvert.summarize` exists.** `regenerateSummary()` had been exported
  and documented since the layered item landed but nothing called it — a documented
  capability with no entrance. Now a tool.
- **2026-11-09 · the compiler is the dead-code signal.** Six warnings removed, zero
  remain; no unreferenced `pub` items; no unused imports; every declared tool has a
  handler.

## Traps that cost hours (do not re-learn)

- **`ort` is a release candidate.** Pin `2.0.0-rc.15` and `ndarray 0.17` (ort pins
  ndarray; mixing versions produces a type error that reads like a bug in your own
  code). Environment: `let env = ort::init().build()?;` then `Session::builder(&env)`.
- **PP-OCRv6's dictionary is one class short.** The rec model's ONNX metadata key
  `character` holds 18 708 entries but the model emits 18 710 classes: 0 is the CTC
  blank and PaddleOCR appends the space class at runtime. Map `idx-1` and treat
  out-of-range as `" "` — otherwise every line comes out with its spaces stripped.
- **PP-DocLayout v2 stretches to 800×800** (no letterbox) and takes
  `scale_factor = [800/h, 800/w]` per axis. Getting this wrong squashes x only, which
  reads as a model bug.
- **DB unclip is closed-form for rectangles:** `d = area * ratio / perimeter`, then
  expand the box by `d`. A hand-rolled padding guess turned small print into noise; this
  one line took the same page from unusable to 18/18.
- **Staging a rebuilt addon while the server runs fails with `EBUSY`.** `napi/setup.js`
  copies a version-stamped file first, so bump the version and the new binary lands
  beside the locked one (the loader picks newest by mtime).
- **PowerShell 5.1 writes a BOM** with `Set-Content -Encoding utf8`, which breaks the
  engine's `JSON.parse` of its own package.json. Write manifests with
  `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`.
- **llama.cpp prompt caching is all-or-nothing here.** Identical prompt → 0.8 s first
  token; change one character of text or one image → full ~6 s re-prefill (`max_tokens`
  is irrelevant). Per-chunk latency variance is cache state, not degradation.
- **PDFium is process-parallel, not thread-parallel.** `pdfium-render` serializes per
  process, so rendering fans out across the persistent pool.

## Contracts the artefact keeps

- `derived-by: ocr | model | measured` in the frontmatter; OCR chunks report
  `coverage: null` because there is no layer to measure against — the reading *is* the
  measurement.
- `document.mechanical.md` is always written beside a deep result (never-destroy).
- Every absorbed variance is a warning with a code; unknown or corrupt input fails with a
  diagnosis instead of degrading.
- Content-addressed reuse: an identical submit returns the existing item and spends no
  compute. Engine version or settings change invalidates it deliberately.
- The step list tells the truth: a step this run does not need closes with a reason
  ("not needed — pages read by OCR"), never stays `pending`.

## State

- Corpus on disk: **74 items, 931 MB**.
- Tests: 84 Rust unit + 1 OCR acceptance (`nConvert/tests/ocr_scan.rs`, skips without the
  weights) + 7 JS suites + 79-file Tika corpus (39 converted, 40 correctly refused, 0
  failures).
- Repo clean and pushed. The `nDB` submodule is detached at `v1.5.0-5-g37813f8` —
  pre-existing, invisible to VS Code's behind/ahead indicator.

## What is left, ranked

1. **Conditional vision** — born-digital `deep` runs still spend ~3 s of GPU per page on
   structure the layout pass already measured. Biggest remaining lever; it changes what
   `deep` means, so it is David's call.
2. **Model provisioning** — the 235 MB of weights are not in the repo; a new machine
   cannot do scans without a fetch script (mirror `napi/fetch-pdfium.js`).
3. **Quantise PP-DocLayout v2** — 204 MB of the 235; an hour of work, likely 4× smaller.
4. **Running headers repeat on multi-page scans** — kept deliberately (dropping them
   lost real text on the DKV page); the fix is cross-page repetition detection.
5. **Rotated pages** — the 0.6 MB angle classifier is staged, not wired.
6. **Tiny italic footnotes** — a few character errors in Rust where the Python reference
   (RapidOCR) is exact; rec preprocessing tuning.
7. **Standalone raster input** still returns `needs_ocr`; the OCR path is wired for PDF
   scan pages only.

## See also

- `documentation/tools/nconvert.md` — operator reference (tools, artefact, paths).
- `docs/m5-ocr-plan.md` — the scan-path evidence and pipeline detail.
- `nConvert/AGENTS.md` — the module's own architecture map.
- `nConvert/docs/SPEC.md` — spec of record (v2.5). It predates the M5 scan path;
  this handover and `docs/m5-ocr-plan.md` are current for that.
