import { LLMRouter } from '../src/llm/router.js';
import { config } from 'dotenv';
import { readFileSync } from 'fs';

// Load environment variables
config();

// Load config
const configData = JSON.parse(readFileSync('./config.json', 'utf-8'));

// Replace env vars in config
const llmConfig = JSON.parse(
  JSON.stringify(configData.llm).replace(/\${(\w+)}/g, (_, key) => process.env[key] || '')
);

async function testLLMRouter() {
  console.log('=== LLM Router Test ===\n');
  
  const router = new LLMRouter(llmConfig);
  
  // Set progress callback
  router.setProgressCallback((progress, total, message) => {
    console.log(`[${progress}/${total}] ${message}`);
  });

  try {
    // List all providers
    console.log('1. Listing providers...');
    const providers = await router.listProviders();
    console.log('Available providers:');
    providers.forEach(p => {
      console.log(`  - ${p.name} (${p.connected ? 'connected' : 'not connected'}) ${p.isDefault ? '[DEFAULT]' : ''}`);
      console.log(`    Capabilities: streaming=${p.capabilities.streaming}, embeddings=${p.capabilities.embeddings}`);
    });
    console.log();

    // Test default provider (LM Studio)
    console.log('2. Testing default provider (LM Studio)...');
    const lmstudioModels = await router.listModels();
    console.log(`Available models: ${lmstudioModels.map(m => m.id).join(', ')}`);
    
    const loaded = await router.getLoadedModel();
    console.log(`Currently loaded: ${loaded ? loaded.id : 'none'}`);
    console.log();

    // Generate text with default provider
    console.log('3. Generating text with default provider...');
    const response1 = await router.predict({
      prompt: 'In one sentence, what is the capital of France?',
      maxTokens: 50
    });
    console.log(`Response: ${response1.trim()}`);
    console.log();

    // Test Ollama (if enabled)
    if (llmConfig.providers.ollama?.enabled) {
      console.log('4. Testing Ollama...');
      try {
        const ollamaModels = await router.listModels('ollama');
        console.log(`Ollama models: ${ollamaModels.map(m => m.id).join(', ')}`);
        
        const response2 = await router.predict({
          prompt: 'In one sentence, what is 2+2?',
          provider: 'ollama',
          maxTokens: 30
        });
        console.log(`Response: ${response2.trim()}`);
      } catch (err) {
        console.log(`Ollama error: ${err.message}`);
      }
      console.log();
    }

    // Test Gemini (if enabled and API key provided)
    if (llmConfig.providers.gemini?.enabled && llmConfig.providers.gemini.apiKey) {
      console.log('5. Testing Gemini...');
      try {
        const geminiModels = await router.listModels('gemini');
        console.log(`Gemini models: ${geminiModels.map(m => m.id).join(', ')}`);
        
        const response3 = await router.predict({
          prompt: 'In one sentence, what is machine learning?',
          provider: 'gemini',
          model: 'gemini-2.0-flash-exp',
          maxTokens: 50
        });
        console.log(`Response: ${response3.trim()}`);
      } catch (err) {
        console.log(`Gemini error: ${err.message}`);
      }
      console.log();
    }

    // Test embeddings
    console.log('6. Testing embeddings...');
    try {
      const embedding = await router.embedText('Hello, world!');
      console.log(`Embedding vector length: ${embedding.length}`);
      console.log(`First 5 values: ${embedding.slice(0, 5).join(', ')}`);
    } catch (err) {
      console.log(`Embedding error: ${err.message}`);
    }
    console.log();

    // Check capabilities
    console.log('7. Provider capabilities:');
    for (const [name, adapter] of router.adapters.entries()) {
      const caps = adapter.getCapabilities();
      console.log(`  ${name}:`, caps);
    }

  } catch (err) {
    console.error('Test failed:', err);
    console.error(err.stack);
  } finally {
    // Cleanup
    await router.disconnect();
    console.log('\n=== Test Complete ===');
  }
}

testLLMRouter().catch(console.error);
