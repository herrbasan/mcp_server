import { config as loadDotEnv } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LLMRouter } from '../src/llm/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: join(__dirname, '..', '.env') });

const configRaw = readFileSync(join(__dirname, '..', 'config.json'), 'utf-8');
const configStr = configRaw.replace(/\${(\w+)}/g, (_, key) => process.env[key] || '');
const config = JSON.parse(configStr);

async function testOllama() {
  console.log('=== Ollama Endpoint Test ===\n');
  
  const router = new LLMRouter(config.llm);
  
  router.setProgressCallback((progress, total, message) => {
    console.log(`[${progress}/${total}] ${message}`);
  });

  try {
    // Test 1: Check connection
    console.log('1. Testing Ollama connection...');
    const ollamaAdapter = router.getAdapter('ollama');
    const connected = await ollamaAdapter.isConnected();
    console.log(`✓ Connection status: ${connected ? 'CONNECTED' : 'NOT CONNECTED'}`);
    console.log();

    if (!connected) {
      console.log('❌ Cannot reach Ollama at', config.llm.providers.ollama.endpoint);
      return;
    }

    // Test 2: List models
    console.log('2. Listing available models...');
    const models = await router.listModels('ollama');
    console.log(`✓ Found ${models.length} models:`);
    models.forEach(m => console.log(`  - ${m.id} (${(m.size / 1e9).toFixed(2)} GB)`));
    console.log();

    // Test 3: Text generation
    console.log('3. Testing text generation...');
    const response = await router.predict({
      prompt: 'In one sentence, what is the capital of France?',
      provider: 'ollama',
      model: config.llm.providers.ollama.model,
      maxTokens: 50
    });
    console.log(`✓ Response: ${response.trim()}`);
    console.log();

    // Test 4: Embeddings
    console.log('4. Testing embeddings...');
    const embedding = await router.embedText('Hello, world!', 'ollama');
    console.log(`✓ Embedding generated: ${embedding.length} dimensions`);
    console.log(`  First 5 values: [${embedding.slice(0, 5).map(v => v.toFixed(4)).join(', ')}]`);
    console.log();

    // Test 5: Capabilities
    console.log('5. Ollama capabilities:');
    const caps = router.getCapabilities('ollama');
    console.log(`  streaming: ${caps.streaming}`);
    console.log(`  embeddings: ${caps.embeddings}`);
    console.log(`  vision: ${caps.vision}`);
    console.log(`  toolUse: ${caps.toolUse}`);
    console.log(`  modelManagement: ${caps.modelManagement}`);
    console.log(`  progressReporting: ${caps.progressReporting}`);
    console.log();

    console.log('=== All Ollama Tests Passed ===');
  } catch (err) {
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
  }
}

testOllama().catch(console.error);
