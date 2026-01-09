export class LMStudioServer {
  constructor(config) {
    this.endpoint = config.endpoint;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt;
  }

  getTools() {
    return [{
      name: 'get_second_opinion',
      description: 'Query local LM Studio model for alternative perspective on code/architecture decisions',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Question for the local model' },
          context: { type: 'string', description: 'Optional code or context' }
        },
        required: ['question']
      }
    }];
  }

  handlesTool(name) {
    return name === 'get_second_opinion';
  }

  async callTool(name, args) {
    const { question, context } = args;
    const prompt = context ? `${context}\n\nQuestion: ${question}` : question;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 500
        }),
        signal: controller.signal
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      const data = await res.json();
      
      if (!data?.choices?.[0]?.message?.content) {
        throw new Error('Invalid response format from LM Studio');
      }
      
      return {
        content: [{
          type: 'text',
          text: data.choices[0].message.content
        }]
      };
    } catch (err) {
      const msg = err.name === 'AbortError' 
        ? 'Request timeout (30s)' 
        : err.message;
      
      return {
        content: [{
          type: 'text',
          text: `❌ LM Studio error: ${msg}\n\nEndpoint: ${this.endpoint}\nModel: ${this.model}\n\nEnsure LM Studio is running with the model loaded.`
        }],
        isError: true
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
