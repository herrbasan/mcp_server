#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * CLI tool for building full code search index
 * Usage: node scripts/build-index.js --workspace "D:\DEV\mcp_server" [--machine COOLKID]
 */

async function main() {
  const args = parseArgs();
  
  if (!args.workspace) {
    console.error('Usage: node scripts/build-index.js --workspace "path" [--machine name]');
    process.exit(1);
  }

  console.log('🔍 Code Search Index Builder');
  console.log('============================\n');

  // Load config and substitute environment variables
  const configPath = path.join(__dirname, '..', 'config.json');
  let configText = await fs.readFile(configPath, 'utf-8');
  
  // Substitute ${VAR} with process.env.VAR
  configText = configText.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return process.env[varName] || match;
  });
  
  const config = JSON.parse(configText);

  // Initialize workspace resolver
  const { WorkspaceResolver } = await import('../src/lib/workspace.js');
  const workspace = new WorkspaceResolver(config.workspaces || {});

  // Resolve path
  const machine = args.machine || config.workspaces.defaultMachine;
  console.log(`Machine: ${machine}`);
  console.log(`Local path: ${args.workspace}`);
  
  const uncPath = workspace.resolvePath(args.workspace, machine);
  console.log(`UNC path: ${uncPath}\n`);

  // Determine index file path
  const indexPath = config.servers['code-search']?.indexPath || 'data/indexes';
  const indexFilename = workspace.getIndexPath(args.workspace, machine);
  const indexFile = path.join(indexPath, indexFilename);

  console.log(`Index file: ${indexFile}\n`);

  // Check if index exists
  try {
    await fs.access(indexFile);
    const answer = await promptUser('Index already exists. Rebuild? (y/N): ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(0);
    }
  } catch (err) {
    // Index doesn't exist, proceed
  }

  // Initialize LLM router for embeddings
  console.log('Initializing LLM router...');
  const { LLMRouter } = await import('../src/llm/router.js');
  const router = new LLMRouter(config.llm);
  console.log('✓ LLM router ready\n');

  // Build index
  const startTime = Date.now();
  const index = {
    version: 2,
    workspace: uncPath,
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

      // Generate embedding text
      let embeddingText = filePath;
      if (tree.functions.length > 0 || tree.classes.length > 0) {
        const symbols = [
          ...tree.functions.map(f => f.name),
          ...tree.classes.map(c => c.name)
        ].join(' ');
        embeddingText = `${filePath} ${symbols}`;
      }
      if (embeddingText.length > 8000) {
        embeddingText = embeddingText.slice(0, 8000);
      }

      fileData.push({ filePath, metadata, contentHash, tree, embeddingText });
    } catch (err) {
      console.warn(`\nWarning: Failed to read ${filePath}: ${err.message}`);
    }
  }

  console.log(`\n✓ Parsed ${fileData.length} files\n`);

  // Batch embedding with parallel requests
  const BATCH_SIZE = 50;
  const PARALLEL_REQUESTS = 4;
  
  console.log(`Phase 3: Embedding (batch=${BATCH_SIZE}, parallel=${PARALLEL_REQUESTS})...`);
  const embedStartTime = Date.now();

  // Create batches
  const batches = [];
  for (let i = 0; i < fileData.length; i += BATCH_SIZE) {
    batches.push(fileData.slice(i, i + BATCH_SIZE));
  }

  let embeddedCount = 0;
  const allEmbeddings = new Map(); // filePath -> embedding

  // Process batches in parallel chunks
  for (let i = 0; i < batches.length; i += PARALLEL_REQUESTS) {
    const parallelBatches = batches.slice(i, i + PARALLEL_REQUESTS);
    
    const results = await Promise.all(
      parallelBatches.map(async (batch) => {
        const texts = batch.map(f => f.embeddingText);
        const embeddings = await router.embedBatch(texts, null);
        return batch.map((f, idx) => ({ filePath: f.filePath, embedding: embeddings[idx] }));
      })
    );

    // Collect results
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

  // Build index
  console.log('Phase 4: Building index...');
  for (const { filePath, metadata, contentHash, tree } of fileData) {
    index.files[filePath] = {
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
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  
  // Stream write to avoid "Invalid string length" for large indexes
  await writeIndexStreaming(indexFile, index);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Index built successfully in ${duration}s`);
  console.log(`  Files: ${index.file_count}`);
  console.log(`  Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Index file: ${indexFile}`);
}

/**
 * Write index file in streaming fashion to handle large file counts.
 * Avoids "Invalid string length" error from JSON.stringify.
 */
async function writeIndexStreaming(filePath, index) {
  const { createWriteStream } = await import('fs');
  const stream = createWriteStream(filePath, { encoding: 'utf-8' });
  
  const write = (data) => new Promise((resolve, reject) => {
    if (!stream.write(data)) {
      stream.once('drain', resolve);
    } else {
      resolve();
    }
  });

  // Write header
  await write('{\n');
  await write(`  "version": ${index.version},\n`);
  await write(`  "workspace": ${JSON.stringify(index.workspace)},\n`);
  await write(`  "created_at": ${JSON.stringify(index.created_at)},\n`);
  await write(`  "last_full_build": ${JSON.stringify(index.last_full_build)},\n`);
  await write(`  "last_refresh": ${JSON.stringify(index.last_refresh)},\n`);
  await write(`  "file_count": ${index.file_count},\n`);
  await write(`  "total_size_bytes": ${index.total_size_bytes},\n`);
  await write(`  "build_in_progress": ${index.build_in_progress},\n`);
  await write(`  "files": {\n`);

  // Write files one at a time
  const entries = Object.entries(index.files);
  for (let i = 0; i < entries.length; i++) {
    const [key, value] = entries[i];
    const comma = i < entries.length - 1 ? ',' : '';
    await write(`    ${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}\n`);
  }

  await write('  }\n');
  await write('}\n');

  await new Promise((resolve, reject) => {
    stream.end(resolve);
    stream.on('error', reject);
  });
}

async function walkWorkspace(basePath, currentPath, files) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      // Skip ignored directories
      if (['.git', 'node_modules', '.next', 'dist', 'build', '.vscode', '__pycache__'].includes(entry.name)) {
        continue;
      }
      await walkWorkspace(basePath, fullPath, files);
    } else if (entry.isFile()) {
      // Only index code files
      const ext = path.extname(entry.name).toLowerCase();
      if (!['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.md'].includes(ext)) {
        continue;
      }

      const stats = await fs.stat(fullPath);
      files.set(relativePath.replace(/\\/g, '/'), {
        mtime: stats.mtimeMs,
        size: stats.size
      });
    }
  }
}

function parseFile(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const tree = {
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    comments: []
  };

  // Basic regex parsing for JS/TS
  if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
    const functionRegex = /(?:function|const|let|var)\s+(\w+)\s*[=\(]/g;
    const classRegex = /class\s+(\w+)/g;
    const importRegex = /import\s+.*?from\s+['"](.+?)['"]/g;
    const exportRegex = /export\s+(?:default\s+)?(?:class|function|const|let|var)\s+(\w+)/g;

    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      tree.functions.push({ name: match[1], line: getLineNumber(content, match.index) });
    }
    while ((match = classRegex.exec(content)) !== null) {
      tree.classes.push({ name: match[1], line: getLineNumber(content, match.index) });
    }
    while ((match = importRegex.exec(content)) !== null) {
      tree.imports.push({ module: match[1] });
    }
    while ((match = exportRegex.exec(content)) !== null) {
      tree.exports.push(match[1]);
    }
  }

  // Basic parsing for Python
  if (ext === '.py') {
    const functionRegex = /def\s+(\w+)\s*\(/g;
    const classRegex = /class\s+(\w+)/g;
    const importRegex = /(?:from\s+(\S+)\s+)?import\s+(.+)/g;

    let match;
    while ((match = functionRegex.exec(content)) !== null) {
      tree.functions.push({ name: match[1], line: getLineNumber(content, match.index) });
    }
    while ((match = classRegex.exec(content)) !== null) {
      tree.classes.push({ name: match[1], line: getLineNumber(content, match.index) });
    }
    while ((match = importRegex.exec(content)) !== null) {
      tree.imports.push({ module: match[1] || match[2].split(',')[0].trim() });
    }
  }

  return tree;
}

function getLineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const langMap = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.cs': 'csharp',
    '.go': 'go',
    '.rs': 'rust',
    '.md': 'markdown'
  };
  return langMap[ext] || 'unknown';
}

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, '');
    const value = process.argv[i + 1];
    args[key] = value;
  }
  return args;
}

function promptUser(question) {
  return new Promise(resolve => {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    readline.question(question, answer => {
      readline.close();
      resolve(answer);
    });
  });
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
