/**
 * Live Grep - ripgrep integration for exact text search
 * 
 * Spawns ripgrep process for real-time results (no staleness)
 * Features: Caching, parallel threads, file size limits, early termination
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const execAsync = promisify(exec);

// Simple LRU cache for grep results
class GrepCache {
  constructor(maxSize = 100, ttlMs = 60000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  _makeKey(sourceDir, pattern, options) {
    const key = JSON.stringify({ sourceDir, pattern, options });
    return createHash('md5').update(key).digest('hex');
  }

  async _getDirFingerprint(sourceDir) {
    // Fast fingerprint based on file count and total size from manifest
    try {
      const manifestPath = path.join(sourceDir, '..', 'manifest.json');
      const data = await fs.readFile(manifestPath, 'utf-8').catch(() => null);
      if (data) {
        const manifest = JSON.parse(data);
        const files = Object.keys(manifest.files);
        const totalSize = files.reduce((sum, f) => sum + (manifest.files[f].size || 0), 0);
        return `${files.length}:${totalSize}`;
      }
    } catch {
      // Fall through to mtime
    }
    
    // Fallback: use directory mtime
    try {
      const stats = await fs.stat(sourceDir);
      return stats.mtimeMs.toString();
    } catch {
      return Date.now().toString();
    }
  }

  async get(sourceDir, pattern, options) {
    const key = this._makeKey(sourceDir, pattern, options);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    
    // Check fingerprint (did files change?)
    const currentFingerprint = await this._getDirFingerprint(sourceDir);
    if (currentFingerprint !== entry.fingerprint) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.results;
  }

  async set(sourceDir, pattern, options, results) {
    const key = this._makeKey(sourceDir, pattern, options);
    const fingerprint = await this._getDirFingerprint(sourceDir);
    
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, {
      results,
      timestamp: Date.now(),
      fingerprint
    });
  }

  clear() {
    this.cache.clear();
  }

  get stats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs
    };
  }
}

export class GrepSearcher {
  constructor() {
    this.cache = new GrepCache(100, 60000); // 100 entries, 60s TTL
  }

  /**
   * Search codebase with ripgrep
   * @param {string} sourceDir - Source directory to search
   * @param {string} pattern - Search pattern
   * @param {Object} options
   * @param {boolean} options.regex - Use regex pattern (default: true)
   * @param {string} options.pathPattern - Filter by path glob
   * @param {number} options.limit - Max results (default: 50)
   * @param {number} options.maxMatchesPerFile - Max matches per file, -1 for unlimited (default: 5)
   * @param {boolean} options.caseSensitive - Case sensitive search (default: false)
   * @param {number} options.timeoutMs - Search timeout in ms (default: 5000)
   * @param {boolean} options.noCache - Skip cache lookup (default: false)
   */
  async grep(sourceDir, pattern, options = {}) {
    const { 
      regex = true, 
      pathPattern, 
      limit = 50, 
      maxMatchesPerFile = 5,
      caseSensitive = false,
      timeoutMs = 5000,
      noCache = false
    } = options;
    
    // Check cache first (unless disabled)
    if (!noCache) {
      const cached = await this.cache.get(sourceDir, pattern, options);
      if (cached) {
        return cached;
      }
    }
    
    // Try ripgrep first, fall back to JavaScript implementation
    let results;
    try {
      results = await this._grepRipgrep(sourceDir, pattern, { 
        regex, pathPattern, limit, maxMatchesPerFile, caseSensitive, timeoutMs 
      });
    } catch (err) {
      if (err.message.includes('ripgrep not found')) {
        results = await this._grepJavascript(sourceDir, pattern, { 
          regex, pathPattern, limit, maxMatchesPerFile, caseSensitive 
        });
      } else {
        throw err;
      }
    }
    
    // Cache results
    if (!noCache) {
      await this.cache.set(sourceDir, pattern, options, results);
    }
    
    return results;
  }
  
  _grepRipgrep(sourceDir, pattern, options) {
    const { regex, pathPattern, limit, maxMatchesPerFile, caseSensitive, timeoutMs } = options;
    
    const args = [
      regex ? '--regexp' : '--fixed-strings',
      pattern,
      '--line-number',
      '--column',
      '--threads', '0', // Use all available CPU cores
      '--max-filesize', '1M', // Skip files > 1MB
      '--max-depth', '20',
      '--json',
      '--glob', '!node_modules/**',
      '--glob', '!.git/**',
      '--glob', '!dist/**',
      '--glob', '!build/**',
      '--glob', '!target/**',
      '--glob', '!*.map',
      '--glob', '!*.min.js',
      '--glob', '!*.lock',
      '--glob', '!package-lock.json',
      '--glob', '!Cargo.lock',
      '--glob', '!*.bin',
      '--glob', '!*.exe',
      '--glob', '!*.dll',
      '--glob', '!*.so',
      '--glob', '!*.dylib'
    ];
    
    // Case sensitivity
    if (caseSensitive) {
      args.push('--case-sensitive');
    } else {
      args.push('--smart-case');
    }
    
    if (pathPattern) {
      args.push('--glob', pathPattern);
    }

    return new Promise((resolve, reject) => {
      const results = [];
      let matchCount = 0;
      const fileMatchCounts = new Map(); // Track matches per file for maxMatchesPerFile
      const rg = spawn('rg', args, { 
        cwd: sourceDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderr = '';
      let killedEarly = false;
      
      rg.stdout.on('data', (data) => {
        // Early termination if we have enough total results
        if (matchCount >= limit) {
          if (!killedEarly) {
            killedEarly = true;
            rg.kill('SIGTERM');
          }
          return;
        }
        
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (matchCount >= limit) break;
          if (!line.trim()) continue;
          
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'match') {
              const match = parsed.data;
              const filePath = match.path.text;
              
              // Check per-file match limit
              const currentFileMatches = fileMatchCounts.get(filePath) || 0;
              if (maxMatchesPerFile > 0 && currentFileMatches >= maxMatchesPerFile) {
                continue; // Skip this match, file has enough
              }
              
              fileMatchCounts.set(filePath, currentFileMatches + 1);
              
              results.push({
                path: filePath,
                line: match.line_number,
                column: match.submatches[0]?.start || 0,
                content: match.lines.text?.trim() || '',
                match: match.submatches[0]?.match?.text || ''
              });
              matchCount++;
            }
          } catch {
            // Skip non-JSON lines
          }
        }
      });
      
      rg.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      rg.on('close', (code) => {
        if (code === 0 || code === 1 || code === null) {
          // code === null means we killed it early (enough results)
          resolve(results);
        } else {
          reject(new Error('ripgrep failed: ' + (stderr || 'exit code ' + code)));
        }
      });
      
      rg.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error('ripgrep not found'));
        } else {
          reject(err);
        }
      });
      
      // Timeout with early termination support
      const timeoutId = setTimeout(() => {
        rg.kill('SIGTERM');
        resolve(results); // Return what we found so far
      }, timeoutMs);
      
      // Clean up timeout on close
      rg.on('close', () => {
        clearTimeout(timeoutId);
      });
    });
  }
  
  async _grepPowershell(sourceDir, pattern, options) {
    const { limit, regex } = options;
    
    // Use JavaScript-based grep for better reliability on Windows
    return this._grepJavascript(sourceDir, pattern, { ...options, limit });
  }
  
  /**
   * JavaScript-based grep fallback - works on all platforms
   */
  async _grepJavascript(sourceDir, pattern, options) {
    const { limit = 50, regex = true, maxMatchesPerFile = -1, caseSensitive = false } = options;
    const results = [];
    
    const fs = await import('fs/promises');
    const path = await import('path');
    
    // Create search pattern
    const flags = caseSensitive ? '' : 'i';
    const searchRegex = regex ? new RegExp(pattern, flags) : new RegExp(this._escapeRegex(pattern), flags);
    
    // Extensions to search
    const extensions = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.rs', '.java', '.go', '.c', '.cpp', '.h', '.cs', '.rb', '.php', '.swift', '.kt', '.scala']);
    
    // Ignore patterns
    const ignorePatterns = [/node_modules/, /\.git/, /dist/, /build/, /target/, /\.next/, /coverage/, /\.nyc_output/];
    
    // Track per-file match counts
    const fileMatchCounts = new Map();
    
    async function searchDir(dir) {
      if (results.length >= limit) return;
      
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      
      for (const entry of entries) {
        if (results.length >= limit) break;
        
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(sourceDir, fullPath).replace(/\\/g, '/');
        
        // Skip ignored paths
        if (ignorePatterns.some(p => p.test(relativePath))) continue;
        
        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!extensions.has(ext)) continue;
          
          // Skip files > 1MB (consistent with ripgrep setting)
          const stats = await fs.stat(fullPath).catch(() => null);
          if (!stats || stats.size > 1024 * 1024) continue;
          
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length && results.length < limit; i++) {
              const line = lines[i];
              const match = line.match(searchRegex);
              if (match) {
                // Check per-file match limit
                const currentCount = fileMatchCounts.get(relativePath) || 0;
                if (maxMatchesPerFile > 0 && currentCount >= maxMatchesPerFile) {
                  break; // Stop searching this file, move to next
                }
                fileMatchCounts.set(relativePath, currentCount + 1);
                
                results.push({
                  path: relativePath,
                  line: i + 1,
                  column: match.index || 0,
                  content: line.trim().slice(0, 200), // Limit content length
                  match: match[0]
                });
              }
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
    
    await searchDir(sourceDir);
    return results;
  }
  
  _escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
