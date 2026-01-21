import { BaseLLMAdapter } from './base-adapter.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export class GeminiAdapter extends BaseLLMAdapter {
  constructor(config) {
    super(config);
    
    if (!config.apiKey) {
      throw new Error('Google Gemini API key is required');
    }

    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.currentModel = config.model || 'gemini-2.0-flash-exp';
    this._availableModels = [
      'gemini-2.0-flash-exp',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
      'gemini-1.5-pro',
      'gemini-1.0-pro'
    ];
  }

  async isConnected() {
    return true; // API-based, always "connected" if API key is valid
  }

  async connect() {
    // No explicit connection needed for API
  }

  async disconnect() {
    // No explicit disconnection needed for API
  }

  async listModels() {
    return this._availableModels.map(id => ({
      id,
      name: id,
      provider: 'google'
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

    try {
      const genModel = this.genAI.getGenerativeModel({ model: modelId });
      
      const generationConfig = {};
      if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
      if (temperature !== undefined) generationConfig.temperature = temperature;

      const parts = [];
      if (systemPrompt) parts.push({ text: systemPrompt });
      parts.push({ text: prompt });

      const result = await genModel.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig
      });

      const response = await result.response;
      const text = response.text();

      this.sendProgress(100, 100, 'Complete');
      return text;
    } catch (err) {
      throw new Error(`Gemini prediction failed: ${err.message}`);
    }
  }

  async embedText(text) {
    const embeddingModel = this.config.embeddingModel || 'text-embedding-004';
    
    try {
      const model = this.genAI.getGenerativeModel({ model: embeddingModel });
      const result = await model.embedContent(text);
      return result.embedding?.values || [];
    } catch (err) {
      throw new Error(`Gemini embedding failed: ${err.message}`);
    }
  }

  getCapabilities() {
    return {
      streaming: true,
      embeddings: true,
      vision: true,
      toolUse: true,
      modelManagement: false,
      progressReporting: true
    };
  }
}
