# MCP Server Workshop — LLM Briefing

**Project**: `mcp_server` (herrbasan/mcp_server)
**Purpose**: Centralized MCP server running as an independent HTTP service. Meta-MCP with nested agent modules.
**Prime directive**: `D:\MCP_Storage\documentation\Workshop\Agents_Prime.md` (in storage) — read this first on every session.
**Tool reference**: `D:\MCP_Storage\documentation\Workshop\workshop.md` (in storage) — full tool catalog and usage patterns.

> **Documentation is a storage citizen.** The `documentation` agent was removed (2026-07-25). All curated docs live under `D:\MCP_Storage\documentation\` and are indexed by the VDB `storage` collection (folder `documentation`). Access them with `storage.read`/`storage.write` (paths like `documentation/Workshop/workshop.md`) and `vdb.search` (folder `documentation`). There is no separate documentation endpoint.

## Architecture

- **Entry point**: `src/server.js` — HTTP server on port 3100.
- **Transport**: Per-session SSE mapped by `sessionId`.
- **Gateway client**: `src/gateway-client.js` — WebSocket to central LLM Gateway at localhost:3400.
- **Agents**: `src/agents/` — browser, chart, chat, codereview, dreaming, forge, github, harvest, image, inspector, llm, memory, nconvert, notepad, print, research, storage, telemetry, vision.
- **Loader**: `src/agent-loader.js` — loads agents and registers tools.
- **Config**: `config.json` (non-sensitive) + `.env` (sensitive).

## Important Conventions

- **Vanilla JS only** (ES modules). No TypeScript. No unnecessary abstractions.
- **Fail fast, fail loud**: no silent fallbacks, no defensive defaults.
- **Use IDE file tools** for edits; do not use terminal scripts to modify files.
- **Absolute paths only** for file references in tools (`D:\...` or `\\server\share\...`).
- **Local git state wins**: never pull/fetch/rebase/merge/reset/checkout over uncommitted changes without explicit user approval.

## MCP Endpoints

The server exposes the single unified `tools` tool on two transports (the legacy per-tool endpoints were removed 2026-08-04):

- **`/mcp/compact`** — streamable HTTP. For modern MCP clients.
- **`/sse/compact`** + **`/message/compact`** — legacy SSE transport. For VS Code Copilot and older SSE-only clients.

Both route all agent methods via `agent.action` (e.g. `storage.write`, `memory.recall`).

## Adding a New Tool

1. Create agent under `src/agents/<name>/`:
   - `config.json` with `agent`, `description`, `tools[]`
   - `index.js` exporting `init(context)` + one handler per tool
2. Add defaults to `config.json` under `agents.<name>` if needed.
3. Wire into `src/server.js`:
   - Add methods to `COMPACT_TOOL` description.
   - Add `agent.action` → `legacy_tool_name` mappings in `COMPACT_TO_LEGACY`.
4. Restart server **and reconnect every client**. A client copies the tool
   description when it connects, so a newly registered agent is invisible to a
   session that was already open — it will answer "Unknown method" for a method
   the server has. `methods.list` returns the live registry, which is how you tell
   "not registered" apart from "stale client copy".

## Tool Handler Return Format

All handlers must return:

```javascript
{ content: [{ type: 'text', text: '...' }], isError: false }
```

Plain objects cause compact-endpoint clients to fail with `r.content is not iterable`.

## Gateway Client

Use task-based routing. Examples:

```javascript
const gateway = createGatewayClient(wsUrl, httpUrl);
await gateway.chat({ task: 'query', messages: [...], systemPrompt: '...' });
await gateway.embedText('query');
```

Model routing is handled by the Gateway. Do not rely on a `models` section in `config.json`.

## Key Directories

- `src/` — server, gateway client, agent loader, agents.
- `src/agents/` — agent implementations.
- `src/upload.js` — upload handoff: `POST /upload` streams bytes to
  `data/uploads/<id>/<name>` and returns the absolute path any path-taking tool
  consumes directly; `/nconvert/upload` reuses the same writer. Spec:
  `docs/upload-handoff-spec.md`, reference: `documentation/tools/upload.md`,
  tests: `npm run test:upload`.
- `src/agents/codereview/` — Prime-Directive code review agent (spec: `docs/codereview-spec.md`, reference: `documentation/tools/codereview.md`). JavaScript AST + Rust structural tier-0 analysis; **every snapshotted text file** (code, config, docs, data, extensionless) stays model-review eligible, with generic tier-0 coverage explicitly reported. Tier-1/tier-2 model pipeline with a bias validator; orchestrator timeout/JSON failure returns a persisted PARTIAL report with completed findings instead of discarding them; snapshots under `data/codereview/`; automated acceptance gate is JavaScript-only and refuses other languages loudly; tests: `npm run test:codereview`.
- `docs/` — working documents (plans, handovers, notes). (Curated reference docs live in storage under `D:\MCP_Storage\documentation\`, not here.)
- `documentation/` — in-repo reference docs: `fileops.md` (shared file-ops engine), `html-to-markdown.md` (shared HTML→CommonMark converter) and `documentation/tools/` (the full tool catalog — one doc per system plus `tools/overview.md` index).
- `data/` — runtime data: memories (nDB), dream maps, forge tools, storage, VDB index, notepad (nDB + file buckets).
- `data/chat/sessions/` — persistent headless chat sessions (one pretty-printed JSON per session, owned by the `chat` agent).
- `nDB/` — nDB submodule (herrbasan/nDB) — embeddable document database (Rust + napi-rs).
- `src/nCharts` — nCharts submodule (SVG diagrams).
- `src/nui_wc2` — nui_wc2 submodule, canonical MD-Blocks renderer used by the print agent.
### nConvert (universal document ingest)

**The engine is not in this repo.** Conversion, job records and the artefact
folders belong to `nteligence-server` (`D:\DEV\nTeligence`); the tools below are
an HTTP proxy to it (`agents.nconvert.serviceUrl`, default
`http://127.0.0.1:3300`) and keep their names, arguments and response shapes.
The `nConvert/` submodule, its N-API build, the ingest queue and the native
process pool were removed from mcp_server on 2026-11-11 — do not reintroduce
them here. Engine spec: `nTeligence/nConvert/docs/SPEC.md`; backend plan:
`nTeligence/docs/rust-backend-plan.md`.

Lane status (2026-11-11): **mechanical is live** for every format the engine
supports — txt/csv/tsv/md (validated passthrough), json/yaml/toml/xml, pdf text,
docx/doc, pptx, xlsx/xlsb/xls, odt/odp/ods, epub, eml/mbox, rtf. `depth: "deep"`,
OCR of scans/standalone images, `nconvert.summarize` (L0) and `nconvert.verify`
(audit) are not implemented in the service yet: each answers with an explicit
refusal naming what is missing, never a silent downgrade to mechanical output.
An unreachable service is a loud error naming the URL and the start command.

- **MCP tools**: `nconvert.convert` / `nconvert.enqueue` (mechanical inline;
  identical bytes with the same settings reuse the item, `force: true`
  reconverts), `nconvert.jobs`, `nconvert.job` (`since`, `activityLimit`),
  `nconvert.cancel`, `nconvert.capabilities`, `nconvert.items`,
  `nconvert.fetch`, `nconvert.summarize`, `nconvert.verify`.
- **Artefact**: a self-contained item under storage `ingest/<id>/` —
  `original.<ext>` (provenance), `document.md` (L1 MD-Blocks + conversion
  frontmatter), `meta.json` (detection verdict, stats, ALL warnings),
  `item.json` (manifest), `assets/` (extracted binaries). The folder relocates
  as a unit.
- **NUI UX** (`/nconvert`): source harness with drag/drop upload and server paths,
  live route totals + timed steps + filterable decision log, and NUI-rendered
  L0/L1 results with layer links. Uploads use raw octet-stream bodies under the
  existing input cap and are cleaned at completion. MCP submit/job responses carry
  structured `ui` actions (`/nconvert?job=…` or `?item=…`), so an LLM can open the
  progress/result surface directly. Files: `ui-api.js`, `ui.html`, `ui.js`, `ui.css`.
- **REST + SSE** (dashboard surface): `GET/POST /nconvert/jobs`,
  `GET /nconvert/jobs/:id` (`?since=N`), `POST /nconvert/jobs/:id/cancel`,
  `POST /nconvert/upload`, `GET /nconvert/items/:id`,
  `GET /nconvert/events` (SSE: `queue.snapshot` on connect, then `job.*`), and
  `GET /files/<path>` — a proxy to the engine's artefact namespace, which stays
  same-origin for the review UI (the service binds loopback).
- **Tests**: `npm run test:nconvert` runs `nconvert-service-smoke.mjs` (the MCP
  proxy against a live service) and `nconvert-ux-test.mjs` (page, upload, item
  payload, `/files` proxy). Both require nTeligence to be running.
- Operator doc: `documentation/tools/nconvert.md`; handover:
  `docs/nconvert-handover.md`. The MCP server is nPM service
  `agent_orchestrator` — restart via
  `POST http://192.168.0.100:9333/api/services/agent_orchestrator/restart`
  (permitted for this project).
- `tests/` — benchmarks and quick tests.
- `_Archive/` — archived modules and old plans.

### Print (MD-Blocks → PDF)

- **MCP tools**: `print.render` (NUI → Chromium PDF + exact PDFium page previews)
  and `print.preview` (rasterize selected pages of an existing PDF).
- **PDFium** left this repo with the nConvert engine: `agents.print.pdfiumModule`
  and `agents.print.pdfiumPath` name the addon and its DLLs inside the engine
  installation. Both are required at startup, so a missing addon stops the agent
  with the path in the message rather than failing the first preview.
- **Visual page editor**: path-based `print.render` results advertise a structured
  `ui` action (`Edit page breaks`, `/print?path=…`, `mode: preview`) so chat can
  open the editor from the tool bubble; inline-markdown renders omit it. At
  `/print?path=vita/vita_ai_change_manager_v4.md`, the editor shows exact PDF
  pages and breaks them on the paper itself — hovering a page reveals a
  line and handle at each semantic target's real vertical position; clicking sets
  that break and clears any other within 2.5% of a page height. Targets are
  sections, blocks, columns **and paragraphs** (content-addressed `p-<hash>`
  IDs; boxed presets are excluded so a break cannot tear a card). Break-only changes
  reuse the session's loaded Chromium page (~1 s); style/format/orientation/
  section-per-page reload it (~2.5 s). Changes rerender
  non-destructively; Save writes `print.breakBefore`/`print.breakAfter` plus the
  visible design options to frontmatter. Target geometry comes from nConvert
  `searchText` reading absolute-positioned marker spans out of the PDF text
  layer (page **and** y), not from DOM guesses.
- **Hosted editor lifecycle events** (#74): the chat parent may append an opaque
  `hostInstanceId` and exact `parentOrigin` to `/print`. When that origin is in
  `agents.print.parentOrigins`, the editor posts `saved` and `closed`
  `workshop-app` messages to that parent only. `saved` fires after the source
  write and verification render, with path/new SHA/pdfUrl; save success never
  depends on host notification, and notification failure is reported separately.
  The editor never learns the chat conversation id or calls the chat backend.
  `/print` sends a route-scoped CSP `frame-ancestors` for the same configured
  origins; other routes are unchanged. Headless `print.render` has no events.
- Canonical renderer: `src/nui_wc2` submodule (`nui.util.markdownToHtml`), not a
  second Markdown implementation. Semantic `breakBefore`/`breakAfter` IDs
  (caller or frontmatter), source `preset=page-break`, and section-per-page are
  supported.
- Editorial/minimal/classic profiles; larger type gets lighter. Full four-edge
  bleed chrome with automatic inset/gap sizing and native `{{page}}`/`{{pages}}`.
- Full contract and examples: `documentation/tools/print.md`.
  Validation: `npm run test:print`.

## Memory System (nDB + nVDB)

The `memory` agent uses a two-database architecture (mirrors the LLM Gateway Chat app):

- **nDB** (`data/memories/data.jsonl`, database-as-a-folder) — document store for memory metadata. O(1) lookups, indexed queries (`category`, `id`, `embedStatus`), append-only JSONL persistence, soft-delete via tombstones. Loaded via `src/agents/memory/ndb-loader.js` (native binary from `nDB/` submodule).
- **nVDB** (`data/nvdb/`, `memory` collection) — vector index for embedding search. The memory agent accesses the VDB agent's nVDB instance via `dependsOn: "vdb"` and `vdbAgent.getCollection('memory')`.

The legacy `data/memories.json` (37MB, inline embeddings) is kept as a cold backup and vector source for backfill. It is no longer read or written by the memory agent at runtime.

The dreaming agent accesses memories via `memoryAgent.memories.iter()` (with fallback to `.memories` array for backward compatibility).

## Notepad (deliberate state)

The `notepad` agent (`src/agents/notepad/`, own nDB at `data/notepad/`) stores
ideas (pins), tasks with flat step checklists, important dates (optionally
yearly recurring), contacts, and file attachments (nDB bucket, SHA-256 dedup).
It is deliberate state — NOT memory; don't merge the two. Two boards
(`owner: david | machine`); registry-validated contexts; `body` long-payload
delivered only via `notepad.get`.

- **MCP tools**: `notepad.add/list/get/update/complete/remove/promote/attach/snapshot`
  + `notepad.context_add/contexts/context_rename/context_remove`.
- **`notepad.snapshot`** is the Today view (optional per-context project-start
  view / overdue / due-soon / open tasks with step progress / upcoming dates /
  recent ideas / stale pins / context footer), computed on read. Session-start
  priming reads this; project work starts with `snapshot(context)` (pin check).
- **REST API** on the same server: `/notepad/items*`, `/notepad/snapshot`,
  `/notepad/files/:hash.:ext`, `/notepad/items/:id/attachments` (raw upload),
  `/notepad/contexts*`. Consumed by the shared notepad component (localweb
  dashboard + chat app).
- **Boundary**: the dreaming system and background automation never touch the
  notepad — mutations only via explicit `notepad.*` calls from David or an
  active session. Stale pins are surfaced, never auto-archived.
- Details: `documentation/tools/notepad.md` (spec: `scratch/notepad-proposal.md`).

## VDB Indexing

The `vdb` agent indexes text files from the storage root (`agents.storage.root`, which includes `documentation/`) for semantic search. Exclusions work at two levels:

- **Config-level**: `agents.vdb.ignore` in `config.json` lists directory/file names to skip everywhere.
- **Directory-level**: any watched directory may contain a `.nvdb_ignore` file with one pattern per line (`name`, `*`, or simple globs like `*.tmp`). Patterns apply to entries in that directory only.

Current default ignores: `forge` (transient forge tool output), `temp` (fleeting user temp files).

**Scans must not block the event loop.** Enumeration is `fs.promises.readdir` (a
recursive `readdirSync` over ~9.7k files stalled every HTTP request for ~20 s),
and the hash/read path yields every `scanYieldBudgetMs` (50 ms). Embedding
persists each file as soon as all of its chunks complete, so a later batch
failure cannot discard earlier files; failures name the pending file list.
Compaction of the
segment files runs **only when a scan produced tombstones** (`removed`/`updated`
> 0), tracked by `data/nvdb/compaction-pending` so it survives a restart — an
unconditional compact rewrote the 104 MB segment every five minutes for no
change. Measured after both fixes: steady-state scan <1 s, and p95 latency 2 ms
while a scan runs (previously 13–20 s).

## Running

```bash
npm start       # production
npm run dev     # watch mode
```

Bind `HOST=0.0.0.0` in `.env` for remote access.

## Useful Links

- Prime directive: `D:\MCP_Storage\documentation\Workshop\Agents_Prime.md`
- Tool reference: `D:\MCP_Storage\documentation\Workshop\workshop.md`
- LLM Gateway WebSocket API: `docs/LLM_GATEWAY_WEBSOCKET_API.md`
- LLM Gateway REST API: `docs/LLM_GATEWAY_REST_API.md`
