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
        console.log('\n✅ Research Complete!\n');
        console.log('Preview (first 800 chars):');
        console.log(msg.result.content[0].text.substring(0, 800) + '...\n');
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
  // Show debug logs and key phases
  if (text.includes('[DEBUG]') || 
      text.includes('LLM selected') || 
      text.includes('LLM selection failed') ||
      text.includes('Successfully scraped') ||
      text.includes('[Bing]')) {
    console.log(text.trim());
  }
});

await new Promise(r => setTimeout(r, 1000));

console.log('🧪 Testing LLM Source Selection Fixes\n');
console.log('Query: "React Hooks best practices"\n');
console.log('Looking for:');
console.log('  - LLM selecting sources (not falling back)');
console.log('  - Bing URL decoding working');
console.log('  - Multiple sources successfully scraped\n');

const testRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'research_topic',
    arguments: {
      query: 'React Hooks best practices',
      max_pages: 3,
      engines: ['bing']
    },
    _meta: {
      progressToken: 'source-selection-test'
    }
  }
};

server.stdin.write(JSON.stringify(testRequest) + '\n');

setTimeout(() => {
  console.log('\n⏱️ Test timeout (3 minutes)');
  server.kill();
  process.exit(1);
}, 180000);
