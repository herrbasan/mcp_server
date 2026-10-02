# Media Tools

Deterministic media conversion via nMedia (`POST /v1/process`): storage path
in → rasterize/transcode → storage path out. Added 2026-10-02 (plan:
render-and-inspect, mcp_server — the workshop half of the render→attach→inspect
loop; see `documentation/pathways.md`).

## Methods

### `media.process`

`{ in*, out?, processor?, mode?, options? }`

The bytes never enter any model context — the whole point of putting the
conversion at the MCP layer. The tool resolves the storage path locally, hands
nMedia a path-native job (`input_path`), polls to completion, downloads the
cached asset, and writes it into storage.

**Flow:** `POST /v1/process {input_path, processor, mode?, options}` →
poll `GET /v1/jobs/:id` → `GET /v1/assets/:id/metadata` (dimensions) +
`GET /v1/assets/:id` (bytes) → `fs.writeFileSync` into storage → re-stat
verify. Jobs complete in ~0.3 s for SVG raster; the poll deadline is
`agents.media.timeoutMs` (default 120 s) — on timeout the error names the job
URL (jobs and assets persist ~1 h).

**Processor inference** from the input extension: image (`.svg .png .jpg
.webp .gif .avif .bmp .tif .ico .heic`), audio (`.mp3 .m4a .wav .flac .ogg
.opus`), video (`.mp4 .mov .mkv .webm .avi .m4v`). Explicit `processor`
overrides. Video takes `mode`: `extract_keyframes` (default — returns the
first frame as JPEG), `extract_audio`, `transcode`. Every mode yields exactly
one output asset.

**Output format** comes from the `out` extension and must agree with
`options.format` when both are given (mismatch → loud error). Valid image
outs: png/jpg/webp/avif/gif; audio: mp3/m4a/wav/flac/ogg/opus; video:
mp4/webm/mkv. Default `out`: `temp/<input basename>.<png|mp3|mp4>`. Image
default: `max_dimension: 2000`.

**Returns** `{ out, bytes, width, height, ms, assetId }` as JSON text.
`out` is storage-relative with forward slashes — feed it straight to the
chat app's `image_attach`, `storage.read`, or a `/storage/` URL.

**Blank-render guard:** the PNG output is decoded in-process (zlib; all four
scanline filters, gray/RGB/palette/alpha, 8-bit) and checked for pixel
uniformity. A raster where EVERY pixel is identical — or a 0-byte one — is
refused, not written, with the raster-unsafe-styling explanation. This is the
exact failure class of nMedia job #3 (2026-10-02): SVGs themed via
`@media (prefers-color-scheme: dark)` rasterized to solid fills with invisible
text. Style diagrams with explicit presentation attributes (CSS may override
them in the browser only) so a render can never come back blank. The guard is
best-effort by design: formats it cannot decode (JPEG/WebP output, interlaced
or 16-bit PNG) are skipped with a logged trace — it refuses only what it can
prove. Note the converse is NOT caught: partial invisibility (some elements
vanish, others survive) is non-uniform and passes — that is what raster-safe
styling is for.

**Loud failures:** missing input, non-file input, path escape, unknown
extension, processor/mode/format disagreements, nMedia job failure (error text
passed through verbatim), verify mismatch after write.

## Config

Top-level `nMediaUrl` (default `http://localhost:3500`, shared with the image
agent); storage root from `agents.storage.root` (missing → agent refuses to
init).

`config.json → agents.media`:

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `120000` | Job poll deadline |
| `pollIntervalMs` | `400` | Poll cadence |

## Not built (deliberate)

`media.describe` (plan §A.2) — the description channel. A description is not
sight; the vision agent already covers unattended description, and the chat
app's `image_attach` covers the real look. If it is ever wanted, it belongs
behind an explicit flag so nobody confuses the two channels.
