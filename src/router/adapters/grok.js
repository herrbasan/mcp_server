const DEFAULT_ENDPOINT = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4-1-fast-non-reasoning';

export function createGrokAdapter(config) {
  const { apiKey, endpoint = DEFAULT_ENDPOINT, embeddingModel = 'text-embedding-3-small' } = config;
  let model = config.model || DEFAULT_MODEL;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  async function apiPost(path, body) {
    const response = await fetch(`${endpoint}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Grok API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();
  }

  return {
    name: 'grok',

    getModel() { return model; },

    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) {
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: prompt });

      const body = {
        model,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens ?? 2048
      };

      if (schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            schema
          }
        };
      }

      const data = await apiPost('chat/completions', body);
      return data.choices[0].message.content;
    },

    async embedText(text, requestedModel) {
      const modelToUse = requestedModel || embeddingModel;
      const data = await apiPost('embeddings', { model: modelToUse, input: text });
      return data.data[0].embedding;
    },

    async embedBatch(texts, requestedModel) {
      const modelToUse = requestedModel || embeddingModel;
      const data = await apiPost('embeddings', { model: modelToUse, input: texts });
      return data.data.map(d => d.embedding);
    },

    async getContextWindow() {
      // Grok 4: 2,000,000 tokens
      // Grok 3: 131,072 tokens
      // Grok 2: 32,768 tokens
      const contextWindows = {
        'grok-4': 2000000,
        'grok-4-0709': 2000000,
        'grok-4-latest': 2000000,
        'grok-4-fast': 2000000,
        'grok-4-fast-reasoning': 2000000,
        'grok-4-fast-non-reasoning': 2000000,
        'grok-3': 131072,
        'grok-3-latest': 131072,
        'grok-3-fast': 131072,
        'grok-3-mini': 131072,
        'grok-2-vision': 32768,
        'grok-2-vision-1212': 32768,
        'grok-beta': 131072
      };
      return contextWindows[model] || 131072;
    },

    async listModels() {
      const data = await apiPost('models', {});
      return data.data.map(m => ({ id: m.id }));
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