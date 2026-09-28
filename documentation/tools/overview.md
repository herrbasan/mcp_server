# Tool Catalog — Overview

Index of every agent and tool in the MCP server, with links to the detailed
reference docs. Last verified 2026-09-22.

Detailed docs live in this folder, one file per system. Shared infrastructure is
documented alongside: `documentation/fileops.md` (root-confined file operations)
and `documentation/html-to-markdown.md` (HTML→CommonMark conversion, used by
`browser.content` `mode: 'markdown'`).

## How tools are invoked

One unified tool: **`tools`**. Every call is
`{ method: "<agent>.<action>", payload: { …args } }` — ALL arguments go inside
`payload`, never top-level. `args.X is required` almost always means wrong
nesting level.

- Transports: `/mcp/compact` (streamable HTTP) and `/sse/compact` +
  `/message/compact` (legacy SSE). Both route identically via the server's
  compact→legacy method map (`COMPACT_TO_LEGACY` in `src/server.js`).
- Every tool returns `{ content: [{ type: "text", text: "…" }], isError? }`.
  Plain objects break compact clients.
- Errors are `isError: true` with the message in `content[0].text` — check it
  before assuming success.
- Loader guarantees: agents load in `dependsOn` topological order; a
  config-advertised tool without an exported handler kills the server at boot
  (`process.exit(1)`); shutdown runs in reverse order. Agents can be disabled
  via `agents.<name>.disabled`.

## The systems

| Agent(s) | Methods | One-liner | Doc |
|---|---|---|---|
| **memory** | `memory.store/recall/get/forget/list/update/overview/embed_heal` | Persistent cross-session memory: nDB store + nVDB vectors, hybrid semantic+lexical recall, knowledge-map overview. | [memory.md](memory.md) |
| **dreaming** | `memory.dream_generate/dream_status/dream_inject` | Consolidation pipeline (every 15 min): clusters, bridges, scores, wildcards. No `dream.*` namespace. | [memory.md](memory.md) |
| **storage** | `storage.*` (18 file ops + `storage.resources_*`) | Root-confined file store (`D:\MCP_Storage`) with snapshots, trash, bulk ops, semantic search, REST + MCP resources. | [storage.md](storage.md) |
| **vdb** | `vdb.search/status/trigger_scan/build_index` | nVDB vector index: watches storage, chunks + LLM-enhances + embeds files every 5 min; owns the memory collection. | [vdb.md](vdb.md) |
| **browser** | `browser.fetch`, `browser.session_*`, `browser.goto/content/click/fill/type/evaluate/scroll/inspect/console/wait` (15) | Persistent headless Chrome (Puppeteer) with idle-timeout session lifecycle, plus `browser.fetch`: one URL in, rendered Markdown written to storage, path returned. | [browser.md](browser.md) |
| **harvest** | `harvest.collect` | Pass 1 of docs harvesting: discover a seed's section, render every page into storage, write a manifest listing every discovered link. No model. | [harvest.md](harvest.md) |
| **research** | `research.topic` | Multi-engine search → scrape → cite-tracked synthesis + confidence evaluation. | [browser.md](browser.md) |
| **forge** | `forge.write/update/read/list/delete/call/stop/history/rollback/help` | Git-versioned custom tools executing in isolated worker threads. | [forge.md](forge.md) |
| **chat** | `chat.create/models/send/inject/list/status/history/update/compact/delete` | Named headless LLM sessions, persisted to disk, full workshop tool access. | [chat.md](chat.md) |
| **llm** | `llm.query`, `llm.session_create/query/close` | One-shot clean-context queries + in-memory pinned sessions. | [llm.md](llm.md) |
| **github** | `git.read/tree/log/commit/diff/branches/repo_info`, `git.search_repos/code/issues`, `git.issue_*`, `git.pr_list/get` (17) | GitHub REST relay (read-heavy; issue writes). Needs `GIT_TOKEN`. | [github.md](github.md) |
| **vision** | `vision.session_create/analyze/get/list/close` | Multi-pass image analysis with region/grid focus, preprocessed via nMedia. | [vision.md](vision.md) |
| **image** | `image.generate` | Image generation via gateway, rendered to webp size variants + JSON sidecar in storage; inline thumbnail in the result. | [image.md](image.md) |
| **inspector** | `inspector.inspect_code` | Whole-file code review through the gateway with the house system prompt. | [inspector.md](inspector.md) |
| **telemetry** | `telemetry.report` | Lab report from localweb2: environment, hardware, alerts, cluster, services + nPM LLM log findings. | [telemetry.md](telemetry.md) |

## Cross-cutting dependencies

- **LLM Gateway** (`ws://localhost:3400`, `http://localhost:3400`) — all model
  traffic: chat (tasks: query, synthesis, analysis, vision, inspect, local,
  dreamer/distiller), embeddings (foreground + background batch), predict.
  Routing is task-based; `chat.models` / `forge.help` / `llm.session_create`
  are the model-discovery points.
- **nMedia** (`http://localhost:3500`) — image crop/optimize for vision.
- **localweb2 / nPM** (`:4445` / `:9333`) — telemetry sources.
- **nDB submodule** (`nDB/`) — native document store (memories). The memory
  agent refuses to boot on a binary older than the v1.3 delta-op index fix.
- **fileops** (`src/lib/fileops.js`) — the shared confinement/snapshot/atomic-
  write engine under storage (and forge ctx). See `documentation/fileops.md`.

## Gotchas register

Things that bite if you don't know them (each detailed in the linked doc):

- Storage utf8 reads return RAW TEXT; a JSON object response is a pointer
  (`inline:false` → HTTP fetch; `truncated:true` → window with offset+length).
  64 KB inline threshold. [storage.md](storage.md)
- `storage.write` is FULL-FILE replacement — for sections use `storage.replace`.
  [storage.md](storage.md)
- Forge `maxTimeout` is 600 000 ms (config), not the 900 000 code default;
  timeouts are idle-based with a 30-min absolute cap. [forge.md](forge.md)
- Chat recursion is cycle-guarded; hop cap 25; `chat.status` is in-memory
  only. [chat.md](chat.md)
- `research.topic`: engines google/duckduckgo only (bing was advertised but
  never supported — removed 2026-09-22); `max_pages` default is 5.
  [browser.md](browser.md)
- Root config `agents.browser.viewport/userDataDir` and the whole
  `agents.research` section are dead config — never read. [browser.md](browser.md)
- `git.search_*` don't validate `query` — an undefined query searches for the
  literal string "undefined". [github.md](github.md)
- The dream map lags memory by up to the 15-minute dreaming cadence — recall
  for anything recent. [memory.md](memory.md)
- Legacy tool names (`storage_read`, `memory_store`, …) still work — the
  server maps them — but `agent.action` form is canonical.
