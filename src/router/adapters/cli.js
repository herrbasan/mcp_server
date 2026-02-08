import { spawn } from 'child_process';

export function createCliAdapter(config) {
  const { 
    command, 
    args = [], 
    env = {}, 
    timeout = 120000,
    systemPromptArg = '--system',
    maxTokensArg = '--max-tokens',
    temperatureArg = '--temperature',
    modelArg = '--model',
    promptPos = 'end' // 'end' | 'after-args'
  } = config;

  if (!command) {
    throw new Error('CLI adapter requires a command');
  }

  async function runCli(prompt, systemPrompt, maxTokens, temperature, model) {
    const cliArgs = [...args];
    const cliEnv = { ...process.env, ...env };

    // Add optional args
    if (systemPrompt && systemPromptArg) {
      cliArgs.push(systemPromptArg, systemPrompt);
    }
    if (maxTokens && maxTokensArg) {
      cliArgs.push(maxTokensArg, String(maxTokens));
    }
    if (temperature !== undefined && temperatureArg) {
      cliArgs.push(temperatureArg, String(temperature));
    }
    if (model && modelArg) {
      cliArgs.push(modelArg, model);
    }

    // Add prompt
    if (promptPos === 'end') {
      cliArgs.push(prompt);
    } else if (promptPos === 'after-args') {
      // Prompt goes before other args
      cliArgs.unshift(prompt);
    }

    return new Promise((resolve, reject) => {
      const stdout = [];
      const stderr = [];
      
      const child = spawn(command, cliArgs, {
        env: cliEnv,
        timeout,
        shell: process.platform === 'win32'
      });

      child.stdout.on('data', data => stdout.push(data));
      child.stderr.on('data', data => stderr.push(data));

      child.on('close', code => {
        const output = Buffer.concat(stdout).toString('utf-8').trim();
        const errors = Buffer.concat(stderr).toString('utf-8').trim();
        
        if (code !== 0) {
          reject(new Error(`CLI exited ${code}: ${errors || output}`));
        } else {
          resolve(output);
        }
      });

      child.on('error', reject);
    });
  }

  return {
    name: 'cli',
    
    getModel() { return command; },

    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) {
      const output = await runCli(prompt, systemPrompt, maxTokens, temperature);
      
      // If schema requested, try to extract JSON
      if (schema) {
        try {
          const jsonMatch = output.match(/```json\n?([\s\S]*?)```/) || 
                           output.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            return JSON.stringify(parsed);
          }
        } catch {
          // Fall through to raw output
        }
      }
      
      return output;
    },

    capabilities: {
      embeddings: false,
      structuredOutput: true, // Via JSON extraction
      batch: false,
      modelManagement: false,
      local: true
    }
  };
}
