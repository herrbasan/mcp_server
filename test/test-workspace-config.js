import { CodeSearchServer } from '../src/servers/code-search.js';

const config = {
  indexPath: 'data/indexes',
  workspaces: {
    'COOLKID-Work': '\\\\COOLKID\\Work',
    'BADKID-DEV': '\\\\BADKID\\Stuff\\DEV',
    'BADKID-SRV': '\\\\BADKID\\Stuff\\SRV'
  }
};

const codeSearch = new CodeSearchServer(config, null);

console.log('Testing get_workspace_config tool...\n');

const result = await codeSearch.callTool('get_workspace_config', {});
console.log(result.content[0].text);
