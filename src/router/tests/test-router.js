// Router test: validates fast path (fits) and slow path (chunking/compaction)

import { config } from 'dotenv';
import { createRouter } from '../router.js';

config();

const endpoint = process.env.LM_STUDIO_HTTP_ENDPOINT || 'http://192.168.0.100:12345';

console.log('='.repeat(70));
console.log('ROUTER TESTS');
console.log('='.repeat(70));

async function getLoadedModel() {
  const res = await fetch(`${endpoint}/api/v1/models`);
  const data = await res.json();
  const loaded = data.models.find(m => m.type === 'llm' && m.loaded_instances?.length > 0);
  if (!loaded) throw new Error('No LLM model loaded in LM Studio');
  return loaded.key;
}

async function runTests() {
  console.log('\nFetching loaded model from LM Studio...');
  const modelName = await getLoadedModel();
  console.log('Model:', modelName);
  console.log('Endpoint:', endpoint);

  console.log('\nCreating router (auto-detects context window)...');
  const router = await createRouter(endpoint, modelName);
  console.log('Router config:');
  console.log('  Context window:', router.config.contextWindow.toLocaleString());
  console.log('  Available tokens:', router.availableTokens.toLocaleString());

  // Test 1: Fast path (data fits)
  console.log('\n' + '='.repeat(70));
  console.log('TEST 1: Small Data (Fast Path)');
  console.log('='.repeat(70));

  const smallData = 'What is the capital of France?';
  console.log('Data:', smallData);

  const start1 = performance.now();
  const result1 = await router.predict(
    'You are a helpful assistant. Answer concisely.',
    smallData,
    { max_tokens: 100 }
  );
  const time1 = performance.now() - start1;

  console.log('\nResult:');
  console.log('  Content:', result1.content);
  console.log('  Chunked:', result1.chunked);
  console.log('  Time:', (time1 / 1000).toFixed(2), 's');

  if (result1.chunked) {
    console.error('\n❌ FAIL: Small data should NOT be chunked');
    process.exit(1);
  }
  console.log('✅ PASS: Fast path works');

  // Test 2: Slow path (requires chunking)
  console.log('\n' + '='.repeat(70));
  console.log('TEST 2: Large Data (Slow Path with Chunking)');
  console.log('='.repeat(70));

  // Create data that exceeds context window
  const largeData = 'function test() { return true; }\n'.repeat(5000);
  console.log('Data size:', largeData.length.toLocaleString(), 'chars');
  console.log('Estimated tokens:', Math.ceil(largeData.length / 3).toLocaleString());

  const start2 = performance.now();
  const result2 = await router.predict(
    'Analyze this code and summarize its purpose in 2-3 sentences.',
    largeData,
    { max_tokens: 200 }
  );
  const time2 = performance.now() - start2;

  console.log('\nResult:');
  console.log('  Content:', result2.content);
  console.log('  Chunked:', result2.chunked);
  if (result2.originalTokens && result2.compressedTokens) {
    console.log('  Original tokens:', result2.originalTokens.toLocaleString());
    console.log('  Compressed tokens:', result2.compressedTokens.toLocaleString());
    const ratio = (result2.compressedTokens / result2.originalTokens * 100).toFixed(1);
    console.log('  Compression ratio:', ratio + '%');
  }
  console.log('  Time:', (time2 / 1000).toFixed(2), 's');

  if (!result2.chunked) {
    console.error('\n❌ FAIL: Large data SHOULD be chunked');
    process.exit(1);
  }
  console.log('✅ PASS: Slow path works');

  console.log('\n' + '='.repeat(70));
  console.log('✅ ALL TESTS PASSED');
  console.log('='.repeat(70));
}

runTests().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
