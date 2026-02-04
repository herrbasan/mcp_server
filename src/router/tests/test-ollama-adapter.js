import { createOllamaAdapter } from '../adapters/ollama.js';
import 'dotenv/config';

const config = {
  httpEndpoint: process.env.OLLAMA_ENDPOINT || 'http://192.168.0.145:11434',
  model: 'gemma3:12b',
  embeddingModel: 'nomic-embed-text'
};

async function test() {
  const adapter = createOllamaAdapter(config);
  
  console.log('Testing Ollama adapter (FATTEN @ 192.168.0.145)...\n');
  
  // Test 1: List models (GET /api/tags)
  console.log('1. listModels()');
  const models = await adapter.listModels();
  console.log(`   ✅ Found ${models.length} models: ${models.map(m => m.name).join(', ')}\n`);
  
  // Test 2: Show model info (POST /api/show)
  console.log('2. showModelInfo()');
  const info = await adapter.showModelInfo('gemma3:12b');
  const ctxKey = Object.keys(info.model_info || {}).find(k => k.includes('context_length'));
  console.log(`   Model: ${info.modelfile ? 'has Modelfile' : 'no Modelfile'}`);
  console.log(`   Context: ${ctxKey ? info.model_info[ctxKey] : 'not found'}`);
  console.log(`   ✅ Model info retrieved\n`);
  
  // Test 3: Context window (via show API)
  console.log('3. getContextWindow()');
  const ctx = await adapter.getContextWindow();
  console.log(`   ✅ Context: ${ctx} tokens\n`);
  
  // Test 4: Get version
  console.log('4. getVersion()');
  const version = await adapter.getVersion();
  console.log(`   ✅ Ollama version: ${version.version}\n`);

  // Test 5: Running models (GET /api/ps)
  console.log('5. getRunningModels()');
  const running = await adapter.getRunningModels();
  if (running.length > 0) {
    console.log(`   Running: ${running.map(m => m.name).join(', ')}`);
    console.log(`   VRAM: ${(running[0].sizeVram / 1e9).toFixed(2)} GB`);
  } else {
    console.log('   No models currently loaded');
  }
  console.log(`   ✅ Running models check complete\n`);
  
  // Test 6: Single embedding (POST /api/embed)
  console.log('6. embedText()');
  const embedding = await adapter.embedText('test');
  console.log(`   ✅ Vector: ${embedding.length}D\n`);
  
  // Test 7: Batch embedding (POST /api/embed with array)
  console.log('7. embedBatch()');
  const embeddings = await adapter.embedBatch(['hello', 'world', 'test']);
  console.log(`   ✅ ${embeddings.length} vectors, each ${embeddings[0].length}D\n`);
  
  // Test 8: Simple prediction
  console.log('8. predict() - simple');
  const result = await adapter.predict({
    systemPrompt: 'You are helpful. Be brief.',
    prompt: 'Say "hello" and nothing else.',
    maxTokens: 20,
    temperature: 0
  });
  console.log(`   ✅ Response: ${result.trim()}\n`);
  
  // Test 9: JSON mode with schema
  console.log('9. predict() - JSON schema');
  const json = await adapter.predict({
    systemPrompt: 'Extract person info to JSON',
    prompt: 'John is 30 from NYC.',
    responseFormat: { 
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
          city: { type: 'string' }
        },
        required: ['name', 'age', 'city']
      }
    },
    maxTokens: 100
  });
  console.log(`   ✅ JSON: ${json.trim()}\n`);
  
  // Test 10: Capabilities
  console.log('10. capabilities');
  const caps = adapter.capabilities;
  console.log(`    embeddings: ${caps.embeddings}`);
  console.log(`    structuredOutput: ${caps.structuredOutput}`);
  console.log(`    batch: ${caps.batch}`);
  console.log(`    modelManagement: ${caps.modelManagement}`);
  console.log(`    local: ${caps.local}`);
  console.log(`    ✅ All capabilities defined\n`);

  console.log('✅ ALL 10 OLLAMA ADAPTER TESTS PASSED');
}

test().catch(err => {
  console.error('❌ ADAPTER TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
