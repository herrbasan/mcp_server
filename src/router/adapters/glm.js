const DEFAULT_ENDPOINT = 'https://api.z.ai/api/paas/v4';
const DEFAULT_MODEL = 'glm-5';

export function createGLMAdapter(config) {
  const { apiKey, endpoint = DEFAULT_ENDPOINT } = config;
  let model = config.model || DEFAULT_MODEL;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US,en'
  };

  async function apiPost(path, body) {
    const response = await fetch(`${endpoint}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GLM API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();
  }

  return {
    name: 'glm',

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
      throw new Error('GLM adapter does not support embeddings - z.ai API has no embeddings endpoint');
    },

    async embedBatch(texts, requestedModel) {
      throw new Error('GLM adapter does not support embeddings - z.ai API has no embeddings endpoint');
    },

    async getContextWindow() {
      // GLM-5: 128k tokens
      // GLM-4: 128k tokens
      // GLM-4V: 8k tokens
      const contextWindows = {
        'glm-5': 131072,
        'glm-4': 131072,
        'glm-4-plus': 131072,
        'glm-4-flash': 131072,
        'glm-4-air': 131072,
        'glm-4-airx': 8192,
        'glm-4v': 8192,
        'glm-4v-plus': 8192
      };
      return contextWindows[model] || 131072;
    },

    async listModels() {
      const data = await apiPost('models', {});
      return data.data.map(m => ({ id: m.id }));
    },

    capabilities: {
      embeddings: false,
      structuredOutput: true,
      batch: false,
      modelManagement: false,
      local: false
    }
  };
}
