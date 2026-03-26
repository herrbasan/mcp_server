/**
 * Simple Metadata Store - JSON-based with content search
 * 
 * Stores:
 * - File metadata (mtime, size, hash, language) in JSON manifest
 * - File content snippets for fast keyword search (NEW)
 * - Symbols come from nDB payload (no duplication)
 * - Full content comes from filesystem (no duplication)
 */

import fs from 'fs/promises';
import path from 'path';

// Content index for fast keyword search
class ContentIndex {
  constructor(basePath) {
    this.basePath = basePath;
    this.indexPath = path.join(basePath, 'content-index.json');
    this.index = null; // { word: [{ path, lines: [{ line, content }] }] }
    this.maxContentLength = 200; // Max chars per line snippet
    this.maxLinesPerFile = 10; // Max lines indexed per word per file
  }

  async load() {
    try {
      const data = await fs.readFile(this.indexPath, 'utf-8');
      const parsed = JSON.parse(data);

      // Validate structure: must be { word: [{ path: string, lines: array }] }
      if (parsed && typeof parsed === 'object') {
        for (const [word, entries] of Object.entries(parsed)) {
          if (!Array.isArray(entries)) {
            throw new Error(`Corrupted index: word "${word}" has non-array value`);
          }
          for (const entry of entries) {
            if (!entry || typeof entry.path !== 'string' || !Array.isArray(entry.lines)) {
              throw new Error(`Corrupted index: invalid entry for word "${word}"`);
            }
          }
        }
        this.index = parsed;
      } else {
        throw new Error('Corrupted index: root is not an object');
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.index = {};
      } else {
        console.warn(`[ContentIndex] Corrupted index, resetting: ${err.message}`);
        this.index = {};
      }
    }
  }

  async save() {
    await fs.writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
  }

  _tokenize(text) {
    // Extract identifiers and words
    // Match: camelCase, PascalCase, snake_case, kebab-case, alphanumeric
    const tokens = new Set();
    const words = text.match(/[a-zA-Z_][a-zA-Z0-9_]*|[a-zA-Z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g) || [];
    for (const word of words) {
      // Store lowercase for case-insensitive search
      tokens.add(word.toLowerCase());
      // Also store camelCase parts
      const parts = word.split(/(?=[A-Z])|_/);
      for (const part of parts) {
        if (part.length > 2) {
          tokens.add(part.toLowerCase());
        }
      }
    }
    return Array.from(tokens);
  }

  async indexFile(filePath, content) {
    const lines = content.split('\n');
    const seenWords = new Map(); // word -> count per file

    for (let i = 0; i < lines.length; i++) {
      const lineContent = lines[i];
      const words = this._tokenize(lineContent);

      for (const word of words) {
        const count = seenWords.get(word) || 0;
        if (count >= this.maxLinesPerFile) continue;
        seenWords.set(word, count + 1);

        if (!Array.isArray(this.index[word])) {
          this.index[word] = []; // Reset corrupted data
        }

        let entry = this.index[word].find(e => e.path === filePath);
        if (!entry) {
          entry = { path: filePath, lines: [] };
          this.index[word].push(entry);
        }

        entry.lines.push({
          line: i + 1,
          content: lineContent.trim().slice(0, this.maxContentLength)
        });
      }
    }
  }

  async removeFile(filePath) {
    for (const word of Object.keys(this.index)) {
      this.index[word] = this.index[word].filter(e => e.path !== filePath);
      if (this.index[word].length === 0) {
        delete this.index[word];
      }
    }
  }

  search(query, limit = 20) {
    const lowerQuery = query.toLowerCase();
    const results = [];
    const seenFiles = new Set();

    // Direct word match
    if (this.index[lowerQuery]) {
      for (const entry of this.index[lowerQuery]) {
        if (seenFiles.has(entry.path)) continue;
        seenFiles.add(entry.path);

        results.push({
          path: entry.path,
          rank: 0, // Best match
          matches: entry.lines.slice(0, 3) // Top 3 lines
        });

        if (results.length >= limit) break;
      }
    }

    // Partial matches
    if (results.length < limit) {
      for (const [word, entries] of Object.entries(this.index)) {
        if (word.includes(lowerQuery) || lowerQuery.includes(word)) {
          for (const entry of entries) {
            if (seenFiles.has(entry.path)) continue;
            seenFiles.add(entry.path);

            results.push({
              path: entry.path,
              rank: 1,
              matches: entry.lines.slice(0, 2)
            });

            if (results.length >= limit) break;
          }
        }
        if (results.length >= limit) break;
      }
    }

    return results;
  }
}

export class SimpleMetadataStore {
  constructor(basePath) {
    this.basePath = basePath;
    this.manifestPath = path.join(basePath, 'manifest.json');
    this.cache = null;
    this.contentIndex = new ContentIndex(basePath);
  }

  async init() {
    await fs.mkdir(this.basePath, { recursive: true });
    
    // Load or create manifest
    try {
      const data = await fs.readFile(this.manifestPath, 'utf-8');
      this.cache = JSON.parse(data);
    } catch {
      this.cache = { files: {}, lastIndexed: null };
    }

    // Load content index
    await this.contentIndex.load();
  }

  async save() {
    await fs.writeFile(this.manifestPath, JSON.stringify(this.cache, null, 2));
    await this.contentIndex.save();
  }

  async saveFile(filePath, { mtime, size, hash, language, content = null }) {
    this.cache.files[filePath] = {
      mtime,
      size,
      hash,
      language,
      lastIndexed: new Date().toISOString()
    };

    // Index content if provided
    if (content) {
      await this.contentIndex.indexFile(filePath, content);
    }

    await this.save();
  }

  async getFile(filePath) {
    const meta = this.cache.files[filePath];
    if (!meta) return null;

    // Return metadata only - content is read by the service from source directory
    return {
      path: filePath,
      ...meta,
      stale: false  // Staleness checked by service using mtime
    };
  }

  async deleteFile(filePath) {
    delete this.cache.files[filePath];
    await this.contentIndex.removeFile(filePath);
    await this.save();
  }

  async getAllFiles() {
    return Object.entries(this.cache.files).map(([path, data]) => ({
      path,
      ...data
    }));
  }

  get fileCount() {
    return Object.keys(this.cache.files).length;
  }

  get lastIndexed() {
    return this.cache.lastIndexed;
  }

  async setLastIndexed(date = new Date().toISOString()) {
    this.cache.lastIndexed = date;
    await this.save();
  }

  /**
   * Close the store - no-op for JSON-based store
   */
  close() {
    // JSON-based store, nothing to close
    this.cache = null;
  }

  async _hash(content) {
    const { createHash } = await import('crypto');
    return createHash('md5').update(content).digest('hex');
  }

  // Keyword search - path-based + optional content search
  async searchKeyword(query, limit = 20, searchContent = true) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    const seenPaths = new Set();
    
    // 1. Path-based search (fast)
    for (const [filePath, data] of Object.entries(this.cache.files)) {
      const lowerPath = filePath.toLowerCase();
      let score = 0;
      
      if (lowerPath.includes(lowerQuery)) {
        // Exact match in path gets higher score
        score = lowerPath === lowerQuery ? 1.0 : 
                lowerPath.split('/').pop().includes(lowerQuery) ? 0.8 : 0.5;
        
        results.push({
          path: filePath,
          rank: -score, // Negative because FTS5 rank convention (lower is better)
          ...data
        });
        seenPaths.add(filePath);
      }
      
      if (results.length >= limit) break;
    }
    
    // 2. Content search (if enabled and we have room)
    if (searchContent && results.length < limit) {
      const contentResults = this.contentIndex.search(query, limit - results.length);
      
      for (const contentResult of contentResults) {
        if (seenPaths.has(contentResult.path)) {
          // Merge with existing path result
          const existing = results.find(r => r.path === contentResult.path);
          if (existing) {
            existing.contentMatches = contentResult.matches;
            existing.rank = Math.min(existing.rank, contentResult.rank); // Better rank
          }
          continue;
        }
        
        const fileData = this.cache.files[contentResult.path];
        if (fileData) {
          results.push({
            path: contentResult.path,
            rank: contentResult.rank,
            contentMatches: contentResult.matches,
            ...fileData
          });
          seenPaths.add(contentResult.path);
        }
      }
    }
    
    // Sort by rank (most relevant first)
    results.sort((a, b) => a.rank - b.rank);
    return results.slice(0, limit);
  }

  /**
   * Get file tree structure for browsing
   */
  async getFileTree(subpath = '') {
    const entries = new Map(); // Use map to deduplicate
    const prefix = subpath ? subpath.replace(/\/ $/, '') + '/' : '';
    
    for (const filePath of Object.keys(this.cache.files)) {
      // Skip files not under the requested subpath
      if (subpath && !filePath.startsWith(prefix)) continue;
      
      // Get the relative path from the subpath
      const relativePath = subpath ? filePath.slice(prefix.length) : filePath;
      const parts = relativePath.split('/');
      
      if (parts.length === 0) continue;
      
      const firstPart = parts[0];
      if (parts.length === 1) {
        // This is a file
        entries.set(firstPart, { name: firstPart, type: 'file' });
      } else {
        // This is a directory
        entries.set(firstPart, { name: firstPart, type: 'dir' });
      }
    }
    
    return Array.from(entries.values()).sort((a, b) => {
      // Directories first, then alphabetically
      if (a.type === 'dir' && b.type === 'file') return -1;
      if (a.type === 'file' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });
  }
}
