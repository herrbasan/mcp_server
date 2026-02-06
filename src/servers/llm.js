const TOOLS = [
  {
    name: 'query_model',
    description: 'Query the local LLM. Use for different perspective or offline processing. Display response verbatim before analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt to send' },
        systemPrompt: { type: 'string', description: 'Optional system prompt' },
        schema: { type: 'object', description: 'Optional JSON schema for structured output' },
        maxTokens: { type: 'number', description: 'Optional token limit' }
      },
      required: ['prompt']
    }
  }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

async function queryModel(router, config, { prompt, systemPrompt, schema, maxTokens }) {
  const response = await router.predict({
    prompt,
    systemPrompt: systemPrompt || config.systemPrompt,
    ...(schema && { responseFormat: schema }),
    ...(maxTokens && { maxTokens })
  });
  return { content: [{ type: 'text', text: response || '(No response generated)' }] };
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
