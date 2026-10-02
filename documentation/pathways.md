# Pathways — how the parts interoperate

The workshop is a set of execution contexts with different capabilities. Most
 confusion comes from treating them as one place. This document formalizes the
 pathways between them: which hand-offs exist, which are forbidden, and the
 rules that keep them safe. Companion to the tool catalog (`tools/overview.md`).
 Established 2026-10-02 with the render-and-inspect work.

## The three contexts

- **CONTEXT A — MCP server** (workshop, port 3100): storage, memory, forge,
  media, vision, browser, GitHub, … Filesystem access, gateway access, no
  pixels-in-context (tool results are text; the MCP wire is size-capped).
- **CONTEXT B — Forge worker** (inside `forge.call`): isolated worker thread.
  `ctx.payload` (Buffers), `ctx.gateway`, `ctx.storagePath` only. No MCP tools,
  no chat state, no browser. An MCP relay exists for some methods but must not
  be load-bearing — plan data flow at the top level instead.
- **CONTEXT C — Chat app backend** (LLM-Gateway-Chat, port 8080): builds each
  model request from history. Reads the storage box from disk directly
  (`storage_*`, `image_attach` native tools). The ONLY place that can put
  pixels into the model's context.

## The interchange is the storage box

Every cross-context hand-off goes through `D:\MCP_Storage` as a path — never
through a model context, never as inline bytes over a wire:

```
forge worker ──writes──▶ storage ◀──reads── workshop tools (A)
                            ▲
                            │ reads from disk
                    chat backend (C) ──▶ image parts in the next request
```

- Forge output lands in `ctx.storagePath` (→ `D:\MCP_Storage`); the result
  names the path. Callers fetch or attach it; the worker never relays.
- Workshop tools (`media.process`, `image.generate`, `browser.fetch`) are
  storage-in → storage-out by contract; results name paths.
- The chat backend resolves paths server-side — no byte crosses the MCP wire.

## Pathway 1 — render → attach → inspect (the closed loop)

A model that draws should look at its own drawing. Since 2026-10-02:

1. **Render**: `media.process { in: "blog/x/images/diagram.svg",
   out: "temp/diagram.png" }` (CONTEXT A). Raster-safe styling is a
   prerequisite — explicit presentation attributes on elements; CSS overrides
   for the browser only. The blank-render guard refuses single-colour rasters.
2. **Attach**: `image_attach { path: "temp/diagram.png" }` (CONTEXT C, native).
   Real image content parts in the next request — sight, not description.
3. **Fix**: the model sees the render and corrects the source; re-render,
   re-attach (two paths per call allow before/after comparison).

Transiency contract: attached images live for the current RUN (all hops of
 it), then stop riding requests. The stub text persists with the source path —
 a later turn re-attaches deliberately. The UI keeps showing what was attached
 (`toolImagesStripped` flag; `runner._stripTransientToolImages`).

Rules (non-negotiable):
- **Explicit calls only.** A URL or path in prose never auto-attaches; otherwise
  any fetched page could make the model ingest images.
- **Storage-box paths only** for `image_attach`; no remote URLs, no data URLs.
  A model-authored URL must never become a fetch-and-execute primitive.
- **Bounded**: ≤ 2 images per call, ≤ 4 MB each, auto-downscale above 2048 px
  (via nMedia).
- **SVG is refused** — rasterize first (`media.process`); SVG is text, and
  renderers treat it as executable.

## Pathway 2 — describe ≠ see

Two different channels, never conflate them:

- **Sight** (Pathway 1): image content parts. Multimodal input, the model does
  the looking. Requires a vision-capable substrate.
- **Description**: the vision agent (`vision.session_create/analyze`) — a
  second model describes an image (from a storage path or URL) in text. Works
  for non-vision substrates and unattended runs; lossy by nature.

The chat's auto-vision flow (runner `_ensureVisionAnalysis`) is the bridge for
user attachments on non-vision models. There is deliberately no
`media.describe` in the workshop — a description behind a generic name invites
the confusion this section exists to prevent.

## Pathway 3 — chat ⇄ storage ⇄ forge

- Chat → storage: `attachment_save` (bucket URL → storage path),
  `storage_write/replace/append`.
- Storage → chat display: `/storage/<path>` proxy (cookie-auth'd) or
  markdown `![](/storage/...)` inline images.
- Storage → forge: pass paths in `forge.call payload` (resolved to Buffers);
  forge → storage via `ctx.storagePath`.

## Open pathways (not built)

- **VS Code Copilot**: reaches CONTEXT A only (`/sse/compact`). Render works
  (`media.process`); pixels-into-context has no pathway — Copilot's MCP tool
  results are text-only. Attach remains chat-native.
- **Cross-session re-attach**: the stub names the path; a future inline
  "@attach" reference syntax could let users re-attach without the model
  re-deriving. Not needed yet.
