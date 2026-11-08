# M5 — scan path: OCR + layout on CPU

**Status:** implemented 2026-11-08 — `nConvert/src/ocr.rs` + the `ocr` native
operation + the scan branch in `deepConvert`. Rust end to end; no Python, no provider
call, no GPU. See "What is left" at the bottom.

## Decision

Scans are read by **two small ONNX models on the CPU**, not by a vision LLM:

1. **PP-DocLayout v2** (via RapidLayout) — regions from pixels: `table`, `paragraph_title`,
   `text`, `header`, `footer`, `aside_text`, `number`.
2. **PP-OCRv6** det + cls + rec (via RapidOCR) — text with per-line boxes and confidence.

The VLM leaves the scan path entirely. It stays available as the P3 advisory for pages
that neither OCR nor geometry can settle.

## Why — measured on the DKV scan

`ingest/20261103_1701_dkvbescheinigung-fr-fa-2022/pages/page-001.png`, the page whose
embedded Acrobat layer lost `325,50 EUR`.

| reader | facts recovered | time | hardware |
|---|---|---|---|
| embedded text layer | 17/18 (`325,50` lost) | free | — |
| VLM `badkid-llama-chat` (Gemma 4 12B) | numbers found, whole rows dropped | 3.1 s/page | GPU |
| Mirage (22 MB VLM) | ~half the lines | 0.83 s/page | CPU |
| **PP-OCRv6** | **18/18** | **2.44 s/page** | CPU |

Regions: PP-DocLayout v2 finds **both** tax tables (0.93 / 0.99) in 731 ms. The
F1-leading alternative, DocLayout-YOLO, found **one** table and labelled most of the page
`abandon` — the independent 20-model / 41-document benchmark's "under-detects on forms"
weakness reproduced on our own document.

End-to-end prototype (Python, CPU only) reconstructed both tables as Markdown: columns
correct, `Zeitraum` rows preserved, `Summe` intact, `Zeile 23–27` and `116,80 EUR` in the
second table.

## Pipeline

```
page image (PDFium render, already exists)
  -> PP-DocLayout v2            regions + reading order      ~0.7 s
  -> PP-OCRv6 det/cls/rec       lines + boxes + confidence   ~2.4 s
  -> words assigned to regions  (centre-in-box)
  -> geometry pass              the SAME code born-digital uses:
                                rows by y-cluster, columns by x-cluster,
                                headings from paragraph_title, headers/footers dropped
  -> MD-Blocks document.md  +  document.mechanical.md (unchanged role)
```

Cost: **~3.2 s per page, CPU only, zero VRAM.** Parallelisable through the existing
persistent process pool. 353 pages ≈ 19 minutes of a CPU box and no GPU at all, versus
~18 minutes of GPU for the current VLM path.

## Integration — Rust (decided)

**Rust-first.** A throwaway Rust program (`C:\Users\dave\ocr-rust-spike`, outside the repo)
ran the whole path on the DKV scan:

| stage | model | time |
|---|---|---|
| layout | PP-DocLayout v2 (204 MB) | 309 ms |
| text detection | PP-OCRv6 det small (9.5 MB) | 123 ms |
| recognition | PP-OCRv6 rec small (20.3 MB), 72 lines | 665 ms |
| **total** | **~1.1 s per page, CPU, zero VRAM** | |

**Quality: 18/18 ground truth**, identical to the Python reference. Regions identical too
(both tables, `paragraph_title` at y340, `table` at y482 and y915).

The earlier "1–2 weeks of post-processing swamp" estimate was wrong, and the reason is
worth recording: DB's unclip step is `d = area * ratio / perimeter` followed by a polygon
buffer, and for the axis-aligned rectangles that text lines produce, that buffer is a
closed-form outward expansion — no clipper library needed. Replacing a hand-rolled padding
guess with that one formula moved the output from "footer lines are noise" to 18/18.

Non-obvious details that cost the most time (keep them in the port):

- `ort` is a release candidate: pin `2.0.0-rc.15`, and use `ndarray 0.17` (ort pins it).
- The environment is built with `ort::init().build()?`, then `Session::builder(&env)`.
- PP-OCRv6 rec carries its dictionary in ONNX metadata under `character`
  (newline-separated, 18 708 entries). Its output has 18 710 classes: 0 is the CTC blank,
  and the class list is one wider than the metadata because PaddleOCR appends the space
  class at runtime — map `idx-1` and treat out-of-range as `" "`.
- PP-DocLayout v2 is RT-DETR-shaped: inputs `im_shape`, `image` (**stretched**, not
  letterboxed, to 800×800), `scale_factor` as `[800/h, 800/w]`; outputs `[300, 8]`
  (`cls, score, x0, y0, x1, y1, …`, already in page coordinates) and a count. No NMS.
- Layout classes come from the same `character` metadata (25 entries); index 21 is `table`.

Python (RapidOCR + RapidLayout) stays as the **reference implementation**: it is what the
Rust path is validated against when models or preprocessing change.

## Acceptance criteria (from `nconvert-reassessment-2026-11-07.md` §7 P2)

- DKV certificate: page text from OCR, **table cells correct**, `325,50 EUR` present.
- Klinikum letter: names, dates, addresses and diagnoses read correctly.
- No page loses content that the Acrobat layer had.
- Every page states `derived_by: ocr | measured | model`.
- Zero GPU, zero cloud in the scan path.

## Delete when this lands

The compensation stack around the VLM's unreliability: `chunkPrompt`/`requestVision`
retyping for scan pages, the corrective retry loop, `scanFactThreshold`-era heuristics,
and the `deep-untrusted-text-layer` acceptance path.

## Open items

- Two-line table headers split into two rows — merge rows whose column spans overlap.
- Rotated pages — the OCR bundle ships a 0.6 MB angle classifier; wire it in.
- Multi-column reading order needs a real test document.
- Very large pages may need tiling before detection.
- Larger `PP-OCRv6` server variants exist if small-model accuracy proves insufficient.

## What is left (2026-11-08)

Shipped: the native path, the scan branch, provenance, the acceptance test
(`nConvert/tests/ocr_scan.rs`, skips without the weights), docs, and the full suite green
(84 Rust unit tests + 1 integration, six JS suites).

Still open:

1. **Running headers on multi-page scans** repeat once per page. They are kept
   deliberately (dropping them lost real content on the DKV page); the fix is
   cross-page repetition detection, not a new default.
2. **The angle classifier** (`ch_ppocr_mobile_v2.0_cls_mobile.onnx`, 0.6 MB) is staged
   but not wired — rotated scans are unimplemented, not broken.
3. **Model weights are not in the repo** (235 MB). `models/ocr` under the storage root
   must be provisioned on any new machine; add a fetch script like `fetch-pdfium.js`.
4. **Layout model size** — 204 MB of the 235. Quantising PP-DocLayout v2, or testing a
   smaller variant, is worth an hour before this is deployed widely.
5. **Table columns** are clustered by x-centre; a scan with a very narrow first column
   (the DKV "Zeile 23" cells) can split a column. Not observed as data loss, but worth a
   test document.
6. **`scanFactThreshold`-era heuristics and the vision retry loop** still exist for
   non-scan chunks — they can be deleted only once the conditional-vision decision
   (skip the model when measured geometry exists) is made.
