import { BaseLLMAdapter } from './base-adapter.js';

export class OpenAIAdapter extends BaseLLMAdapter {
  constructor(config) {
    super(config);
    
    if (!config.apiKey && !config.endpoint.includes('localhost')) {
      throw new Error('OpenAI API key is required (unless using local endpoint)');
    }

    this.apiKey = config.apiKey || 'not-needed-for-local';
    this.endpoint = config.endpoint || 'https://api.openai.com/v1/chat/completions';
    this.currentModel = config.model || 'gpt-4o';
    this._availableModels = [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4',
      'gpt-3.5-turbo',
      'o1-preview',
      'o1-mini'
    ];
  }

  async isConnected() {
    return true; // API-based, always "connected"
  }

  async connect() {
    // No explicit connection needed
  }

  async disconnect() {
    // No explicit disconnection needed
  }

  async listModels() {
    return this._availableModels.map(id => ({
      id,
      name: id,
      provider: 'openai'
    }));
  }

  async getLoadedModel() {
    return this.currentModel ? { id: this.currentModel } : null;
  }

  async loadModel(modelId) {
    if (!this._availableModels.includes(modelId)) {
      throw new Error(`Model "${modelId}" not available. Available: ${this._availableModels.join(', ')}`);
    }
    this.currentModel = modelId;
    return modelId;
  }

  async unloadModel(modelId) {
    if (this.currentModel === modelId) this.currentModel = null;
  }

  async predict({ prompt, systemPrompt, maxTokens, temperature, model }) {
    const modelId = model || this.currentModel;
    if (!modelId) throw new Error('No model specified');

    this.sendProgress(10, 100, `Generating with ${modelId}...`);

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const body = {
      model: modelId,
      messages,
      stream: false
    };

    if (maxTokens) body.max_tokens = maxTokens;
    if (temperature !== undefined) body.temperature = temperature;

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || '';

      this.sendProgress(100, 100, 'Complete');
      return text;
    } catch (err) {
      throw new Error(`Copilot prediction failed: ${err.message}`);
    }
  }

  async embedText(text) {
    // OpenAI embeddings would need different endpoint
    throw new Error('Embeddings not supported by OpenAI chat adapter (use dedicated embedding endpoint)');
  }

  getCapabilities() {
    return {
      streaming: true,
      embeddings: false,
      vision: false,
      toolUse: true,
      modelManagement: false,
      progressReporting: true
    };
  }
}
