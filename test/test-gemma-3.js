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

async function testGemma(name, systemMsg, userMsg, params = {}) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log(`${'='.repeat(60)}`);
  
  const startTime = performance.now();
  
  try {
    const response = await fetch(`${httpEndpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemma-3-12b',
        messages: [
          ...(systemMsg ? [{ role: 'system', content: systemMsg }] : []),
          { role: 'user', content: userMsg }
        ],
        temperature: params.temperature ?? 0.0,
        max_tokens: params.max_tokens ?? 300,
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
    console.log(`\n📄 Raw output:`);
    console.log(content);
    
    // Try to extract JSON
    let jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (!jsonMatch) {
      jsonMatch = content.match(/```\s*(\{[\s\S]*?\})\s*```/);
    }
    
    let cleaned;
    if (jsonMatch) {
      console.log(`\n📦 Found JSON in code fence`);
      cleaned = jsonMatch[1].trim();
    } else {
      // Try to find raw JSON object
      const objMatch = content.match(/\{[\s\S]*?\}/);
      if (objMatch) {
        cleaned = objMatch[0];
      } else {
        console.log(`\n❌ No JSON found`);
        return { success: false, duration };
      }
    }
    
    console.log(`\n🧹 Extracted:`);
    console.log(cleaned);
    
    try {
      const parsed = JSON.parse(cleaned);
      console.log(`\n✅ JSON VALID!`);
      console.log(`   Functions: ${parsed.functions?.length || 0}`);
      console.log(`   Classes: ${parsed.classes?.length || 0}`);
      console.log(`   Keywords: ${parsed.keywords?.length || 0}`);
      
      // Validate data quality
      const hasData = (parsed.functions && parsed.functions.length > 0) || 
                      (parsed.classes && parsed.classes.length > 0);
      if (hasData) {
        console.log(`   Data:`, JSON.stringify(parsed, null, 2));
      } else {
        console.log(`   ⚠️  Empty data - model returned structure but no values`);
      }
      
      return { success: true, duration, hasData, parsed };
    } catch (e) {
      console.log(`\n❌ JSON INVALID: ${e.message}`);
      return { success: false, duration };
    }
  } catch (error) {
    console.log(`\n❌ Error: ${error.message}`);
    return { success: false, duration: 0 };
  }
}

async function runTests() {
  console.log(`🧪 Gemma 3 12B JSON Extraction Test`);
  console.log(`Endpoint: ${httpEndpoint}`);
  console.log(`Model: google/gemma-3-12b\n`);
  
  const results = [];
  
  // Test 1: Direct minimal
  results.push(await testGemma(
    'Minimal prompt',
    null,
    `Extract functions and classes from this code as JSON:

${TEST_CODE}

JSON format: {"functions": ["name1"], "classes": ["Class1"]}`
  ));
  
  // Test 2: Schema-first
  results.push(await testGemma(
    'Schema-first',
    null,
    `Fill this JSON schema with data from the code:

{"functions": [], "classes": [], "keywords": []}

Code:
${TEST_CODE}`
  ));
  
  // Test 3: One-shot example
  results.push(await testGemma(
    'One-shot example',
    null,
    `Example input:
class Calculator { add(a,b) { return a+b; } }

Example output:
{"functions": ["add"], "classes": ["Calculator"]}

Now analyze this code:
${TEST_CODE}

Output JSON:`
  ));
  
  // Test 4: JSON-only system message
  results.push(await testGemma(
    'JSON-only system',
    'You are a code analyzer. Output only valid JSON, no explanations.',
    `Extract functions and classes:

${TEST_CODE}

Format: {"functions": [], "classes": []}`
  ));
  
  // Test 5: Short output constraint
  results.push(await testGemma(
    'Short constraint',
    null,
    `Functions and classes in this code:

${TEST_CODE}

JSON only:`,
    { max_tokens: 150 }
  ));
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(60)}`);
  
  const successful = results.filter(r => r.success);
  const withData = results.filter(r => r.success && r.hasData);
  
  console.log(`\n✅ Valid JSON: ${successful.length}/${results.length}`);
  console.log(`📊 With actual data: ${withData.length}/${results.length}`);
  
  if (withData.length > 0) {
    console.log(`\n🎉 Working approaches:`);
    results.forEach((r, i) => {
      if (r.success && r.hasData) {
        console.log(`   ${i + 1}. Test ${i + 1} (${r.duration.toFixed(0)}ms)`);
      }
    });
    
    console.log(`\n📊 Key findings:`);
    console.log(`   - Gemma 3 12B can output structured JSON`);
    console.log(`   - Check if it actually extracts data vs returning empty schemas`);
    console.log(`   - Performance: ${Math.min(...withData.map(r => r.duration)).toFixed(0)}ms fastest`);
  } else if (successful.length > 0) {
    console.log(`\n⚠️  Valid JSON but no actual data extracted`);
    console.log(`   Model returns structure but doesn't fill it with values`);
  } else {
    console.log(`\n💔 No approaches worked with Gemma 3`);
  }
}

runTests().catch(console.error);
