/**
 * Centralized code indexing utilities
 * Shared by build-index.js and server.js refreshIndex
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

// ========== FILE ID GENERATION ==========

export function generateFileId(workspace, filePath) {
  const fileKey = `${workspace}:${filePath}`;
  return createHash('sha256').update(fileKey).digest('hex').slice(0, 32);
}

// ========== LANGUAGE DETECTION ==========

export function detectLanguage(filePath) {
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

// ========== CONTENT PARSING ==========

function getLineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

export function parseFile(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const tree = {
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    comments: []
  };

  if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
    const functionRegex = /(?:function|const|let|var)\s+(\w+)\s*[=\(]/g;
    const classRegex = /class\s+(\w+)/g;
    const importRegex = /import\s+.*?from\s+['"](.+?)['"]/g;

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
  }

  return tree;
}

// ========== WORKSPACE SCANNING ==========

const EXCLUDED_DIRS = ['.git', 'node_modules', '.next', 'dist', 'build', '.vscode', '$RECYCLE.BIN', 'System Volume Information', 'Recovery', '$Recycle.Bin'];
const INCLUDED_EXTS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.md'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export async function walkWorkspace(basePath, currentPath, files) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(basePath, fullPath);

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry.name)) continue;
      await walkWorkspace(basePath, fullPath, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!INCLUDED_EXTS.includes(ext)) continue;

      const stats = await fs.stat(fullPath);
      if (stats.size > MAX_FILE_SIZE) continue;
      
      files.set(relativePath.replace(/\\/g, '/'), {
        mtime: stats.mtimeMs,
        size: stats.size
      });
    }
  }
}

// ========== EMBEDDING TEXT GENERATION ==========

export function generateEmbeddingText(filePath, tree) {
  let embeddingText = filePath;
  if (tree && (tree.functions.length > 0 || tree.classes.length > 0)) {
    const symbols = [
      ...tree.functions.map(f => f.name),
      ...tree.classes.map(c => c.name)
    ].join(' ');
    embeddingText = `${filePath} ${symbols}`;
  }
  if (embeddingText.length > 8000) {
    embeddingText = embeddingText.slice(0, 8000);
  }
  return embeddingText;
}

// ========== INDEX I/O ==========

export async function writeIndexStreaming(filePath, index) {
  const { createWriteStream } = await import('fs');
  const stream = createWriteStream(filePath, { encoding: 'utf-8' });
  
  const write = (data) => new Promise((resolve, reject) => {
    if (!stream.write(data)) {
      stream.once('drain', resolve);
    } else {
      resolve();
    }
  });

  await write('{\n');
  await write(`  "version": ${index.version},\n`);
  await write(`  "workspace": ${JSON.stringify(index.workspace)},\n`);
  await write(`  "created_at": ${JSON.stringify(index.created_at)},\n`);
  await write(`  "last_full_build": ${JSON.stringify(index.last_full_build)},\n`);
  await write(`  "last_refresh": ${JSON.stringify(index.last_refresh)},\n`);
  await write(`  "file_count": ${index.file_count},\n`);
  await write(`  "total_size_bytes": ${index.total_size_bytes},\n`);
  await write(`  "build_in_progress": ${index.build_in_progress},\n`);
  if (index.lock_acquired_at !== undefined) {
    await write(`  "lock_acquired_at": ${JSON.stringify(index.lock_acquired_at)},\n`);
  }
  await write(`  "files": {\n`);

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

export async function atomicWriteIndex(indexFile, data) {
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  const tempFile = `${indexFile}.tmp.${Date.now()}`;
  await writeIndexStreaming(tempFile, data);
  await fs.rename(tempFile, indexFile);
}

export async function loadIndex(indexFile) {
  const content = await fs.readFile(indexFile, 'utf-8');
  return JSON.parse(content);
}
