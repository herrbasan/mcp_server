import { WorkspaceResolver } from '../src/lib/workspace.js';

console.log('Testing WorkspaceResolver (new simplified API)...\n');

// Test config: workspace name -> UNC path
const config = {
  'COOLKID-Work': '\\\\COOLKID\\Work',
  'COOLKID-DEV': '\\\\COOLKID\\DEV',
  'BADKID-DEV': '\\\\BADKID\\Stuff\\DEV',
  'BADKID-SRV': '\\\\BADKID\\Stuff\\SRV'
};

const resolver = new WorkspaceResolver(config);
let passed = 0;
let failed = 0;

// Test 1: Get workspace path
console.log('Test 1: Get workspace path');
try {
  const result = resolver.getWorkspacePath('BADKID-DEV');
  console.log(`✓ BADKID-DEV -> ${result}`);
  if (result !== '\\\\BADKID\\Stuff\\DEV') {
    throw new Error(`Expected \\\\BADKID\\Stuff\\DEV, got ${result}`);
  }
  passed++;
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
  failed++;
}

// Test 2: Unknown workspace throws
console.log('\nTest 2: Unknown workspace throws');
try {
  resolver.getWorkspacePath('NONEXISTENT');
  console.log('✗ Should have thrown');
  failed++;
} catch (err) {
  if (err.message.includes('Unknown workspace')) {
    console.log(`✓ Correctly rejected: ${err.message}`);
    passed++;
  } else {
    console.log(`✗ Wrong error: ${err.message}`);
    failed++;
  }
}

// Test 3: Parse file ID
console.log('\nTest 3: Parse file ID');
try {
  const result = resolver.parseFileId('BADKID-DEV:src/http-server.js');
  console.log(`✓ Parsed: workspace=${result.workspace}, relativePath=${result.relativePath}`);
  if (result.workspace !== 'BADKID-DEV' || result.relativePath !== 'src/http-server.js') {
    throw new Error('Parsed values incorrect');
  }
  passed++;
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
  failed++;
}

// Test 4: Invalid file ID (no colon)
console.log('\nTest 4: Invalid file ID (no colon)');
try {
  resolver.parseFileId('BADKID-DEV/src/file.js');
  console.log('✗ Should have thrown');
  failed++;
} catch (err) {
  if (err.message.includes('missing')) {
    console.log(`✓ Correctly rejected: ${err.message}`);
    passed++;
  } else {
    console.log(`✗ Wrong error: ${err.message}`);
    failed++;
  }
}

// Test 5: Path traversal rejection
console.log('\nTest 5: Path traversal rejection');
try {
  resolver.parseFileId('BADKID-DEV:../etc/passwd');
  console.log('✗ Should have thrown');
  failed++;
} catch (err) {
  if (err.message.includes('traversal')) {
    console.log(`✓ Correctly rejected: ${err.message}`);
    passed++;
  } else {
    console.log(`✗ Wrong error: ${err.message}`);
    failed++;
  }
}

// Test 6: Resolve file ID to UNC path
console.log('\nTest 6: Resolve file ID to UNC path');
try {
  const result = resolver.resolveFileId('BADKID-DEV:src/http-server.js');
  console.log(`✓ BADKID-DEV:src/http-server.js -> ${result}`);
  // Should be \\BADKID\Stuff\DEV\src\http-server.js
  if (!result.includes('BADKID') || !result.includes('http-server.js')) {
    throw new Error(`Unexpected path: ${result}`);
  }
  passed++;
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
  failed++;
}

// Test 7: Create file ID
console.log('\nTest 7: Create file ID');
try {
  const result = resolver.createFileId('COOLKID-Work', 'project\\src\\main.js');
  console.log(`✓ Created: ${result}`);
  if (result !== 'COOLKID-Work:project/src/main.js') {
    throw new Error(`Expected COOLKID-Work:project/src/main.js, got ${result}`);
  }
  passed++;
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
  failed++;
}

// Test 8: Get workspaces list
console.log('\nTest 8: Get workspaces list');
try {
  const workspaces = resolver.getWorkspaces();
  console.log(`✓ Found ${workspaces.length} workspaces`);
  workspaces.forEach(w => console.log(`   - ${w.name}: ${w.uncPath}`));
  if (workspaces.length !== 4) {
    throw new Error(`Expected 4 workspaces, got ${workspaces.length}`);
  }
  passed++;
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
  failed++;
}

console.log(`\n========================================`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
console.log(`========================================`);

process.exit(failed > 0 ? 1 : 0);
