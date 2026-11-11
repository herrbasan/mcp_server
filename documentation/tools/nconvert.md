# nConvert — Universal Document Ingest

One engine turns any document into a **layered artefact** in a fixed store:
`storage/ingest/`.

**The engine is not in this repo any more.** Conversion, job records and the
artefact folders live in `nteligence-server` (`D:\DEV\nTeligence`); the tools
below are an HTTP proxy to it (`agents.nconvert.serviceUrl`, default
`http://127.0.0.1:3300`). The vendored `nConvert/` submodule, its N-API build,
the ingest queue and the native process pool were removed from `mcp_server` on
2026-11-11 — do not reintroduce them here. Engine spec of record:
`nConvert/docs/SPEC.md`; backend plan: `nTeligence/docs/rust-backend-plan.md`.

Lane status (2026-11-11): **mechanical is live** for every format the engine
supports. `depth: "deep"`, OCR of scans/standalone images, `nconvert.summarize`
(L0) and `nconvert.verify` (audit) are **not implemented in the service yet** and
refuse with a named reason — they never degrade silently to mechanical output.

Engine settings named below (`coverageThreshold`, `chunkPages`,
`visionPathSegments`, `summary`, `verify`, OCR model paths, …) belong to the
engine and live with nTeligence; they are not keys in this repo. `agents.nconvert`
here holds only `serviceUrl`, `folder`, `maxInputMb`, `maxExpandedMb`, `ignore`,
`contextEnhancement` and `watch`.

## Tools

| Method | Args | What it does |
|---|---|---|
| `nconvert.convert` | `{ path*, depth?, assets?, keepOriginal?, ocr?, name?, force? }` | Ingests one file into an artefact under `storage/ingest/`. Mechanical lane only: `depth: "deep"`, `ocr` and other deep-lane arguments are refused with a reason. Identical bytes with the same settings reuse the existing item (`force: true` reconverts). Every submit returns a `ui` action for `/nconvert`. |
| `nconvert.job` | `{ id*, since?, activityLimit? }` | Step timings, result link and error. Structured activity lands with the queued lanes; `since` is accepted and currently returns an empty page. |
| `nconvert.capabilities` | `{}` | Format matrix, limits, converter version, and which lanes are unavailable. |
| `nconvert.items` | `{ limit? }` | The artefact registry, newest first — id, source, format, depth, layers carried. |
| `nconvert.fetch` | `{ item*, layer?, section?, page?, asset?, maxChars? }` | Read one layer: `document` · `mechanical` · `verification` · `page` · `asset` · `original`; `summary` names why L0 is not there yet; `rejected` is refused (deep-lane legacy). |
| `nconvert.summarize` | `{ item* }` | **Not available yet** — returns the refusal naming the missing Gateway client (Pass 2). |
| `nconvert.verify` | `{ item*, model?, force? }` | **Not available yet** — returns the refusal naming the missing audit lane. |

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
- Summary generation is default-on (engine `summary: false` to skip) and is
  reported in the tool response when unavailable. It runs on the **local model**
  (`summaryModels`, default `badkid-llama-chat`) with no fallback chain, so ingest
  makes no cloud calls by default; a cloud model can be named instead,
  one target at a time. Measured 2026-11-08 on the 353-page handbook and a kickoff
  deck: local 3.4 s per summary versus 4.0 s cloud, with longer, better-structured
  output. Provider calls are independently bounded by
  `maxSummaryJobs` (engine, default 4).

## The ingest queue (bounded mechanical lane + one deep/large job)

Small mechanical conversions share up to `maxConcurrentJobs` (engine, default 16)
scheduled slots. Deep conversions and inputs over ~25 MB (`heavyMb`, engine) are
limited by `maxHeavyJobs` (default 1).
Mechanical callers await the scheduled result; deep/large callers receive a job
handle. Submitting the same file twice while queued/running deduplicates to the
same job, including multiple waiting callers.

**Finished ingests are reused, not repeated.** An ingest is a pure function of
(source bytes, engine version, output-affecting settings), so a submit whose
`sha256` and settings match a finished item returns that item instead of
re-running the mechanical pass, the PDFium renders and the vision calls. The
reply states the reuse; `force: true` reconverts. Changing the engine version —
or `visionModel`, `visionPathSegments`, `chunkPages`, `pageWidth`, the coverage threshold, `assets`,
`keepOriginal`, `ocr` — changes the key and reconverts, so a settings change is
never silently answered with a stale artefact.

| Surface | Call |
|---|---|
| MCP | `nconvert.enqueue { path, depth?… }` (alias of `nconvert.convert` — same routing), `nconvert.jobs { state?, limit? }`, `nconvert.job { id, since?, activityLimit? }`, `nconvert.cancel { id }` |
| REST | `GET /nconvert/jobs`, `GET /nconvert/jobs/:id` (`?since=N` for incremental activity), `POST /nconvert/jobs { path, depth?… }`, `POST /nconvert/jobs/:id/cancel` |
| Upload | `POST /nconvert/upload?filename=…&depth=…` with an `application/octet-stream` body; same queue and response shape as path submission |
| Item | `GET /nconvert/items/:id` — manifest, result links, L0 summary and bounded L1 preview |
| Events | `GET /nconvert/events` — SSE: `queue.snapshot` on connect, then `job.queued` / `job.started` / `job.update` / `job.activity` / `job.done` / `job.failed` / `job.cancelled` frames |

Progress is a **step model plus a sequenced activity history**, not just a percentage:
`converting → rendering → ocr/vision i/n (+ coverage) → retry → summarizing`. Steps
carry start/finish timestamps and cumulative durations. Activity records carry
`seq`, `at`, `level`, `kind` (`decision` / `problem` / `metric` / `event`), `code`,
`message`, optional `pages`/`step`, and structured evidence (`data`). Every chunk's
route choice, model completion, warning, summary and audit is therefore visible.
Normal SSE job updates exclude the history; each `job.activity` frame carries one
new record, avoiding quadratic traffic on long documents. Full history survives in
`data/nconvert/jobs.json` and is available through MCP/REST after reconnect.

Jobs survive restarts (interrupted `running` jobs re-queue). Cancel is
cooperative — queued jobs immediately, running jobs at the next checkpoint
(between steps or page chunks). History retention: newest 200 finished jobs.

## NUI progress and result UI

Open **`/nconvert`**. The same NUI surface covers:

- **Source:** drag/drop or file-picker upload, server-path input, mechanical/deep
  options, and recent jobs. Uploads are raw `application/octet-stream`, capped by
  `maxInputMb`, written under `data/nconvert/uploads` and removed at completion.
- **Progress:** timed steps, measured/OCR/vision page totals, provider-call count,
  problems, cancellation, and a filterable live decision log. Jobs and items are
  URL-addressable (`?job=…`, `?item=…`); refresh and SSE reconnect restore state.
- **Result:** L0 summary, NUI-rendered L1 preview, provenance, warnings, statistics,
  and links to document/mechanical/original/manifest/pages/assets. Preview media
  resolve relative to the artefact. Large L1 previews are bounded; the full file is
  one click away.

`nconvert.convert` / `enqueue` return `jobId` where applicable, a structured result,
and `ui: { label, url, mode: "preview" }`. Reused artefacts open the existing item
without spending compute. `nconvert.job` returns the same UI action plus full or
incremental activity. No separate UI tool or frontend framework is involved.

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
- **Tables** are read as grids by the geometry the page already carries: the
  column starts are where the run's lines begin plus the wide gutters most lines
  share, and rows are the lines further apart than the wrapped lines inside a
  cell. Measured on the GSB table: rows sit 21.1 pt apart, wrapped cell lines
  12.9 pt, so the smallest gap × 1.35 separates them. A cell that wraps joins its
  own row and column; a caption (`Tabelle`/`Abbildung`/`Figure` + number) never
  starts or joins a grid.
- **Lists**: bullet and number markers (`•`, `-`, `1.`, `a)`) become list blocks,
  with wrapped lines appended to the item they belong to. A section number
  (`5.1.2 Cache`) is not a list marker.
- **Word spaces are measured, not assumed.** Loose bounds already reach the
  advance on this corpus, so intra-word gaps sit at 0.00 em and space gaps at
  0.18–0.26 em; the threshold is 0.10 em (`probe_word_gap_distribution` records
  the histogram).
- **PDFium is required** for this pass. Without the engine's PDFium installation
  the conversion falls back to flat plain-text extraction and says so with the
  `pdf-layout-unavailable` warning.

## Deep conversion (spec §2.5) — measured first, vision on ambiguity

Mechanical conversion reads what a file *declares*. Born-digital PDFs already declare glyph positions and font metrics, so `pdf_layout` owns ordinary structure. Technical documents can still keep meaning in drawings: the ASUS corpus manual holds **295,482 vector path segments against 23 raster images** — diagrams are Bézier curves in the content stream, unreachable by text extraction alone. `depth: "deep"` preserves page rasters and escalates only the chunks that need visual semantics.

**Pipeline:** mechanical pass first (its text is the *content authority*) → for each `chunkPages` chunk (default 8), PDFium renders only that chunk at 1240 px → the host selects one route:

1. **Scan:** every page carries its own image → local PP-DocLayout v2 + PP-OCRv6 on CPU.
2. **Measured:** no ambiguity trigger → the per-page `pdf_layout` sections ship directly, with no provider call and `derivedBy: "measured"`.
3. **Vision:** any trigger → page images + authoritative text go to `visionModel` (default `badkid-llama-chat`) → text-coverage measurement (default 98 %, diagnostic only) → assembled MD-Blocks. The whole chunk takes this route if one page is ambiguous.

**Vision triggers:** unavailable/inconsistent geometry; an embedded figure; or at least `visionPathSegments` (engine) vector path segments on one page (default **128**; `0` forces vision). PDFium counts segments per page, excluding text and raster images. On the 353-page GSB handbook, the threshold selects 40 pages; 64 would select 131 and incorrectly turn ordinary rules and borders into model work. Each `meta.json` vision chunk records its `triggers` and `pathSegments`.

Pages within a chunk fan out across the engine's worker processes; rendered PNGs go directly from worker to artefact storage, so memory is bounded by the chunk rather than the whole PDF.

- **One vision target, no chain** (2026-11-08). `visionFallbackModels` defaults to
  `[]`: point `visionModel` at the local model *or* at a cloud model — a chain is an
  option, not the default. Production reads pages locally. Reason: the retry rotated
  to the next provider, so one coverage miss on a ~5 s local chunk became a ~50 s
  cloud reasoning call that sometimes returned nothing. A failure now surfaces
  instead of silently hopping providers.
- **Vision calls disable thinking** (`reasoningEffort: 'none'`, `enableThinking:
  false`). Measured 2026-11-08 on one page image at 400 tokens: `deepseek-flash-chat`
  returned **0 chars with all 400 tokens spent on reasoning** at its config effort
  `low`, and **1143 chars** at `none`. Note that `enable_thinking: false` alone does
  not reach it — the Gateway's model config pins `reasoning_effort`, and effort
  outranks the boolean. `minimax-m31-flash-chat` declares no `none` level and cannot
  comply.
- **Never starve the vision budget.** Measured 2026-11-07: `max_tokens` 800 and
  8000 both returned "streamed reasoning but never produced an answer"
  (`ZERO_CONTENT`) for `deepseek-flash-chat` and `minimax-m31-flash-chat` on a
  page-length prompt, while `32000` answered the identical request correctly
  (DeepSeek even recovered `325,50 EUR` that the text layer had lost). With thinking
  off the ceiling is headroom, not a requirement — but a model that cannot switch
  thinking off still needs it to clear its reasoning. Configured as
  `visionMaxTokens` (engine); the same failure appears on text-only
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
  model-read chunks, `chunks: N/M structured` the share across every route, and
  `coverage: n/a` when no chunk had a model reading to compare (measured/OCR runs,
  or failed vision). `meta.json` carries `deep.meanCoverage: null` in that case —
  never a fabricated 100 %.
- **Never-destroy:** `document.mechanical.md` is always written beside the deep result.
- Coverage or provider failure falls back per chunk — loudly, never silently.
- **Renderer:** PDFium (Chrome's engine), dynamically loaded inside the engine's
  convert workers (`nConvert/napi/fetch-pdfium.js` fetches `pdfium.dll`; the path
  lives in nTeligence's `[convert] pdfium`). PDFium is process-parallel, not
  thread-parallel: the service runs one conversion per worker process, each with
  its own reusable binding (`processes` in `nteligence.toml`).

Historical full-vision measurement (before conditional vision): 82 pages, ~210–240 s, 9/11 chunks structured, 99.8 % coverage,
149 headings, 61 figure blocks, 89 table rows — including a specifications table
reconstructed from the drawing that mechanical conversion could only emit as prose.

## Scan path (M5) — pixels become text on the CPU

A page that carries its own image (`page-NNN-img-*`) is a **scan**: its embedded text
layer is an older OCR of the same pixels and is discarded by policy, not trusted. Those
pages are read locally by two ONNX models instead of a vision model:

| stage | model | CPU time |
|---|---|---|
| regions | PP-DocLayout v2 | ~0.3 s |
| text detection | PP-OCRv6 det small | ~0.1 s |
| recognition | PP-OCRv6 rec small | ~0.7 s |
| **per page** | | **~1.2 s, zero VRAM** |

- **Nothing leaves the machine.** No provider call, no GPU, no Python: the models run
  through `ort` inside the same Rust core (`nConvert/src/ocr.rs`) and are reached by the
  service as the native `ocr` operation in its worker processes.
- **Models** live under the storage root at `models/ocr` (engine OCR model directory):
  `pp_doc_layoutv2.onnx`, `PP-OCRv6_det_small.onnx`, `PP-OCRv6_rec_small.onnx`.
  Disabling OCR in the engine falls back to the vision path for scans.
- **Regions become structure**, not prose: a `table` region is rebuilt as a Markdown
  table (rows by y-cluster, columns by x-cluster, two-line headers merged), a
  `paragraph_title` becomes `## `, `header`/`footer`/`aside_text` are dropped.
  Lines outside every region are appended in reading order — never lost.
- **Provenance is stated.** The chunk report carries `derivedBy: "ocr"`, the frontmatter
  gains `derived-by: ocr | model | measured`, and OCR chunks report `coverage: null`
  because there is no layer to measure against — the reading *is* the measurement.
- **Measured on the DKV certificate** (the page whose Acrobat layer lost `325,50 EUR`):
  18/18 ground-truth facts, both tax tables reconstructed with correct cell ownership,
  `derived-by: ocr`, 2.9 s end to end for the document.

## Verification — how far to trust a result

The deterministic guard measures what survived. It cannot say *what* is missing
when the evidence itself is damaged, so there is an independent audit
(`nconvert.verify`). It runs **on demand**, not after every ingest: one
large-model call per document is not a routine cost (engine `verify: true` makes
deep ingests audit themselves):

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

## Running the service

The engine and its build live in `nteligence-server` (`D:\DEV\nTeligence`):

```
cd D:\DEV\nTeligence
cargo run -p nteligence-server         # binds 127.0.0.1:3300 (nteligence.toml)
cargo test -p nconvert                 # engine tests + corpus contract
node nConvert/napi/setup.js            # rebuild the Node addon (print consumes it)
```

`agents.nconvert.serviceUrl` in `config.json` is the only link between the repos.
After a server restart, **reconnect clients** — a session connected before the
restart answers "Unknown method" for new tools.

`npm run test:nconvert` here runs the proxy smoke test and the review-UI surface
test, both against a live service.
