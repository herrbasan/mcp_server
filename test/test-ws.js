import { LMStudioWSServer } from './src/servers/lm-studio-ws.js';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('config.json', 'utf-8'));

console.log('🧪 Testing WebSocket LM Studio implementation\n');

const server = new LMStudioWSServer(config.servers['lm-studio']);

let progressCount = 0;
server.setProgressCallback((progress, total, message) => {
  progressCount++;
  console.log(`📊 [${progress}/${total}] ${message}`);
});

try {
  // Test 1: Get available models
  console.log('📋 Fetching available models...\n');
  const models = await server.getAvailableModels();
  console.log(`Found ${models.length} LLM models (excluding embeddings)\n`);
  
  models.forEach(m => {
    console.log(`  ${m.isLoaded ? '✓' : '○'} ${m.id}`);
    if (m.isLoaded) {
      console.log(`    Context: ${m.contextLength || 'N/A'} / Max: ${m.maxContextLength || 'N/A'}`);
    }
  });
  
  // Test 2: Get loaded model
  console.log('\n📍 Current loaded model:\n');
  const loaded = await server.getLoadedModel();
  if (loaded) {
    console.log(`  Model: ${loaded.id}`);
    console.log(`  Context: ${loaded.contextLength}`);
    console.log(`  Vision: ${loaded.supportsVision}`);
    console.log(`  Tools: ${loaded.supportsToolUse}`);
  } else {
    console.log('  No model loaded');
  }
  
  // Test 3: Simple question
  console.log('\n💬 Testing prediction with progress...\n');
  
  const result = await server.callTool('get_second_opinion', {
    question: 'In one sentence, what is the benefit of WebSocket over HTTP for real-time apps?'
  });
  
  console.log('\n✅ Response:\n');
  console.log(result.content[0].text);
  
  console.log(`\n✨ Total progress updates: ${progressCount}`);
  
  // Cleanup
  await server.cleanup();
  console.log('\n✓ Cleanup complete');
  
} catch (err) {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  await server.cleanup();
  process.exit(1);
}
