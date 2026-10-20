# Image Tools

Image generation via the LLM Gateway with automatic variant rendering into
MCP storage. Added 2026-09-25.

> **`image.ingest` does not work in VS Code (measured 2026-10-20).** The tool
> builds a correct PNG image block and the MCP client validates and accepts it —
> no warning — and the model still receives nothing. WebP blocks are refused
> outright (`MCP image omitted — MIME type unsupported`). Images the user
> **pastes** into a message do reach the model, so the gap is the host's handling
> of tool results, not the block. Do not design a verification loop around
> returning images from a tool here; run the vision check inside the tool and
> return text, which is what `chart.hybrid` does.

## Methods

### `image.ingest`

`{ source* | sources*, max_dimension?, format?, quality?, region?, upscale?, label? }`

Returns an existing image as an MCP image block so a caller can look at it.
Bounded: ≤4 sources, 24 MB per source, ≤4 MB of base64 per block (halved again
rather than truncated), and paths resolved against the storage root plus
`agents.image.ingestRoots` — without that, it is an arbitrary-file-read tool.

`region {x,y,w,h}` crops in **source pixels**, before any resize; it is for
reading one label band of a chart at a time. `upscale` is honoured for SVG (nMedia
re-renders it larger) and refused for bitmaps, which the metadata says out loud.
`format` defaults to **png** because that is the only block the VS Code client
accepts.

nMedia's limits shape the order of operations: `max_dimension` is a target for an
SVG but only a cap for a bitmap, crop and resize do not combine in one call, and
`region` is fractional internally — so an SVG is rendered at the working size
first, the region is cut from that raster, a bitmap is only ever shrunk, and the
fractions are computed from the source size.

**It does not give a model sight in VS Code** — see the warning at the top.

### `image.generate`

`{ prompt*, name?, references?, model?, size?, aspect_ratio?, seed?, extra_body? }`

`size` (`"WxH"`) is forwarded upstream as exact pixel dimensions
(`width`/`height` + `size`, never snapped or discarded) — 4K requests arrive
as 4K and custom ratios (e.g. `1920x960`) keep their composition.
`aspect_ratio` (`"W:H"`) is a composition preset validated against the
model's declared ratios; when given alongside `size` the explicit resolution
is preserved and the ratio rides along as metadata.

Calls the gateway's `POST /v1/images/generations` (synchronous, model of
`type: "image"` or the default `imagegen` task when `model` is omitted),
then renders the result through nMedia into a fixed set of webp sizes, the
lossless PNG original, and writes everything to storage under `images/`.

**Output naming** — base = `YYYYMMDD_HHMM_<slug>` (local server time; slug
from `name` or the first 6 prompt words; `-2`, `-3` … on collision):

```
images/<base>_full.webp    transcode at source resolution (shrink-only cap 10000)
images/<base>_1920.webp    longest-edge downscale, shrink-only
images/<base>_1280.webp
images/<base>_720.webp
images/<base>_180.webp     thumbnail
images/<base>_full.png     lossless PNG original (#58) — for platforms that
                           reject webp (YouTube thumbnails/logos/banners)
images/<base>.json         sidecar: prompt, model, request params, references,
                           lineage, usage/cost, per-file width/height/bytes
```

The PNG original is written in addition to the webp set: when the provider
returns PNG (the normal case) those bytes are written untouched with the
dimensions read from the IHDR chunk; any other source format gets one
nMedia re-encode to PNG under the same shrink-only cap as `full`. In the
sidecar's `files` map it appears under the `png` key alongside the size
keys.

**Vector output (OmniSVG, StarVector)** — the branch is chosen *per returned
image*, sniffed from `media_type` and, failing that, the decoded bytes
(`<svg` in the first 512 bytes), so a model returning a mixed candidate set
gets both treatments. For an SVG the size-variant set and the PNG original are
skipped — a vector rescales losslessly, and the PNG re-encode would replace the
real deliverable with a raster copy. Instead:

```
images/<base>.svg           provider bytes, written verbatim (the deliverable)
images/<base>_preview.webp  raster ≤1280, shrink-only
images/<base>_thumb.webp    raster ≤180, shrink-only
```

`files.svg` reports the SVG's own intrinsic size (root `width`/`height`,
falling back to `viewBox`) — not the preview raster's capped size. Verified
2026-10-16 against nGen: `coolkid-omnisvg` returns `media_type: image/svg+xml`
at a fixed 200×200 viewBox for icons (it ignores `width`/`height`);
`coolkid-starvector` returns `editing: true` and takes the input image via
`input_references`, emitting a viewBox matching the reference. Note omnisvg can
return several candidates, some raster — the `n`-suffixes and per-image branch
handle that. Neither nGen model exposes a `GET /v1/models` endpoint (404).

**Returns:** text with model, cost and the per-size file list, plus an MCP
image content block with the 1280px variant (`image/webp`) — the largest
derived size, so the inline preview keeps the detail. The caller
copies whichever sizes it needs out of storage — the tool has no downstream
knowledge.

**Image-to-image:** `references` accepts storage paths (relative to storage
root, read and sent as data URIs) or http(s) URLs (passed through; the
gateway fetches them SSRF-safe). Requires an editing-capable model
(`capabilities.editing: true`, e.g. `qwen-image-3` via OpenRouter); the
gateway 422s otherwise. Storage paths in `references` are also recorded in
the sidecar's `lineage` array.

**`n` > 1:** each returned image gets its own output set with a `-2`, `-3`
suffix on the slug and its own sidecar.

## Config

`config.json → agents.image`:

| Key | Default | Meaning |
|---|---|---|
| `folder` | `images` | Storage subfolder for output |
| `sizes` | `[1920, 1280, 720, 180]` | Downscale variants (plus implicit `full`) |
| `quality` | `85` | webp quality for all variants |
| `timeoutMs` | `300000` | Gateway generation timeout (image gen takes 1–2 min) |
| `defaultSize` | `1920x1440` | Request size when the caller gives neither `size` nor `aspect_ratio` — 4:3 at 2K, crops well to both 16:9 and 1:1 |

Gateway HTTP URL + access key come from `config.gateway`; nMedia URL from
top-level `nMediaUrl`; storage root from `agents.storage.root` (missing →
agent refuses to init).

## Dependencies

- **Gateway** `POST /v1/images/generations` — returns `b64_json` (PNG).
- **nMedia** `POST /v1/process/image` — base64-in/base64-out, shrink-only
  `max_dimension`, formats jpeg/png/webp/avif/gif. ⚠️ The deployed service
  (`D:\SRV\nMedia`) mounts at `/v1/process`, the older `D:\DEV\MediaService`
  checkout mounts at `/v1/optimize` — they are different codebases.
- **Storage** — files written directly via `fs` into `agents.storage.root`
  (same pattern as forge outputs), not through the storage tool layer.
