import fetch from 'node-fetch';

const MCP_ENDPOINT = 'http://192.168.0.100:3100/mcp';
const SESSION_ID = 'test-session-' + Date.now();

let testResults = {
  passed: 0,
  failed: 0,
  errors: []
};

// Helper to make MCP requests
async function mcpRequest(method, params = {}) {
  const response = await fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'mcp-session-id': SESSION_ID
    },
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
async function testTool(name, method, params, validator) {
  try {
    console.log(`\n🧪 Testing: ${name}`);
    const result = await mcpRequest(method, params);
    
    if (result.error) {
      console.error(`❌ FAILED: ${result.error.message}`);
      testResults.failed++;
      testResults.errors.push({ tool: name, error: result.error.message });
      return false;
    }

    if (validator && !validator(result.result)) {
      console.error(`❌ FAILED: Validation failed`);
      testResults.failed++;
      testResults.errors.push({ tool: name, error: 'Validation failed' });
      return false;
    }

    console.log(`✅ PASSED`);
    testResults.passed++;
    return true;
  } catch (error) {
    console.error(`❌ FAILED: ${error.message}`);
    testResults.failed++;
    testResults.errors.push({ tool: name, error: error.message });
    return false;
  }
}

async function runTests() {
  console.log('=====================================');
  console.log('MCP Orchestrator Endpoint Test Suite');
  console.log('=====================================');
  console.log(`Session ID: ${SESSION_ID}`);
  console.log(`Endpoint: ${MCP_ENDPOINT}\n`);

  // Test 1: List available tools
  console.log('\n📋 Phase 1: Discovery');
  await testTool(
    'tools/list',
    'tools/list',
    {},
    (result) => Array.isArray(result.tools) && result.tools.length > 0
  );

  // ============================================
  // MEMORY MODULE (7 tools)
  // ============================================
  console.log('\n\n💾 Phase 2: Memory Module (7 tools)');
  
  let memoryId = null;

  await testTool(
    'remember (create memory)',
    'tools/call',
    {
      name: 'remember',
      arguments: {
        text: 'Test memory for endpoint validation',
        category: 'context'
      }
    },
    (result) => {
      if (result.content?.[0]?.text) {
        const match = result.content[0].text.match(/ID (\d+)/);
        if (match) {
          memoryId = parseInt(match[1]);
          return true;
        }
      }
      return false;
    }
  );

  await testTool(
    'list_memories',
    'tools/call',
    {
      name: 'list_memories',
      arguments: {}
    },
    (result) => Array.isArray(result.content?.[0]?.text && JSON.parse(result.content[0].text))
  );

  await testTool(
    'recall (search memories)',
    'tools/call',
    {
      name: 'recall',
      arguments: {
        query: 'test memory',
        limit: 5
      }
    },
    (result) => result.content?.[0]?.text?.includes('Results:')
  );

  if (memoryId) {
    await testTool(
      'update_memory',
      'tools/call',
      {
        name: 'update_memory',
        arguments: {
          id: memoryId,
          text: 'Updated test memory for endpoint validation'
        }
      },
      (result) => result.content?.[0]?.text?.includes('updated')
    );

    await testTool(
      'forget (delete memory)',
      'tools/call',
      {
        name: 'forget',
        arguments: {
          id: memoryId
        }
      },
      (result) => result.content?.[0]?.text?.includes('deleted')
    );
  }

  // Note: reflect_on_session and apply_reflection_changes are higher-level tools
  // that require specific workflows - skipping for basic endpoint test

  // ============================================
  // CODE SEARCH MODULE (9 tools)
  // ============================================
  console.log('\n\n🔍 Phase 3: Code Search Module (9 tools)');

  let workspaceName = null;
  let testFileId = null;

  await testTool(
    'get_workspace_config',
    'tools/call',
    {
      name: 'get_workspace_config',
      arguments: {}
    },
    (result) => {
      const text = result.content?.[0]?.text;
      if (text) {
        const match = text.match(/- (\w+-\w+):/);
        if (match) {
          workspaceName = match[1];
          return true;
        }
      }
      return false;
    }
  );

  if (workspaceName) {
    await testTool(
      'get_index_stats',
      'tools/call',
      {
        name: 'get_index_stats',
        arguments: { workspace: workspaceName }
      },
      (result) => result.content?.[0]?.text?.includes('files')
    );

    await testTool(
      'search_files (glob)',
      'tools/call',
      {
        name: 'search_files',
        arguments: {
          workspace: workspaceName,
          glob: '*.md'
        }
      },
      (result) => {
        const text = result.content?.[0]?.text;
        return text && text.includes('Found');
      }
    );

    await testTool(
      'search_keyword',
      'tools/call',
      {
        name: 'search_keyword',
        arguments: {
          workspace: workspaceName,
          pattern: 'function',
          limit: 3
        }
      },
      (result) => result.content?.[0]?.text?.includes('matches')
    );

    await testTool(
      'search_semantic',
      'tools/call',
      {
        name: 'search_semantic',
        arguments: {
          workspace: workspaceName,
          query: 'server configuration',
          limit: 3
        }
      },
      (result) => {
        const text = result.content?.[0]?.text;
        if (text && text.includes('similarity')) {
          // Try to extract a file ID for later tests
          const match = text.match(/File: ([a-f0-9]{32})/);
          if (match) {
            testFileId = match[1];
          }
          return true;
        }
        return false;
      }
    );

    await testTool(
      'search_code (combined)',
      'tools/call',
      {
        name: 'search_code',
        arguments: {
          workspace: workspaceName,
          query: 'export function',
          limit: 3
        }
      },
      (result) => result.content?.[0]?.text
    );

    if (testFileId) {
      await testTool(
        'get_file_info',
        'tools/call',
        {
          name: 'get_file_info',
          arguments: {
            file: testFileId
          }
        },
        (result) => result.content?.[0]?.text?.includes('Workspace:')
      );

      await testTool(
        'retrieve_file (partial)',
        'tools/call',
        {
          name: 'retrieve_file',
          arguments: {
            file: testFileId,
            startLine: 1,
            endLine: 10
          }
        },
        (result) => result.content?.[0]?.text
      );
    }

    // Note: refresh_index and refresh_all_indexes are maintenance operations
    // that modify state - skipping for basic endpoint test
  }

  // ============================================
  // LM STUDIO MODULE (3 tools)
  // ============================================
  console.log('\n\n🤖 Phase 4: LM Studio Module (3 tools)');

  await testTool(
    'list_available_models',
    'tools/call',
    {
      name: 'list_available_models',
      arguments: {}
    },
    (result) => result.content?.[0]?.text
  );

  await testTool(
    'get_loaded_model',
    'tools/call',
    {
      name: 'get_loaded_model',
      arguments: {}
    },
    (result) => result.content?.[0]?.text
  );

  await testTool(
    'query_model',
    'tools/call',
    {
      name: 'query_model',
      arguments: {
        prompt: 'What is 2+2? Answer with just the number.'
      }
    },
    (result) => result.content?.[0]?.text?.includes('4')
  );

  // ============================================
  // BROWSER MODULE (5 tools)
  // ============================================
  console.log('\n\n🌐 Phase 5: Browser Module (5 tools)');

  await testTool(
    'browser_fetch (text mode)',
    'tools/call',
    {
      name: 'browser_fetch',
      arguments: {
        url: 'https://example.com',
        mode: 'text'
      }
    },
    (result) => result.content?.[0]?.text?.includes('Example Domain')
  );

  await testTool(
    'browser_evaluate',
    'tools/call',
    {
      name: 'browser_evaluate',
      arguments: {
        url: 'https://example.com',
        script: 'document.title'
      }
    },
    (result) => result.content?.[0]?.text?.includes('Example')
  );

  // Note: browser_click, browser_fill, and browser_pdf require more complex
  // setup with interactive pages - testing basic fetch and evaluate covers core functionality

  // ============================================
  // LOCAL AGENT MODULE (3 tools)
  // ============================================
  console.log('\n\n🕵️ Phase 6: Local Agent Module (3 tools)');

  if (workspaceName && testFileId) {
    await testTool(
      'inspect_code',
      'tools/call',
      {
        name: 'inspect_code',
        arguments: {
          workspace: workspaceName,
          target: testFileId,
          question: 'What is this file about?'
        }
      },
      (result) => result.content?.[0]?.text
    );

    // Note: run_local_agent is a complex autonomous operation that can take
    // significant time - skipping for basic endpoint test
  }

  // ============================================
  // WEB RESEARCH MODULE (1 tool)
  // ============================================
  console.log('\n\n🔬 Phase 7: Web Research Module (1 tool)');
  
  // Note: research_topic is currently known to be failing per documentation
  // Testing it anyway to confirm current state
  console.log('⚠️  Note: research_topic has known issues per documentation');
  await testTool(
    'research_topic',
    'tools/call',
    {
      name: 'research_topic',
      arguments: {
        query: 'what is nodejs',
        max_pages: 3
      }
    },
    (result) => result.content?.[0]?.text
  );

  // ============================================
  // SUMMARY
  // ============================================
  console.log('\n\n=====================================');
  console.log('Test Summary');
  console.log('=====================================');
  console.log(`✅ Passed: ${testResults.passed}`);
  console.log(`❌ Failed: ${testResults.failed}`);
  console.log(`📊 Total:  ${testResults.passed + testResults.failed}`);
  
  if (testResults.errors.length > 0) {
    console.log('\n❌ Failed Tests:');
    testResults.errors.forEach(({ tool, error }) => {
      console.log(`  - ${tool}: ${error}`);
    });
  }

  console.log('\n=====================================\n');
  
  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
  console.error('Fatal error running tests:', error);
  process.exit(1);
});
