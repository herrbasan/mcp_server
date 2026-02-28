/**
 * Integration Test for Search Analysis Feature
 * 
 * Tests the `analyze` parameter on search tools using actual MCP HTTP endpoints.
 * This uses the MCP SDK client to properly communicate with the server.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_ENDPOINT = 'http://192.168.0.100:3100/mcp';

let testResults = {
  passed: 0,
  failed: 0,
  errors: []
};

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

async function testCase(name, testFn) {
  try {
    console.log(`\n🧪 Testing: ${name}`);
    await testFn();
    console.log(`✅ PASSED`);
    testResults.passed++;
    return true;
  } catch (error) {
    console.error(`❌ FAILED: ${error.message}`);
    if (error.stack) console.error(error.stack.split('\n').slice(0, 3).join('\n'));
    testResults.failed++;
    testResults.errors.push({ test: name, error: error.message });
    return false;
  }
}

async function runTests() {
  console.log('=====================================');
  console.log('Search Analysis Integration Test');
  console.log('=====================================');
  console.log(`Endpoint: ${MCP_ENDPOINT}\n`);

  // Create MCP client
  console.log('🔌 Connecting to MCP server...');
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_ENDPOINT));
  
  try {
    await client.connect(transport);
    console.log('✅ Connected\n');
  } catch (err) {
    console.error('❌ Failed to connect:', err.message);
    process.exit(1);
  }

  // Test 1: List available tools to verify connection
  await testCase('List available tools', async () => {
    const tools = await client.listTools();
    assert(tools.tools.length > 0, 'Should have tools');
    
    const searchTools = tools.tools.filter(t => 
      ['search_codebase', 'search_semantic', 'search_keyword', 'grep_codebase', 'search_all_codebases'].includes(t.name)
    );
    console.log(`   📋 Found ${searchTools.length} search tools`);
    
    // Check that analyze parameter is documented
    const searchAllTool = tools.tools.find(t => t.name === 'search_all_codebases');
    assert(searchAllTool, 'search_all_codebases should exist');
    assert(searchAllTool.inputSchema.properties.analyze, 'analyze parameter should be documented');
    console.log(`   ✅ analyze parameter documented in ${searchAllTool.name}`);
  });

  // Test 2: search_all_codebases with analyze=true
  await testCase('search_all_codebases with analyze=true', async () => {
    const result = await client.callTool({
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop file handling',
        strategy: 'semantic',
        limit: 10,
        analyze: true
      }
    });

    assert(result.content?.[0]?.text, 'Should have content');
    
    const parsed = JSON.parse(result.content[0].text);
    
    // Should have analysis section
    assert(parsed.analysis, 'Should have analysis section');
    assert(typeof parsed.analysis.summary === 'string', 'Should have summary');
    assert(Array.isArray(parsed.analysis.keyFindings), 'Should have keyFindings array');
    assert(Array.isArray(parsed.analysis.relevantFiles), 'Should have relevantFiles array');
    assert(Array.isArray(parsed.analysis.implementationPatterns), 'Should have implementationPatterns array');
    
    // Should have stats
    assert(parsed.stats, 'Should have stats section');
    assert(typeof parsed.stats.resultCount === 'number', 'Should have resultCount');
    
    // Should NOT have rawResults by default
    assert(!parsed.rawResults, 'Should not have rawResults when includeRaw is false');
    
    console.log(`   📊 Results: ${parsed.stats.resultCount}`);
    console.log(`   📝 Summary: ${parsed.analysis.summary.substring(0, 70)}...`);
    console.log(`   🔑 Key findings: ${parsed.analysis.keyFindings.length}`);
    console.log(`   📁 Relevant files: ${parsed.analysis.relevantFiles.length}`);
    
    // Print actual findings
    if (parsed.analysis.keyFindings.length > 0) {
      console.log('   📌 Top findings:');
      parsed.analysis.keyFindings.slice(0, 3).forEach((f, i) => {
        console.log(`      ${i + 1}. ${f.substring(0, 60)}${f.length > 60 ? '...' : ''}`);
      });
    }
  });

  // Test 3: search_all_codebases with includeRaw=true
  await testCase('search_all_codebases with includeRaw=true', async () => {
    const result = await client.callTool({
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop file handling',
        strategy: 'semantic',
        limit: 5,
        analyze: true,
        includeRaw: true
      }
    });

    const parsed = JSON.parse(result.content[0].text);
    
    assert(parsed.analysis, 'Should have analysis section');
    assert(parsed.rawResults, 'Should have rawResults when includeRaw=true');
    assert(Array.isArray(parsed.rawResults), 'rawResults should be an array');
    
    console.log(`   📄 Raw results included: ${parsed.rawResults.length} items`);
    console.log(`   📊 Analyzed results: ${parsed.stats.resultCount}`);
  });

  // Test 4: Compare token savings (rough estimate)
  await testCase('Compare raw vs analyzed token usage', async () => {
    // Get raw results
    const rawResult = await client.callTool({
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop file handling',
        strategy: 'semantic',
        limit: 15
      }
    });
    const rawParsed = JSON.parse(rawResult.content[0].text);
    const rawSize = JSON.stringify(rawParsed).length;
    
    // Get analyzed results
    const analyzedResult = await client.callTool({
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop file handling',
        strategy: 'semantic',
        limit: 15,
        analyze: true
      }
    });
    const analyzedParsed = JSON.parse(analyzedResult.content[0].text);
    const analyzedSize = JSON.stringify(analyzedParsed).length;
    
    const savings = ((rawSize - analyzedSize) / rawSize * 100).toFixed(1);
    
    console.log(`   📊 Raw size: ${rawSize.toLocaleString()} chars`);
    console.log(`   📊 Analyzed size: ${analyzedSize.toLocaleString()} chars`);
    console.log(`   💰 Token savings: ${savings}%`);
    
    assert(analyzedSize < rawSize, 'Analyzed should be smaller than raw');
    
    if (parseFloat(savings) > 50) {
      console.log('   ✅ Significant token savings achieved!');
    }
  });

  // Test 5: search_codebase (single codebase) with analyze
  await testCase('search_codebase with analyze=true', async () => {
    // First list codebases
    const listResult = await client.callTool({
      name: 'list_codebases',
      arguments: {}
    });
    const codebases = JSON.parse(listResult.content[0].text);
    
    if (codebases.length === 0) {
      console.log('   ⚠️ No codebases available');
      return;
    }
    
    const testCodebase = codebases[0].name;
    console.log(`   📁 Using codebase: ${testCodebase}`);
    
    const result = await client.callTool({
      name: 'search_codebase',
      arguments: {
        codebase: testCodebase,
        query: 'function handler',
        limit: 5,
        analyze: true
      }
    });

    const parsed = JSON.parse(result.content[0].text);
    
    if (parsed.stats?.resultCount > 0) {
      assert(parsed.analysis, 'Should have analysis when results found');
      console.log(`   📊 Analyzed ${parsed.stats.resultCount} results`);
      console.log(`   📝 Summary: ${parsed.analysis.summary.substring(0, 60)}...`);
    } else {
      console.log('   ℹ️ No results found in this codebase');
    }
  });

  // Test 6: grep_codebase with analyze
  await testCase('grep_codebase with analyze=true', async () => {
    const listResult = await client.callTool({
      name: 'list_codebases',
      arguments: {}
    });
    const codebases = JSON.parse(listResult.content[0].text);
    
    if (codebases.length === 0) {
      console.log('   ⚠️ No codebases available');
      return;
    }
    
    const result = await client.callTool({
      name: 'grep_codebase',
      arguments: {
        codebase: codebases[0].name,
        pattern: 'function.*\(.*\)',
        limit: 10,
        analyze: true
      }
    });

    const parsed = JSON.parse(result.content[0].text);
    
    if (parsed.stats?.resultCount > 0) {
      assert(parsed.analysis, 'Should have analysis when results found');
      console.log(`   📊 Analyzed ${parsed.stats.resultCount} grep results`);
      console.log(`   🔑 Key findings: ${parsed.analysis.keyFindings.length}`);
    } else {
      console.log('   ℹ️ No results found');
    }
  });

  // Test 7: Real-world use case - Find drag-and-drop implementations
  await testCase('Real-world: Find drag-and-drop implementations', async () => {
    console.log('   🔍 Searching for "drag and drop file upload"...');
    
    const result = await client.callTool({
      name: 'search_all_codebases',
      arguments: {
        query: 'drag and drop file upload electron',
        strategy: 'semantic',
        limit: 10,
        analyze: true
      }
    });

    const parsed = JSON.parse(result.content[0].text);
    
    console.log(`\n   📊 Found ${parsed.stats.resultCount} results across codebases`);
    console.log(`\n   📝 ANALYSIS:`);
    console.log(`   ${parsed.analysis.summary}`);
    
    if (parsed.analysis.keyFindings.length > 0) {
      console.log(`\n   🔑 KEY FINDINGS:`);
      parsed.analysis.keyFindings.forEach((finding, i) => {
        console.log(`   ${i + 1}. ${finding}`);
      });
    }
    
    if (parsed.analysis.relevantFiles.length > 0) {
      console.log(`\n   📁 RELEVANT FILES:`);
      parsed.analysis.relevantFiles.forEach((file, i) => {
        console.log(`   ${i + 1}. ${file}`);
      });
    }
    
    if (parsed.analysis.implementationPatterns.length > 0) {
      console.log(`\n   📋 IMPLEMENTATION PATTERNS:`);
      parsed.analysis.implementationPatterns.forEach((pattern, i) => {
        console.log(`   ${i + 1}. ${pattern}`);
      });
    }
    
    assert(parsed.analysis.summary.length > 20, 'Should have meaningful summary');
  });

  // Cleanup
  console.log('\n🔌 Disconnecting...');
  await client.close();

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
