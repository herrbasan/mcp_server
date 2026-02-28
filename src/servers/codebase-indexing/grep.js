/**
 * Live Grep - ripgrep integration for exact text search
 * 
 * Spawns ripgrep process for real-time results (no staleness)
 */

import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class GrepSearcher {
  /**
   * Search codebase with ripgrep
   * @param {string} sourceDir - Source directory to search
   * @param {string} pattern - Search pattern
   * @param {Object} options
   * @param {boolean} options.regex - Use regex pattern (default: true)
   * @param {string} options.pathPattern - Filter by path glob
   * @param {number} options.limit - Max results
   */
  async grep(sourceDir, pattern, options = {}) {
    const { regex = true, pathPattern, limit = 50 } = options;
    
    // Try ripgrep first, fall back to PowerShell Select-String on Windows
    try {
      return await this._grepRipgrep(sourceDir, pattern, { regex, pathPattern, limit });
    } catch (err) {
      if (err.message.includes('ripgrep not found')) {
        return this._grepPowershell(sourceDir, pattern, { regex, pathPattern, limit });
      }
      throw err;
    }
  }
  
  _grepRipgrep(sourceDir, pattern, options) {
    const { regex, pathPattern, limit } = options;
    
    const args = [
      regex ? '--regexp' : '--fixed-strings',
      pattern,
      '--line-number',
      '--column',
      '--max-count=5',
      '--max-depth=20',
      '--smart-case',
      '--json',
      '--glob', '!node_modules/**',
      '--glob', '!.git/**',
      '--glob', '!dist/**',
      '--glob', '!build/**',
      '--glob', '!target/**',
      '--glob', '!*.map',
      '--glob', '!*.min.js'
    ];
    
    if (pathPattern) {
      args.push('--glob', pathPattern);
    }

    return new Promise((resolve, reject) => {
      const results = [];
      const rg = spawn('rg', args, { 
        cwd: sourceDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderr = '';
      
      rg.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (!line.trim() || results.length >= limit) continue;
          
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'match') {
              const match = parsed.data;
              results.push({
                path: match.path.text,
                line: match.line_number,
                column: match.submatches[0]?.start || 0,
                content: match.lines.text?.trim() || '',
                match: match.submatches[0]?.match?.text || ''
              });
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
        if (code === 0 || code === 1) {
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
      
      setTimeout(() => {
        rg.kill();
        resolve(results);
      }, 10000);
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
    const { limit = 50, regex = true } = options;
    const results = [];
    
    const fs = await import('fs/promises');
    const path = await import('path');
    
    // Create search pattern
    const searchRegex = regex ? new RegExp(pattern, 'i') : new RegExp(this._escapeRegex(pattern), 'i');
    
    // Extensions to search
    const extensions = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.rs', '.java', '.go', '.c', '.cpp', '.h', '.cs', '.rb', '.php', '.swift', '.kt', '.scala']);
    
    // Ignore patterns
    const ignorePatterns = [/node_modules/, /\.git/, /dist/, /build/, /target/, /\.next/, /coverage/, /\.nyc_output/];
    
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
          
          // Skip files > 100KB
          const stats = await fs.stat(fullPath).catch(() => null);
          if (!stats || stats.size > 100 * 1024) continue;
          
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            
            for (let i = 0; i < lines.length && results.length < limit; i++) {
              const line = lines[i];
              const match = line.match(searchRegex);
              if (match) {
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
