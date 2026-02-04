import 'dotenv/config';

const MCP_ENDPOINT = 'http://localhost:3100/mcp';

async function testLLM() {
  console.log('Testing LLM endpoint after router simplification...\n');

  // Test 1: Basic query
  console.log('Test 1: Basic query');
  try {
    const response1 = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query_model',
          arguments: {
            prompt: 'What is 2+2? Answer with just the number.'
          }
        }
      })
    });
    const result1 = await response1.json();
    console.log('Result:', result1.result?.content?.[0]?.text || result1);
  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n---\n');

  // Test 2: Structured output
  console.log('Test 2: Structured output (JSON schema)');
  try {
    const response2 = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
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
        }
      })
    });
    const result2 = await response2.json();
    const text2 = result2.result?.content?.[0]?.text;
    console.log('Result:', text2);
    console.log('Parsed:', JSON.parse(text2));
  } catch (err) {
    console.error('Error:', err.message);
  }

  console.log('\n---\n');

  // Test 3: Limited output
  console.log('Test 3: Limited output (maxTokens=20)');
  try {
    const response3 = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'query_model',
          arguments: {
            prompt: 'Explain quantum computing in simple terms',
            maxTokens: 20
          }
        }
      })
    });
    const result3 = await response3.json();
    console.log('Result:', result3.result?.content?.[0]?.text || result3);
    console.log('(Should be truncated due to maxTokens=20)');
  } catch (err) {
    console.error('Error:', err.message);
  }
}

testLLM().catch(console.error);
