# Chart Tools

Deterministic SVG diagrams from a semantic spec, via
[nCharts](https://github.com/herrbasan/nCharts) vendored as a submodule at
`src/nCharts`. Added 2026-10-19.

The contract is that **the caller describes meaning and the renderer decides every
coordinate.** `x`, `y`, `width`, `height`, `cx`, `cy` are rejected by validation.
That is what makes two diagrams of the same type look like they belong together,
and what stops a model from producing a plausible-looking but badly spaced figure.

## Methods

### `chart.guide`

`{ example? }`

Returns the authoring contract verbatim (`src/nCharts/src/contract.js`): spec
types, every field, the tone names, and the rules that reject input. With
`example`, returns one bundled example spec instead — the names are listed at the
end of the contract response.

**Call this before authoring a spec.** The format exists in no training set; a
model that guesses keys gets a validation error and learns nothing the tool could
not have told it for free.

### `chart.render`

`{ spec* | specPath*, name?, theme?, preview? }`

`spec` is an **object**, not a path — the chat hemisphere has no filesystem, so a
path-only signature would be unusable there. `specPath` takes a storage path to an
earlier sidecar (`charts/<base>.json`); `spec` wins if both are given.

Order of operations:

1. **`audit()`** — geometry proofs (content fits the canvas, no node overlap, text
   fits its box, no edge passes through a node, arrows long enough to read, group
   containment, tone cap, ramp length, 16:9 frame).
   Failure returns `isError: true` with the offending field named, **and writes
   nothing** — a rejected spec must not leave a file that reads as a result.
2. **`render()`** — the SVG.
3. **`check()`** — static rules over the emitted markup (stroke weight, palette-only
   colours, defined classes and filters, tag balance). These are renderer bugs, not
   caller mistakes, so they **throw** rather than shipping a file.
4. Write the sidecar, the SVG, and (unless `preview: false`) a preview raster.

Success returns the file paths **plus audit warnings**. Warnings mean "legible but
not perfect" — text that just fits, a stub arrow, a two-tone cap reached. They are
the difference between a valid diagram and a good one, and they are deliberately
not fatal.

## Storage layout

```
charts/<base>.svg            self-contained; carries light AND dark in one file
charts/<base>.json           the exact spec — the diagram's source
charts/<base>_preview.webp   display raster; theme picks light or dark
```

`<base>` = `YYYYMMDD_HHMM_<slug>`, slug from `name`, else the spec title, else
`chart`; `-2`, `-3` … on collision.

The sidecar is the point of the layout. Without it a diagram is a dead picture.
With it the spec is the source of truth: edit the JSON and call
`chart.render({ specPath })` to re-render the same figure — change a label, add a
node, invert a card — instead of regenerating it from a prompt.

`theme` affects the **preview raster only**. The SVG always carries both themes in
a `@media (prefers-color-scheme)` block, so one file is correct in a light slide and
a dark reader.

## Configuration

```json
"agents": { "chart": { "folder": "charts", "previewSize": 1600 } }
```

`previewSize` is the longest edge of the preview raster. `nMediaUrl` is the usual
root config; the agent renders the preview through nMedia's process API.

## Submodule

`src/nCharts` — pinned commit, `branch = main` declared in `.gitmodules` so it
tracks its branch rather than a detached HEAD.

nCharts is zero-dependency ESM with no build step, so the server imports it
directly (`import { render, audit, check, CONTRACT } from '../../nCharts/src/index.js'`)
with nothing installed. Only `src/index.js` is imported — that is the embedding
surface, and the internals behind it are free to move.

Bump the pin deliberately and commit the gitlink as its own commit:

```bash
cd src/nCharts && git fetch && git merge --ff-only origin/main
cd ../.. && git add src/nCharts && git commit -m "charts: bump nCharts to <sha>"
```

## Verified

`tests/chart-smoke.mjs` — init against a temp storage root, the guide, a real
render (svg + spec + preview, with the inline image part), an audit rejection
(three tones in a structure diagram: nothing written), and a supplied geometry key
(throws naming `nodes[0].x`).

## Gotchas

- **A tool with no exported handler kills the server at boot** (agent-loader
  guarantee), so a config tool and an export must always land together.
- **A preview failure does not fail the render.** nMedia is an outside service and
  the SVG and sidecar are already on disk when it is called, so a rasterizer outage
  is reported in the result (`preview  FAILED — …`) and logged, instead of throwing
  away a good diagram. Any other error still throws.
- Specs are storage-scoped: `specPath` is resolved against `agents.storage.root`
  and rejects anything that escapes it.
