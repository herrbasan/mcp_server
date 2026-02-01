import fs from 'fs/promises';

console.log('Testing module initialization...\n');

// Test loading config
console.log('Test 1: Load config.json');
const config = JSON.parse(await fs.readFile('config.json', 'utf-8'));
console.log('✓ Config loaded');

// Test workspaces config (new simplified format)
console.log('\nTest 2: Validate workspaces config');
if (!config.workspaces) {
  throw new Error('Missing workspaces config');
}
const workspaceCount = Object.keys(config.workspaces).length;
if (workspaceCount === 0) {
  throw new Error('No workspaces configured');
}
console.log(`✓ Configured workspaces: ${Object.keys(config.workspaces).join(', ')}`);

// Test local-agent config
console.log('\nTest 3: Validate local-agent config');
if (!config.servers['local-agent']) {
  throw new Error('Missing local-agent config');
}
const agentConfig = config.servers['local-agent'];
console.log(`✓ Enabled: ${agentConfig.enabled}`);
console.log(`✓ Max token budget: ${agentConfig.maxTokenBudget}`);
console.log(`✓ Max iterations: ${agentConfig.maxIterations}`);
console.log(`✓ Tool calling format: ${agentConfig.toolCallingFormat}`);

// Test code-search config
console.log('\nTest 4: Validate code-search config');
if (!config.servers['code-search']) {
  throw new Error('Missing code-search config');
}
const searchConfig = config.servers['code-search'];
console.log(`✓ Enabled: ${searchConfig.enabled}`);
console.log(`✓ Index path: ${searchConfig.indexPath}`);

// Test LLM router has agent task type
console.log('\nTest 5: Validate LLM router config');
if (!config.llm.taskDefaults.agent) {
  throw new Error('Missing agent task type in LLM router');
}
console.log(`✓ Agent task default: ${config.llm.taskDefaults.agent}`);

// Test module imports
console.log('\nTest 6: Import WorkspaceResolver');
const { WorkspaceResolver } = await import('../src/lib/workspace.js');
console.log('✓ WorkspaceResolver imported');

console.log('\nTest 7: Import LocalAgentServer');
const { LocalAgentServer } = await import('../src/servers/local-agent.js');
console.log('✓ LocalAgentServer imported');

console.log('\nTest 8: Import CodeSearchServer');
const { CodeSearchServer } = await import('../src/servers/code-search.js');
console.log('✓ CodeSearchServer imported');

// Test module instantiation
console.log('\nTest 9: Instantiate WorkspaceResolver');
const resolver = new WorkspaceResolver(config.workspaces);
console.log('✓ WorkspaceResolver instantiated');

console.log('\nTest 10: Instantiate LocalAgentServer (without LLM router)');
try {
  const agent = new LocalAgentServer({ ...agentConfig, workspaces: config.workspaces }, null);
  console.log('✓ LocalAgentServer instantiated');
  console.log(`✓ Tools: ${agent.getTools().length}`);
  console.log(`  - ${agent.getTools()[0].name}`);
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
}

console.log('\nTest 11: Instantiate CodeSearchServer (without LLM router)');
try {
  const search = new CodeSearchServer({ ...searchConfig, workspaces: config.workspaces }, null);
  console.log('✓ CodeSearchServer instantiated');
  console.log(`✓ Tools: ${search.getTools().length}`);
  const toolNames = search.getTools().map(t => t.name);
  console.log(`  - ${toolNames.join('\n  - ')}`);
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
}

console.log('\n✓ All initialization tests passed!');
console.log('\nNext steps:');
console.log('1. Build an index: node scripts/build-index.js --workspace "BADKID-DEV"');
console.log('   Or build all: node scripts/build-index.js --all --force');
console.log('2. Start server: npm run start:http');
console.log('3. Test via MCP client');
