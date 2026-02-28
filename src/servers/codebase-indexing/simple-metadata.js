/**
 * Simple Metadata Store - JSON-based (replaces SQLite)
 * 
 * Stores:
 * - File metadata (mtime, size, hash) in JSON manifest
 * - Symbols come from nDB payload (no duplication)
 * - Content comes from filesystem (no duplication)
 */

import fs from 'fs/promises';
import path from 'path';

export class SimpleMetadataStore {
  constructor(basePath) {
    this.basePath = basePath;
    this.manifestPath = path.join(basePath, 'manifest.json');
    this.cache = null;
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
  }

  async save() {
    await fs.writeFile(this.manifestPath, JSON.stringify(this.cache, null, 2));
  }

  async saveFile(filePath, { mtime, size, hash, language }) {
    this.cache.files[filePath] = {
      mtime,
      size,
      hash,
      language,
      lastIndexed: new Date().toISOString()
    };
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

  // Keyword search - simple path-based search
  async searchKeyword(query, limit = 20) {
    const results = [];
    const lowerQuery = query.toLowerCase();
    
    for (const [path, data] of Object.entries(this.cache.files)) {
      // Score based on how well the path matches the query
      const lowerPath = path.toLowerCase();
      let score = 0;
      
      if (lowerPath.includes(lowerQuery)) {
        // Exact match in path gets higher score
        score = lowerPath === lowerQuery ? 1.0 : 
                lowerPath.split('/').pop().includes(lowerQuery) ? 0.8 : 0.5;
        
        results.push({
          path,
          rank: -score, // Negative because FTS5 rank convention (lower is better)
          ...data
        });
      }
      
      if (results.length >= limit) break;
    }
    
    // Sort by rank (most relevant first)
    results.sort((a, b) => a.rank - b.rank);
    return results;
  }

  /**
   * Get file tree structure for browsing
   */
  async getFileTree(subpath = '') {
    const entries = new Map(); // Use map to deduplicate
    const prefix = subpath ? subpath.replace(/\/$/, '') + '/' : '';
    
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
