import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { LMStudioWSServer } from './servers/lm-studio-ws.js';
import { CodeAnalyzerServer } from './servers/code-analyzer.js';
import { WebResearchServer } from './servers/web-research.js';
import { MemoryServer } from './servers/memory.js';
import { WebServer } from './web/server.js';
import { globalLogger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

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
  console.error('✓ LM Studio (WebSocket)');
}

if (config.servers['code-analyzer']?.enabled) {
  const s = new CodeAnalyzerServer(config.servers['code-analyzer']);
  serverModules.set('code-analyzer', s);
  tools.push(...s.getTools());
  console.error('✓ Code Analyzer');
}

if (config.servers['web-research']?.enabled) {
  const s = new WebResearchServer(config.servers['web-research']);
  serverModules.set('web-research', s);
  tools.push(...s.getTools());
  console.error('✓ Web Research');
}

if (config.servers['memory']?.enabled) {
  const s = new MemoryServer(config.servers['memory']);
  serverModules.set('memory', s);
  tools.push(...s.getTools());
  if (s.getResources) resources.push(...s.getResources());
  console.error('✓ Memory');
}
// Start web monitoring interface
if (config.web?.enabled) {
  const memoryServer = serverModules.get('memory');
  const lmStudioServer = new LMStudioWSServer(config.servers['lm-studio']);
  const webServer = new WebServer(config.web, memoryServer, lmStudioServer);
  webServer.start();
  console.error('✓ Web Interface');
}

// Create single MCP server instance
const mcpServer = new Server({
  name: config.orchestrator.name,
  version: config.orchestrator.version
}, {
  capabilities: {
    tools: {},
    resources: resources.length > 0 ? {} : undefined
  }
});

// Set up request handlers
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

if (resources.length > 0) {
  mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));
  mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args, _meta } = request.params;
  const progressToken = _meta?.progressToken;
  
  console.error(`\n🔧 Tool: ${name}`);
  console.error(`  [DEBUG] Request received in CallToolRequestSchema handler`);
  console.error(`  [DEBUG] Logging to globalLogger and web monitoring`);
  console.error(`  [DEBUG] globalLogger state - logs: ${globalLogger.logs.length}, listeners: ${globalLogger.listeners.size}`);
  
  for (const [sName, module] of serverModules) {
    if (module.handlesTool(name)) {
      console.error(`  → ${sName}`);
      
      if (progressToken && module.setProgressCallback) {
        module.setProgressCallback((progress, total, message) => {
          mcpServer.notification({
            method: 'notifications/progress',
            params: { progressToken, progress, total, message }
          });
        });
      }
      
      try {
        const result = await module.callTool(name, args);
        console.error(`  [DEBUG] Tool executed successfully, now logging...`);
        globalLogger.log('mcp-tool', name, args, result);
        console.error(`  [DEBUG] Log created! New log count: ${globalLogger.logs.length}, listeners: ${globalLogger.listeners.size}`);
        return result;
      } catch (err) {
        console.error(`  ✗ Error: ${err.message}`);
        globalLogger.log('mcp-tool', name, args, null, err);
        throw err;
      }
    }
  }
  
  throw new Error(`Unknown tool: ${name}`);
});

// Create StreamableHTTPServerTransport with session management
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});

// Connect server to transport
await mcpServer.connect(transport);
console.error('[MCP] Server connected to StreamableHTTP transport');

const httpServer = createServer();
const HOST = process.env.MCP_HOST || '0.0.0.0';
const PORT = process.env.MCP_PORT || 3100;

httpServer.listen(PORT, HOST, () => {
  console.error(`🚀 MCP Server listening on http://${HOST}:${PORT}`);
  console.error(`📡 MCP endpoint: http://${HOST}:${PORT}/mcp`);
  console.error(`📡 SSE endpoint (legacy): http://${HOST}:${PORT}/sse`);
  if (config.web?.enabled) {
    console.error(`🌐 Web interface: http://${config.web.host}:${config.web.port}`);
  }
  console.error(`\nConfigure VS Code mcp.json with:`);
  console.error(`{`);
  console.error(`  "servers": {`);
  console.error(`    "orchestrator": {`);
  console.error(`      "type": "sse",`);
  console.error(`      "url": "http://${HOST === '0.0.0.0' ? 'YOUR_IP' : HOST}:${PORT}/mcp"`);
  console.error(`    }`);
  console.error(`  }`);
  console.error(`}`);
  
  // Test log to verify logger is working
  globalLogger.log('system', 'startup', {}, { status: 'ready', listeners: globalLogger.listeners.size });
  console.error(`\n[DEBUG] Test log created - total logs: ${globalLogger.logs.length}, listeners: ${globalLogger.listeners.size}`);
});

httpServer.on('request', async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  // Log all incoming requests for debugging
  console.error(`[HTTP] ${req.method} ${url.pathname} from ${req.socket.remoteAddress}`);
  
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', servers: Array.from(serverModules.keys()) }));
    return;
  }
  
  if (url.pathname === '/mcp' || url.pathname === '/sse') {
    console.error('[MCP] Handling MCP request...');
    try {
      await transport.handleRequest(req, res);
      console.error('[MCP] Request handled successfully');
    } catch (err) {
      console.error('[MCP] Error handling request:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error: ${err.message}`);
      }
    }
    return;
  }
  
  res.writeHead(404);
  res.end('Not found. Use /mcp or /sse for MCP connection, /health for status');
});
