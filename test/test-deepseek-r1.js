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

async function testDeepSeek(testName, prompt, maxTokens = 8000) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${testName}`);
  console.log(`${'='.repeat(60)}`);
  
  const startTime = performance.now();
  
  const response = await fetch(`${httpEndpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-r1-0528-qwen3-8b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.0,
      max_tokens: maxTokens,
      stream: false
    })
  });
  
  const endTime = performance.now();
  const duration = endTime - startTime;
  
  if (!response.ok) {
    console.log(`❌ HTTP Error: ${response.statusText}`);
    return { success: false, duration };
  }
  
  const data = await response.json();
  let content = data.choices[0].message.content.trim();
  
  console.log(`\n⏱️  Duration: ${duration.toFixed(0)}ms`);
  console.log(`📊 Tokens: ${data.usage?.completion_tokens || 'unknown'}`);
  
  // Check for <think> tags
  const hasThinkStart = content.includes('<think>');
  const hasThinkEnd = content.includes('</think>');
  console.log(`\n🧠 CoT: ${hasThinkStart ? '✓' : '✗'} <think>, ${hasThinkEnd ? '✓' : '✗'} </think>`);
  
  if (hasThinkStart && hasThinkEnd) {
    // Extract thinking
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      const thinking = thinkMatch[1].trim();
      console.log(`\n💭 Thinking (${thinking.length} chars):`);
      console.log(thinking.slice(0, 200));
      if (thinking.length > 200) console.log('...');
    }
  } else if (hasThinkStart && !hasThinkEnd) {
    console.log(`\n⚠️  Thinking started but never finished!`);
    console.log(`Last 300 chars:`);
    console.log(content.slice(-300));
  }
  
  // Extract content after </think> if present
  let cleaned = content;
  if (content.includes('</think>')) {
    const parts = content.split('</think>');
    cleaned = parts[parts.length - 1].trim();
    console.log(`\n📦 Content after </think>:`);
    console.log(cleaned);
  } else {
    console.log(`\n📄 Raw output:`);
    console.log(content.slice(0, 500));
    if (content.length > 500) console.log('...');
  }
  
  // Try to extract JSON
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const jsonStr = jsonMatch[0];
    try {
      const parsed = JSON.parse(jsonStr);
      console.log(`\n✅ JSON VALID!`);
      console.log(`   Functions: ${parsed.functions?.length || 0}`);
      console.log(`   Classes: ${parsed.classes?.length || 0}`);
      console.log(`   Keywords: ${parsed.keywords?.length || 0}`);
      console.log(`   Data:`, JSON.stringify(parsed, null, 2));
      return { success: true, duration, data: parsed };
    } catch (e) {
      console.log(`\n❌ JSON INVALID: ${e.message}`);
      return { success: false, duration };
    }
  } else {
    console.log(`\n❌ No JSON found`);
    return { success: false, duration };
  }
}

async function runTests() {
  console.log('🧪 DeepSeek R1 CoT Test Suite');
  console.log(`Endpoint: ${httpEndpoint}`);
  console.log(`Model: deepseek/deepseek-r1-0528-qwen3-8b\n`);
  
  const results = [];
  
  // Test 1: Simple direct request with high token limit
  results.push(await testDeepSeek(
    'Simple extraction (max_tokens=1000)',
    `Extract functions and classes from this code as JSON:

${TEST_CODE}

Output format: {"functions": ["name1"], "classes": ["Class1"], "keywords": ["keyword1"]}`,
    1000
  ));
  
  // Test 2: Very brief prompt
  results.push(await testDeepSeek(
    'Ultra brief (max_tokens=800)',
    `Code:
${TEST_CODE}

JSON: {"functions": [], "classes": []}`,
    800
  ));
  
  // Test 3: Explicit "be concise"
  results.push(await testDeepSeek(
    'Be concise instruction (max_tokens=600)',
    `Be concise. Extract functions and classes from this code:

${TEST_CODE}

Output only: {"functions": [], "classes": []}`,
    600
  ));
  
  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(60)}`);
  
  const successful = results.filter(r => r.success);
  console.log(`\n✅ Successful: ${successful.length}/${results.length}`);
  
  if (successful.length > 0) {
    const avgDuration = successful.reduce((sum, r) => sum + r.duration, 0) / successful.length;
    console.log(`⚡ Average time: ${avgDuration.toFixed(0)}ms`);
    
    console.log(`\n🎯 Key findings:`);
    console.log(`   - DeepSeek R1 ${successful.length === results.length ? 'RELIABLE' : 'UNRELIABLE'} for JSON extraction`);
    console.log(`   - Speed: ~${avgDuration.toFixed(0)}ms per extraction`);
    
    // Check data quality
    const correctData = successful.filter(r => 
      r.data?.classes?.includes('Logger') &&
      r.data?.functions?.length > 0
    );
    console.log(`   - Correct data: ${correctData.length}/${successful.length}`);
  }
}

runTests().catch(console.error);
