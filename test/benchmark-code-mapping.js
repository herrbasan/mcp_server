import { readdirSync, readFileSync } from 'fs';
import { join, extname, relative } from 'path';
import { config } from 'dotenv';

config();

// HTTP client for LM Studio (simpler than WebSocket)
class LMStudioClient {
  constructor(httpURL) {
    this.httpURL = httpURL;
  }
  
  async generateSummary(code, filename) {
    const prompt = `You are a code-analysis engine that produces a deep functional map.
Analyze the following file and return exactly the structure below.

FILE: ${filename}
${code}
---END OF FILE CONTENT---

**Output Schema:**
Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "file_path": "${filename}",
  "purpose": "<1-2 sentence high-level purpose>",
  "architecture": "<architectural role: component/module/service/utility>",
  "functions": [
    {
      "name": "<function name>",
      "role": "<what it does>",
      "keywords": ["<keyword1>", "<keyword2>"]
    }
  ],
  "classes": [
    {
      "name": "<class name>",
      "role": "<what it does>",
      "keywords": ["<keyword1>", "<keyword2>"]
    }
  ],
  "data_structures": [
    {
      "name": "<struct/map/array name>",
      "usage_patterns": ["<pattern1>"],
      "keywords": ["<keyword1>"]
    }
  ],
  "dependencies": {
    "imports": [{"module": "<name>", "reason": "<why>"}],
    "exports": [{"module": "<name>", "reason": "<why>"}]
  },
  "control_flow": [
    {
      "branch": "<if/for/while/switch>",
      "purpose": "<what decision>"
    }
  ],
  "side_effects": [
    {
      "effect": "<mutation/IO/state>",
      "keywords": ["<keyword1>"]
    }
  ],
  "searchable_keywords": ["<keyword1>", "<keyword2>", "..."],
  "code_snippets": {
    "function_signature": "<most representative function>",
    "dependency_pattern": "<import line>"
  }
}

Return ONLY the JSON object. No prose, no markdown, no explanations.`;

    const response = await fetch(`${this.httpURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'hermes-3-llama-3.1-8b',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 1500,
        stream: false
      })
    });
    
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    let content = data.choices[0].message.content.trim();
    
    // Strip markdown code fences if present
    content = content.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    
    return content;
  }
}

// Embedding client
class EmbeddingClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
  }
  
  async createEmbedding(text) {
    const response = await fetch(`${this.baseURL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-nomic-embed-text-v2-moe',
        input: text
      })
    });
    
    if (!response.ok) {
      throw new Error(`Embedding failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.data[0].embedding;
  }
}

// Collect sample files
function collectFiles(dirPath, maxFiles = 10) {
  const files = [];
  const blacklist = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'LMStudioAPI', 'nui_wc2']);
  
  function walk(dir) {
    if (files.length >= maxFiles) return;
    
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (files.length >deep functional map with LLM
      const summaryStart = performance.now();
      const mapJson = await llmClient.generateSummary(file.content, file.path);
      const summaryEnd = performance.now();
      const summaryDuration = summaryEnd - summaryStart;
      
      // Parse and validate JSON
      let parsed = null;
      try {
        parsed = JSON.parse(mapJson);
        const keywords = parsed.searchable_keywords?.length || 0;
        const functions = parsed.functions?.length || 0;
        const classes = parsed.classes?.length || 0;
        console.log(`  Map (${summaryDuration.toFixed(0)}ms): ${keywords} keywords, ${functions} functions, ${classes} classes`);
        console.log(`  Purpose: ${parsed.purpose?.slice(0, 60) || 'N/A'}...`);
      } catch (err) {
        console.log(`  ⚠️  JSON parse failed (${summaryDuration.toFixed(0)}ms): ${err.message}`);
        console.log(`  Raw: ${mapJson.slice(0, 100)}...`);
      }
      
      // Step 2: Create embedding of the entire JSON map
      const embedStart = performance.now();
      const embedding = await embClient.createEmbedding(mapJson);
      const embedEnd = performance.now();
      const embedDuration = embedEnd - embedStart;
      
      console.log(`  Embedding: ${embedding.length}-dim (${embedDuration.toFixed(0)}ms)`);
      
      const totalDuration = summaryDuration + embedDuration;
      console.log(`  Total: ${totalDuration.toFixed(0)}ms\n`);
      
      results.push({
        file: file.path,
        map: parsed,
        mapJson
    } catch {}
  }
  
  walk(dirPath);
  return files;
}

// Run benchmark
async function runBenchmark() {
  const targetPath = process.argv[2] || process.cwd();
  const httpEndpoint = process.env.LM_STUDIO_HTTP_ENDPOINT || 'http://localhost:1234';
  
  console.log(`\n🗺️  Code Mapping Benchmark`);
  console.log(`Target: ${targetPath}`);
  console.log(`HTTP: ${httpEndpoint}\n`);
  
  const llmClient = new LMStudioClient(httpEndpoint);
  const embClient = new EmbeddingClient(httpEndpoint);
  
  // Collect files
  console.log(`Collecting sample files...`);
  const files = collectFiles(targetPath, 10);
  console.log(`Collected ${files.length} files\n`);
  
  if (files.length === 0) {
    console.log('❌ No suitable files found');
    return;
  }
  
  const results = [];
  
  // Process each file
  console.log(`Processing files...\n`);
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`[${i+1}/${files.length}] ${file.path}`);
    
    try {
      // Step 1: Generate summary with LLM
      const summaryStart = performance.now();
      const summary = await llmClient.generateSummary(file.content, file.path);
      const summaryEnd = performance.now();
      const summaryDuration = summaryEnd - summaryStart;
      
      console.log(`  Summary (${summaryDuration.toFixed(0)}ms): ${summary.slice(0, 80)}...`);
      
      // Step 2: Create embedding of summary
      const embedStart = performance.now();
      const embedding = await embClient.createEmbedding(summary);
      const embedEnd = performance.now();
      const embedDuration = embedEnd - embedStart;
      
      console.log(`  Embedding: ${embedding.length}-dim (${embedDuration.toFixed(0)}ms)`);
      
      const totalDuration = summaryDuration + embedDuration;
      console.log(`  Total: ${totalDuration.toFixed(0)}ms\n`);
      
      results.push({
        file: file.path,
        summary,
        summaryTime: summaryDuration,
        embedTime: embedDuration,
        totalTime: totalDuration
      });
      
      // Delay to avoid overwhelming LM Studio
      awt validMaps = results.filter(r => r.map !== null).length;
    const totalKeywords = results.reduce((sum, r) => sum + (r.map?.searchable_keywords?.length || 0), 0);
    const totalFunctions = results.reduce((sum, r) => sum + (r.map?.functions?.length || 0), 0);
    
    console.log(`\n📊 Statistics (${results.length} files):`);
    console.log(`  Valid JSON maps: ${validMaps}/${results.length}`);
    console.log(`  Total keywords extracted: ${totalKeywords}`);
    console.log(`  Total functions mapped: ${totalFunctions}`);
    console.log(`  Avg LLM mapping: ${avgSummary.toFixed(0)}ms`);
    console.log(`  Avg embedding: ${avgEmbed.toFixed(0)}ms`);
    console.log(`  Avg total: ${avgTotal.toFixed(0)}ms`);
    
    const estimated100k = (avgTotal * 100000) / 1000 / 60;
    console.log(`\n📈 Extrapolation:`);
    console.log(`  100k files: ~${estimated100k.toFixed(0)} minutes (~${(estimated100k/60).toFixed(1)} hours)`);
    console.log(`  Note: This is sequential. With 10x parallelization: ~${(estimated100k/60/10).toFixed(1)} hours
    const avgSummary = results.reduce((sum, r) => sum + r.summaryTime, 0) / results.length;
    const avgEmbed = results.reduce((sum, r) => sum + r.embedTime, 0) / results.length;
    const avgTotal = results.reduce((sum, r) => sum + r.totalTime, 0) / results.length;
    
    console.log(`\n📊 Statistics (${results.length} files):`);
    console.log(`  Avg LLM summary: ${avgSummary.toFixed(0)}ms`);
    console.log(`  Avg embedding: ${avgEmbed.toFixed(0)}ms`);
    console.log(`  Avg total: ${avgTotal.toFixed(0)}ms`);
    
    const estimated100k = (avgTotal * 100000) / 1000 / 60;
    console.log(`\n📈 Extrapolation:`);
    console.log(`  100k files: ~${estimated100k.toFixed(0)} minutes (~${(estimated100k/60).toFixed(1)} hours)`);
    console.log(`  Note: This is sequential. Batching would be much faster.`);
  }
}

runBenchmark().catch(console.error);
