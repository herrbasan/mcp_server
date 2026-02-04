// LMStudio adapter: pure function-based provider

export function createLMStudioAdapter(config) {
  const { httpEndpoint, embeddingModel } = config;
  let model = config.model; // mutable - can be resolved later
  
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(httpEndpoint);
  
  // Helper: get any loaded LLM model
  async function getAnyLoadedModel() {
    const response = await fetch(`${httpEndpoint}/api/v1/models`);
    if (!response.ok) return null;
    const data = await response.json();
    const loaded = data.models.find(m => m.type === 'llm' && m.loaded_instances?.length > 0);
    return loaded ? (loaded.id || loaded.key) : null;
  }
  
  // Helper: get first available LLM model
  async function getFirstAvailableModel() {
    const response = await fetch(`${httpEndpoint}/api/v1/models`);
    if (!response.ok) return null;
    const data = await response.json();
    const llm = data.models.find(m => m.type === 'llm');
    return llm ? (llm.id || llm.key) : null;
  }
  
  return {
    name: 'lmstudio',
    
    // Resolve model: loaded > config > first available
    async resolveModel() {
      if (model) return model;
      model = await getAnyLoadedModel();
      if (model) { console.log(`[lmstudio] Using loaded model: ${model}`); return model; }
      model = await getFirstAvailableModel();
      if (model) { console.log(`[lmstudio] Using first available model: ${model}`); return model; }
      throw new Error('No LLM models available in LM Studio');
    },
    
    getModel() { return model; },
    
    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) {
      if (!model) await this.resolveModel();
      
      const messages = [{ role: 'user', content: prompt }];
      if (systemPrompt) {
        messages.unshift({ role: 'system', content: systemPrompt });
      }
      
      const body = {
        model,
        messages,
        max_tokens: maxTokens || 2000,
        temperature: temperature ?? 0.3
      };
      
      // LMStudio requires OpenAI json_schema format
      if (schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'response', strict: true, schema }
        };
      }

      const response = await fetch(`${httpEndpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      
      if (!response.ok) {
        throw new Error(`LMStudio predict failed: ${response.status}`);
      }
      
      const data = await response.json();
      return data.choices[0].message.content;
    },
    
    async embedText(text) {
      const response = await fetch(`${httpEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, input: text })
      });
      
      if (!response.ok) {
        throw new Error(`LMStudio embed failed: ${response.status}`);
      }
      
      const data = await response.json();
      return data.data[0].embedding;
    },
    
    async embedBatch(texts) {
      const response = await fetch(`${httpEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, input: texts })
      });
      
      if (!response.ok) {
        throw new Error(`LMStudio embedBatch failed: ${response.status}`);
      }
      
      const data = await response.json();
      return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    },
    
    async getContextWindow() {
      const response = await fetch(`${httpEndpoint}/api/v1/models`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }
      
      const data = await response.json();
      const loaded = data.models.find(m => 
        m.type === 'llm' && 
        m.loaded_instances?.length > 0 &&
        (m.key === model || m.id === model)
      );
      
      if (!loaded) throw new Error(`Model ${model} not loaded`);
      return loaded.loaded_instances[0].config.context_length;
    },
    
    async listModels() {
      const response = await fetch(`${httpEndpoint}/api/v1/models`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }
      
      const data = await response.json();
      return data.models
        .filter(m => m.type === 'llm')
        .map(m => ({
          id: m.id || m.key,
          key: m.key,
          path: m.path,
          isLoaded: m.loaded_instances?.length > 0,
          contextLength: m.loaded_instances?.[0]?.config?.context_length,
          maxContextLength: m.max_context_length,
          architecture: m.architecture
        }));
    },
    
    async getLoadedModel() {
      const response = await fetch(`${httpEndpoint}/api/v1/models`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }
      
      const data = await response.json();
      const loaded = data.models.find(m => 
        m.type === 'llm' && 
        m.loaded_instances?.length > 0 &&
        (m.key === model || m.id === model)
      );
      
      if (!loaded) return null;
      
      return {
        id: loaded.id || loaded.key,
        key: loaded.key,
        path: loaded.path,
        contextLength: loaded.loaded_instances[0].config.context_length,
        architecture: loaded.architecture
      };
    },
    
    capabilities: {
      embeddings: true,
      structuredOutput: true,
      batch: true,
      modelManagement: true,
      local: isLocal
    }
  };
}
