import { readdirSync, statSync, readFileSync } from 'fs';
import { join, extname, relative } from 'path';
import { config } from 'dotenv';
import { LLMRouter } from '../src/llm/index.js';
import llmConfig from '../config.json' with { type: 'json' };

config();

// Interpolate env vars in config
function interpolateEnvVars(obj) {
  const result = JSON.parse(JSON.stringify(obj));
  const interpolate = (val) => {
    if (typeof val === 'string' && val.startsWith('${') && val.endsWith('}')) {
      const envVar = val.slice(2, -1);
      return process.env[envVar] || val;
    }
    return val;
  };
  
  const walk = (obj) => {
    for (const key in obj) {
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        walk(obj[key]);
      } else {
        obj[key] = interpolate(obj[key]);
      }
    }
  };
  walk(result);
  return result;
}

const router = new LLMRouter(interpolateEnvVars(llmConfig.llm));

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
  
  console.log(`\n📊 Embedding Creation Benchmark`);
  console.log(`Target: ${targetPath}`);
  console.log(`Using LLM Router\n`);
  
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
  await router.embedText(files[0].content);
  const singleEnd = performance.now();
  const singleDuration = singleEnd - singleStart;
  console.log(`  Duration: ${singleDuration.toFixed(2)}ms\n`);
  
  // Test 2: Batch embeddings (10 files)
  const batchSize = Math.min(10, files.length);
  console.log(`Test 2: Batch Embedding (${batchSize} files)`);
  const batchTexts = files.slice(0, batchSize).map(f => f.content);
  const batchStart = performance.now();
  await Promise.all(batchTexts.map(text => router.embedText(text)));
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
    await Promise.all(largeTexts.map(text => router.embedText(text)));
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
