# nConvert — Session Handover (2026-11-03, evening)

Pick-up point for the next session. Spec of record: `nConvert/docs/SPEC.md`.
Operator doc: `documentation/tools/nconvert.md` (includes the queue section).
Engine repo: `herrbasan/nConvert` (private, MIT), consumed as a submodule.

## Verify first (30 seconds)

```powershell
cd D:\DEV\mcp_server; git --no-pager log -1 --oneline; git status --porcelain
cd nConvert; git --no-pager log -1 --oneline; git status --porcelain
```
Then `nconvert.items` — expect 4+ items. Server live on engine **0.7.0**
(pptx live). **Restarting the server is agent-executable for this project**
(David's permission, 2026-11-03): `POST
http://192.168.0.100:9333/api/services/agent_orchestrator/restart` — then
verify with a workshop call; clients must reconnect to see new tools.
The Finanzamt letter is ingested clean:
`20261103_0933_finanzamt-pfaffenhofenmietedarlegung` — 3 full photos
(PIL-verified decode), the corrupt 0.6.0 item was deleted. ZOLL deck
ingested at `20261103_1610_20260923zollkickoff-workshop`.

State at handover: host clean, engine clean, submodule pinned at engine
0.7.0, all committed (engine 24d1c92, host f1b445d).

## What is live

| Capability | Notes |
|---|---|
| txt, csv, tsv, md, json, yaml, toml, xml | M1 |
| PDF text (per page), embedded images, AES-256/R6 decrypt | M4 |
| PDFium rasterization + deep vision conversion + corrective retry | M4.2 |
| Layered artefact + `items`/`fetch` reader | M4.5 |
| **DOCX mechanical** | **M3 · live** (engine 0.5.0): styles → headings, numPr → nested lists, gridSpan/vMerge → rectangular grid, media → assets, footnotes → GFM, hyperlink fields (element + fldChar form), OMML math flattened (warned), page breaks → `***`, captions attach to image blocks, ZIP expansion budget per entry + total |
| **PPTX mechanical** | **M3 · live** (engine 0.7.0): one section per slide (order from sldIdLst via rels — never filename sort), title/body placeholders → heading/paragraphs, buChar/buAutoNum + lvl → nested lists, DrawingML tables → shared span grid, media → assets (SVG preferred over PNG fallback), speaker notes → `preset=narration` blocks, charts/SmartArt warned pending. Shared OOXML machinery extracted to `src/ooxml.rs` (ZipParts, budget, grid, run model) |
| **XLSX mechanical** | **M3 · live** (engine 0.8.0): calamine; one section per sheet, first row as header, merged cells fill from origin, styled serials → ISO dates (Lotus-bug-aware), integral floats without `.0`, row cap + maxCells, empty sheets warned-skip, expansion budget pre-charged from the ZIP central directory |
| **Ingest queue + progress** | **Live** (2026-11-03, host-only): fast lane (mechanical inline) + one heavy job (deep / >25 MB) at a time; step-model progress with i/n and coverage; jobs persist across restarts (running → re-queued); sha256 dedup; cooperative cancel at checkpoints; MCP `nconvert.enqueue/jobs/job/cancel` + REST `/nconvert/jobs*` + SSE `/nconvert/events`; retention 200. Verified live: deep DKV pdf queued → rendered 1 page → vision 98.8 % after retry (own step) → summarizing → done, with cancel tested mid-summary |
| **DOC (Word 97-2003)** | **M6 · live, pulled forward** (engine 0.6.1): CFB container (`cfb` crate 0.16, MIT) + [MS-DOC] piece-table text (cp1252 + UTF-16 pieces), field results kept / instructions dropped, page breaks → `***`, photos carved from the `Data` stream **structure-aware** (`jpeg_bounds`: segments + entropy walk — EXIF-embedded thumbnails no longer truncate the host image); tables/footnotes/headers/textboxes warned-not-converted; Word 6/95 (nFib<0xC1) and encrypted/obfuscated refused loudly. Detection now classifies inside CFB by stream shapes (WordDocument → doc, Workbook → xls, __substg → msg) |

Tools: `nconvert.convert`, `nconvert.capabilities`, `nconvert.items`,
`nconvert.fetch`. Store: `storage/ingest/<YYYYMMDD_HHMM>_<slug>/`.

## Measured (2026-11-02 evening)

- Engine: **40/40 tests** (6 new docx tests: end-to-end, determinism, budget
  hard error, missing-part, page-break split, field hyperlink).
- Engine 0.6.0: **47/47 tests** (+7 doc tests incl. a real-file corpus test
  on `Finanzamt Pfaffenhofen_Miete_Darlegung.doc`: umlaut text + 6 carved
  JPEGs — 3 photos × (full + 160px thumbnail)).
- Real corpus `.doc` #2: `Zeitsprung_V2.3.doc` (Word 97, 19 203 CPs) —
  2 606 words clean German (AV storyboard), picture anchors present but images
  are metafiles → 0 carved, honestly warned (`doc-picture-chars`).
- PPTX real decks (engine 0.7.0, 2026-11-03): ZOLL KickOff (17 slides,
  PptxGenJS, plain textboxes) → 1 914 words, 5 tables in 12 ms;
  `Erläuterung zur Nutzung des Folienmasters` (109 slides, 50 notes, 226
  media / 19.2 MB incl. 163 SVG) → 1 471 blocks, 8 headings, 4 tables,
  **215 figure refs**, 226 assets, **43 narration blocks**, 132 KB md,
  266 ms. Chart + EMF warnings honest. 54/54 engine tests.
- Bindings: ALL PASS incl. PDFium corpus rasterization. Agent smoke: ALL PASS.
- Real-world DOCX (no Materna file on this machine): trustainable manuscript
  (226 KB, German) — 172 blocks, 27 list lines, 45 bold, 2 images, captions —
  in 30 ms; AMD `License.docx` — 514 blocks, 70 clause list lines, endnotes
  warning — in 11 ms. Both clean, zero conversion errors.
- **Pending: a real Materna DOCX** — the original M3 exit criterion. Convert
  one when available (work machine), expect numbering/tables/images.

## Fixed en route (was biting silently)

- **detect.rs central-directory walk was broken** (`p = eocd + 16` walked the
  EOCD record itself instead of reading the cd-offset field stored there):
  every real ZIP failed detection with "central directory unreadable".
  Invisible until now because docx was Unsupported — an error either way.
  Fixed, plus the backward EOCD scan (≤64 KB comments) now actually scans.
- **Self-consistent fixture trap (doc FIB offsets)**: first implementation put
  rgLw97@62 and rgFcLcb97@120 — wrong by 2/34 bytes, but the hand-built fixture
  encoded the same wrong offsets, so all tests passed. Only the REAL Finanzamt
  file exposed it (lcbClx read as 0). Correct: rgLw97@64, rgFcLcb97@154,
  fcClx@418. Lesson recorded: a format parser needs at least one real-world
  fixture in its tests, generated fixtures alone prove nothing about offsets.
- **quick-xml 0.39 splits text at entities** (`Event::GeneralRef`): a
  catch-all arm silently deleted `&amp;` → "GEO  AEO" on the ZOLL corpus;
  affected docx too (latent — no fixture had entities). Fixed in all text
  consumers via `ooxml::entity_text`; regression asserts in both fixtures.
- **JPEG signature carving truncated full-size photos (0.6.0 → 0.6.1)**:
  Finanzamt photos carry EXIF APP1 segments with embedded thumbnail JPEGs;
  cutting at the first FFD9 produced "SOI + EXIF + thumb-EOI" blobs (thumbs
  readable, fulls corrupt). The carver now walks JPEG structure (segments +
  entropy stuffing rules, `jpeg_bounds`) and jumps past each carved image;
  PNG end is IEND + CRC. Verified: all 3 real photos (714×1116, 644×1078,
  706×972) fully decode via PIL. Second lesson from the same file: **validate
  carved images by decoding, not by finding magic bytes** — the corrupt blobs
  had perfect signatures.

## Next: queue + progress (M7 pulled forward), then formats

**Design proposed 2026-11-03, awaiting David's call on two forks:**
1. Fast lane (mechanical inline + one heavy job at a time) vs strict FIFO
2. SSE (`GET /nconvert/events`) as the event transport (recommended)

Core design: job store `data/nconvert/jobs.json` (atomic, survives restarts),
`queued → running → done/failed/cancelled`, FIFO, sha256 dedup, step-model
progress (detecting → converting → rendering i/N → vision i/N + coverage →
retry → summarizing → indexing), MCP tools `nconvert.enqueue/jobs/job/cancel`,
REST for the admin dashboard, cooperative cancel between chunks.

1. **.msg/.eml** — needs a real export from David (none on the machine).
2. **rtf** (text-based spec, hand parser).
3. **DOCX/PPTX charts** — cached series → data table.
4. **xls (BIFF)** — real fixture in corpus (`2011_Staubsauger-Typensuche_final.xls`).
5. **doc refinements**: WMF/EMF rasters, footnote/header text, Escher provenance.
6. odt / epub.

## Known limits (all deliberate, all recorded)

1. **Multilingual blocks** — vision model cannot reproduce CJK/RTL; falls back to
   mechanical text. M5 target.
2. **Scans** — embedded OCR layers carry their era's errors (a 2013 letter reads
   *Ubelstem*, *EntzOndungsparameter*). M5 target via gateway vision.
3. **Deep is PDF-only** — the rasterizer is the gate.
4. **Retries cost time** — 238 s → 527 s on the 82-page run. `coverageRetry: false`
   in `agents.nconvert` disables it.
5. **No chunk-level retrieval yet** — VDB searches whole documents; chunking,
   section summaries and the explicit embedding hand-off are M7.
6. **Media (YouTube) not in the artefact model** — M7.
7. **`privacy` is `unset` on every item** — field exists, policy doesn't.
8. **DOCX**: charts pending; endnotes warned not converted; documents with
   manual formatting (no heading styles) yield no headings — mechanical reads
   what the file declares; that is correct, not a bug.

## Gotchas that will bite again

- **Windows DLL lock:** a running server holds the staged `.node`. `napi/setup.js`
  stages version-stamped copies and the loader takes the newest by mtime — bump
  the version to stage a fresh one; never try to overwrite a loaded binary.
- **Gateway stream drops** (ECONNRESET in nPM telemetry, 2026-11-02) kill turns
  mid-generation — three turns died before a big file-write landed. Write large
  files in chunks with a trailing append marker, not one giant tool call.
- **Submodule + running server:** do not move/replace `nConvert/` while the server
  is up; the lock blocks it. The swap was completed *around* a locked file.
- **`profile.release` only at the workspace root** — member profiles are ignored.
- **`type: "commonjs"`** in `nConvert/package.json` is required (host is ESM).
- **lopdf auto-decrypts V5/R6 at load** — presence is `encryption_state.is_some()`,
  not `trailer.has(b"Encrypt")`.
- **Never trust the PowerShell console for encoding** — it renders UTF-8 as CP1252.
  A CJK search failed in PS and matched instantly via `storage.grep`.
- **quick-xml events borrow the read buffer** — own your values (attr strings,
  element names) before the next `read_event_into`; passing `e.name()` into a
  call that also takes `&mut buf` is a double borrow.
- **`w:name` in styles.xml is attribute-form** (`w:val`) — element text is a
  fallback; style names stay canonical English in-file regardless of UI language.
- **Bulk edits:** never run multi-file text substitution in a shell loop (a
  flattened array replaced single characters and destroyed five files on
  2026-10-30). Use the edit tool.

## Open questions for David

- **Restart the MCP server** when convenient to load nconvert 0.6.0 (doc +
  docx live for connected clients; reconnect after restart).
- **A real Materna DOCX** for the golden validation.
- Deep conversion for **office formats**: rasterize via LibreOffice, or keep deep
  PDF-only and accept mechanical DOCX? (Blocks a real feature decision.)
- **Chunking granularity** for M7: MD-Blocks sections (a slide/chapter/page) as the
  unit, or finer windows? Sections are the natural unit and already computed.
- **`privacy` values and who sets them** — product decision, not an engineering one.
- Media ingestion scope: transcript-only, or transcript + keyframes + summary in
  one item?
