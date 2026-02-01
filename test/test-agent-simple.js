import { LocalAgentServer } from '../src/servers/local-agent.js';
import { LLMRouter } from '../src/llm/router.js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const configText = fs.readFileSync('config.json', 'utf-8')
  .replace(/\$\{([^}]+)\}/g, (match, varName) => process.env[varName] || match);
const config = JSON.parse(configText);

console.log('Initializing LLM Router...');
const router = new LLMRouter(config.llm);

console.log('Creating LocalAgentServer...');
const agent = new LocalAgentServer(config.servers['local-agent'], router);
agent.workspace = new (await import('../src/lib/workspace.js')).WorkspaceResolver(config.workspaces);

console.log('Workspace config:', config.workspaces);

// Add progress logging
agent.setProgressCallback((progress) => {
  console.log(`[Progress] ${progress.progress}% - ${progress.message}`);
});

console.log('\nTesting simple read task...\n');

const result = await agent.callTool('run_local_agent', {
  task: 'Read the file libs/ffmpeg-napi-interface/lib/player-sab.js and summarize what it does in 2-3 sentences.',
  path: 'D:\\Work\\_GIT\\SoundApp',
  machine: 'COOLKID',
  maxTokens: 20000
});

console.log('\n=== RESULT ===');
console.log(JSON.stringify(JSON.parse(result.content[0].text), null, 2));

process.exit(0);
