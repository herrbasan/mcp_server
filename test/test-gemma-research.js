import { config } from 'dotenv';

config();

const httpEndpoint = process.env.LM_STUDIO_HTTP_ENDPOINT || 'http://localhost:12345';
const model = process.env.LM_STUDIO_MODEL || 'google/gemma-3-12b';

async function testQueryPreparation() {
  const prompt = `You are a search query optimization expert. Given a user's research question, generate 3-5 highly effective search query variants that will find the most relevant and authoritative sources.

User question: "12B to 20B parameter language models good at code analysis structured output 2025 2026"

Consider:
1. Technical terminology (e.g., quote multi-word terms like "Virtual DOM")
2. Domain-specific sites (e.g., add "site:stackoverflow.com" for coding questions)
3. Disambiguation (add context words to prevent ambiguous results)
4. Alternative phrasings (how would different experts phrase this?)
5. Specificity levels (one broad query, one narrow query, one focused on examples/tutorials)

Generate 3-5 search query variants optimized for Google/DuckDuckGo/Bing.

Return ONLY valid JSON (no markdown, no code blocks, no explanation):
{"queries":[{"query":"exact search string","reasoning":"why this variant"}],"recommended":"query string you recommend most"}`;

  console.log('Testing Gemma 3 query preparation...\n');
  const startTime = performance.now();
  
  try {
    const res = await fetch(`${httpEndpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1500
      })
    });

    if (!res.ok) {
      console.error(`❌ HTTP Error: ${res.status}`);
      return;
    }
    
    const data = await res.json();
    const response = data.choices[0].message.content;
    const duration = performance.now() - startTime;
    
    console.log(`⏱️  Duration: ${duration.toFixed(0)}ms`);
    console.log(`📊 Tokens: ${data.usage?.completion_tokens || 'unknown'}`);
    console.log(`\n📄 Raw response:\n${response}\n`);
    
    // Try to extract JSON
    let cleaned = response
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    
    // Find all {...} blocks
    const jsonCandidates = [];
    let depth = 0;
    let start = -1;
    
    for (let i = 0; i < cleaned.length; i++) {
      if (cleaned[i] === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (cleaned[i] === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          jsonCandidates.push(cleaned.substring(start, i + 1));
          start = -1;
        }
      }
    }
    
    console.log(`\n🔍 Found ${jsonCandidates.length} JSON candidates`);
    
    // Try to parse candidates in reverse order
    let parsed = null;
    for (let i = jsonCandidates.length - 1; i >= 0; i--) {
      try {
        const candidate = jsonCandidates[i];
        const obj = JSON.parse(candidate);
        
        if (obj.queries && Array.isArray(obj.queries) && obj.recommended) {
          parsed = obj;
          console.log(`✅ Successfully parsed candidate ${i + 1}`);
          console.log(`\n📊 Result:`);
          console.log(`   Recommended: "${obj.recommended}"`);
          console.log(`   Variants: ${obj.queries.length}`);
          obj.queries.forEach((q, idx) => {
            console.log(`      ${idx + 1}. "${q.query}"`);
          });
          return;
        }
      } catch (e) {
        console.log(`   Candidate ${i + 1} failed: ${e.message}`);
      }
    }
    
    if (!parsed) {
      console.log(`\n❌ No valid JSON found`);
      console.log(`\nCandidates were:`);
      jsonCandidates.forEach((c, i) => {
        console.log(`\n${i + 1}. ${c.slice(0, 200)}${c.length > 200 ? '...' : ''}`);
      });
    }
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
  }
}

testQueryPreparation();
