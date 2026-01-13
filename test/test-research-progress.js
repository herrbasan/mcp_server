import { spawn } from 'child_process';

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
        const update = `[${msg.params.progress}/${msg.params.total}] ${msg.params.message}`;
        progressUpdates.push(update);
        console.log(`📊 ${update}`);
      } else if (msg.result) {
        console.log('\n✅ Research Complete!\n');
        console.log('📊 Progress Timeline:');
        progressUpdates.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
        console.log(`\n📄 Result Preview (first 500 chars):`);
        console.log(msg.result.content[0].text.substring(0, 500) + '...\n');
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

server.stderr.on('data', (data) => {
  const text = data.toString();
  // Only show key phases in stderr
  if (text.includes('ITERATION') || text.includes('Phase') || text.includes('Research complete')) {
    console.error(text.trim());
  }
});

await new Promise(r => setTimeout(r, 1000));

console.log('🧪 Testing Web Research Progress Notifications\n');
console.log('Query: "TypeScript async patterns"\n');

const testRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'research_topic',
    arguments: {
      query: 'TypeScript async patterns',
      max_pages: 2,
      engines: ['bing']
    },
    _meta: {
      progressToken: 'research-progress-test'
    }
  }
};

server.stdin.write(JSON.stringify(testRequest) + '\n');

setTimeout(() => {
  console.log('\n⏱️ Test timeout (2 minutes)');
  console.log(`\n📊 Progress updates received: ${progressUpdates.length}`);
  progressUpdates.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  server.kill();
  process.exit(1);
}, 120000);
