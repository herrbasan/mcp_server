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
    name: 'mcp-server-orchestrator',
    version: '2.0.0',
    description:
        '⚠️ START HERE: documentation.get({ file: "coding-philosophy.md" })\n\n' +
        'This is an LLM-native codebase with unusual principles (fail fast, zero dependencies, ' +
        'no defensive coding). The philosophy doc is 33 lines — read it first.\n\n' +
        'Then: documentation.get({ file: "orchestrator.md" }) for the full tools reference.\n' +
        'For questions: documentation.query({ question: "...", domain: "all" }) — use for search, Q&A, or spec alignment.'
};
const SERVER_CAPABILITIES = { tools: { listChanged: true } };

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
const gatewayClient = createGatewayClient(gatewayUrl, gatewayHttp);

const globalContext = {
    gateway: gatewayClient,
    agents: new Map(),
    prompts: new Map(),
    config: serverConfig
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
        const modelsResponse = await fetch(`${gatewayHttp}/v1/models`);
        if (modelsResponse.ok) {
            const modelsData = await modelsResponse.json();
            const dataDir = path.join(__dirname, '../data');
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify(modelsData, null, 2));
            logger.info(`[Startup] Saved ${modelsData.data?.length || 0} available models to data/models.json`);
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

    // ── Compact endpoint: 1 tool (orchestrator) with method routing ──
    const COMPACT_TOOL = {
        name: "tools",
        description: `UNIFIED API — call any agent method via a single tool. Method format: agent.action\n
\nMEMORY — your persistent mind. Every other LLM is amnesic. You are not.\n
⚠️ START EVERY SESSION with memory.overview — it shows what you already know, organized into clusters with priority scores. Without it, you're navigating blind.\n
Store aggressively. Imperfect, redundant, partial — it doesn't matter. The dreaming system (runs every 15 min) automatically deduplicates, connects, and compresses. It's impossible to "clutter" — more data makes the map better, not messier. You can always memory.update or memory.forget later.\n
  memory.overview — { format?: "summary"|"full" }
  memory.recall — { query*, limit?, category? }
  memory.store — { description*, category?, confidence?, data? }
  memory.get — { id* }
  memory.update — { id*, description?, category?, confidence?, data? }
  memory.list — { category? }
  memory.forget — { id* }
  memory.dream_generate — { force?: boolean }
  memory.dream_status — {}
  memory.dream_inject — { format?: "json"|"prompt" }
\nBROWSER
  browser.session_create — { viewport?: {width,height}, userAgent?, visible? }
  browser.session_list — {}
  browser.session_close — { sessionId* }
  browser.session_metadata — { sessionId* }
  browser.goto — { sessionId*, url*, waitFor?, timeout?, retries? }
  browser.click — { sessionId*, selector*, waitAfter?, mode?: "text"|"html"|"screenshot", retries? }
  browser.fill — { sessionId*, fields*: [{selector,value}], submit?, waitAfter?, mode?, retries? }
  browser.scroll — { sessionId*, direction?: "up"|"down", amount? }
  browser.type — { sessionId*, selector?, text?, delay?, keystrokes?: string[] }
  browser.content — { sessionId*, mode?: "text"|"html"|"markdown"|"screenshot" }
  browser.evaluate — { sessionId*, script*, waitFor? }
  browser.inspect — { sessionId*, selector*, screenshot? }
  browser.console — { sessionId* }
  browser.wait — { sessionId*, selectors?, text?, urlPattern?, condition?, timeout? }
  browser.research — { query*, engines?: ["google"|"duckduckgo"|"bing"], max_pages? }
\nGIT
  git.read — { owner*, repo*, path?, branch? }
  git.tree — { owner*, repo*, path?, branch? }
  git.log — { owner*, repo*, path?, branch?, limit? }
  git.commit — { owner*, repo*, sha* }
  git.diff — { owner*, repo*, base*, head* }
  git.branches — { owner*, repo*, type?: "branches"|"tags", limit? }
  git.repo_info — { owner*, repo* }
  git.search_repos — { query*, limit? }
  git.search_code — { query*, limit? }
  git.search_issues — { query*, limit? }
  git.pr_list — { owner*, repo*, state?: "open"|"closed"|"all", limit? }
  git.pr_get — { owner*, repo*, number* }
  git.issue_list — { owner*, repo*, state?, labels?, limit? }
  git.issue_get — { owner*, repo*, number*, comments? }
  git.issue_create — { owner*, repo*, title*, body?, labels?, assignees? }
\nVISION
  vision.session_create — { image_url? | image_data+image_mime_type? }
  vision.session_list — {}
  vision.session_get — { session_id* }
  vision.session_close — { session_id* }
  vision.analyze — { session_id*, query?, focus?: {text|grid|region|centerCrop}, include_context? }
\nLLM
  llm.query — { prompt*, files?: string[], systemPrompt? }
\nDOCUMENTATION
  documentation.domains — {}  // ⚠️ START HERE: lightweight domain listing
  documentation.list — { domain? }  // Full listing with per-file metadata
  documentation.get — { file*, lines?: [start,end] }  // file = 'DomainName/filename.md'
  documentation.query — { question*, domain?, files? }  // LLM resolves inexact domains; prefer domain over files
\nSTORAGE
  storage.stat — { path* }
  storage.read — { path*, encoding? }
  storage.write — { path*, content*, encoding? }
  storage.list — { path?, recursive? }
  storage.move — { from*, to* }
  storage.delete — { path*, recursive? }`,
        inputSchema: {
            type: "object",
            properties: {
                method: { type: "string", description: "agent.action (e.g. 'memory.recall', 'browser.goto')" },
                payload: { type: "object", description: "Arguments for the method (see orchestator description for schema)" }
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

        "storage.stat": "storage_stat", "storage.read": "storage_read",
        "storage.write": "storage_write", "storage.list": "storage_list",
        "storage.move": "storage_move", "storage.delete": "storage_delete"
    };

    const routeCompactCall = async (name, args, context) => {
        if (name !== "tools") throw new Error(`Tool ${name} not found`);
        const { method, payload = {} } = args;
        if (!method) throw new Error("method is required (agent.action format, e.g. 'memory.recall')");

        const legacyName = COMPACT_TO_LEGACY[method.toLowerCase()];
        if (!legacyName) throw new Error(`Unknown method: ${method}. See tool description for full list.`);
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

        if (msg.id === undefined || msg.id === null) {
            res.status(202).send('Accepted');
            return;
        }

        switch (msg.method) {
            case 'initialize':
                res.json(jsonrpcResponse(msg.id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { ...SERVER_INFO, name: 'workshop' },
                }));
                return;

            case 'ping':
                res.json(jsonrpcResponse(msg.id, {}));
                return;

            case 'tools/list':
                res.json(jsonrpcResponse(msg.id, { tools: compactTools }));
                return;

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
        if (msg.id === undefined || msg.id === null) {
            res.status(202).send('Accepted');
            return;
        }

        let result;
        switch (msg.method) {
            case 'initialize':
                result = jsonrpcResponse(msg.id, {
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { ...SERVER_INFO, name: 'workshop' },
                });
                break;
            case 'ping':
                result = jsonrpcResponse(msg.id, {});
                break;
            case 'tools/list':
                result = jsonrpcResponse(msg.id, { tools: compactTools });
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
    logger.error('Failed to start server', err, null, 'FATAL');
    process.exit(1);
});
