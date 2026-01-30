import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { URL } from 'url';

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3100/mcp'));

const client = new Client({
  name: 'prompts-test-client',
  version: '1.0.0'
}, {
  capabilities: {}
});

await client.connect(transport);

// List available prompts
const promptsList = await client.listPrompts();
console.log('Available prompts:', JSON.stringify(promptsList, null, 2));

// Get the memory-protocol prompt
if (promptsList.prompts.length > 0) {
  const prompt = await client.getPrompt({ name: 'memory-protocol' });
  console.log('\nMemory Protocol Prompt:', JSON.stringify(prompt, null, 2));
}

await client.close();
console.log('\n✓ Test complete');
