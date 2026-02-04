import { createRouter } from '../src/router/router.js';
import { createLocalAgentServer } from '../src/servers/local-agent.js';
import { createCodeSearchServer } from '../src/servers/code-search/server.js';
import fs from 'fs/promises';

async function test() {
  const config = JSON.parse(await fs.readFile('./config.json', 'utf8'));
  
  const router = await createRouter(config.llm);
  const codeSearch = await createCodeSearchServer(config.servers['code-search'], router);
  const agent = await createLocalAgentServer(config.servers['local-agent'], router);
  
  agent.setCodeSearchServer(codeSearch);

  console.log('\n=== Testing simplified run_local_agent ===\n');
  
  const result = await agent.callTool('run_local_agent', {
    task: 'Give me a brief overview of how the router handles multiple LLM providers',
    workspace: 'BADKID-DEV',
    maxFiles: 20,
    tokenBudget: 15000
  });

  const data = JSON.parse(result.content[0].text);
  
  if (data.error) {
    console.log('ERROR:', data.error);
    if (data.stack) console.log(data.stack);
  } else {
    console.log('Files analyzed:', data.files_analyzed);
    console.log('\nRetrieval plan:');
    data.retrieval_plan.forEach(p => {
      console.log(`  - ${p.file} ${p.startLine ? `(lines ${p.startLine}-${p.endLine})` : '(full file)'}`);
      if (p.reason) console.log(`    Reason: ${p.reason}`);
    });
    console.log('\nAnalysis:');
    console.log(data.analysis);
  }

  process.exit(0);
}

test().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
