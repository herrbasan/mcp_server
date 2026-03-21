/**
 * Indexer - File walking, parsing, and embedding generation
 * 
 * Phase 4 improvements:
 * - Batch embedding generation (2-3x faster)
 * - Better progress reporting (current file, rate)
 * - Error collection (don't stop on bad files)
 * - Cancel support
 */

import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { parseJavaScript, parseTypeScript, parsePython, parseRust } from './parser/index.js';

const PARSERS = {
  '.js': parseJavaScript,
  '.ts': parseTypeScript,
  '.jsx': parseJavaScript,
  '.tsx': parseTypeScript,
  '.py': parsePython,
  '.rs': parseRust
};

export class Indexer {
  constructor(config, llmRouter) {
    this.config = config;
    this.router = llmRouter;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Index a directory with batch processing
   */
  async indexDirectory({ source, collection, metadata, incremental = false, onProgress }) {
    const startTime = Date.now();
    this.cancelled = false;
    
    // Get existing files if incremental
    const existingFiles = incremental 
      ? new Map((await metadata.getAllFiles()).map(f => [f.path, f]))
      : new Map();

    // Walk directory
    onProgress?.({ phase: 'scanning', message: 'Scanning files...' });
    const filesToIndex = [];
    await this._walkDirectory(source, source, filesToIndex);

    // Determine what to index
    const toIndex = [];
    const toDelete = [];

    for (const file of filesToIndex) {
      if (this.cancelled) throw new Error('Indexing cancelled');
      
      const existing = existingFiles.get(file.relativePath);
      
      if (!existing) {
        toIndex.push(file);
      } else if (existing.mtime < file.mtime) {
        toIndex.push(file);
        existingFiles.delete(file.relativePath);
      } else {
        existingFiles.delete(file.relativePath);
      }
    }

    // Remaining existing files were deleted
    for (const [p] of existingFiles) {
      toDelete.push(p);
    }

    const totalFiles = toIndex.length;
    onProgress?.({ 
      phase: 'indexing', 
      total: totalFiles, 
      current: 0, 
      message: totalFiles === 0 ? 'Nothing to index' : `Indexing ${totalFiles} files` 
    });

    // Delete removed files
    for (const filePath of toDelete) {
      await metadata.deleteFile(filePath);
      try {
        collection.delete(filePath);
      } catch {
        // May not exist in collection
      }
    }

    if (totalFiles === 0) {
      return { indexed: 0, errors: 0, duration: Date.now() - startTime, errorsDetail: [] };
    }

    // Process files in batches for embeddings
    const EMBED_BATCH_SIZE = 25;  // LM Studio handles 25 well
    const DB_BATCH_SIZE = 50;     // nDB insert batch
    
    let indexed = 0;
    const errors = [];
    let processedCount = 0;
    let lastProgressTime = Date.now();

    // Phase 1: Parse all files and prepare embedding texts
    const parsedFiles = [];
    for (let i = 0; i < toIndex.length; i++) {
      const fileInfo = toIndex[i];
      
      try {
        const parsed = await this._parseFile(fileInfo);
        if (parsed) {
          parsedFiles.push({ ...fileInfo, ...parsed });
        }
      } catch (err) {
        errors.push({ file: fileInfo.relativePath, error: err.message });
      }
      
      // Progress every 50 files during parsing
      if ((i + 1) % 50 === 0) {
        onProgress?.({
          phase: 'parsing',
          total: totalFiles,
          current: i + 1,
          message: `Parsed ${i + 1}/${totalFiles} files`
        });
      }
    }

    // Phase 2: Batch generate embeddings
    const embeddings = [];
    for (let i = 0; i < parsedFiles.length; i += EMBED_BATCH_SIZE) {
      if (this.cancelled) throw new Error('Indexing cancelled');
      
      const batch = parsedFiles.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map(p => p.embeddingText);
      
      try {
        const vectors = await this.router.embedBatch(texts);
        
        for (let j = 0; j < batch.length; j++) {
          embeddings.push({
            ...batch[j],
            vector: vectors[j]
          });
        }
      } catch (err) {
        // Fall back to individual embedding on batch failure
        for (const item of batch) {
          try {
            const vector = await this.router.embedText(item.embeddingText);
            embeddings.push({ ...item, vector });
          } catch (e) {
            errors.push({ file: item.relativePath, error: e.message });
          }
        }
      }
      
      // Progress during embedding
      const now = Date.now();
      if (now - lastProgressTime > 500) {  // Update every 500ms
        const rate = embeddings.length / ((now - startTime) / 1000);
        onProgress?.({
          phase: 'embedding',
          total: totalFiles,
          current: Math.min(i + EMBED_BATCH_SIZE, parsedFiles.length),
          message: `Embedded ${Math.min(i + EMBED_BATCH_SIZE, parsedFiles.length)}/${parsedFiles.length} files (${rate.toFixed(1)}/s)`,
          rate
        });
        lastProgressTime = now;
      }
    }

    // Phase 3: Batch insert into nDB and SQLite
    for (let i = 0; i < embeddings.length; i += DB_BATCH_SIZE) {
      if (this.cancelled) throw new Error('Indexing cancelled');
      
      const batch = embeddings.slice(i, i + DB_BATCH_SIZE);
      
      for (const item of batch) {
        try {
          // nDB insert
          collection.insert(item.relativePath, item.vector, JSON.stringify({
            path: item.relativePath,
            language: this._getLanguage(item.ext),
            size: item.size,
            functions: item.symbols.functions,
            classes: item.symbols.classes,
            imports: item.symbols.imports
          }));
          
          // SQLite metadata
          await metadata.saveFile(item.relativePath, {
            mtime: item.mtime,
            size: item.size,
            hash: item.hash,
            language: this._getLanguage(item.ext),
            content: item.content,
            symbols: item.symbols
          });
          
          indexed++;
        } catch (err) {
          errors.push({ file: item.relativePath, error: err.message });
        }
      }
      
      processedCount += batch.length;
      
      // Progress
      const now = Date.now();
      const rate = processedCount / ((now - startTime) / 1000);
      onProgress?.({
        phase: 'storing',
        total: totalFiles,
        current: processedCount,
        message: `Stored ${processedCount}/${totalFiles} files (${rate.toFixed(1)}/s)`,
        rate
      });
    }

    const duration = Date.now() - startTime;
    
    return {
      indexed,
      errors: errors.length,
      duration,
      errorsDetail: errors.slice(0, 10),  // First 10 errors
      rate: indexed / (duration / 1000)
    };
  }

  /**
   * Parse a single file (no embedding yet)
   */
  async _parseFile(fileInfo) {
    const { fullPath, relativePath, mtime, size, ext } = fileInfo;

    const content = await fs.readFile(fullPath, 'utf-8');
    const hash = createHash('md5').update(content).digest('hex');

    const parser = PARSERS[ext];
    const symbols = parser ? parser(content) : { functions: [], classes: [], imports: [] };

    const embeddingText = this._prepareEmbeddingText(relativePath, content, symbols);

    return {
      relativePath,
      mtime,
      size,
      ext,
      hash,
      content,
      symbols,
      embeddingText
    };
  }

  /**
   * Walk directory and collect files
   */
  async _walkDirectory(basePath, currentPath, files) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (this._shouldIgnore(relativePath, true)) continue;
        await this._walkDirectory(basePath, fullPath, files);
      } else if (entry.isFile()) {
        if (this._shouldIgnore(relativePath, false)) continue;

        const stats = await fs.stat(fullPath);
        if (stats.size > this.config.maxFileSize) continue;

        const ext = path.extname(entry.name).toLowerCase();
        
        // Skip binary files by checking for null bytes in first chunk
        try {
          const fd = await fs.open(fullPath, 'r');
          const buffer = Buffer.alloc(1024);
          const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
          await fd.close();
          
          // Check for null bytes = binary file
          if (bytesRead > 0 && buffer.slice(0, bytesRead).includes(0)) {
            continue;
          }
        } catch {
          continue; // Can't read, skip
        }

        files.push({
          fullPath,
          relativePath,
          mtime: stats.mtimeMs,
          size: stats.size,
          ext
        });
      }
    }
  }

  _shouldIgnore(relativePath, isDirectory) {
    for (const pattern of this.config.ignorePatterns) {
      if (this._matchGlob(relativePath, pattern)) return true;
    }
    return false;
  }

  _matchGlob(path, pattern) {
    let regex = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/\/\{\{GLOBSTAR\}\}$/, '(?:/.*)?')
      .replace(/^\{\{GLOBSTAR\}\}\//, '(?:.*/)?')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    
    return new RegExp(`^${regex}$`).test(path);
  }

  _prepareEmbeddingText(filePath, content, symbols) {
    // Prioritize symbols - they define what the file IS
    const symbolNames = [
      ...symbols.functions.map(f => f.name),
      ...symbols.classes.map(c => c.name)
    ].join(' ');
    
    // Repeat symbols for weight + smaller content sample
    const contentSample = content.slice(0, 1000);
    
    // Format: path + repeated symbols + content
    // Repeating symbols gives them more weight in the embedding
    return `${filePath} ${symbolNames} ${symbolNames} ${contentSample}`;
  }

  _getLanguage(ext) {
    const mapping = {
      '.js': 'javascript',
      '.ts': 'typescript',
      '.jsx': 'javascript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.rs': 'rust',
      '.java': 'java',
      '.go': 'go',
      '.rb': 'ruby',
      '.php': 'php',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp',
      '.c': 'c',
      '.h': 'c',
      '.hpp': 'cpp',
      '.cs': 'csharp',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.r': 'r',
      '.m': 'objective-c',
      '.mm': 'objective-cpp',
      '.pl': 'perl',
      '.lua': 'lua',
      '.groovy': 'groovy',
      '.dart': 'dart',
      '.elm': 'elm',
      '.erl': 'erlang',
      '.hrl': 'erlang',
      '.ex': 'elixir',
      '.exs': 'elixir',
      '.fs': 'fsharp',
      '.fsx': 'fsharp',
      '.hs': 'haskell',
      '.lhs': 'haskell',
      '.jl': 'julia',
      '.ml': 'ocaml',
      '.mli': 'ocaml',
      '.nim': 'nim',
      '.pas': 'pascal',
      '.pp': 'pascal',
      '.scm': 'scheme',
      '.ss': 'scheme',
      '.tcl': 'tcl',
      '.coffee': 'coffeescript',
      '.litcoffee': 'coffeescript',
      '.vb': 'vbnet',
      '.fs': 'fsharp',
      // Markup/Config/Data
      '.md': 'markdown',
      '.mdx': 'markdown',
      '.html': 'html',
      '.htm': 'html',
      '.xml': 'xml',
      '.css': 'css',
      '.scss': 'scss',
      '.sass': 'sass',
      '.less': 'less',
      '.json': 'json',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.toml': 'toml',
      '.ini': 'ini',
      '.cfg': 'config',
      '.conf': 'config',
      '.sh': 'shell',
      '.bash': 'shell',
      '.zsh': 'shell',
      '.fish': 'shell',
      '.ps1': 'powershell',
      '.psm1': 'powershell',
      '.psd1': 'powershell',
      '.bat': 'batch',
      '.cmd': 'batch',
      '.sql': 'sql',
      '.dockerfile': 'dockerfile',
      '.tf': 'terraform',
      '.hcl': 'hcl',
      '.proto': 'protobuf',
      '.graphql': 'graphql',
      '.gql': 'graphql'
    };
    return mapping[ext] || 'text';
  }
}

// Parsers imported from ./parser/index.js (tree-sitter with regex fallback)
