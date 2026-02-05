export function createOpenAIAdapter(config) {
  const { endpoint = 'https://api.openai.com/v1', apiKey, embeddingModel } = config;
  let model = config.model || 'gpt-4o-mini';

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
      throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 200)}`);
    }

    return response.json();
  }

  return {
    name: 'openai',

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
      if (!embeddingModel) throw new Error('No embedding model configured');
      const data = await apiPost('embeddings', { model: embeddingModel, input: text });
      return data.data[0].embedding;
    },

    async embedBatch(texts, requestedModel) {
      if (!embeddingModel) throw new Error('No embedding model configured');
      const data = await apiPost('embeddings', { model: embeddingModel, input: texts });
      return data.data.map(d => d.embedding);
    },

    async getContextWindow() {
      return 131072; // Conservative for gpt-4o/grok-beta
    },

    async listModels() {
      const data = await apiPost('models', {});
      return data.data.slice(0, 10).map(m => ({ id: m.id })); // Top 10
    },

    capabilities: {
      embeddings: !!embeddingModel,
      structuredOutput: true,
      batch: true,
      modelManagement: false,
      local: false
    }
  };
}