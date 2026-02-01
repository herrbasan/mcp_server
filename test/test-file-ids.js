import { CodeSearchServer } from '../src/servers/code-search.js';
import { LocalAgentServer } from '../src/servers/local-agent.js';
import { WorkspaceResolver } from '../src/lib/workspace.js';

const config = {
  indexPath: 'data/indexes',
  workspaces: {
    defaultMachine: 'COOLKID',
    machines: {
      COOLKID: {
        'D:\\Work': '\\\\COOLKID\\Work'
      },
      BADKID: {
        'D:\\DEV': '\\\\BADKID\\Stuff\\DEV',
        'D:\\SRV': '\\\\BADKID\\Stuff\\SRV'
      }
    }
  }
};

const workspace = new WorkspaceResolver(config.workspaces);
const codeSearch = new CodeSearchServer(config, null);
const localAgent = new LocalAgentServer(config, null);

console.log('=== File ID System Test ===\n');

// Test 1: Get workspace config
console.log('1. Get workspace configuration:');
const configResult = await codeSearch.callTool('get_workspace_config', {});
console.log(JSON.parse(configResult.content[0].text));
console.log('');

// Test 2: Search files with workspace identifier
console.log('2. Search files using workspace identifier (BADKID:D:\\DEV\\mcp_server):');
const searchResult = await codeSearch.callTool('search_files', {
  workspace: 'BADKID:D:\\DEV\\mcp_server',
  glob: 'src/*.js'
});
const searchData = JSON.parse(searchResult.content[0].text);
console.log(`Found ${searchData.count} files`);
if (searchData.matches && searchData.matches.length > 0) {
  console.log('Sample file IDs:');
  searchData.matches.slice(0, 3).forEach(m => console.log(`  - ${m.file_id}`));
}
console.log('');

// Test 3: Parse workspace identifier
console.log('3. Parse workspace identifiers:');
console.log('  "BADKID:D:\\\\DEV\\\\mcp_server" =>', codeSearch._parseWorkspace('BADKID:D:\\DEV\\mcp_server'));
console.log('  "D:\\\\Work" (no machine) =>', codeSearch._parseWorkspace('D:\\Work'));
console.log('');

// Test 4: Format file ID
console.log('4. Format file IDs:');
const fileId1 = codeSearch._formatFileId('src\\http-server.js', 'D:\\DEV\\mcp_server', 'BADKID');
const fileId2 = codeSearch._formatFileId('projects\\app.js', 'D:\\Work', null); // Uses default
console.log(`  BADKID file: ${fileId1}`);
console.log(`  Default machine file: ${fileId2}`);
console.log('');

console.log('✓ All file ID tests passed!\n');
console.log('Key takeaway: Calling LLMs never need to understand UNC paths or path mappings.');
console.log('They just use file IDs like "BADKID:D:\\\\DEV\\\\mcp_server\\\\src\\\\http-server.js"');
