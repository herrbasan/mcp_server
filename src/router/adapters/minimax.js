const DEFAULT_ENDPOINT = 'https://api.minimax.io/anthropic';
const DEFAULT_MODEL = 'MiniMax-M2.5';

export function createMiniMaxAdapter(config) {
  const { apiKey, endpoint = DEFAULT_ENDPOINT, embeddingModel } = config;
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
      throw new Error(`MiniMax API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();
  }

  return {
    name: 'minimax',

    getModel() { return model; },

    async predict({ prompt, systemPrompt, maxTokens, temperature, schema }) {
      const messages = [{ role: 'user', content: prompt }];

      const body = {
        model,
        messages,
        max_tokens: maxTokens ?? 2048,
        temperature: temperature ?? 0.7
      };

      if (systemPrompt) {
        body.system = systemPrompt;
      }

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

      const data = await apiPost('v1/messages', body);
      
      // Anthropic Messages API response format
      if (data.content && data.content.length > 0) {
        const textBlock = data.content.find(b => b.type === 'text');
        if (textBlock) return textBlock.text;
      }
      
      throw new Error('Unexpected response format from MiniMax API');
    },

    async getContextWindow() {
      // MiniMax models: 204,800 tokens context window
      const contextWindows = {
        'MiniMax-M2.5': 204800,
        'MiniMax-M2.5-highspeed': 204800,
        'MiniMax-M2.1': 204800,
        'MiniMax-M2.1-highspeed': 204800,
        'MiniMax-M2': 204800
      };
      return contextWindows[model] || 204800;
    },

    async listModels() {
      const response = await fetch(`${endpoint}/v1/models`, { headers });
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }
      const data = await response.json();
      return data.data.map(m => ({ id: m.id }));
    },

    async getLoadedModel() {
      return { id: model, name: model };
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
