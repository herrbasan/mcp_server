# Image Tools

Image generation via the LLM Gateway with automatic variant rendering into
MCP storage. Added 2026-09-25.

> **`image.ingest` is unproven: no tool-returned image has been verified to reach
> the model.** Measured 2026-10-20 in VS Code 1.142 — a blind test (a diagram never
> described in the session) could not be read after ingestion on either the
> gateway or the deepseek provider, and `view` on a PNG gave nothing. A **pasted**
> image does reach the model. See `vision.md`. Keep this tool only while it is
> being tested; if the crop/magnify path never proves useful, remove it.

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
`format` defaults to **png**, the block format the client accepts most reliably.

nMedia's limits shape the order of operations: `max_dimension` is a target for an
SVG but only a cap for a bitmap, crop and resize do not combine in one call, and
`region` is fractional internally — so an SVG is rendered at the working size
first, the region is cut from that raster, a bitmap is only ever shrunk, and the
fractions are computed from the source size.

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

**Vector output** — the branch is chosen *per returned image*, sniffed from
`media_type` and, failing that, the decoded bytes (`<svg` in the first 512
bytes), so a model returning a mixed candidate set gets both treatments. For an
SVG the size-variant set and the PNG original are skipped — a vector rescales
losslessly, and the PNG re-encode would replace the real deliverable with a
raster copy. Instead:

```
images/<base>.svg           provider bytes, written verbatim (the deliverable)
images/<base>_preview.webp  raster ≤1280, shrink-only
images/<base>_thumb.webp    raster ≤180, shrink-only
```

`files.svg` reports the SVG's own intrinsic size (root `width`/`height`,
falling back to `viewBox`) — not the preview raster's capped size.

> **No vector model is configured today.** nGen dropped its vector path
> (verified 2026-11-12: `GET /v1/engines` lists only raster models, so the
> gateway's `coolkid-omnisvg` / `coolkid-starvector` entries were removed). The
> branch is retained because the branch is a property of the *payload*, not of a
> model list: any upstream returning SVG still lands here. Historical
> verification (2026-10-16): `coolkid-omnisvg` returned `media_type:
> image/svg+xml` at a fixed 200×200 viewBox for icons and ignored
> `width`/`height`; `coolkid-starvector` took the input image via
> `input_references` and emitted a viewBox matching the reference.

**Image payloads are bytes or URLs.** Most upstreams inline `b64_json`; MiniMax's
H3 models default to `response_format: "url"` and hand back a CDN link, which the
tool fetches itself (60 s timeout, 64 MB cap) before rendering. A `data:` URI is
accepted on either. MiniMax also reports **per-image failures inside a 200** —
`data[]` slots that carry only `error` (content-safety rejections) — so the tool
skips those slots, keeps the images that did come back, and states how many slots
failed. When every slot fails the call throws with the upstream reason rather
than returning an empty success.

**Returns:** text with model, cost and the per-size file list, plus an MCP
image content block with the 1280px variant (`image/webp`) — the largest
derived size, so the inline preview keeps the detail. The caller
copies whichever sizes it needs out of storage — the tool has no downstream
knowledge.

**Image-to-image:** `references` accepts storage paths (relative to storage
root, read and sent as data URIs) or http(s) URLs (passed through; the
gateway fetches them SSRF-safe). Requires an editing-capable model
(`capabilities.editing: true` — `qwen-image`, `coolkid-qwen-image-21`,
`coolkid-minimax-h3-image`, `coolkid-z-image`, `coolkid-krea2`,
`coolkid-ideogram4`, `coolkid-moss-image`); the gateway 422s otherwise. Storage
paths in `references` are also recorded in the sidecar's `lineage` array.

**`n` > 1:** each returned image gets its own output set with a `-2`, `-3`
suffix on the slug and its own sidecar.

## Model notes (2026-11-12)

Cloud — `POST` to the provider, billed per image:

| Model id | Notes |
|---|---|
| `krea-2-image` | Krea 2 Medium Turbo via OpenRouter, ~$0.015, fast; i2i broken upstream |
| `krea-2-large-image` | Krea 2 Large, 2K-capable, ~$0.06 |
| `qwen-image` | Qwen Image 3 via OpenRouter, ~$0.03, t2i + i2i |
| `muse-image` | Meta Muse, cheapest (~$0.01); `aspect_ratio` is bucket-collapsed, `size` is honoured |
| `minimax-h3-image` | MiniMax H3 Image, ~$0.022 (1K) — returns a **URL**, not bytes; `size` must be 655,360–20,000,000 px at 1:3–3:1 and a ratio alongside a `WxH` size is a 400; no `negative_prompt`; edits via `/v1/images/edits` are not wired |

Local — nGen on COOLKID (`http://192.168.0.110:8100/v1`), $0, one job at a time,
and a *different* model is refused with 503 while another has work queued:

| Model id | Notes |
|---|---|
| `coolkid-z-image` | Z-Image Turbo, ~2 s warm; guidance 0.0, steps ~9 |
| `coolkid-krea2` | Same checkpoint as the cloud Krea 2 Turbo — prompt parity without cost |
| `coolkid-ideogram4` | Caption model: JSON layout prompts, best text rendering; no alpha |
| `coolkid-moss-image` | MOSS-Image, JSON layout prompts, 23.5 GB — one-job model |
| `coolkid-qwen-image-21` | Qwen-Image 2.1, native 2K (32 px grid, max 2752); prose not captions; **only model with real alpha** (needs its RGBA wording); for i2i pass `extra_body: { denoise: 0.45 }` — the engine default 1.0 replaces the latent, so an "edit" without `denoise` is a re-render |
| `coolkid-minimax-h3-image` | MiniMax H3 Image, 33B, ~21 s warm at 4 MP; no negative prompt, guidance must be 1; editing is reference conditioning — `references[0]` is `<Picture 1>`, more via `extra_body.reference_images` (16 total), `denoise` stays 1 |

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
