export class DocsHelperServer {
  constructor(config) {
    this.config = config;
  }

  getTools() {
    return [
      {
        name: 'generate_jsdoc',
        description: 'Generate JSDoc comments for functions/classes',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Function or class code' },
            style: { type: 'string', description: 'Doc style: standard, terse, or detailed' }
          },
          required: ['code']
        }
      },
      {
        name: 'explain_api',
        description: 'Explain how to use an API or library feature',
        inputSchema: {
          type: 'object',
          properties: {
            api: { type: 'string', description: 'API name or feature' },
            context: { type: 'string', description: 'Usage context or example' }
          },
          required: ['api']
        }
      }
    ];
  }

  handlesTool(name) {
    return ['generate_jsdoc', 'explain_api'].includes(name);
  }

  async callTool(name, args) {
    if (name === 'generate_jsdoc') {
      const { code, style = 'standard' } = args;
      const doc = this.generateDoc(code, style);
      
      return {
        content: [{
          type: 'text',
          text: doc
        }]
      };
    }
    
    if (name === 'explain_api') {
      const { api, context } = args;
      const explanation = this.explainAPI(api, context);
      
      return {
        content: [{
          type: 'text',
          text: explanation
        }]
      };
    }
  }

  generateDoc(code, style) {
    const funcMatch = code.match(/(?:async\s+)?function\s+(\w+)\s*\((.*?)\)/);
    const classMatch = code.match(/class\s+(\w+)/);
    
    if (funcMatch) {
      const [, name, params] = funcMatch;
      const paramList = params.split(',').map(p => p.trim()).filter(Boolean);
      
      if (style === 'terse') {
        return `/** ${name}(${params}) */`;
      }
      
      let doc = '/**\n';
      doc += ` * ${name} - [Add description]\n`;
      if (paramList.length) doc += ' *\n';
      paramList.forEach(p => {
        const pName = p.split('=')[0].trim();
        doc += ` * @param {*} ${pName} - [Add description]\n`;
      });
      doc += ' * @returns {*} [Add description]\n';
      doc += ' */';
      
      return doc;
    }
    
    if (classMatch) {
      const [, name] = classMatch;
      return `/**\n * ${name} class\n * @class\n */`;
    }
    
    return '/** [Add documentation] */';
  }

  explainAPI(api, context) {
    const examples = {
      fetch: 'fetch(url, {method, headers, body}) - Returns Promise<Response>. Use await response.json() for JSON.',
      map: 'array.map(fn) - Transforms each element. Returns new array.',
      filter: 'array.filter(predicate) - Keeps elements where predicate is true. Returns new array.',
      reduce: 'array.reduce((acc, val) => newAcc, initial) - Accumulates values into single result.',
    };
    
    const apiLower = api.toLowerCase();
    const match = Object.keys(examples).find(k => apiLower.includes(k));
    
    if (match) {
      return `${api}:\n${examples[match]}${context ? `\n\nContext: ${context}` : ''}`;
    }
    
    return `${api}: [API documentation not found in cache. ${context || 'Check official docs.'}]`;
  }
}
