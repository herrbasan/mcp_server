import { spawn } from 'child_process';

const server = spawn('node', ['src/stdio-server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
let testsPassed = 0;
let testsFailed = 0;

server.stdout.on('data', (data) => {
  buffer += data.toString();
  let lines = buffer.split('\n');
  buffer = lines.pop();
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      
      if (msg.result) {
        console.log('\n✅ Result received:');
        console.log(JSON.stringify(msg.result, null, 2));
        testsPassed++;
      } else if (msg.error) {
        console.error('\n❌ Error:', msg.error);
        testsFailed++;
      } else if (msg.method === 'notifications/progress') {
        console.log(`📊 Progress: [${msg.params.progress}/${msg.params.total}] ${msg.params.message}`);
      }
    } catch (e) {
      // Ignore non-JSON
    }
  }
});

server.stderr.on('data', (data) => {
  console.error(data.toString().trim());
});

await new Promise(r => setTimeout(r, 1000));

console.log('🧪 MCP PROTOCOL TEST: WebSocket LM Studio Integration\n');

// Test 1: List resources
console.log('═══════════════════════════════════════════════════════');
console.log('TEST 1: List MCP Resources');
console.log('═══════════════════════════════════════════════════════\n');

server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'resources/list'
}) + '\n');

await new Promise(r => setTimeout(r, 2000));

// Test 2: Read models resource
console.log('\n═══════════════════════════════════════════════════════');
console.log('TEST 2: Read LM Studio Models Resource');
console.log('═══════════════════════════════════════════════════════\n');

server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'resources/read',
  params: {
    uri: 'lmstudio://models/ws'
  }
}) + '\n');

await new Promise(r => setTimeout(r, 3000));

// Test 3: Call tool with progress token
console.log('\n═══════════════════════════════════════════════════════');
console.log('TEST 3: Call get_second_opinion with MCP progress');
console.log('═══════════════════════════════════════════════════════\n');

server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'get_second_opinion',
    arguments: {
      question: 'In one sentence, what is the key advantage of WebSocket over HTTP?'
    },
    _meta: {
      progressToken: 'mcp-test-123'
    }
  }
}) + '\n');

await new Promise(r => setTimeout(r, 30000));

// Test 4: Call tool with specific model
console.log('\n═══════════════════════════════════════════════════════');
console.log('TEST 4: Call tool with specific model override');
console.log('═══════════════════════════════════════════════════════\n');

server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'get_second_opinion',
    arguments: {
      question: 'Say "test passed" in exactly two words.',
      model: 'nvidia/nemotron-3-nano'
    },
    _meta: {
      progressToken: 'mcp-test-456'
    }
  }
}) + '\n');

await new Promise(r => setTimeout(r, 60000));

console.log('\n═══════════════════════════════════════════════════════');
console.log('MCP TEST SUMMARY');
console.log('═══════════════════════════════════════════════════════\n');
console.log(`✅ Tests passed: ${testsPassed}`);
console.log(`❌ Tests failed: ${testsFailed}`);

server.kill();
process.exit(testsFailed > 0 ? 1 : 0);
