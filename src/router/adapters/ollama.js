export function createOllamaAdapter(config) {
  const { httpEndpoint, embeddingModel } = config;
  let model = config.model; // mutable - can be resolved later
  
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(httpEndpoint);
  
  async function getAnyRunningModel(endpoint) {
    const response = await fetch(`${endpoint}/api/ps`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.models?.[0]?.name || null;
  }
  
  async function getFirstAvailableModel(endpoint) {
    const response = await fetch(`${endpoint}/api/tags`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.models?.[0]?.name || null;
  }
  
  return {
    name: 'ollama',
    
    async resolveModel() {
      if (model) return model;
      model = await getAnyRunningModel(httpEndpoint);
      if (model) { console.log(`[ollama] Using running model: ${model}`); return model; }
      model = await getFirstAvailableModel(httpEndpoint);
      if (model) { console.log(`[ollama] Using first available model: ${model}`); return model; }
      throw new Error('No models available in Ollama');
    },
    
    getModel() { return model; },
    
    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) {
      if (!model) await this.resolveModel();
      
      const body = {
        model,
        prompt,
        system: systemPrompt,
        stream: false,
        options: {
          temperature: temperature ?? 0.7
        }
      };
      
      if (maxTokens) body.options.num_predict = maxTokens;
      
      if (schema) {
        body.format = schema;
      }
      
      const response = await fetch(`${httpEndpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama predict failed: ${response.status} ${text}`);
      }
      
      const data = await response.json();
      return data.response || '';
    },
    
    async embedText(text, requestedModel) {
      const modelToUse = requestedModel || embeddingModel;
      const response = await fetch(`${httpEndpoint}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelToUse, input: text })
      });
      
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama embed failed: ${response.status} ${errText}`);
      }
      
      const data = await response.json();
      return data.embeddings?.[0] || [];
    },
    
    async embedBatch(texts, requestedModel) {
      const modelToUse = requestedModel || embeddingModel;
      const response = await fetch(`${httpEndpoint}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelToUse, input: texts })
      });
      
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama embedBatch failed: ${response.status} ${errText}`);
      }
      
      const data = await response.json();
      return data.embeddings || [];
    },
    
    async getContextWindow() {
      // Priority 1: Config override (allows limiting context window)
      if (config.contextWindow && config.contextWindow > 0) {
        return config.contextWindow;
      }
      
      // Priority 2: Get context length from model info
      try {
        const info = await this.showModelInfo(model);
        if (info?.model_info) {
          for (const [key, value] of Object.entries(info.model_info)) {
            if (key.includes('context_length')) return value;
          }
        }
      } catch {
        // Ignore errors, fall through to default
      }
      
      // Default fallback
      return 8192;
    },
    
    async listModels() {
      const response = await fetch(`${httpEndpoint}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }
      
      const data = await response.json();
      return (data.models || []).map(m => ({
        id: m.name,
        name: m.name,
        size: m.size,
        digest: m.digest,
        modified: m.modified_at,
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level
      }));
    },
    
    async getRunningModels() {
      const response = await fetch(`${httpEndpoint}/api/ps`);
      if (!response.ok) {
        throw new Error(`Failed to get running models: ${response.status}`);
      }
      
      const data = await response.json();
      return (data.models || []).map(m => ({
        name: m.name,
        size: m.size,
        sizeVram: m.size_vram,
        digest: m.digest,
        expiresAt: m.expires_at,
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level
      }));
    },
    
    async getLoadedModel() {
      const running = await this.getRunningModels();
      if (running.length === 0) return null;
      
      // Return first running model or the configured one if running
      const configured = running.find(m => m.name === model);
      return configured || running[0];
    },
    
    async showModelInfo(modelName) {
      const response = await fetch(`${httpEndpoint}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName || model })
      });
      
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Failed to show model info: ${response.status}`);
      }
      
      return response.json();
    },
    
    async loadModel(modelName, keepAlive = '5m') {
      const response = await fetch(`${httpEndpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          model: modelName || model,
          keep_alive: keepAlive
        })
      });
      
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to load model: ${response.status} ${text}`);
      }
      
      return response.json();
    },
    
    async unloadModel(modelName) {
      const response = await fetch(`${httpEndpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          model: modelName || model,
          keep_alive: 0
        })
      });
      
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to unload model: ${response.status} ${text}`);
      }
      
      return response.json();
    },
    
    async getVersion() {
      const response = await fetch(`${httpEndpoint}/api/version`);
      if (!response.ok) {
        throw new Error(`Failed to get version: ${response.status}`);
      }
      return response.json();
    },
    
    capabilities: {
      embeddings: true,
      structuredOutput: true,
      batch: true,              // /api/embed supports array input
      modelManagement: true,
      local: isLocal
    }
  };
}
