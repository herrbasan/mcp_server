// Test structured output on all enabled providers
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createRouter } from '../src/router/router.js';

// Load config with env substitution
const configText = readFileSync('config.json', 'utf-8');
const config = JSON.parse(configText.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || ''));

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    hex: { type: 'string' },
    feelings: { type: 'array', items: { type: 'string' } }
  },
  required: ['name', 'hex', 'feelings']
};

async function testProvider(router, provider) {
  console.log(`\n--- Testing ${provider} ---`);
  try {
    const result = await router.predict({
      prompt: 'Describe the color green in structured format',
      systemPrompt: 'You provide structured JSON responses.',
      provider,
      responseFormat: schema,
      maxTokens: 200
    });
    console.log('Raw:', result);
    const parsed = JSON.parse(result);
    console.log('Parsed:', parsed);
    console.log(`✓ ${provider} PASSED`);
    return true;
  } catch (err) {
    console.error(`✗ ${provider} FAILED:`, err.message);
    return false;
  }
}

async function main() {
  console.log('Creating router...');
  const router = await createRouter(config.llm);
  
  const providers = router.getProviders();
  console.log('Enabled providers:', providers);
  
  const results = {};
  for (const provider of providers) {
    results[provider] = await testProvider(router, provider);
  }
  
  console.log('\n=== Summary ===');
  for (const [provider, passed] of Object.entries(results)) {
    console.log(`${passed ? '✓' : '✗'} ${provider}`);
  }
}

main().catch(console.error);
