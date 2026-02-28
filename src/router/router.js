import { createLMStudioAdapter } from './adapters/lmstudio.js';
import { createOllamaAdapter } from './adapters/ollama.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createGrokAdapter } from './adapters/grok.js';
import { createKimiAdapter } from './adapters/kimi.js';
import { createGLMAdapter } from './adapters/glm.js';
import { createKimiCliAdapter } from './adapters/kimi-cli.js';
import { createMiniMaxAdapter } from './adapters/minimax.js';
import { createContextManager } from './context-manager.js';
import { formatOutput } from './formatter.js';
import { estimateTokens } from './tokenize.js';

// Factory registry for provider types
const PROVIDER_FACTORIES = {
  lmstudio: (config) => ({
    adapter: createLMStudioAdapter({
      httpEndpoint: config.endpoint,
      model: config.model,
      embeddingModel: config.embeddingModel
    }),
    contextWindow: config.contextWindow || 8192,
    contextManagerConfig: {
      httpEndpoint: config.endpoint,
      contextWindow: config.contextWindow || 8192,
      model: config.model,
      maxTokens: 1000,
      temperature: 0.3
    }
  }),
  
  ollama: (config) => ({
    adapter: createOllamaAdapter({
      httpEndpoint: config.endpoint,
      model: config.model,
      embeddingModel: config.embeddingModel,
      contextWindow: config.contextWindow
    }),
    contextWindow: config.contextWindow || 16384,
    contextManagerConfig: {
      httpEndpoint: config.endpoint,
      contextWindow: config.contextWindow || 16384,
      model: config.model,
      maxTokens: 1000,
      temperature: 0.3
    }
  }),
  
  gemini: (config) => ({
    adapter: createGeminiAdapter({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model,
      embeddingModel: config.embeddingModel || 'gemini-embedding-001',
      embeddingDimensions: config.embeddingDimensions || 768
    }),
    contextWindow: 1048576,
    contextManagerConfig: {
      contextWindow: 1048576,
      model: config.model,
      maxTokens: 2048,
      temperature: 1.0
    }
  }),
  
  grok: (config) => ({
    adapter: createGrokAdapter({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model,
      embeddingModel: config.embeddingModel
    }),
    contextWindow: 131072,
    contextManagerConfig: {
      contextWindow: 131072,
      model: config.model,
      maxTokens: 2048,
      temperature: 0.7
    }
  }),
  
  kimi: (config) => ({
    adapter: createKimiAdapter({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model
    }),
    contextWindow: 256000,
    contextManagerConfig: {
      contextWindow: 256000,
      model: config.model,
      maxTokens: 2048,
      temperature: 0.7
    }
  }),
  
  'kimi-cli': (config) => ({
    adapter: createKimiCliAdapter({
      command: config.command,
      model: config.model,
      timeout: config.timeout
    }),
    contextWindow: 256000,
    contextManagerConfig: {
      contextWindow: 256000,
      model: config.model || 'kimi-k2.5',
      maxTokens: 2048,
      temperature: 0.7
    }
  }),
  
  glm: (config) => ({
    adapter: createGLMAdapter({
      apiKey: config.apiKey,
      model: config.model,
      endpoint: config.endpoint
    }),
    contextWindow: 131072,
    contextManagerConfig: {
      contextWindow: 131072,
      model: config.model,
      maxTokens: 2048,
      temperature: 0.7
    }
  }),
  
  minimax: (config) => ({
    adapter: createMiniMaxAdapter({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      model: config.model
    }),
    contextWindow: 204800,
    contextManagerConfig: {
      contextWindow: 204800,
      model: config.model,
      maxTokens: 2048,
      temperature: 0.7
    }
  })
};

export async function createRouter(config) {
  const adapters = {};
  const contextManagers = {};
  const metadata = {};
  const providerConfigs = {};
  
  // Validate config
  if (!config.defaultProvider) {
    throw new Error('Router config missing defaultProvider');
  }
  if (!config.providers || Object.keys(config.providers).length === 0) {
    throw new Error('Router config missing providers');
  }
  
  // Lazy initialization: store configs, create on first use
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    if (!providerConfig.enabled) continue;
    
    const factory = PROVIDER_FACTORIES[providerConfig.type];
    if (!factory) {
      throw new Error(`Unknown provider type: ${providerConfig.type} for provider ${name}`);
    }
    
    providerConfigs[name] = providerConfig;
    metadata[name] = {
      contextWindow: providerConfig.contextWindow || 8192,
      model: providerConfig.model,
      lastRefresh: null,
      refreshing: false,
      initialized: false
    };
  }
  
  // Validate defaultProvider exists
  if (!providerConfigs[config.defaultProvider]) {
    throw new Error(`defaultProvider '${config.defaultProvider}' is not enabled or not configured`);
  }
  
  const defaultProvider = config.defaultProvider;
  const embeddingProvider = config.embeddingProvider || defaultProvider;
  const taskDefaults = config.taskDefaults || {};
  
  // Lazy initialization function
  function initializeProvider(providerName) {
    if (metadata[providerName]?.initialized) return;
    
    const providerConfig = providerConfigs[providerName];
    if (!providerConfig) {
      throw new Error(`Provider ${providerName} not found or not enabled`);
    }
    
    const factory = PROVIDER_FACTORIES[providerConfig.type];
    const { adapter, contextManagerConfig } = factory(providerConfig);
    
    adapters[providerName] = adapter;
    contextManagers[providerName] = createContextManager(contextManagerConfig);
    metadata[providerName].contextWindow = contextManagerConfig.contextWindow;
    metadata[providerName].initialized = true;
    
    console.error(`[Router] Initialized provider: ${providerName}`);
  }
  
  const refreshMetadata = async (providerName) => {
    const meta = metadata[providerName];
    if (!meta) return;
    
    const now = Date.now();
    const TTL = 5 * 60 * 1000;
    
    if (meta.lastRefresh && (now - meta.lastRefresh) < TTL) return;
    if (meta.refreshing) return;
    
    meta.refreshing = true;
    try {
      initializeProvider(providerName);
      const adapter = adapters[providerName];
      
      if (adapter.resolveModel) {
        await adapter.resolveModel();
        meta.model = adapter.getModel();
      }
      
      if (adapter.getContextWindow) {
        try {
          const contextWindow = await adapter.getContextWindow();
          if (contextWindow && contextWindow > 0) {
            meta.contextWindow = contextWindow;
            // Update context manager
            if (contextManagers[providerName]) {
              contextManagers[providerName].contextWindow = contextWindow;
            }
          }
        } catch (err) {
          console.warn(`[Router] Failed to get context window for ${providerName}: ${err.message}`);
        }
      }
      
      meta.lastRefresh = now;
    } catch (err) {
      console.warn(`[Router] Failed to refresh metadata for ${providerName}: ${err.message}`);
    } finally {
      meta.refreshing = false;
    }
  };
  
  return {
    async predict({ prompt, systemPrompt, provider, taskType, maxTokens, temperature, responseFormat }) {
      const providerName = provider || (taskType && taskDefaults[taskType]) || defaultProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        throw new Error(`Failed to initialize provider ${providerName}: ${err.message}`);
      }
      
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      
      // Lazy refresh metadata before prediction
      await refreshMetadata(providerName);
      
      const contextManager = contextManagers[providerName];
      if (!contextManager) throw new Error(`Context manager for ${providerName} not found`);
      
      const outputTokens = maxTokens || Math.floor(contextManager.contextWindow * 0.3);
      const available = contextManager.calculateAvailableTokens(systemPrompt, outputTokens);
      console.error(`[Router.predict] provider: ${providerName}, taskType: ${taskType || 'none'}, contextWindow: ${contextManager.contextWindow}, outputTokens: ${outputTokens}, available: ${available}, promptTokens: ${estimateTokens(prompt).tokens}`);
      
      let finalPrompt = prompt;
      // Only compact if prompt is large (>2k tokens) AND doesn't fit
      // Skip compaction for small prompts to avoid expansion issues
      const promptTokens = estimateTokens(prompt).tokens;
      if (promptTokens > 2000 && !contextManager.checkFits(prompt, available)) {
        try {
          finalPrompt = await contextManager.compact(prompt, available);
        } catch (err) {
          console.warn(`[Router] Failed to compact prompt: ${err.message}`);
        }
      }
      
      let rawOutput;
      try {
        if (process.env.DEBUG_ROUTER === '1') {
          console.error(`[Router.predict→${providerName}] systemPrompt: ${systemPrompt ? 'YES' : 'NO'} (${systemPrompt?.length || 0} chars)`);
        }
        rawOutput = await adapter.predict({
          prompt: finalPrompt,
          systemPrompt,
          maxTokens: outputTokens,
          temperature: temperature ?? 0.7,
          schema: responseFormat || null
        });
      } catch (err) {
        throw new Error(`Prediction failed for ${providerName}: ${err.message}`);
      }

      const providerConfig = providerConfigs[providerName];
      try {
        return formatOutput(rawOutput, {
          stripThinking: providerConfig?.stripThinking,
          extractJSON: !!responseFormat
        });
      } catch (err) {
        console.warn(`[Router] formatOutput failed: ${err.message}`);
        return rawOutput;
      }
    },
    
    async embedText(text, provider, model) {
      const providerName = provider || embeddingProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        throw new Error(`Failed to initialize provider ${providerName}: ${err.message}`);
      }
      
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.capabilities.embeddings) {
        throw new Error(`Provider ${providerName} doesn't support embeddings`);
      }
      
      try {
        return await adapter.embedText(text, model);
      } catch (err) {
        throw new Error(`Embedding failed for ${providerName}: ${err.message}`);
      }
    },
    
    async embedBatch(texts, provider, model) {
      const providerName = provider || embeddingProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        throw new Error(`Failed to initialize provider ${providerName}: ${err.message}`);
      }
      
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      
      if (!adapter.capabilities.embeddings) {
        throw new Error(`Provider ${providerName} doesn't support embeddings`);
      }
      
      try {
        if (adapter.capabilities.batch && adapter.embedBatch) {
          return await adapter.embedBatch(texts, model);
        }
        return Promise.all(texts.map(t => adapter.embedText(t, model)));
      } catch (err) {
        throw new Error(`Batch embedding failed for ${providerName}: ${err.message}`);
      }
    },
    
    getProviders() {
      return Object.keys(providerConfigs);
    },
    
    async listModels(provider) {
      const providerName = provider || defaultProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        throw new Error(`Failed to initialize provider ${providerName}: ${err.message}`);
      }
      
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.listModels) {
        throw new Error(`Provider ${providerName} doesn't support model listing`);
      }
      
      try {
        return await adapter.listModels();
      } catch (err) {
        throw new Error(`Failed to list models for ${providerName}: ${err.message}`);
      }
    },
    
    async getLoadedModel(provider) {
      const providerName = provider || defaultProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        throw new Error(`Failed to initialize provider ${providerName}: ${err.message}`);
      }
      
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.getLoadedModel) {
        throw new Error(`Provider ${providerName} doesn't support loaded model query`);
      }
      
      try {
        return await adapter.getLoadedModel();
      } catch (err) {
        throw new Error(`Failed to get loaded model for ${providerName}: ${err.message}`);
      }
    },
    
    async getRunningModels(provider) {
      const providerName = provider || defaultProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        return null;
      }
      
      const adapter = adapters[providerName];
      if (!adapter || !adapter.getRunningModels) return null;
      
      try {
        return await adapter.getRunningModels();
      } catch {
        return null;
      }
    },
    
    async showModelInfo(modelName, provider) {
      const providerName = provider || defaultProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        return null;
      }
      
      const adapter = adapters[providerName];
      if (!adapter || !adapter.showModelInfo) return null;
      
      try {
        return await adapter.showModelInfo(modelName);
      } catch {
        return null;
      }
    },

    async loadModel(modelName, provider, keepAlive) {
      const providerName = provider || defaultProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        throw new Error(`Failed to initialize provider ${providerName}: ${err.message}`);
      }
      
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.loadModel) {
        throw new Error(`Provider ${providerName} doesn't support model loading`);
      }
      
      try {
        return await adapter.loadModel(modelName, keepAlive);
      } catch (err) {
        throw new Error(`Failed to load model for ${providerName}: ${err.message}`);
      }
    },

    async unloadModel(modelName, provider) {
      const providerName = provider || defaultProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        throw new Error(`Failed to initialize provider ${providerName}: ${err.message}`);
      }
      
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.unloadModel) {
        throw new Error(`Provider ${providerName} doesn't support model unloading`);
      }
      
      try {
        return await adapter.unloadModel(modelName);
      } catch (err) {
        throw new Error(`Failed to unload model for ${providerName}: ${err.message}`);
      }
    },

    async getVersion(provider) {
      const providerName = provider || defaultProvider;
      
      try {
        initializeProvider(providerName);
      } catch (err) {
        return null;
      }
      
      const adapter = adapters[providerName];
      if (!adapter || !adapter.getVersion) return null;
      
      try {
        return await adapter.getVersion();
      } catch {
        return null;
      }
    },

    setProgressCallback(callback) {
      // Set callback on already initialized adapters
      Object.values(adapters).forEach(adapter => {
        if (adapter.setProgressCallback) adapter.setProgressCallback(callback);
      });
      // Store for future lazy-loaded adapters
      this._progressCallback = callback;
    },
    
    getAdapter(provider) {
      const providerName = provider || defaultProvider;
      try {
        initializeProvider(providerName);
        return adapters[providerName];
      } catch {
        return null;
      }
    },
    
    async refreshAllMetadata() {
      const promises = Object.keys(providerConfigs).map(name => refreshMetadata(name));
      await Promise.allSettled(promises);
    },
    
    getMetadata(provider) {
      const providerName = provider || defaultProvider;
      return metadata[providerName];
    },
    
    getAllMetadata() {
      return { ...metadata };
    }
  };
}
