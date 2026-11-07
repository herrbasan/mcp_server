# nConvert — reassessment and rebuild plan (2026-11-07)

Written by the agent that built the current deep path, after that path failed in
production. Intended reader: the model that executes this. David has not chosen
between the phases — read §7 before writing code.

---

## 1. Goal (unchanged, David's words)

An ingest service that handles a large variety of document types and formats and
makes their contents machine readable, **retaining every fact at the lowest
compute cost that achieves it**. Accuracy over speed; take compute savings where
they exist. Explicitly: *"be clear about the confidence of the extracted
information."*

## 2. What exists today (measured, not estimated)

| Part | Size | State |
|---|---|---|
| Rust engine `nConvert/` | 8 745 lines, 19 files | 80 tests pass; 81-file Apache Tika corpus: 39 converted / 40 correctly refused / 0 failures |
| — format parsers (docx 1432, pptx 1121, odf 974, doc 732, epub 669, xlsx 451, ooxml 440, mail 238, text/csv/emit/ir ~1 200) | ~6 500 lines | work, tested against real files |
| — `pdf.rs` | 317 lines | text only, **no coordinates** |
| — `pdf_images.rs` / `render.rs` | 343 / 318 lines | embedded-image extraction, PDFium page rasterization |
| Host agent `src/agents/nconvert/` | 1 829 lines (index 1389, queue 291, pool 104, worker 45) | queue, artefact layout, manifest, `items`/`fetch`, sha256 reuse: all sound |
| — of which `deepConvert` + coverage guard + retry + rejected layer + verification | ~300 lines | **the broken part** |

Working, worth preserving: byte detection, the layered artefact (`document.md`,
`document.mechanical.md`, `assets/`, `pages/`, `original`, `item.json`), the
ingest queue with step progress and restart safety, content-addressed reuse,
`nconvert.fetch` progressive disclosure.

## 3. Why the deep path is wrong — the inversion

The deep path renders every PDF page to PNG and asks a chat model to **retype the
page's text as Markdown**, with the mechanically extracted text labelled
"authoritative". Then, because retyping cannot be trusted, it:

1. measures text coverage and rejects chunks below 98 % (`textCoverage`),
2. measures figure coverage (`factCoverage`, added 2026-11-07),
3. retries once with the missing words listed back (`deepConvert` retry loop),
4. keeps the rejected candidate (`rejected/`), and
5. has a second model audit the result (`verifyItem`, `kimi-k31-chat`).

Five mechanisms, all compensating for one modelling error: **for most documents
the structure is already in the file, and we ask a model to guess it from a
picture instead of measuring it.**

Consequences observed in one morning (2026-11-07):

- A born-digital 200-page PDF took **>19 minutes for 20 of 25 chunks**; many
  chunks retried with *zero* words missing (figure-driven), doubling the work.
- A one-page scan produced, across four runs: correct structure at 97.7 %;
  nothing at all twice (Gateway `ZERO_CONTENT`); and once a fully refuted result
  that shipped the OCR layer instead.
- The best reading of that scan (correct table, all amounts) came from a model
  reading the **image**, not from the text layer — the layer had lost
  `325,50 EUR`, which the model recovered and arithmetic confirmed
  (2.884,27 + 325,50 + 1.179,00 + 651,00 = 5.039,77, the printed total).

## 4. Root cause, in one line

**The engine never learned geometry.** `pdf.rs` uses `pdf-extract`, which returns
plain text without coordinates. Everything in §3 exists to reconstruct, by
guesswork, information PDFium can hand over exactly: per-glyph position, font
size, line and block grouping, table rules.

## 5. Target design — measure first, model last

Three sources of truth, applied in order, each page labelled with how it was
derived:

**Tier 1 — declared structure (no model, no OCR).** For every format that carries
its own structure: DOCX/PPTX/XLSX/ODF/EPUB/mail already work. For **born-digital
PDF**, extract positioned text from PDFium (`FPDFText_*`: char boxes, font size,
rotation) and build:
- lines (y-clustering within tolerance), blocks (line spacing + x-overlap),
- headings (font size/bold relative to body mode, numbering patterns),
- columns (x-cluster separation across blocks; respect multi-column reading order),
- tables (ruling lines from the content stream, plus aligned-cell fallback),
- figures (image placements from `pdf_images`), in reading order.
Output: MD-Blocks Markdown. Deterministic, fast, no network.

**Tier 2 — OCR (cheap, only for pages with no usable text layer).** Detect a page
whose text layer is absent or damage-heavy (this is the M5 milestone). Run an OCR
provider that returns **text plus boxes**, then feed the *same* Tier-1 layout
logic. Provider is pluggable (spec §11 D1); hosted OCR models or a CPU engine.

**Tier 3 — model, advisory only.** Only for what geometry and OCR cannot decide:
ambiguous columns, figure semantics, captions, handwriting. The model returns
**structure hints anchored to the real text** (e.g. "the block starting
`In Rechnung gestellt` and ending `Beitrag*` is a table with 4 columns and 7
rows"), never retyped text. The host slices the authoritative text by those
anchors — so text fidelity is by construction, not by verification.

If Tier 3 is used, it must be cheap by default (`deepseek-flash-chat`, local
`badkid-llama-chat` where available) and must never be gated behind a
transcription that can be dropped.

## 6. What to delete, keep, add

**Delete (the compensation stack, ~300 lines in `src/agents/nconvert/index.js`):**
- the verbatim-retype `chunkPrompt` and `requestVision` transcription loop,
- the corrective retry loop and `deep-retry-failed` handling,
- `textCoverage` / `factCoverage` as **gates**; keep the functions, if at all, as
  diagnostics in the report,
- `deep-untrusted-text-layer` acceptance path (no longer needed — nothing is
  retyped, so nothing can be "untrusted" in that sense).

**Keep:** detection (Rust), all format parsers, artefact layout, queue, reuse,
`fetch`, `items`, summary generation, and the audit as an **on-demand diagnostic**
(`nconvert.verify`) — it is genuinely useful, but it must describe a trustworthy
pipeline, not compensate for an untrustworthy one.

**Add:**
1. `nConvert/src/pdf_layout.rs` (or an extension of `pdf.rs`): positioned-text
   extraction via PDFium + the Tier-1 layout pass. Estimated 400–700 Rust lines.
2. A per-page `derived_by` field in `item.json` / document frontmatter:
   `measured | ocr | model`, plus the reason, so confidence is factual.
3. M5 OCR path (Tier 2), reading the render, returning text + boxes.

## 7. Phasing and acceptance criteria

**P0 — stop the bleeding (do not delete yet).**
Turn the guards off as gates: a chunk that fails coverage ships as-is with a
warning instead of being replaced by mechanical text, and no retries run.
`agents.nconvert.coverageRetry: false` does part of this today. Acceptance: a
deep run never loses a page it already had.

**P1 — geometry for born-digital PDF.** Tier 1 above, no model calls.
Acceptance, measured on `H:\Ingest_TestFiles\GSB_11_Anwendungshandbuch_11.2.4.pdf`
(~200 pages): correct heading hierarchy, tables with correct cell ownership, two
or more columns preserved in reading order, figures in order, **zero provider
calls**, and total wall time < 60 s.

**P2 — scans.** For `H:\Ingest_TestFiles\DKV_Bescheinigung für FA 2022.pdf`:
page text from OCR, table cells correct, and the amount `325,50 EUR` present
(it exists on the page; the current text layer lost it).

**P3 — advisory model.** Only for pages P1/P2 flag as ambiguous. Acceptance: the
model's output is a hint list, never document text; `document.md` is assembled
by the host.

**P4 — confidence reporting.** `nconvert.verify` runs on demand, and every item
states per page how its structure was derived. Acceptance: a reader can tell a
measured page from a guessed one without opening the PDF.

David decides the order; P0 and P1 are the intended minimum.

## 8. Traps recorded today (do not re-learn)

- **`max_tokens` below the model's reasoning length returns nothing, silently.**
  Measured: 800 and 8 000 both produced "streamed reasoning but never produced an
  answer" (`ZERO_CONTENT`) for `deepseek-flash-chat` and `minimax-m31-flash-chat`
  on a page-length prompt; 32 000 answered the same request correctly. The cap is
  a ceiling, not a reservation — billing is on output. Now
  `agents.nconvert.visionMaxTokens` (default 32 000).
- **`outputTokens: 0` in the Gateway log means "no text tokens"**, not "no tokens
  spent" — reasoning consumed the cap. Do not infer causation from that field.
- **The Gateway's own `vision` task routes to `badkid-llama-chat` with
  `kimi-k3-chat` fallback** — that is why vision "works in chat" while nConvert,
  which pins an explicit model, hit the failing pair.
- **Local model speeds** (one page, real prompt): `badkid-llama-chat` 4–5 s,
  `gemini-flash-chat` 8 s, `claude-haiku-chat` 9 s, `deepseek-flash-chat` 49 s,
  `minimax-m31-flash-chat` 55 s. The local model produced the most complete table
  (17 rows) and corrected OCR errors; sample of one page, treat as indicative.
- **Never trust the retired claim that mechanical text is authoritative on a
  scan** — a scan's layer is an older OCR of the same pixels and can be *less*
  complete than a model reading the image.
- Tests that hardcode model ids rot within hours. Derive expectations from
  `nconvert.capabilities`, as the current deep tests do.

## 9. State of the working tree when this was written

- Uncommitted on `main`: `src/agents/nconvert/{index,queue,config}.js(on)`,
  `src/server.js`, `config.json`, `documentation/tools/nconvert.md`,
  `docs/nconvert-handover.md`, `tests/nconvert-agent-smoke.mjs`,
  and two new tests (`nconvert-deep-retry-test.mjs`,
  `nconvert-facts-reuse-test.mjs`).
- `config.json` currently sets `visionModel: badkid-llama-chat`,
  fallbacks `[deepseek-flash-chat, minimax-m31-flash-chat]`,
  `visionMaxTokens: 32000` — provisional, chosen for measurement.
- A killed in-process deep run may have left a `running` job in
  `data/nconvert/jobs.json`; it will be re-queued on the next server start —
  remove that record before restarting.
- The MCP server must be restarted by David only (it serves other projects).

## 10. Open questions for David

1. Phase order: P0+P1 only, or straight to P2 (scans) as well?
2. OCR provider for Tier 2: gateway vision models, or a CPU engine (Tesseract)?
3. Do we keep `document.mechanical.md` once Tier 1 is measured rather than
   guessed? (Proposed: keep — it is the provenance of a mechanical pass.)
4. The audit (`nconvert.verify`) costs one large-model call per document. On
   demand only, or after every deep ingest?
