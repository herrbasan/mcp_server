import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(path.join(__dirname, '..', '..', 'prompts', 'code_inspect.txt'), 'utf-8');

// Verify system prompt loaded at module load time
if (!SYSTEM_PROMPT || SYSTEM_PROMPT.length === 0) {
  console.error('[code-inspector] WARNING: System prompt is empty!');
} else {
  console.error(`[code-inspector] System prompt loaded: ${SYSTEM_PROMPT.length} chars`);
}

const MCP_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    uri: { type: 'string', description: 'Resource URI (file://path or custom scheme)' },
    text: { type: 'string', description: 'Resource content (if embedded)' },
    mimeType: { type: 'string', description: 'MIME type of resource' }
  }
};

const TOOLS = [
  {
    name: 'inspect_code',
    description: 'Analyze code with LLM for quality issues. Provide absolute file paths or code snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths (e.g., "D:\\path\\to\\file.js" or "\\\\server\\share\\file.js")' },
        code: { type: 'string', description: 'Code snippet to analyze directly.' },
        question: { type: 'string', description: 'Question about the code' },
        resources: { type: 'array', items: MCP_RESOURCE_SCHEMA, description: 'MCP resources with embedded text content.' }
      },
      required: ['question']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

/**
 * Parse MCP resources into file references or embedded content
 */
function parseMcpResources(resources) {
  const files = [];
  const embedded = [];
  
  for (const resource of resources || []) {
    if (!resource.uri) continue;
    
    // Handle embedded resources (has text content) - check first!
    if (resource.text !== undefined) {
      embedded.push(resource);
    }
    // Handle file:// URIs
    else if (resource.uri.startsWith('file://')) {
      let filePath = resource.uri.slice(7);
      filePath = decodeURIComponent(filePath);
      files.push(filePath);
    }
    // Handle other URIs (must be absolute paths)
    else {
      files.push(resource.uri);
    }
  }
  
  return { files, embedded };
}

/**
 * Validate that a path looks like an absolute path
 */
function validateAbsolutePath(filePath) {
  // Windows absolute: D:\... or \\server\...
  const isWindowsAbsolute = /^[a-zA-Z]:[\\\/]|^\\\\/.test(filePath);
  
  if (!isWindowsAbsolute) {
    throw new Error(
      `Path must be absolute. Got: "${filePath}". ` +
      `Use full paths like "D:\\project\\file.js" or "\\\\server\\share\\file.js"`
    );
  }
  
  return filePath;
}

export function createCodeInspectorServer(config, router) {
  let progressCallback = null;

  function sendProgress(progress, total, message) {
    if (progressCallback) {
      progressCallback({ progress, total, message });
    }
  }

  async function inspectCode(args) {
    const { files, code, question, resources } = args;

    try {
      // Parse MCP resources first
      const mcpRefs = parseMcpResources(resources);
      const hasMcpFiles = mcpRefs.files.length > 0 || mcpRefs.embedded.length > 0;
      
      // Validate: exactly one input method must be provided
      const inputCount = (files ? 1 : 0) + (code ? 1 : 0) + (hasMcpFiles ? 1 : 0);
      if (inputCount > 1) {
        throw new Error('Cannot specify multiple of "files", "code", and "resources". Use one method only.');
      }
      if (inputCount === 0) {
        throw new Error('Must specify either "files", "code" (snippet), or "resources" (MCP resources).');
      }

      let prompt;
      let resultMeta = {};
      
      if (code && !files) {
        prompt = `Code:\n\`\`\`\n${code}\n\`\`\`\n\nQuestion: ${question}\n\nProvide a concise answer.`;
        resultMeta = { type: 'code_snippet', codeLength: code.length };
      } else if (hasMcpFiles) {
        // Handle MCP resources
        const sections = [];
        
        // Process file:// URIs from MCP resources
        for (const filePath of mcpRefs.files) {
          validateAbsolutePath(filePath);
          const content = await fs.readFile(filePath, 'utf-8');
          sections.push(`File: ${filePath}\n\`\`\`\n${content}\n\`\`\``);
        }
        
        // Add embedded resources
        for (const resource of mcpRefs.embedded) {
          sections.push(`Resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''}\n\`\`\`\n${resource.text}\n\`\`\``);
        }
        
        prompt = `${sections.join('\n\n')}\n\nQuestion: ${question}\n\nProvide a concise answer.`;
        resultMeta = { type: 'mcp_resources', files: mcpRefs.files, embedded: mcpRefs.embedded.length };
      } else if (files) {
        // Handle files (absolute paths only)
        const targets = Array.isArray(files) 
          ? files 
          : files.split(',').map(t => t.trim());
        
        const fileContents = [];
        
        for (const filePath of targets) {
          // Validate absolute path
          validateAbsolutePath(filePath);
          
          // Read file
          const content = await fs.readFile(filePath, 'utf-8');
          fileContents.push({ path: filePath, content });
        }
        
        let filesSection = fileContents.map(f => 
          `File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
        ).join('\n\n');
        
        prompt = `${filesSection}\n\nQuestion: ${question}\n\nProvide a concise answer.`;
        resultMeta = { type: 'files', files: fileContents.map(f => f.path) };
      }
      
      const answer = await router.predict({
        systemPrompt: SYSTEM_PROMPT,
        prompt,
        maxTokens: 1000,
        temperature: 0.3,
        taskType: 'inspect'
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...resultMeta,
            question,
            analysis: answer.trim()
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            code: err.code || 'INSPECT_ERROR',
            files: args.files
          }, null, 2)
        }]
      };
    }
  }

  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    
    getPrompts: () => [],
    handlesPrompt: name => false,
    getPrompt: (name, args) => null,
    
    async callTool(name, args) {
      if (name === 'inspect_code') return await inspectCode(args);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    },
    
    setProgressCallback: (callback) => { progressCallback = callback; },
    
    cleanup: async () => {}
  };
}

export { createCodeInspectorServer as createLocalAgentServer };
