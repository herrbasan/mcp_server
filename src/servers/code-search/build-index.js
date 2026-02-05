#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import dotenv from 'dotenv';
import readline from 'readline';
import {
  generateFileId,
  detectLanguage,
  parseFile,
  walkWorkspace,
  generateEmbeddingText,
  writeIndexStreaming,
  atomicWriteIndex
} from './indexer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

async function main() {
  const args = parseArgs();
  
  if (!args.workspace && !args.all) {
    console.error('Usage:');
    console.error('  node scripts/build-index.js --workspace "workspace-name"');
    console.error('  node scripts/build-index.js --all');
    console.error('  node scripts/build-index.js --all --force');
    process.exit(1);
  }

  console.log('🔍 Code Search Index Builder');
  console.log('============================\n');

  const configPath = path.join(__dirname, '..', '..', '..', 'config.json');
  let configText = await fs.readFile(configPath, 'utf-8');
  
  configText = configText.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return process.env[varName] || match;
  });
  
  const config = JSON.parse(configText);

  const { WorkspaceResolver } = await import('../../lib/workspace.js');
  const workspace = new WorkspaceResolver(config.workspaces || {});

  console.log('Initializing LLM router...');
  const { createRouter } = await import('../../router/router.js');
  const router = await createRouter(config.llm);
  console.log('✓ LLM router ready\n');

  const indexPath = config.servers['code-search']?.indexPath || 'data/indexes';

  if (args.all) {
    const workspaces = workspace.getWorkspaces();
    console.log(`Building indexes for ${workspaces.length} workspaces:\n`);
    workspaces.forEach(w => console.log(`  - ${w.name}: ${w.uncPath}`));
    console.log('');

    if (!args.force) {
      const answer = await promptUser('Proceed with building all indexes? (y/N): ');
      if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    for (const w of workspaces) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Building index for: ${w.name}`);
      console.log(`${'='.repeat(60)}\n`);
      
      try {
        await buildIndex(w.name, w.uncPath, indexPath, router);
        console.log(`✓ ${w.name} complete\n`);
      } catch (err) {
        console.error(`✗ ${w.name} failed: ${err.message}\n`);
      }
    }
    
    console.log('\n🎉 All indexes built!');
  } else {
    const workspaceName = args.workspace;
    console.log(`Workspace: ${workspaceName}`);
    
    const uncPath = workspace.getWorkspacePath(workspaceName);
    console.log(`UNC path: ${uncPath}\n`);

    const indexFile = path.join(indexPath, `${workspaceName}.json`);
    console.log(`Index file: ${indexFile}\n`);

    try {
      await fs.access(indexFile);
      if (!args.force) {
        const answer = await promptUser('Index already exists. Rebuild? (y/N): ');
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          process.exit(0);
        }
      }
    } catch (err) {
      // Index doesn't exist, proceed
    }

    await buildIndex(workspaceName, uncPath, indexPath, router);
    console.log('\n🎉 Index built successfully!');
  }
}

async function buildIndex(workspaceName, uncPath, indexPath, router) {
  const startTime = Date.now();
  const indexFile = path.join(indexPath, `${workspaceName}.json`);
  
  const index = {
    version: 2,
    workspace: workspaceName,
    uncPath: uncPath,
    created_at: new Date().toISOString(),
    last_full_build: new Date().toISOString(),
    last_refresh: new Date().toISOString(),
    file_count: 0,
    total_size_bytes: 0,
    build_in_progress: false,
    files: {}
  };

  console.log('Phase 1: Scanning workspace...');
  const files = new Map();
  await walkWorkspace(uncPath, uncPath, files);
  console.log(`Found ${files.size} files\n`);

  console.log('Phase 2: Reading & parsing files...');
  const fileData = []; // {filePath, metadata, content, contentHash, tree, embeddingText}
  let totalSize = 0;
  let readCount = 0;

  for (const [filePath, metadata] of files) {
    readCount++;
    totalSize += metadata.size;

    if (readCount % 100 === 0 || readCount === files.size) {
      process.stdout.write(`\rReading: ${readCount}/${files.size}`);
    }

    try {
      const fullPath = path.join(uncPath, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const contentHash = createHash('sha256').update(content).digest('hex');
      const tree = parseFile(content, filePath);
      const embeddingText = generateEmbeddingText(filePath, tree);

      fileData.push({ filePath, metadata, contentHash, tree, embeddingText });
    } catch (err) {
      console.warn(`\nWarning: Failed to read ${filePath}: ${err.message}`);
    }
  }

  console.log(`\n✓ Parsed ${fileData.length} files\n`);

  const BATCH_SIZE = 50;
  const PARALLEL_REQUESTS = 4;
  
  console.log(`Phase 3: Embedding (batch=${BATCH_SIZE}, parallel=${PARALLEL_REQUESTS})...`);
  const embedStartTime = Date.now();

  const batches = [];
  for (let i = 0; i < fileData.length; i += BATCH_SIZE) {
    batches.push(fileData.slice(i, i + BATCH_SIZE));
  }

  let embeddedCount = 0;
  const allEmbeddings = new Map(); // filePath -> embedding

  for (let i = 0; i < batches.length; i += PARALLEL_REQUESTS) {
    const parallelBatches = batches.slice(i, i + PARALLEL_REQUESTS);
    
    const results = await Promise.all(
      parallelBatches.map(async (batch) => {
        const texts = batch.map(f => f.embeddingText);
        const embeddings = await router.embedBatch(texts, null);
        return batch.map((f, idx) => ({ filePath: f.filePath, embedding: embeddings[idx] }));
      })
    );

    for (const batchResult of results) {
      for (const { filePath, embedding } of batchResult) {
        allEmbeddings.set(filePath, embedding);
        embeddedCount++;
      }
    }

    const progress = ((embeddedCount / fileData.length) * 100).toFixed(1);
    const elapsed = ((Date.now() - embedStartTime) / 1000).toFixed(1);
    const rate = (embeddedCount / (Date.now() - embedStartTime) * 1000).toFixed(1);
    process.stdout.write(`\rEmbedding: ${embeddedCount}/${fileData.length} (${progress}%) - ${elapsed}s - ${rate}/s`);
  }

  const embedDuration = ((Date.now() - embedStartTime) / 1000).toFixed(1);
  console.log(`\n✓ Embedded in ${embedDuration}s (${(fileData.length / embedDuration).toFixed(1)} files/s)\n`);

  console.log('Phase 4: Building index...');
  for (const { filePath, metadata, contentHash, tree } of fileData) {
    const fileId = generateFileId(workspaceName, filePath);
    index.files[fileId] = {
      id: fileId,
      path: filePath,
      content_hash: contentHash,
      mtime: metadata.mtime,
      last_indexed_at: new Date().toISOString(),
      language: detectLanguage(filePath),
      size_bytes: metadata.size,
      tree,
      embedding: allEmbeddings.get(filePath) || [],
      parse_failed: false
    };
  }

  index.file_count = Object.keys(index.files).length;
  index.total_size_bytes = totalSize;

  console.log('Phase 5: Writing index...');
  await atomicWriteIndex(indexFile, index);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Index built successfully in ${duration}s`);
  console.log(`  Files: ${index.file_count}`);
  console.log(`  Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Index file: ${indexFile}`);
}

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--all') {
      args.all = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--workspace' && process.argv[i + 1]) {
      args.workspace = process.argv[++i];
    }
  }
  return args;
}

function promptUser(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
