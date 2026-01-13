import { spawn } from 'child_process';

const server = spawn('node', ['src/stdio-server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';

server.stdout.on('data', (data) => {
  buffer += data.toString();
  let lines = buffer.split('\n');
  buffer = lines.pop();
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.result) {
        console.log(JSON.stringify(msg.result, null, 2));
        testQuestion();
      }
    } catch (e) {}
  }
});

server.stderr.on('data', (data) => console.error(data.toString().trim()));

await new Promise(r => setTimeout(r, 1000));

console.log('🧪 Testing LM Studio models resource\n');

// Test 1: List resources
server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'resources/list'
}) + '\n');

async function testQuestion() {
  await new Promise(r => setTimeout(r, 500));
  
  console.log('\n🧪 Reading models resource\n');
  
  // Test 2: Read models resource
  server.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'resources/read',
    params: {
      uri: 'lmstudio://models'
    }
  }) + '\n');
  
  await new Promise(r => setTimeout(r, 2000));
  server.kill();
}

setTimeout(() => {
  console.log('\n⏱️ Timeout');
  server.kill();
  process.exit(1);
}, 10000);
