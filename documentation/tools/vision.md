# Vision — image analysis sessions

Reference documentation for iterative image analysis. Last verified
2026-09-22 against `src/agents/vision/index.js`, `fleeting-memory.js`,
`media-client.js`.

## Can a model see a tool's image? Measured 2026-10-20 — no, on both providers

VS Code 1.142, one session, one MCP server, one tool call:

| Channel | Result |
|---|---|
| Pasted / attached image | **arrives** — verified blind on a file-tree screenshot |
| `image.ingest` PNG block, gateway provider | **nothing** |
| `image.ingest` PNG block, `vizards.deepseek-v4-for-copilot` | **nothing** |
| `view` on a PNG | **nothing** |
| Browser screenshot | **nothing** |

The decisive test: `tree-latency.svg` was rasterized through `media.process` and
ingested — a diagram never described in the session — and none of its labels
("Prefill", "Decode", "Tokenising", "Attention", "Weights", "Context") could be
read. Ground truth afterwards from the SVG. Earlier "it works" readings in this
session were contaminated: the images had already been described by the vision
agent, so the description was memory, not sight.

**Only a user paste is verified to reach the model.** Everything else must assume
it did not.

That also weakens the first version of this note, which blamed the gateway
extension specifically: `herrbasan/llm-gateway-copilot#2` was filed on an A/B where
the deepseek column was never verified blind. The upstream issues are real
(`microsoft/vscode#339600`, `#326276`), but the attribution to one extension is not
established.

Consequence for tool design:

- A tool that reports a picture must never claim it was seen. The text block from
  `image.ingest` says so explicitly.
- For unattended work, the tool looks and returns text. `chart.hybrid` does that
  with `check: true`, and that is the only channel demonstrated to work here.

## What it is

Multi-pass image analysis: load an image once into a session, then ask
questions about it, optionally constraining analysis to a region/grid cell/
crop. Images are preprocessed through nMedia (crop, resize, re-encode) before
reaching the vision model.

## Tools (5)

| Tool | Args | Behavior |
|---|---|---|
| `vision.session_create` | `image_url?` XOR `image_data?`+`image_mime_type?` | URL fetched server-side (placeholder/example.com/undefined URLs rejected with guidance); raw base64 requires the MIME type. Returns `img_<ts>_<rand>` id. |
| `vision.analyze` | `session_id*`, `query?`, `focus?: {text \| grid{cols,rows,cells} \| region{l,t,r,b ∈ [0,1]} \| centerCrop N%}`, `include_context?` (default true) | The analysis pass — see below. |
| `vision.get_session` | `session_id*` | Full dump: timestamps, original dimensions, ALL prior analyses with their focus. |
| `vision.list_sessions` | — | Id + analysis count + created. |
| `vision.close_session` | `session_id*` | Frees the image memory. |

## Analysis pass mechanics

1. **Focus crop** (unless `focus.text` or none): nMedia `POST
   /v1/process/image/crop` — grid → numbered cells, region → fractional box,
   centerCrop → centered N% box. Crop failure → isError `crop_failed`.
   `focus.text` only shapes the prompt, never the pixels.
2. **Model optimization** (always): nMedia `POST /v1/process/image`
   `{max_dimension, format: 'jpeg', quality: 85}`. The max dimension is
   probed at init from the gateway's first vision-capable model
   (`capabilities.imageInputLimit.maxDimension`), overridable via
   `agents.vision.modelLimits['<model>']`; fallback 2048. Failure throws
   `image_optimization_failed` — no silent passthrough.
3. **Gateway chat** (task `vision`) with the image as `image_url` content.
   With `include_context`, all prior descriptions of the session are compiled
   into the prompt (focus-tagged headers) so later passes build on earlier
   ones.
4. The description is stored on the session (`desc_<ts>_<rand>`), so sessions
   accumulate an analysis history.

## Session lifecycle

- In-memory Map (no disk persistence). TTL **30 min idle**
  (`agents.vision.ttlMinutes`); cleanup interval every 60 s.
- nMedia endpoint from root config `nMediaUrl` — the MCP server and nMedia
  run on the same machine, so `http://localhost:3500` is correct here. If
  nMedia is down, session creation still works but analyze fails loud —
  never start/restart the service yourself.
- Known open issue: #44 — `vision.session_create` cannot fetch chat-app
  attachment URLs (401). Feed images by URL only from publicly reachable
  hosts, or pass `image_data` directly.
