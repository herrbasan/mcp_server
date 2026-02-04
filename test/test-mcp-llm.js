import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_ENDPOINT = 'http://localhost:3100/mcp';

async function testMCP() {
  console.log('Testing LLM via MCP protocol...\n');

  const client = new Client({
    name: 'test-client',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT));
  await client.connect(transport);

  console.log('✓ Connected to MCP server\n');

  // Test 1: Basic query
  console.log('Test 1: Basic query (2+2)');
  try {
    const result = await client.callTool({
      name: 'query_model',
      arguments: {
        prompt: 'What is 2+2? Answer with just the number.'
      }
    });
    console.log('Result:', result.content[0].text);
  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n---\n');

  // Test 2: Structured output
  console.log('Test 2: Structured output (JSON schema)');
  try {
    const result = await client.callTool({
      name: 'query_model',
      arguments: {
        prompt: 'Describe the color blue in a structured format',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            hex: { type: 'string' },
            feelings: { type: 'array', items: { type: 'string' } }
          },
          required: ['name', 'hex', 'feelings']
        }
      }
    });
    const text = result.content[0].text;
    console.log('Result:', text);
    console.log('Parsed:', JSON.parse(text));
  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n---\n');

  // Test 3: Limited output
  console.log('Test 3: Limited output (maxTokens=20)');
  try {
    const result = await client.callTool({
      name: 'query_model',
      arguments: {
        prompt: 'Explain quantum computing in simple terms',
        maxTokens: 20
      }
    });
    console.log('Result:', result.content[0].text);
    console.log('(Should be truncated due to maxTokens=20)');
  } catch (err) {
    console.error('Error:', err.message);
  }

  await client.close();
  console.log('\n✓ Tests complete');
}

testMCP().catch(console.error);
