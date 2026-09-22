# Vision — image analysis sessions

Reference documentation for iterative image analysis. Last verified
2026-09-22 against `src/agents/vision/index.js`, `fleeting-memory.js`,
`media-client.js`.

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
