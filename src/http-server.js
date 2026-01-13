import { config as loadDotEnv } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { LMStudioWSServer } from './servers/lm-studio-ws.js';
import { WebResearchServer } from './servers/web-research.js';
import { MemoryServer } from './servers/memory.js';
import { WebServer } from './web/server.js';
import { globalLogger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Process managers/Electron often spawn with a different cwd; load .env by absolute path.
loadDotEnv({ path: join(__dirname, '..', '.env') });
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const PROCESS_LOG_PATH = join(__dirname, '..', 'data', 'process-events.log');
const logProcessEvent = (event, data = {}) => {
  try {
    appendFileSync(PROCESS_LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
  } catch { }
};

process.on('exit', (code) => logProcessEvent('exit', { code }));
process.on('SIGINT', () => logProcessEvent('signal', { signal: 'SIGINT' }));
process.on('SIGTERM', () => logProcessEvent('signal', { signal: 'SIGTERM' }));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  logProcessEvent('uncaughtException', { message: err?.message, stack: err?.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(typeof reason === 'string' ? reason : 'UnhandledRejection');
  console.error('[FATAL] unhandledRejection:', err);
  logProcessEvent('unhandledRejection', { message: err?.message, stack: err?.stack });
  process.exit(1);
});

// Override config with environment variables if present
if (process.env.LM_STUDIO_WS_ENDPOINT) config.servers['lm-studio'].endpoint = process.env.LM_STUDIO_WS_ENDPOINT;
if (process.env.LM_STUDIO_MODEL) config.servers['lm-studio'].model = process.env.LM_STUDIO_MODEL;
if (process.env.LM_STUDIO_HTTP_ENDPOINT) {
  const baseUrl = process.env.LM_STUDIO_HTTP_ENDPOINT;
  config.servers['web-research'].llmEndpoint = `${baseUrl}/v1/chat/completions`;
  config.servers['memory'].embeddingEndpoint = `${baseUrl}/v1/embeddings`;
}
if (process.env.LM_STUDIO_MODEL) config.servers['web-research'].llmModel = process.env.LM_STUDIO_MODEL;
if (process.env.EMBEDDING_MODEL) config.servers['memory'].embeddingModel = process.env.EMBEDDING_MODEL;

// Override web config with environment variables
if (process.env.WEB_ENABLED !== undefined) config.web.enabled = process.env.WEB_ENABLED === 'true';
if (process.env.WEB_HOST) config.web.host = process.env.WEB_HOST;
if (process.env.WEB_PORT) config.web.port = parseInt(process.env.WEB_PORT);
if (process.env.WEB_MAX_LOGS) config.web.maxLogs = parseInt(process.env.WEB_MAX_LOGS);

const serverModules = new Map();
const tools = [];
const resources = [];

// Initialize enabled servers
if (config.servers['lm-studio']?.enabled) {
  const s = new LMStudioWSServer(config.servers['lm-studio']);
  serverModules.set('lm-studio', s);
  tools.push(...s.getTools());
  if (s.getResources) resources.push(...s.getResources());
  console.log('✓ LM Studio (WebSocket)');
}

if (config.servers['web-research']?.enabled) {
  const s = new WebResearchServer(config.servers['web-research']);
  serverModules.set('web-research', s);
  tools.push(...s.getTools());
  console.log('✓ Web Research');
}

if (config.servers['memory']?.enabled) {
  const s = new MemoryServer(config.servers['memory']);
  serverModules.set('memory', s);
  tools.push(...s.getTools());
  if (s.getResources) resources.push(...s.getResources());
  console.log('✓ Memory');
}
// Start web monitoring interface
if (config.web?.enabled) {
  const memoryServer = serverModules.get('memory');
  const lmStudioServer = new LMStudioWSServer(config.servers['lm-studio']);
  const webServer = new WebServer(config.web, memoryServer, lmStudioServer);
  webServer.start();
  console.log('✓ Web Interface');
}

// Factory function to create and configure a new MCP server instance per connection
function createMCPServer() {
  const server = new Server({
    name: config.orchestrator.name,
    version: config.orchestrator.version
  }, {
    capabilities: {
      tools: {},
      resources: resources.length > 0 ? {} : undefined
    }
  });

  // Set up request handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  if (resources.length > 0) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      for (const [sName, module] of serverModules) {
        if (module.readResource) {
          try {
            return await module.readResource(uri);
          } catch (err) {
            continue;
          }
        }
      }
      throw new Error(`Resource not found: ${uri}`);
    });
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args, _meta } = request.params;
    const progressToken = _meta?.progressToken;
    
    for (const [sName, module] of serverModules) {
      if (module.handlesTool(name)) {
        if (progressToken && module.setProgressCallback) {
          module.setProgressCallback((progress, total, message) => {
            server.notification({
              method: 'notifications/progress',
              params: { progressToken, progress, total, message }
            });
          });
        }
        
        try {
          const result = await module.callTool(name, args);
          globalLogger.log('mcp-tool', name, args, result);
          return result;
        } catch (err) {
          console.error(`[MCP] Tool error: ${err.message}`);
          globalLogger.log('mcp-tool', name, args, null, err);
          throw err;
        }
      }
    }
    
    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}
const httpServer = createServer();
const HOST = process.env.MCP_HOST || '0.0.0.0';
const PORT = process.env.MCP_PORT || 3100;

const sessions = new Map();
const createSession = () => {
  const server = createMCPServer();

  let session;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, session);
      if (process.env.DEBUG_MCP_HTTP === '1') console.log(`[MCP] Session initialized: ${sessionId}`);
    },
    onsessionclosed: (sessionId) => {
      const s = sessions.get(sessionId);
      sessions.delete(sessionId);
      if (process.env.DEBUG_MCP_HTTP === '1') console.log(`[MCP] Session closed: ${sessionId}`);
      try { s?.server?.close(); } catch { }
    }
  });

  const connectPromise = server.connect(transport);
  session = { server, transport, connectPromise, createdAt: Date.now() };
  return session;
};

httpServer.on('error', (err) => {
  console.error('[HTTP] Server error:', err);
  logProcessEvent('httpServerError', { code: err?.code, message: err?.message, stack: err?.stack, host: HOST, port: PORT });
  process.exit(1);
});

httpServer.on('request', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', servers: Array.from(serverModules.keys()) }));
    return;
  }
  
  if (url.pathname === '/mcp') {
    const sessionId = req.headers['mcp-session-id'];
    let session;
    if (sessionId) {
      session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Session not found');
        return;
      }
    } else {
      session = createSession();
    }

    try {
      await session.connectPromise;
      await session.transport.handleRequest(req, res);
    } catch (err) {
      console.error('[MCP] Request error:', err);
      logProcessEvent('mcpRequestError', { message: err?.message, stack: err?.stack, path: url.pathname, method: req.method });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`MCP Error: ${err.message}`);
      }
    }
    return;
  }
  
  res.writeHead(404);
  res.end('Not found. Use /mcp for MCP connection, /health for status');
});

httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 MCP Server listening on http://${HOST}:${PORT}`);
  console.log(`📡 MCP endpoint: http://${HOST}:${PORT}/mcp`);
  if (config.web?.enabled) {
    console.log(`🌐 Web interface: http://${config.web.host}:${config.web.port}`);
  }
  console.log(`\nConfigure VS Code mcp.json with:`);
  console.log(`{`);
  console.log(`  "servers": {`);
  console.log(`    "orchestrator": {`);
  console.log(`      "url": "http://${HOST === '0.0.0.0' ? 'YOUR_IP' : HOST}:${PORT}/mcp"`);
  console.log(`    }`);
  console.log(`  }`);
  console.log(`}`);
  
  globalLogger.log('system', 'startup', {}, { status: 'ready', transport: 'streamable-http-per-session' });
  logProcessEvent('startup', { host: HOST, port: PORT, transport: 'streamable-http-per-session', web: !!config.web?.enabled, webHost: config.web?.host, webPort: config.web?.port });
});
