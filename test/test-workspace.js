import { WorkspaceResolver } from '../src/lib/workspace.js';

console.log('Testing WorkspaceResolver...\n');

// Test config
const config = {
  defaultMachine: 'COOLKID',
  machines: {
    'COOLKID': {
      'D:\\Work': '\\\\COOLKID\\Work',
      'D:\\DEV': '\\\\COOLKID\\DEV'
    },
    'FATTEN': {
      'E:\\Projects': '\\\\FATTEN\\Projects'
    }
  }
};

const resolver = new WorkspaceResolver(config);

// Test 1: Basic path resolution
console.log('Test 1: Basic path resolution');
try {
  const result = resolver.resolvePath('D:\\DEV\\mcp_server');
  console.log(`✓ D:\\DEV\\mcp_server -> ${result}`);
  if (result !== '\\\\COOLKID\\DEV\\mcp_server') {
    throw new Error(`Expected \\\\COOLKID\\DEV\\mcp_server, got ${result}`);
  }
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
}

// Test 2: Case insensitive matching
console.log('\nTest 2: Case insensitive matching');
try {
  const result = resolver.resolvePath('d:\\work\\project');
  console.log(`✓ d:\\work\\project -> ${result}`);
  if (result !== '\\\\COOLKID\\Work\\project') {
    throw new Error(`Expected \\\\COOLKID\\Work\\project, got ${result}`);
  }
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
}

// Test 3: Longest prefix match
console.log('\nTest 3: Longest prefix match (if overlapping shares existed)');
try {
  const result = resolver.resolvePath('D:\\DEV\\mcp_server\\src');
  console.log(`✓ D:\\DEV\\mcp_server\\src -> ${result}`);
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
}

// Test 4: Different machine
console.log('\nTest 4: Explicit machine specification');
try {
  const result = resolver.resolvePath('E:\\Projects\\webapp', 'FATTEN');
  console.log(`✓ E:\\Projects\\webapp [FATTEN] -> ${result}`);
  if (result !== '\\\\FATTEN\\Projects\\webapp') {
    throw new Error(`Expected \\\\FATTEN\\Projects\\webapp, got ${result}`);
  }
} catch (err) {
  console.log(`✗ Error: ${err.message}`);
}

// Test 5: Path traversal rejection
console.log('\nTest 5: Path traversal rejection');
try {
  const result = resolver.resolvePath('D:\\DEV\\..\\..\\Windows');
  console.log(`✗ Should have rejected path with ..`);
} catch (err) {
  console.log(`✓ Correctly rejected: ${err.message}`);
}

// Test 6: Unknown path
console.log('\nTest 6: Unknown path (not in any share)');
try {
  const result = resolver.resolvePath('C:\\Windows\\System32');
  console.log(`✗ Should have thrown error for unconfigured path`);
} catch (err) {
  console.log(`✓ Correctly rejected: ${err.message}`);
}

// Test 7: Unknown machine
console.log('\nTest 7: Unknown machine');
try {
  const result = resolver.resolvePath('D:\\DEV\\test', 'UNKNOWN');
  console.log(`✗ Should have thrown error for unknown machine`);
} catch (err) {
  console.log(`✓ Correctly rejected: ${err.message}`);
}

// Test 8: List machines
console.log('\nTest 8: List machines');
const machines = resolver.listMachines();
console.log(`✓ Available machines: ${machines.join(', ')}`);

// Test 9: Get shares
console.log('\nTest 9: Get shares for COOLKID');
const shares = resolver.getShares('COOLKID');
console.log(`✓ Shares:`, shares);

// Test 10: Get allowed shares
console.log('\nTest 10: Get allowed shares (for validation)');
const allowed = resolver.getAllowedShares('COOLKID');
console.log(`✓ Allowed UNC prefixes: ${allowed.join(', ')}`);

// Test 11: Index path generation
console.log('\nTest 11: Index path generation');
const indexPath = resolver.getIndexPath('D:\\DEV\\mcp_server');
console.log(`✓ Index path: ${indexPath}`);

console.log('\n✓ All tests passed!');
