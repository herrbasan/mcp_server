import { config } from 'dotenv';

config();

const TEST_CODE = `
export class Logger {
  constructor() {
    this.listeners = [];
  }
  
  addListener(fn) {
    this.listeners.push(fn);
  }
  
  log(type, message) {
    console.log(\`[\${type}] \${message}\`);
    this.listeners.forEach(fn => fn({ type, message }));
  }
}
`;

const httpEndpoint = process.env.LM_STUDIO_HTTP_ENDPOINT || 'http://localhost:12345';

async function quickTest() {
  console.log('🧪 DeepSeek R1 - Disable Thinking Test\n');
  
  const response = await fetch(`${httpEndpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-r1-0528-qwen3-8b',
      messages: [{
        role: 'system',
        content: 'Output only the requested data. No thinking. No explanation.'
      }, {
        role: 'user',
        content: `Functions and classes in this code as JSON:\n\n${TEST_CODE}\n\nJSON: {"functions": [], "classes": []}`
      }],
      temperature: 0.0,
      max_tokens: 100,
      stream: false
    })
  });
  
  const data = await response.json();
  const content = data.choices[0].message.content.trim();
  
  console.log('RAW OUTPUT:');
  console.log(content);
  console.log('\n' + '='.repeat(60));
  
  if (content.includes('<think>')) {
    console.log('❌ Still outputting <think> tags despite system message');
  } else {
    console.log('✅ No <think> tags!');
  }
  
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('✅ Valid JSON:', parsed);
    } catch (e) {
      console.log('❌ Invalid JSON:', e.message);
    }
  } else {
    console.log('❌ No JSON found');
  }
}

quickTest().catch(console.error);
