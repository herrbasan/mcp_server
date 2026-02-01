import { LMStudioAdapter } from './lmstudio-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';

const DEFAULT_THINKING_TAGS = ['think', 'analysis', 'reasoning'];

/**
 * Robust thinking tag stripper adapted from LMStudioAPI.
 * Handles: encapsulated blocks, separator-style tags (orphan </think>), 
 * and mixed patterns.
 */
function createThinkingStripper(tags = DEFAULT_THINKING_TAGS) {
  const maxBuffer = 16384;
  let buffer = '';
  let inTag = null;

  const closeNeedleFor = (tagLower) => `</${tagLower}>`;

  const isOpenTagAt = (text, idx, tagLower) => {
    if (text[idx] !== '<') return false;
    if (text[idx + 1] !== tagLower[0]) return false;
    const after = text[idx + 1 + tagLower.length];
    return after === '>' || after === ' ' || after === '\t' || after === '\r' || after === '\n' || after === '/';
  };

  const findNextOpen = () => {
    const lower = buffer.toLowerCase();
    let bestIdx = -1, bestTag = null;
    for (const tag of tags) {
      const tagLower = String(tag).toLowerCase();
      let idx = lower.indexOf(`<${tagLower}`);
      while (idx !== -1) {
        if (isOpenTagAt(lower, idx, tagLower)) break;
        idx = lower.indexOf(`<${tagLower}`, idx + 1);
      }
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestTag = tagLower;
      }
    }
    return bestIdx === -1 ? null : { idx: bestIdx, tag: bestTag };
  };

  const findNextClose = () => {
    const lower = buffer.toLowerCase();
    let bestIdx = -1, bestTag = null;
    for (const tag of tags) {
      const tagLower = String(tag).toLowerCase();
      const idx = lower.indexOf(closeNeedleFor(tagLower));
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestTag = tagLower;
      }
    }
    return bestIdx === -1 ? null : { idx: bestIdx, tag: bestTag };
  };

  return {
    process(text) {
      if (!text) return '';
      buffer += String(text);
      if (buffer.length > maxBuffer) buffer = buffer.slice(-maxBuffer);

      let out = '';
      while (true) {
        if (inTag) {
          const closeNeedle = closeNeedleFor(inTag);
          const closeIdx = buffer.toLowerCase().indexOf(closeNeedle);
          if (closeIdx === -1) {
            buffer = buffer.slice(-(closeNeedle.length - 1));
            break;
          }
          buffer = buffer.slice(closeIdx + closeNeedle.length);
          inTag = null;
          continue;
        }

        const nextOpen = findNextOpen();
        const nextClose = findNextClose();

        // Handle orphan close tag (separator style: everything before </think> is thinking)
        if (nextClose && (!nextOpen || nextClose.idx < nextOpen.idx)) {
          buffer = buffer.slice(nextClose.idx + closeNeedleFor(nextClose.tag).length);
          continue;
        }

        if (!nextOpen) break;

        // Output content before the opening tag
        if (nextOpen.idx > 0) {
          out += buffer.slice(0, nextOpen.idx);
          buffer = buffer.slice(nextOpen.idx);
        }

        const gt = buffer.indexOf('>');
        if (gt === -1) break;

        buffer = buffer.slice(gt + 1);
        inTag = nextOpen.tag;
      }

      return out;
    },
    flush() {
      const out = inTag ? '' : buffer;
      buffer = '';
      inTag = null;
      return out;
    }
  };
}

function stripThinkingFromText(text, tags = DEFAULT_THINKING_TAGS) {
  if (!text || typeof text !== 'string') return text;
  const stripper = createThinkingStripper(tags);
  const result = stripper.process(text) + stripper.flush();
  return result.trim();
}

export class LLMRouter {
  constructor(config) {
    this.config = config;
    this.adapters = new Map();
    this.defaultProvider = config.defaultProvider || 'lmstudio';
    this.maxTokens = config.maxTokens || 32768;
    this.taskDefaults = config.taskDefaults || {};
    this.progressCallback = null;
    this.stripThinking = config.stripThinking !== false; // default true
    this.thinkingTags = Array.isArray(config.thinkingTags) ? config.thinkingTags : DEFAULT_THINKING_TAGS;
    this._initAdapters();
  }

  _initAdapters() {
    const providers = this.config.providers || {};

    for (const [name, providerConfig] of Object.entries(providers)) {
      if (!providerConfig.enabled) continue;

      try {
        // Inject centralized maxTokens if not set per-provider
        const configWithDefaults = {
          ...providerConfig,
          maxTokens: providerConfig.maxTokens || this.maxTokens
        };
        const adapter = this._createAdapter(name, configWithDefaults);
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

  async predict({ prompt, systemPrompt, maxTokens, temperature, model, provider, taskType = 'analysis', responseFormat }) {
    const adapter = this.getAdapter(provider, taskType);
    await adapter.connect();
    let response = await adapter.predict({ prompt, systemPrompt, maxTokens, temperature, model, responseFormat });
    
    if (this.stripThinking && response) {
      response = stripThinkingFromText(response, this.thinkingTags);
    }
    
    return response;
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

  /**
   * Batch embed multiple texts. Falls back to sequential if adapter doesn't support batch.
   * @param {string[]} texts - Array of texts to embed
   * @param {string} providerName - Optional provider override
   * @returns {Promise<number[][]>} Array of embeddings
   */
  async embedBatch(texts, providerName) {
    const adapter = this.getAdapter(providerName, 'embedding');
    const capabilities = adapter.getCapabilities();
    
    if (!capabilities.embeddings) {
      const resolvedName = this._resolveProvider(providerName, 'embedding');
      throw new Error(`Provider "${resolvedName}" does not support embeddings`);
    }
    
    await adapter.connect();
    
    // Use batch method if available, otherwise fall back to sequential
    if (typeof adapter.embedBatch === 'function') {
      return adapter.embedBatch(texts);
    }
    
    // Fallback: sequential embedding
    const results = [];
    for (const text of texts) {
      results.push(await adapter.embedText(text));
    }
    return results;
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
