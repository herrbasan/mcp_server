import { readFileSync } from 'fs';
import { join, dirname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { SpaceResolver } from '../lib/space.js';
import fs from 'fs/promises';
import path from 'path';

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
    description: 'Query the local LLM. To include files, use the files parameter with absolute Windows paths.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt to send.' },
        systemPrompt: { type: 'string', description: 'Optional system prompt' },
        useConfigSystemPrompt: { type: 'boolean', description: 'Use the system prompt from config.json' },
        schema: { type: 'object', description: 'Optional JSON schema for structured output' },
        maxTokens: { type: 'number', description: 'Optional token limit' },
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute Windows paths to files to include.' },
        resources: { type: 'array', items: MCP_RESOURCE_SCHEMA, description: 'Optional MCP resources to include.' }
      },
      required: ['prompt']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

// Regex patterns for file detection
const HASH_ID_PATTERN = /\b[a-f0-9]{32}\b/gi;
const WORKSPACE_PATH_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]*):([a-zA-Z0-9_\-\/\\.]+\.[a-zA-Z0-9]+)\b/g;
// Match absolute Windows/UNC paths with extensions: D:\foo\bar.js or \\server\foo.js
const ABSOLUTE_PATH_PATTERN = /(?:[a-zA-Z]:[\\\/][^\s"'`<>|*?]+\.[a-zA-Z0-9]+|\\\\[^\s"'`<>|*?]+\.[a-zA-Z0-9]+)/gi;

/**
 * Find which workspace an absolute path belongs to
 * @param {string} absolutePath - The absolute path
 * @param {SpaceResolver} spaceResolver - Space resolver
 * @returns {{space: string, filePath: string} | null}
 */
function findSpaceForPath(absolutePath, spaceResolver) {
  // Normalize: lowercase, forward slashes to backslashes
  const normalizedInput = absolutePath.toLowerCase().replace(/\//g, '\\');
  const spaces = spaceResolver.getSpaces();
  
  // Sort by path length (longest first) to handle nested spaces
  const sortedSpaces = spaces
    .map(s => ({ 
      ...s, 
      normalizedPath: s.uncPath.toLowerCase().replace(/\//g, '\\')
    }))
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length);
  
  for (const s of sortedSpaces) {
    if (normalizedInput.startsWith(s.normalizedPath)) {
      // Extract relative path
      let relativePath = normalizedInput.substring(s.normalizedPath.length);
      relativePath = relativePath.replace(/^\\/, ''); // Remove leading backslash
      relativePath = relativePath.replace(/\\/g, '/'); // Normalize to forward slashes
      return { space: s.name, filePath: relativePath };
    }
  }
  
  return null;
}

/**
 * Resolve absolute path to workspace + relative path
 * Tries: 1) Configured workspace paths, 2) Code search index lookup
 * @param {string} absolutePath - The absolute path
 * @param {SpaceResolver} spaceResolver - Space resolver
 * @param {object} codeSearch - Code search server (optional, for index lookup)
 * @returns {{space: string, filePath: string} | null}
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
async function findFileInIndex(absolutePath, codeSearch, preferredSpace = null) {
  if (!codeSearch) return null;
  
  const normalizedPath = absolutePath.toLowerCase().replace(/\//g, '\\');
  const pathParts = normalizedPath.split('\\');
  const fileName = pathParts[pathParts.length - 1];
  
  // Require at least 3 path components for index lookup
  if (pathParts.length < 3) {
    return null;
  }
  
  try {
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Index search timeout')), 5000)
    );
    
    const searchPromise = codeSearch.callTool('search_keyword', { 
      pattern: fileName.replace(/\./g, '\\.'),
      regex: true
    });
    
    const result = await Promise.race([searchPromise, timeoutPromise]);
    
    if (!result?.content?.[0]?.text) return null;
    
    const searchResults = JSON.parse(result.content[0].text);
    if (!searchResults.results?.length) return null;
    
    // Sort results: preferred workspace first, then by path similarity
    let matches = searchResults.results.map(match => {
      const indexedPath = match.path?.toLowerCase() || '';
      const indexedParts = indexedPath.split('/');
      
      // Calculate match score based on path suffix overlap
      let score = 0;
      for (let inputStart = 0; inputStart < pathParts.length; inputStart++) {
        const inputSuffix = pathParts.slice(inputStart);
        
        if (indexedParts.length >= inputSuffix.length) {
          const indexedSuffix = indexedParts.slice(-inputSuffix.length);
          if (inputSuffix.every((part, i) => part === indexedSuffix[i])) {
            score = inputSuffix.length; // Higher score = more path components matched
            break;
          }
        }
      }
      
      // Bonus for preferred space
      if (preferredSpace && match.space === preferredSpace) {
        score += 100;
      }
      
      return { ...match, score };
    }).filter(m => m.score > 0);
    
    // Sort by score descending
    matches.sort((a, b) => b.score - a.score);
    
    if (matches.length > 0) {
      return { space: matches[0].space, filePath: matches[0].path };
    }
  } catch (err) {
    // Best effort
  }
  
  return null;
}

/**
 * Extract file references from prompt text
 * @param {string} prompt - The prompt text
 * @param {SpaceResolver} spaceResolver - Space resolver (optional, for absolute path mapping)
 * @returns {{hashIds: string[], spacePaths: {space: string, filePath: string}[], absolutePaths: string[]}}
 */
function extractFileReferences(prompt, spaceResolver) {
  const hashIds = [...prompt.matchAll(HASH_ID_PATTERN)].map(m => m[0]).filter((v, i, a) => a.indexOf(v) === i);
  const spacePaths = [];
  const absolutePaths = [];
  
  // Extract SPACE:path format
  let match;
  const pathRegex = new RegExp(WORKSPACE_PATH_PATTERN.source, 'g');
  while ((match = pathRegex.exec(prompt)) !== null) {
    spacePaths.push({
      space: match[1],
      filePath: match[2].replace(/\\/g, '/')
    });
  }
  
  // Extract absolute paths
  const absRegex = new RegExp(ABSOLUTE_PATH_PATTERN.source, 'g');
  while ((match = absRegex.exec(prompt)) !== null) {
    const absPath = match[0];
    // Skip if it looks like a workspace:path (already captured above)
    if (!absPath.match(/^[A-Za-z][A-Za-z0-9_-]*:/)) {
      absolutePaths.push(absPath);
    }
  }
  
  // Remove duplicates
  const seenSpaces = new Set();
  const uniquePaths = spacePaths.filter(p => {
    const key = `${p.space}:${p.filePath}`;
    if (seenSpaces.has(key)) return false;
    seenSpaces.add(key);
    return true;
  });
  
  const uniqueAbsPaths = [...new Set(absolutePaths)];
  
  return { hashIds, spacePaths: uniquePaths, absolutePaths: uniqueAbsPaths };
}

/**
 * Parse MCP resource URIs into file references
 * @param {Array} resources - MCP resources array
 * @returns {{hashIds: string[], spacePaths: Array, absolutePaths: string[], embedded: Array}}
 */
function parseMcpResources(resources) {
  const hashIds = [];
  const spacePaths = [];
  const absolutePaths = [];
  const embedded = [];
  
  for (const resource of resources || []) {
    if (!resource.uri) continue;
    
    // Handle embedded resources with text content - check first!
    if (resource.text !== undefined) {
      embedded.push(resource);
    }
    // Handle file:// URIs
    else if (resource.uri.startsWith('file://')) {
      let filePath = resource.uri.slice(7); // Remove file:// prefix
      filePath = decodeURIComponent(filePath); // Decode URI encoding
      
      // Check if it contains a hash ID
      if (/^[a-f0-9]{32}$/i.test(filePath)) {
        hashIds.push(filePath);
      }
      // Check if it's an absolute path (Windows drive letter or UNC)
      else if (filePath.match(/^[a-zA-Z]:[\\/]|^\\\\/)) {
        // Windows absolute path (D:\...) or UNC (\\server\...)
        absolutePaths.push(filePath);
      }
      // Check if it's WORKSPACE:path format (not Windows drive like C:)
      else if (filePath.match(/^[A-Za-z][A-Za-z0-9_-]*:/) && !filePath.match(/^[a-zA-Z]:[\\/]/)) {
        const colonIdx = filePath.indexOf(':');
        const ws = filePath.substring(0, colonIdx);
        const relPath = filePath.substring(colonIdx + 1);
        spacePaths.push({ space: ws, filePath: relPath });
      }
    }
    // Handle custom schemes or hash IDs as plain URIs
    else if (/^[a-f0-9]{32}$/i.test(resource.uri)) {
      hashIds.push(resource.uri);
    }
  }
  
  return { hashIds, spacePaths, absolutePaths, embedded };
}

/**
 * Resolve hash ID to file path using code search server
 */
async function resolveHashId(hashId, codeSearch) {
  if (!codeSearch) {
    throw new Error('Code search not available - cannot resolve hash ID. Enable code-search server or use absolute/SPACE:path format.');
  }
  
  const result = await codeSearch.callTool('get_file_info', { file: hashId });
  const info = JSON.parse(result.content[0].text);
  
  if (info.error) {
    throw new Error(`Failed to resolve file ID ${hashId}: ${info.error}`);
  }
  
  return { space: info.space, filePath: info.path };
}

/**
 * Resolve and fetch file contents
 */
async function resolveFiles(fileRefs, spaceResolver, codeSearch) {
  const files = [];
  const errors = [];
  const availableSpaces = spaceResolver.getSpaces().map(s => `${s.name}=${s.uncPath}`).join(', ');
  
  for (const ref of fileRefs) {
    try {
      let spaceName, filePath, fullPath;
      
      if (typeof ref === 'string' && /^[a-f0-9]{32}$/i.test(ref)) {
        // Hash ID
        const resolved = await resolveHashId(ref, codeSearch);
        spaceName = resolved.space;
        filePath = resolved.filePath;
        const spacePath = spaceResolver.getSpacePath(spaceName);
        fullPath = path.join(spacePath, filePath);
      } else if (ref.space && ref.filePath) {
        // Explicit SPACE:path object
        spaceName = ref.space;
        filePath = ref.filePath;
        const spacePath = spaceResolver.getSpacePath(spaceName);
        fullPath = path.join(spacePath, filePath);
      } else if (typeof ref === 'string') {
        // Absolute path - resolve via config or index
        const mapped = await resolveAbsolutePath(ref, spaceResolver, codeSearch);
        
        if (!mapped) {
          errors.push(`Path "${ref}" not in any configured space. Available spaces: ${availableSpaces}. Either use a path within these spaces, add the path to config.json spaces, or use hash IDs from code search.`);
          continue;
        }
        spaceName = mapped.space;
        filePath = mapped.filePath;
        // Use the matched basePath (could be local or UNC) instead of always using primary path
        fullPath = path.join(mapped.basePath, filePath);
      } else {
        errors.push(`Invalid file reference: ${JSON.stringify(ref)}`);
        continue;
      }
      
      await spaceResolver.validatePath(fullPath, spaceName);
      const content = await fs.readFile(fullPath, 'utf-8');
      
      files.push({
        path: `${spaceName}:${filePath}`,
        content,
        size: content.length
      });
    } catch (err) {
      const refStr = typeof ref === 'string' ? ref : `${ref.space}:${ref.filePath}`;
      errors.push(`${refStr} - ${err.message}`);
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

async function queryModel(router, config, spaceResolver, codeSearch, args) {
  const { prompt, systemPrompt, useConfigSystemPrompt, schema, maxTokens, files, resources } = args;
  
  // Add overall timeout for file resolution
  const TIMEOUT_MS = 30000; // 30 seconds max
  const startTime = Date.now();
  
  const checkTimeout = () => {
    if (Date.now() - startTime > TIMEOUT_MS) {
      throw new Error('File resolution timeout - try using hash IDs or SPACE:path format');
    }
  };
  
  try {
    // Extract file references from prompt text
    const extracted = extractFileReferences(prompt, spaceResolver);
    checkTimeout();
    
    // Parse MCP resources
    const mcpRefs = parseMcpResources(resources);
    
    // Parse explicit refs (can be hash IDs, absolute paths, or workspace:path strings)
    const parsedExplicitRefs = (files || []).map(ref => {
      if (/^[a-f0-9]{32}$/i.test(ref)) {
        return ref; // Hash ID
      }
      if (ref.match(/^[a-zA-Z]:[\\\/]|^\\\\/)) {
        return ref; // Absolute path (Windows drive or UNC)
      }
      // WORKSPACE:path format (not Windows drive like C:)
      if (ref.match(/^[A-Za-z][A-Za-z0-9_-]*:/) && !ref.match(/^[a-zA-Z]:[\\\/]/)) {
        const colonIdx = ref.indexOf(':');
        const ws = ref.substring(0, colonIdx);
        const path = ref.substring(colonIdx + 1);
        return { space: ws, filePath: path };
      }
      return null;
    }).filter(Boolean);
    
    // Combine all unique refs
    const allHashIds = [...new Set([...extracted.hashIds, ...mcpRefs.hashIds])];
    const allSpacePaths = [...extracted.spacePaths, ...mcpRefs.spacePaths];
    const allAbsolutePaths = [...extracted.absolutePaths, ...mcpRefs.absolutePaths];
    
    // Add explicit refs to appropriate arrays
    for (const ref of parsedExplicitRefs) {
      if (typeof ref === 'string') {
        if (/^[a-f0-9]{32}$/i.test(ref)) {
          if (!allHashIds.includes(ref)) allHashIds.push(ref);
        } else {
          // Absolute path
          if (!allAbsolutePaths.includes(ref)) allAbsolutePaths.push(ref);
        }
      } else {
        const exists = allSpacePaths.some(p => p.space === ref.space && p.filePath === ref.filePath);
        if (!exists) allSpacePaths.push(ref);
      }
    }
    
    // Resolve and fetch files if any found
    let enhancedPrompt = prompt;
    let resolvedFiles = [];
    let resolutionErrors = [];
    
    const totalRefs = allHashIds.length + allSpacePaths.length + allAbsolutePaths.length;
    if (totalRefs > 0 || mcpRefs.embedded.length > 0) {
      if (!spaceResolver) {
        return {
          content: [{ 
            type: 'text', 
            text: '❌ Error: File references detected but space configuration not available. Please configure spaces in config.json.' 
          }],
          isError: true
        };
      }
      
      checkTimeout();
      
      const hashResults = allHashIds.length > 0 
        ? await resolveFiles(allHashIds, spaceResolver, codeSearch)
        : { files: [], errors: [] };
      
      checkTimeout();
      
      const pathResults = allSpacePaths.length > 0
        ? await resolveFiles(allSpacePaths, spaceResolver, codeSearch)
        : { files: [], errors: [] };
      
      checkTimeout();
      
      const absResults = allAbsolutePaths.length > 0
        ? await resolveFiles(allAbsolutePaths, spaceResolver, codeSearch)
        : { files: [], errors: [] };
      
      resolvedFiles = [...hashResults.files, ...pathResults.files, ...absResults.files];
      resolutionErrors = [...hashResults.errors, ...pathResults.errors, ...absResults.errors];
      
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
    
    // Build result with metadata about resolved files
    const result = {
      response: response || '(No response generated)',
      meta: {
        filesIncluded: resolvedFiles.length,
        embeddedResources: mcpRefs.embedded.length,
        files: resolvedFiles.map(f => ({ path: f.path, size: f.size })),
        errors: resolutionErrors.length > 0 ? resolutionErrors : undefined
      }
    };
    
    return { 
      content: [{ 
        type: 'text', 
        text: result.response 
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

export function createLLMServer(config, router, spaceConfig, codeSearch) {
  const spaceResolver = spaceConfig ? new SpaceResolver(spaceConfig) : null;
  
  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    
    async callTool(name, args) {
      try {
        if (name === 'query_model') return await queryModel(router, config, spaceResolver, codeSearch, args);
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }], isError: true };
      }
    },
    
    cleanup: async () => {}
  };
}
