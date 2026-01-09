import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LMStudioServer } from './servers/lm-studio.js';
import { CodeAnalyzerServer } from './servers/code-analyzer.js';
import { DocsHelperServer } from './servers/docs-helper.js';
import { MemoryServer } from './servers/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf-8'));

const serverModules = new Map();
const tools = [];

// Initialize enabled servers
if (config.servers['lm-studio']?.enabled) {
  const s = new LMStudioServer(config.servers['lm-studio']);
  serverModules.set('lm-studio', s);
  tools.push(...s.getTools());
  console.error('✓ LM Studio');
}

if (config.servers['code-analyzer']?.enabled) {
  const s = new CodeAnalyzerServer(config.servers['code-analyzer']);
  serverModules.set('code-analyzer', s);
  tools.push(...s.getTools());
  console.error('✓ Code Analyzer');
}

if (config.servers['docs-helper']?.enabled) {
  const s = new DocsHelperServer(config.servers['docs-helper']);
  serverModules.set('docs-helper', s);
  tools.push(...s.getTools());
  console.error('✓ Docs Helper');
}

if (config.servers['memory']?.enabled) {
  const s = new MemoryServer(config.servers['memory']);
  serverModules.set('memory', s);
  tools.push(...s.getTools());
  console.error('✓ Memory');
}

console.error(`📦 ${tools.length} tools ready\n`);

const server = new Server(
  { name: config.orchestrator.name, version: config.orchestrator.version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  console.error(`🔧 ${name}`);
  
  for (const [sName, module] of serverModules) {
    if (module.handlesTool(name)) {
      console.error(`  → ${sName}`);
      return await module.callTool(name, args);
    }
  }
  
  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
console.error('🚀 MCP Orchestrator running\n');
