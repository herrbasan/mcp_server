import { spawn } from 'child_process';

const server = spawn('node', ['src/index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';

server.stdout.on('data', (data) => {
  buffer += data.toString();
  let lines = buffer.split('\n');
  buffer = lines.pop();
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'notifications/progress') {
        console.log(`📊 Progress: ${msg.params.progress}/${msg.params.total} - ${msg.params.message}`);
      } else if (msg.result) {
        console.log('\n✅ Result:', JSON.stringify(msg.result, null, 2));
      }
    } catch (e) {
      console.log('STDOUT:', line);
    }
  }
});

server.stderr.on('data', (data) => {
  console.error('STDERR:', data.toString().trim());
});

await new Promise(r => setTimeout(r, 1000));

console.log('\n🧪 Testing LM Studio with progress reporting...\n');

const testRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'get_second_opinion',
    arguments: {
      question: 'Should I use async/await or promises for this Node.js API?',
      context: 'Building a REST API with Express that needs to query a database'
    },
    _meta: {
      progressToken: 'test-progress-123'
    }
  }
};

server.stdin.write(JSON.stringify(testRequest) + '\n');

await new Promise(r => setTimeout(r, 30000));
server.kill();
console.log('\n✅ Test complete');
