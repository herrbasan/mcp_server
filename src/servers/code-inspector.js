import fs from 'fs/promises';
import path from 'path';
import { WorkspaceResolver } from '../lib/workspace.js';

const TOOLS = [
  {
    name: 'inspect_code',
    description: 'Analyze code with LLM. Scope: external files only (for current project, analyze directly). Provide target (hash ID) OR code, not both.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File hash ID(s), comma-separated' },
        code: { type: 'string', description: 'Direct code snippet' },
        question: { type: 'string', description: 'Question about the code' },
        workspace: { type: 'string', description: 'For legacy path format' }
      },
      required: ['question']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

const PROMPTS = [];
const PROMPT_NAMES = new Set();

export function createCodeInspectorServer(config, router) {
  const workspace = new WorkspaceResolver(config.workspaces || {});
  let codeSearch = null;
  let progressCallback = null;

  function sendProgress(progress, total, message) {
    if (progressCallback) {
      progressCallback({ progress, total, message });
    }
  }

  async function inspectCode(args) {
    const { target, code, question, workspace: workspaceName } = args;

    try {
      // Validate: exactly one of target or code must be provided
      if (target && code) {
        throw new Error('Cannot specify both "target" and "code". Use one or the other.');
      }
      if (!target && !code) {
        throw new Error('Must specify either "target" (files) or "code" (direct snippet).');
      }

      let prompt;
      let resultMeta = {};

      if (code) {
        prompt = `Code:\n\`\`\`\n${code}\n\`\`\`\n\nQuestion: ${question}\n\nProvide a concise answer.`;
        resultMeta = { type: 'code_snippet', codeLength: code.length };
      } else {
        const targets = Array.isArray(target) 
          ? target 
          : target.split(',').map(t => t.trim());
        
        const files = [];
        
        for (let fileId of targets) {
          let filePath, fullPath, content, resolvedWorkspace;
          
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
            resolvedWorkspace = fileInfo.workspace;
            fullPath = path.join(workspace.getWorkspacePath(resolvedWorkspace), filePath);
          } else {
            // Legacy path format - workspace required
            if (!workspaceName) {
              throw new Error('"workspace" is required when using legacy path format (e.g., "src/file.js"). Use hash IDs from search to omit workspace.');
            }
            
            filePath = fileId;
            resolvedWorkspace = workspaceName;
            
            if (filePath.includes(':')) {
              const parts = filePath.split(':');
              if (parts.length === 2) {
                resolvedWorkspace = parts[0];
                filePath = parts[1];
              }
            }
            
            fullPath = path.join(workspace.getWorkspacePath(resolvedWorkspace), filePath);
          }
          
          await workspace.validatePath(fullPath, resolvedWorkspace);
          content = await fs.readFile(fullPath, 'utf-8');
          files.push({ path: filePath, content });
        }
        
        let filesSection = files.map(f => 
          `File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``
        ).join('\n\n');
        
        prompt = `${filesSection}\n\nQuestion: ${question}\n\nProvide a concise answer.`;
        resultMeta = { type: 'files', files: files.map(f => f.path) };
      }
      
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
            target: args.target
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
