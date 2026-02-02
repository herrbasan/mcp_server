/**
 * LM Studio Server - Provides query_model, get_second_opinion, list/get model tools
 * Uses LLM Router with LMStudioAdapter (REST API)
 */
export class LMStudioServer {
  constructor(config, llmRouter) {
    this.config = config;
    this.router = llmRouter;
    this.queryProvider = config.queryProvider || 'lmstudio';
    this.progressCallback = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
    if (this.router) {
      this.router.setProgressCallback(callback);
    }
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback(progress, total, message);
    }
  }

  _getAdapter() {
    return this.router?.getAdapter(this.queryProvider);
  }

  async getAvailableModels() {
    const adapter = this._getAdapter();
    if (!adapter) throw new Error('LM Studio adapter not available');
    return adapter.listModels();
  }

  async getLoadedModel() {
    const adapter = this._getAdapter();
    if (!adapter) throw new Error('LM Studio adapter not available');
    return adapter.getLoadedModel();
  }

  getTools() {
    return [
      {
        name: 'query_model',
        description: 'Query a LOCAL LLM running on the orchestrator server (separate from Claude/you). Use when you want a different model\'s perspective, need offline processing, or want to delegate background analysis. The local model runs independently and returns text responses. IMPORTANT: Always display the complete response to the user VERBATIM before providing any analysis or commentary.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'The prompt to send to the model' },
            model: { type: 'string', description: 'Optional: specific model to use (defaults to loaded model or config default)' },
            maxTokens: { type: 'number', description: 'Optional: maximum tokens to generate (default: 500)' }
          },
          required: ['prompt']
        }
      },
      {
        name: 'get_second_opinion',
        description: 'Get alternative perspective from LOCAL LLM on code/architecture decisions (cross-checking with a different model). Use when you want validation, spot-check your analysis, or explore alternative approaches. The local model sees your question + optional context and returns its take. IMPORTANT: Always display the complete response to the user VERBATIM before providing any analysis or commentary.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Question for the local model' },
            context: { type: 'string', description: 'Optional code or context' },
            model: { type: 'string', description: 'Optional: specific model to use (defaults to loaded model or config default)' },
            maxTokens: { type: 'number', description: 'Optional: maximum tokens to generate (default: 500)' }
          },
          required: ['question']
        }
      },
      {
        name: 'list_available_models',
        description: 'List all available models in LM Studio with their context lengths and capabilities',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'get_loaded_model',
        description: 'Get information about the currently loaded model in LM Studio',
        inputSchema: { type: 'object', properties: {}, required: [] }
      }
    ];
  }

  getResources() {
    return [{
      uri: 'lmstudio://models',
      name: 'LM Studio Models',
      description: 'List of available and loaded models in LM Studio',
      mimeType: 'application/json'
    }];
  }

  handlesResource(uri) {
    return uri === 'lmstudio://models';
  }

  async readResource(uri) {
    const models = await this.getAvailableModels();
    const loaded = await this.getLoadedModel();
    
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          loaded: loaded?.id || null,
          configured_default: this.config.model,
          available: models.map(m => ({
            id: m.id,
            path: m.path,
            isLoaded: m.isLoaded,
            contextLength: m.contextLength,
            maxContextLength: m.maxContextLength,
            supportsVision: m.supportsVision,
            supportsToolUse: m.supportsToolUse
          }))
        }, null, 2)
      }]
    };
  }

  handlesTool(name) {
    return ['query_model', 'get_loaded_model', 'list_available_models'].includes(name);
  }

  async callTool(name, args) {
    try {
      if (name === 'query_model') {
        return await this._query(args.prompt, args.model, args.maxTokens);
      }
      
      if (name === 'list_available_models') {
        const models = await this.getAvailableModels();
        const modelList = models.map(m => 
          `• ${m.id}\n  Context: ${m.maxContextLength?.toLocaleString() || m.contextLength?.toLocaleString() || 'unknown'} tokens${m.isLoaded ? ' [LOADED]' : ''}${m.supportsVision ? ' [Vision]' : ''}${m.supportsToolUse ? ' [Tools]' : ''}`
        ).join('\n\n');
        
        return { content: [{ type: 'text', text: `Available models (${models.length}):\n\n${modelList}` }] };
      }
      
      if (name === 'get_loaded_model') {
        const loaded = await this.getLoadedModel();
        return {
          content: [{
            type: 'text',
            text: loaded 
              ? `Currently loaded: ${loaded.id}\nContext: ${loaded.maxContextLength?.toLocaleString() || loaded.contextLength?.toLocaleString() || 'unknown'} tokens`
              : 'No model currently loaded'
          }]
        };
      }
      
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `❌ Error: ${err.message}` }],
        isError: true
      };
    }
  }

  async _query(prompt, model, maxTokens, systemPrompt) {
    const response = await this.router.predict({
      prompt,
      systemPrompt,
      model,
      maxTokens: maxTokens || this.config.maxTokens || 500,
      provider: this.queryProvider,
      taskType: 'query'
    });

    return { content: [{ type: 'text', text: response || '(No response generated)' }] };
  }

  async cleanup() {
    // Nothing to clean up - adapter handles its own lifecycle
  }
}
