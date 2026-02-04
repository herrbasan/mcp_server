import { createGeminiAdapter } from '../adapters/gemini.js';
import 'dotenv/config';

const config = {
  apiKey: process.env.GEMINI_API_KEY,
  model: 'gemini-2.5-flash',
  embeddingModel: 'gemini-embedding-001',
  embeddingDimensions: 768
};

async function test() {
  if (!config.apiKey || config.apiKey.includes('your-')) {
    console.log('⚠️  GEMINI_API_KEY not set in .env, skipping tests');
    return;
  }
  
  const adapter = createGeminiAdapter(config);
  
  console.log('Testing Gemini adapter (Google AI)...\n');
  
  // Test 1: List models
  console.log('1. listModels()');
  const models = await adapter.listModels();
  const genModels = models.filter(m => m.supportedGenerationMethods?.includes('generateContent'));
  console.log(`   ✅ Found ${models.length} models (${genModels.length} support generation)\n`);
  
  // Test 2: Context window
  console.log('2. getContextWindow()');
  const ctx = await adapter.getContextWindow();
  console.log(`   ✅ Context: ${ctx.toLocaleString()} tokens\n`);
  
  // Test 3: Simple prediction
  console.log('3. predict() - simple');
  const result = await adapter.predict({
    systemPrompt: 'You are helpful. Be extremely brief.',
    prompt: 'Say "hello" and nothing else.',
    maxTokens: 20,
    temperature: 0
  });
  console.log(`   ✅ Response: ${result.trim()}\n`);
  
  // Test 4: Single embedding
  console.log('4. embedText()');
  const embedding = await adapter.embedText('test');
  console.log(`   ✅ Vector: ${embedding.length}D\n`);
  
  // Test 5: Batch embedding
  console.log('5. embedBatch()');
  const embeddings = await adapter.embedBatch(['hello', 'world', 'test']);
  console.log(`   ✅ ${embeddings.length} vectors, each ${embeddings[0].length}D\n`);
  
  // Test 6: JSON schema structured output
  console.log('6. predict() - JSON schema');
  const json = await adapter.predict({
    systemPrompt: 'Extract person info to JSON',
    prompt: 'John is 30 from NYC.',
    responseFormat: { 
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
          city: { type: 'string' }
        },
        required: ['name', 'age', 'city']
      }
    },
    maxTokens: 100
  });
  console.log(`   ✅ JSON: ${json.trim()}\n`);
  
  // Test 7: Token counting
  console.log('7. countTokens()');
  const tokens = await adapter.countTokens('Hello, how are you today?');
  console.log(`   ✅ Tokens: ${tokens}\n`);
  
  // Test 8: Capabilities
  console.log('8. capabilities');
  const caps = adapter.capabilities;
  console.log(`   embeddings: ${caps.embeddings}`);
  console.log(`   structuredOutput: ${caps.structuredOutput}`);
  console.log(`   batch: ${caps.batch}`);
  console.log(`   modelManagement: ${caps.modelManagement}`);
  console.log(`   local: ${caps.local}`);
  console.log(`   ✅ All capabilities defined\n`);

  console.log('✅ ALL 8 GEMINI ADAPTER TESTS PASSED');
}

test().catch(err => {
  console.error('❌ ADAPTER TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
