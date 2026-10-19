# Chart Tools

Deterministic SVG diagrams from a semantic spec, via
[nCharts](https://github.com/herrbasan/nCharts) vendored as a submodule at
`src/nCharts`. Added 2026-10-19.

The contract is that **the caller describes meaning and the renderer decides every
coordinate.** `x`, `y`, `width`, `height`, `cx`, `cy` are rejected by validation.
That is what makes two diagrams of the same type look like they belong together,
and what stops a model from producing a plausible-looking but badly spaced figure.

`chart.hybrid` adds a second surface: the same diagram drawn in a styled raster
(hand-drawn ink on paper by default) with the words still vector. Diffusion cannot
preserve lettering — it generates glyph-shaped marks — so the words never enter the
model. Measured in `src/nCharts/docs/HYBRID.md` (NCC 0.58–0.60 against a 0.16 noise
floor, across denoise values, two models and two resolutions).

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

`{ spec* | specPath*, name?, theme?, text?, strength?, preview? }`

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

`text: false` writes the **textless geometry base** instead: no type, strokes
weighted to `strength` (default 2.5), pinned to the light palette, on a page
colour. That is what an image model needs — an SVG with no background rasterizes
to transparency and the model invents a ground for it; at stroke 1 a downscaled
base reads as scratches, so the model loses the shape. The spec sidecar is still
written, because the text layer can only be recovered by re-rendering.

### `chart.hybrid`

`{ spec* | specPath* | svg* | svgPath*, name?, preset?, prompt?, denoise?, steps?, theme?, strength?, backdropPath?, preview? }`

A restyled surface with exact vector type on top. Input is a spec, a spec sidecar
(`charts/<base>.json`, the same file `chart.render` wrote), an SVG string, or a
storage path — any SVG whose words live in `<text>` elements.

Pipeline:

1. **Base** — `chart.render({ text: false })`'s output: the drawing without type,
   weighted, on a page colour. For a non-nCharts SVG, text is removed and a white
   ground is added; strokes are left as authored unless `strength` is given.
2. **Rasterize** through nMedia at `hybridSize` (default 1920, 2× the canvas).
3. **Restyle** through the Gateway's image route with the base as an init image,
   `denoise` from the preset, prompt from the preset or `prompt`.
4. **Transcode** the result to WebP (q92) — a photo-like surface as PNG would put
   several megabytes of base64 inside the SVG.
5. **Composite** — every drawing element is stripped, the image is inserted before
   the body, and the original `<text>` elements paint on top. `xMidYMid slice`
   crops the sampler's 64-pixel rounding rather than stretching it, which would
   slide the shapes out from under the words.

**Model chain.** `agents.chart.hybridModels` is tried in order: local
`coolkid-krea2` (nGen on COOLKID, free) first, cloud `qwen-image` only if the local
worker refuses. Every refusal is logged with the model and status, and the last
error lists all of them — a silent downgrade to a paid model is exactly what the
chain exists to prevent.

**Presets** live in `agents.chart.presets`; `prompt` overrides a preset's wording,
`denoise` overrides its departure. `handdrawn` is the shipped preset.

**A hybrid is single-theme.** The backdrop is one fixed image, so the vector type
is pinned to `theme` (default light). A dual-scheme hybrid breaks at the first
dark-mode reader — the type flips over paper that cannot follow.

#### Re-composite — the cheap path

Pass `backdropPath` (the `<base>-backdrop.png` from an earlier run) and the model
is skipped entirely: 200 ms instead of 20 s. That is the iteration loop that
matters — restyle once, then edit labels, add a node, fix a typo, and re-composite
each time. The surface you approved stops changing under you, and the local GPU is
touched once instead of per edit. The result is a new artifact with its own base
name; the source backdrop is copied in, never mutated.

#### Drift audit — the oracle for the surface

The type is placed from the original geometry, so a restyle that moves the boxes
leaves the words floating off their shapes. That used to be caught by eye. Now both
rasterizations — the base the model saw and the surface it returned — are read back
(8-bit PNG, decoded in-process, no dependency), reduced to ink coverage on a 16-cell
grid, and correlated:

- **`score`** is Pearson correlation of cell coverage, in `-1..1`. Correlation, not
  difference: paper grain raises ink everywhere, and what must match is *where* the
  ink is, not how much of it there is.
- Below `driftFloor` (0.55) the call returns **`isError: true`** with the score, the
  five worst cells, and the advice to lower denoise. The artifacts are still written
  — the backdrop and the base are what you need to see why it drifted.
- Calibrated on `flow-gateway` through the local krea2: **0.77 at the shipped
  preset, 0.32 at denoise 0.85**. The floor sits between them with margin on both
  sides.

The audit runs on re-composites too — it is cheap, and a backdrop kept from an older
diagram can still be wrong for the new one.

## Storage layout

```
charts/<base>.svg             render: self-contained, light AND dark in one file
charts/<base>.json            render: the exact spec — the diagram's source
charts/<base>_preview.webp    render: display raster; theme picks light or dark
charts/<base>-base.svg        render text:false / hybrid: the textless handoff
charts/<base>.svg             hybrid: the deliverable (vector type over the raster)
charts/<base>_preview.webp    hybrid: display raster
charts/<base>-backdrop.webp   hybrid: the embedded surface (quality 92)
charts/<base>-backdrop.png    hybrid: the model's raw output — re-composite without
                              paying for another generation
charts/<base>-base.png        hybrid: the rasterized base the model saw
charts/<base>-hybrid.json     hybrid: preset, prompt, model, usage, seconds, files
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
"agents": {
  "chart": {
    "folder": "charts",
    "previewSize": 1600,
    "hybridSize": 1920,
    "hybridTimeoutMs": 180000,
    "driftFloor": 0.55,
    "hybridModels": ["coolkid-krea2", "qwen-image"],
    "defaultPreset": "handdrawn",
    "presets": { "handdrawn": { "denoise": 0.45, "steps": 20, "prompt": "…" } }
  }
}
```

`previewSize` is the longest edge of the preview raster; `hybridSize` the same for
the base and the embedded backdrop. `nMediaUrl` is the usual root config; the agent
renders through nMedia's process API. The Gateway (`gateway.httpUrl` +
`gateway.accessKey`) is used only by `chart.hybrid`.

**Tuning, measured through the Gateway's krea2 adapter** (2026-10-19, `flow-gateway`
base at 1920×640): denoise 0.3 with 12 steps returns a near-copy — the texture is
there, the hand-drawn quality is not. 0.75 departs so far that boxes move out from
under the type. **0.45 with 20 steps holds the structure and reads as pen on
paper**, which is why it is the shipped preset. This differs from nCharts' own 0.3
default because that measurement was made against nGen directly; the same number
means a different amount of departure through the Gateway.

`charts` is in `agents.vdb.ignore`: chart output is transient, and a spec sidecar
per render would otherwise become searchable documents.

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
render (svg + spec + preview, with the inline image part), the textless base (no
`<text>` elements, page colour present), hybrid's refusal of a textless base, an
audit rejection (three tones in a structure diagram: nothing written), a supplied
geometry key (throws naming `nodes[0].x`), and nMedia-down (the render still lands
and says so). `CHART_HYBRID=1` adds a real hybrid through the Gateway (asserts
`<text>` + WebP `<image>`, and a drift score above the floor), a **re-composite**
(the label is swapped, the model line says `saved backdrop`, ~200 ms) and a **drift
guard** run at denoise 0.85 (`isError: true`, score below the floor).

Verified against live services 2026-10-19: `coolkid-krea2` accepts the init image
through the Gateway and holds the layout at the shipped preset; `qwen-image` is a
working fallback (it is also the only image model in `data/models.json` declaring
`editing`).

## Gotchas

- **A tool with no exported handler kills the server at boot** (agent-loader
  guarantee), so a config tool and an export must always land together.
- **A preview failure does not fail the render.** nMedia is an outside service and
  the SVG and sidecar are already on disk when it is called, so a rasterizer outage
  is reported in the result (`preview  FAILED — …`) and logged, instead of throwing
  away a good diagram. Any other error still throws.
- Specs are storage-scoped: `specPath`/`svgPath` resolve against
  `agents.storage.root` and reject anything that escapes it.
- **`geometryBase()` hides text with CSS, it does not remove it.** A base that
  relies on it still *contains* `<text>`, so `chart.hybrid` would treat it as a
  text layer and composite a wordless diagram. The renderer removes the elements;
  the smoke test asserts it.
- **nMedia's `color_scheme` option is accepted and ignored** on `/v1/process/image`
  (measured: byte-identical light and dark requests). The scheme is resolved in the
  SVG (`variantSvg`) before rasterizing.
- **Do not send `size`/`aspect_ratio` with an init image.** The reference defines
  the frame; a size makes some upstreams treat it as authoritative and breaks the
  edit path (same trap as issue #67 in `image.generate`).
- **Edge-label chips belong to the text layer.** `compositeHybrid` strips every
  drawing element, but a `nc-chip` rect exists only to read as a gap in the wire
  behind a word — the wire is drawn whole and the chip is painted over it. Stripped,
  the label sits straight on the hand-drawn line. At denoise 0.3 the model redrew
  the chips itself, so the gap survived by luck; at 0.45 it stopped and the labels
  lost their background. The composite keeps chips, re-inserts them under the type,
  and re-fills them with the **paper colour sampled from the backdrop** — the
  token's fill is the document background, which on warm paper reads as a hole.
- **A textless base cannot be hybridized.** The words are gone; pass the spec or a
  full SVG. The tool says so instead of returning a wordless picture.
- **`uniqueBase` must check both sidecars.** A render writes `<base>.json`, a hybrid
  writes `<base>-hybrid.json`. Checking only the first let two hybrids in the same
  minute land on the same name — the second silently overwrote the first, and a
  re-composite then reused the wrong backdrop.
- **The drift score is a heuristic, not a proof.** It reads ink distribution on a
  16-cell grid, so it catches boxes that moved or vanished, not a subtly wrong
  stroke. A different diagram type (bars, a dense table) can score lower without
  being wrong — the floor is calibrated on `flow-gateway`, and `driftFloor` is
  config for that reason. Trust the score to raise a question, then look.
