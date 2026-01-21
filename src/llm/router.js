import { LMStudioAdapter } from './lmstudio-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';

export class LLMRouter {
  constructor(config) {
    this.config = config;
    this.adapters = new Map();
    this.defaultProvider = config.defaultProvider || 'lmstudio';
    this.taskDefaults = config.taskDefaults || {};
    this.progressCallback = null;
    this._initAdapters();
  }

  _initAdapters() {
    const providers = this.config.providers || {};

    for (const [name, providerConfig] of Object.entries(providers)) {
      if (!providerConfig.enabled) continue;

      try {
        const adapter = this._createAdapter(name, providerConfig);
        if (adapter) {
          this.adapters.set(name, adapter);
        }
      } catch (err) {
        console.error(`[LLMRouter] Failed to initialize ${name}:`, err.message);
      }
    }

    if (this.adapters.size === 0) {
      console.warn('[LLMRouter] No adapters initialized');
    }
  }

  _createAdapter(name, config) {
    const type = (config.type || name).toLowerCase();

    switch (type) {
      case 'lmstudio':
      case 'lm-studio':
        return new LMStudioAdapter(config);
      
      case 'ollama':
        return new OllamaAdapter(config);
      
      case 'gemini':
      case 'google':
        return new GeminiAdapter(config);
      
      case 'openai':
      case 'azure':
      case 'azure-openai':
        return new OpenAIAdapter(config);
      
      default:
        console.warn(`[LLMRouter] Unknown provider type: ${type}`);
        return null;
    }
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
    for (const adapter of this.adapters.values()) {
      adapter.setProgressCallback(callback);
    }
  }

  _resolveProvider(explicitProvider, taskType) {
    // Priority: explicit > task default > global default
    if (explicitProvider) return explicitProvider;
    if (taskType && this.taskDefaults[taskType]) return this.taskDefaults[taskType];
    return this.defaultProvider;
  }

  getAdapter(providerName, taskType) {
    const name = this._resolveProvider(providerName, taskType);
    const adapter = this.adapters.get(name);
    
    if (!adapter) {
      const available = Array.from(this.adapters.keys()).join(', ');
      throw new Error(`Provider "${name}" not found. Available: ${available || 'none'}`);
    }
    
    return adapter;
  }

  async listProviders() {
    const providers = [];
    
    for (const [name, adapter] of this.adapters.entries()) {
      const connected = await adapter.isConnected();
      const capabilities = adapter.getCapabilities();
      
      providers.push({
        name,
        connected,
        capabilities,
        isDefault: name === this.defaultProvider
      });
    }
    
    return providers;
  }

  async listModels(providerName) {
    const adapter = this.getAdapter(providerName);
    return adapter.listModels();
  }

  async getLoadedModel(providerName) {
    const adapter = this.getAdapter(providerName);
    return adapter.getLoadedModel();
  }

  async loadModel(modelId, providerName) {
    const adapter = this.getAdapter(providerName);
    return adapter.loadModel(modelId);
  }

  async unloadModel(modelId, providerName) {
    const adapter = this.getAdapter(providerName);
    return adapter.unloadModel(modelId);
  }

  async predict({ prompt, systemPrompt, maxTokens, temperature, model, provider, taskType = 'analysis' }) {
    const adapter = this.getAdapter(provider, taskType);
    await adapter.connect();
    return adapter.predict({ prompt, systemPrompt, maxTokens, temperature, model });
  }

  async embedText(text, providerName) {
    const adapter = this.getAdapter(providerName, 'embedding');
    const capabilities = adapter.getCapabilities();
    
    if (!capabilities.embeddings) {
      const resolvedName = this._resolveProvider(providerName, 'embedding');
      throw new Error(`Provider "${resolvedName}" does not support embeddings`);
    }
    
    await adapter.connect();
    return adapter.embedText(text);
  }

  async disconnect(providerName) {
    if (providerName) {
      const adapter = this.getAdapter(providerName);
      await adapter.disconnect();
    } else {
      for (const adapter of this.adapters.values()) {
        await adapter.disconnect();
      }
    }
  }

  async connectAll() {
    const results = [];
    
    for (const [name, adapter] of this.adapters.entries()) {
      try {
        await adapter.connect();
        results.push({ provider: name, connected: true });
      } catch (err) {
        results.push({ provider: name, connected: false, error: err.message });
      }
    }
    
    return results;
  }

  getCapabilities(providerName) {
    const adapter = this.getAdapter(providerName);
    return adapter.getCapabilities();
  }
}
