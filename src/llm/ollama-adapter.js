import { BaseLLMAdapter } from './base-adapter.js';

export class OllamaAdapter extends BaseLLMAdapter {
  constructor(config) {
    super(config);
    this.baseUrl = config.endpoint || 'http://localhost:11434';
    this.currentModel = config.model || null;
    this._modelsCache = null;
    this._modelsCacheAt = 0;
  }

  async isConnected() {
    try {
      const response = await fetch(`${this.baseUrl}/api/version`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async connect() {
    const connected = await this.isConnected();
    if (!connected) {
      throw new Error(`Cannot connect to Ollama at ${this.baseUrl}`);
    }
  }

  async disconnect() {
    // Ollama is stateless HTTP
  }

  async listModels() {
    const now = Date.now();
    if (this._modelsCache && (now - this._modelsCacheAt) < 5000) return this._modelsCache;

    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const data = await response.json();
      const models = (data.models || []).map(m => ({
        id: m.name,
        name: m.name,
        size: m.size,
        digest: m.digest,
        modified: m.modified_at,
        details: m.details
      }));

      this._modelsCache = models;
      this._modelsCacheAt = now;
      return models;
    } catch (err) {
      throw new Error(`Failed to list Ollama models: ${err.message}`);
    }
  }

  async getLoadedModel() {
    // Ollama doesn't track "loaded" state via API
    return this.currentModel ? { id: this.currentModel } : null;
  }

  async loadModel(modelId) {
    const models = await this.listModels();
    const model = models.find(m => m.id === modelId || m.name === modelId);
    
    if (!model) {
      throw new Error(`Model "${modelId}" not found. Available: ${models.map(m => m.id).join(', ')}`);
    }

    this.currentModel = model.id;
    this.sendProgress(50, 100, `Model ${modelId} ready`);
    return model.id;
  }

  async unloadModel(modelId) {
    // Ollama handles model lifecycle internally
    if (this.currentModel === modelId) this.currentModel = null;
  }

  async predict({ prompt, systemPrompt, maxTokens, temperature, model }) {
    const modelId = model || this.currentModel || this.config.model;
    if (!modelId) throw new Error('No model specified');

    this.sendProgress(10, 100, `Generating with ${modelId}...`);

    const body = {
      model: modelId,
      prompt,
      stream: false,
      options: {}
    };

    if (systemPrompt) body.system = systemPrompt;
    if (maxTokens) body.options.num_predict = maxTokens;
    if (temperature !== undefined) body.options.temperature = temperature;

    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      this.sendProgress(100, 100, 'Complete');
      return data.response || '';
    } catch (err) {
      throw new Error(`Ollama prediction failed: ${err.message}`);
    }
  }

  async embedText(text) {
    const modelId = this.config.embeddingModel || 'mxbai-embed-large';
    
    try {
      const response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          prompt: text
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      return data.embedding || [];
    } catch (err) {
      throw new Error(`Ollama embedding failed: ${err.message}`);
    }
  }

  getCapabilities() {
    return {
      streaming: true,
      embeddings: true,
      vision: false,
      toolUse: false,
      modelManagement: false,
      progressReporting: true
    };
  }
}
