# nConvert — Session Handover (2026-11-02, evening)

Pick-up point for the next session. Spec of record: `nConvert/docs/SPEC.md` (v2.3).
Operator doc: `documentation/tools/nconvert.md`. Engine repo: `herrbasan/nConvert`
(private, MIT), consumed as a submodule.

## Verify first (30 seconds)

```powershell
cd D:\DEV\mcp_server; git --no-pager log -1 --oneline; git status --porcelain
cd nConvert; git --no-pager log -1 --oneline; git status --porcelain
```
Then `nconvert.items` — expect 3+ items. **The running server still loads
engine 0.5.0** (restarted 19:42 before the .doc build); `.doc` goes live for
clients after the next restart — David's call, not the agent's.

State at handover: host clean, engine clean, submodule pinned, engine **0.6.0
staged** (`napi/setup.js` ran; plain name replaced while unlocked).

## What is live

| Capability | Notes |
|---|---|
| txt, csv, tsv, md, json, yaml, toml, xml | M1 |
| PDF text (per page), embedded images, AES-256/R6 decrypt | M4 |
| PDFium rasterization + deep vision conversion + corrective retry | M4.2 |
| Layered artefact + `items`/`fetch` reader | M4.5 |
| **DOCX mechanical** | **M3 · live** (engine 0.5.0): styles → headings, numPr → nested lists, gridSpan/vMerge → rectangular grid, media → assets, footnotes → GFM, hyperlink fields (element + fldChar form), OMML math flattened (warned), page breaks → `***`, captions attach to image blocks, ZIP expansion budget per entry + total |
| **DOC (Word 97-2003)** | **M6 · live, pulled forward** (engine 0.6.0): CFB container (`cfb` crate 0.16, MIT) + [MS-DOC] piece-table text (cp1252 + UTF-16 pieces), field results kept / instructions dropped, page breaks → `***`, photos carved from the `Data` stream (JPEG/PNG ≥1 KB); tables/footnotes/headers/textboxes warned-not-converted; Word 6/95 (nFib<0xC1) and encrypted/obfuscated refused loudly. Detection now classifies inside CFB by stream shapes (WordDocument → doc, Workbook → xls, __substg → msg) |

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

## Next: M3 + M6 continued (order suggested)

1. **pptx** — one section per slide, speaker notes → narration blocks. The
   zip/budget plumbing in `src/docx.rs` generalizes; extract shared helpers
   into a container module when the second OOXML format lands.
2. **.msg** (Outlook, CFB `__substg` streams) and **.xls** (BIFF) — the CFB
   container layer landed with `doc`; both are container work only now.
3. **rtf** (text-based spec, hand parser).
4. **DOCX charts** — cached series → data table (the one spec'd docx item
   still pending).
5. **doc refinements**: WMF/EMF metafile rasters, footnote/header text (CCP
   ranges already parsed), Escher walk for exact image provenance vs carving,
   thumbnail/full-pair dedupe.
6. odt / epub / eml.

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
