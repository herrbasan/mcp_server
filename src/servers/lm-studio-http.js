export class LMStudioServer {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.endpoint.replace('ws://', 'http://').replace(/\/$/, '');
    this.endpoint = this.baseUrl + '/v1/chat/completions';
    this.modelsEndpoint = this.baseUrl + '/v1/models';
    this.currentModel = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  async getAvailableModels() {
    try {
      const res = await fetch(this.modelsEndpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.data || [];
    } catch (err) {
      console.error('Failed to fetch models:', err.message);
      return [];
    }
  }

  async getLoadedModel() {
    const models = await this.getAvailableModels();
    return models.find(m => m.id !== 'N/A' && m.id) || null;
  }

  async unloadModel(modelId) {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId })
      });
      return res.ok;
    } catch (err) {
      console.error('Failed to unload model:', err.message);
      return false;
    }
  }

  async selectModel(modelId = null) {
    if (modelId) {
      const loaded = await this.getLoadedModel();
      if (loaded && loaded.id !== modelId) {
        this.sendProgress(0, 100, `Unloading ${loaded.id}...`);
        await this.unloadModel(loaded.id);
        await new Promise(r => setTimeout(r, 500));
      }
      this.currentModel = modelId;
      return modelId;
    }
    
    const loaded = await this.getLoadedModel();
    if (loaded) {
      this.currentModel = loaded.id;
      return loaded.id;
    }
    
    this.currentModel = this.config.model;
    return this.config.model;
  }

  getTools() {
    return [{
      name: 'get_second_opinion',
      description: 'Query local LM Studio model for alternative perspective on code/architecture decisions',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Question for the local model' },
          context: { type: 'string', description: 'Optional code or context' },
          model: { type: 'string', description: 'Optional: specific model to use (defaults to loaded model or config default)' }
        },
        required: ['question']
      }
    }];
  }

  getResources() {
    return [{
      uri: 'lmstudio://models',
      name: 'LM Studio Models',
      description: 'List of available and loaded models in LM Studio',
      mimeType: 'application/json'
    }];
  }

  handlesResource(uri) {
    return uri === 'lmstudio://models';
  }

  async readResource(uri) {
    const models = await this.getAvailableModels();
    const loaded = await this.getLoadedModel();
    
    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          loaded: loaded?.id || null,
          configured_default: this.config.model,
          current: this.currentModel,
          available: models.map(m => ({
            id: m.id,
            object: m.object,
            owned_by: m.owned_by
          }))
        }, null, 2)
      }]
    };
  }

  handlesTool(name) {
    return name === 'get_second_opinion';
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback(progress, total, message);
    }
  }

  async callTool(name, args) {
    const { question, context, model } = args;
    const prompt = context ? `${context}\n\nQuestion: ${question}` : question;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    
    try {
      const selectedModel = await this.selectModel(model);
      this.sendProgress(0, 100, `Using model: ${selectedModel}`);
      
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: 'system', content: this.config.systemPrompt },
            { role: 'user', content: prompt }
          ],
          temperature: this.config.temperature || 0.7,
          max_tokens: this.config.maxTokens || 500,
          stream: true
        }),
        signal: controller.signal
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      this.sendProgress(10, 100, 'Generating response...');
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      let chunkCount = 0;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.trim() && l.trim() !== 'data: [DONE]');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const json = JSON.parse(line.slice(6));
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                fullResponse += content;
                chunkCount++;
                if (chunkCount % 5 === 0) {
                  const progress = Math.min(10 + chunkCount, 95);
                  this.sendProgress(progress, 100, `Generating... (${chunkCount} chunks)`);
                }
              }
            } catch (e) {
              // Skip malformed JSON
            }
          }
        }
      }
      
      this.sendProgress(100, 100, 'Complete');
      
      return {
        content: [{
          type: 'text',
          text: fullResponse || '(No response generated)'
        }]
      };
    } catch (err) {
      const msg = err.name === 'AbortError' 
        ? 'Request timeout (60s)' 
        : err.message;
      
      return {
        content: [{
          type: 'text',
          text: `❌ LM Studio error: ${msg}\n\nEndpoint: ${this.endpoint}\nModel: ${this.currentModel || this.config.model}\n\nEnsure LM Studio is running with the model loaded.`
        }],
        isError: true
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
