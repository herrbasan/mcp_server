import { readFileSync, readdirSync } from 'fs';
import { dirname, join, extname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '..', '..', 'mcp_documentation');

const TOOLS = [
  {
    name: 'get_documentation',
    description: 'Get the main orchestrator documentation (tools guide). Equivalent to read_document({name: "orchestrator"}).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_documents',
    description: 'List all available documentation files in the mcp_documentation folder.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'read_document',
    description: 'Read a specific documentation file by name (without .md extension).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Document name without extension (e.g., "orchestrator", "coding-philosophy")' }
      },
      required: ['name']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

function getDocFiles() {
  try {
    const files = readdirSync(DOCS_DIR);
    return files
      .filter(f => extname(f) === '.md')
      .map(f => ({
        name: basename(f, '.md'),
        filename: f,
        path: join(DOCS_DIR, f)
      }));
  } catch (err) {
    return [];
  }
}

function loadDoc(name) {
  const files = getDocFiles();
  const doc = files.find(f => f.name === name);
  
  if (!doc) {
    const available = files.map(f => f.name).join(', ');
    throw new Error(`Document "${name}" not found. Available: ${available || 'none'}`);
  }
  
  return readFileSync(doc.path, 'utf-8');
}

export function createDocsServer() {
  async function getDocumentation() {
    // Default to orchestrator.md
    const content = loadDoc('orchestrator');
    return {
      content: [{
        type: 'text',
        text: content
      }]
    };
  }
  
  async function listDocuments() {
    const files = getDocFiles();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          documents: files.map(f => f.name),
          count: files.length
        }, null, 2)
      }]
    };
  }
  
  async function readDocument(args) {
    const { name } = args;
    const content = loadDoc(name);
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
        if (name === 'list_documents') return await listDocuments();
        if (name === 'read_document') return await readDocument(args);
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }], isError: true };
      }
    },
    
    cleanup: async () => {}
  };
}
