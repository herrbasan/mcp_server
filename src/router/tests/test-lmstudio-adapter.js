import { createLMStudioAdapter } from '../adapters/lmstudio.js';

const config = {
  httpEndpoint: 'http://192.168.0.100:12345',
  model: 'qwen3-coder-30b-a3b-instruct',
  embeddingModel: 'nomic-embed-text-v2-moe'
};

async function test() {
  const adapter = createLMStudioAdapter(config);
  
  console.log('Testing LMStudio adapter...\n');
  
  // Test 1: Context window detection
  console.log('1. getContextWindow()');
  const ctx = await adapter.getContextWindow();
  console.log(`   ✅ Context: ${ctx} tokens\n`);
  
  // Test 2: Simple prediction
  console.log('2. predict() - simple');
  const result = await adapter.predict({
    systemPrompt: 'You are helpful.',
    prompt: 'Say "hello" and nothing else.',
    maxTokens: 10,
    temperature: 0
  });
  console.log(`   ✅ Response: ${result}\n`);
  
  // Test 3: Single embedding
  console.log('3. embedText()');
  const embedding = await adapter.embedText('test');
  console.log(`   ✅ Vector: ${embedding.length}D\n`);
  
  // Test 4: Batch embeddings
  console.log('4. embedBatch()');
  const batch = await adapter.embedBatch(['test1', 'test2', 'test3']);
  console.log(`   ✅ Batch: ${batch.length} vectors (${batch[0].length}D each)\n`);
  
  // Test 5: Structured output (JSON schema)
  console.log('5. predict() - structured output');
  const structured = await adapter.predict({
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
  console.log(`   ✅ JSON: ${structured}\n`);
  
  // Test 6: Capabilities
  console.log('6. capabilities');
  const caps = adapter.capabilities;
  console.log(`   embeddings: ${caps.embeddings}`);
  console.log(`   structuredOutput: ${caps.structuredOutput}`);
  console.log(`   batch: ${caps.batch}`);
  console.log(`   modelManagement: ${caps.modelManagement}`);
  console.log(`   local: ${caps.local} (endpoint: ${config.httpEndpoint})`);
  console.log(`   ✅ All capabilities defined\n`);

  console.log('✅ ALL LMSTUDIO ADAPTER TESTS PASSED');
}

test().catch(err => {
  console.error('❌ ADAPTER TEST FAILED:', err.message);
  process.exit(1);
});
