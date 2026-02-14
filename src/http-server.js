import { config as loadDotEnv } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { createLLMServer } from './servers/llm.js';
import { WebResearchServer } from './servers/web-research.js';
import { createMemoryServer } from './servers/memory.js';
import { createBrowserServer } from './servers/browser.js';
import { createDocsServer } from './servers/docs.js';
import { WebServer } from './web/server.js';
import { globalLogger } from './logger.js';
import { createRouter } from './router/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Process managers/Electron often spawn with a different cwd; load .env by absolute path.
loadDotEnv({ path: join(__dirname, '..', '.env') });
const configRaw = readFileSync(join(__dirname, '..', 'config.json'), 'utf-8');
// Replace environment variables in config
const configStr = configRaw.replace(/\${(\w+)}/g, (_, key) => process.env[key] || '');
const config = JSON.parse(configStr);

const PROCESS_LOG_PATH = join(__dirname, '..', 'data', 'process-events.log');
const logProcessEvent = (event, data = {}) => {
  try {
    appendFileSync(PROCESS_LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);
  } catch { }
};

let maintenanceInterval = null;
let httpServerInstance = null;
let webServerInstance = null;

const shutdown = async (signal) => {
  console.log(`\n[SHUTDOWN] Received ${signal}, cleaning up...`);
  logProcessEvent('signal', { signal });
  
  if (maintenanceInterval) {
    clearInterval(maintenanceInterval);
    maintenanceInterval = null;
  }
  
  if (webServerInstance?.stop) {
    try {
      await webServerInstance.stop();
      console.log('[SHUTDOWN] Web server stopped');
    } catch (err) {
      console.error('[SHUTDOWN] Web server stop error:', err.message);
    }
  }
  
  if (httpServerInstance) {
    httpServerInstance.close(() => {
      console.log('[SHUTDOWN] HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[SHUTDOWN] Forcing exit after 2s timeout');
      process.exit(1);
    }, 2000);
  } else {
    process.exit(0);
  }
};

process.on('exit', (code) => {
  logProcessEvent('exit', { code });
});
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
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
const prompts = [];

// Initialize LLM Router
let llmRouter = null;
if (config.llm) {
  llmRouter = await createRouter(config.llm);
  console.log('✓ LLM Router initialized');
}

// Initialize Docs server (always enabled)
const docsServer = createDocsServer();
serverModules.set('docs', docsServer);
tools.push(...docsServer.getTools());
console.log('✓ Docs');

// Initialize Browser server first (needed by web-research)
let browserServer = null;
if (config.servers['browser']?.enabled) {
  browserServer = createBrowserServer(config.servers['browser']);
  serverModules.set('browser', browserServer);
  tools.push(...browserServer.getTools());
  console.log('✓ Browser');
}

// Initialize LLM server (query tools)
let llmServer = null;

if (config.servers['web-research']?.enabled) {
  const s = new WebResearchServer(config.servers['web-research'], llmRouter, browserServer);
  serverModules.set('web-research', s);
  tools.push(...s.getTools());
  console.log('✓ Web Research');
}

if (config.servers['memory']?.enabled) {
  // Pass LLM router to memory server for embedding
  const s = createMemoryServer(config.servers['memory'], llmRouter);
  serverModules.set('memory', s);
  tools.push(...s.getTools());
  if (s.getResources) resources.push(...s.getResources());
  if (s.getPrompts) prompts.push(...s.getPrompts());
  console.log('✓ Memory');
}

// Browser server already initialized above (before web-research)

// Support both 'code-inspector' (new) and 'local-agent' (deprecated) config keys
const inspectorConfig = config.servers['code-inspector'] || config.servers['local-agent'];
if (inspectorConfig?.enabled) {
  const { createCodeInspectorServer } = await import('./servers/code-inspector.js');
  const s = createCodeInspectorServer(inspectorConfig, llmRouter);
  serverModules.set('code-inspector', s);
  tools.push(...s.getTools());
  if (s.getPrompts) prompts.push(...s.getPrompts());
  console.log('✓ Code Inspector');
}

// Initialize LLM server (query tools)
if (config.servers['llm']?.enabled) {
  llmServer = createLLMServer(config.servers['llm'], llmRouter);
  serverModules.set('llm', llmServer);
  tools.push(...llmServer.getTools());
  console.log('✓ LLM');
}

// Start web monitoring interface
if (config.web?.enabled) {
  const memoryServer = serverModules.get('memory');
  const webServer = new WebServer(config.web, memoryServer, llmServer);
  webServerInstance = webServer;
  webServer.start();
  console.log('✓ Web Interface');
}

// Start maintenance cycle
if (config.maintenance?.enabled) {
  const intervalMs = config.maintenance.indexRefreshIntervalMs || 3600000; // Default 1 hour
  const intervalMinutes = (intervalMs / 60000).toFixed(1);
  
  const runMaintenance = async () => {
    try {
      const startTime = Date.now();
      
      // Refresh LLM router metadata (model info, context windows)
      if (llmRouter?.refreshAllMetadata) {
        await llmRouter.refreshAllMetadata();
      }
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[Maintenance] Complete in ${duration}s`);
    } catch (err) {
      console.error('[Maintenance] Failed:', err);
    }
  };
  
  // Don't run immediately on startup - let it wait for first interval
  maintenanceInterval = setInterval(runMaintenance, intervalMs);
  console.log(`✓ Maintenance Cycle (refresh indexes every ${intervalMinutes}min)`);
}

// Factory function to create and configure a new MCP server instance per connection
function createMCPServer() {
  const server = new Server({
    name: config.orchestrator.name,
    version: config.orchestrator.version
  }, {
    capabilities: {
      tools: {},
      resources: resources.length > 0 ? {} : undefined,
      prompts: prompts.length > 0 ? {} : undefined
    }
  });

  // Set up request handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  if (prompts.length > 0) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments || {};
      for (const [sName, module] of serverModules) {
        if (module.getPrompt) {
          try {
            return await module.getPrompt(name, args);
          } catch (err) {
            continue;
          }
        }
      }
      throw new Error(`Prompt not found: ${name}`);
    });
  }

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
          module.setProgressCallback((data) => {
            const { progress, total, message } = data;
            server.notification({
              method: 'notifications/progress',
              params: { progressToken, progress, total, message }
            }).catch(() => {
              // Client disconnected, ignore
            });
          });
        }
        
        try {
          const result = await module.callTool(name, args);
          globalLogger.log('mcp-tool', name, args, result);
          return result;
        } catch (err) {
          console.error(`[MCP] Tool error in ${name}:`, err.message);
          globalLogger.log('mcp-tool', name, args, null, err);
          
          // CRITICAL: Never throw, always return error response
          // Throwing breaks MCP connection when client cancels
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: err.message,
                code: err.code || 'TOOL_ERROR',
                tool: name
              }, null, 2)
            }],
            isError: true
          };
        } finally {
          // Clear progress callback
          if (module.setProgressCallback) {
            module.setProgressCallback(null);
          }
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

try { httpServer.setTimeout?.(0); } catch { }

const MCP_SSE_KEEPALIVE_MS = Math.max(0, parseInt(process.env.MCP_SSE_KEEPALIVE_MS || '45000', 10) || 0);
const MCP_TCP_KEEPALIVE_MS = Math.max(0, parseInt(process.env.MCP_TCP_KEEPALIVE_MS || '30000', 10) || 0);
const MCP_SESSION_TTL_MS = Math.max(0, parseInt(process.env.MCP_SESSION_TTL_MS || '3600000', 10) || 0);

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
      closeSession(sessionId);
    }
  });

  const connectPromise = server.connect(transport);
  session = { server, transport, connectPromise, createdAt: Date.now(), lastSeen: Date.now() };
  return session;
};

const closeSession = (sessionId, reason) => {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  if (process.env.DEBUG_MCP_HTTP === '1') console.log(`[MCP] Session closed${reason ? ` (${reason})` : ''}: ${sessionId}`);
  try { s?.server?.close(); } catch { }
};

if (MCP_SESSION_TTL_MS > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, s] of sessions) {
      if (now - (s?.lastSeen || s?.createdAt || now) > MCP_SESSION_TTL_MS) closeSession(sessionId, 'ttl');
    }
  }, Math.min(60000, Math.max(10000, Math.floor(MCP_SESSION_TTL_MS / 6)))).unref?.();
}

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

    session.lastSeen = Date.now();

    try {
      if (MCP_TCP_KEEPALIVE_MS > 0) {
        try {
          req.socket?.setKeepAlive?.(true, MCP_TCP_KEEPALIVE_MS);
          req.socket?.setNoDelay?.(true);
          req.socket?.setTimeout?.(0);
        } catch { }
      }
    } catch { }

    let keepAliveTimer;
    let contentType;
    const _setHeader = res.setHeader?.bind(res);
    const _writeHead = res.writeHead?.bind(res);

    if (_setHeader) {
      res.setHeader = (name, value) => {
        if (typeof name === 'string' && name.toLowerCase() === 'content-type') contentType = String(value);
        return _setHeader(name, value);
      };
    }
    if (_writeHead) {
      res.writeHead = (...args) => {
        const headers = args.length >= 2 && typeof args[1] === 'object' ? args[1] : (args.length >= 3 && typeof args[2] === 'object' ? args[2] : null);
        if (headers && !contentType) {
          for (const k of Object.keys(headers)) {
            if (k && String(k).toLowerCase() === 'content-type') { contentType = String(headers[k]); break; }
          }
        }
        const ret = _writeHead(...args);
        if (MCP_SSE_KEEPALIVE_MS > 0 && contentType && /text\/event-stream/i.test(contentType) && !keepAliveTimer) {
          keepAliveTimer = setInterval(() => {
            try { res.write(`:ka\n\n`); } catch { }
          }, MCP_SSE_KEEPALIVE_MS);
          keepAliveTimer.unref?.();
        }
        return ret;
      };
    }

    const clearKeepAlive = () => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      if (_setHeader) res.setHeader = _setHeader;
      if (_writeHead) res.writeHead = _writeHead;
    };
    res.on('close', clearKeepAlive);
    res.on('finish', clearKeepAlive);

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
  httpServerInstance = httpServer;
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
