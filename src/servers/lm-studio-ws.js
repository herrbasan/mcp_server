import { LMStudioSession } from '../../LMStudioAPI/vanilla-sdk.js';

export class LMStudioWSServer {
  constructor(config) {
    this.config = config;
    this.session = null;
    this.currentModel = null;
    this.progressCallback = null;
    this.connectPromise = null;
    this._modelsCache = null;
    this._modelsCacheAt = 0;
    this._modelLoadPromise = null;
    this._modelLoadKey = null;
    this._connectNsSeen = null;
    this._lastStatus = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback(progress, total, message);
    }
  }

  _sendStatus(progress, message) {
    if (!message) return;
    if (message === this._lastStatus) return;
    this._lastStatus = message;
    this.sendProgress(progress, 100, message);
  }

  _isConnectionError(err) {
    const msg = err && err.message ? String(err.message) : String(err || '');
    const m = msg.toLowerCase();
    return (
      m.includes('not connected') ||
      m.includes('connect timeout') ||
      m.includes('connection closed') ||
      m.includes('connection error') ||
      m.includes('econnrefused') ||
      m.includes('websocket')
    );
  }

  _isSessionReady() {
    if (!this.session) return false;
    return typeof this.session.connectionState === 'number' ? this.session.connectionState === 3 : true;
  }

  async ensureConnected() {
    if (this._isSessionReady()) return;
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
      // Defaults in LMStudioAPI are good; we tune for reliability under load.
      connectTimeoutMs: this.config.connectTimeoutMs || 10000,
      rpcTimeoutMs: this.config.rpcTimeoutMs || 120000,
      autoReconnect: true,
      reconnect: {
        enabled: true,
        maxAttempts: 12,
        baseDelayMs: 200,
        maxDelayMs: 6000,
        multiplier: 1.7,
        jitter: 0.3,
      },
      telemetry: {
        onReconnect: (info) => {
          this.sendProgress(2, 100, `Reconnecting (${info?.namespace || 'unknown'})...`);
        },
        onGiveUp: (info) => {
          this.sendProgress(2, 100, `Reconnect gave up (${info?.namespace || 'unknown'})`);
        },
      },
      modelOptions: {
        enforceSingleModel: true,
        // JIT auto-unload TTL is optional; keep it off unless configured.
        ...(typeof this.config.autoUnloadTtlMs === 'number' ? { autoUnloadTtlMs: this.config.autoUnloadTtlMs } : {})
      }
    });

    try {
      this._connectNsSeen = new Set();
      await this.session.connect({
        onProgress: (p) => {
          if (!p || typeof p !== 'object') return;

          if (p.namespace) this._connectNsSeen.add(String(p.namespace));

          // Coarse connect progress: keep it stable and cheap.
          // Most of the meaningful progress happens during model loading.
          const nsCount = this._connectNsSeen ? this._connectNsSeen.size : 0;
          const pct = Math.min(10, 2 + nsCount * 2);
          const msg = p.message || p.status || 'connecting';
          this._sendStatus(pct, msg);
        }
      });
    } catch (err) {
      this.session = null;
      throw err;
    } finally {
      this._connectNsSeen = null;
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
      const now = Date.now();
      const ttlMs = 1500;
      if (this._modelsCache && (now - this._modelsCacheAt) < ttlMs) return this._modelsCache;

      const models = await this.session.listModels();
      // Map to consistent structure
      const mapped = models
        .filter(m => m && m.type === 'llm' && !m.isEmbeddingModel)
        .map(m => ({
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

      this._modelsCache = mapped;
      this._modelsCacheAt = now;
      return mapped;
    } catch (err) {
      if (this._isConnectionError(err)) this.session = null;
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

  async _ensureModelLoaded(modelKey) {
    await this.ensureConnected();

    if (this._modelLoadPromise) {
      if (this._modelLoadKey === modelKey) return this._modelLoadPromise;
      try { await this._modelLoadPromise; } catch (e) {}
    }

    this._modelLoadKey = modelKey;
    this._modelsCache = null;
    this._modelsCacheAt = 0;

    this._modelLoadPromise = this.session.ensureModelLoaded(modelKey, (p) => {
      if (!p || typeof p !== 'object') return;
      if (p.status === 'loading_model' && typeof p.progress === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(p.progress * 100)));
        this._sendStatus(5 + Math.round(pct * 0.3), `Loading model: ${pct}%`);
      }
    }).finally(() => {
      if (this._modelLoadKey === modelKey) {
        this._modelLoadPromise = null;
        this._modelLoadKey = null;
      }
    });

    return this._modelLoadPromise;
  }

  async _predictOnce({ prompt, model, maxTokens, systemPrompt }) {
    await this.ensureConnected();
    const selectedModel = await this.selectModel(model);

    this._sendStatus(0, `Using model: ${selectedModel}`);
    this._sendStatus(5, 'Ensuring model loaded...');
    await this._ensureModelLoaded(selectedModel);

    this._sendStatus(35, 'Generating response...');

    let fullResponse = '';
    const tokens = maxTokens || this.config.maxTokens || 500;

    const stripThinking = this.config.stripThinking !== false;
    const thinkingTags = Array.isArray(this.config.thinkingTags) && this.config.thinkingTags.length ? this.config.thinkingTags : undefined;

    const stream = this.session.predict({
      modelKey: selectedModel,
      prompt,
      ...(systemPrompt ? { systemPrompt } : {}),
      maxTokens: tokens,
      ...(stripThinking ? { stripThinking: true, ...(thinkingTags ? { thinkingTags } : {}) } : {}),
      onProgress: (p) => {
        if (!p || typeof p !== 'object' || !p.status) return;
        if (p.status === 'streaming') return;
        this._sendStatus(35, p.status);
      }
    });

    for await (const chunk of stream) fullResponse += chunk;

    this._sendStatus(100, 'Complete');
    return fullResponse;
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
            model: { type: 'string', description: 'Optional: specific model to use (defaults to loaded model or config default)' },
            maxTokens: { type: 'number', description: 'Optional: maximum tokens to generate (default: 500)' }
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
        const fullResponse = await this._predictOnce({ prompt, model, maxTokens });
        
        return {
          content: [{
            type: 'text',
            text: fullResponse || '(No response generated)'
          }]
        };
      } catch (err) {
        if (this._isConnectionError(err)) this.session = null;
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
    
    const { question, context, model, maxTokens } = args;
    const prompt = context ? `${context}\n\nQuestion: ${question}` : question;
    
    try {
      const fullResponse = await this._predictOnce({
        prompt,
        model,
        maxTokens: maxTokens || this.config.maxTokens || 500,
        systemPrompt: this.config.systemPrompt,
      });
      
      return {
        content: [{
          type: 'text',
          text: fullResponse || '(No response generated)'
        }]
      };
    } catch (err) {
      if (this._isConnectionError(err)) this.session = null;
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
