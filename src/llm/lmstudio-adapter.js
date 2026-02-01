import { BaseLLMAdapter } from './base-adapter.js';

export class LMStudioAdapter extends BaseLLMAdapter {
  constructor(config) {
    super(config);
    this.baseUrl = config.endpoint || 'http://localhost:1234';
    this.authToken = config.authToken || config.apiKey || null;
    this.requestTimeoutMs = config.requestTimeoutMs || 300000; // 5 min default for long generations
    this._modelsCache = null;
    this._modelsCacheAt = 0;
    this._modelLoadPromise = null;
    this._modelLoadKey = null;
    this._lastStatus = null;
    this._modelLastUsed = new Map();
    this._ttlCheckInterval = null;
    this._defaultModelTtlMs = config.defaultModelTtlMs || 60 * 60 * 1000;
    this._nonDefaultModelTtlMs = config.nonDefaultModelTtlMs || 10 * 60 * 1000;
  }

  _getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
    return headers;
  }

  _handleHttpError(res, context) {
    const status = res.status;
    if (status === 401 || status === 403) {
      throw new Error(`${context}: Authentication failed (${status})`);
    } else if (status === 404) {
      throw new Error(`${context}: Resource not found (${status})`);
    } else if (status === 429) {
      throw new Error(`${context}: Rate limited (${status})`);
    } else if (status >= 500) {
      throw new Error(`${context}: Server error (${status})`);
    } else {
      throw new Error(`${context}: HTTP ${status}`);
    }
  }

  _sendStatus(progress, message) {
    if (!message || message === this._lastStatus) return;
    this._lastStatus = message;
    this.sendProgress(progress, 100, message);
  }

  async isConnected() {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/models`, { headers: this._getHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async connect() {
    const connected = await this.isConnected();
    if (!connected) throw new Error(`Cannot connect to LM Studio at ${this.baseUrl}`);
  }

  async disconnect() {
    if (this._ttlCheckInterval) {
      clearInterval(this._ttlCheckInterval);
      this._ttlCheckInterval = null;
    }
  }

  async listModels() {
    const now = Date.now();
    if (this._modelsCache && (now - this._modelsCacheAt) < 1500) return this._modelsCache;

    const res = await fetch(`${this.baseUrl}/api/v1/models`, { headers: this._getHeaders() });
    if (!res.ok) this._handleHttpError(res, 'Failed to list models');
    
    const data = await res.json();
    const mapped = (data.models || [])
      .filter(m => m.type === 'llm')
      .map(m => ({
        id: m.key,
        path: m.key,
        modelKey: m.key,
        displayName: m.display_name,
        isLoaded: m.loaded_instances?.length > 0,
        loadedInstances: m.loaded_instances || [],
        contextLength: m.loaded_instances?.[0]?.config?.context_length,
        maxContextLength: m.max_context_length,
        supportsVision: m.capabilities?.vision,
        supportsToolUse: m.capabilities?.trained_for_tool_use
      }));

    this._modelsCache = mapped;
    this._modelsCacheAt = now;
    return mapped;
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

    if (model.isLoaded) return model.modelKey;

    const modelKey = model.modelKey;

    if (this._modelLoadPromise && this._modelLoadKey === modelKey) {
      return this._modelLoadPromise;
    }

    this._modelLoadKey = modelKey;
    this._modelLoadPromise = this._loadModelInternal(modelKey, available);

    try {
      await this._modelLoadPromise;
      return modelKey;
    } finally {
      this._modelLoadPromise = null;
      this._modelLoadKey = null;
    }
  }

  async _loadModelInternal(modelKey, available) {
    // Unload any currently loaded models first (enforce single model)
    for (const m of available) {
      if (!m.isLoaded) continue;
      for (const inst of m.loadedInstances) {
        const instId = typeof inst === 'string' ? inst : inst.id;
        await fetch(`${this.baseUrl}/api/v1/models/unload`, {
          method: 'POST',
          headers: this._getHeaders(),
          body: JSON.stringify({ instance_id: instId })
        });
      }
    }

    this._sendStatus(10, `Loading ${modelKey}...`);

    const res = await fetch(`${this.baseUrl}/api/v1/models/load`, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({ model: modelKey })
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Failed to load model "${modelKey}": ${err || `HTTP ${res.status}`}`);
    }

    this._modelsCache = null;
    this._sendStatus(35, `Model ${modelKey} loaded`);
  }

  async unloadModel(modelId) {
    const models = await this.listModels();
    const model = models.find(m => (m.id === modelId || m.modelKey === modelId) && m.isLoaded);
    if (!model) return;

    for (const inst of model.loadedInstances) {
      const instId = typeof inst === 'string' ? inst : inst.id;
      await fetch(`${this.baseUrl}/api/v1/models/unload`, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify({ instance_id: instId })
      });
    }

    this._modelLastUsed.delete(model.modelKey);
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
    try {
      const models = await this.listModels();
      const now = Date.now();

      for (const model of models) {
        if (!model.isLoaded) continue;

        const modelKey = model.modelKey;
        const lastUsed = this._modelLastUsed.get(modelKey);
        if (!lastUsed) continue;

        const isDefault = modelKey === this.config.model;
        const ttl = isDefault ? this._defaultModelTtlMs : this._nonDefaultModelTtlMs;

        if (now - lastUsed > ttl) {
          await this.unloadModel(modelKey);
        }
      }
    } catch {
      // Ignore TTL check errors
    }
  }

  // JSON Schema for agent tool calls - enforced at token level via llama.cpp grammar
  static TOOL_CALL_SCHEMA = {
    type: 'json_schema',
    json_schema: {
      name: 'tool_call',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'Name of the tool to call' },
          args: { type: 'object', description: 'Arguments to pass to the tool' }
        },
        required: ['tool', 'args']
      }
    }
  };

  async predict({ prompt, systemPrompt, maxTokens, temperature, model, responseFormat }) {
    await this.connect();

    const available = await this.listModels();
    let selectedModel = null;

    if (model) {
      const found = available.find(m => m.id === model || m.modelKey === model);
      if (!found) throw new Error(`Model "${model}" not found`);
      selectedModel = found.modelKey;
    } else {
      const loaded = await this.getLoadedModel();
      if (loaded) {
        selectedModel = loaded.modelKey;
      } else if (this.config.model) {
        const defaultModel = available.find(m => m.id === this.config.model || m.modelKey === this.config.model);
        if (defaultModel) selectedModel = defaultModel.modelKey;
      }
      if (!selectedModel && available.length > 0) {
        selectedModel = available[0].modelKey;
      }
    }

    if (!selectedModel) throw new Error('No model available');

    this._sendStatus(5, 'Ensuring model loaded...');
    await this.loadModel(selectedModel);
    this._trackModelUsage(selectedModel);
    this._startTtlMonitoring();

    this._sendStatus(35, 'Generating response...');

    // Setup timeout via AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      // Use OpenAI-compatible endpoint when structured output is requested
      // This leverages llama.cpp grammar-based sampling for guaranteed valid JSON
      if (responseFormat) {
        return await this._predictStructured({
          model: selectedModel, prompt, systemPrompt, maxTokens, temperature, responseFormat, controller
        });
      }

      const res = await fetch(`${this.baseUrl}/api/v1/chat`, {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify({
          model: selectedModel,
          input: prompt,
          ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
          max_output_tokens: maxTokens || this.config.maxTokens,
          ...(temperature !== undefined ? { temperature } : {}),
          reasoning: this.config.reasoning || 'off',
          stream: true
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        if (res.status === 404) throw new Error(`Model "${selectedModel}" not found or not loaded`);
        this._handleHttpError(res, `Prediction failed${err ? ': ' + err : ''}`);
      }

      // Parse SSE stream
      const fullResponse = await this._parseSSEStream(res, controller.signal);
      this._sendStatus(100, 'Complete');
      return fullResponse;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.requestTimeoutMs / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Structured output via OpenAI-compatible endpoint with JSON schema enforcement
  async _predictStructured({ model, prompt, systemPrompt, maxTokens, temperature, responseFormat, controller }) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({
        model,
        messages,
        response_format: responseFormat,
        max_tokens: maxTokens || this.config.maxTokens,
        ...(temperature !== undefined ? { temperature } : {}),
        stream: false  // Structured output works best non-streaming
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      this._handleHttpError(res, `Structured prediction failed${err ? ': ' + err : ''}`);
    }

    const data = await res.json();
    this._sendStatus(100, 'Complete');
    return data.choices?.[0]?.message?.content || '';
  }

  async _parseSSEStream(res, signal) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const chunks = [];

    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) continue;
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (!data) continue;

          try {
            const evt = JSON.parse(data);

            if (evt.type === 'model_load.progress') {
              const pct = Math.round((evt.progress || 0) * 100);
              this._sendStatus(10 + pct * 0.25, `Loading ${pct}%`);
            } else if (evt.type === 'prompt_processing.progress') {
              const pct = Math.round((evt.progress || 0) * 100);
              this._sendStatus(35 + pct * 0.15, `Processing ${pct}%`);
            } else if (evt.type === 'message.delta') {
              if (evt.content) chunks.push(evt.content);
            } else if (evt.type === 'error') {
              throw new Error(evt.error?.message || 'Stream error');
            }
          } catch (parseErr) {
            if (parseErr.message === 'Stream error' || parseErr.name === 'AbortError') throw parseErr;
            // Ignore JSON parse errors for malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return chunks.join('');
  }

  async embedText(text) {
    await this.connect();

    if (!this.config.embeddingModel) {
      throw new Error('No embedding model configured');
    }

    // Use OpenAI-compatible endpoint for embeddings
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({
        model: this.config.embeddingModel,
        input: text
      })
    });

    if (!res.ok) {
      this._handleHttpError(res, 'Embedding failed');
    }

    const data = await res.json();
    return data.data?.[0]?.embedding || [];
  }

  /**
   * Batch embed multiple texts in a single request.
   * Much faster than individual embedText() calls.
   * @param {string[]} texts - Array of texts to embed
   * @returns {Promise<number[][]>} Array of embeddings in same order as input
   */
  async embedBatch(texts) {
    await this.connect();

    if (!this.config.embeddingModel) {
      throw new Error('No embedding model configured');
    }

    if (!texts.length) return [];

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: this._getHeaders(),
      body: JSON.stringify({
        model: this.config.embeddingModel,
        input: texts
      })
    });

    if (!res.ok) {
      this._handleHttpError(res, 'Batch embedding failed');
    }

    const data = await res.json();
    // Sort by index to ensure order matches input
    const sorted = (data.data || []).sort((a, b) => a.index - b.index);
    return sorted.map(d => d.embedding || []);
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
