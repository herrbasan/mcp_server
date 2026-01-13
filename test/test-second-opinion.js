import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const server = spawn('node', ['src/stdio-server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';
let progressUpdates = [];

server.stdout.on('data', (data) => {
  buffer += data.toString();
  let lines = buffer.split('\n');
  buffer = lines.pop();
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'notifications/progress') {
        const update = `${msg.params.progress}/${msg.params.total} - ${msg.params.message}`;
        progressUpdates.push(update);
        console.log(`📊 ${update}`);
      } else if (msg.result) {
        console.log('\n✅ Second Opinion:\n');
        console.log(msg.result.content[0].text);
        console.log('\n📊 Progress Updates Received:', progressUpdates.length);
        server.kill();
        process.exit(0);
      } else if (msg.error) {
        console.error('\n❌ Error:', msg.error);
        server.kill();
        process.exit(1);
      }
    } catch (e) {
      // Ignore non-JSON lines
    }
  }
});

server.stderr.on('data', (data) => {
  console.error(data.toString().trim());
});

await new Promise(r => setTimeout(r, 1000));

console.log('🧪 Testing LM Studio SDK with progress reporting\n');
console.log('📝 Getting a quick second opinion...\n');

const testRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'get_second_opinion',
    arguments: {
      question: 'In 2-3 sentences, suggest one concrete improvement to a Node.js server that streams model output and reports progress.',
      maxTokens: 96
    },
    _meta: {
      progressToken: 'test-progress-123'
    }
  }
};

server.stdin.write(JSON.stringify(testRequest) + '\n');

setTimeout(() => {
  console.log('\n⏱️ Timeout - killing server');
  server.kill();
  process.exit(1);
}, 60000);
