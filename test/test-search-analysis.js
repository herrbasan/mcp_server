/**
 * Test Search Analysis Feature
 * 
 * Tests the `analyze` parameter on search tools that uses local LLM
 * to pre-analyze results and reduce token costs.
 */

// Native fetch (Node 18+) - no import needed
const MCP_ENDPOINT = 'http://192.168.0.100:3100/mcp';
const SESSION_ID = null; // Let server create session automatically

let testResults = {
  passed: 0,
  failed: 0,
  errors: []
};

// Helper to make MCP requests
async function mcpRequest(method, params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': '*/*'
  };
  if (SESSION_ID) {
    headers['mcp-session-id'] = SESSION_ID;
  }
  
  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return await response.json();
}

// Test helper
async function testCase(name, testFn) {
  try {
    console.log(`\n🧪 Testing: ${name}`);
    await testFn();
    console.log(`✅ PASSED`);
    testResults.passed++;
    return true;
  } catch (error) {
    console.error(`❌ FAILED: ${error.message}`);
    testResults.failed++;
    testResults.errors.push({ test: name, error: error.message });
    return false;
  }
}

// Assertion helpers
function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertHas(obj, key, message) {
  if (!(key in obj)) throw new Error(message || `Missing key: ${key}`);
}

async function runTests() {
  console.log('=====================================');
  console.log('Search Analysis Feature Test Suite');
  console.log('=====================================');
  console.log(`Session ID: ${SESSION_ID || '(auto-created)'}`);
  console.log(`Endpoint: ${MCP_ENDPOINT}\n`);

  // Test 1: search_all_codebases with analyze=true
  await testCase('search_all_codebases with analyze=true', async () => {
    const response = await mcpRequest('tools/call', {
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop',
        strategy: 'semantic',
        limit: 10,
        analyze: true
      }
    });
    
    console.log('   Response keys:', Object.keys(response).join(', '));

    assert(!response.error, `Tool error: ${response.error?.message}`);
    
    console.log('   Result keys:', Object.keys(response.result || {}).join(', '));
    
    const content = response.result?.content?.[0]?.text;
    assert(content, 'No content in response');
    
    const result = JSON.parse(content);
    
    // Should have analysis section
    assertHas(result, 'analysis', 'Missing analysis section');
    assertHas(result.analysis, 'summary', 'Missing analysis.summary');
    assertHas(result.analysis, 'keyFindings', 'Missing analysis.keyFindings');
    assertHas(result.analysis, 'relevantFiles', 'Missing analysis.relevantFiles');
    assertHas(result.analysis, 'implementationPatterns', 'Missing analysis.implementationPatterns');
    assertHas(result.analysis, 'raw', 'Missing analysis.raw');
    
    // Should have stats section
    assertHas(result, 'stats', 'Missing stats section');
    assertHas(result.stats, 'resultCount', 'Missing stats.resultCount');
    assertHas(result.stats, 'searchType', 'Missing stats.searchType');
    assert(result.stats.searchType === 'search_all_codebases', 'Wrong searchType');
    
    // Should NOT have rawResults by default
    assert(!('rawResults' in result), 'rawResults should not be present when includeRaw is false');
    
    console.log(`   📊 Found ${result.stats.resultCount} results`);
    console.log(`   📝 Summary: ${result.analysis.summary.substring(0, 80)}...`);
    console.log(`   🔑 Key findings: ${result.analysis.keyFindings.length}`);
  });

  // Test 2: search_all_codebases with includeRaw=true
  await testCase('search_all_codebases with includeRaw=true', async () => {
    const response = await mcpRequest('tools/call', {
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop',
        strategy: 'semantic',
        limit: 5,
        analyze: true,
        includeRaw: true
      }
    });

    assert(!response.error, `Tool error: ${response.error?.message}`);
    
    const result = JSON.parse(response.result.content[0].text);
    
    // Should have analysis
    assertHas(result, 'analysis', 'Missing analysis section');
    
    // SHOULD have rawResults when includeRaw=true
    assertHas(result, 'rawResults', 'Missing rawResults when includeRaw=true');
    assert(Array.isArray(result.rawResults), 'rawResults should be an array');
    
    console.log(`   📄 Raw results included: ${result.rawResults.length} items`);
  });

  // Test 3: search_codebase with analyze=true (single codebase)
  await testCase('search_codebase with analyze=true', async () => {
    // First list codebases to find one to test with
    const listResponse = await mcpRequest('tools/call', {
      name: 'list_codebases',
      arguments: {}
    });
    
    const listResult = JSON.parse(listResponse.result.content[0].text);
    assert(listResult.length > 0, 'No codebases available for testing');
    
    const testCodebase = listResult[0].name;
    console.log(`   📁 Using codebase: ${testCodebase}`);
    
    const response = await mcpRequest('tools/call', {
      name: 'search_codebase',
      arguments: {
        codebase: testCodebase,
        query: 'function',
        limit: 5,
        analyze: true
      }
    });

    assert(!response.error, `Tool error: ${response.error?.message}`);
    
    const result = JSON.parse(response.result.content[0].text);
    assertHas(result, 'analysis', 'Missing analysis section');
    assertHas(result, 'stats', 'Missing stats section');
    assert(result.stats.searchType === 'search_codebase', 'Wrong searchType');
    
    console.log(`   📊 Results: ${result.stats.resultCount}`);
    console.log(`   📝 Summary: ${result.analysis.summary.substring(0, 60)}...`);
  });

  // Test 4: grep_codebase with analyze=true
  await testCase('grep_codebase with analyze=true', async () => {
    const listResponse = await mcpRequest('tools/call', {
      name: 'list_codebases',
      arguments: {}
    });
    
    const listResult = JSON.parse(listResponse.result.content[0].text);
    const testCodebase = listResult[0]?.name;
    
    if (!testCodebase) {
      console.log('   ⚠️ Skipping - no codebases available');
      return;
    }
    
    const response = await mcpRequest('tools/call', {
      name: 'grep_codebase',
      arguments: {
        codebase: testCodebase,
        pattern: 'function|class|const',
        limit: 10,
        analyze: true
      }
    });

    assert(!response.error, `Tool error: ${response.error?.message}`);
    
    const result = JSON.parse(response.result.content[0].text);
    
    // grep returns results differently, check for analysis
    if (result.stats && result.stats.resultCount > 0) {
      assertHas(result, 'analysis', 'Missing analysis when results found');
      console.log(`   📊 Analyzed ${result.stats.resultCount} grep results`);
    } else {
      console.log('   ℹ️ No results found (codebase may be empty)');
    }
  });

  // Test 5: search without analyze (baseline - should return raw results)
  await testCase('search without analyze (raw results)', async () => {
    const response = await mcpRequest('tools/call', {
      name: 'search_all_codebases',
      arguments: {
        query: 'function',
        strategy: 'semantic',
        limit: 5
        // NO analyze parameter
      }
    });

    assert(!response.error, `Tool error: ${response.error?.message}`);
    
    const result = JSON.parse(response.result.content[0].text);
    
    // Should have raw results directly
    assertHas(result, 'results', 'Missing results array');
    assert(Array.isArray(result.results), 'results should be an array');
    
    // Should NOT have analysis section
    assert(!('analysis' in result), 'analysis should not be present when analyze=false');
    
    console.log(`   📄 Raw results: ${result.results.length} items`);
  });

  // Test 6: Verify token savings (rough estimate)
  await testCase('verify token savings estimation', async () => {
    // Get raw results
    const rawResponse = await mcpRequest('tools/call', {
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop implementation',
        strategy: 'semantic',
        limit: 15
      }
    });
    
    const rawResult = JSON.parse(rawResponse.result.content[0].text);
    const rawSize = JSON.stringify(rawResult).length;
    
    // Get analyzed results
    const analyzedResponse = await mcpRequest('tools/call', {
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop implementation',
        strategy: 'semantic',
        limit: 15,
        analyze: true
      }
    });
    
    const analyzedResult = JSON.parse(analyzedResponse.result.content[0].text);
    const analyzedSize = JSON.stringify(analyzedResult).length;
    
    const savings = ((rawSize - analyzedSize) / rawSize * 100).toFixed(1);
    
    console.log(`   📊 Raw size: ${rawSize} chars`);
    console.log(`   📊 Analyzed size: ${analyzedSize} chars`);
    console.log(`   💰 Estimated savings: ${savings}%`);
    
    // Analyzed should be significantly smaller
    assert(analyzedSize < rawSize * 0.5, 'Expected at least 50% size reduction');
  });

  // Summary
  console.log('\n=====================================');
  console.log('Test Summary');
  console.log('=====================================');
  console.log(`✅ Passed: ${testResults.passed}`);
  console.log(`❌ Failed: ${testResults.failed}`);
  
  if (testResults.errors.length > 0) {
    console.log('\n📋 Errors:');
    testResults.errors.forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.test}: ${e.error}`);
    });
  }
  
  process.exit(testResults.failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
