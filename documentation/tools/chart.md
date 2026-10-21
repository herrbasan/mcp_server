# Chart Tools

Deterministic SVG diagrams from a semantic spec, via
[nCharts](https://github.com/herrbasan/nCharts) vendored as a submodule at
`src/nCharts`. Added 2026-10-19; hybrid restyle retired 2026-10-21.

The contract is that **the caller describes meaning and the renderer decides every
coordinate.** `x`, `y`, `width`, `height`, `cx`, `cy` are rejected by validation.
That is what makes two diagrams of the same type look like they belong together,
and what stops a model from producing a plausible-looking but badly spaced figure.

Two capabilities answer the presentation case:

- **`frame`** composes the diagram into a box — a full 16:9 slide, the 8:9 half of
  one, a square — instead of letting the height fall out of the content.
- **`style: "sketch"`** redraws the shapes hand-drawn as pure vector. This replaced
  the image-model restyle (`chart.hybrid`, retired): nearly the same look, no model
  call, no drift, no per-image cost, and the words were never at risk.

## Methods

### `chart.guide`

`{ example? }`

Returns the authoring contract verbatim (`src/nCharts/src/contract.js`): spec
types, every field, the tone names, the frame rules, and the rules that reject
input. With `example`, returns one bundled example spec instead — the names are
listed at the end of the contract response.

**Call this before authoring a spec.** The format exists in no training set; a
model that guesses keys gets a validation error and learns nothing the tool could
not have told it for free.

### `chart.render`

`{ spec* | specPath*, name?, theme?, style?, preview? }`

`spec` is an **object**, not a path — the chat hemisphere has no filesystem, so a
path-only signature would be unusable there. `specPath` takes a storage path to an
earlier sidecar (`charts/<base>.json`); `spec` wins if both are given.

Order of operations:

1. **`audit()`** — geometry proofs (content fits the canvas, no node overlap, text
   fits its box, no edge passes through a node, arrows long enough to read, group
   containment, tone cap, ramp length, frame fit). Failure returns `isError: true`
   with the offending field named, **and writes nothing** — a rejected spec must
   not leave a file that reads as a result.
2. **`resolve()`** — the layout the renderer settled on (variant, canvas, scale).
3. **`check()`** — static rules over the emitted markup (stroke weight,
   palette-only colours, defined classes and filters, tag balance). These are
   renderer bugs, not caller mistakes, so they **throw** rather than shipping a file.
4. Write the SVG, the sidecar holding the **resolved** spec, and (unless
   `preview: false`) a preview raster.

Success returns the file paths, the frame line when one was asked for, **plus audit
warnings**. Warnings mean "legible but not perfect" — text that just fits, a stub
arrow, a drawing that had to shrink into its box. They are the difference between a
valid diagram and a good one, and they are deliberately not fatal.

`style` is `"flat"` (default) or `"sketch"`. Sketch is a geometry pass in
`src/agents/chart/sketch.js`: every rect/line/path is replaced by a wobbled
equivalent with a deterministic seed, a faint retrace underneath, a turbulence
displacement filter, and 1.8 weight. Fills are untouched — the tone classes still
carry colour, so a sketch diagram is a *drawn* diagram, not a monochrome one.

## Frames — the presentation case

A frame says "this diagram has to live in a box". Without one the canvas height is
whatever the content needs, which is why an unconstrained diagram comes out either
very wide or very tall.

```json
{ "type": "flow", "numbers": true, "frame": "8:9", "nodes": [], "edges": [] }
```

Named ratios: `16:9` (a full slide), `8:9` (half of a 16:9 slide split 50/50 — the
text-and-diagram slide), `1:1`, `4:3`, `3:2`, `2:1`, `9:16`, or `[width, height]`.

What the renderer does, in order:

1. **Reflow.** It tries the aspect knobs the type already has — flow `direction`,
   flow `wrap` with `columns` (only when the flow is already numbered), list
   `columns` — and a range of canvas widths (960 → 480), and keeps the combination
   that fills the box best.
2. **Compose.** The winner is placed in a canvas of exactly the box's aspect.
   `fit: "fill"` (default) scales the drawing to use the box, up or down, never
   cropping. `fit: "pad"` keeps the unit scale and centres the drawing in the space
   left over — for a page where several diagrams must share one type size exactly.
3. **Report.** The result line names what happened:
   `frame    8:9 · flow vertical · scale 1.83x`.

Why a width search rather than a zoom: `width` is a *unit scale*, not a pixel size.
A narrower canvas wraps text sooner and stacks rows, so the same layout occupies a
larger share of the box once the file is scaled to it — and the drawn type ends up
larger too. That is the lever a portrait box needs, and it is a re-layout, never a
scaled viewBox.

**A frame never adds marks.** `wrap` is offered only to flows that already carry
`numbers`; no variant invents edges, numbers or tones; the authored shape wins
every tie. A framed spec whose authored shape does not validate (a six-node
horizontal flow at 960) is rearranged rather than rejected — the frame IS the
request. Without a frame that same overflow is still an error.

**Known limit.** Layouts that span the full width by design — bars, matrix, table —
cannot grow into a tall frame. They use what they can and the audit says so:
`fills 38% of the 8:9 frame — the drawing is width-bound …`.

## Chrome

`title` and `caption` are **optional**. They are chrome, and a slide that draws its
own header and footer wants a diagram carrying neither. Omit both keys and the SVG
has no title or caption elements at all; with a frame, chrome that *is* present is
scaled and placed inside the box like any other content.

## Storage layout

```
charts/<base>.svg             self-contained, light AND dark in one file
charts/<base>.json            the RESOLVED spec — the diagram's source
charts/<base>_preview.webp    display raster; theme picks light or dark
```

`<base>` = `YYYYMMDD_HHMM_<slug>`, slug from `name`, else the spec title, else
`chart`; `-2`, `-3` … on collision.

The sidecar is the point of the layout. Without it a diagram is a dead picture.
With it the spec is the source of truth: edit the JSON and call
`chart.render({ specPath })` to re-render the same figure — change a label, add a
node, invert a card — instead of regenerating it from a prompt.

It records the spec the renderer **resolved**, not the one the caller sent: a frame
picks a layout variant and a canvas width, and a sidecar that kept the authored
shape would re-render to a different file. The smoke test asserts the round trip.

`theme` affects the **preview raster only**. The SVG always carries both themes in
a `@media (prefers-color-scheme)` block, so one file is correct in a light slide and
a dark reader.

## Configuration

```json
"agents": {
  "chart": {
    "folder": "charts",
    "previewSize": 1600
  }
}
```

`previewSize` is the longest edge of the preview raster. `nMediaUrl` is the usual
root config; the agent rasterizes through nMedia's process API. The Gateway is not
used by this agent.

`charts` is in `agents.vdb.ignore`: chart output is transient, and a spec sidecar
per render would otherwise become searchable documents.

## Submodule

`src/nCharts` — pinned commit, `branch = main` declared in `.gitmodules` so it
tracks its branch rather than a detached HEAD.

nCharts is zero-dependency ESM with no build step, so the server imports it
directly (`import { audit, check, CONTRACT, variantSvg, resolve } from
'../../nCharts/src/index.js'`) with nothing installed. Only `src/index.js` is
imported — that is the embedding surface, and the internals behind it are free to
move.

Bump the pin deliberately and commit the gitlink as its own commit:

```bash
cd src/nCharts && git fetch && git merge --ff-only origin/main
cd ../.. && git add src/nCharts && git commit -m "charts: bump nCharts to <sha>"
```

## Verified

`tests/chart-smoke.mjs` — init against a temp storage root, the guide (contract
mentions `frame`), a real render (svg + spec + preview, with the inline image
part), **the three frames** (canvas aspect within 1%, the variant reported, the
sidecar re-rendering to the same canvas), a **chrome-free** render (no `t-title` /
`t-caption` text), the **sketch** style (ink filters present, `<text>` intact), an
audit rejection (three tones in a structure diagram: nothing written), a supplied
geometry key (throws naming `nodes[0].x`), an unknown frame (named, refused), and
nMedia-down (the render still lands and says so).

## Retired: `chart.hybrid` (2026-10-19 → 2026-10-21)

The old second surface rasterized the drawing, had an image model restyle it, and
composited the vector type back on top — because diffusion cannot preserve
lettering. It worked, and it cost: a model call per render, a vision self-check, a
drift score that read 0.97 while an accent hue had silently gone, chip re-plating
sampled from the backdrop, and a single-theme result.

`style: "sketch"` does the hand-drawn look as vector, deterministically, in about
100 ms, in both themes, with the words never leaving the renderer. The experiment
record — the model A/B, moss as a full renderer, the perception-channel
measurements — is archived at
[`docs/_Archive/chart-hybrid-experiments.md`](../../docs/_Archive/chart-hybrid-experiments.md).

nCharts still ships the composite primitives (`compositeSvg`, `hybridize`) for its
own CLI; nothing in this server calls them.

## Gotchas

- **A tool with no exported handler kills the server at boot** (agent-loader
  guarantee), so a config tool and an export must always land together.
- **A preview failure does not fail the render.** nMedia is an outside service and
  the SVG and sidecar are already on disk when it is called, so a rasterizer outage
  is reported in the result (`preview  FAILED — …`) and logged, instead of throwing
  away a good diagram. Any other error still throws.
- Specs are storage-scoped: `specPath` resolves against `agents.storage.root` and
  rejects anything that escapes it.
- **nMedia's `color_scheme` option is accepted and ignored** on `/v1/process/image`
  (measured: byte-identical light and dark requests). The scheme is resolved in the
  SVG (`variantSvg`) before rasterizing.
- **The sidecar must be written from `resolve()`, not from `args.spec`.** A framed
  render changes `direction` / `wrap` / `columns` / `width`; a sidecar holding the
  authored shape re-renders to a different file. Same for hybrid re-renders and any
  future consumer.
- **The width search is bounded at 480 units** (`0.5 × 960`). Below that the type
  scale and the wrapping start to read as a different diagram rather than a bigger
  one.
- **`style: "sketch"` runs after `check()`,** on the renderer's own flat output —
  the sketch weights (1.8) are deliberately not the system's stroke token, so
  running the static check on a sketchified SVG would fail it by design.
