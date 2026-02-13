const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.0-flash';

export function createGeminiAdapter(config) {
  const { apiKey, endpoint = DEFAULT_ENDPOINT, embeddingModel, embeddingDimensions = 768 } = config;
  let model = config.model; // mutable - can be resolved later
  
  const headers = { 'Content-Type': 'application/json' };
  
  async function apiCall(apiEndpoint, body) {
    const url = `${endpoint}/${apiEndpoint}?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${text}`);
    }
    
    return response.json();
  }
  
  async function getFirstAvailableModel() {
    const url = `${BASE_URL}/models?key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    
    const genModels = (data.models || []).filter(m => 
      m.supportedGenerationMethods?.includes('generateContent') &&
      m.name?.includes('gemini')
    );
    
    const preferred = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    for (const pref of preferred) {
      const match = genModels.find(m => m.name?.includes(pref));
      if (match) return match.name.replace('models/', '');
    }
    
    return genModels[0]?.name?.replace('models/', '') || null;
  }
  
  return {
    name: 'gemini',
    
    async resolveModel() {
      if (model) return model;
      model = await getFirstAvailableModel();
      if (model) { console.log(`[gemini] Using first available model: ${model}`); return model; }
      model = DEFAULT_MODEL;
      console.log(`[gemini] Using default model: ${model}`);
      return model;
    },
    
    getModel() { return model; },
    
    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) {
      if (!model) await this.resolveModel();
      
      const contents = [{ role: 'user', parts: [{ text: prompt }] }];
      
      const generationConfig = {
        temperature: temperature ?? 1.0,
        maxOutputTokens: maxTokens || 2048
      };
      
        if (schema) {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = schema;
      }
      
      const body = { contents, generationConfig };
      
      if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
      }
      
      const data = await apiCall(`models/${model}:generateContent`, body);
      
      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts?.[0]?.text) {
        throw new Error('No content in Gemini response');
      }
      
      return candidate.content.parts[0].text;
    },
    
    async embedText(text, requestedModel, taskType = 'RETRIEVAL_DOCUMENT') {
      const modelToUse = requestedModel || embeddingModel;
      const body = {
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: embeddingDimensions
      };
      
      const data = await apiCall(`models/${modelToUse}:embedContent`, body);
      return data.embedding?.values || [];
    },
    
    async embedBatch(texts, requestedModel, taskType = 'RETRIEVAL_DOCUMENT') {
      const modelToUse = requestedModel || embeddingModel;
      const requests = texts.map(text => ({
        model: `models/${modelToUse}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: embeddingDimensions
      }));
      
      const body = { requests };
      const data = await apiCall(`models/${modelToUse}:batchEmbedContents`, body);
      
      return (data.embeddings || []).map(e => e.values);
    },
    
    async getContextWindow() {
      try {
        const modelInfo = await apiCall(`models/${model}`, null, 'GET');
        if (modelInfo.inputTokenLimit) {
          return modelInfo.inputTokenLimit;
        }
      } catch {
      }
      

      if (model.includes('2.5') || model.includes('3')) return 1048576;
      if (model.includes('2.0')) return 1048576;
      if (model.includes('latest')) return 1048576; // Aliases like flash-latest
      if (model.includes('pro')) return 1048576;
      if (model.includes('flash')) return 1048576;
      return 128000; // Conservative default
    },
    
    async listModels() {
      const url = `${BASE_URL}/models?key=${apiKey}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }
      
      const data = await response.json();
      return (data.models || []).map(m => ({
        id: m.name.replace('models/', ''),
        name: m.displayName,
        description: m.description,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        supportedGenerationMethods: m.supportedGenerationMethods
      }));
    },
    
    async getLoadedModel() {
      return { id: model, name: model };
    },
    
    async countTokens(text) {
      const body = {
        contents: [{ parts: [{ text }] }]
      };
      
      const data = await apiCall(`models/${model}:countTokens`, body);
      return data.totalTokens || 0;
    },
    
    capabilities: {
      embeddings: true,
      structuredOutput: true,
      batch: true,
      modelManagement: false,
      local: false
    }
  };
}
