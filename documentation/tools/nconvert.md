# nConvert — Universal Document Ingest

One engine turns any document into a **layered artefact** in a fixed store:
`storage/ingest/`. Rust core (`nConvert/` at the repo root, nDB pattern:
workspace + napi bindings, own repo at spin-out), thin JS agent
(`src/agents/nconvert/`). Spec of record: `nConvert/docs/SPEC.md`.

## Tools

| Method | Args | What it does |
|---|---|---|
| `nconvert.convert` | `{ path*, depth?, assets?, keepOriginal?, ocr?, name? }` | Ingests one file into an artefact under `storage/ingest/`. `depth: "deep"` (PDF) renders every page and has a vision model reconstruct structure. |
| `nconvert.capabilities` | `{}` | Format matrix, limits, converter version, deep status. |
| `nconvert.items` | `{ limit? }` | The artefact registry, newest first — id, source, format, depth, layers carried. |
| `nconvert.fetch` | `{ item*, layer?, section?, page?, asset?, maxChars? }` | Read one layer: `summary` · `document` · `mechanical` · `verification` · `rejected` (legacy items only) · `page` · `asset` · `original`. |

## The artefact is a layered object (spec §2.6)

*Nothing lost — layers added for discovery.* A reader answers from the cheapest
sufficient layer and digs only when it must:

| Layer | File | Use |
|---|---|---|
| **L0** | `summary.md` | what this is, who for, what it covers — feeds the registry and embeddings |
| **L1** | `document.md` | structured text; sections addressable via `nconvert.fetch { section: N }` |
| **L1b** | `document.mechanical.md` | deterministic conversion (deep only) — comparison and fallback |
| **L1c** | `rejected/chunk-N-M.md` | **legacy only** — items ingested before 2026-11-07 carry the reconstruction the old coverage guard refused. The guard is a diagnostic now; nothing new is refused |
| **L2** | `assets/`, `pages/` | extracted images, rasterized pages — visual understanding |
| **L3** | `original.<ext>` | byte-exact source, last resort |
| **index** | `item.json` | manifest: `sha256`, provenance, lineage, layer inventory, stats, warnings, privacy |

- **Sufficiency:** re-summarise, re-chunk or re-embed from the artefact alone — the
  original is never needed twice.
- **Reachability:** the `assets/…` and `pages/…` references inside `document.md` are
  served by `nconvert.fetch`, so no layer is mentioned but unreachable.
- **Discovery:** `nconvert.items` lists; VDB indexes the store for semantic search;
  `nconvert.fetch` returns the layer a hit points at.
- Summary generation is default-on (`agents.nconvert.summary: false` to skip) and is
  reported in the tool response when unavailable. Provider calls use explicit cloud
  models (`summaryModels`, default DeepSeek Flash then MiniMax M3.1 Flash) and are
  independently bounded by `agents.nconvert.maxSummaryJobs` (default 4).

## The ingest queue (bounded mechanical lane + one deep/large job)

Small mechanical conversions share up to `agents.nconvert.maxConcurrentJobs`
(default 16) scheduled slots. Deep conversions and inputs over ~25 MB
(`agents.nconvert.heavyMb`) are limited by `maxHeavyJobs` (default 1).
Mechanical callers await the scheduled result; deep/large callers receive a job
handle. Submitting the same file twice while queued/running deduplicates to the
same job, including multiple waiting callers.

**Finished ingests are reused, not repeated.** An ingest is a pure function of
(source bytes, engine version, output-affecting settings), so a submit whose
`sha256` and settings match a finished item returns that item instead of
re-running the mechanical pass, the PDFium renders and the vision calls. The
reply states the reuse; `force: true` reconverts. Changing the engine version —
or `visionModel`, `chunkPages`, `pageWidth`, the coverage threshold, `assets`,
`keepOriginal`, `ocr` — changes the key and reconverts, so a settings change is
never silently answered with a stale artefact.

| Surface | Call |
|---|---|
| MCP | `nconvert.enqueue { path, depth?… }` (alias of `nconvert.convert` — same routing), `nconvert.jobs { state?, limit? }`, `nconvert.job { id }`, `nconvert.cancel { id }` |
| REST | `GET /nconvert/jobs`, `GET /nconvert/jobs/:id`, `POST /nconvert/jobs { path, depth?… }`, `POST /nconvert/jobs/:id/cancel` |
| Events | `GET /nconvert/events` — SSE: `queue.snapshot` on connect, then `job.queued` / `job.started` / `job.update` / `job.done` / `job.failed` / `job.cancelled` frames |

Progress is a **step model, not a percentage**: `converting → rendering →
vision i/n (+ coverage) → retry → summarizing`. Jobs survive restarts
(`data/nconvert/jobs.json`; interrupted `running` jobs re-queue). Cancel is
cooperative — queued jobs immediately, running jobs at the next checkpoint
(between steps or page chunks). History retention: newest 200 finished jobs.

## PDF structure is measured, not guessed (Tier 1)

Born-digital PDFs carry their own layout. `depth: "mechanical"` reads it: PDFium
hands over every glyph with its box, font size and weight, and `pdf_layout.rs`
derives lines, blocks, heading levels, column reading order and — by the
aligned-cell fallback, not by drawing inspection — tables. No model, no OCR, no
network. Measured on the 353-page GSB handbook: **~4 s** total, 367 headings,
zero provider calls.

- **Headings** come from numbering first (`1` → H1, `5.1` → H2, `5.1.1` → H3) and
  from the font-size ladder second (largest heading size = H1). A line longer
  than 100 characters is never a heading.
- **Contents pages** are recognised as a whole (two of five lines ending in a
  page number) and their entries stay paragraphs: the leading number there is a
  page reference, not a heading number. Dot leaders collapse to a space — the
  page numbers survive.
- **Running headers and footers** are removed: a line that repeats at the same
  vertical band on 40 % of the pages, differing only in its digits, is furniture.
  A page holding nothing else keeps its lines, so a divider never becomes a
  phantom scan.
- **Reading order** follows columns: full-width blocks (titles, rules) keep their
  place, and the narrow blocks between them are read down one column, then the
  next.
- **Word spaces are measured, not assumed.** Loose bounds already reach the
  advance on this corpus, so intra-word gaps sit at 0.00 em and space gaps at
  0.18–0.26 em; the threshold is 0.10 em (`probe_word_gap_distribution` records
  the histogram).
- **PDFium is required** for this pass. Without `agents.nconvert.pdfiumPath` the
  conversion falls back to flat plain-text extraction and says so with the
  `pdf-layout-unavailable` warning.
- **Known gaps** (next increments): tables whose cells wrap across several lines
  still ship as paragraphs — the aligned-cell fallback only reads one-line rows;
  bullet lists are not yet list blocks; column detection is presence-tested but
  not yet validated on a real multi-column layout.

## Deep conversion (spec §2.5) — structure from the drawing

Mechanical conversion reads what a file *declares*. Technical documents keep much of
their meaning in the drawing: the ASUS corpus manual holds **295,482 vector path
segments against 23 raster images** — every diagram is Bézier curves in the content
stream, unreachable by any image extractor. `depth: "deep"` recovers that.

**Pipeline:** mechanical pass first (its text is the *content authority* — the model
never retypes the document) → for each `chunkPages` chunk (default 8), PDFium renders
only that chunk at 1240 px → the chunk sends page images + its authoritative text to
the vision model (`visionModel`, default `deepseek-flash-chat`, with
`visionFallbackModels`, default MiniMax M3.1 Flash), which decides only structure →
**text-coverage measurement** (default 98 %, diagnostic only) → assembled MD-Blocks. Pages within a chunk fan out across the native process
pool; rendered PNGs go directly from worker to artefact storage, so parent memory is
bounded by the chunk rather than the whole PDF.

- **Never starve the vision budget.** Measured 2026-11-07: `max_tokens` 800 and
  8000 both returned "streamed reasoning but never produced an answer"
  (`ZERO_CONTENT`) for `deepseek-flash-chat` and `minimax-m31-flash-chat` on a
  page-length prompt, while `32000` answered the identical request correctly
  (DeepSeek even recovered `325,50 EUR` that the text layer had lost). The cap
  must clear the model's *thinking*, not the expected answer — billing is on
  output tokens, so a high ceiling costs nothing extra. Configured as
  `agents.nconvert.visionMaxTokens`; the same failure appears on text-only
  prompts with a small cap, so blame the budget before the model.
- The model **never writes MD-Blocks directives**; it emits
  `[[FIGURE:page-NNN.png|caption]]` markers the agent translates, so untrusted output
  cannot inject syntax.
- **Coverage is measured, not enforced** (P0, 2026-11-07). The guard compares the
  model's reading against the authoritative *vocabulary*: unique words, hyphenation
  joined, running headers excluded, concatenation artifacts reassembled. A chunk
  below the threshold (`coverageThreshold`, default 98 %) now **ships as the model
  read it** with `deep-low-coverage` naming the gap — it is no longer replaced by
  mechanical text. A retry runs only when `coverageRetry` is true (default
  **false**): it doubled work on chunks that had lost nothing, and a dead second
  call used to erase a page that had already been read.
- **Figures are graded, not only words.** Digit runs (`2.884,27`, `11.07.1973`,
  `KV319097290`) are compared with separators normalised away, so a reconstruction
  that keeps every word and drops an amount is visible in the warning. Page numbers
  are excluded as furniture. Measured before the change: **94.7–100 %** figure
  coverage on shipped deep artefacts.
- **Nothing is refused any more.** The old `rejected/` layer held the reconstruction
  the guard discarded; since the chunk itself ships, that layer is only written by
  items ingested before 2026-11-07 (`nconvert.fetch { layer: "rejected" }` fails
  loudly on a new item). `document.mechanical.md` is the comparison beside every
  deep result.
- The document frontmatter states what actually happened: `coverage:` is the mean of
  the measured chunks, `chunks: N/M structured` the share, and `coverage: n/a` only
  when no chunk produced a measurable reading at all (a `deep-chunk-failed` chunk).
  `meta.json` carries `deep.meanCoverage: null` in that case — never a fabricated
  100 %.
- **Never-destroy:** `document.mechanical.md` is always written beside the deep result.
- Coverage or provider failure falls back per chunk — loudly, never silently.
- **Renderer:** PDFium (Chrome's engine), dynamically loaded. `pdfium.dll` (~7 MB)
  fetched by `node nConvert/napi/fetch-pdfium.js`; path in `agents.nconvert.pdfiumPath`.
  PDFium is process-parallel, not thread-parallel: `nativeProcesses` (default 16)
  persistent workers are started lazily, each with its own reusable PDFium binding.

Measured on the corpus: 82 pages, ~210–240 s, 9/11 chunks structured, 99.8 % coverage,
149 headings, 61 figure blocks, 89 table rows — including a specifications table
reconstructed from the drawing that mechanical conversion could only emit as prose.

## Verification — how far to trust a result

The deterministic guard measures what survived. It cannot say *what* is missing
when the evidence itself is damaged, so there is an independent audit
(`nconvert.verify`). It runs **on demand**, not after every ingest: one
large-model call per document is not a routine cost (set
`agents.nconvert.verify: true` to make deep ingests audit themselves):

- a large-context model (`verifyModel`, default `kimi-k31-chat`, fallback
  `deepseek-chat`) reads `document.md` beside the text layer, the mechanical
  document and every refused candidate;
- it reports facts present, facts at risk, internal consistency (do sums and
  periods agree?), and — the part that keeps it honest — **what it could not
  check**, because it never sees the page images;
- the report lands as `verification.md`, the verdict (`confidence:
  high|medium|low`) is recorded in `item.json.verification`, and the layer is
  readable via `nconvert.fetch { layer: "verification" }`.

The audit never alters the document. Its confidence is about *verifiability*, not
document length: a clean text PDF verifies "high"; a scan whose layer is broken
usually cannot exceed "medium", and its report says so.

## Detection and failure philosophy

- Magic bytes are authoritative; the extension breaks ties. Unknown input = hard error
  listing what was probed.
- Live: **txt, csv, tsv, md, json, yaml, toml, xml** (M1), **pdf** (M4) with text,
  embedded images (JPX→PNG, DCT→jpg, flate→PNG) and AES-256/R6 auto-decryption,
  **docx** (M3): styles → headings, `numPr` → nested lists, `gridSpan`/`vMerge` tables
  resolved into a rectangular grid, `word/media/*` → assets, footnotes → GFM, hyperlink
  fields resolved, OMML math flattened to text (warned), page breaks → `***`,
  and **doc** (M6, pulled forward): Word 97-2003 binary via the [MS-DOC] piece
  table (cp1252 + UTF-16 pieces), field results kept, page breaks → `***`,
  photos carved from the CFB `Data` stream (JPEG/PNG); tables/footnotes/headers
  flattened or warned; Word 6/95 and encrypted files refused loudly,
  and **pptx** (M3): one MD-Blocks section per slide (order from sldIdLst via
  rels), title/body placeholders → headings/paragraphs, bullet paragraphs with
  levels → nested lists, DrawingML tables → the span grid, media → assets
  (SVG preferred over PNG fallback), speaker notes → `mb:block preset=narration`;
  charts/SmartArt warned pending,
  and **xlsx** (M3): one section per sheet, first row as header, merged cells
  fill their rectangle from the origin value, dates render ISO (styled serials),
  integral numbers without trailing `.0`, row cap + maxCells, empty sheets
  skipped with a warning, expansion budget pre-charged from the ZIP directory.
  The same calamine path covers **xlsb** and legacy **xls**, and **ods**.
- **odt/odp** (M3): ODF headings, styled spans, lists, repeated/covered table
  cells, Pictures → assets, footnotes; presentations get one section per page,
  title placeholders → H2 and notes → narration. StarOffice 6 accepted;
  encrypted ODF refused loudly.
- **epub** (M3): OPF metadata → frontmatter, spine order → sections, scoped
  XHTML headings/paragraphs/lists/tables/links/images; manifest images → assets.
- **eml/mbox** (M3): `mail-parser` 0.11 handles MIME trees, encoded headers and
  charsets; plain text preferred, HTML-only bodies flattened with warning;
  attachments and inline parts → assets plus an inventory. mbox: section per message.
- Detected-but-pending fail with their milestone: html (M2), images (M5),
  rtf/msg (M6). IDML and iBooks are recognized and refused by name. The Tika
  xlsb fixture trips a calamine BrtBundleSh reader gap and fails loudly rather
  than panicking. DOCX/PPTX charts as data tables: pending.
- Limits (`agents.nconvert`): `maxInputMb` 100, `maxExpandedMb` 500 (ZIP budget,
  enforced per entry and in total), `maxOutputMb` 64, `maxTableRows` 10000 — breaches
  are hard errors.

## Building

The engine is a **git submodule** (`nConvert/`, repo `herrbasan/nConvert`,
MIT). After a fresh clone of this repo:

```
git submodule update --init nConvert   # fetch the engine
node nConvert/napi/fetch-pdfium.js     # renderer DLL (~7 MB, idempotent)
npm run build:nconvert                 # Rust workspace + staged napi binary
npm run test:nconvert                  # 79 core tests + agent smoke + 79-file corpus contract
```

Binaries are staged version-stamped; the loader picks the newest, so a rebuild
never fights a running server. After a server restart, **reconnect clients** — a
session connected before the restart answers "Unknown method" for new tools.

The engine's own tests (`cargo test`, `nConvert/napi/test/bindings.mjs`) live in
the submodule; `tests/nconvert-agent-smoke.mjs` here covers the host wiring.
