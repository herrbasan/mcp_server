import { BaseLLMAdapter } from './base-adapter.js';
import { LMStudioSession } from '../../LMStudioAPI/vanilla-sdk.js';

export class LMStudioAdapter extends BaseLLMAdapter {
  constructor(config) {
    super(config);
    this.session = null;
    this.currentModel = null;
    this._modelsCache = null;
    this._modelsCacheAt = 0;
    this._modelLoadPromise = null;
    this._modelLoadKey = null;
    this._connectPromise = null;
    this._connectNsSeen = null;
    this._lastStatus = null;
    this._modelLastUsed = new Map();
    this._ttlCheckInterval = null;
    this._defaultModelTtlMs = config.defaultModelTtlMs || 60 * 60 * 1000;
    this._nonDefaultModelTtlMs = config.nonDefaultModelTtlMs || 10 * 60 * 1000;
  }

  _sendStatus(progress, message) {
    if (!message || message === this._lastStatus) return;
    this._lastStatus = message;
    this.sendProgress(progress, 100, message);
  }

  _isConnectionError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('not connected') || msg.includes('connect timeout') || 
           msg.includes('connection closed') || msg.includes('connection error') ||
           msg.includes('econnrefused') || msg.includes('websocket');
  }

  _isSessionReady() {
    if (!this.session) return false;
    return typeof this.session.connectionState === 'number' ? this.session.connectionState === 3 : true;
  }

  async isConnected() {
    return this._isSessionReady();
  }

  async connect() {
    if (this._isSessionReady()) return;
    if (this._connectPromise) return this._connectPromise;
    
    this._connectPromise = this._initSession();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  async _initSession() {
    const baseUrl = this._buildWsUrl(this.config.endpoint);
    
    this.session = new LMStudioSession({
      baseUrl,
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
        onReconnect: (info) => this.sendProgress(2, 100, `Reconnecting (${info?.namespace || 'unknown'})...`),
        onGiveUp: (info) => this.sendProgress(2, 100, `Reconnect gave up (${info?.namespace || 'unknown'})`),
      },
      modelOptions: {
        enforceSingleModel: true,
        ...(typeof this.config.autoUnloadTtlMs === 'number' ? { autoUnloadTtlMs: this.config.autoUnloadTtlMs } : {})
      }
    });

    try {
      this._connectNsSeen = new Set();
      await this.session.connect({
        onProgress: (p) => {
          if (!p || typeof p !== 'object') return;
          if (p.namespace) this._connectNsSeen.add(String(p.namespace));
          const nsCount = this._connectNsSeen?.size || 0;
          const pct = Math.min(10, 2 + nsCount * 2);
          this._sendStatus(pct, p.message || p.status || 'connecting');
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

  async disconnect() {
    if (this._ttlCheckInterval) {
      clearInterval(this._ttlCheckInterval);
      this._ttlCheckInterval = null;
    }
    if (this.session) {
      await this.session.disconnect();
      this.session = null;
    }
    this.currentModel = null;
  }

  async listModels() {
    await this.connect();
    try {
      const now = Date.now();
      if (this._modelsCache && (now - this._modelsCacheAt) < 1500) return this._modelsCache;

      const models = await this.session.listModels();
      const mapped = models
        .filter(m => m?.type === 'llm' && !m.isEmbeddingModel)
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
    const models = await this.listModels();
    return models.find(m => m.isLoaded) || null;
  }

  async loadModel(modelId) {
    await this.connect();
    const available = await this.listModels();
    const model = available.find(m => m.id === modelId || m.modelKey === modelId || m.path === modelId);
    
    if (!model) {
      throw new Error(`Model "${modelId}" not found. Available: ${available.map(m => m.id).join(', ')}`);
    }

    if (model.isLoaded) return model.modelKey || model.path;

    const modelKey = model.modelKey || model.path;
    
    if (this._modelLoadPromise && this._modelLoadKey === modelKey) {
      return this._modelLoadPromise;
    }

    this._modelLoadKey = modelKey;
    this._modelLoadPromise = this._loadModelInternal(modelKey);
    
    try {
      await this._modelLoadPromise;
      return modelKey;
    } finally {
      this._modelLoadPromise = null;
      this._modelLoadKey = null;
    }
  }

  async _loadModelInternal(modelKey) {
    this._sendStatus(10, `Loading ${modelKey}...`);
    
    try {
      await this.session._loadModelAndWait(
        { modelKey, path: modelKey },
        (p) => {
          if (!p || typeof p !== 'object') return;
          
          // Extract progress percentage
          const pct = typeof p.progress === 'number' ? Math.round(p.progress * 100) : 
                     (p.status === 'loading_model' ? 50 : 10);
          
          // Map to 10-35% range for model loading phase
          const progress = 10 + Math.min(pct * 0.25, 25);
          
          // Extract status message
          const statusMsg = p.message || p.status || `Loading ${pct}%`;
          
          this._sendStatus(progress, statusMsg);
        }
      );
      
      this._modelsCache = null;
      this._sendStatus(35, `Model ${modelKey} loaded`);
    } catch (err) {
      if (this._isConnectionError(err)) this.session = null;
      throw new Error(`Failed to load model "${modelKey}": ${err.message}`);
    }
  }

  async unloadModel(modelId) {
    await this.connect();
    const models = await this.listModels();
    const model = models.find(m => (m.id === modelId || m.modelKey === modelId || m.path === modelId) && m.isLoaded);
    
    if (!model) return;

    const modelKey = model.modelKey || model.path;
    const instances = Array.isArray(model.loadedInstances) ? model.loadedInstances : [];
    const identifier = instances.length > 0 
      ? (typeof instances[0] === 'string' ? instances[0] : (instances[0].identifier || instances[0].instanceReference || modelKey))
      : modelKey;
    
    await this.session.llm.unloadModel(identifier);
    this._modelLastUsed.delete(modelKey);
    this._modelsCache = null;
  }

  _trackModelUsage(modelKey) {
    this._modelLastUsed.set(modelKey, Date.now());
  }

  _startTtlMonitoring() {
    if (this._ttlCheckInterval) return;
    this._ttlCheckInterval = setInterval(() => this._checkAndUnloadExpired(), 60000);
  }

  async _checkAndUnloadExpired() {
    if (!this._isSessionReady()) return;
    
    try {
      const models = await this.listModels();
      const now = Date.now();
      
      for (const model of models) {
        if (!model.isLoaded) continue;
        
        const modelKey = model.modelKey || model.path;
        const lastUsed = this._modelLastUsed.get(modelKey);
        if (!lastUsed) continue;
        
        const isDefault = modelKey === this.config.model;
        const ttl = isDefault ? this._defaultModelTtlMs : this._nonDefaultModelTtlMs;
        
        if (now - lastUsed > ttl) {
          await this.session.llm.unloadModel(modelKey);
          this._modelLastUsed.delete(modelKey);
          this._modelsCache = null;
        }
      }
    } catch (err) {
      // Ignore TTL check errors
    }
  }

  async predict({ prompt, systemPrompt, maxTokens, temperature, model }) {
    await this.connect();
    
    const available = await this.listModels();
    let selectedModel = null;

    if (model) {
      const found = available.find(m => m.id === model || m.modelKey === model || m.path === model);
      if (!found) throw new Error(`Model "${model}" not found`);
      selectedModel = found.modelKey || found.path;
    } else {
      const loaded = await this.getLoadedModel();
      if (loaded) {
        selectedModel = loaded.modelKey || loaded.path;
      } else if (this.config.model) {
        const defaultModel = available.find(m => m.id === this.config.model || 
                                                 m.modelKey === this.config.model || 
                                                 m.path === this.config.model);
        if (defaultModel) selectedModel = defaultModel.modelKey || defaultModel.path;
      }
      
      if (!selectedModel && available.length > 0) {
        selectedModel = available[0].modelKey || available[0].path;
      }
    }

    if (!selectedModel) throw new Error('No model available');

    this._sendStatus(5, 'Ensuring model loaded...');
    await this.loadModel(selectedModel);
    this._trackModelUsage(selectedModel);
    this._startTtlMonitoring();

    this._sendStatus(35, 'Generating response...');

    const stripThinking = this.config.stripThinking !== false;
    const thinkingTags = Array.isArray(this.config.thinkingTags) && this.config.thinkingTags.length ? 
                        this.config.thinkingTags : undefined;

    const stream = this.session.predict({
      modelKey: selectedModel,
      prompt,
      ...(systemPrompt ? { systemPrompt } : {}),
      maxTokens: maxTokens || this.config.maxTokens || 500,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(stripThinking ? { stripThinking: true, ...(thinkingTags ? { thinkingTags } : {}) } : {}),
      onProgress: (p) => {
        if (p?.status && p.status !== 'streaming') this._sendStatus(35, p.status);
      }
    });

    let fullResponse = '';
    for await (const chunk of stream) fullResponse += chunk;

    this._sendStatus(100, 'Complete');
    return fullResponse;
  }

  async embedText(text) {
    await this.connect();
    
    if (!this.config.embeddingModel) {
      throw new Error('No embedding model configured');
    }

    const embedding = await this.session.createEmbedding(
      text,
      this.config.embeddingModel,
      {
        autoUnload: true
      }
    );
    
    return embedding;
  }

  getCapabilities() {
    return {
      streaming: true,
      embeddings: true,
      vision: true,
      toolUse: true,
      modelManagement: true,
      progressReporting: true
    };
  }
}
