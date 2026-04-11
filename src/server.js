import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import { createLogger, interceptConsole } from './utils/logger.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = createLogger({ logsDir: path.join(__dirname, '../logs'), sessionPrefix: 'mcp' });
interceptConsole(logger);

import { loadAgents } from './agent-loader.js';
import { createGatewayClient } from './gateway-client.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = {
    name: 'mcp-server-orchestrator',
    version: '2.0.0',
    description:
        '⚠️ START HERE: get_philosophy()\n\n' +
        'This is an LLM-native codebase with unusual principles (fail fast, zero dependencies, ' +
        'no defensive coding). The philosophy doc is 33 lines — read it first.\n\n' +
        'Then: get_orchestrator_doc() for the full tools reference (35+ tools, 9 agents).'
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
if (fs.existsSync('config.json')) serverConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));

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

    const server = app.listen(PORT, HOST, () => {
        logger.info(`Server running at http://${HOST}:${PORT}`, null, 'MCP');
        logger.info(`SSE endpoint at http://${HOST}:${PORT}/sse`, null, 'MCP');
    });

    // Keepalive comment lines to prevent proxy/client timeouts
    const keepalive = setInterval(() => {
        for (const [, session] of sessions) {
            session.res.write(':\n\n');
        }
    }, 30000);

    process.on('SIGINT', async () => {
        logger.info('Exiting gracefully...', null, 'SHUTDOWN');
        clearInterval(keepalive);
        server.close();
        for (const [, session] of sessions) session.res.end();
        sessions.clear();
        await shutdownAll();
        process.exit(0);
    });
}

start().catch(err => {
    logger.error('Failed to start server', err, null, 'FATAL');
    process.exit(1);
});
