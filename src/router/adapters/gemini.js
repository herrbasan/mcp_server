// Gemini adapter: Google AI REST API provider
// API Reference: https://ai.google.dev/api

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.0-flash'; // fallback if no model configured

export function createGeminiAdapter(config) {
  const { apiKey, embeddingModel, embeddingDimensions = 768 } = config;
  let model = config.model; // mutable - can be resolved later
  
  const headers = { 'Content-Type': 'application/json' };
  
  async function apiCall(endpoint, body) {
    const url = `${BASE_URL}/${endpoint}?key=${apiKey}`;
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
  
  // Helper: get first available model that supports generateContent
  // Prefer stable models (gemini-2.0, gemini-1.5) over experimental
  async function getFirstAvailableModel() {
    const url = `${BASE_URL}/models?key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    
    const genModels = (data.models || []).filter(m => 
      m.supportedGenerationMethods?.includes('generateContent') &&
      m.name?.includes('gemini')
    );
    
    // Prefer stable models: 2.0-flash, 1.5-flash, 1.5-pro, then any
    const preferred = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    for (const pref of preferred) {
      const match = genModels.find(m => m.name?.includes(pref));
      if (match) return match.name.replace('models/', '');
    }
    
    return genModels[0]?.name?.replace('models/', '') || null;
  }
  
  return {
    name: 'gemini',
    
    // Resolve model: config > first available > default
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
      
      // Gemini uses responseMimeType + responseSchema
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
    
    async embedText(text, taskType = 'RETRIEVAL_DOCUMENT') {
      const body = {
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: embeddingDimensions
      };
      
      const data = await apiCall(`models/${embeddingModel}:embedContent`, body);
      return data.embedding?.values || [];
    },
    
    async embedBatch(texts, taskType = 'RETRIEVAL_DOCUMENT') {
      // Use batchEmbedContents endpoint
      const requests = texts.map(text => ({
        model: `models/${embeddingModel}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: embeddingDimensions
      }));
      
      const body = { requests };
      const data = await apiCall(`models/${embeddingModel}:batchEmbedContents`, body);
      
      return (data.embeddings || []).map(e => e.values);
    },
    
    async getContextWindow() {
      // Gemini models have large context windows
      // gemini-2.5-flash: 1M tokens, gemini-2.5-pro: 1M tokens
      // gemini-3-flash-preview: 1M tokens
      if (model.includes('2.5') || model.includes('3')) return 1000000;
      if (model.includes('2.0')) return 1000000;
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
      // Cloud API - model always "loaded"
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
      modelManagement: false,  // Cloud API, no local model management
      local: false
    }
  };
}
