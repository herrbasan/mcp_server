// Test structured output for web-research module
import 'dotenv/config';
import { createRouter } from '../src/router/router.js';
import { readFileSync } from 'fs';

const configRaw = readFileSync('./config.json', 'utf8');
const configStr = configRaw.replace(/\${(\w+)}/g, (_, key) => process.env[key] || '');
const config = JSON.parse(configStr);
const router = await createRouter(config.llm);

console.log('=== Testing Structured Output for Web Research ===\n');

// Test 1: selectBestSources schema (indices array)
console.log('Test 1: Source Selection (indices array)');
const indicesSchema = {
  type: 'object',
  properties: {
    indices: { type: 'array', items: { type: 'number' } }
  },
  required: ['indices']
};

const sourcesResult = await router.predict({
  prompt: `Pick the top 3 most relevant URLs for the query "JavaScript async patterns":
1. stackoverflow.com/questions/async-await
2. medium.com/10-js-tips
3. developer.mozilla.org/en-US/docs/Learn/JavaScript/Asynchronous
4. reddit.com/r/javascript
5. github.com/sindresorhus/promise-fun

Return indices in order of relevance.`,
  provider: 'gemini',
  maxTokens: 100,
  temperature: 0.3,
  responseFormat: indicesSchema
});

console.log('Raw:', sourcesResult);
const parsed1 = JSON.parse(sourcesResult);
console.log('Parsed:', parsed1);
console.log('✓ Indices:', parsed1.indices);
console.log();

// Test 2: evaluateSynthesis schema
console.log('Test 2: Evaluation (confidence + gaps)');
const evalSchema = {
  type: 'object',
  properties: {
    confidence: { type: 'number' },
    gaps: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    followUpQuery: { type: 'string', nullable: true }
  },
  required: ['confidence', 'gaps', 'contradictions', 'followUpQuery']
};

const evalResult = await router.predict({
  prompt: `Original query: "How does JavaScript async/await work?"

Synthesis: JavaScript async/await is syntactic sugar over Promises, introduced in ES2017. 
The async keyword marks a function as returning a Promise, while await pauses execution 
until a Promise resolves. This makes asynchronous code look synchronous.

Evaluate: confidence (0-100), gaps, contradictions, and suggest a follow-up query if needed.`,
  provider: 'gemini',
  maxTokens: 300,
  temperature: 0.3,
  responseFormat: evalSchema
});

console.log('Raw:', evalResult);
const parsed2 = JSON.parse(evalResult);
console.log('Parsed:', parsed2);
console.log('✓ Confidence:', parsed2.confidence);
console.log('✓ Gaps:', parsed2.gaps);
console.log('✓ Follow-up:', parsed2.followUpQuery);
console.log();

// Test 3: prepareQuery schema
console.log('Test 3: Query Preparation');
const querySchema = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          reasoning: { type: 'string' }
        },
        required: ['query', 'reasoning']
      }
    },
    recommended: { type: 'string' }
  },
  required: ['queries', 'recommended']
};

const queryResult = await router.predict({
  prompt: `Generate 3 search query variants for: "best practices for error handling in Node.js"

Consider technical terminology, site-specific searches, and alternative phrasings.`,
  provider: 'gemini',
  maxTokens: 500,
  temperature: 0.3,
  responseFormat: querySchema
});

console.log('Raw:', queryResult.substring(0, 200) + '...');
const parsed3 = JSON.parse(queryResult);
console.log('✓ Recommended:', parsed3.recommended);
console.log('✓ Variants:', parsed3.queries.length);
parsed3.queries.forEach((q, i) => console.log(`  ${i+1}. ${q.query}`));

console.log('\n=== All tests passed ===');
