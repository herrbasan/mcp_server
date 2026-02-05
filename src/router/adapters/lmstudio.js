export function createLMStudioAdapter(config) {
  const { httpEndpoint, embeddingModel: defaultEmbeddingModel } = config;
  let llmModel = config.model;
  let loadedLlmModel = null;
  let loadedEmbeddingModel = null;
  
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(httpEndpoint);
  
  async function apiGet(path) {
    const response = await fetch(`${httpEndpoint}${path}`);
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
    return response.json();
  }
  
  async function apiPost(path, body) {
    const response = await fetch(`${httpEndpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`POST ${path} failed: ${response.status} ${text}`);
    }
    return response.json();
  }
  
  async function getLoadedModels() {
    try {
      const data = await apiGet('/api/v1/models');
      return {
        llm: data.models.find(m => m.type === 'llm' && m.loaded_instances?.length > 0),
        embedding: data.models.find(m => m.type === 'embedding' && m.loaded_instances?.length > 0)
      };
    } catch {
      return { llm: null, embedding: null };
    }
  }
  
  async function loadModel(modelId, type = 'llm') {
    if (!modelId) return false;
    
    const data = await apiGet('/api/v1/models');
    const modelInfo = data.models.find(m => m.key === modelId || m.id === modelId);
    
    // Check if any instance of this model is already loaded (by key, not instance ID)
    if (modelInfo?.loaded_instances?.length > 0) {
      console.log(`[lmstudio] ${type} model ${modelId} already loaded (${modelInfo.loaded_instances.length} instance(s))`);
      if (type === 'llm') loadedLlmModel = modelId;
      else loadedEmbeddingModel = modelId;
      return true;
    }
    
    console.log(`[lmstudio] Loading ${type} model: ${modelId}`);
    try {
      await apiPost('/api/v1/models/load', { model: modelId });
      
      if (type === 'llm') loadedLlmModel = modelId;
      else loadedEmbeddingModel = modelId;
      
      return true;
    } catch (err) {
      console.error(`[lmstudio] Failed to load ${type} model ${modelId}:`, err.message);
      return false;
    }
  }
  
  async function resolveLlmModel() {
    const loaded = await getLoadedModels();
    
    if (loaded.llm) {
      const modelId = loaded.llm.id || loaded.llm.key;
      llmModel = modelId;
      loadedLlmModel = modelId;
      return modelId;
    }
    
    if (llmModel) {
      await loadModel(llmModel, 'llm');
      return llmModel;
    }
    
    const data = await apiGet('/api/v1/models');
    const firstLlm = data.models.find(m => m.type === 'llm');
    if (firstLlm) {
      const modelId = firstLlm.id || firstLlm.key;
      llmModel = modelId;
      await loadModel(modelId, 'llm');
      return modelId;
    }
    
    throw new Error('No LLM models available in LM Studio');
  }
  
  async function resolveEmbeddingModel(requestedModel) {
    const modelToUse = requestedModel || defaultEmbeddingModel;
    if (!modelToUse) {
      throw new Error('No embedding model specified');
    }
    
    const loaded = await getLoadedModels();
    
    if (loaded.embedding && (loaded.embedding.id === modelToUse || loaded.embedding.key === modelToUse)) {
      loadedEmbeddingModel = modelToUse;
      return modelToUse;
    }
    
    await loadModel(modelToUse, 'embedding');
    return modelToUse;
  }
  
  return {
    name: 'lmstudio',
    
    async resolveModel() {
      return resolveLlmModel();
    },
    
    getModel() { return llmModel || loadedLlmModel; },
    
    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) {
      const modelToUse = await resolveLlmModel();
      
      const messages = [{ role: 'user', content: prompt }];
      if (systemPrompt) {
        messages.unshift({ role: 'system', content: systemPrompt });
      }
      
      const body = {
        model: modelToUse,
        messages,
        max_tokens: maxTokens || 2000,
        temperature: temperature ?? 0.3
      };
      
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
    
    async embedText(text, requestedModel) {
      const modelToUse = await resolveEmbeddingModel(requestedModel);
      
      const response = await fetch(`${httpEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelToUse, input: text })
      });
      
      if (!response.ok) {
        throw new Error(`LMStudio embed failed: ${response.status}`);
      }
      
      const data = await response.json();
      return data.data[0].embedding;
    },
    
    async embedBatch(texts, requestedModel) {
      const modelToUse = await resolveEmbeddingModel(requestedModel);
      
      const response = await fetch(`${httpEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelToUse, input: texts })
      });
      
      if (!response.ok) {
        throw new Error(`LMStudio embedBatch failed: ${response.status}`);
      }
      
      const data = await response.json();
      return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    },
    
    async getContextWindow() {
      const loaded = await getLoadedModels();
      if (!loaded.llm) throw new Error('No LLM loaded');
      
      const modelToCheck = llmModel || loadedLlmModel;
      const model = loaded.llm.key === modelToCheck || loaded.llm.id === modelToCheck 
        ? loaded.llm 
        : null;
        
      if (!model) throw new Error(`Model ${modelToCheck} not loaded`);
      return model.loaded_instances[0].config.context_length;
    },
    
    async listModels() {
      const data = await apiGet('/api/v1/models');
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
      const loaded = await getLoadedModels();
      if (!loaded.llm) return null;
      
      return {
        id: loaded.llm.id || loaded.llm.key,
        key: loaded.llm.key,
        path: loaded.llm.path,
        contextLength: loaded.llm.loaded_instances[0].config.context_length,
        architecture: loaded.llm.architecture
      };
    },
    
    async loadModel(modelName, keepAlive) {
      return loadModel(modelName, 'llm');
    },
    
    async unloadModel(modelName) {
      try {
        const loaded = await getLoadedModels();
        const model = loaded.llm?.key === modelName ? loaded.llm : 
                     loaded.embedding?.key === modelName ? loaded.embedding : null;
        if (!model?.loaded_instances?.[0]) {
          console.log(`[lmstudio] Model ${modelName} not loaded, nothing to unload`);
          return true;
        }
        await apiPost('/api/v1/models/unload', { instance_id: model.loaded_instances[0].id });
        if (loadedLlmModel === modelName) loadedLlmModel = null;
        if (loadedEmbeddingModel === modelName) loadedEmbeddingModel = null;
        return true;
      } catch (err) {
        console.error(`[lmstudio] Failed to unload model ${modelName}:`, err.message);
        return false;
      }
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
