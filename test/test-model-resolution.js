// Test model resolution fallback logic
import 'dotenv/config';
import { readFileSync } from 'fs';
import { createRouter } from '../src/router/router.js';

// Load config but CLEAR the model env vars to test fallback
delete process.env.LM_STUDIO_MODEL;
delete process.env.OLLAMA_MODEL;
delete process.env.GEMINI_MODEL;

const configText = readFileSync('config.json', 'utf-8');
const config = JSON.parse(configText.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || ''));

console.log('Testing model resolution fallback...');
console.log('LM_STUDIO_MODEL:', process.env.LM_STUDIO_MODEL || '(not set)');
console.log('OLLAMA_MODEL:', process.env.OLLAMA_MODEL || '(not set)');
console.log('GEMINI_MODEL:', process.env.GEMINI_MODEL || '(not set)');
console.log();

async function main() {
  const router = await createRouter(config.llm);
  
  console.log('\nProviders:', router.getProviders());
  
  // Test each provider
  for (const provider of router.getProviders()) {
    console.log(`\n--- ${provider} ---`);
    try {
      const result = await router.predict({
        prompt: 'What is 2+2? Answer with just the number.',
        systemPrompt: 'Be brief.',
        provider,
        maxTokens: 10
      });
      console.log('Response:', result.trim());
      console.log(`✓ ${provider} works`);
    } catch (err) {
      console.error(`✗ ${provider} failed:`, err.message);
    }
  }
}

main().catch(console.error);
