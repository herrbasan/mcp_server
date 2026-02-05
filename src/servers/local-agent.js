/**
 * Local Agent Server - Simplified autonomous code analysis
 * Strategy: Plan (get metadata) → Retrieve (batch fetch) → Analyze (LLM answers)
 */

import fs from 'fs/promises';
import path from 'path';
import { WorkspaceResolver } from '../lib/workspace.js';

// ========== TOOL DEFINITIONS ==========

const TOOLS = [
  {
    name: 'run_local_agent',
    description: 'AUTONOMOUS CODE ANALYSIS: Three-step process (1) Get project metadata from code-search, (2) LLM plans what code to retrieve within token budget, (3) Batch retrieve and analyze. Returns TEXT SUMMARY only - saves YOUR context! WHEN TO USE: Complex tasks requiring multiple files, unclear where to start, need architectural overview. DON\'T USE: Simple 1-2 file questions (use inspect_code), need actual code (use retrieve_file). EXAMPLES: "Explain authentication flow", "Find performance bottlenecks", "Document API architecture". Always 2 LLM calls (planning + analysis), no unpredictable iteration.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Clear description of what you want to understand. Be specific about scope and depth. Examples: "Explain how WebSocket connections are managed", "Find all database query patterns", "Document the router\'s context management strategy".'
        },
        workspace: {
          type: 'string',
          description: 'Workspace name (e.g., "BADKID-DEV", "COOLKID-Work"). Use get_workspace_config to see available workspaces.'
        },
        maxFiles: {
          type: 'number',
          description: 'Max files to include in metadata for planning (default: 50). Higher = more thorough but slower planning.'
        },
        tokenBudget: {
          type: 'number',
          description: 'Token budget for code retrieval (default: 30000). LLM will plan retrievals to stay within this limit.'
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
          description: 'File path(s) or hash ID(s) to analyze. Formats: "src/file.js" (path), "a3f2b1c4d5e6f7a8" (hash ID from search), "file1.js, file2.js" (multiple comma-separated). Can include workspace prefix like "BADKID-DEV:src/file.js" or be relative to workspace root.'
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
    description: 'Get file content - ALWAYS use partial retrieval (startLine/endLine) to save tokens. File IDs from search use 32-char hash format. BEST PRACTICE: (1) search_semantic to find relevant files, (2) get_file_info to see function locations with line numbers, (3) retrieve_file with startLine/endLine to fetch only needed functions. Example: Function at line 245? Use startLine=245, endLine=280 to get ~35 lines instead of entire file. Token savings: 50-500x for large files!',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File ID from search results (32-char hash like "a3f2b1c4d5e6f7a8b9c0d1e2f3a4b5c6") or legacy format ("BADKID-DEV:src/file.js")'
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

const PROMPTS = [];
const PROMPT_NAMES = new Set();

// ========== FACTORY FUNCTION ==========

export function createLocalAgentServer(config, router) {
  const workspace = new WorkspaceResolver(config.workspaces || {});
  let codeSearch = null;
  let progressCallback = null;

  function sendProgress(progress, total, message) {
    if (progressCallback) {
      progressCallback({ progress, total, message });
    }
  }

  // ========== TOOL IMPLEMENTATIONS ==========

  async function runLocalAgent(args) {
    const { task, workspace: workspaceName, maxFiles = 50, tokenBudget = 30000 } = args;

    try {
      if (!codeSearch) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'Code search not available - workspace not indexed',
              suggestion: 'Use code-search tools directly or run: scripts/build-index.js'
            }, null, 2)
          }]
        };
      }

      sendProgress(10, 100, 'Getting workspace metadata...');

      // Step 1: Get project structure
      const searchResult = await codeSearch.callTool('search_files', {
        workspace: workspaceName,
        glob: '**/*'
      });
      
      const searchData = JSON.parse(searchResult.content[0].text);
      const allFiles = searchData.files || [];
      const selectedFiles = allFiles.slice(0, maxFiles);

      sendProgress(30, 100, `Analyzing ${selectedFiles.length} files...`);

      // Get file metadata (functions, imports, etc.)
      const fileInfoPromises = selectedFiles.map(async (fileId) => {
        try {
          const infoResult = await codeSearch.callTool('get_file_info', { file: fileId });
          return JSON.parse(infoResult.content[0].text);
        } catch (e) {
          return null;
        }
      });

      const fileInfos = (await Promise.all(fileInfoPromises)).filter(f => f !== null);

      sendProgress(50, 100, 'Planning retrieval strategy...');

      // Step 2: LLM plans what to retrieve
      const planningPrompt = `You are analyzing a codebase to answer: "${task}"

Project structure (${fileInfos.length} files):
${JSON.stringify(fileInfos.map(f => ({
  file: f.file,  // This is the full "workspace:path" format - use it exactly as shown
  language: f.language,
  size_bytes: f.size_bytes,
  functions: f.functions?.slice(0, 10).map(fn => `${fn.name} (line ${fn.line})`),
  classes: f.classes?.slice(0, 5).map(c => `${c.name} (line ${c.line})`),
  imports: f.imports?.slice(0, 5)
})), null, 2)}

Token budget: ${tokenBudget} (roughly ${Math.floor(tokenBudget / 4)} lines of code)

Plan your retrieval strategy:
1. Identify which files contain relevant code
2. Specify line ranges for specific functions (use line numbers from metadata)
3. Stay within token budget (estimate ~4 tokens per line)
4. Prioritize imports, key functions, and architecture-critical code

IMPORTANT: Use the EXACT file IDs from the metadata above (e.g., "BADKID-DEV:mcp_server/src/file.js") - do not abbreviate or change them.

Return JSON array of retrievals:
[
  {
    "file": "BADKID-DEV:mcp_server/src/http-server.js",
    "startLine": 10,
    "endLine": 50,
    "reason": "Contains authentication logic"
  }
]

Be selective - quality over quantity. Focus on code that directly answers the task.`;

      const planSchema = {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            startLine: { type: 'number' },
            endLine: { type: 'number' },
            reason: { type: 'string' }
          },
          required: ['file']
        }
      };

      const planResponse = await router.predict({
        systemPrompt: 'You are a code analysis planner. Create efficient retrieval strategies that stay within token budgets.',
        prompt: planningPrompt,
        responseFormat: planSchema,
        maxTokens: 2000,
        temperature: 0.3,
        taskType: 'agent'
      });

      let plan;
      try {
        plan = JSON.parse(planResponse);
      } catch (e) {
        // Try to extract JSON from response
        const match = planResponse.match(/\[[\s\S]*\]/);
        if (match) {
          plan = JSON.parse(match[0]);
        } else {
          throw new Error('Failed to parse retrieval plan');
        }
      }

      if (!Array.isArray(plan) || plan.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'No files selected for retrieval',
              plan: planResponse
            }, null, 2)
          }]
        };
      }

      sendProgress(70, 100, `Retrieving ${plan.length} code chunks...`);

      // Step 3: Batch retrieve chunks
      const retrievalPromises = plan.map(async (item) => {
        try {
          const retrieveArgs = { file: item.file };
          if (item.startLine) retrieveArgs.startLine = item.startLine;
          if (item.endLine) retrieveArgs.endLine = item.endLine;
          
          const result = await codeSearch.callTool('retrieve_file', retrieveArgs);
          const data = JSON.parse(result.content[0].text);
          
          return {
            file: item.file,
            reason: item.reason,
            lines: `${data.start_line || 1}-${data.end_line || data.total_lines}`,
            content: data.content
          };
        } catch (e) {
          return {
            file: item.file,
            error: e.message
          };
        }
      });

      const chunks = await Promise.all(retrievalPromises);
      const validChunks = chunks.filter(c => c.content);

      sendProgress(90, 100, 'Analyzing code...');

      // Step 4: LLM analyzes with retrieved code
      const codeSection = validChunks.map(chunk => 
        `File: ${chunk.file} (lines ${chunk.lines})${chunk.reason ? `\nReason: ${chunk.reason}` : ''}\n\`\`\`\n${chunk.content}\n\`\`\``
      ).join('\n\n');

      const analysisPrompt = `${codeSection}\n\nTask: ${task}\n\nProvide a clear, concise analysis.`;

      const analysis = await router.predict({
        systemPrompt: 'You are a code analysis assistant. Provide clear, accurate explanations of code architecture and behavior.',
        prompt: analysisPrompt,
        maxTokens: 2000,
        temperature: 0.3,
        taskType: 'agent'
      });

      sendProgress(100, 100, 'Complete');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            task,
            files_analyzed: validChunks.length,
            retrieval_plan: plan,
            analysis: analysis.trim()
          }, null, 2)
        }]
      };

    } catch (err) {
      sendProgress(100, 100, 'Error');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: err.message,
            code: err.code || 'AGENT_ERROR',
            task: args.task
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
      for (let fileId of targets) {
        let filePath, fullPath, content;
        
        // Check if it's a hash ID (32 hex chars, no path separators)
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
          fullPath = path.join(workspace.getWorkspacePath(fileInfo.workspace), filePath);
        } else {
          // File path (with or without workspace prefix)
          filePath = fileId;
          
          // Strip workspace prefix if present (e.g., "BADKID-DEV:src/file.js" -> "src/file.js")
          if (filePath.includes(':')) {
            const parts = filePath.split(':');
            if (parts.length === 2 && parts[0] === workspaceName) {
              filePath = parts[1];
            }
          }
          
          fullPath = path.join(uncPath, filePath);
        }
        
        await workspace.validatePath(fullPath, workspaceName);
        content = await fs.readFile(fullPath, 'utf-8');
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

  async function retrieveFile(args) {
    const { file, startLine, endLine } = args;

    try {
      let uncPath, workspaceName, filePath;

      // Handle both hash IDs and old "workspace:path" format
      if (file.includes(':')) {
        // Old format: workspace:path
        uncPath = workspace.resolveFileId(file);
        const parsed = workspace.parseFileId(file);
        workspaceName = parsed.workspace;
        filePath = parsed.relativePath;
      } else {
        // New format: hash ID - need to look up in index
        const fileInfoResult = await codeSearch.callTool('get_file_info', { file });
        const fileInfo = JSON.parse(fileInfoResult.content[0].text);
        
        if (fileInfo.error) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: fileInfo.error,
                file,
                hint: fileInfo.hint
              }, null, 2)
            }],
            isError: true
          };
        }

        workspaceName = fileInfo.workspace;
        filePath = fileInfo.path;
        const workspacePath = workspace.getWorkspacePath(workspaceName);
        uncPath = path.join(workspacePath, filePath);
      }

      await workspace.validatePath(uncPath, workspaceName);

      const content = await fs.readFile(uncPath, 'utf-8');
      const lines = content.split('\n');

      const actualStart = startLine ? Math.max(1, startLine) : 1;
      const actualEnd = endLine ? Math.min(lines.length, endLine) : lines.length;

      const selectedLines = lines.slice(actualStart - 1, actualEnd);
      const resultContent = selectedLines.join('\n');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            file_id: file,
            workspace: workspaceName,
            path: filePath,
            total_lines: lines.length,
            retrieved_lines: selectedLines.length,
            start_line: actualStart,
            end_line: actualEnd,
            size: resultContent.length,
            content: resultContent
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
            file
          }, null, 2)
        }],
        isError: true
      };
    }
  }

  // ========== PUBLIC API ==========

  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    
    getPrompts: () => PROMPTS,
    handlesPrompt: name => PROMPT_NAMES.has(name),
    getPrompt: (name, args) => null,
    
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
