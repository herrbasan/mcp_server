// Multi-provider LLM router with context management

import { createLMStudioAdapter } from './adapters/lmstudio.js';
import { createOllamaAdapter } from './adapters/ollama.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createContextManager } from './context-manager.js';
import { formatOutput } from './formatter.js';
import { estimateTokens } from './tokenize.js';

export async function createRouter(config) {
  const adapters = {};
  const contextManagers = {};
  const metadata = {}; // Cache for model/context window info
  
  // Initialize adapters without blocking on model resolution
  for (const [name, providerConfig] of Object.entries(config.providers)) {
    if (!providerConfig.enabled) continue;
    
    metadata[name] = {
      contextWindow: providerConfig.contextWindow || 8192,
      model: providerConfig.model,
      lastRefresh: null,
      refreshing: false
    };
    
    if (providerConfig.type === 'lmstudio') {
      adapters[name] = createLMStudioAdapter({
        httpEndpoint: providerConfig.endpoint,
        model: providerConfig.model,
        embeddingModel: providerConfig.embeddingModel
      });
      
      contextManagers[name] = createContextManager({
        httpEndpoint: providerConfig.endpoint,
        contextWindow: metadata[name].contextWindow,
        model: providerConfig.model,
        maxTokens: 1000,
        temperature: 0.3
      });
    }
    
    if (providerConfig.type === 'ollama') {
      adapters[name] = createOllamaAdapter({
        httpEndpoint: providerConfig.endpoint,
        model: providerConfig.model,
        embeddingModel: providerConfig.embeddingModel,
        contextWindow: providerConfig.contextWindow
      });
      
      contextManagers[name] = createContextManager({
        httpEndpoint: providerConfig.endpoint,
        contextWindow: metadata[name].contextWindow,
        model: providerConfig.model,
        maxTokens: 1000,
        temperature: 0.3
      });
    }
    
    
    if (providerConfig.type === 'gemini') {
      adapters[name] = createGeminiAdapter({
        apiKey: providerConfig.apiKey,
        model: providerConfig.model,
        embeddingModel: providerConfig.embeddingModel || 'gemini-embedding-001',
        embeddingDimensions: providerConfig.embeddingDimensions || 768
      });
      
      // Gemini context window is fixed, no need to query
      metadata[name].contextWindow = 1048576; // 1M tokens
      
      contextManagers[name] = createContextManager({
        contextWindow: metadata[name].contextWindow,
        model: providerConfig.model,
        maxTokens: 2048,
        temperature: 1.0
      });
    }
  }
  
  const defaultProvider = config.defaultProvider;
  const embeddingProvider = config.embeddingProvider || defaultProvider;
  
  // Lazy refresh metadata for a provider (TTL: 5 minutes)
  const refreshMetadata = async (providerName) => {
    const meta = metadata[providerName];
    const now = Date.now();
    const TTL = 5 * 60 * 1000; // 5 minutes
    
    // Skip if recently refreshed or already refreshing
    if (meta.lastRefresh && (now - meta.lastRefresh) < TTL) return;
    if (meta.refreshing) return;
    
    meta.refreshing = true;
    try {
      const adapter = adapters[providerName];
      const providerConfig = config.providers[providerName];
      
      // Resolve model (what's actually running/loaded)
      if (adapter.resolveModel) {
        await adapter.resolveModel();
        meta.model = adapter.getModel();
      }
      
      // Get actual context window
      if (adapter.getContextWindow) {
        const contextWindow = await adapter.getContextWindow();
        if (contextWindow && contextWindow > 0) {
          meta.contextWindow = contextWindow;
          // Update context manager
          contextManagers[providerName].contextWindow = contextWindow;
        }
      }
      
      meta.lastRefresh = now;
    } catch (err) {
      // Silently fail - use cached/default values
      console.warn(`[Router] Failed to refresh metadata for ${providerName}: ${err.message}`);
    } finally {
      meta.refreshing = false;
    }
  };
  
  return {
    async predict({ prompt, systemPrompt, provider, maxTokens, temperature, responseFormat }) {
      const providerName = provider || defaultProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      
      // Lazy refresh metadata before prediction
      await refreshMetadata(providerName);
      
      const contextManager = contextManagers[providerName];
      if (!contextManager) throw new Error(`Context manager for ${providerName} not found`);
      
      const outputTokens = maxTokens || Math.floor(contextManager.contextWindow * 0.3);
      const available = contextManager.calculateAvailableTokens(systemPrompt, outputTokens);
      console.error(`[Router.predict] provider: ${providerName}, contextWindow: ${contextManager.contextWindow}, outputTokens: ${outputTokens}, available: ${available}, promptTokens: ${estimateTokens(prompt).tokens}`);
      
      let finalPrompt = prompt;
      // Only compact if prompt is large (>2k tokens) AND doesn't fit
      // Skip compaction for small prompts to avoid expansion issues
      const promptTokens = estimateTokens(prompt).tokens;
      if (promptTokens > 2000 && !contextManager.checkFits(prompt, available)) {
        finalPrompt = await contextManager.compact(prompt, available);
      }
      
      // Pass schema directly to adapter - each adapter handles its own format requirements
      const rawOutput = await adapter.predict({
        prompt: finalPrompt,
        systemPrompt,
        maxTokens: outputTokens,
        temperature: temperature ?? 0.7,
        schema: responseFormat || null
      });

      const providerConfig = config.providers[providerName];
      return formatOutput(rawOutput, {
        stripThinking: providerConfig?.stripThinking,
        extractJSON: !!responseFormat
      });
    },
    
    async embedText(text, provider) {
      const providerName = provider || embeddingProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.capabilities.embeddings) throw new Error(`Provider ${providerName} doesn't support embeddings`);
      return adapter.embedText(text);
    },
    
    async embedBatch(texts, provider) {
      const providerName = provider || embeddingProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      
      if (adapter.capabilities.batch && adapter.embedBatch) {
        return adapter.embedBatch(texts);
      }
      return Promise.all(texts.map(t => adapter.embedText(t)));
    },
    
    getProviders() {
      return Object.keys(adapters);
    },
    
    async listModels(provider) {
      const providerName = provider || defaultProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.listModels) throw new Error(`Provider ${providerName} doesn't support model listing`);
      return adapter.listModels();
    },
    
    async getLoadedModel(provider) {
      const providerName = provider || defaultProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.getLoadedModel) throw new Error(`Provider ${providerName} doesn't support loaded model query`);
      return adapter.getLoadedModel();
    },
    
    async getRunningModels(provider) {
      const providerName = provider || defaultProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.getRunningModels) return null;
      return adapter.getRunningModels();
    },
    
    async showModelInfo(modelName, provider) {
      const providerName = provider || defaultProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.showModelInfo) return null;
      return adapter.showModelInfo(modelName);
    },

    async loadModel(modelName, provider, keepAlive) {
      const providerName = provider || defaultProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.loadModel) throw new Error(`Provider ${providerName} doesn't support model loading`);
      return adapter.loadModel(modelName, keepAlive);
    },

    async unloadModel(modelName, provider) {
      const providerName = provider || defaultProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.unloadModel) throw new Error(`Provider ${providerName} doesn't support model unloading`);
      return adapter.unloadModel(modelName);
    },

    async getVersion(provider) {
      const providerName = provider || defaultProvider;
      const adapter = adapters[providerName];
      if (!adapter) throw new Error(`Provider ${providerName} not available`);
      if (!adapter.getVersion) return null;
      return adapter.getVersion();
    },

    setProgressCallback(callback) {
      Object.values(adapters).forEach(adapter => {
        if (adapter.setProgressCallback) adapter.setProgressCallback(callback);
      });
    },
    
    getAdapter(provider) {
      const providerName = provider || defaultProvider;
      return adapters[providerName];
    },
    
    // Manually refresh metadata for all providers (for maintenance loop)
    async refreshAllMetadata() {
      const promises = Object.keys(adapters).map(name => refreshMetadata(name));
      await Promise.allSettled(promises);
    },
    
    // Get current metadata for a provider
    getMetadata(provider) {
      const providerName = provider || defaultProvider;
      return metadata[providerName];
    },
    
    // Get all metadata
    getAllMetadata() {
      return { ...metadata };
    }
  };
}
