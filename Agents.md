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
- **Agents**: `src/agents/` — browser, chart, chat, dreaming, forge, github, harvest, image, inspector, llm, memory, nconvert, print, research, storage, telemetry, vision.
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
- `docs/` — working documents (plans, handovers, notes). (Curated reference docs live in storage under `D:\MCP_Storage\documentation\`, not here.)
- `documentation/` — in-repo reference docs: `fileops.md` (shared file-ops engine), `html-to-markdown.md` (shared HTML→CommonMark converter) and `documentation/tools/` (the full tool catalog — one doc per system plus `tools/overview.md` index).
- `data/` — runtime data: memories (nDB), dream maps, forge tools, storage, VDB index, notepad (nDB + file buckets).
- `data/chat/sessions/` — persistent headless chat sessions (one pretty-printed JSON per session, owned by the `chat` agent).
- `nDB/` — nDB submodule (herrbasan/nDB) — embeddable document database (Rust + napi-rs).
- `src/nCharts` — nCharts submodule (SVG diagrams).
- `src/nui_wc2` — nui_wc2 submodule, canonical MD-Blocks renderer used by the print agent.
- `nConvert/` — nConvert submodule (herrbasan/nConvert) — document → layered Markdown ingest engine (Rust + napi-rs). Spec: `nConvert/docs/SPEC.md`. Agent: `src/agents/nconvert/`; artefacts land in storage `ingest/`.

### nConvert (universal document ingest)

Live formats: txt/csv/tsv/md (validated passthrough)/json/yaml/toml/xml, pdf
(text + deep vision conversion), docx/doc, pptx, xlsx/xlsb/xls, odt/odp/ods,
epub, eml/mbox. Detected-but-pending formats fail loudly with their milestone.

- **MCP tools**: `nconvert.convert` (mechanical inline; deep or >25 MB →
  queued job handle), `nconvert.enqueue` (alias), `nconvert.jobs`,
  `nconvert.job`, `nconvert.cancel`, `nconvert.capabilities`, `nconvert.items`,
  `nconvert.fetch`.
- **Ingest queue** (`src/agents/nconvert/queue.js`): bounded lanes — up to 16
  small mechanical jobs, one deep/large job, and four cloud summary calls by
  default. Summaries and deep vision use DeepSeek Flash with MiniMax M3.1 Flash
  fallback. Native conversion and PDFium rendering use a lazy persistent process
  pool (`nativeProcesses: 16`); deep chunks fan out pages across independent
  PDFium processes and write PNGs directly to artefact storage. Fast lane —
  mechanical calls await their result; deep/large jobs return a queued handle.
  Step-model progress (converting → rendering → vision i/n + coverage → retry →
  summarizing), restart-safe FIFO (`data/nconvert/jobs.json`), sha256 dedup,
  cooperative cancel, REST + SSE.
- **REST + SSE** (dashboard surface): `GET/POST /nconvert/jobs`,
  `GET /nconvert/jobs/:id`, `POST /nconvert/jobs/:id/cancel`, and
  `GET /nconvert/events` (SSE: `queue.snapshot` on connect, then `job.*`).
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
and the hash/read path yields every `scanYieldBudgetMs` (50 ms). Compaction of the
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
