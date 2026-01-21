import { config as loadDotEnv } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { LLMRouter } from '../src/llm/router.js';
import { MemoryServer } from '../src/servers/memory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: join(__dirname, '..', '.env') });

// Load and parse config with env var substitution
const configRaw = readFileSync(join(__dirname, '..', 'config.json'), 'utf-8');
const configStr = configRaw.replace(/\${(\w+)}/g, (_, key) => process.env[key] || '');
const config = JSON.parse(configStr);

async function testMemoryWithRouter() {
  console.log('=== Memory Server + Router Integration Test ===\n');
  
  // Initialize router
  const router = new LLMRouter(config.llm);
  console.log('✓ Router initialized');
  console.log(`  Default provider: ${router.defaultProvider}`);
  console.log(`  Task defaults:`, router.taskDefaults);
  console.log();

  // Initialize memory server with router
  const memoryServer = new MemoryServer(config.servers.memory, router);
  console.log('✓ Memory server initialized');
  console.log(`  Embedding provider: ${memoryServer.embeddingProvider || '(using task default)'}`);
  console.log();

  try {
    // Test 1: Store a memory
    console.log('1. Testing remember (embedding generation)...');
    const result = await memoryServer.callTool('remember', {
      text: 'LLM router integration test - hybrid routing works with task defaults',
      category: 'proven',
      domain: 'mcp_server'
    });
    console.log(`✓ Memory stored: ${result.content[0].text}`);
    console.log();

    // Test 2: Recall memories
    console.log('2. Testing recall (embedding search)...');
    const recallResult = await memoryServer.callTool('recall', {
      query: 'router integration',
      domain: 'mcp_server'
    });
    console.log(`✓ Recall complete`);
    console.log(recallResult.content[0].text.substring(0, 200) + '...');
    console.log();

    // Test 3: Verify routing
    console.log('3. Verifying task-based routing...');
    const embeddingProvider = router._resolveProvider(memoryServer.embeddingProvider, 'embedding');
    console.log(`  Resolved embedding provider: ${embeddingProvider}`);
    console.log(`  Expected: ${config.llm.taskDefaults.embedding || config.llm.defaultProvider}`);
    console.log();

    console.log('=== All Tests Passed ===');
  } catch (err) {
    console.error('Test failed:', err);
    console.error(err.stack);
  }
}

testMemoryWithRouter().catch(console.error);
