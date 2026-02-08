import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SpaceResolver } from '../lib/space.js';

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
    description: 'Analyze code with LLM for quality issues. To analyze a file, provide the absolute Windows path.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute Windows paths to files to analyze.' },
        code: { type: 'string', description: 'Code snippet to analyze directly.' },
        question: { type: 'string', description: 'Question about the code' },
        space: { type: 'string', description: 'Optional space hint.' },
        resources: { type: 'array', items: MCP_RESOURCE_SCHEMA, description: 'MCP resources with embedded text content.' }
      },
      required: ['question']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

const PROMPTS = [];
const PROMPT_NAMES = new Set();

/**
 * Resolve absolute path to space + relative path
 * Tries: 1) Configured space paths, 2) Code search index lookup
 * @param {string} absolutePath - The absolute path
 * @param {SpaceResolver} spaceResolver - Space resolver
 * @param {object} codeSearch - Code search server (optional, for index lookup)
 * @returns {{space: string, basePath: string, filePath: string} | null}
 */
async function resolveAbsolutePath(absolutePath, spaceResolver, codeSearch) {
  // 1. Try configured space paths (prefix matching)
  const match = spaceResolver.findMatchingSpacePath(absolutePath);
  if (match) {
    return { 
      space: match.space, 
      basePath: match.basePath,
      filePath: match.relativePath 
    };
  }
  
  // 2. Fallback: code search index lookup (handles drive letter vs UNC mismatches)
  if (codeSearch) {
    const indexMatch = await findFileInIndex(absolutePath, codeSearch);
    if (indexMatch) {
      // Get the base path for the matched space
      const basePath = spaceResolver.getSpacePath(indexMatch.space);
      return {
        space: indexMatch.space,
        basePath,
        filePath: indexMatch.filePath
      };
    }
  }
  
  return null;
}

/**
 * Find file in code search index by path suffix matching
 * Maps local drive paths (D:\Work\_GIT\...) to UNC shares (\\COOLKID\Work\_GIT\...)
 * @param {string} absolutePath - The absolute path (e.g., "D:\Work\_GIT\file.js")
 * @param {object} codeSearch - Code search server
 * @returns {{space: string, filePath: string} | null}
 */
async function findFileInIndex(absolutePath, codeSearch) {
  if (!codeSearch) return null;
  
  const normalizedPath = absolutePath.toLowerCase().replace(/\//g, '\\');
  const pathParts = normalizedPath.split('\\');
  const fileName = pathParts[pathParts.length - 1];
  
  if (pathParts.length < 2) return null;
  
  try {
    const result = await codeSearch.callTool('search_keyword', { 
      pattern: fileName.replace(/\./g, '\\.'),
      regex: true
    });
    
    if (!result?.content?.[0]?.text) return null;
    
    const searchResults = JSON.parse(result.content[0].text);
    if (!searchResults.results?.length) return null;
    
    // Find match by path suffix comparison
    for (const match of searchResults.results) {
      const indexedPath = match.path?.toLowerCase() || '';
      const indexedParts = indexedPath.split('/');
      
      for (let inputStart = 0; inputStart < pathParts.length; inputStart++) {
        const inputSuffix = pathParts.slice(inputStart);
        
        if (indexedParts.length >= inputSuffix.length) {
          const indexedSuffix = indexedParts.slice(-inputSuffix.length);
          if (inputSuffix.every((part, i) => part === indexedSuffix[i])) {
            return { space: match.space, filePath: match.path };
          }
        }
      }
    }
  } catch (err) {
    // Best effort
  }
  
  return null;
}

/**
 * Find file by relative path across all spaces
 * Used when space is not provided for a relative path
 * @param {string} relativePath - The relative path (e.g., "Tests/stage.js")
 * @param {object} codeSearch - Code search server
 * @returns {{space: string, filePath: string} | null}
 */
async function findFileByRelativePath(relativePath, codeSearch) {
  if (!codeSearch) return null;
  
  // Normalize to forward slashes
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const pathParts = normalizedPath.split('/');
  const fileName = pathParts[pathParts.length - 1];
  
  try {
    const result = await codeSearch.callTool('search_keyword', { 
      pattern: fileName.replace(/\./g, '\\.'),
      regex: true
    });
    
    if (!result?.content?.[0]?.text) return null;
    
    const searchResults = JSON.parse(result.content[0].text);
    if (!searchResults.results?.length) return null;
    
    // Find matches where the indexed path ends with the relative path
    const matches = searchResults.results.filter(match => {
      const indexedPath = match.path || '';
      return indexedPath.endsWith(normalizedPath);
    });
    
    if (matches.length === 1) {
      return { space: matches[0].space, filePath: matches[0].path };
    }
    
    // If multiple matches, try to find exact match
    const exactMatch = matches.find(m => m.path === normalizedPath);
    if (exactMatch) {
      return { space: exactMatch.space, filePath: exactMatch.path };
    }
    
    // Return first match if multiple (ambiguous)
    if (matches.length > 0) {
      return { space: matches[0].space, filePath: matches[0].path };
    }
  } catch (err) {
    // Best effort
  }
  
  return null;
}

/**
 * Get detailed workspace info for error messages
 */
function getSpaceInfo(spaceResolver) {
  const spaces = spaceResolver.getSpaces();
  return spaces.map(s => `"${s.name}" -> ${s.uncPath}`).join(', ');
}

export function createCodeInspectorServer(config, router) {
  const spaceResolver = new SpaceResolver(config.spaces || {});
  let codeSearch = null;
  let progressCallback = null;

  function sendProgress(progress, total, message) {
    if (progressCallback) {
      progressCallback({ progress, total, message });
    }
  }

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
      // Handle hash IDs or other URIs
      else {
        files.push(resource.uri);
      }
    }
    
    return { files, embedded };
  }

  async function inspectCode(args) {
    const { files, code, question, space: spaceName, resources } = args;

    // Debug: log raw args
    if (process.env.DEBUG_INSPECT_CODE === '1') {
      console.error(`[inspect_code] RAW args: ${JSON.stringify({ files, space: spaceName, hasResources: !!resources })}`);
    }

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
      
      // Auto-detect: if space looks like a path, treat it as files
      let actualFiles = files;
      let actualSpace = spaceName;
      
      if (actualSpace && !actualFiles && actualSpace.match(/^[a-zA-Z]:[\\\/]|^\\\\/)) {
        // space param is actually a file path - convert to files
        actualFiles = actualSpace;
        actualSpace = null;
      }
      
      // Auto-detect: if code looks like a file path, treat it as files
      let actualCode = code;
      let detectedPath = false;
      
      if (actualCode && !actualFiles) {
        // Check if code looks like a file path (contains / or \ and ends with common code extension or no extension)
        const looksLikePath = /^[a-zA-Z]:[\\\/]|^\\\\|[\\\/]/.test(actualCode) && 
                             !actualCode.includes('\n') && 
                             !actualCode.includes('{') && 
                             !actualCode.includes('}') &&
                             actualCode.length < 500;
        
        if (looksLikePath) {
          actualFiles = actualCode;
          actualCode = null;
          detectedPath = true;
        }
      }
      
      // Debug logging
      if (process.env.DEBUG_INSPECT_CODE === '1') {
        console.error(`[inspect_code] files=${files}, space=${spaceName}`);
        console.error(`[inspect_code] actualFiles=${actualFiles}, actualSpace=${actualSpace}`);
      }
      
      if (actualCode && !actualFiles) {
        // Check if code looks like a file path (contains / or \ and ends with common code extension or no extension)
        const looksLikePath = /^[a-zA-Z]:[\\\/]|^\\\\|[\\\/]/.test(actualCode) && 
                             !actualCode.includes('\n') && 
                             !actualCode.includes('{') && 
                             !actualCode.includes('}') &&
                             actualCode.length < 500;
        
        if (looksLikePath) {
          actualFiles = actualCode;
          actualCode = null;
          detectedPath = true;
        }
      }

      if (actualCode) {
        prompt = `Code:\n\`\`\`\n${actualCode}\n\`\`\`\n\nQuestion: ${question}\n\nProvide a concise answer.`;
        resultMeta = { type: 'code_snippet', codeLength: actualCode.length };
      } else if (hasMcpFiles) {
        // Handle MCP resources
        const sections = [];
        
        // Process file:// URIs from MCP resources
        for (const fileId of mcpRefs.files) {
          let filePath, fullPath, content, resolvedSpace;
          
          if (/^[a-f0-9]{32}$/i.test(fileId) && !fileId.includes('/') && !fileId.includes('\\')) {
            // Hash ID - resolve via code search
            if (!codeSearch) {
              throw new Error('Code search not available - cannot resolve hash IDs. Use file paths instead.');
            }
            
            const fileInfoResult = await codeSearch.callTool('get_file_info', { file: fileId });
            const fileInfo = JSON.parse(fileInfoResult.content[0].text);
            
            if (fileInfo.error) {
              throw new Error(`Failed to resolve file ID ${fileId}: ${fileInfo.error}`);
            }
            
            filePath = fileInfo.path;
            resolvedSpace = fileInfo.space;
            fullPath = path.join(spaceResolver.getSpacePath(resolvedSpace), filePath);
          } else if (fileId.match(/^[a-zA-Z]:/) || fileId.startsWith('\\\\')) {
            // Absolute Windows path (D:\...) or UNC (\\server\...) - resolve via config or index
            if (process.env.DEBUG_INSPECT_CODE === '1') {
              console.error(`[inspect_code] Detected absolute path: ${fileId}`);
            }
            
            const mapped = await resolveAbsolutePath(fileId, spaceResolver, codeSearch);
            
            if (process.env.DEBUG_INSPECT_CODE === '1') {
              console.error(`[inspect_code] resolveAbsolutePath returned: ${JSON.stringify(mapped)}`);
            }
            
            if (!mapped) {
              const spaceInfo = getSpaceInfo(spaceResolver);
              throw new Error(`Path "${fileId}" not in any configured space. Configured: ${spaceInfo}. Either use a path within these spaces, or add your path to config.json.`);
            }
            resolvedSpace = mapped.space;
            filePath = mapped.filePath;
            // Use the matched basePath (could be local or UNC) instead of always using UNC
            fullPath = path.join(mapped.basePath, filePath);
            
            if (process.env.DEBUG_INSPECT_CODE === '1') {
              console.error(`[inspect_code] Resolved to: space=${resolvedSpace}, basePath=${mapped.basePath}, fullPath=${fullPath}`);
            }
          } else if (fileId.match(/^[A-Za-z][A-Za-z0-9_-]*:/) && !fileId.match(/^[a-zA-Z]:/)) {
            // SPACE:path format (not Windows drive letter)
            const colonIdx = fileId.indexOf(':');
            resolvedSpace = fileId.substring(0, colonIdx);
            filePath = fileId.substring(colonIdx + 1);
            fullPath = path.join(spaceResolver.getSpacePath(resolvedSpace), filePath);
          } else {
            // Relative path - try auto-detect via code search first
            const autoDetect = await findFileByRelativePath(fileId, codeSearch);
            if (autoDetect) {
              resolvedSpace = autoDetect.space;
              filePath = autoDetect.filePath;
              fullPath = path.join(spaceResolver.getSpacePath(resolvedSpace), filePath);
            } else if (!actualSpace) {
              const spaceInfo = getSpaceInfo(spaceResolver);
              throw new Error(`Use an absolute Windows path like "D:\\SomeFolder\\SomeFile.js". Relative paths require a space parameter.`);
            } else {
              filePath = fileId;
              resolvedSpace = actualSpace;
              fullPath = path.join(spaceResolver.getSpacePath(resolvedSpace), filePath);
            }
          }
          
          await spaceResolver.validatePath(fullPath, resolvedSpace);
          content = await fs.readFile(fullPath, 'utf-8');
          sections.push(`File: ${resolvedSpace}:${filePath}\n\`\`\`\n${content}\n\`\`\``);
        }
        
        // Add embedded resources
        for (const resource of mcpRefs.embedded) {
          sections.push(`Resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''}\n\`\`\`\n${resource.text}\n\`\`\``);
        }
        
        prompt = `${sections.join('\n\n')}\n\nQuestion: ${question}\n\nProvide a concise answer.`;
        resultMeta = { type: 'mcp_resources', files: mcpRefs.files, embedded: mcpRefs.embedded.length };
      } else if (actualFiles) {
        // Handle files (file paths)
        const targets = Array.isArray(actualFiles) 
          ? actualFiles 
          : actualFiles.split(',').map(t => t.trim());
        
        const files = [];
        
        for (let fileId of targets) {
          let filePath, fullPath, content, resolvedSpace;
          
          if (/^[a-f0-9]{32}$/i.test(fileId) && !fileId.includes('/') && !fileId.includes('\\')) {
            // Hash ID - resolve via code search
            if (!codeSearch) {
              throw new Error('Code search not available - cannot resolve hash IDs. Use file paths instead.');
            }
            
            const fileInfoResult = await codeSearch.callTool('get_file_info', { file: fileId });
            const fileInfo = JSON.parse(fileInfoResult.content[0].text);
            
            if (fileInfo.error) {
              throw new Error(`Failed to resolve file ID ${fileId}: ${fileInfo.error}`);
            }
            
            filePath = fileInfo.path;
            resolvedSpace = fileInfo.space;
            fullPath = path.join(spaceResolver.getSpacePath(resolvedSpace), filePath);
          } else if (fileId.match(/^[a-zA-Z]:/) || fileId.startsWith('\\\\')) {
            // Absolute Windows path or UNC - resolve via config or index
            if (process.env.DEBUG_INSPECT_CODE === '1') {
              console.error(`[inspect_code] Processing absolute path: ${fileId}`);
            }
            
            const mapped = await resolveAbsolutePath(fileId, spaceResolver, codeSearch);
            
            if (process.env.DEBUG_INSPECT_CODE === '1') {
              console.error(`[inspect_code] resolveAbsolutePath result: ${JSON.stringify(mapped)}`);
            }
            
            if (!mapped) {
              const spaceInfo = getSpaceInfo(spaceResolver);
              console.error(`[inspect_code] Path resolution failed for: ${fileId}`);
              console.error(`[inspect_code] Available spaces: ${spaceInfo}`);
              throw new Error(`Path "${fileId}" not found in any space. Available: ${spaceResolver.getSpaces().map(s => s.name).join(', ')}. Try using SPACE:path format (e.g., "COOLKID-Work:_GIT/path/to/file.js") or hash ID.`);
            }
            resolvedSpace = mapped.space;
            filePath = mapped.filePath;
            // Use the matched basePath (could be local or UNC) instead of always using UNC
            fullPath = path.join(mapped.basePath, filePath);
          } else if (fileId.match(/^[A-Za-z][A-Za-z0-9_-]*:/) && !fileId.match(/^[a-zA-Z]:/)) {
            // SPACE:path format (not Windows drive letter)
            const colonIdx = fileId.indexOf(':');
            resolvedSpace = fileId.substring(0, colonIdx);
            filePath = fileId.substring(colonIdx + 1);
            fullPath = path.join(spaceResolver.getSpacePath(resolvedSpace), filePath);
          } else {
            // Relative path - try auto-detect via code search first
            const autoDetect = await findFileByRelativePath(fileId, codeSearch);
            if (autoDetect) {
              resolvedSpace = autoDetect.space;
              filePath = autoDetect.filePath;
              fullPath = path.join(spaceResolver.getSpacePath(resolvedSpace), filePath);
            } else {
              filePath = fileId;
              resolvedSpace = actualSpace;
              
              if (!resolvedSpace) {
                const spaceInfo = getSpaceInfo(spaceResolver);
                throw new Error(`"space" required for relative path "${fileId}". Use space name: ${spaceResolver.getSpaces().map(s => s.name).join(', ')}. Or use absolute path, hash ID, or SPACE:path format. Configured: ${spaceInfo}`);
              }
              
              fullPath = path.join(spaceResolver.getSpacePath(resolvedSpace), filePath);
            }
          }
          
          // Debug logging
          if (process.env.DEBUG_INSPECT_CODE === '1') {
            console.error(`[inspect_code] Validating fullPath: ${fullPath}`);
            console.error(`[inspect_code] For space: ${resolvedSpace}`);
          }
          
          await spaceResolver.validatePath(fullPath, resolvedSpace);
          content = await fs.readFile(fullPath, 'utf-8');
          files.push({ path: `${resolvedSpace}:${filePath}`, content });
        }
        
        let filesSection = files.map(f => 
          `File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
        ).join('\n\n');
        
        prompt = `${filesSection}\n\nQuestion: ${question}\n\nProvide a concise answer.`;
        resultMeta = { type: 'files', files: files.map(f => f.path) };
      }
      
      // Debug: log system prompt info
      if (process.env.DEBUG_INSPECT_CODE === '1') {
        console.error(`[inspect_code] Using system prompt: ${SYSTEM_PROMPT ? 'YES' : 'NO'} (length: ${SYSTEM_PROMPT?.length || 0})`);
        console.error(`[inspect_code] Prompt preview: ${prompt?.slice(0, 100)}...`);
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
    
    getPrompts: () => PROMPTS,
    handlesPrompt: name => PROMPT_NAMES.has(name),
    getPrompt: (name, args) => null,
    
    async callTool(name, args) {
      if (name === 'inspect_code') return await inspectCode(args);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    },
    
    setProgressCallback: (callback) => { progressCallback = callback; },
    setCodeSearchServer: (server) => { codeSearch = server; },
    
    cleanup: async () => {}
  };
}

export { createCodeInspectorServer as createLocalAgentServer };

