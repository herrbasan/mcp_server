import { LMStudioSession } from '../../LMStudioAPI/vanilla-sdk.js';

export class LMStudioWSServer {
  constructor(config) {
    this.config = config;
    this.session = null;
    this.currentModel = null;
    this.progressCallback = null;
    this.connectPromise = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback(progress, total, message);
    }
  }

  async ensureConnected() {
    if (this.session) return;
    if (this.connectPromise) return this.connectPromise;
    
    this.connectPromise = this._initSession();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async _initSession() {
    const baseUrl = this._buildWsUrl(this.config.endpoint);
    
    this.session = new LMStudioSession({
      baseUrl,
      modelOptions: {
        enforceSingleModel: true
      }
    });

    try {
      await this.session.connect({
        onProgress: (p) => {
          if (p.status) {
            this.sendProgress(p.progress || 0, 100, p.status);
          }
        }
      });
    } catch (err) {
      this.session = null;
      throw err;
    }
  }

  _buildWsUrl(endpoint) {
    try {
      const url = new URL(endpoint);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.toString();
    } catch {
      return endpoint.replace(/^https?:/, 'ws:');
    }
  }

  async getAvailableModels() {
    await this.ensureConnected();
    try {
      const models = await this.session.listModels();
      // Map to consistent structure
      return models.filter(m => !m.isEmbeddingModel).map(m => ({
        id: m.id || m.path || m.modelKey,
        path: m.path,
        modelKey: m.modelKey || m.id || m.path,
        isLoaded: m.isLoaded,
        contextLength: m.contextLength,
        maxContextLength: m.maxContextLength,
        supportsVision: m.supportsVision,
        supportsToolUse: m.supportsToolUse,
        loadedInstances: m.loadedInstances
      }));
    } catch (err) {
      throw new Error(`Failed to fetch models: ${err.message}`);
    }
  }

  async getLoadedModel() {
    const models = await this.getAvailableModels();
    return models.find(m => m.isLoaded) || null;
  }

  async selectModel(modelId = null) {
    if (modelId) {
      const available = await this.getAvailableModels();
      const found = available.find(m => 
        m.id === modelId || m.modelKey === modelId || m.path === modelId
      );
      if (!found) {
        throw new Error(`Model "${modelId}" not found. Available models: ${available.map(m => m.id).join(', ')}`);
      }
      this.currentModel = found.modelKey || found.id;
      return this.currentModel;
    }
    
    const loaded = await this.getLoadedModel();
    if (loaded) {
      this.currentModel = loaded.modelKey || loaded.id;
      return this.currentModel;
    }
    
    this.currentModel = this.config.model;
    return this.config.model;
  }

  getTools() {
    return [
      {
        name: 'query_model',
        description: 'Query LM Studio model with a custom prompt (no specialized instructions). IMPORTANT: Always display the complete response to the user VERBATIM before providing any analysis or commentary.',
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
        description: 'Query local LM Studio model for alternative perspective on code/architecture decisions. IMPORTANT: Always display the complete response to the user VERBATIM before providing any analysis or commentary.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'Question for the local model' },
            context: { type: 'string', description: 'Optional code or context' },
            model: { type: 'string', description: 'Optional: specific model to use (defaults to loaded model or config default)' }
          },
          required: ['question']
        }
      },
      {
        name: 'list_available_models',
        description: 'List all available models in LM Studio with their context lengths and capabilities',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      },
      {
        name: 'get_loaded_model',
        description: 'Get information about the currently loaded model in LM Studio',
        inputSchema: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    ];
  }

  getResources() {
    return [{
      uri: 'lmstudio://models/ws',
      name: 'LM Studio Models (WebSocket)',
      description: 'List of available and loaded models in LM Studio via WebSocket',
      mimeType: 'application/json'
    }];
  }

  handlesResource(uri) {
    return uri === 'lmstudio://models/ws';
  }

  async readResource(uri) {
    const models = await this.getAvailableModels();
    const loaded = await this.getLoadedModel();
    
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          transport: 'websocket',
          loaded: loaded?.id || null,
          configured_default: this.config.model,
          current: this.currentModel,
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
    return name === 'query_model' || name === 'get_second_opinion' || name === 'get_loaded_model' || name === 'list_available_models';
  }

  async callTool(name, args) {
    if (name === 'query_model') {
      const { prompt, model, maxTokens } = args;
      
      try {
        await this.ensureConnected();
        
        const selectedModel = await this.selectModel(model);
        this.sendProgress(0, 100, `Using model: ${selectedModel}`);
        
        this.sendProgress(5, 100, 'Ensuring model loaded...');
        await this.session.ensureModelLoaded(selectedModel, (progress) => {
          if (progress.progress !== undefined) {
            const pct = Math.round(progress.progress * 100);
            this.sendProgress(5 + pct * 0.3, 100, `Loading model: ${pct}%`);
          }
        });
        
        this.sendProgress(35, 100, 'Generating response...');
        
        let fullResponse = '';
        let chunkCount = 0;
        const tokens = maxTokens || this.config.maxTokens || 500;
        
        const stream = await this.session.predict({
          modelKey: selectedModel,
          prompt,
          maxTokens: tokens,
          onProgress: (p) => {
            if (p.status) {
              this.sendProgress(35, 100, p.status);
            }
          }
        });
        
        for await (const chunk of stream) {
          fullResponse += chunk;
          chunkCount++;
        }
        
        this.sendProgress(100, 100, 'Complete');
        
        return {
          content: [{
            type: 'text',
            text: fullResponse || '(No response generated)'
          }]
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `❌ LM Studio error: ${err.message}${err.stack ? '\n\nStack: ' + err.stack : ''}`
          }],
          isError: true,
          error: { message: err.message, stack: err.stack }
        };
      }
    }
    
    if (name === 'list_available_models') {
      try {
        await this.ensureConnected();
        const models = await this.getAvailableModels();
        const modelList = models.map(m => 
          `• ${m.id}\n  Context: ${m.maxContextLength?.toLocaleString() || m.contextLength?.toLocaleString() || 'unknown'} tokens${m.isLoaded ? ' [LOADED]' : ''}${m.supportsVision ? ' [Vision]' : ''}${m.supportsToolUse ? ' [Tools]' : ''}`
        ).join('\n\n');
        
        return {
          content: [{
            type: 'text',
            text: `Available models (${models.length}):\n\n${modelList}`
          }]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `❌ Error: ${err.message}` }],
          isError: true
        };
      }
    }
    
    if (name === 'get_loaded_model') {
      try {
        await this.ensureConnected();
        const loaded = await this.getLoadedModel();
        return {
          content: [{
            type: 'text',
            text: loaded 
              ? `Currently loaded: ${loaded.id}\nContext: ${loaded.maxContextLength?.toLocaleString() || loaded.contextLength?.toLocaleString() || 'unknown'} tokens`
              : 'No model currently loaded'
          }]
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `❌ Error: ${err.message}` }],
          isError: true
        };
      }
    }
    
    const { question, context, model } = args;
    const prompt = context ? `${context}\n\nQuestion: ${question}` : question;
    
    try {
      await this.ensureConnected();
      
      const selectedModel = await this.selectModel(model);
      this.sendProgress(0, 100, `Using model: ${selectedModel}`);
      
      // Auto-load model with progress tracking
      this.sendProgress(5, 100, 'Ensuring model loaded...');
      await this.session.ensureModelLoaded(selectedModel, (progress) => {
        if (progress.progress !== undefined) {
          const pct = Math.round(progress.progress * 100);
          this.sendProgress(5 + pct * 0.3, 100, `Loading model: ${pct}%`);
        }
      });
      
      this.sendProgress(35, 100, 'Generating response...');
      
      let fullResponse = '';
      let chunkCount = 0;
      const maxTokens = this.config.maxTokens || 500;
      
      const stream = await this.session.predict({
        modelKey: selectedModel,
        prompt,
        systemPrompt: this.config.systemPrompt,
        maxTokens,
        onProgress: (p) => {
          if (p.status) {
            this.sendProgress(35, 100, p.status);
          }
        }
      });
      
      for await (const chunk of stream) {
        fullResponse += chunk;
        chunkCount++;
      }
      
      this.sendProgress(100, 100, 'Complete');
      
      return {
        content: [{
          type: 'text',
          text: fullResponse || '(No response generated)'
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `❌ LM Studio WebSocket error: ${err.message}\n\nModel: ${this.currentModel || this.config.model}\n\nEnsure LM Studio is running.${err.stack ? '\n\nStack: ' + err.stack : ''}`
        }],
        isError: true,
        error: { message: err.message, stack: err.stack }
      };
    }
  }

  async cleanup() {
    if (this.session) {
      await this.session.disconnect();
      this.session = null;
    }
  }
}
