import { readdirSync, readFileSync } from 'fs';
import { join, extname, relative } from 'path';
import { config } from 'dotenv';

config();

// HTTP client for LM Studio
class LMStudioClient {
  constructor(httpURL) {
    this.httpURL = httpURL;
  }
  
  async generateDeepMap(code, filename) {
    const response = await fetch(`${this.httpURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemma-3-12b',
        messages: [
          {
            role: 'system',
            content: 'You are a code analyzer. Output only valid JSON, no explanations.'
          },
          {
            role: 'user',
            content: `Extract functions, classes, and keywords from this code:

File: ${filename}
${code.slice(0, 4000)}

Format: {"functions": [{"name": "funcName", "role": "what it does"}], "classes": [], "keywords": []}`
          }
        ],
        temperature: 0.0,
        max_tokens: 500,
        stream: false
      })
    });
    
    if (!response.ok) {
      throw new Error(`LLM request failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    let content = data.choices[0].message.content.trim();
    
    // Extract from code fence (Gemma outputs ```json ... ```)
    let jsonMatch = content.match(/```json\s*([\s\S]*?)```/i);
    if (!jsonMatch) {
      jsonMatch = content.match(/```\s*(\{[\s\S]*?\})\s*```/);
    }
    
    if (jsonMatch) {
      content = jsonMatch[1].trim();
    } else {
      // Fallback: extract raw JSON object
      const objMatch = content.match(/\{[\s\S]*\}/);
      if (objMatch) {
        content = objMatch[0];
      }
    }
    
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
        if (files.length >= maxFiles) break;
        
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory() && !blacklist.has(entry.name)) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = extname(entry.name);
          if (['.js', '.ts', '.py'].includes(ext)) {
            try {
              const content = readFileSync(fullPath, 'utf-8');
              if (content.length > 200 && content.length < 5000) {
                files.push({
                  path: relative(dirPath, fullPath),
                  content,
                  size: content.length
                });
              }
            } catch {}
          }
        }
      }
    } catch {}
  }
  
  walk(dirPath);
  return files;
}

// Run benchmark
async function runBenchmark() {
  const targetPath = process.argv[2] || process.cwd();
  const httpEndpoint = process.env.LM_STUDIO_HTTP_ENDPOINT || 'http://localhost:1234';
  
  console.log(`\n🗺️  Deep Code Mapping Benchmark`);
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
      // Step 1: Generate deep functional map with LLM
      const mapStart = performance.now();
      const mapJson = await llmClient.generateDeepMap(file.content, file.path);
      const mapEnd = performance.now();
      const mapDuration = mapEnd - mapStart;
      
      // Parse and validate JSON
      let parsed = null;
      try {
        parsed = JSON.parse(mapJson);
        const keywords = parsed.searchable_keywords?.length || 0;
        const functions = parsed.functions?.length || 0;
        const classes = parsed.classes?.length || 0;
        const imports = parsed.dependencies?.imports?.length || 0;
        console.log(`  Map (${mapDuration.toFixed(0)}ms): ${keywords} keywords, ${functions} funcs, ${classes} classes, ${imports} imports`);
        console.log(`  Purpose: ${parsed.purpose?.slice(0, 70) || 'N/A'}...`);
      } catch (err) {
        console.log(`  ⚠️  JSON parse failed (${mapDuration.toFixed(0)}ms): ${err.message}`);
        console.log(`  Raw: ${mapJson.slice(0, 100)}...`);
      }
      
      // Step 2: Create embedding of the entire JSON map
      const embedStart = performance.now();
      const embedding = await embClient.createEmbedding(mapJson);
      const embedEnd = performance.now();
      const embedDuration = embedEnd - embedStart;
      
      console.log(`  Embedding: ${embedding.length}-dim (${embedDuration.toFixed(0)}ms)`);
      
      const totalDuration = mapDuration + embedDuration;
      console.log(`  Total: ${totalDuration.toFixed(0)}ms\n`);
      
      results.push({
        file: file.path,
        map: parsed,
        mapJson,
        mapTime: mapDuration,
        embedTime: embedDuration,
        totalTime: totalDuration,
        success: parsed !== null
      });
      
      // Delay to avoid overwhelming LM Studio
      await new Promise(r => setTimeout(r, 500));
      
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}\n`);
    }
  }
  
  // Statistics
  if (results.length > 0) {
    const avgMap = results.reduce((sum, r) => sum + r.mapTime, 0) / results.length;
    const avgEmbed = results.reduce((sum, r) => sum + r.embedTime, 0) / results.length;
    const avgTotal = results.reduce((sum, r) => sum + r.totalTime, 0) / results.length;
    
    const validMaps = results.filter(r => r.success).length;
    const totalKeywords = results.reduce((sum, r) => sum + (r.map?.keywords?.length || r.map?.searchable_keywords?.length || 0), 0);
    const totalFunctions = results.reduce((sum, r) => sum + (r.map?.functions?.length || 0), 0);
    const totalClasses = results.reduce((sum, r) => sum + (r.map?.classes?.length || 0), 0);
    
    console.log(`\n📊 Statistics (${results.length} files):`);
    console.log(`  Valid JSON maps: ${validMaps}/${results.length}`);
    console.log(`  Total keywords extracted: ${totalKeywords}`);
    console.log(`  Total functions mapped: ${totalFunctions}`);
    console.log(`  Total classes mapped: ${totalClasses}`);
    console.log(`  Avg LLM mapping: ${avgMap.toFixed(0)}ms`);
    console.log(`  Avg embedding: ${avgEmbed.toFixed(0)}ms`);
    console.log(`  Avg total: ${avgTotal.toFixed(0)}ms`);
    
    const estimated100k = (avgTotal * 100000) / 1000 / 60;
    console.log(`\n📈 Extrapolation:`);
    console.log(`  100k files: ~${estimated100k.toFixed(0)} minutes (~${(estimated100k/60).toFixed(1)} hours)`);
    console.log(`  With 10x parallelization: ~${(estimated100k/60/10).toFixed(1)} hours`);
    
    // Show sample map
    if (validMaps > 0) {
      const sample = results.find(r => r.success);
      console.log(`\n📄 Sample Map (${sample.file}):`);
      console.log(JSON.stringify(sample.map, null, 2).slice(0, 800) + '...');
    }
  }
}

runBenchmark().catch(console.error);
