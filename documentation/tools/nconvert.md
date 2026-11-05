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
| `nconvert.fetch` | `{ item*, layer?, section?, page?, asset?, maxChars? }` | Read one layer: `summary` · `document` · `mechanical` · `page` · `asset` · `original`. |

## The artefact is a layered object (spec §2.6)

*Nothing lost — layers added for discovery.* A reader answers from the cheapest
sufficient layer and digs only when it must:

| Layer | File | Use |
|---|---|---|
| **L0** | `summary.md` | what this is, who for, what it covers — feeds the registry and embeddings |
| **L1** | `document.md` | structured text; sections addressable via `nconvert.fetch { section: N }` |
| **L1b** | `document.mechanical.md` | deterministic conversion (deep only) — comparison and fallback |
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
  reported in the tool response when unavailable.

## The ingest queue (fast lane + one heavy job at a time)

Mechanical conversions run inline in the caller (ms-fast, CPU-only). Deep
conversions and inputs over ~25 MB (`agents.nconvert.heavyMb`) serialize
through a single worker — gateway tokens, PDFium and disk are never contended.
Submitting the same file twice while queued/running deduplicates to the same job.

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

## Deep conversion (spec §2.5) — structure from the drawing

Mechanical conversion reads what a file *declares*. Technical documents keep much of
their meaning in the drawing: the ASUS corpus manual holds **295,482 vector path
segments against 23 raster images** — every diagram is Bézier curves in the content
stream, unreachable by any image extractor. `depth: "deep"` recovers that.

**Pipeline:** mechanical pass first (its text is the *content authority* — the model
never retypes the document) → PDFium renders every page at 1240 px → pages chunked to
`chunkPages` (default 8) → each chunk sends page images + its authoritative text to the
vision model, which decides only structure → **text-coverage validation** (default
98 %) → assembled MD-Blocks.

- The model **never writes MD-Blocks directives**; it emits
  `[[FIGURE:page-NNN.png|caption]]` markers the agent translates, so untrusted output
  cannot inject syntax.
- **Coverage** is measured on the authoritative *vocabulary*: unique words, hyphenation
  joined, running headers excluded, concatenation artifacts reassembled. A chunk below
  threshold is **retried once with its missing words listed back to the model** — the
  guard is never lowered, the omission is named. Measured: 9/11 → **10/11 chunks
  structured**, specification and package-contents tables recovered (89 → 200 table rows).
- **Never-destroy:** `document.mechanical.md` is always written beside the deep result.
- Coverage or provider failure falls back per chunk — loudly, never silently.
- **Renderer:** PDFium (Chrome's engine), dynamically loaded. `pdfium.dll` (~7 MB)
  fetched by `node nConvert/napi/fetch-pdfium.js`; path in `agents.nconvert.pdfiumPath`.

Measured on the corpus: 82 pages, ~210–240 s, 9/11 chunks structured, 99.8 % coverage,
149 headings, 61 figure blocks, 89 table rows — including a specifications table
reconstructed from the drawing that mechanical conversion could only emit as prose.

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
