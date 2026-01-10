import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LMStudioWSServer } from './servers/lm-studio-ws.js';
import { CodeAnalyzerServer } from './servers/code-analyzer.js';
import { WebResearchServer } from './servers/web-research.js';
import { MemoryServer } from './servers/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

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
  console.error('✓ Memory');
}

console.error(`📦 ${tools.length} tools, ${resources.length} resources ready\n`);

const server = new Server(
  { name: config.orchestrator.name, version: config.orchestrator.version },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  
  for (const [sName, module] of serverModules) {
    if (module.handlesResource && module.handlesResource(uri)) {
      console.error(`📄 ${uri} → ${sName}`);
      return await module.readResource(uri);
    }
  }
  
  throw new Error(`Unknown resource: ${uri}`);
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const progressToken = req.params._meta?.progressToken;
  
  console.error(`🔧 ${name}`);
  
  for (const [sName, module] of serverModules) {
    if (module.handlesTool(name)) {
      console.error(`  → ${sName}`);
      
      if (progressToken && module.setProgressCallback) {
        module.setProgressCallback((progress, total, message) => {
          server.notification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress,
              total,
              message
            }
          });
        });
      }
      
      return await module.callTool(name, args);
    }
  }
  
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
console.error('🚀 MCP Orchestrator running\n');
