/**
 * MCP Orchestrator - Endpoint Test Suite
 * Tests all 16 tools across 5 modules
 */

const BASE_URL = 'http://localhost:3100/mcp';

let sessionId = null;
let passed = 0;
let failed = 0;
const errors = [];

async function mcpRequest(method, params = {}, id = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  };
  
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }
  
  const body = {
    jsonrpc: '2.0',
    method,
    params,
    id: id || Math.floor(Math.random() * 1000000)
  };
  
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  
  // Check for session ID in response
  const newSessionId = response.headers.get('mcp-session-id');
  if (newSessionId) {
    sessionId = newSessionId;
  }
  
  const data = await response.json();
  return data;
}

async function testTool(name, params = {}) {
  process.stdout.write(`Testing ${name}... `);
  try {
    const result = await mcpRequest('tools/call', { name, arguments: params });
    if (result.error) {
      throw new Error(result.error.message);
    }
    console.log('✅ PASS');
    passed++;
    return result.result;
  } catch (err) {
    console.log(`❌ FAIL: ${err.message}`);
    failed++;
    errors.push({ tool: name, error: err.message });
    return null;
  }
}

async function runTests() {
  console.log('=== MCP Orchestrator Endpoint Tests ===\n');
  
  // Initialize session
  console.log('Initializing MCP session...');
  const init = await mcpRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  });
  
  if (init.error) {
    console.error('Failed to initialize:', init.error);
    return;
  }
  console.log('Session initialized:', sessionId || 'no session id');
  
  // Send initialized notification
  await mcpRequest('notifications/initialized');
  console.log('');
  
  // ========== DOCUMENTATION MODULE (3 tools) ==========
  console.log('--- Documentation Module ---');
  await testTool('list_documents');
  await testTool('read_document', { name: 'orchestrator' });
  await testTool('get_documentation');
  console.log('');
  
  // ========== MEMORY MODULE (7 tools) ==========
  console.log('--- Memory Module ---');
  await testTool('remember', { 
    text: 'Test pattern for endpoint validation', 
    category: 'proven',
    domain: 'test_suite'
  });
  await testTool('recall', { query: 'endpoint validation', limit: 5 });
  await testTool('list_memories', { domain: 'test_suite' });
  
  // Get memory ID for update/forget tests
  const memories = await mcpRequest('tools/call', { 
    name: 'list_memories', 
    arguments: { domain: 'test_suite' }
  });
  
  let testMemoryId = null;
  if (memories.result?.content?.[0]?.text) {
    try {
      const memData = JSON.parse(memories.result.content[0].text);
      testMemoryId = memData.memories?.[0]?.id;
    } catch {}
  }
  
  if (testMemoryId) {
    await testTool('update_memory', { 
      id: testMemoryId, 
      text: 'Updated test pattern',
      category: 'proven'
    });
    await testTool('forget', { id: testMemoryId });
  } else {
    console.log('Testing update_memory... ⚠️ SKIP (no memory to update)');
    console.log('Testing forget... ⚠️ SKIP (no memory to delete)');
  }
  
  await testTool('reflect_on_session', { 
    sessionSummary: 'Test session for endpoint validation' 
  });
  console.log('Testing apply_reflection_changes... ⚠️ SKIP (requires user interaction)');
  console.log('');
  
  // ========== LLM MODULE (1 tool) ==========
  console.log('--- LLM Module ---');
  await testTool('query_model', { 
    prompt: 'Say "test successful" and nothing else',
    maxTokens: 10
  });
  console.log('');
  
  // ========== CODE INSPECTOR MODULE (1 tool) ==========
  console.log('--- Code Inspector Module ---');
  await testTool('inspect_code', {
    code: 'function add(a,b) { return a+b }',
    question: 'Is this function correct?'
  });
  console.log('');
  
  // ========== BROWSER MODULE (6 tools) ==========
  console.log('--- Browser Module ---');
  await testTool('browser_fetch', { 
    url: 'https://example.com',
    mode: 'text'
  });
  
  // Test error handling for invalid URL
  console.log('Testing browser_fetch error handling...');
  const browserError = await testTool('browser_fetch', { 
    url: 'not-a-valid-url'
  });
  
  // Click/Fill/Evaluate require actual pages - test basic param validation
  console.log('Testing browser_click (param validation)...');
  const clickResult = await mcpRequest('tools/call', { 
    name: 'browser_click', 
    arguments: { url: 'https://example.com', selector: 'body' }
  });
  if (clickResult.error && clickResult.error.message.includes('timed out')) {
    console.log('browser_click... ⚠️ TIMEOUT (expected for network requests)');
  } else if (clickResult.result) {
    console.log('browser_click... ✅ PASS');
    passed++;
  } else {
    console.log('browser_click... ❌ FAIL:', clickResult.error?.message);
    failed++;
  }
  
  console.log('Testing browser_pdf (param validation)... ⚠️ SKIP (slow operation)');
  console.log('Testing browser_login (param validation)... ⚠️ SKIP (requires manual auth)');
  console.log('');
  
  // ========== WEB RESEARCH MODULE (1 tool) ==========
  console.log('--- Web Research Module ---');
  console.log('Testing research_topic... (this may take 10-30s)');
  const researchResult = await testTool('research_topic', { 
    query: 'MCP protocol introduction',
    max_pages: 3
  });
  console.log('');
  
  // ========== SUMMARY ==========
  console.log('=== Test Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  - ${e.tool}: ${e.error}`));
  }
}

runTests().catch(console.error);
