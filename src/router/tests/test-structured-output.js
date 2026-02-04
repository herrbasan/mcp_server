import { createLMStudioAdapter } from '../adapters/lmstudio.js';

const config = {
  httpEndpoint: 'http://192.168.0.100:12345',
  model: 'qwen3-coder-30b-a3b-instruct',
  embeddingModel: 'nomic-embed-text-v2-moe'
};

async function test() {
  const adapter = createLMStudioAdapter(config);
  
  console.log('Testing structured output with different formats:\n');
  
  // Test 1: No response_format (baseline)
  console.log('1. No response_format');
  try {
    const result = await adapter.predict({
      systemPrompt: 'Extract info to JSON.',
      prompt: 'John is 30 years old from NYC.',
      maxTokens: 100
    });
    console.log(`   ✅ ${result}\n`);
  } catch (err) {
    console.log(`   ❌ ${err.message}\n`);
  }
  
  // Test 2: response_format as object
  console.log('2. response_format = { type: "json_object" }');
  try {
    const result = await adapter.predict({
      systemPrompt: 'Extract info to JSON.',
      prompt: 'John is 30 years old from NYC.',
      responseFormat: { type: 'json_object' },
      maxTokens: 100
    });
    console.log(`   ✅ ${result}\n`);
  } catch (err) {
    console.log(`   ❌ ${err.message}\n`);
  }
  
  // Test 3: response_format as JSON schema
  console.log('3. response_format with schema');
  try {
    const result = await adapter.predict({
      systemPrompt: 'Extract info to JSON.',
      prompt: 'John is 30 years old from NYC.',
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'person',
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'number' },
              city: { type: 'string' }
            },
            required: ['name', 'age', 'city']
          }
        }
      },
      maxTokens: 100
    });
    console.log(`   ✅ ${result}\n`);
  } catch (err) {
    console.log(`   ❌ ${err.message}\n`);
  }
}

test().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
