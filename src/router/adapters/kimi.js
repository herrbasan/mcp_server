const DEFAULT_MODEL = 'kimi-k2.5';
const BASE_URL = 'https://api.moonshot.cn/v1';
const KIMI_CODE_URL = 'https://api.kimi.com/coding/v1';

export function createKimiAdapter(config) {
  const { apiKey, endpoint } = config;
  // Auto-detect Kimi Code platform (keys start with 'sk-kimi-')
  const baseUrl = endpoint || (apiKey?.startsWith('sk-kimi-') ? KIMI_CODE_URL : BASE_URL);
  let model = config.model || DEFAULT_MODEL;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Claude-Code/1.0'
  };

  async function apiPost(path, body) {
    const response = await fetch(`${baseUrl}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kimi API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();
  }

  return {
    name: 'kimi',

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

    async getContextWindow() {
      // Kimi K2.5: 256K tokens
      // Kimi K2 (older): 128K tokens
      const contextWindows = {
        'kimi-k2.5': 256000,
        'kimi-k2.5-preview': 256000,
        'kimi-k2-thinking-turbo': 256000,
        'kimi-k2': 128000,
        'kimi-k2-instruct': 128000
      };
      return contextWindows[model] || 256000;
    },

    async listModels() {
      const response = await fetch(`${baseUrl}/models`, { headers });
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
      embeddings: false,  // Moonshot doesn't provide embedding API
      structuredOutput: true,
      batch: false,
      modelManagement: false,
      local: false
    }
  };
}
