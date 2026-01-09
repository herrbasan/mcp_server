export class CodeAnalyzerServer {
  constructor(config) {
    this.config = config;
  }

  getTools() {
    return [
      {
        name: 'analyze_code_quality',
        description: 'Analyze code for quality issues, complexity, and best practices',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Code to analyze' },
            language: { type: 'string', description: 'Programming language (js, py, etc)' }
          },
          required: ['code']
        }
      },
      {
        name: 'suggest_refactoring',
        description: 'Suggest refactoring improvements for code structure',
        inputSchema: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'Code to refactor' },
            focus: { type: 'string', description: 'Focus area: performance, readability, or maintainability' }
          },
          required: ['code']
        }
      }
    ];
  }

  handlesTool(name) {
    return ['analyze_code_quality', 'suggest_refactoring'].includes(name);
  }

  async callTool(name, args) {
    if (name === 'analyze_code_quality') {
      const { code, language = 'javascript' } = args;
      const issues = this.analyzeComplexity(code);
      
      return {
        content: [{
          type: 'text',
          text: `Code Analysis (${language}):\n${issues.map(i => `• ${i}`).join('\n')}`
        }]
      };
    }
    
    if (name === 'suggest_refactoring') {
      const { code, focus = 'readability' } = args;
      const suggestions = this.getRefactoringSuggestions(code, focus);
      
      return {
        content: [{
          type: 'text',
          text: `Refactoring Suggestions (${focus}):\n${suggestions.map(s => `• ${s}`).join('\n')}`
        }]
      };
    }
  }

  analyzeComplexity(code) {
    const issues = [];
    const lines = code.split('\n');
    
    if (lines.length > 50) issues.push(`Long function (${lines.length} lines) - consider splitting`);
    if ((code.match(/if\s*\(/g) || []).length > 5) issues.push('High cyclomatic complexity - too many conditionals');
    if ((code.match(/\.then\(/g) || []).length > 3) issues.push('Promise chain - consider async/await');
    if (/var\s/.test(code)) issues.push('Using var - prefer const/let');
    if (/(==|!=)/.test(code)) issues.push('Loose equality - use === or !==');
    
    return issues.length ? issues : ['No major issues detected'];
  }

  getRefactoringSuggestions(code, focus) {
    const suggestions = [];
    
    if (focus === 'performance') {
      if (/for\s*\(.*\.length/.test(code)) suggestions.push('Cache array length in loops');
      if (/forEach/.test(code)) suggestions.push('Consider for...of for better performance');
    } else if (focus === 'readability') {
      if (code.split('\n').length > 30) suggestions.push('Extract helper functions');
      if ((code.match(/\(/g) || []).length > 10) suggestions.push('Simplify nested calls');
    } else {
      suggestions.push('Extract magic numbers to constants');
      suggestions.push('Add error handling for edge cases');
    }
    
    return suggestions.length ? suggestions : ['Code structure looks good'];
  }
}
