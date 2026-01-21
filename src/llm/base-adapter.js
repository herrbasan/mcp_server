export class BaseLLMAdapter {
  constructor(config) {
    this.config = config;
    this.progressCallback = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback(progress, total, message);
    }
  }

  // Must implement in derived classes
  async connect() {
    throw new Error('connect() must be implemented');
  }

  async disconnect() {
    throw new Error('disconnect() must be implemented');
  }

  async isConnected() {
    throw new Error('isConnected() must be implemented');
  }

  async listModels() {
    throw new Error('listModels() must be implemented');
  }

  async loadModel(modelId) {
    throw new Error('loadModel() must be implemented');
  }

  async unloadModel(modelId) {
    throw new Error('unloadModel() must be implemented');
  }

  async getLoadedModel() {
    throw new Error('getLoadedModel() must be implemented');
  }

  async predict({ prompt, systemPrompt, maxTokens, temperature, model }) {
    throw new Error('predict() must be implemented');
  }

  async embedText(text) {
    throw new Error('embedText() must be implemented');
  }

  getCapabilities() {
    return {
      streaming: false,
      embeddings: false,
      vision: false,
      toolUse: false,
      modelManagement: false,
      progressReporting: false
    };
  }

  getName() {
    return this.constructor.name.replace('Adapter', '');
  }
}
