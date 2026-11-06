# Print — MD-Blocks → PDF

Render MD-Blocks documents with the canonical `nui_wc2` renderer, print them
through headless Chromium, and inspect rasterized pages from the resulting PDF.
The tool owns pagination and output; it does not implement a second Markdown or
MD-Blocks renderer.

## Methods

### `print.render`

```json
{
  "path": "vita/vita_ai_change_manager_v4.md",
  "name": "vita-full-bleed",
  "style": "editorial",
  "breakBefore": ["berufserfahrung", "technologien", "kurzvita"],
  "pages": [1, 2, 3]
}
```

Input is exactly one of:

- `path` — Markdown file, storage-relative or absolute. Relative media resolves
  against the file's directory.
- `markdown` — inline MD-Blocks source. `basePath` sets the relative-media base
  and defaults to the storage root.

Design and pagination controls:

- `style` — `editorial` (Segoe UI/navy), `minimal` (compact black-and-white), or
  `classic` (serif/traditional). All profiles are unshaded and can also be set
  through frontmatter `print.style`. Display typography gets lighter as it gets
  larger; heavy weights are reserved for small text.

- `breakBefore: ["section-id", "block-id"]` — force a break before existing
  MD-Blocks IDs. Also read from frontmatter `print.breakBefore`.
- `breakAfter: ["block-id"]` — force a break after existing IDs. Also read from
  frontmatter `print.breakAfter`. Caller arrays override the authored arrays.
- `sectionPages: true` — start every section on a fresh page. Also read from
  frontmatter `print.sectionPages`.
- An empty source block with `preset=page-break` forces a break at that point.
- `format` (`A4`, `A5`, `Letter`, `Legal`), `orientation`, and `margin` override
  the corresponding frontmatter `print` values. Margins accept one CSS length or
  `top`/`right`/`bottom`/`left` values in `mm`, `cm`, `in`, or `px`.

Unknown, missing, or duplicate break targets fail the render. The result lists
all available semantic IDs and their kind/preset/heading so the next call can
adjust breaks without guessing CSS selectors.

**Paragraphs are break targets too.** Besides sections, blocks and columns, every
plain paragraph gets a content-addressed ID (`p-<fnv1a>`) so a break can land
between paragraphs, not only at authored boundaries. The ID hashes the
paragraph's normalized text: it survives other paragraphs moving, and if the
paragraph itself is edited the ID disappears — the render then fails loudly with
that ID rather than silently breaking somewhere else. `breakBefore` accepts these
IDs exactly like authored ones.

Two things are deliberately excluded, because a break there would tear a box
apart: paragraphs inside a container the stylesheet marks `break-inside: avoid`,
and paragraphs inside anything visibly boxed (border on both edges or a fill) —
presets like `band` and `card` stay whole. Text that NUI emits as a bare node
rather than a `<p>` (text sitting tight against the preceding block) is promoted
to `p.nui-print-loose`, whose zero margin leaves the printed result unchanged.

`repeat=header` and `repeat=footer` chrome is moved into Chromium's real PDF
header/footer and repeats on every page. Chrome uses a light-gray full-bleed
surface reaching all four paper edges. Negative margins offset Chromium's native
inset while compensating padding keeps the text and body layout stationary. Two
footer paragraphs are laid out left/right. `{{page}}` and
`{{pages}}` inside chrome become Chromium's native `pageNumber`/`totalPages`
fields, so `Seite {{page}} von {{pages}}` is resolved while printing.

Chrome is measured at the actual page width before printing. Top/bottom margins
are treated as minimums and grow to fit the chrome plus Chromium's native inset
allowance (`chromeInsetMm`, default 5 mm) and the body gap (`chromeGapMm`,
default 8 mm). Chrome requiring more than `maxChromeFraction` of page height
(default 0.35) fails loudly instead of clipping or colliding with the body. Growing a
margin can change pagination, so the normal preview loop still applies.

Multiple different header or footer scopes in one document fail loudly;
Chromium cannot represent per-scope global chrome in one PDF.

### `print.preview`

```json
{
  "path": "prints/20261103_2106_vita-full-bleed-test/document.pdf",
  "pages": [2, 3],
  "width": 1240
}
```

Rasterizes selected 1-based pages of an existing PDF and attaches the exact PNG
pages. Out-of-range pages fail. Use this for another look without rerendering
the source.

## Visual page-break editor

Open `/print?path=vita/vita_ai_change_manager_v4.md` on the MCP server. The
editor shows exact PDF pages with a thumbnail rail that scrolls on its own.
**Breaking happens on the paper itself:** hovering a page reveals a dashed line
with a "Break here" handle at every spot where a section, block, or column
starts, positioned at that element's real vertical coordinate on the page.
Clicking a spot makes it the page break; clicking the line of an existing break
removes it.

One break per stretch of paper — a click drops any other break within 2.5% of a
page height of the spot (roughly 7 mm on A4), so a click never leaves two breaks
fighting over the same region. Break-before on a target and break-after on the
target above it
resolve to the same position, are drawn as one line, and are removed together.
The document's first target gets no spot (nothing precedes it, so a break there
would only produce an empty page).

Style, format, orientation, and section-per-page controls use the same render
loop. There is deliberately no separate document-tree editor.

Every change rerenders the real PDF without touching the source. Break-only
changes reuse the session's loaded page (~1 s); changing style, format,
orientation or section-per-page reloads it (~2.5 s), because those are resolved
when the page loads. **Save to document** updates only the frontmatter,
preserving the Markdown body and
unrelated metadata:

```yaml
print:
  style: editorial
  format: A4
  orientation: portrait
  sectionPages: false
  breakBefore:
    - berufserfahrung
  breakAfter: []
```

The PDF link downloads the current, possibly unsaved preview. Saves use the
source SHA-256 as a conflict guard; an external edit must be reopened rather
than overwritten. Remote clients must use storage-relative source paths.
Absolute source paths are accepted only from loopback clients.

The editor REST surface is `POST /print/api/open`, `/render`, `/save`, and
`/close` under `/print/api/` (the listed names are the suffixes). Editor output
lives under `prints/_editor/<session>/`; abandoned sessions expire after six
hours of inactivity. Concurrent operations on one session fail with 409 instead
of racing over the same PDF.

For page mapping and geometry, the renderer inserts tiny absolute-positioned
text markers at semantic targets. Because they are absolutely positioned they
add no layout, so the marked PDF paginates identically to the delivered one.
nConvert's `searchText` reads each marker's page **and** vertical position back
out of the PDF text layer as character boxes (`searchText` matches
character-by-character, skipping whitespace — PDFium reports 1px glyph runs
space-separated, so contiguous string search finds nothing). The markers are
then removed and the delivered PDF is generated again. A marked/final page-count
mismatch fails loudly, and the final PDF contains no mapping markers. Set
`PRINT_PROBE_PDF=<absolute path>` to keep the marked probe PDF when a target
cannot be located.

## Output

Each render creates a unique folder under `prints/`:

```text
prints/<timestamp>_<name>/
  document.pdf
  render.json
  pages/
    page-001.png
    ...
```

`render.json` records the source hash, resolved page options, explicit breaks,
semantic targets, page count, preview paths, cumulative phase timings
(`timings`, milliseconds since the render began) and renderer warnings. A cold
render adds `launch` (Chromium start), `load` (render page delivered and parsed),
`rendered` (NUI result ready) and `layout` (page ready to print, after chrome
fitting); both paths then record `pdf`, `geometry`, `pdfFinal` and `raster`.
With `preview: false`, only the PDF and sidecar are written and `pageCount` is
null.

**A render session keeps one Chromium page alive for one document.** Loading it
— markdown parse, fonts, images — is the single largest cost (~1.3 s), so a
break-only change reuses the loaded page, rewrites the break classes in place,
and re-prints; a warm render reports `timings.layout: 0`. Anything that changes
layout (source text on disk, `style`, `format`, `orientation`, `sectionPages`)
reopens the page, because those are baked in at load. Measured on a 5-page
document: ~1.5 s cold, ~0.9 s warm. The editor holds at most four warm sessions,
evicting the oldest idle one, and closes the browser on `/print/api/close` or
after six hours idle.

Cold open, measured on the vita document: Chromium launch 0.21 s, render page
delivered and parsed 0.24 s, chrome fit 0.14 s, first PDF 0.38 s, geometry
0.03 s, second PDF 0.37 s, raster 0.18 s. Two things dominate and both are real
work: the two PDF passes (the marked probe that yields geometry, then the clean
delivered file) and the document parse. The render page is waited on with
`domcontentloaded` plus the page's own `__PRINT_RESULT__` signal — the previous
`networkidle0` added roughly a second of idle waiting for nothing.

Page thumbnails reuse the same PNGs as the full pages at a CSS-scaled size, so
they cost nothing extra; the pictures are only ~0.2 s of a render, pagination is
the rest.

Previews default to enabled. Every page is written to `pages/`; the first eight
are attached inline unless `pages` selects others. `width` controls raster width
(320–3000 px, default 1240).

## Implementation and limits

- Renderer: `src/nui_wc2/NUI/nui.js` (`nui.util.markdownToHtml`) and
  `nui-theme.css`, vendored as a submodule.
- A loopback-only ephemeral HTTP server supplies the render page, NUI assets,
  and the current document's media. It never listens on a LAN interface.
- Chromium creates the PDF with backgrounds and CSS `@page` size enabled.
- PDFium rasterizes the actual PDF, not an approximate screen layout. Each
  rasterization runs in a short-lived worker because PDFium bindings cannot be
  initialized twice in one Node process.
- Narration blocks and interactive player/slideshow controls are omitted from
  print. Images are loaded eagerly and broken/refused media fails the render.
- `agents.print.maxPages` bounds full-document preview rasterization (default
  100); `inlinePreviewLimit` defaults to 8; `previewTimeoutMs` defaults to
  120000. `chromeGapMm` defaults to 8, `chromeInsetMm` to 5, and
  `maxChromeFraction` to 0.35.
  `pdfiumPath` uses the nConvert PDFium installation by default.

## Validation

```bash
npm run test:print
```

The smoke test renders real PDFs twice in one process, verifies source and
caller breaks by page count, checks selected PNGs and sidecar settings, checks
native page fields and bleed chrome, grows margins for a tall header, and
exercises excessive-chrome, unknown-target, invalid-style, and out-of-range
failures. It also locates semantic targets to exact pages and vertical
positions, verifies that mapping markers are absent from the delivered PDF, and
exercises the editor HTTP loop: open, toggle/rerender, save frontmatter, and
reopen persisted pagination.
