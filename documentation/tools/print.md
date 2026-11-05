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
  MD-Blocks IDs.
- `breakAfter: ["block-id"]` — force a break after existing IDs.
- `sectionPages: true` — start every section on a fresh page. Also read from
  frontmatter `print.sectionPages`.
- An empty source block with `preset=page-break` forces a break at that point.
- `format` (`A4`, `A5`, `Letter`, `Legal`), `orientation`, and `margin` override
  the corresponding frontmatter `print` values. Margins accept one CSS length or
  `top`/`right`/`bottom`/`left` values in `mm`, `cm`, `in`, or `px`.

Unknown, missing, or duplicate break targets fail the render. The result lists
all available semantic IDs and their kind/preset/heading so the next call can
adjust breaks without guessing CSS selectors.

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
semantic targets, page count, preview paths, and renderer warnings. With
`preview: false`, only the PDF and sidecar are written and `pageCount` is null.

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
failures.
