import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URL } from 'url';

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3100/mcp'));

const client = new Client({
  name: 'test-client',
  version: '1.0.0'
}, {
  capabilities: {}
});

await client.connect(transport);

const tools = await client.listTools();

// Find memory-related tools
const memoryTools = tools.tools.filter(t => ['list_memories', 'recall', 'remember'].includes(t.name));

console.log('Memory Tool Descriptions:\n');
memoryTools.forEach(tool => {
  console.log(`=== ${tool.name.toUpperCase()} ===`);
  console.log(tool.description);
  console.log('\n');
});

await client.close();
