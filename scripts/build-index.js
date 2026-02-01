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

  console.log('Phase 2: Parsing & embedding...');
  let processed = 0;
  let totalSize = 0;

  for (const [filePath, metadata] of files) {
    processed++;
    totalSize += metadata.size;

    if (processed % 10 === 0 || processed === files.size) {
      const progress = ((processed / files.size) * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`\rProgress: ${processed}/${files.size} (${progress}%) - ${elapsed}s`);
    }

    try {
      const fullPath = path.join(uncPath, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const contentHash = createHash('sha256').update(content).digest('hex');

      // Parse file structure
      const tree = parseFile(content, filePath);

      // Generate embedding
      let embeddingText = filePath;
      if (tree.functions.length > 0 || tree.classes.length > 0) {
        const symbols = [
          ...tree.functions.map(f => f.name),
          ...tree.classes.map(c => c.name)
        ].join(' ');
        embeddingText = `${filePath} ${symbols}`;
      }

      // Truncate to avoid token limits
      if (embeddingText.length > 8000) {
        embeddingText = embeddingText.slice(0, 8000);
      }

      const embedding = await router.embedText(embeddingText, null); // null = use task default

      index.files[filePath] = {
        path: filePath,
        content_hash: contentHash,
        mtime: metadata.mtime,
        last_indexed_at: new Date().toISOString(),
        language: detectLanguage(filePath),
        size_bytes: metadata.size,
        tree,
        embedding,
        parse_failed: false
      };
    } catch (err) {
      console.warn(`\nWarning: Failed to index ${filePath}: ${err.message}`);
    }
  }

  index.file_count = Object.keys(index.files).length;
  index.total_size_bytes = totalSize;

  console.log('\n\nPhase 3: Writing index...');
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  await fs.writeFile(indexFile, JSON.stringify(index, null, 2));

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Index built successfully in ${duration}s`);
  console.log(`  Files: ${index.file_count}`);
  console.log(`  Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Index file: ${indexFile}`);
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
