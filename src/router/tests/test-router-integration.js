import { createRouter } from '../router.js';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('d:\\DEV\\mcp_server\\config.json', 'utf-8'));

// Replace env vars
config.llm.providers.lmstudio.endpoint = 'http://192.168.0.100:12345';
config.llm.providers.lmstudio.model = 'qwen3-coder-30b-a3b-instruct';

async function test() {
  console.log('Creating router...');
  const router = await createRouter(config.llm);
  
  console.log(`Providers: ${router.getProviders().join(', ')}\n`);
  
  // Test 1: Minimal params (only required fields)
  console.log('1. predict() - minimal params (defaults: taskType=query, temp=0.7)');
  const result = await router.predict({
    prompt: 'Say "hello".',
    systemPrompt: 'You are helpful.'
  });
  console.log(`   ✅ ${result}\n`);
  
  // Test 2: Task-based routing
  console.log('2. predict() - explicit task routing');
  const query = await router.predict({
    prompt: 'What is 2+2?',
    systemPrompt: 'You are helpful.',
    taskType: 'query',
    maxTokens: 10
  });
  console.log(`   ✅ ${query}\n`);
  
  // Test 3: Embeddings (task-based)
  console.log('3. embedText() - task routing');
  const embedding = await router.embedText('test');
  console.log(`   ✅ Vector: ${embedding.length}D\n`);
  
  // Test 4: Batch embeddings
  console.log('4. embedBatch()');
  const batch = await router.embedBatch(['test1', 'test2']);
  console.log(`   ✅ Batch: ${batch.length} vectors\n`);
  
  // Test 5: Large prompt (triggers compaction)
  console.log('5. predict() - auto-compaction (no maxTokens = use full context)');
  const largePrompt = 'test '.repeat(15000);
  const compacted = await router.predict({
    prompt: largePrompt,
    systemPrompt: 'Summarize.'
  });
  console.log(`   ✅ Compacted: ${compacted.length} chars\n`);
  
  // Test 6: Thinking tag stripping
  console.log('6. predict() - thinking tags stripped');
  const thinking = await router.predict({
    systemPrompt: 'Answer briefly.',
    prompt: 'What is 1+1? Use <think> tags to reason.',
    systemPrompt: 'Answer briefly.'
  });
  console.log(`   ✅ ${thinking}\n`);
  
  // Test 7: Model management (separate from predict)
  console.log('7. Model management');
  const loaded = await router.getLoadedModel();
  console.log(`   ✅ Loaded: ${loaded.key} (${loaded.contextLength} ctx)\n`);
  
  const models = await router.listModels();
  console.log(`   ✅ Available: ${models.length} models\n`);
  
  console.log('✅ ALL ROUTER INTEGRATION TESTS PASSED (7/7)');
}

test().catch(err => {
  console.error('❌ TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
