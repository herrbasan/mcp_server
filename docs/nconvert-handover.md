# nConvert — current state

**As of 2026-11-11 · engine 0.11.0 runs in `nteligence-server` · NUI UX live-verified**

> **The engine moved (2026-11-11).** Conversion, job records and artefact folders
> now live in `nteligence-server` (`D:\DEV\nTeligence`); mcp_server keeps only the
> MCP/HTTP proxy and the `/nconvert` review surface. The `nConvert/` submodule,
> its N-API build, the ingest queue (`queue.js`) and the native process pool were
> removed from this repo. Everything below about engine internals describes
> nTeligence's `nConvert/`; the proxy and UI sections are what this repo owns.

Ingest makes **no cloud calls** in its default configuration: ordinary born-digital
PDFs are read from glyph geometry without a model, scans by two ONNX models on the
CPU, figure/geometry ambiguity by the local VLM, summaries by the local VLM. Cloud is
opt-in, one target at a time.

Superseded session narratives live in git history; the durable decisions, numbers and
traps are consolidated here.

## Verify first (2 minutes)

```bash
npm run test:nconvert        # proxy smoke + review-UI surface (service must be running)
curl http://127.0.0.1:3300/api/health
```

Then over MCP: `nconvert.capabilities` should show `nconvert 0.11.0`, the format
matrix, `deep.available: false` with its reason, and the `ui` block naming
`/nconvert`, the upload route, `/nconvert/events` and the `/files` proxy.
Engine tests and corpus runs belong to nTeligence (`cargo test -p nconvert`,
`nConvert/napi/setup.js`).
`nconvert.items` reports the registry size, not the page size (fixed 2026-11-09).

## Three reading paths

| input | reader | cost | measured |
|---|---|---|---|
| born-digital PDF | PDFium glyphs → `pdf_layout` geometry; VLM only for figures/ambiguity | CPU by default, no model on measured chunks | 353 pages, 4 s mechanical, 265 headings, 41 tables; 40/353 pages reach the 128-segment vision trigger |
| scan (page carries its own image) | PP-DocLayout v2 + PP-OCRv6 (`src/ocr.rs`, `ort`) | ~1.2 s/page, zero VRAM | DKV certificate: 18/18 facts, both tax tables, `325,50 EUR` |
| ambiguity | local VLM, advisory | ~3.1 s/page, GPU | embedded figures, unavailable geometry, or ≥128 vector path segments |

Scan detection is a measurement, not a guess: a page whose assets include
`page-NNN-img-*` never had a text layer of its own — the embedded one is an older OCR
of the same pixels and is discarded by policy.

## Architecture

mcp_server (this repo) — proxy and review surface only:

```
src/server.js                 MCP (compact + SSE) + REST/SSE for nconvert, proxied
src/agents/nconvert/
  index.js                    tool handlers, service transport, ui/result envelopes
  ui-api.js                   /nconvert page, raw upload, item payload, /files proxy
  ui.html / ui.js / ui.css    source harness, live decisions, NUI result preview
```

nteligence-server (`D:\DEV\nTeligence`) — engine, jobs and artefacts:

```
src/                          axum service: /api/ingest, /api/jobs, /api/items,
                              /api/events, /files; job records; storage ownership
nConvert/src/convert.rs       dispatch, options, limits, envelope
nConvert/src/pdf_layout.rs    measured structure + per-page vector path counts
nConvert/src/ocr.rs           scan path: regions + text over ort (CPU)
nConvert/src/render.rs        PDFium rasterization + text search (page coordinates)
nConvert/src/emit.rs          the single MD-Blocks emitter
nConvert/napi/src/lib.rs      AsyncTasks: convert, renderPages, searchText, ocrPage
```

The service shares the storage root (`D:\MCP_Storage`), so item paths reported by
the engine (`ingest/<id>/…`) mean the same thing to the browser, the MCP tools
and the disk. The engine serves them at `/files`; mcp_server proxies that
namespace so the review UI's links stay same-origin.

Models live **outside the repo** under the storage root: `models/ocr/`
(`pp_doc_layoutv2.onnx` 204 MB, `PP-OCRv6_det_small.onnx` 9.5 MB,
`PP-OCRv6_rec_small.onnx` 20.3 MB, `ch_ppocr_mobile_v2.0_cls_mobile.onnx` 0.6 MB —
the classifier is staged but not wired).

## Decisions (date · decision · reason)

- **2026-11-09 · NUI progress/result surface.** `/nconvert` combines upload/path
  submission, recent jobs, timed steps, route totals and a live decision log with
  NUI-rendered L0/L1 results. Jobs persist sequenced activity; SSE sends one small
  `job.activity` record at a time, while MCP/REST `since` fills gaps after reconnect.
  Every LLM submit returns a `ui` action. Raw uploads stay under the existing input
  cap and are deleted at completion. Browser-verified: text path → summary/result;
  DKV file picker → OCR (72 lines, 16 regions) → tax table; restart preserves both.
- **2026-11-09 · conditional deep vision.** Ordinary born-digital chunks ship
  the measured `pdf_layout` sections directly; only unavailable geometry,
  embedded figures, or ≥128 PDFium vector path segments call the local VLM.
  One ambiguous page escalates its whole chunk and the report names every
  trigger. Measured on GSB: 128 selects 40/353 pages; 64 selects 131 and turns
  ordinary rules/borders into model work. Four-page smoke: 2 vision calls → 1.
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

- `derived-by: ocr | model | measured` in the frontmatter; OCR and measured chunks
  report `coverage: null` because there is no model reading to compare against the
  authoritative layer. Mean coverage is calculated across model-read chunks only.
- `document.mechanical.md` is always written beside a deep result (never-destroy).
- Every absorbed variance is a warning with a code; unknown or corrupt input fails with a
  diagnosis instead of degrading.
- Content-addressed reuse: an identical submit returns the existing item and spends no
  compute. Engine version or settings change invalidates it deliberately.
- The step list tells the truth: a step this run does not need closes with a reason
  ("not needed — pages read by OCR"), never stays `pending`. Steps carry timestamps
  and cumulative durations.
- Activity is append-only and sequenced: `kind` (`decision` / `problem` / `metric` /
  `event`), `code`, `message`, optional pages/step and structured evidence. Job list
  and ordinary SSE updates exclude the full array; `job.activity` carries increments.

## State

- Baseline corpus before UX smoke: **74 items, 931 MB**; `nconvert.items` is the live count.
- Tests: 84 Rust unit + 1 OCR acceptance (`nConvert/tests/ocr_scan.rs`, skips without the
  weights) + 8 JS suites + 79-file Tika corpus (39 converted, 40 correctly refused, 0
  failures).
- Live 0.11.0 smoke: two born-digital pages in 2.2 s, 1/1 measured chunk,
  `model: null`, `pathSegments: 0`, both page sections preserved, zero warnings.
- Live UX smoke: path-based text conversion and file-picker DKV deep upload both
  reach NUI results; OCR logs 72 lines / 16 regions and the table keeps `325,50 EUR`.
  Completed uploads leave `data/nconvert/uploads` empty; a restart retains the full
  decision log and result. `tests/nconvert-ux-test.mjs` covers the backend contracts.
- Repo state is not asserted here; see git status. The `nDB` submodule is detached at `v1.5.0-5-g37813f8` — pre-existing, invisible
  to VS Code's behind/ahead indicator.

## What is left, ranked

1. **Model provisioning** — the 235 MB of weights are not in the repo; a new machine
   cannot do scans without a fetch script (mirror `napi/fetch-pdfium.js`).
2. **Quantise PP-DocLayout v2** — 204 MB of the 235; an hour of work, likely 4× smaller.
3. **Running headers repeat on multi-page scans** — kept deliberately (dropping them
   lost real text on the DKV page); the fix is cross-page repetition detection.
4. **Rotated pages** — the 0.6 MB angle classifier is staged, not wired.
5. **Tiny italic footnotes** — a few character errors in Rust where the Python reference
   (RapidOCR) is exact; rec preprocessing tuning.
6. **Standalone raster input** still returns `needs_ocr`; the OCR path is wired for PDF
   scan pages only.

## See also

- `documentation/tools/nconvert.md` — operator reference (tools, artefact, paths).
- `docs/m5-ocr-plan.md` — the scan-path evidence and pipeline detail.
- `nConvert/AGENTS.md` — the module's own architecture map.
- `nConvert/docs/SPEC.md` — spec of record (v2.7, conditional deep vision).
