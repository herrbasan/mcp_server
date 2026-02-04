/**
 * Local Agent Server - Autonomous LLM agent with file access to remote workspaces
 * Enables Claude to delegate code analysis to local models via UNC paths
 */

import fs from 'fs/promises';
import path from 'path';
import { WorkspaceResolver } from '../lib/workspace.js';

// ========== PURE HELPERS ==========

function globToRegex(glob) {
  const pattern = glob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i');
}

function parseToolCall(content) {
  try {
    const firstBrace = content.indexOf('{');
    if (firstBrace === -1) return null;

    let braceCount = 0;
    let jsonEnd = -1;
    for (let i = firstBrace; i < content.length; i++) {
      if (content[i] === '{') braceCount++;
      if (content[i] === '}') braceCount--;
      if (braceCount === 0) {
        jsonEnd = i + 1;
        break;
      }
    }

    if (jsonEnd === -1) return null;

    const jsonStr = content.slice(firstBrace, jsonEnd);
    const parsed = JSON.parse(jsonStr);
    
    if (!parsed.tool || !parsed.args) return null;
    return { tool: parsed.tool, args: parsed.args };
  } catch (e) {
    return null;
  }
}

function buildSystemPrompt(tools, basePath) {
  const toolsJson = JSON.stringify(tools, null, 2);
  return `You are a code analysis agent with file access to: ${basePath}

Available tools:
${toolsJson}

Rules:
1. Each response MUST be valid JSON: {"tool": "name", "args": {...}}
2. Use search tools first, read files only when needed
3. When reading files, use the FULL path from search results INCLUDING the workspace prefix (e.g., "BADKID-DEV:mcp_server/src/file.js")
4. Call "done" IMMEDIATELY when you have enough information to answer the question - do not over-research
5. Stay focused on the user's specific question - answer it directly

IMPORTANT: Once you have the answer, call done right away. Do not keep searching or reading more files.

Example search: {"tool": "search_keyword", "args": {"pattern": "SharedArrayBuffer"}}
Example read: {"tool": "read_file", "args": {"path": "BADKID-DEV:mcp_server/src/http-server.js"}}
Example done: {"tool": "done", "args": {"summary": "The parseToolCall function extracts JSON tool calls from LLM responses by finding matching braces."}}`;
}

function getBasicTools() {
  return [
    {
      name: 'list_dir',
      description: 'List files and directories in a path',
      parameters: {
        path: { type: 'string', description: 'Path relative to workspace root (use "." for root)' }
      }
    },
    {
      name: 'read_file',
      description: 'Read file content. Counts against token budget.',
      parameters: {
        path: { type: 'string', description: 'Path relative to workspace root' },
        startLine: { type: 'number', description: 'Optional: start line (1-indexed)' },
        endLine: { type: 'number', description: 'Optional: end line (1-indexed)' }
      }
    },
    {
      name: 'grep',
      description: 'Search for pattern in files. Recursive by default.',
      parameters: {
        pattern: { type: 'string', description: 'Search pattern' },
        path: { type: 'string', description: 'Optional: limit to path (default: workspace root)' },
        regex: { type: 'boolean', description: 'Optional: treat pattern as regex (default: false)' }
      }
    },
    {
      name: 'find_files',
      description: 'Find files matching glob pattern',
      parameters: {
        glob: { type: 'string', description: 'Glob pattern (e.g., "*.js", "src/**/*.ts")' }
      }
    },
    {
      name: 'done',
      description: 'Complete the task and return summary',
      parameters: {
        summary: { type: 'string', description: 'Summary of findings (no code, just analysis)' }
      }
    }
  ];
}

function getSearchTools() {
  return [
    {
      name: 'search_semantic',
      description: 'Semantic search using embeddings - finds code by meaning, not keywords',
      parameters: {
        query: { type: 'string', description: 'What to search for (e.g., "authentication logic")' },
        limit: { type: 'number', description: 'Max results (default: 10)' }
      }
    },
    {
      name: 'search_keyword',
      description: 'Fast keyword/regex search across all files',
      parameters: {
        pattern: { type: 'string', description: 'Search pattern' },
        regex: { type: 'boolean', description: 'Treat as regex (default: false)' }
      }
    },
    {
      name: 'search_files',
      description: 'Find files by name/path pattern',
      parameters: {
        glob: { type: 'string', description: 'Glob pattern (e.g., "*auth*.js")' }
      }
    },
    {
      name: 'read_file',
      description: 'Read file content. Counts against token budget.',
      parameters: {
        path: { type: 'string', description: 'Path relative to workspace root' },
        startLine: { type: 'number', description: 'Optional: start line (1-indexed)' },
        endLine: { type: 'number', description: 'Optional: end line (1-indexed)' }
      }
    },
    {
      name: 'done',
      description: 'Complete the task and return summary',
      parameters: {
        summary: { type: 'string', description: 'Summary of findings (no code, just analysis)' }
      }
    }
  ];
}

// ========== PROMPTS ==========

const PROMPTS = [
  {
    name: 'deep-code-audit',
    description: 'Run autonomous agent to audit code for security, performance, or architectural issues',
    arguments: [
      { name: 'focus', description: 'What to audit (e.g., "memory leaks", "SQL injection risks", "race conditions")', required: true },
      { name: 'workspace', description: 'Workspace path', required: true }
    ]
  },
  {
    name: 'architecture-map',
    description: 'Let the agent explore and explain system architecture autonomously',
    arguments: [
      { name: 'component', description: 'Component or module to map (e.g., "authentication system", "data pipeline")', required: true },
      { name: 'workspace', description: 'Workspace path', required: true }
    ]
  },
  {
    name: 'agent-research',
    description: 'Delegate complex code research to local agent while you work on other tasks',
    arguments: [
      { name: 'question', description: 'Research question (e.g., "How does error propagation work in this codebase?")', required: true },
      { name: 'workspace', description: 'Workspace path', required: true }
    ]
  }
];

const PROMPT_NAMES = new Set(PROMPTS.map(p => p.name));

function getPrompt(name, args) {
  if (name === 'deep-code-audit') {
    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Audit ${args.workspace} for: ${args.focus}

**Autonomous Agent Strategy:**

\`\`\`
run_local_agent(
  task="Find ${args.focus} in this codebase. For each issue:
  1. Identify the problematic pattern
  2. Locate all instances (file + line numbers)
  3. Assess severity (critical/high/medium/low)
  4. Suggest concrete fixes
  
  Search strategy:
  - Use semantic search for conceptual patterns
  - Use keyword search for known dangerous functions
  - Read actual source code to validate findings
  - Cross-reference across files for systemic issues
  
  Return structured summary with prioritized recommendations.",
  path="${args.workspace}",
  maxTokens=50000
)
\`\`\`

**Why delegate to agent:**
- **Saves your context**: Agent reads thousands of lines without polluting your conversation
- **Autonomous iteration**: Agent can search, read, re-search based on findings
- **Local LLM privacy**: Code never leaves the network
- **Parallel work**: Agent runs while you implement fixes`
        }
      }]
    };
  }

  if (name === 'architecture-map') {
    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Map the architecture of "${args.component}" in ${args.workspace}

**Agent Exploration Pattern:**

\`\`\`
run_local_agent(
  task="Explore and document the architecture of ${args.component}:
  
  Phase 1 - Discovery:
  - Search for entry points and main files
  - Identify key classes/functions
  - Map file organization
  
  Phase 2 - Dependency Analysis:
  - Find what ${args.component} depends on
  - Find what depends on ${args.component}
  - Trace data flow through the system
  
  Phase 3 - Pattern Recognition:
  - Identify design patterns used
  - Note architectural decisions
  - Flag potential issues or anti-patterns
  
  Phase 4 - Documentation:
  - Create component diagram (text-based)
  - List responsibilities of each module
  - Explain key interactions
  
  Use search tools aggressively, read actual code to validate assumptions.",
  path="${args.workspace}",
  maxTokens=50000
)
\`\`\`

**Follow-up workflow:**
1. Agent returns architecture summary
2. You store key insights in memory
3. Use retrieve_file to get full source of critical files
4. Ask agent follow-up questions with more focused tasks`
        }
      }]
    };
  }

  if (name === 'agent-research') {
    return {
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Research question: "${args.question}" in ${args.workspace}

**Parallel Research Workflow:**

1. **Delegate to agent** (runs autonomously):
\`\`\`
run_local_agent(
  task="${args.question}
  
  Research approach:
  - Use semantic search to find relevant code
  - Read actual implementations
  - Cross-reference multiple files
  - Look for patterns and edge cases
  - Provide concrete examples from the code
  
  Answer with:
  - Direct answer to the question
  - File locations and line numbers
  - Code examples (small snippets only)
  - Related patterns worth investigating",
  path="${args.workspace}",
  maxTokens=50000
)
\`\`\`

2. **When agent returns**: Review findings, retrieve full files as needed`
        }
      }]
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}

// ========== TOOLS ==========

const TOOLS = [
  {
    name: 'run_local_agent',
    description: 'AUTONOMOUS CODE EXPLORATION: Delegate complex codebase exploration to separate LLM agent that runs independently. Agent reads files/searches autonomously (up to 50k tokens) and returns TEXT SUMMARY only - saves YOUR context! WHEN TO USE: Complex tasks requiring multiple files, unclear where to start, need high-level architecture understanding. DON\'T USE: Simple 1-2 file questions (use inspect_code), need actual code (use retrieve_file), function-level detail (use get_file_info). EXAMPLES: "Find all memory leaks", "Explain authentication flow across modules", "Identify race conditions in server code". Think: delegating research to junior dev who briefs you after reading everything.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'WHAT you want to know, not HOW to find it. Agent autonomously decides search strategy, file selection, and iteration depth. Examples: "Find memory leaks - look for buffers that are allocated but never freed", "Explain the WebSocket connection lifecycle", "Check for SQL injection vulnerabilities". More detailed tasks = better results.'
        },
        workspace: {
          type: 'string',
          description: 'Workspace name (e.g., "BADKID-DEV", "COOLKID-Work"). Use get_workspace_config to see available workspaces.'
        },
        maxTokens: {
          type: 'number',
          description: 'Token budget for file reads (default: 50000). Higher = more thorough analysis.'
        }
      },
      required: ['task', 'workspace']
    }
  },
  {
    name: 'inspect_code',
    description: 'Quick code analysis shortcut - retrieves file(s) and asks LLM a question. Saves YOUR context tokens by delegating file retrieval + LLM call to server. Router handles context window management/compaction automatically. WHEN TO USE: Quick focused questions on 1-3 files. HOW TO USE: Single file "src/file.js" or multiple "file1.js, file2.js". DON\'T USE FOR: Complex exploration (use run_local_agent), single function analysis (use get_file_info + retrieve_file with line numbers for better token efficiency).',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'File path(s) to analyze. Formats: "src/file.js" (single), "file1.js, file2.js" (multiple comma-separated). Can include workspace prefix like "BADKID-DEV:src/file.js" or be relative to workspace root.'
        },
        question: {
          type: 'string',
          description: 'Question to ask about the code. Examples: "Are there any bugs?", "Check for performance issues", "Suggest improvements", "Review for edge cases".'
        },
        workspace: {
          type: 'string',
          description: 'Workspace name (e.g., "BADKID-DEV", "COOLKID-Work").'
        }
      },
      required: ['target', 'question', 'workspace']
    }
  },
  {
    name: 'retrieve_file',
    description: 'Get file content - ALWAYS use partial retrieval (startLine/endLine) to save tokens. File IDs from search use "workspace:path" format. BEST PRACTICE: (1) search_semantic to find relevant files, (2) get_file_info to see function locations with line numbers, (3) retrieve_file with startLine/endLine to fetch only needed functions. Example: Function at line 245? Use startLine=245, endLine=280 to get ~35 lines instead of entire file. Token savings: 50-500x for large files!',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File ID from search results (e.g., "BADKID-DEV:src/http-server.js", "COOLKID-Work:project/index.ts")'
        },
        startLine: {
          type: 'number',
          description: 'Start line (1-indexed, inclusive). Use with get_file_info function line numbers to fetch specific functions. Omit to read from beginning.'
        },
        endLine: {
          type: 'number',
          description: 'End line (1-indexed, inclusive). Omit to read to end. Example: if function is at line 245, use startLine=245, endLine=280 to get just that function.'
        }
      },
      required: ['file']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

// ========== FACTORY FUNCTION ==========

export function createLocalAgentServer(config, router) {
  const workspace = new WorkspaceResolver(config.workspaces || {});
  const maxTokenBudget = config.maxTokenBudget || 50000;
  const maxIterations = config.maxIterations || 20;
  const agentModel = config.model || null;
  let codeSearch = null;
  let progressCallback = null;

  function sendProgress(progress, total, message) {
    if (progressCallback) {
      progressCallback({ progress, total, message });
    }
  }

  // ========== FILE OPERATIONS ==========

  async function listDir(relativePath, ctx) {
    const fullPath = path.join(ctx.basePath, relativePath || '.');
    await workspace.validatePath(fullPath, ctx.workspace);

    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return {
      files: entries.filter(e => e.isFile()).map(e => e.name),
      dirs: entries.filter(e => e.isDirectory()).map(e => e.name),
      path: relativePath || '.'
    };
  }

  async function readFile(relativePath, startLine, endLine, ctx) {
    const fullPath = path.join(ctx.basePath, relativePath);
    await workspace.validatePath(fullPath, ctx.workspace);

    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    const start = (startLine || 1) - 1;
    const end = endLine || lines.length;
    const selectedLines = lines.slice(start, end);
    const resultContent = selectedLines.join('\n');
    
    const tokens = Math.ceil(resultContent.length / 4);

    return {
      result: { content: resultContent, lineCount: lines.length, linesRead: selectedLines.length },
      tokens
    };
  }

  async function grep(pattern, relativePath, isRegex, ctx) {
    const searchPath = relativePath ? path.join(ctx.basePath, relativePath) : ctx.basePath;
    await workspace.validatePath(searchPath, ctx.workspace);

    const matches = [];
    const regex = isRegex ? new RegExp(pattern, 'gi') : null;
    const limits = { maxFiles: 500, maxMatches: 50, maxFileSize: 100 * 1024 };
    const skipExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', 
      '.mp3', '.mp4', '.wav', '.ogg', '.zip', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib', 
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.psd', '.ai']);
    const skipDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '__pycache__']);
    
    let filesScanned = 0;
    let stopped = false;

    const walkDir = async (dir) => {
      if (stopped) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      
      for (const entry of entries) {
        if (stopped || filesScanned >= limits.maxFiles || matches.length >= limits.maxMatches) {
          stopped = true;
          return;
        }
        
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) await walkDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (skipExt.has(ext)) continue;
          
          filesScanned++;
          const stat = await fs.stat(fullPath).catch(() => null);
          if (!stat || stat.size > limits.maxFileSize) continue;
          
          const content = await fs.readFile(fullPath, 'utf-8').catch(() => null);
          if (!content) continue;
          
          content.split('\n').forEach((line, idx) => {
            if (matches.length >= limits.maxMatches) return;
            if (regex ? regex.test(line) : line.includes(pattern)) {
              matches.push({
                file: path.relative(ctx.basePath, fullPath),
                line: idx + 1,
                content: line.trim().slice(0, 200)
              });
            }
          });
        }
      }
    };

    await walkDir(searchPath);
    return { matches, count: matches.length, filesScanned, stopped };
  }

  async function findFiles(globPattern, ctx) {
    await workspace.validatePath(ctx.basePath, ctx.workspace);

    const matches = [];
    const regex = globToRegex(globPattern);
    const limits = { maxDirs: 200, maxMatches: 100 };
    const skipDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'build']);
    
    let dirsScanned = 0;
    let stopped = false;

    const walkDir = async (dir) => {
      if (stopped || matches.length >= limits.maxMatches || dirsScanned >= limits.maxDirs) {
        stopped = true;
        return;
      }
      dirsScanned++;
      
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      
      for (const entry of entries) {
        if (stopped || matches.length >= limits.maxMatches) return;
        
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(ctx.basePath, fullPath);

        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) await walkDir(fullPath);
        } else if (entry.isFile()) {
          if (regex.test(relativePath.replace(/\\/g, '/'))) {
            matches.push(relativePath);
          }
        }
      }
    };

    await walkDir(ctx.basePath);
    return { matches, count: matches.length, stopped };
  }

  // ========== SEARCH TOOLS ==========

  async function executeSearchTool(tool, args, ctx) {
    if (!codeSearch) {
      return { error: 'Code search not available' };
    }

    const searchArgs = { ...args, workspace: ctx.workspace };
    const result = await codeSearch.callTool(`search_${tool.split('_')[1]}`, searchArgs);
    return JSON.parse(result.content[0].text);
  }

  async function selectTools(ctx) {
    if (!codeSearch) return getBasicTools();
    
    const stats = await codeSearch.callTool('get_index_stats', { workspace: ctx.workspace });
    const parsed = JSON.parse(stats.content?.[0]?.text || '{}');
    return parsed.exists ? getSearchTools() : getBasicTools();
  }

  // ========== TOOL EXECUTION ==========

  async function executeTool(toolCall, tools, ctx) {
    const { tool, args } = toolCall;

    if (['search_semantic', 'search_keyword', 'search_files'].includes(tool)) {
      const result = await executeSearchTool(tool, args, ctx);
      return { result, tokens: 0 };
    }

    switch (tool) {
      case 'list_dir': {
        const result = await listDir(args.path, ctx);
        return { result, tokens: 0 };
      }
      case 'read_file': {
        let filePath = args.path;
        if (filePath && filePath.includes(':')) {
          const parts = filePath.split(':');
          if (parts.length === 2 && parts[0] === ctx.workspace) {
            filePath = parts[1];
          }
        }
        const { result, tokens } = await readFile(filePath, args.startLine, args.endLine, ctx);
        return { result, tokens };
      }
      case 'grep': {
        const result = await grep(args.pattern, args.path, args.regex, ctx);
        return { result, tokens: 0 };
      }
      case 'find_files': {
        const result = await findFiles(args.glob, ctx);
        return { result, tokens: 0 };
      }
      default:
        return { result: { error: `Unknown tool: ${tool}` }, tokens: 0 };
    }
  }

  // ========== AGENT LOOP ==========

  async function runAgentLoop(task, uncPath, workspaceName, maxTokens) {
    const ctx = {
      basePath: uncPath,
      workspace: workspaceName,
      maxTokens,
      maxIterations
    };

    const tools = await selectTools(ctx);

    const systemPrompt = buildSystemPrompt(tools, ctx.basePath);
    let messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task }
    ];
    let tokensUsed = 0;

    const toolCallSchema = {
      type: 'object',
      properties: {
        tool: { type: 'string' },
        args: { type: 'object' }
      },
      required: ['tool', 'args']
    };

    for (let iteration = 1; iteration <= ctx.maxIterations; iteration++) {
      sendProgress(20 + (iteration / ctx.maxIterations) * 70, 100, `Iteration ${iteration}/${ctx.maxIterations}`);

      const prompt = messages.slice(1).map(m => `${m.role}: ${m.content}`).join('\n\n');
      const llmResponse = await router.predict({
        systemPrompt: messages[0].content,
        prompt,
        model: agentModel,
        maxTokens: 2000,
        responseFormat: toolCallSchema,
        taskType: 'agent' // Use agent provider without compaction
      });

      const toolCall = parseToolCall(llmResponse);
      if (!toolCall) {
        return { error: 'INVALID_TOOL_CALL', response: llmResponse, iteration };
      }

      if (toolCall.tool === 'done') {
        return { success: true, result: toolCall.args.summary, iterations: iteration, tokensUsed };
      }

      const toolDesc = toolCall.tool === 'read_file' ? `Reading ${toolCall.args.path}` :
                       toolCall.tool === 'search_semantic' ? `Searching: ${toolCall.args.query}` :
                       toolCall.tool === 'search_keyword' ? `Finding: ${toolCall.args.pattern}` :
                       toolCall.tool === 'list_dir' ? `Listing ${toolCall.args.path || 'root'}` :
                       toolCall.tool === 'grep' ? `Grepping: ${toolCall.args.pattern}` :
                       toolCall.tool === 'find_files' ? `Finding files: ${toolCall.args.glob}` :
                       `Using ${toolCall.tool}`;
      sendProgress(20 + (iteration / ctx.maxIterations) * 70, 100, `${toolDesc} (${tokensUsed}/${ctx.maxTokens} tokens)`);

      const { result, tokens } = await executeTool(toolCall, tools, ctx);
      tokensUsed += tokens;

      messages = [
        ...messages,
        { role: 'assistant', content: llmResponse },
        { role: 'user', content: `Tool result:\n${JSON.stringify(result, null, 2)}` }
      ];

      if (tokensUsed > ctx.maxTokens) {
        return { error: 'TOKEN_BUDGET_EXCEEDED', tokensUsed, budget: ctx.maxTokens, iteration };
      }
    }

    return { error: 'MAX_ITERATIONS_REACHED', iterations: ctx.maxIterations };
  }

  // ========== TOOL HANDLERS ==========

  async function retrieveFile(args) {
    const { file, startLine, endLine } = args;

    try {
      const uncPath = workspace.resolveFileId(file);
      const { workspace: workspaceName } = workspace.parseFileId(file);
      
      await workspace.validatePath(uncPath, workspaceName);

      const content = await fs.readFile(uncPath, 'utf-8');
      const lines = content.split('\n');
      
      let retrievedContent;
      let actualStart = 1;
      let actualEnd = lines.length;
      
      if (startLine !== undefined || endLine !== undefined) {
        actualStart = Math.max(1, startLine || 1);
        actualEnd = Math.min(lines.length, endLine || lines.length);
        retrievedContent = lines.slice(actualStart - 1, actualEnd).join('\n');
      } else {
        retrievedContent = content;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            file_id: file,
            total_lines: lines.length,
            retrieved_lines: actualEnd - actualStart + 1,
            start_line: actualStart,
            end_line: actualEnd,
            size: retrievedContent.length,
            content: retrievedContent
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            code: err.code || 'RETRIEVE_ERROR',
            file_id: file
          }, null, 2)
        }]
      };
    }
  }

  async function inspectCode(args) {
    const { target, question, workspace: workspaceName } = args;

    try {
      // Parse target - can be single file, multiple comma-separated files, or array
      const targets = Array.isArray(target) 
        ? target 
        : target.split(',').map(t => t.trim());
      
      const uncPath = workspace.getWorkspacePath(workspaceName);
      const files = [];
      
      // Retrieve all files
      for (let filePath of targets) {
        // Strip workspace prefix if present (e.g., "BADKID-DEV:src/file.js" -> "src/file.js")
        if (filePath.includes(':')) {
          const parts = filePath.split(':');
          if (parts.length === 2 && parts[0] === workspaceName) {
            filePath = parts[1];
          }
        }
        
        const fullPath = path.join(uncPath, filePath);
        await workspace.validatePath(fullPath, workspaceName);
        
        const content = await fs.readFile(fullPath, 'utf-8');
        files.push({ path: filePath, content });
      }
      
      // Build prompt with all files
      let filesSection = files.map(f => 
        `File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
      ).join('\n\n');
      
      const prompt = `${filesSection}\n\nQuestion: ${question}\n\nProvide a concise answer.`;
      
      // Router handles context window management and compaction
      const answer = await router.predict({
        systemPrompt: 'You are a code analysis assistant. Answer questions about code concisely and accurately.',
        prompt,
        maxTokens: 1000,
        temperature: 0.3,
        taskType: 'agent'
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            files: files.map(f => f.path),
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
            target: args.target
          }, null, 2)
        }]
      };
    }
  }

  async function runLocalAgent(args) {
    const { task, workspace: workspaceName, maxTokens = maxTokenBudget } = args;

    try {
      sendProgress(5, 100, 'Resolving workspace path...');
      
      const uncPath = workspace.getWorkspacePath(workspaceName);
      
      sendProgress(10, 100, 'Validating path access...');
      
      await workspace.validatePath(uncPath, workspaceName);

      sendProgress(15, 100, 'Initializing agent...');

      const timeoutMs = 5 * 60 * 1000;
      const result = await Promise.race([
        runAgentLoop(task, uncPath, workspaceName, maxTokens),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Agent timeout after 5 minutes')), timeoutMs)
        )
      ]);

      sendProgress(100, 100, 'Complete');

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      console.error('[Agent] Error in callTool:', err);
      sendProgress(100, 100, 'Error');
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            code: err.code || 'AGENT_ERROR',
            stack: err.stack?.split('\n').slice(0, 5).join('\n')
          }, null, 2)
        }]
      };
    }
  }

  // ========== PUBLIC API ==========

  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    
    getPrompts: () => PROMPTS,
    handlesPrompt: name => PROMPT_NAMES.has(name),
    getPrompt: (name, args) => getPrompt(name, args),
    
    async callTool(name, args) {
      if (name === 'retrieve_file') return await retrieveFile(args);
      if (name === 'inspect_code') return await inspectCode(args);
      if (name === 'run_local_agent') return await runLocalAgent(args);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    },
    
    setProgressCallback: (callback) => { progressCallback = callback; },
    setCodeSearchServer: (server) => { codeSearch = server; },
    
    cleanup: async () => {}
  };
}

// Keep old export for backward compatibility during migration
export { createLocalAgentServer as LocalAgentServer };
