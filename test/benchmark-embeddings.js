import { readdirSync, statSync, readFileSync } from 'fs';
import { join, extname, relative } from 'path';
import { config } from 'dotenv';

config();

// Simple LM Studio HTTP client for embeddings
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
  
  async createEmbeddings(texts) {
    const response = await fetch(`${this.baseURL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-nomic-embed-text-v2-moe',
        input: texts
      })
    });
    
    if (!response.ok) {
      throw new Error(`Batch embedding failed: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.data.map(d => d.embedding);
  }
}

// Collect sample files
function collectFiles(dirPath, maxFiles = 100) {
  const files = [];
  const blacklist = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
  
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
          if (['.js', '.ts', '.py', '.java', '.cpp', '.c', '.go', '.rs'].includes(ext)) {
            try {
              const content = readFileSync(fullPath, 'utf-8');
              if (content.length > 100 && content.length < 10000) {
                files.push({
                  path: relative(dirPath, fullPath),
                  content: content.slice(0, 1000), // First 1000 chars
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

// Run benchmarks
async function runBenchmarks() {
  const targetPath = process.argv[2] || process.cwd();
  const endpoint = process.env.LM_STUDIO_HTTP_ENDPOINT || 'http://localhost:1234';
  
  console.log(`\n📊 Embedding Creation Benchmark`);
  console.log(`Target: ${targetPath}`);
  console.log(`Endpoint: ${endpoint}\n`);
  
  const client = new EmbeddingClient(endpoint);
  
  // Collect sample files
  console.log(`Collecting sample files...`);
  const files = collectFiles(targetPath, 50);
  console.log(`Collected ${files.length} files\n`);
  
  if (files.length === 0) {
    console.log('❌ No suitable files found');
    return;
  }
  
  // Test 1: Single embedding
  console.log(`Test 1: Single Embedding`);
  const singleStart = performance.now();
  await client.createEmbedding(files[0].content);
  const singleEnd = performance.now();
  const singleDuration = singleEnd - singleStart;
  console.log(`  Duration: ${singleDuration.toFixed(2)}ms\n`);
  
  // Test 2: Batch embeddings (10 files)
  const batchSize = Math.min(10, files.length);
  console.log(`Test 2: Batch Embedding (${batchSize} files)`);
  const batchTexts = files.slice(0, batchSize).map(f => f.content);
  const batchStart = performance.now();
  await client.createEmbeddings(batchTexts);
  const batchEnd = performance.now();
  const batchDuration = batchEnd - batchStart;
  console.log(`  Total duration: ${batchDuration.toFixed(2)}ms`);
  console.log(`  Per file: ${(batchDuration / batchSize).toFixed(2)}ms\n`);
  
  // Test 3: Large batch (all files)
  if (files.length >= 20) {
    const largeSize = Math.min(50, files.length);
    console.log(`Test 3: Large Batch (${largeSize} files)`);
    const largeTexts = files.slice(0, largeSize).map(f => f.content);
    const largeStart = performance.now();
    await client.createEmbeddings(largeTexts);
    const largeEnd = performance.now();
    const largeDuration = largeEnd - largeStart;
    console.log(`  Total duration: ${largeDuration.toFixed(2)}ms (${(largeDuration/1000).toFixed(2)}s)`);
    console.log(`  Per file: ${(largeDuration / largeSize).toFixed(2)}ms\n`);
  }
  
  // Extrapolate to 100k files
  const avgPerFile = batchDuration / batchSize;
  const estimated100k = (avgPerFile * 100000) / 1000 / 60;
  console.log(`📈 Extrapolation:`);
  console.log(`  Average per file: ${avgPerFile.toFixed(2)}ms`);
  console.log(`  100k files: ~${estimated100k.toFixed(1)} minutes`);
}

runBenchmarks().catch(console.error);
