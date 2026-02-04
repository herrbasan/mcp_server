import { createRouter } from '../src/router/router.js';
import { createLocalAgentServer } from '../src/servers/local-agent.js';
import fs from 'fs/promises';

async function test() {
  const config = JSON.parse(await fs.readFile('./config.json', 'utf8'));
  
  // Use gemini or lmstudio - whichever is configured
  config.llm.taskDefaults = config.llm.taskDefaults || {};
  config.llm.taskDefaults.agent = 'gemini';  // or 'lmstudio' if you have it running
  
  const router = await createRouter(config.llm);
  const agent = await createLocalAgentServer(config, router);

  console.log('\n=== Test 1: Single file ===');
  const start1 = Date.now();
  const result1 = await agent.callTool('inspect_code', {
    target: 'mcp_server/test/test-inspect-extraction.js',
    question: 'What does this test file do?',
    workspace: 'BADKID-DEV'
  });
  console.log('Time:', Date.now() - start1, 'ms');
  console.log('Result:', result1.content[0].text.substring(0, 300) + '...');

  console.log('\n=== Test 2: Multiple files ===');
  const start2 = Date.now();
  const result2 = await agent.callTool('inspect_code', {
    target: 'mcp_server/src/router/router.js, mcp_server/src/router/context-manager.js',
    question: 'How do these files work together?',
    workspace: 'BADKID-DEV'
  });
  console.log('Time:', Date.now() - start2, 'ms');
  console.log('Result:', result2.content[0].text.substring(0, 300) + '...');

  process.exit(0);
}

test().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
