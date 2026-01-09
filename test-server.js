import { spawn } from 'child_process';

const server = spawn('node', ['src/index.js'], { cwd: process.cwd() });

let output = '';

server.stdout.on('data', (data) => {
  output += data.toString();
  console.log('STDOUT:', data.toString());
});

server.stderr.on('data', (data) => {
  console.log('STDERR:', data.toString());
});

// Wait for server to initialize
setTimeout(() => {
  console.log('\n📝 Sending tools/list request...\n');
  
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {}
  };
  
  server.stdin.write(JSON.stringify(request) + '\n');
}, 500);

// Collect response
setTimeout(() => {
  console.log('\n✅ Server Response:\n', output);
  
  try {
    const response = JSON.parse(output);
    console.log('\n📊 Tools available:', response.result?.tools?.length || 0);
    response.result?.tools?.forEach((tool, i) => {
      console.log(`  ${i + 1}. ${tool.name} - ${tool.description}`);
    });
  } catch (e) {
    console.log('Response parsing:', e.message);
  }
  
  server.kill();
  process.exit(0);
}, 1500);
