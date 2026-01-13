import { spawn } from 'child_process';

const server = spawn('node', ['src/stdio-server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
let progressCount = 0;

server.stdout.on('data', (data) => {
  buffer += data.toString();
  let lines = buffer.split('\n');
  buffer = lines.pop();
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'notifications/progress') {
        progressCount++;
        console.log(`📊 ${msg.params.message}`);
      } else if (msg.result) {
        console.log('\n✅ Response:\n');
        console.log(msg.result.content[0].text);
        server.kill();
        process.exit(0);
      } else if (msg.error) {
        console.error('\n❌ Error:', msg.error);
        server.kill();
        process.exit(1);
      }
    } catch (e) {}
  }
});

server.stderr.on('data', (data) => console.error(data.toString().trim()));

await new Promise(r => setTimeout(r, 1000));

console.log('🧪 Testing model selection with specific model override...\n');

const testRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'get_second_opinion',
    arguments: {
      question: 'Should I use TypeScript or JavaScript for this project?',
      model: 'mistralai/devstral-small-2-2512'  // Override with specific model
    },
    _meta: {
      progressToken: 'model-test'
    }
  }
};

server.stdin.write(JSON.stringify(testRequest) + '\n');

setTimeout(() => {
  console.log('\n⏱️ Timeout');
  server.kill();
  process.exit(1);
}, 30000);
