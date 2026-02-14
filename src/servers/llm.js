import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_PROMPT = readFileSync(join(__dirname, '..', '..', 'prompts', 'query_model_system.txt'), 'utf-8');

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
    name: 'query_model',
    description: 'Query the local LLM. To include files, use absolute paths.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt to send.' },
        systemPrompt: { type: 'string', description: 'Optional system prompt' },
        useConfigSystemPrompt: { type: 'boolean', description: 'Use the system prompt from config.json' },
        schema: { type: 'object', description: 'Optional JSON schema for structured output' },
        maxTokens: { type: 'number', description: 'Optional token limit' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths (e.g., "D:\\path\\to\\file.js" or "\\\\server\\share\\file.js")' },
        resources: { type: 'array', items: MCP_RESOURCE_SCHEMA, description: 'Optional MCP resources to include.' }
      },
      required: ['prompt']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

// Match absolute Windows/UNC paths: D:ooar.js or \serveroo.js
const ABSOLUTE_PATH_PATTERN = /(?:[a-zA-Z]:[\\\/][^\s"'`<>|*?]+|\\\\[^\s"'`<>|*?]+)/gi;

/**
 * Validate that a path looks like an absolute path
 */
function validateAbsolutePath(filePath) {
  const isWindowsAbsolute = /^[a-zA-Z]:[\\\/]|^\\\\/.test(filePath);
  
  if (!isWindowsAbsolute) {
    throw new Error(
      `Path must be absolute. Got: "${filePath}". ` +
      `Use full paths like "D:\\project\\file.js" or "\\\\server\\share\\file.js"`
    );
  }
  
  return filePath;
}

/**
 * Extract absolute file paths from prompt text
 */
function extractFilePaths(prompt) {
  const matches = [...prompt.matchAll(ABSOLUTE_PATH_PATTERN)];
  return [...new Set(matches.map(m => m[0]))];
}

/**
 * Parse MCP resource URIs into file references
 */
function parseMcpResources(resources) {
  const files = [];
  const embedded = [];
  
  for (const resource of resources || []) {
    if (!resource.uri) continue;
    
    // Handle embedded resources with text content
    if (resource.text !== undefined) {
      embedded.push(resource);
    }
    // Handle file:// URIs
    else if (resource.uri.startsWith('file://')) {
      let filePath = resource.uri.slice(7);
      filePath = decodeURIComponent(filePath);
      files.push(filePath);
    }
    // Handle absolute paths as plain URIs
    else {
      files.push(resource.uri);
    }
  }
  
  return { files, embedded };
}

/**
 * Resolve and fetch file contents
 */
async function resolveFiles(filePaths) {
  const files = [];
  const errors = [];
  
  for (const filePath of filePaths) {
    try {
      validateAbsolutePath(filePath);
      const content = await fs.readFile(filePath, 'utf-8');
      files.push({ path: filePath, content, size: content.length });
    } catch (err) {
      errors.push(`${filePath} - ${err.message}`);
    }
  }
  
  return { files, errors };
}

/**
 * Build enhanced prompt with file contents injected
 */
function buildEnhancedPrompt(originalPrompt, files, embeddedResources = []) {
  const sections = [];
  
  // Add file contents
  if (files.length > 0) {
    const fileSections = files.map(f => 
      `--- File: ${f.path} (${f.size} chars) ---\n\`\`\`\n${f.content}\n\`\`\``
    );
    sections.push(fileSections.join('\n\n'));
  }
  
  // Add embedded resources
  if (embeddedResources.length > 0) {
    const embeddedSections = embeddedResources.map(r => 
      `--- Resource: ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ''} ---\n\`\`\`\n${r.text}\n\`\`\``
    );
    sections.push(embeddedSections.join('\n\n'));
  }
  
  // Add original prompt
  sections.push(`--- User Prompt ---\n${originalPrompt}`);
  
  return sections.join('\n\n');
}

async function queryModel(router, config, args) {
  const { prompt, systemPrompt, useConfigSystemPrompt, schema, maxTokens, files, resources } = args;
  
  try {
    // Extract file references from prompt text
    const extractedPaths = extractFilePaths(prompt);
    
    // Parse MCP resources
    const mcpRefs = parseMcpResources(resources);
    
    // Parse explicit file refs
    const explicitPaths = (files || []).map(ref => {
      if (typeof ref === 'string' && /^[a-zA-Z]:[\\\/]|^\\\\/.test(ref)) {
        return ref;
      }
      return null;
    }).filter(Boolean);
    
    // Combine all unique paths
    const allPaths = [...new Set([...extractedPaths, ...mcpRefs.files, ...explicitPaths])];
    
    // Resolve and fetch files
    let enhancedPrompt = prompt;
    let resolvedFiles = [];
    let resolutionErrors = [];
    
    if (allPaths.length > 0 || mcpRefs.embedded.length > 0) {
      const result = await resolveFiles(allPaths);
      resolvedFiles = result.files;
      resolutionErrors = result.errors;
      
      // Build enhanced prompt with file contents and embedded resources
      enhancedPrompt = buildEnhancedPrompt(prompt, resolvedFiles, mcpRefs.embedded);
    }
    
    // Priority: explicit param > config > file > blank
    let finalSystemPrompt = '';
    if (systemPrompt !== undefined) {
      finalSystemPrompt = systemPrompt;
    } else if (useConfigSystemPrompt) {
      finalSystemPrompt = config.systemPrompt || '';
    } else if (DEFAULT_SYSTEM_PROMPT) {
      finalSystemPrompt = DEFAULT_SYSTEM_PROMPT;
    }
    
    const response = await router.predict({
      prompt: enhancedPrompt,
      systemPrompt: finalSystemPrompt || undefined,
      taskType: 'query',
      ...(schema && { responseFormat: schema }),
      ...(maxTokens && { maxTokens })
    });
    
    return { 
      content: [{ 
        type: 'text', 
        text: response || '(No response generated)'
      }]
    };
    
  } catch (err) {
    return { 
      content: [{ 
        type: 'text', 
        text: `❌ Error: ${err.message}` 
      }],
      isError: true
    };
  }
}

export function createLLMServer(config, router) {
  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    
    async callTool(name, args) {
      try {
        if (name === 'query_model') return await queryModel(router, config, args);
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }], isError: true };
      }
    },
    
    cleanup: async () => {}
  };
}
