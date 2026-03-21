import fs from 'fs';
import express from 'express';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import { loadAgents } from './agent-loader.js';
import { createGatewayClient } from './gateway-client.js';

dotenv.config();

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'mcp-server-orchestrator', version: '2.0.0' };
const SERVER_CAPABILITIES = { tools: { listChanged: true } };

const app = express();
const PORT = process.env.PORT || 3100;
const HOST = process.env.HOST || '0.0.0.0';

let serverConfig = {};
if (fs.existsSync('config.json')) serverConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));

const gatewayUrl = process.env.GATEWAY_URL || serverConfig.gateway?.wsUrl || 'ws://localhost:3400/v1/realtime';
const gatewayHttp = process.env.GATEWAY_HTTP_URL || serverConfig.gateway?.httpUrl || 'http://localhost:3400';
const gatewayClient = createGatewayClient(gatewayUrl, gatewayHttp, serverConfig.models?.embed, serverConfig.models || {});

const globalContext = {
    gateway: gatewayClient,
    agents: new Map(),
    prompts: new Map(),
    config: serverConfig
};

// Per-session SSE state: Map<sessionId, { res, send }>
const sessions = new Map();

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
    const { tools, routeToolCall, shutdownAll } = await loadAgents(globalContext);

    // Streamable HTTP transport (MCP 2025-03-26) — for Kimi and other modern clients
    // Client POSTs all JSON-RPC messages here; tool calls respond with SSE for progress support
    app.post('/mcp', express.json(), async (req, res) => {
        const msg = req.body;

        // Notifications have no id — just acknowledge
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
                // Headers are flushed immediately — keepalive pings prevent client timeouts
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

    // Legacy SSE transport — for VS Code Copilot and older clients
    // Client GETs here to open stream, then POSTs to /message?sessionId=...
    app.get('/sse', (req, res) => {
        const sessionId = randomUUID();
        console.log(`[MCP] New session: ${sessionId}`);

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
            console.log(`[MCP] Session disconnected: ${sessionId}`);
            sessions.delete(sessionId);
        });
    });

    // POST endpoint — client sends JSON-RPC requests here
    app.post('/message', express.json(), async (req, res) => {
        const sessionId = req.query.sessionId;
        const session = sessions.get(sessionId);
        if (!session) return res.status(404).send('Session not found');

        const msg = req.body;

        // Notifications have no id — acknowledge and don't respond on SSE
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
        console.log(`[MCP] Server running at http://${HOST}:${PORT}`);
        console.log(`[MCP] SSE endpoint at http://${HOST}:${PORT}/sse`);
    });

    // Keepalive comment lines to prevent proxy/client timeouts
    const keepalive = setInterval(() => {
        for (const [, session] of sessions) {
            session.res.write(':\n\n');
        }
    }, 30000);

    process.on('SIGINT', async () => {
        console.log('\n[SHUTDOWN] Exiting gracefully...');
        clearInterval(keepalive);
        server.close();
        for (const [, session] of sessions) session.res.end();
        sessions.clear();
        await shutdownAll();
        process.exit(0);
    });
}

start().catch(err => {
    console.error('[FATAL] Failed to start server:', err);
    process.exit(1);
});
