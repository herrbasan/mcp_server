/**
 * Test: Query local LLM for HTML stripping strategies
 */
import { LLMRouter } from '../src/llm/router.js';
import dotenv from 'dotenv';

dotenv.config();

const config = {
  defaultProvider: 'lmstudio',
  maxTokens: 32768,
  taskDefaults: {
    query: 'lmstudio'
  },
  providers: {
    lmstudio: {
      enabled: true,
      endpoint: process.env.LM_STUDIO_HTTP_ENDPOINT || 'http://localhost:12345',
      model: 'deepseek-r1-distill-qwen-7b'
    }
  }
};

const router = new LLMRouter(config);

const prompt = `Problem: We need to extract search results from Google HTML pages. Challenges:
- Full HTML is 1.6MB (too large for LLM context windows)
- Plain text (innerText) loses all URLs and structure
- CSS selectors are brittle and break when Google changes their DOM

Question: What are effective strategies to strip down HTML to minimal but structured information that:
1. Preserves links (href attributes)
2. Maintains basic structure to separate search results
3. Is resilient to DOM changes
4. Reduces size significantly

Consider approaches like:
- Markdown conversion
- Simplified HTML (keeping only essential tags)
- Custom format with text + links
- Browser-side JavaScript extraction
- Or any other creative solutions

What would you recommend and why? Please be specific and practical.`;

try {
  console.log('Querying local LLM for HTML stripping advice...\n');
  
  const response = await router.predict({
    prompt,
    maxTokens: 1000,
    provider: 'lmstudio',
    taskType: 'query'
  });
  
  console.log('=== LOCAL LLM RESPONSE ===\n');
  console.log(response);
  console.log('\n=========================\n');
  
} catch (err) {
  console.error('Error:', err.message);
  console.error(err.stack);
}
