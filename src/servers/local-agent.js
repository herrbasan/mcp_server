import fs from 'fs/promises';
import path from 'path';
import { WorkspaceResolver } from '../lib/workspace.js';

/**
 * Local Agent Server - Autonomous LLM agent with file access to remote workspaces
 * Enables Claude to delegate code analysis to local models via UNC paths
 */
export class LocalAgentServer {
  constructor(config, llmRouter) {
    this.router = llmRouter;
    this.workspace = new WorkspaceResolver(config.workspaces || {});
    this.maxTokenBudget = config.maxTokenBudget || 50000;
    this.maxIterations = config.maxIterations || 20;
    this.agentModel = config.model || null;
    this.toolCallingFormat = config.toolCallingFormat || 'json-in-prompt';
    this.codeSearch = null; // Set via setCodeSearchServer() after construction
    this.progressCallback = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback({ progress, total, message });
    }
  }

  setCodeSearchServer(codeSearchServer) {
    this.codeSearch = codeSearchServer;
  }

  getPrompts() {
    return [
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
  }

  async getPrompt(name, args) {
    if (name === 'deep-code-audit') {
      return {
        messages: [
          {
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
- **Parallel work**: Agent runs while you implement fixes

**Creative uses:**
- Chain multiple agents: First finds issues, second proposes refactors, third validates fixes
- Combine with memory: Store findings as anti_patterns for future reference
- Use for learning: Ask agent to explain unfamiliar patterns it discovers`
            }
          }
        ]
      };
    }

    if (name === 'architecture-map') {
      return {
        messages: [
          {
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
2. You store key insights in memory: \`remember(text="PROJECT: ${args.component} — <agent findings>", category="context")\`
3. Use \`retrieve_file\` to get full source of critical files agent identified
4. Ask agent follow-up questions: "How does X handle Y?" with more focused task

**Creative insight:** Agent can read your entire codebase in minutes, finding connections you'd miss. It's like having a junior dev who's already read everything.`
            }
          }
        ]
      };
    }

    if (name === 'agent-research') {
      return {
        messages: [
          {
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

2. **While agent runs**, you can:
   - Work on other features
   - Review existing code
   - Write documentation
   - Plan implementation

3. **When agent returns**:
   - Review findings
   - Retrieve full files: \`retrieve_file(path="${args.workspace}", filePath="<agent-suggested-file>")\`
   - Store discoveries: \`remember(text="PROJECT: ${args.workspace.split('\\\\').pop()} — ${args.question}: <answer>", category="context")\`

**Power combinations:**
- Agent + Memory: Build a knowledge base of your codebase over time
- Agent + Code Search: Agent finds areas, you search for similar patterns elsewhere
- Multiple Agents: Run parallel research tasks on different aspects
- Agent + Browser: Agent reads code, you research external docs simultaneously

**Think of the agent as:** Your AI pair programmer who can read the entire codebase in seconds, never gets tired, and works while you focus on creative problem-solving.`
            }
          }
        ]
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  }

  getTools() {
    return [
      {
        name: 'run_local_agent',
        description: 'AUTONOMOUS CODE EXPLORATION: Agent running on orchestrator server (separate from you) that explores codebases independently using a configured LLM (could be local like LMStudio/Ollama or cloud like Gemini/OpenAI - see config.llm.taskDefaults.agent). You provide a TASK DESCRIPTION (not file paths), and the agent decides what to search for, which files to read, and when it has enough information. Agent workflow: (1) Searches semantically/by keyword based on your task, (2) Reads relevant files (up to 50k tokens), (3) Re-searches if needed, (4) Returns TEXT SUMMARY only (no code). Use for: "Find memory leaks", "Explain how authentication works", "Check for race conditions". Agent can read thousands of lines of code without polluting YOUR context - you only see the final analysis. Think of it as delegating research to a junior dev who reads the entire codebase and briefs you.',
        inputSchema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'WHAT you want to know, not HOW to find it. Agent autonomously decides search strategy, file selection, and iteration depth. Examples: "Find memory leaks - look for buffers that are allocated but never freed", "Explain the WebSocket connection lifecycle", "Check for SQL injection vulnerabilities". More detailed tasks = better results.'
            },
            path: {
              type: 'string',
              description: 'Local path to workspace (e.g., D:\\Work\\_GIT\\SoundApp, D:\\DEV\\mcp_server)'
            },
            machine: {
              type: 'string',
              description: 'Machine name (optional, uses default from config if not specified)'
            },
            maxTokens: {
              type: 'number',
              description: 'Token budget for file reads (default: 50000). Higher = more thorough analysis.'
            }
          },
          required: ['task', 'path']
        }
      },
      {
        name: 'retrieve_file',
        description: 'Get file content using file ID from search results. SUPPORTS PARTIAL RETRIEVAL - use startLine/endLine to fetch only the lines you need (saves massive tokens). Optimal workflow: search_semantic → get_file_info (see function at line X) → retrieve_file (startLine=X, endLine=X+50). File IDs format: "workspace:path" (e.g., "BADKID-DEV:src/http-server.js"). Returns: content, total_lines, retrieved_lines, start_line, end_line, size.',
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
  }

  handlesTool(name) {
    return name === 'run_local_agent' || name === 'retrieve_file';
  }

  async callTool(name, args) {
    if (name === 'retrieve_file') {
      return this._retrieveFile(args);
    }
    
    if (name !== 'run_local_agent') {
      throw new Error(`Unknown tool: ${name}`);
    }

    const { task, path: localPath, machine = null, maxTokens = this.maxTokenBudget } = args;

    try {
      this.sendProgress(5, 100, 'Resolving workspace path...');
      
      // Resolve local path to UNC for file access
      const uncPath = this.workspace.resolvePath(localPath, machine);
      const allowedShares = this.workspace.getAllowedShares(machine);
      
      this.sendProgress(10, 100, 'Validating path access...');
      
      // Validate path is accessible and within allowed shares
      await this.workspace.validateResolvedPath(uncPath, allowedShares);

      this.sendProgress(15, 100, 'Initializing agent...');

      // Run agent loop with timeout (5 minutes max)
      // Pass both localPath (for index lookup) and uncPath (for file operations)
      const timeoutMs = 5 * 60 * 1000;
      const result = await Promise.race([
        this._runAgentLoop(task, uncPath, allowedShares, maxTokens, localPath, machine),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Agent timeout after 5 minutes')), timeoutMs)
        )
      ]);

      this.sendProgress(100, 100, 'Complete');

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (err) {
      console.error('[Agent] Error in callTool:', err);
      this.sendProgress(100, 100, 'Error');
      
      // Ensure we always return a valid response, never throw
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            code: err.code || 'AGENT_ERROR',
            stack: err.stack?.split('\n').slice(0, 5).join('\n') // First 5 lines of stack
          }, null, 2)
        }]
      };
    }
  }

  async _retrieveFile(args) {
    const { file, startLine, endLine } = args;

    try {
      // Parse file ID using workspace resolver
      const uncPath = this.workspace.resolveFileId(file);
      const { workspace } = this.workspace.parseFileId(file);
      
      // Validate file path is accessible
      await this.workspace.validatePath(uncPath, workspace);

      // Read file
      const content = await fs.readFile(uncPath, 'utf-8');
      const lines = content.split('\n');
      
      // Handle partial retrieval
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

  async _runAgentLoop(task, basePath, allowedShares, maxTokens, localPath, machine) {
    // Context object - passed explicitly to all functions
    const ctx = {
      basePath,        // UNC path for file operations
      localPath,       // Local path for index lookup
      machine,         // Machine name for workspace resolution
      allowedShares,   // Security: allowed UNC shares
      maxTokens,       // Token budget
      maxIterations: this.maxIterations
    };

    // Step 1: Tool Selection (indexed OR basic)
    const tools = await this._selectTools(ctx);

    // Step 2: Initialize conversation
    const systemPrompt = this._buildSystemPrompt(tools, ctx.basePath);
    let messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task }
    ];
    let tokensUsed = 0;

    // JSON Schema for tool calls - enforced at token level via llama.cpp grammar
    const toolCallSchema = {
      type: 'json_schema',
      json_schema: {
        name: 'tool_call',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            args: { type: 'object' }
          },
          required: ['tool', 'args']
        }
      }
    };

    // Step 3: Agent loop
    for (let iteration = 1; iteration <= ctx.maxIterations; iteration++) {
      this.sendProgress(20 + (iteration / ctx.maxIterations) * 70, 100, `Iteration ${iteration}/${ctx.maxIterations}`);

      // 3a: LLM call with structured output (guaranteed valid JSON)
      const prompt = messages.slice(1).map(m => `${m.role}: ${m.content}`).join('\n\n');
      const llmResponse = await this.router.predict({
        systemPrompt: messages[0].content,
        prompt,
        taskType: 'agent',
        model: this.agentModel,
        maxTokens: 2000,
        responseFormat: toolCallSchema
      });

      // 3b: Parse response - should always be valid JSON now
      const toolCall = this._parseToolCall(llmResponse);
      if (!toolCall) {
        return { error: 'INVALID_TOOL_CALL', response: llmResponse, iteration };
      }

      // 3c: Handle 'done'
      if (toolCall.tool === 'done') {
        return { success: true, result: toolCall.args.summary, iterations: iteration, tokensUsed };
      }

      // 3d: Execute tool (pure function - all context in params)
      const { result, tokens } = await this._executeTool(toolCall, tools, ctx);
      tokensUsed += tokens;

      // 3e: Append to messages
      messages = [
        ...messages,
        { role: 'assistant', content: llmResponse },
        { role: 'user', content: `Tool result:\n${JSON.stringify(result, null, 2)}` }
      ];

      // 3f: Check budget
      if (tokensUsed > ctx.maxTokens) {
        return { error: 'TOKEN_BUDGET_EXCEEDED', tokensUsed, budget: ctx.maxTokens, iteration };
      }
    }

    return { error: 'MAX_ITERATIONS_REACHED', iterations: ctx.maxIterations };
  }

  // Pure function: localPath + machine → Tool[]
  async _selectTools(ctx) {
    if (!this.codeSearch) return this._getBasicTools();
    
    const stats = await this.codeSearch.callTool('get_index_stats', { path: ctx.localPath, machine: ctx.machine });
    const parsed = JSON.parse(stats.content?.[0]?.text || '{}');
    return parsed.exists ? this._getSearchTools() : this._getBasicTools();
  }

  _getBasicTools() {
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

  _getSearchTools() {
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

  _buildSystemPrompt(tools, basePath) {
    const toolsJson = JSON.stringify(tools, null, 2);
    return `You are a code analysis agent with file access to: ${basePath}

Available tools:
${toolsJson}

Rules:
1. Each response MUST be valid JSON: {"tool": "name", "args": {...}}
2. Use search tools first, read files only when needed
3. Call "done" when you have the answer
4. Stay focused on the user's specific question

Example: {"tool": "search_keyword", "args": {"pattern": "SharedArrayBuffer"}}`;
  }

  _parseToolCall(content) {
    try {
      // Extract JSON by finding balanced braces
      const firstBrace = content.indexOf('{');
      if (firstBrace === -1) {
        return null;
      }

      // Find matching closing brace
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

      if (jsonEnd === -1) {
        return null;
      }

      const jsonStr = content.slice(firstBrace, jsonEnd);
      const parsed = JSON.parse(jsonStr);
      
      if (!parsed.tool || !parsed.args) {
        return null;
      }

      return { tool: parsed.tool, args: parsed.args };
    } catch (e) {
      return null;
    }
  }

  // Pure function: (toolCall, tools, ctx) → { result, tokens }
  async _executeTool(toolCall, tools, ctx) {
    const { tool, args } = toolCall;

    // Search tools (use localPath for index)
    if (['search_semantic', 'search_keyword', 'search_files'].includes(tool)) {
      const result = await this._executeSearchTool(tool, args, ctx);
      return { result, tokens: 0 };  // Search is cheap
    }

    // File tools (use basePath/UNC for file access)
    switch (tool) {
      case 'list_dir': {
        const result = await this._listDir(args.path, ctx);
        return { result, tokens: 0 };
      }
      case 'read_file': {
        const { result, tokens } = await this._readFile(args.path, args.startLine, args.endLine, ctx);
        return { result, tokens };
      }
      case 'grep': {
        const result = await this._grep(args.pattern, args.path, args.regex, ctx);
        return { result, tokens: 0 };
      }
      case 'find_files': {
        const result = await this._findFiles(args.glob, ctx);
        return { result, tokens: 0 };
      }
      default:
        return { result: { error: `Unknown tool: ${tool}` }, tokens: 0 };
    }
  }

  // Pure function: (tool, args, ctx) → result
  async _executeSearchTool(tool, args, ctx) {
    if (!this.codeSearch) {
      return { error: 'Code search not available' };
    }

    const searchArgs = { ...args, path: ctx.localPath, machine: ctx.machine };
    const result = await this.codeSearch.callTool(`search_${tool.split('_')[1]}`, searchArgs);
    return JSON.parse(result.content[0].text);
  }

  // Pure function: (relativePath, ctx) → result
  async _listDir(relativePath, ctx) {
    const fullPath = path.join(ctx.basePath, relativePath || '.');
    await this.workspace.validateResolvedPath(fullPath, ctx.allowedShares);

    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return {
      files: entries.filter(e => e.isFile()).map(e => e.name),
      dirs: entries.filter(e => e.isDirectory()).map(e => e.name),
      path: relativePath || '.'
    };
  }

  // Pure function: (relativePath, startLine, endLine, ctx) → { result, tokens }
  async _readFile(relativePath, startLine, endLine, ctx) {
    const fullPath = path.join(ctx.basePath, relativePath);
    await this.workspace.validateResolvedPath(fullPath, ctx.allowedShares);

    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Handle line range
    const start = (startLine || 1) - 1;
    const end = endLine || lines.length;
    const selectedLines = lines.slice(start, end);
    const resultContent = selectedLines.join('\n');
    
    // Estimate tokens (1 token ≈ 4 chars)
    const tokens = Math.ceil(resultContent.length / 4);

    return {
      result: { content: resultContent, lineCount: lines.length, linesRead: selectedLines.length },
      tokens
    };
  }

  // Pure function: (pattern, relativePath, isRegex, ctx) → result
  async _grep(pattern, relativePath, isRegex, ctx) {
    const searchPath = relativePath ? path.join(ctx.basePath, relativePath) : ctx.basePath;
    await this.workspace.validateResolvedPath(searchPath, ctx.allowedShares);

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

  // Pure function: (globPattern, ctx) → result
  async _findFiles(globPattern, ctx) {
    await this.workspace.validateResolvedPath(ctx.basePath, ctx.allowedShares);

    const matches = [];
    const regex = this._globToRegex(globPattern);
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

  _globToRegex(glob) {
    const pattern = glob.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${pattern}$`, 'i');
  }
}
