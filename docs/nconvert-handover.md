# nConvert — Session Handover (2026-11-02)

Pick-up point for the next session. Spec of record: `nConvert/docs/SPEC.md` (v2.3).
Operator doc: `documentation/tools/nconvert.md`. Engine repo: `herrbasan/nConvert`
(private, MIT), consumed as a submodule.

## Verify first (30 seconds)

```powershell
cd D:\DEV\mcp_server; git --no-pager log -1 --oneline; git status --porcelain
cd nConvert; git --no-pager log -1 --oneline; git status --porcelain
```
Expected: host `eb9e1ed`-or-later, engine `eb9e1ed`-or-later, both clean.
Then `nconvert.items` — expect 3 items; if it errors, the server needs a restart.

State at handover: host clean, engine clean, submodule pinned, server live,
`storage/ingest/` has 3 items (1 deep, 2 mechanical), VDB indexes the store.

## What is live

| Capability | Notes |
|---|---|
| txt, csv, tsv, md, json, yaml, toml, xml | M1 |
| PDF text (per page), embedded images, AES-256/R6 decrypt | M4 |
| PDFium rasterization + deep vision conversion + corrective retry | M4.2 |
| Layered artefact + `items`/`fetch` reader | M4.5 |

Tools: `nconvert.convert`, `nconvert.capabilities`, `nconvert.items`,
`nconvert.fetch`. Store: `storage/ingest/<YYYYMMDD_HHMM>_<slug>/`.

## Measured ceiling (do not regress it)

82-page technical PDF, shipped defaults + retry: **10/11 chunks structured,
99.9 % coverage, 155 headings, 200 table rows, 63 figures, 527 s**. The one
fallback is the multilingual regulatory section (CJK/Arabic/Hebrew) — mechanical
text preserved verbatim.

## Next: M3 (OOXML family)

Scope: docx, pptx, xlsx, odt, epub, eml — see spec §3 for the per-format notes.

Start with `docx`:
1. `zip` crate for the container (`maxExpandedMb` budget is already spec'd —
   enforce it per entry *and* in total).
2. `quick-xml` for `word/document.xml`; map `w:pStyle`/`outlineLvl` → headings,
   `w:numPr` → nested lists, `w:tbl` → table (reuse the colspan/rowspan grid
   resolution the JS HTML converter already proved).
3. Images via `word/media/*` → assets, `r:embed` rels resolved to relative links.
4. Footnotes → GFM. Embedded charts: cached series → data table (render only if
   the container ships one).
5. Deep mode for DOCX is **not** automatic: it needs the document rendered to
   pages first. Decide then whether to rasterize via LibreOffice (external) or
   postpone. Do not promise deep DOCX until that exists.

Exit criteria: a real Materna DOCX converts clean, goldens in `corpus/`, and the
host item shows headings/tables/figures in `item.json` stats.

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

## Gotchas that will bite again

- **Windows DLL lock:** a running server holds the staged `.node`. `napi/setup.js`
  stages version-stamped copies and the loader takes the newest by mtime — bump
  the version to stage a fresh one; never try to overwrite a loaded binary.
- **Submodule + running server:** do not move/replace `nConvert/` while the server
  is up; the lock blocks it. The swap was completed *around* a locked file.
- **`profile.release` only at the workspace root** — member profiles are ignored.
- **`type: "commonjs"`** in `nConvert/package.json` is required (host is ESM).
- **lopdf auto-decrypts V5/R6 at load** — presence is `encryption_state.is_some()`,
  not `trailer.has(b"Encrypt")`.
- **Never trust the PowerShell console for encoding** — it renders UTF-8 as CP1252.
  A CJK search failed in PS and matched instantly via `storage.grep`.
- **Bulk edits:** never run multi-file text substitution in a shell loop (a
  flattened array replaced single characters and destroyed five files on
  2026-10-30). Use the edit tool.

## Open questions for David

- Deep conversion for **office formats**: rasterize via LibreOffice, or keep deep
  PDF-only and accept mechanical DOCX? (Blocks a real feature decision.)
- **Chunking granularity** for M7: MD-Blocks sections (a slide/chapter/page) as the
  unit, or finer windows? Sections are the natural unit and already computed.
- **`privacy` values and who sets them** — product decision, not an engineering one.
- Media ingestion scope: transcript-only, or transcript + keyframes + summary in
  one item?
