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

// Enable openai provider for testing
config.llm.providers.openai.enabled = true;

async function testOpenAI() {
  console.log('=== OpenAI Adapter Test (via LM Studio) ===\n');
  
  const router = new LLMRouter(config.llm);
  
  router.setProgressCallback((progress, total, message) => {
    console.log(`[${progress}/${total}] ${message}`);
  });

  try {
    console.log('Testing OpenAI-compatible endpoint:', config.llm.providers.openai.endpoint);
    console.log();

    // Test 1: List models
    console.log('1. Listing models...');
    const models = await router.listModels('openai');
    console.log(`✓ Available models: ${models.map(m => m.id).join(', ')}`);
    console.log();

    // Test 2: Text generation
    console.log('2. Testing text generation...');
    const response = await router.predict({
      prompt: 'In one sentence, what is the capital of France?',
      provider: 'openai',
      maxTokens: 50
    });
    console.log(`✓ Response: ${response.trim()}`);
    console.log();

    // Test 3: Capabilities
    console.log('3. Checking capabilities...');
    const caps = router.getCapabilities('openai');
    console.log(`✓ Capabilities:`, caps);
    console.log();

    console.log('=== OpenAI Adapter Test Passed ===');
    console.log('\n💡 To use with real OpenAI API:');
    console.log('   1. Get API key from https://platform.openai.com/api-keys');
    console.log('   2. Add to .env: OPENAI_API_KEY=sk-...');
    console.log('   3. Update config.json endpoint to: https://api.openai.com/v1/chat/completions');
  } catch (err) {
    console.error('Test failed:', err.message);
    console.error(err.stack);
  } finally {
    await router.disconnect('openai');
  }
}

testOpenAI().catch(console.error);
