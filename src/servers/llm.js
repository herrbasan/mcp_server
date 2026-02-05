const TOOLS = [
  {
    name: 'query_model',
    description: 'Query a LOCAL LLM running on the orchestrator server (separate from Claude/you). Use when you want a different model\'s perspective, need offline processing, or want to delegate background analysis. The local model runs independently and returns text responses. IMPORTANT: Always display the complete response to the user VERBATIM before providing any analysis or commentary.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send to the model' },
        systemPrompt: { type: 'string', description: 'Optional: system prompt to guide the model (defaults to config)' },
        schema: { type: 'object', description: 'Optional: JSON schema for structured output. If provided, response will be valid JSON matching this schema.' },
        maxTokens: { type: 'number', description: 'Optional: maximum tokens to generate. Only use this if you want truncated output - the router automatically calculates optimal length based on model context window. Setting this will limit the response length.' }
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
