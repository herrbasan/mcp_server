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
      
      if (msg.result?.content) {
        console.log('\n' + msg.result.content[0].text);
        server.kill();
        process.exit(0);
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

console.log('📋 Listing available models...\n');

server.stdin.write(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'list_available_models',
    arguments: {}
  }
}) + '\n');

setTimeout(() => {
  console.error('\n⏱️ Timeout - no response');
  server.kill();
  process.exit(1);
}, 15000);
