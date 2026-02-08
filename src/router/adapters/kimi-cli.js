import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_MODEL = 'kimi-k2.5';

// Path to empty MCP config (to avoid CLI trying to connect to our Orchestrator)
const __dirname = dirname(fileURLToPath(import.meta.url));
const EMPTY_MCP_CONFIG = join(__dirname, '..', '..', '..', 'data', 'kimi-empty-mcp.json');

export function createKimiCliAdapter(config) {
  const { 
    command = 'kimi',
    timeout = 120000
  } = config;

  let model = config.model || DEFAULT_MODEL;

  async function runKimiCli(prompt, systemPrompt) {
    // Build the full prompt with system prompt if provided
    const fullPrompt = systemPrompt 
      ? `${systemPrompt}\n\n${prompt}` 
      : prompt;
    
    // Debug logging
    if (process.env.DEBUG_KIMI_CLI === '1') {
      console.error(`[kimi-cli] System prompt length: ${systemPrompt?.length || 0}`);
      console.error(`[kimi-cli] User prompt length: ${prompt?.length || 0}`);
      console.error(`[kimi-cli] Full prompt length: ${fullPrompt?.length || 0}`);
      if (systemPrompt) {
        console.error(`[kimi-cli] System prompt preview: ${systemPrompt.slice(0, 100)}...`);
      }
    }

    return new Promise((resolve, reject) => {
      const stdout = [];
      const stderr = [];
      
      // Use --input-format=text and pass prompt via stdin to avoid shell escaping issues
      const args = [
        '--quiet',
        '--mcp-config-file', EMPTY_MCP_CONFIG,
        '--input-format', 'text'
      ];

      const child = spawn(command, args, {
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8'
        },
        timeout,
        shell: false  // Disable shell to avoid argument parsing issues
      });

      // Send prompt via stdin
      child.stdin.write(fullPrompt);
      child.stdin.end();

      child.stdout.on('data', data => stdout.push(data));
      child.stderr.on('data', data => stderr.push(data));

      child.on('close', code => {
        const output = Buffer.concat(stdout).toString('utf-8').trim();
        const errors = Buffer.concat(stderr).toString('utf-8').trim();
        
        if (code !== 0) {
          reject(new Error(`Kimi CLI exited ${code}: ${errors || output}`));
        } else {
          resolve(output);
        }
      });

      child.on('error', err => {
        reject(new Error(`Failed to spawn Kimi CLI: ${err.message}. Is 'kimi' installed and in PATH?`));
      });
    });
  }

  return {
    name: 'kimi-cli',
    
    getModel() { return model; },

    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) {
      const output = await runKimiCli(prompt, systemPrompt);
      
      // If schema requested, try to extract JSON from markdown code blocks or raw JSON
      if (schema) {
        // Try ```json block first
        const jsonBlockMatch = output.match(/```json\s*\n?([\s\S]*?)```/);
        if (jsonBlockMatch) {
          return jsonBlockMatch[1].trim();
        }
        
        // Try any ``` block
        const codeBlockMatch = output.match(/```\s*\n?([\s\S]*?)```/);
        if (codeBlockMatch) {
          try {
            JSON.parse(codeBlockMatch[1].trim()); // Validate
            return codeBlockMatch[1].trim();
          } catch {
            // Not valid JSON, fall through
          }
        }
        
        // Try to find JSON object/array in output
        const jsonMatch = output.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        if (jsonMatch) {
          try {
            JSON.parse(jsonMatch[1]); // Validate
            return jsonMatch[1];
          } catch {
            // Not valid JSON, fall through
          }
        }
      }
      
      return output;
    },

    async getContextWindow() {
      // Kimi K2.5 via CLI: 256K tokens
      return 256000;
    },

    async listModels() {
      // Kimi CLI doesn't have a list-models command
      // Return known models
      return [
        { id: 'kimi-k2.5', name: 'Kimi K2.5' },
        { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo' }
      ];
    },

    async getLoadedModel() {
      return { id: model, name: model };
    },

    capabilities: {
      embeddings: false,
      structuredOutput: true,  // Via JSON extraction
      batch: false,
      modelManagement: false,
      local: true              // CLI runs locally
    }
  };
}
