// Test embedding dimensions for both LMStudio and Ollama

import { LLMRouter } from '../src/llm/router.js';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const configData = JSON.parse(readFileSync('config.json', 'utf8'));

// Substitute env vars
function substituteEnvVars(obj) {
  const str = JSON.stringify(obj);
  const replaced = str.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
  return JSON.parse(replaced);
}

const processedConfig = substituteEnvVars(configData);
const router = new LLMRouter(processedConfig.llm);

async function test() {
  console.log('\n=== Testing Embedding Dimensions ===\n');

  try {
    // Test LMStudio embedding
    console.log('Testing LMStudio...');
    const lmStudioEmbed = await router.embedText('test', 'lmstudio');
    console.log(`LMStudio (${processedConfig.llm.providers.lmstudio.embeddingModel}): ${lmStudioEmbed.length} dimensions`);

    // Test Ollama embedding
    console.log('\nTesting Ollama...');
    const ollamaEmbed = await router.embedText('test', 'ollama');
    console.log(`Ollama (${processedConfig.llm.providers.ollama.embeddingModel}): ${ollamaEmbed.length} dimensions`);

    // Compare
    console.log('\n=== Comparison ===');
    console.log(`Dimensions match: ${lmStudioEmbed.length === ollamaEmbed.length}`);
    if (lmStudioEmbed.length !== ollamaEmbed.length) {
      console.log('⚠️  Different dimensions - embeddings are incompatible!');
    } else {
      console.log('✓ Same dimensions - embeddings are compatible');
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await router.disconnect();
    process.exit(0);
  }
}

test();
