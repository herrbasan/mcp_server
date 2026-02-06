import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOOLS = [
  {
    name: 'get_documentation',
    description: 'CALL ONCE at session start. Returns complete tool guide with workflows and scope guidelines.',
    inputSchema: { type: 'object', properties: {} }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

export function createDocsServer() {
  let docsContent = null;
  
  function loadDocs() {
    if (docsContent) return docsContent;
    
    try {
      const docsPath = join(__dirname, '..', '..', 'MCP_TOOLS_GUIDE.md');
      docsContent = readFileSync(docsPath, 'utf-8');
      return docsContent;
    } catch (err) {
      throw new Error(`Failed to load documentation: ${err.message}`);
    }
  }
  
  async function getDocumentation() {
    const content = loadDocs();
    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
  
  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    
    async callTool(name, args) {
      try {
        if (name === 'get_documentation') return await getDocumentation();
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }], isError: true };
      }
    },
    
    cleanup: async () => {}
  };
}
