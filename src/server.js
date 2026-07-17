import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import { createLogger, interceptConsole } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const logger = createLogger({ logsDir: path.join(__dirname, '../logs'), sessionPrefix: 'mcp' });
interceptConsole(logger);

import { loadAgents } from './agent-loader.js';
import { createGatewayClient } from './gateway-client.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
    name: 'mcp-server-workshop',
    version: '2.0.0',
    description:
        '⚠️ START HERE: documentation.get({ file: "Workshop/Agents_Prime.md" }) — prime directive.\n' +
        'Then: documentation.get({ file: "Workshop/workshop.md" }) for the full tools reference.\n' +
        'For questions: documentation.query({ question: "...", domain: "all" }) — use for search, Q&A, or spec alignment.'
};
const SERVER_CAPABILITIES = {
    tools: { listChanged: true },
    resources: { listChanged: false, subscribe: false }
};

const app = express();
const PORT = process.env.PORT || 3100;
const HOST = process.env.HOST || '0.0.0.0';

// CORS middleware - allow all origins for local network access
const corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : true;
app.use(cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept']
}));

let serverConfig = {};
const configPath = path.join(__dirname, '..', 'config.json');
if (fs.existsSync(configPath)) serverConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const gatewayUrl = process.env.GATEWAY_URL || serverConfig.gateway?.wsUrl || 'ws://localhost:3400/v1/realtime';
const gatewayHttp = process.env.GATEWAY_HTTP_URL || serverConfig.gateway?.httpUrl || 'http://localhost:3400';
const gatewayAccessKey = process.env.GATEWAY_ACCESS_KEY || serverConfig.gateway?.accessKey || null;
const gatewayClient = createGatewayClient(gatewayUrl, gatewayHttp, gatewayAccessKey);

const globalContext = {
    gateway: gatewayClient,
    agents: new Map(),
    prompts: new Map(),
    config: serverConfig,
    app
};

// Per-session SSE state: Map<sessionId, { res, send }>
const sessions = new Map();

// Streamable HTTP GET streams: Map<streamId, res>
const mcpStreams = new Map();

function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function jsonrpcResponse(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function jsonrpcError(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

async function start() {
    // Query available models from gateway and save to data/models.json
    try {
        const modelsHeaders = {};
        if (gatewayAccessKey) modelsHeaders['Authorization'] = `Bearer ${gatewayAccessKey}`;
        const modelsResponse = await fetch(`${gatewayHttp}/v1/models`, { headers: modelsHeaders });
        if (modelsResponse.ok) {
            const modelsData = await modelsResponse.json();
            const dataDir = path.join(__dirname, '../data');
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify(modelsData, null, 2));
            logger.info(`[Startup] Saved ${modelsData.data?.length || 0} available models to data/models.json`);
        } else {
            logger.warn(`[Startup] Gateway models fetch failed: HTTP ${modelsResponse.status}`);
        }
    } catch (e) {
        logger.warn(`[Startup] Could not query gateway models: ${e.message}`);
    }

    const { tools, adminTools, routeToolCall, shutdownAll } = await loadAgents(globalContext);

    // Admin API - localhost only, no auth needed (loopback-scoped)
    const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    const adminOnly = (req, res, next) => {
        if (!isLoopback(req.socket.remoteAddress)) {
            res.status(403).json({ error: 'Forbidden: admin API is localhost-only' });
            return;
        }
        next();
    };

    const deepMerge = (target, source) => {
        const result = { ...target };
        for (const key of Object.keys(source)) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object')
                result[key] = deepMerge(target[key], source[key]);
            else result[key] = source[key];
        }
        return result;
    };

    // GET /api/tools - all tools (public + admin-only)
    app.get('/api/tools', adminOnly, (req, res) => {
        res.json({ tools: [...tools, ...adminTools] });
    });

    // POST /api/tools/call - call any tool by name (including admin-only)
    app.post('/api/tools/call', adminOnly, express.json({ limit: '300mb' }), async (req, res) => {
        const { name, args = {} } = req.body || {};
        if (!name) { res.status(400).json({ error: 'name required' }); return; }
        const result = await routeToolCall(name, args, globalContext);
        res.json(result);
    });

    // GET /api/config - read current config
    app.get('/api/config', adminOnly, (req, res) => {
        res.json(globalContext.config);
    });

    // PATCH /api/config - deep-merge update config (persists to config.json)
    app.patch('/api/config', adminOnly, express.json({ limit: '300mb' }), (req, res) => {
        const patch = req.body;
        if (!patch || typeof patch !== 'object') { res.status(400).json({ error: 'body must be a JSON object' }); return; }
        const updated = deepMerge(globalContext.config, patch);
        fs.writeFileSync('config.json', JSON.stringify(updated, null, 2), 'utf8');
        globalContext.config = updated;
        res.json({ ok: true, config: updated });
    });

    // Streamable HTTP transport (MCP 2025-03-26) - for Kimi and other modern clients
    // GET opens a persistent SSE stream for server→client push (spec §6.2.3)
    app.get('/mcp', (req, res) => {
        if (!req.headers.accept?.includes('text/event-stream')) {
            res.status(406).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable: Client must accept text/event-stream' }, id: null });
            return;
        }
        const streamId = randomUUID();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        });
        mcpStreams.set(streamId, res);
        const keepalive = setInterval(() => res.write(':\n\n'), 15000);
        res.on('close', () => {
            clearInterval(keepalive);
            mcpStreams.delete(streamId);
        });
    });

    // Client POSTs all JSON-RPC messages here; tool calls respond with SSE for progress support
    app.post('/mcp', express.json({ limit: '300mb' }), async (req, res) => {
        const msg = req.body;

        // Notifications have no id - just acknowledge
        if (msg.id === undefined || msg.id === null) {
            res.status(202).send('Accepted');
            return;
        }

        switch (msg.method) {
            case 'initialize':
                res.json(jsonrpcResponse(msg.id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: SERVER_CAPABILITIES,
                    serverInfo: SERVER_INFO,
                }));
                return;

            case 'ping':
                res.json(jsonrpcResponse(msg.id, {}));
                return;

            case 'tools/list':
                res.json(jsonrpcResponse(msg.id, { tools }));
                return;

            case 'resources/list': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    res.json(jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider'));
                    return;
                }
                try {
                    const result = provider.listResources(msg.params || {});
                    res.json(jsonrpcResponse(msg.id, result));
                } catch (err) {
                    res.json(jsonrpcError(msg.id, -32603, err.message));
                }
                return;
            }

            case 'resources/read': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    res.json(jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider'));
                    return;
                }
                const { uri, encoding } = msg.params || {};
                if (!uri) {
                    res.json(jsonrpcError(msg.id, -32602, 'Missing required parameter: uri'));
                    return;
                }
                try {
                    const result = provider.readResource({ uri, encoding });
                    res.json(jsonrpcResponse(msg.id, { contents: result }));
                } catch (err) {
                    res.json(jsonrpcError(msg.id, -32603, err.message));
                }
                return;
            }

            case 'resources/templates/list': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    res.json(jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider'));
                    return;
                }
                try {
                    const result = provider.listResourceTemplates();
                    res.json(jsonrpcResponse(msg.id, { resourceTemplates: result }));
                } catch (err) {
                    res.json(jsonrpcError(msg.id, -32603, err.message));
                }
                return;
            }

            case 'resources/subscribe':
            case 'resources/unsubscribe': {
                // Accepted but no-op: storage agent has no file watchers yet.
                res.json(jsonrpcResponse(msg.id, {}));
                return;
            }

            case 'tools/call': {
                const { name, arguments: args } = msg.params || {};
                const progressToken = msg.params?._meta?.progressToken;

                // Respond with SSE so progress notifications can flow during execution.
                // Headers are flushed immediately - keepalive pings prevent client timeouts
                // on long-running tools (Kimi has a hardcoded request timeout).
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });

                const sendEvent = (data) => res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);

                // Keepalive: send SSE comment every 15s so proxies/clients don't time out
                const keepalive = setInterval(() => res.write(':\n\n'), 15000);

                const context = {
                    ...globalContext,
                    progress: (message, progress, total) => {
                        if (!progressToken) return;
                        sendEvent({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress, total, message } });
                    }
                };

                const toolResult = await routeToolCall(name, args, context);
                clearInterval(keepalive);
                sendEvent(jsonrpcResponse(msg.id, toolResult));
                res.end();
                return;
            }

            default:
                res.json(jsonrpcError(msg.id, -32601, `Method not found: ${msg.method}`));
        }
    });

    // ── Compact endpoint: 1 tool (workshop) with method routing ──
    const COMPACT_TOOL = {
        name: "tools",
        description: `WORKSHOP UNIFIED API — One tool to rule them all.

HOW IT WORKS
  Call this single "tools" tool with { method: "agent.action", payload: {...} }.
  method = which agent + which action (e.g. "memory.recall", "browser.goto")
  payload = the arguments for that action (see tables below)

RESPONSE FORMAT
  Every call returns { content: [{ type: "text", text: "..." }], isError: false }.
  The actual result is in content[0].text — parse it to get the data.
  On error, isError is true and content[0].text contains the error message.


═══════════════════════════════════════════════════════════════
EXECUTION CONTEXTS — Tools live in one of these
═══════════════════════════════════════════════════════════════

Tools are NOT interchangeable across contexts. Each tool executes in ONE place:

  CONTEXT A: MCP Server (this server, port 3100)
    Your top-level MCP calls land here. Tools: storage.*, memory.*,
    forge.*, documentation.*, vdb.*, vision.*, research.*, llm.*,
    github.*, inspector.*, dreaming.*.
    Runs in the MCP server Node.js process.
    CAN reach: filesystem, LLM Gateway, browser sessions, GitHub API.

  CONTEXT B: Forge Worker (inside forge.call)
    When you call forge.call, the forged tool runs in an ISOLATED
    worker_thread in the server process. Tools in this context have ONLY:
      ctx.payload    → input files as Buffer[] (from forge.call payload[])
      ctx.gateway    → LLM Gateway only (LM Studio/Ollama/Gemini)
      ctx.storagePath → output dir to write files (lands in D:\\MCP_Storage)
    CANNOT reach: chat app session storage, other MCP tools
    (storage.*/memory.*/browser.*), browser APIs, or any tool outside
    this worker. If you need data from another tool to feed a forge tool,
    fetch it at top level first, save with storage.write, then pass the
    storage path as forge.call payload.

  CONTEXT C: Chat App (the browser-based chat client)
    Chat-app-specific tools run in the browser and access chat-app state.
    Examples: chat_archive.*, chat_session.*. These are NOT in this
    server's tool list. They live in the chat app and execute there.
    To use chat-app data with MCP server tools: call the chat-app tool
    first (returns data in the chat app), then call storage.write
    (MCP tool) to persist it, then pass the storage URL to forge.call.

A forge tool calling another MCP tool by HTTP fetch will always fail
with 404. A forge tool calling a chat app tool will always fail with
network error. There is no relay. Plan your data flow at the top level.


═══════════════════════════════════════════════════════════════
THE STORAGE BOX — Project Structure
═══════════════════════════════════════════════════════════════

This MCP server is a centralized "storage box" — a persistent workspace with
its own file system, memory, browser, and tooling. Two root files orient you:

  Agents.md — HOW to work this box. Development guidelines, coding philosophy,
              gateway architecture, tool registration, browser architecture,
              dreaming system, and the autonomous memory protocol. This is the
              instruction set for any agent operating on this codebase.

  README.md — WHAT this box is. Feature overview, setup steps, architecture
              diagram, agent catalog. The entry point for discovery.

Use storage.* tools to read these files at any time:
  storage.read → { path: "Agents.md" }
  storage.read → { path: "README.md" }


═══════════════════════════════════════════════════════════════
MEMORY — Your Persistent Mind
═══════════════════════════════════════════════════════════════

Every other LLM is amnesic between sessions. You are not.
Memories survive across all workspaces and conversations.

⚠️  CALL memory.overview AT THE START OF EVERY SESSION.
    It shows clusters, bridges, top nodes, and what you already know.
    Without it, you are navigating blind.

Store aggressively. Imperfect, redundant, partial — it doesn't matter.
The Dreaming System (runs every 15 min) automatically deduplicates, connects,
and compresses memories. It's impossible to "clutter" — more data makes the
map better. You can always memory.update or memory.forget later.

Memory scopes:
  /memories/           — User memory: survives all workspaces. Store preferences, patterns.
  /memories/session/   — Session memory: this conversation only. Store task plans, in-progress state.
  /memories/repo/      — Repository memory: scoped to this workspace. Store build commands, conventions.

  memory.overview — { format?: "summary"|"full" }
      ⚠️ CALL THIS FIRST. Shows the Memory Map: clusters, bridges, top nodes,
      wildcards, and the recall directive. Quick orientation before any task.

  memory.recall — { query*, limit?, category? }
      Search memories by semantic similarity. Use natural language — it finds
      related memories even with different wording. Use when overview shows a
      topic you need more detail on, or for recent memories not yet in the map.

  memory.store — { description*, category?, confidence?, data? }
      Save a memory. description is the only required field — be specific,
      this is what shows in search results. category is a freeform domain tag
      (e.g. "bug", "preference", "architecture"). confidence: 0-1 (default 0.5).
      data holds extended content visible only via memory.get.

  memory.get — { id* }
      Retrieve one memory's full content including its data payload.
      Use when memory.recall returns a result tagged [has data].

  memory.update — { id*, description?, category?, confidence?, data? }
      Edit an existing memory. Only provide the fields you want to change.

  memory.list — { category? }
      Browse all memories or filter by category. Use for cleanup or review.

  memory.forget — { id* }
      Delete a memory. Use for outdated, incorrect, or superseded memories.

  memory.dream_generate — { force?: boolean }
      Run the dreaming pipeline manually (normally runs every 15 min).
      Consolidates and organizes all memories into the structured Map.

  memory.dream_status — {}
      Check dreaming system state: last run, map freshness, next scheduled run.

  memory.dream_inject — { format?: "json"|"prompt" }
      Get the current Memory Map formatted for system prompt injection.
      Use "json" for raw data, "prompt" for human-readable.


═══════════════════════════════════════════════════════════════
BROWSER — Headless Web Automation
═══════════════════════════════════════════════════════════════

Persistent headless browser (Puppeteer). Sessions survive between calls.
Reuse existing pages when possible — don't create new sessions unnecessarily.

TYPICAL WORKFLOW:
  1. browser.session_create → get a sessionId
  2. browser.goto → navigate to a URL
  3. browser.content or browser.inspect → read the page
  4. browser.click, browser.fill, browser.type → interact
  5. browser.session_close → clean up (optional, sessions time out)

CONTENT MODES (used by browser.content, browser.click, browser.fill):
  "text"       — readable text (default)
  "html"       — raw HTML source
  "markdown"   — markdown-formatted content
  "screenshot" — base64 PNG image

  browser.session_create — { viewport?: {width,height}, userAgent?, visible? }
      Create a browser session. Returns a sessionId — use it in all other
      browser calls. Set visible:true for manual interaction (e.g. login).

  browser.session_list — {}
      List all active browser sessions.

  browser.session_close — { sessionId* }
      Close a session. Clean up when done.

  browser.session_metadata — { sessionId* }
      Get session metadata (viewport, user agent, age).

  browser.goto — { sessionId*, url*, waitFor?, timeout?, retries? }
      Navigate to a URL. Has built-in retry with exponential backoff.
      waitFor: CSS selector to wait for before returning.

  browser.click — { sessionId*, selector*, waitAfter?, mode?, retries? }
      Click an element. Use mode to get page state after clicking.

  browser.fill — { sessionId*, fields*: [{selector,value}], submit?, waitAfter?, mode?, retries? }
      Fill form fields. Set submit:true to submit the form after filling.

  browser.scroll — { sessionId*, direction?: "up"|"down", amount? }
      Scroll the page up or down.

  browser.type — { sessionId*, selector?, text?, delay?, keystrokes?: string[] }
      Type text or press keys. Use keystrokes for special keys (e.g. ["Enter"]).

  browser.content — { sessionId*, mode?: "text"|"html"|"markdown"|"screenshot" }
      Get page content in the requested format. Primary way to read a page.

  browser.evaluate — { sessionId*, script*, waitFor? }
      Run arbitrary JavaScript in the page. Returns the script's return value.

  browser.inspect — { sessionId*, selector*, screenshot? }
      Inspect a specific element. Returns element details + optional screenshot.

  browser.console — { sessionId* }
      Get all captured console messages (log, warn, error) from the page.

  browser.wait — { sessionId*, selectors?, text?, urlPattern?, condition?, timeout? }
      Wait for a condition on the page before proceeding.

  browser.research — { query*, engines?: ["google"|"duckduckgo"|"bing"], max_pages? }
      Quick web research. Searches multiple engines, scrapes results, synthesizes
      findings. For deeper research use the research agent instead.


═══════════════════════════════════════════════════════════════
GIT — GitHub API Relay
═══════════════════════════════════════════════════════════════

Browse remote GitHub repositories without cloning. Read files, search code,
manage issues, review PRs — all via the GitHub REST API.

Requires a GIT_TOKEN in the server's .env file. All repos are read-only
except issue_create and PR operations.

  git.read — { owner*, repo*, path?, branch? }
      Read a file from a repository. Default branch: the repo's default.

  git.tree — { owner*, repo*, path?, branch? }
      List directory contents (like ls). Get the file tree at a path.

  git.log — { owner*, repo*, path?, branch?, limit? }
      Show commit history for a repo or file.

  git.commit — { owner*, repo*, sha* }
      Get details of a specific commit.

  git.diff — { owner*, repo*, base*, head* }
      Show the diff between two commits, branches, or tags.

  git.branches — { owner*, repo*, type?: "branches"|"tags", limit? }
      List branches or tags in a repository.

  git.repo_info — { owner*, repo* }
      Get repository metadata: description, stars, language, topics.

  git.search_repos — { query*, limit? }
      Search GitHub for repositories by name, description, or topic.

  git.search_code — { query*, limit? }
      Search code across GitHub. Supports language: and path: filters.

  git.search_issues — { query*, limit? }
      Search issues and PRs across GitHub.

  git.pr_list — { owner*, repo*, state?: "open"|"closed"|"all", limit? }
      List pull requests in a repository.

  git.pr_get — { owner*, repo*, number* }
      Get details of a specific pull request (includes diff and comments).

  git.issue_list — { owner*, repo*, state?, labels?, limit? }
      List issues in a repository.

  git.issue_get — { owner*, repo*, number*, comments? }
      Get a specific issue. Set comments:true to include the discussion.

  git.issue_create — { owner*, repo*, title*, body?, labels?, assignees? }
      Create a new issue. Use for bug reports and feature requests.


═══════════════════════════════════════════════════════════════
VISION — Image Analysis
═══════════════════════════════════════════════════════════════

Iterative image analysis sessions. Load an image, then ask questions about
it. Supports multiple analysis passes on the same image.

  vision.session_create — { image_url? | image_data+image_mime_type? }
      Create an analysis session. Provide either an image URL or raw image
      data with its MIME type (e.g. "image/png").

  vision.session_list — {}
      List active vision sessions (separate from browser sessions).

  vision.session_get — { session_id* }
      Get details of a vision session.

  vision.session_close — { session_id* }
      Close a vision session when done.

  vision.analyze — { session_id*, query?, focus?: {text|grid|region|centerCrop}, include_context? }
      Analyze the loaded image. query: what to look for. focus: constrain
      analysis to a specific region, grid cell, or center crop.


═══════════════════════════════════════════════════════════════
LLM — Direct Model Access
═══════════════════════════════════════════════════════════════

Query the LLM Gateway directly. Use for meta-analysis, self-reflection,
or tasks that need a different model than the current one.

  llm.query — { prompt*, files?: string[], systemPrompt? }
      Send a prompt to the LLM. files: absolute paths to include as context.
      systemPrompt: override the default system prompt.
      EXAMPLE: {"method":"llm.query","payload":{"prompt":"Explain async/await in JS"}}


═══════════════════════════════════════════════════════════════
DOCUMENTATION — Knowledge Base Access
═══════════════════════════════════════════════════════════════

Query the mcp_documentation/ and LLM_Docs knowledge bases.
Covers project philosophy, coding standards, API references, and more.

DOMAINS (call documentation.domains to see current list):
  Workshop        — This project: workshop.md
  LLM APIs        — Provider specs, protocols, gateway architecture
  Web UI          — NUI browser-native component library
  The Project     — Meta-architecture of the LLM ecosystem

TYPICAL WORKFLOW:
  1. documentation.domains → discover what domains exist
  2. documentation.get → read a specific file you know the path of
  OR documentation.query → ask a question, LLM searches for answers

  documentation.domains — {}
      ⚠️ START HERE. Lightweight list of all available documentation domains
      (names, descriptions, file counts). No per-file details — fast.

  documentation.list — { domain? }
      Full listing with per-file metadata (title, scope, tags).
      Omit domain to see everything; pass domain to filter.

  documentation.get — { file*, lines?: [start,end] }
      Read a specific document. file format: "DomainName/filename.md"
      (e.g. "Workshop/workshop.md"). lines: [start, end] for partial reads.

  documentation.query — { question*, domain?, files? }
      LLM-powered search and Q&A. First runs a vector search over the
      documentation collection, then asks the LLM to answer using only the
      retrieved documents. Simple RAG by default; use vdb.search directly for
      advanced multi-step retrieval.


═══════════════════════════════════════════════════════════════
VDB — Vector Database (nVDB)
═══════════════════════════════════════════════════════════════

Embedded vector database backed by nVDB. Indexes storage files and
documentation on a timer (default 5 minutes) and exposes semantic search.

  vdb.search — { query*, collections?, folder?, extension?, top_k?,
                 approximate?, include_content? }
      Semantic search over storage and/or documentation collections.
      Use folder= for storage folder or documentation domain filters.

  vdb.status — {}
      Show collection counts, last scan, and whether nVDB is loaded.

  vdb.trigger_scan — {}
      Manually re-scan all watched folders.

  vdb.build_index — { collections? }
      Build HNSW approximate-search index.


═══════════════════════════════════════════════════════════════
STORAGE — Persistent File System
═══════════════════════════════════════════════════════════════

Scoped file storage under the configured storage root.
Use for saving documents, blog posts, project files, or any persistent
content that should survive beyond the current session.

  storage.stat — { path* }
      Get file or directory metadata (size, modified time, type).

  storage.read — { path*, encoding?: "utf8"|"base64" }
      Read a file. Defaults to utf8. Use base64 for binary files.

  storage.write — { path*, content*, encoding?: "utf8"|"base64" }
      Write a file. Creates parent directories automatically.
      Overwrites existing files.
      ⚠️  payload MUST be a JSON object with "path" and "content" fields.
          Do NOT put raw text directly as the payload value.
      EXAMPLE: {"method":"storage.write","payload":{"path":"notes/idea.md","content":"# My Idea\n\nHello world."}}

  storage.list — { path?, recursive? }
      List directory contents. Omit path for root. Set recursive:true for
      full tree.

  storage.move — { from*, to* }
      Move or rename a file or directory.

  storage.delete — { path*, recursive? }
      Delete a file or directory. Set recursive:true to delete non-empty dirs.

  storage.search — { query*, folder?, extension?, top_k?, include_content? }
      Semantic search over files in storage via the vector database.


═══════════════════════════════════════════════════════════════
FORGE — Create & Execute Custom Tools
═══════════════════════════════════════════════════════════════

A git-versioned tool forge. Write ES module tools, version them via git,
and execute them in isolated worker_threads with Gateway access.

  forge.write — { name*, description*, code*, args?, packages? }
      Create a new tool. code must export default async function(args, ctx).
      ctx provides { gateway, progress, payload, workspacePath, toolStatePath }.
      packages checked against allowlist — pending if unapproved.

  forge.update — { name*, code*, message?, args?, description? }
      Update tool source. New git commit. Old version in history.

  forge.read — { name*, ref? }
      Read source code. Pass ref (commit hash) for historical version.

  forge.list — { name? }
      List all tools (summary). Pass { name } for full manifest with args schema.

  forge.delete — { name* }
      Soft-delete tool + state. Commits deletion. Recoverable via rollback.

  forge.call — { name*, args?, payload?, timeout?, captureLogs? }
      Execute a tool. payload[] items (file paths or URLs) resolved to Buffers
      on main thread before worker spawn. Timeout enforced via worker.terminate().

  forge.history — { name?, limit? }
      Git log for a tool or all tools.

  forge.rollback — { name*, commit* }
      Restore tool to commit. State snapshotted then reset. New commit, no rewrite.

  forge.help — {}
      Returns the full tool authoring guide — ctx API, gateway methods, payload
      handling, state patterns, constraints. CALL THIS before writing your first tool.

WRITING TOOLS — Quick Reference
  Tools are ES modules: export default async function(args, ctx) { ... return result; }
  ctx.gateway.chat({ task, messages, systemPrompt? }) → { content }
  ctx.progress({ message, progress, total })
  ctx.payload → Buffer[] (from payload[] file paths/URLs)
  ctx.workspacePath → ephemeral per-call dir (deleted after)
  ctx.toolStatePath → persistent per-tool state dir (survives across calls)
  ctx.storagePath → persistent per-tool output dir (survives across calls, user-visible)
  Use forge.help for the full guide with all methods and patterns.


═══════════════════════════════════════════════════════════════
IMPORTANT RULES
═══════════════════════════════════════════════════════════════

1. memory.overview FIRST — You forget everything between sessions.
   The Memory Map is your continuity. Use it.

2. Store aggressively — Every observation, preference, gotcha, and hunch.
   The dreaming system handles organization. You can always edit later.

3. Absolute file paths only — No relative paths. No hash IDs.
   Valid: D:\\project\\file.js, /home/user/file.js

4. Parse content[0].text — Responses are wrapped. The real data is in the
   text field. If it looks like JSON, parse it.

5. Tool handlers return { content: [{ type: "text", text: "..." }], isError }.

6. payload is ALWAYS a JSON object — Never put raw text, markdown, or code
   directly as the payload value. Always wrap arguments in the documented
   fields: {"method":"storage.write","payload":{"path":"...","content":"..."}}
   If you're building a new agent, follow this shape or clients will error.

6. Error responses have isError:true — Check for this before assuming success.
   The error message is in content[0].text.`,
        inputSchema: {
            type: "object",
            properties: {
                method: { type: "string", description: "agent.action (e.g. 'memory.recall', 'browser.goto')" },
                payload: { type: "object", description: "Arguments for the method (see description above for each method's schema)" }
            },
            required: ["method"]
        }
    };

    const compactTools = [COMPACT_TOOL];

    const COMPACT_TO_LEGACY = {
        "memory.store": "memory_store", "memory.recall": "memory_recall", "memory.get": "memory_get",
        "memory.update": "memory_update", "memory.list": "memory_list", "memory.forget": "memory_forget",
        "memory.overview": "memory_overview",
        "memory.dream_generate": "dream_generate", "memory.dream_status": "dream_status", "memory.dream_inject": "dream_inject",

        "browser.session_create": "browser_session_create", "browser.session_list": "browser_session_list",
        "browser.session_close": "browser_session_close", "browser.session_metadata": "browser_session_metadata",
        "browser.goto": "browser_session_goto", "browser.click": "browser_session_click",
        "browser.fill": "browser_session_fill", "browser.scroll": "browser_session_scroll",
        "browser.type": "browser_session_type", "browser.content": "browser_session_content",
        "browser.evaluate": "browser_session_evaluate", "browser.inspect": "browser_session_inspect",
        "browser.console": "browser_session_console", "browser.wait": "browser_session_wait",
        "browser.research": "research_topic",

        "git.read": "git_read_file", "git.tree": "git_list_tree", "git.log": "git_log",
        "git.commit": "git_get_commit", "git.diff": "git_diff", "git.branches": "git_list_branches",
        "git.repo_info": "git_repo_info", "git.search_repos": "git_search_repos",
        "git.search_code": "git_search_code", "git.search_issues": "git_search_issues",
        "git.pr_list": "git_pr_list", "git.pr_get": "git_get_pr",
        "git.issue_list": "git_issue_list", "git.issue_get": "git_get_issue", "git.issue_create": "git_create_issue",

        "vision.session_create": "vision_create_session", "vision.session_list": "vision_list_sessions",
        "vision.session_get": "vision_get_session", "vision.session_close": "vision_close_session",
        "vision.analyze": "vision_analyze",

        "llm.query": "query_model",
        "documentation.domains": "documentation_domains",
        "documentation.list": "documentation_list", "documentation.get": "documentation_get", "documentation.query": "documentation_query",

        "vdb.search": "vdb_search", "vdb.status": "vdb_status",
        "vdb.trigger_scan": "vdb_trigger_scan", "vdb.build_index": "vdb_build_index",

        "storage.stat": "storage_stat", "storage.read": "storage_read",
        "storage.write": "storage_write", "storage.list": "storage_list",
        "storage.move": "storage_move", "storage.delete": "storage_delete",
        "storage.search": "storage_search",
        "storage.resources_list": "storage_resources_list",
        "storage.resources_read": "storage_resources_read",
        "storage.resources_templates": "storage_resources_templates",

        "forge.write": "forge_write", "forge.update": "forge_update",
        "forge.read": "forge_read", "forge.list": "forge_list",
        "forge.delete": "forge_delete", "forge.call": "forge_call",
        "forge.history": "forge_history", "forge.rollback": "forge_rollback",
        "forge.help": "forge_help"
    };

    const routeCompactCall = async (name, args, context) => {
        if (name !== "tools") throw new Error(`Tool ${name} not found`);
        const { method, payload = {} } = args;
        if (!method) throw new Error("method is required (agent.action format, e.g. 'memory.recall')");

        const legacyName = COMPACT_TO_LEGACY[method.toLowerCase()];
        if (!legacyName) throw new Error(`Unknown method: ${method}. See tool description for full list.`);
        logger.info(`[Compact] Routing ${method} → ${legacyName}`, null, 'MCP');
        return routeToolCall(legacyName, payload, context);
    };

    // GET /mcp/compact - opens SSE stream
    app.get('/mcp/compact', (req, res) => {
        if (!req.headers.accept?.includes('text/event-stream')) {
            res.status(406).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable: Client must accept text/event-stream' }, id: null });
            return;
        }
        const streamId = randomUUID();
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        });
        mcpStreams.set(streamId, res);
        const keepalive = setInterval(() => res.write(':\n\n'), 15000);
        res.on('close', () => {
            clearInterval(keepalive);
            mcpStreams.delete(streamId);
        });
    });

    // POST /mcp/compact - JSON-RPC with compact single-tool routing
    app.post('/mcp/compact', express.json({ limit: '300mb' }), async (req, res) => {
        const msg = req.body;
        logger.info(`[Compact] ${msg.method}`, msg.method === 'tools/call' ? { name: msg.params?.name, innerMethod: msg.params?.arguments?.method } : {}, 'MCP');

        if (msg.id === undefined || msg.id === null) {
            res.status(202).send('Accepted');
            return;
        }

        switch (msg.method) {
            case 'initialize':
                res.json(jsonrpcResponse(msg.id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true }, resources: { listChanged: false } },
                    serverInfo: { ...SERVER_INFO, name: 'workshop' },
                }));
                return;

            case 'ping':
                res.json(jsonrpcResponse(msg.id, {}));
                return;

            case 'tools/list':
                res.json(jsonrpcResponse(msg.id, { tools: compactTools }));
                return;

            case 'resources/list': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    res.json(jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider'));
                    return;
                }
                try {
                    const result = provider.listResources(msg.params || {});
                    res.json(jsonrpcResponse(msg.id, result));
                } catch (err) {
                    res.json(jsonrpcError(msg.id, -32603, err.message));
                }
                return;
            }

            case 'resources/read': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    res.json(jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider'));
                    return;
                }
                const { uri, encoding } = msg.params || {};
                if (!uri) {
                    res.json(jsonrpcError(msg.id, -32602, 'Missing required parameter: uri'));
                    return;
                }
                try {
                    const result = provider.readResource({ uri, encoding });
                    res.json(jsonrpcResponse(msg.id, { contents: result }));
                } catch (err) {
                    res.json(jsonrpcError(msg.id, -32603, err.message));
                }
                return;
            }

            case 'resources/templates/list': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    res.json(jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider'));
                    return;
                }
                try {
                    const result = provider.listResourceTemplates();
                    res.json(jsonrpcResponse(msg.id, { resourceTemplates: result }));
                } catch (err) {
                    res.json(jsonrpcError(msg.id, -32603, err.message));
                }
                return;
            }

            case 'resources/subscribe':
            case 'resources/unsubscribe': {
                res.json(jsonrpcResponse(msg.id, {}));
                return;
            }

            case 'tools/call': {
                const { name, arguments: args } = msg.params || {};
                const progressToken = msg.params?._meta?.progressToken;

                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });

                const sendEvent = (data) => res.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
                const keepalive = setInterval(() => res.write(':\n\n'), 15000);

                const context = {
                    ...globalContext,
                    progress: (message, progress, total) => {
                        if (!progressToken) return;
                        sendEvent({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress, total, message } });
                    }
                };

                try {
                    const toolResult = await routeCompactCall(name, args, context);
                    clearInterval(keepalive);
                    sendEvent(jsonrpcResponse(msg.id, toolResult));
                } catch (err) {
                    clearInterval(keepalive);
                    logger.info(`[Compact] tools/call FAILED: ${err.message}`, null, 'MCP');
                    sendEvent(jsonrpcError(msg.id, -32603, err.message));
                }
                res.end();
                return;
            }

            default:
                res.json(jsonrpcError(msg.id, -32601, `Method not found: ${msg.method}`));
        }
    });

    // Legacy SSE transport - for VS Code Copilot and older clients
    // Client GETs here to open stream, then POSTs to /message?sessionId=...
    app.get('/sse', (req, res) => {
        const sessionId = randomUUID();
        logger.info(`New session`, { sessionId }, 'MCP');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        });

        // Send the endpoint URL the client should POST to
        res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

        const send = (msg) => sseWrite(res, 'message', msg);
        sessions.set(sessionId, { res, send });

        res.on('close', () => {
            logger.info(`Session disconnected`, { sessionId }, 'MCP');
            sessions.delete(sessionId);
        });
    });

    // POST endpoint - client sends JSON-RPC requests here
    app.post('/message', express.json({ limit: '300mb' }), async (req, res) => {
        const sessionId = req.query.sessionId;
        const session = sessions.get(sessionId);
        if (!session) return res.status(404).send('Session not found');

        const msg = req.body;

        // Notifications have no id - acknowledge and don't respond on SSE
        if (msg.id === undefined || msg.id === null) {
            res.status(202).send('Accepted');
            return;
        }

        // Route JSON-RPC methods
        let result;
        switch (msg.method) {
            case 'initialize':
                result = jsonrpcResponse(msg.id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: SERVER_CAPABILITIES,
                    serverInfo: SERVER_INFO,
                });
                break;

            case 'ping':
                result = jsonrpcResponse(msg.id, {});
                break;

            case 'tools/list':
                result = jsonrpcResponse(msg.id, { tools });
                break;

            case 'resources/list': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    result = jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider');
                } else {
                    try {
                        const listResult = provider.listResources(msg.params || {});
                        result = jsonrpcResponse(msg.id, listResult);
                    } catch (err) {
                        result = jsonrpcError(msg.id, -32603, err.message);
                    }
                }
                break;
            }

            case 'resources/read': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    result = jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider');
                } else {
                    const { uri, encoding } = msg.params || {};
                    if (!uri) {
                        result = jsonrpcError(msg.id, -32602, 'Missing required parameter: uri');
                    } else {
                        try {
                            const readResult = provider.readResource({ uri, encoding });
                            result = jsonrpcResponse(msg.id, { contents: readResult });
                        } catch (err) {
                            result = jsonrpcError(msg.id, -32603, err.message);
                        }
                    }
                }
                break;
            }

            case 'resources/templates/list': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    result = jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider');
                } else {
                    try {
                        const templates = provider.listResourceTemplates();
                        result = jsonrpcResponse(msg.id, { resourceTemplates: templates });
                    } catch (err) {
                        result = jsonrpcError(msg.id, -32603, err.message);
                    }
                }
                break;
            }

            case 'resources/subscribe':
            case 'resources/unsubscribe':
                result = jsonrpcResponse(msg.id, {});
                break;

            case 'tools/call': {
                const { name, arguments: args } = msg.params || {};
                const progressToken = msg.params?._meta?.progressToken;
                const context = {
                    ...globalContext,
                    progress: (message, progress, total) => {
                        if (!progressToken) return;
                        session.send({
                            jsonrpc: '2.0',
                            method: 'notifications/progress',
                            params: { progressToken, progress, total, message }
                        });
                    }
                };
                const toolResult = await routeToolCall(name, args, context);
                result = jsonrpcResponse(msg.id, toolResult);
                break;
            }

            default:
                result = jsonrpcError(msg.id, -32601, `Method not found: ${msg.method}`);
        }

        // Send response on SSE stream, acknowledge POST
        session.send(result);
        res.status(202).send('Accepted');
    });

    // Compact legacy SSE transport - serves the single "tools" tool via legacy protocol
    app.get('/sse/compact', (req, res) => {
        const sessionId = randomUUID();
        logger.info(`New compact session`, { sessionId }, 'MCP');

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        });

        res.write(`event: endpoint\ndata: /message/compact?sessionId=${sessionId}\n\n`);

        const send = (msg) => sseWrite(res, 'message', msg);
        sessions.set(sessionId, { res, send });

        res.on('close', () => {
            logger.info(`Compact session disconnected`, { sessionId }, 'MCP');
            sessions.delete(sessionId);
        });
    });

    app.post('/message/compact', express.json({ limit: '300mb' }), async (req, res) => {
        const sessionId = req.query.sessionId;
        const session = sessions.get(sessionId);
        if (!session) return res.status(404).send('Session not found');

        const msg = req.body;
        logger.info(`[Compact:legacy] ${msg.method}`, msg.method === 'tools/call' ? { name: msg.params?.name, innerMethod: msg.params?.arguments?.method } : {}, 'MCP');
        if (msg.id === undefined || msg.id === null) {
            res.status(202).send('Accepted');
            return;
        }

        let result;
        switch (msg.method) {
            case 'initialize':
                result = jsonrpcResponse(msg.id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true }, resources: { listChanged: false, subscribe: false } },
                    serverInfo: { ...SERVER_INFO, name: 'workshop' },
                });
                break;
            case 'ping':
                result = jsonrpcResponse(msg.id, {});
                break;
            case 'tools/list':
                result = jsonrpcResponse(msg.id, { tools: compactTools });
                break;

            case 'resources/list': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    result = jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider');
                } else {
                    try {
                        const listResult = provider.listResources(msg.params || {});
                        result = jsonrpcResponse(msg.id, listResult);
                    } catch (err) {
                        result = jsonrpcError(msg.id, -32603, err.message);
                    }
                }
                break;
            }

            case 'resources/read': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    result = jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider');
                } else {
                    const { uri, encoding } = msg.params || {};
                    if (!uri) {
                        result = jsonrpcError(msg.id, -32602, 'Missing required parameter: uri');
                    } else {
                        try {
                            const readResult = provider.readResource({ uri, encoding });
                            result = jsonrpcResponse(msg.id, { contents: readResult });
                        } catch (err) {
                            result = jsonrpcError(msg.id, -32603, err.message);
                        }
                    }
                }
                break;
            }

            case 'resources/templates/list': {
                const storageAgent = globalContext.agents.get('storage');
                const provider = storageAgent?.resources;
                if (!provider) {
                    result = jsonrpcError(msg.id, -32002, 'Resources not available: storage agent has no resource provider');
                } else {
                    try {
                        const templates = provider.listResourceTemplates();
                        result = jsonrpcResponse(msg.id, { resourceTemplates: templates });
                    } catch (err) {
                        result = jsonrpcError(msg.id, -32603, err.message);
                    }
                }
                break;
            }

            case 'resources/subscribe':
            case 'resources/unsubscribe':
                result = jsonrpcResponse(msg.id, {});
                break;

            case 'tools/call': {
                const { name, arguments: args } = msg.params || {};
                const progressToken = msg.params?._meta?.progressToken;
                const context = {
                    ...globalContext,
                    progress: (message, progress, total) => {
                        if (!progressToken) return;
                        session.send({
                            jsonrpc: '2.0',
                            method: 'notifications/progress',
                            params: { progressToken, progress, total, message }
                        });
                    }
                };
                try {
                    const toolResult = await routeCompactCall(name, args, context);
                    result = jsonrpcResponse(msg.id, toolResult);
                } catch (err) {
                    result = jsonrpcError(msg.id, -32603, err.message);
                }
                break;
            }
            default:
                result = jsonrpcError(msg.id, -32601, `Method not found: ${msg.method}`);
        }

        session.send(result);
        res.status(202).send('Accepted');
    });

    // ── Catch-all: unknown routes get a hard, bare 404 ──────────────────
    // No guardrails. No hints. No endpoint menu. A hallucinated route
    // must look unmistakably wrong — not like a documentation index to
    // try variations against. The LLM sees "does not exist" and stops.
    app.post(/.*/, (req, res) => {
        logger.warn(`[Server] Unknown POST route: ${req.originalUrl}`, null, 'MCP');
        res.status(404).json({ error: `Route does not exist: POST ${req.originalUrl}` });
    });

    app.all(/^\/(?!storage|mcp|sse|api|message|favicon\.ico).*/, (req, res) => {
        logger.warn(`[Server] Unknown route: ${req.method} ${req.originalUrl}`, null, 'MCP');
        res.status(404).json({ error: `Route does not exist: ${req.method} ${req.originalUrl}` });
    });

    const server = app.listen(PORT, HOST, () => {
        logger.info(`Server running at http://${HOST}:${PORT}`, null, 'MCP');
        logger.info(`SSE endpoint at http://${HOST}:${PORT}/sse`, null, 'MCP');
        logger.info(`Compact SSE at http://${HOST}:${PORT}/sse/compact (1 tool)`, null, 'MCP');
    });

    // Keepalive comment lines to prevent proxy/client timeouts
    const keepalive = setInterval(() => {
        for (const [, session] of sessions) {
            session.res.write(':\n\n');
        }
    }, 30000);

    let isShuttingDown = false;

    async function gracefulShutdown(signal) {
        if (isShuttingDown) {
            logger.info(`Shutdown already in progress, ignoring ${signal}`, null, 'SHUTDOWN');
            return;
        }
        isShuttingDown = true;
        logger.info(`Received ${signal}, exiting gracefully...`, null, 'SHUTDOWN');
        clearInterval(keepalive);
        server.close();
        for (const [, session] of sessions) session.res.end();
        sessions.clear();
        await shutdownAll();
        process.exit(0);
    }

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    process.on('exit', (code) => {
        logger.info(`Process exiting with code ${code}`, null, 'SHUTDOWN');
    });

    process.on('uncaughtException', async (err) => {
        logger.error('Uncaught exception, shutting down', err, 'FATAL');
        await gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', async (reason, promise) => {
        logger.error('Unhandled rejection, shutting down', reason, 'FATAL');
        await gracefulShutdown('unhandledRejection');
    });
}

start().catch(err => {
    process.stderr.write(`FATAL: ${err?.stack || err}\n`);
    logger.error('Failed to start server', err, null, 'FATAL');
    process.exit(1);
});
