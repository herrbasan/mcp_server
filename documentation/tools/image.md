# Image Tools

Image generation via the LLM Gateway with automatic variant rendering into
MCP storage. Added 2026-09-25.

## Methods

### `image.generate`

`{ prompt*, name?, references?, model?, size?, aspect_ratio?, seed?, extra_body? }`

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
