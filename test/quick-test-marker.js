// Quick test of marker approach
import { config } from 'dotenv';
config();

const httpEndpoint = process.env.LM_STUDIO_HTTP_ENDPOINT || 'http://localhost:12345';

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

async function testMarker() {
  const response = await fetch(`${httpEndpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'nvidia/nemotron-3-nano',
      messages: [{
        role: 'user',
        content: `Think about this code:

${TEST_CODE}

Now OUTPUT exactly this JSON structure filled with correct values:
{"functions": [], "classes": []}

Do not abbreviate. Do not use {...}. Write the complete JSON with actual function and class names.`
      }],
      temperature: 0.0,
      max_tokens: 250,
      stream: false
    })
  });
  
  const data = await response.json();
  const content = data.choices[0].message.content.trim();
  
  console.log('=== RAW OUTPUT ===');
  console.log(content);
  console.log('\n=== EXTRACTION TEST ===');
  
  // Try to find OUTPUT: marker
  const match = content.match(/OUTPUT:\s*(\{[\s\S]*)/i);
  if (match) {
    const after = match[1].trim();
    let depth = 0, start = -1, end = -1;
    for (let i = 0; i < after.length; i++) {
      if (after[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (after[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (start !== -1 && end !== -1) {
      const extracted = after.substring(start, end + 1);
      console.log('Extracted:', extracted);
      try {
        const parsed = JSON.parse(extracted);
        console.log('✅ VALID JSON:', parsed);
      } catch (e) {
        console.log('❌ INVALID:', e.message);
      }
    } else {
      console.log('❌ Could not find complete JSON object');
    }
  } else {
    console.log('❌ No OUTPUT: marker found');
  }
}

testMarker().catch(console.error);
