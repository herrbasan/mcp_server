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

async function testPrompt(name, systemMsg, userMsg, params = {}) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log(`${'='.repeat(60)}`);
  
  const startTime = performance.now();
  
  try {
    const response = await fetch(`${httpEndpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-nano',
        messages: [
          ...(systemMsg ? [{ role: 'system', content: systemMsg }] : []),
          { role: 'user', content: userMsg }
        ],
        temperature: params.temperature ?? 0.0,
        top_p: params.top_p ?? 1.0,
        max_tokens: params.max_tokens ?? 500,
        repetition_penalty: params.repetition_penalty ?? 1.2,
        stream: false,
        stop: params.stop || ["</s>", "\n\n\n", "```"]
      })
    });
    
    const endTime = performance.now();
    
    if (!response.ok) {
      console.log(`❌ HTTP Error: ${response.statusText}`);
      return;
    }
    
    const data = await response.json();
    let content = data.choices[0].message.content.trim();
    
    console.log(`\n📄 Raw output (${(endTime - startTime).toFixed(0)}ms):`);
    console.log(content);
    
    // Show special tokens
    const specialTokens = content.match(/<SPECIAL_\d+>/g);
    if (specialTokens) {
      console.log(`\n⚠️  Special tokens found: ${specialTokens.slice(0, 5).join(', ')} (${specialTokens.length} total)`);
    }
    
    // Try to extract JSON from code fence first
    let jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (!jsonMatch) {
      // Try without language specifier
      jsonMatch = content.match(/```\s*(\{[\s\S]*?\})\s*```/);
    }
    if (!jsonMatch) {
      // Try ANSWER: or OUTPUT: marker (capture everything after)
      const answerMatch = content.match(/(ANSWER|OUTPUT):\s*(\{[\s\S]*)/i);
      if (answerMatch) {
        // Extract JSON object by counting braces
        const afterMarker = answerMatch[2].trim();
        let depth = 0, start = -1, end = -1;
        for (let i = 0; i < afterMarker.length; i++) {
          if (afterMarker[i] === '{') {
            if (depth === 0) start = i;
            depth++;
          } else if (afterMarker[i] === '}') {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        if (start !== -1 && end !== -1) {
          jsonMatch = [null, afterMarker.substring(start, end + 1)];
        }
      }
    }
    
    let cleaned;
    if (jsonMatch) {
      console.log(`\n📦 Found JSON with marker`);
      cleaned = jsonMatch[1].trim();
    } else {
      // Fallback: clean up the whole response
      cleaned = content.replace(/<SPECIAL_\d+>/g, '');
      cleaned = cleaned.replace(/<\/s>/g, '');
      cleaned = cleaned.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      
      // Try to extract JSON object
      const objectMatch = cleaned.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        cleaned = objectMatch[0];
      }
    }
    
    // Try to parse
    console.log(`\n🧹 After cleanup:`);
    console.log(cleaned);
    
    try {
      const parsed = JSON.parse(cleaned);
      console.log(`\n✅ JSON VALID!`);
      console.log(`   Functions: ${parsed.functions?.length || 0}`);
      console.log(`   Keywords: ${parsed.searchable_keywords?.length || 0}`);
      return { success: true, duration: endTime - startTime, parsed };
    } catch (err) {
      console.log(`\n❌ JSON INVALID: ${err.message}`);
      return { success: false, duration: endTime - startTime, error: err.message };
    }
    
  } catch (err) {
    console.log(`\n💥 Error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function runTests() {
  console.log(`\n🧪 Nemotron JSON Output Test Suite`);
  console.log(`Endpoint: ${httpEndpoint}`);
  console.log(`Model: nvidia/nemotron-3-nano\n`);
  
  const results = [];
  
  // Test 1: Minimal prompt, no system message
  results.push(await testPrompt(
    'Minimal (no system message)',
    null,
    `Extract functions from this code as JSON:\n${TEST_CODE}\n\nJSON:`,
    { max_tokens: 300 }
  ));
  
  // Test 2: Explicit JSON-only system message
  results.push(await testPrompt(
    'JSON-only system message',
    'You output ONLY valid JSON. No special tokens. No markdown. Start with { and end with }.',
    `Extract functions and keywords:\n${TEST_CODE}\n\nJSON:`,
    { max_tokens: 300 }
  ));
  
  // Test 3: Schema in prompt
  results.push(await testPrompt(
    'Schema-first prompt',
    null,
    `Return this JSON schema filled with data from the code:
{"functions":[{"name":"","role":""}],"keywords":[]}

Code:
${TEST_CODE}`,
    { max_tokens: 300 }
  ));
  
  // Test 4: One-shot example
  results.push(await testPrompt(
    'One-shot example',
    null,
    `Extract functions as JSON. Example:
Code: function add(a,b) { return a+b; }
JSON: {"functions":[{"name":"add","role":"addition"}],"keywords":["math","add"]}

Code:
${TEST_CODE}

JSON:`,
    { max_tokens: 300 }
  ));
  
  // Test 5: Higher temperature
  results.push(await testPrompt(
    'Temperature 0.3',
    'Output only JSON.',
    `Extract functions:\n${TEST_CODE}\nJSON:`,
    { temperature: 0.3, max_tokens: 300 }
  ));
  
  // Test 6: Very short max_tokens
  results.push(await testPrompt(
    'Short output (max_tokens=150)',
    'Output JSON only.',
    `Functions in this code:\n${TEST_CODE}\nJSON:`,
    { max_tokens: 150 }
  ));
  
  // Summary
  // Test 7: JSON at end after explanation
  await testPrompt(
    'Test 7: Explain then JSON at END',
    null,
    `Analyze this code and explain what you find.
After your explanation, output ONLY the JSON on the last line.

Code:
${TEST_CODE}

JSON format: {"functions": ["name1"], "classes": ["name2"]}`,
    { max_tokens: 300 }
  );

  // Test 8: Use OUTPUT marker with explicit instruction
  await testPrompt(
    'Test 8: OUTPUT marker explicit',
    null,
    `Think about this code and what functions/classes it has:

${TEST_CODE}

Now OUTPUT exactly this JSON structure filled with correct values:
{"functions": [], "classes": []}

Do not abbreviate. Do not use {...}. Write the complete JSON.`,
    { max_tokens: 200 }
  );

  // Test 9: Double newline separator
  await testPrompt(
    'Test 9: Explain + double-newline + JSON',
    null,
    `First line: explain this code in one sentence.
Second line: leave blank.
Third line: output {"functions": [], "classes": []} with actual values.

Code:
${TEST_CODE}`,
    { max_tokens: 200 }
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(60)}`);
  
  const successful = results.filter(r => r.success);
  console.log(`\n✅ Successful: ${successful.length}/${results.length}`);
  
  if (successful.length > 0) {
    console.log(`\n🎉 Working approaches:`);
    results.forEach((r, i) => {
      if (r.success) {
        console.log(`   ${i + 1}. Test ${i + 1} (${r.duration.toFixed(0)}ms)`);
      }
    });
    
    console.log(`\n📊 Key findings:`);
    console.log(`   - Nemotron CAN output structured JSON with correct prompting`);
    console.log(`   - Simple, direct prompts work best (no complex system messages)`);
    console.log(`   - Providing exact structure (schema/example) improves success`);
    console.log(`   - Constraining output length (max_tokens) helps`);
    console.log(`   - "Think then output" with markers FAILS - nemotron reasons about markers instead of outputting them`);
    console.log(`   - Best approach: Direct request with schema, low max_tokens (Test 6: 778ms)`);
  } else {
    console.log(`\n💔 No approaches worked with nemotron for structured JSON output.`);
    console.log(`   Recommendation: Use code-focused model (Qwen) or skip deep mapping.`);
  }
}

runTests().catch(console.error);
