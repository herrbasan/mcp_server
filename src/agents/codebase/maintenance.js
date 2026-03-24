/**
 * Codebase Maintenance - Automatic index refresh and staleness detection
 * 
 * Features:
 * - Periodic refresh of indexed codebases
 * - Staleness detection (file mtime changes)
 * - Incremental updates (only changed files)
 * - Configurable intervals per codebase
 */

import fs from 'fs/promises';
import path from 'path';

export class CodebaseMaintenance {
  constructor(service, config = {}) {
    this.service = service;
    this.config = {
      enabled: true,
      intervalMs: 900000, // 15 minutes default
      autoRefresh: true,
      staleThresholdMs: 300000, // 5 minutes - consider index stale if file changed this recently
      ...config
    };
    this.intervalId = null;
    this.isRunning = false;
    this.lastRun = null;
    this.stats = {
      totalRefreshes: 0,
      filesUpdated: 0,
      errors: 0
    };
  }

  /**
   * Start automatic maintenance cycle
   */
  start() {
    if (!this.config.enabled || this.intervalId) return;
    
    this.intervalId = setInterval(
      () => this.runMaintenance(),
      this.config.intervalMs
    );
    
    console.log(`[CodebaseMaintenance] Started (interval: ${this.config.intervalMs / 60000}min)`);
  }

  /**
   * Stop maintenance cycle
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[CodebaseMaintenance] Stopped');
    }
  }

  /**
   * Run maintenance cycle - refresh all codebases
   */
  async runMaintenance() {
    if (this.isRunning) {
      console.log('[CodebaseMaintenance] Skipping - previous run still active');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      const codebases = await this.service.listCodebases();
      console.log(`[CodebaseMaintenance] Checking ${codebases.length} codebases...`);

      for (const cb of codebases) {
        if (cb.status === 'indexing') {
          console.log(`[CodebaseMaintenance] Skipping ${cb.name} - currently indexing`);
          continue;
        }

        try {
          const result = await this.checkAndRefresh(cb.name);
          if (result.refreshed) {
            console.log(`[CodebaseMaintenance] Refreshed ${cb.name}: ${result.filesUpdated} files updated`);
          }
        } catch (err) {
          console.error(`[CodebaseMaintenance] Failed to refresh ${cb.name}:`, err.message);
          this.stats.errors++;
        }
      }

      this.stats.totalRefreshes++;
      this.lastRun = new Date().toISOString();
      
      const duration = Date.now() - startTime;
      console.log(`[CodebaseMaintenance] Complete in ${duration}ms`);
      
    } catch (err) {
      console.error('[CodebaseMaintenance] Failed:', err.message);
      this.stats.errors++;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Check if codebase needs refresh and update if needed
   */
  async checkAndRefresh(codebaseName) {
    const codebase = await this.service._getCodebase(codebaseName);
    const metadata = await this.service._loadCodebaseMetadata(codebaseName);
    
    if (!metadata) {
      return { refreshed: false, reason: 'no_metadata' };
    }

    // Scan current files
    const currentFiles = new Map();
    await this._scanDirectory(metadata.source, metadata.source, currentFiles);

    // Get indexed files
    const indexedFiles = await codebase.metadata.getAllFiles();
    const indexedMap = new Map(indexedFiles.map(f => [f.path, f]));

    // Find changes
    const toUpdate = [];
    const toDelete = [];
    const toAdd = [];

    // Check for new and modified files
    for (const [path, fileInfo] of currentFiles) {
      const indexed = indexedMap.get(path);
      if (!indexed) {
        toAdd.push(fileInfo);
      } else if (fileInfo.mtime > indexed.mtime) {
        toUpdate.push(fileInfo);
      }
    }

    // Check for deleted files
    for (const [path] of indexedMap) {
      if (!currentFiles.has(path)) {
        toDelete.push(path);
      }
    }

    const totalChanges = toAdd.length + toUpdate.length + toDelete.length;
    
    if (totalChanges === 0) {
      return { refreshed: false, reason: 'up_to_date' };
    }

    if (!this.config.autoRefresh) {
      return { 
        refreshed: false, 
        reason: 'auto_refresh_disabled',
        pendingChanges: { added: toAdd.length, updated: toUpdate.length, deleted: toDelete.length }
      };
    }

    // Run incremental refresh
    console.log(`[CodebaseMaintenance] ${codebaseName}: ${toAdd.length} added, ${toUpdate.length} updated, ${toDelete.length} deleted`);
    
    await this.service.refreshCodebase({ name: codebaseName, analyze: true }, (progress) => {
      // Silent progress - only log errors
      if (progress.phase === 'error') {
        console.error(`[CodebaseMaintenance] ${codebaseName}: ${progress.message}`);
      }
    });

    this.stats.filesUpdated += totalChanges;

    return {
      refreshed: true,
      filesUpdated: totalChanges,
      added: toAdd.length,
      updated: toUpdate.length,
      deleted: toDelete.length
    };
  }

  /**
   * Check if a specific file is stale (changed since indexing)
   */
  async isFileStale(codebaseName, filePath) {
    const codebase = await this.service._getCodebase(codebaseName);
    const fileInfo = await codebase.metadata.getFile(filePath);
    
    if (!fileInfo) {
      return { stale: true, reason: 'not_indexed' };
    }

    const metadata = await this.service._loadCodebaseMetadata(codebaseName);
    const fullPath = path.join(metadata.source, filePath);

    try {
      const stats = await fs.stat(fullPath);
      const isStale = stats.mtimeMs > fileInfo.mtime;
      
      return {
        stale: isStale,
        lastIndexed: fileInfo.lastIndexed,
        fileMtime: new Date(stats.mtimeMs).toISOString(),
        indexMtime: new Date(fileInfo.mtime).toISOString()
      };
    } catch {
      return { stale: true, reason: 'file_not_found' };
    }
  }

  /**
   * Get staleness report for entire codebase
   */
  async getStalenessReport(codebaseName) {
    const codebase = await this.service._getCodebase(codebaseName);
    const metadata = await this.service._loadCodebaseMetadata(codebaseName);
    const indexedFiles = await codebase.metadata.getAllFiles();
    
    const staleFiles = [];
    const missingFiles = [];
    
    for (const file of indexedFiles) {
      const fullPath = path.join(metadata.source, file.path);
      
      try {
        const stats = await fs.stat(fullPath);
        if (stats.mtimeMs > file.mtime) {
          staleFiles.push({
            path: file.path,
            lastIndexed: new Date(file.mtime).toISOString(),
            lastModified: new Date(stats.mtimeMs).toISOString()
          });
        }
      } catch {
        missingFiles.push(file.path);
      }
    }

    return {
      codebase: codebaseName,
      totalFiles: indexedFiles.length,
      staleFiles: staleFiles.length,
      missingFiles: missingFiles.length,
      lastIndexed: metadata?.lastIndexed,
      status: staleFiles.length > 0 || missingFiles.length > 0 ? 'stale' : 'current',
      details: { staleFiles, missingFiles }
    };
  }

  /**
   * Scan directory for current files
   * Only tracks code files that would be indexed (same as indexer)
   */
  async _scanDirectory(basePath, currentPath, files) {
    // Extensions that the indexer processes
    const CODE_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.rs', '.java', '.go', '.c', '.cpp', '.h', '.cs', '.rb', '.php']);
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(basePath, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (!this._shouldIgnore(relativePath, true)) {
          await this._scanDirectory(basePath, fullPath, files);
        }
      } else if (entry.isFile()) {
        if (!this._shouldIgnore(relativePath, false)) {
          // Only track code files (same logic as indexer)
          const ext = path.extname(entry.name).toLowerCase();
          if (!CODE_EXTENSIONS.has(ext)) continue;
          
          const stats = await fs.stat(fullPath).catch(() => null);
          const maxSize = this.service.config?.maxFileSize || 1024 * 1024;
          if (stats && stats.size <= maxSize) {
            files.set(relativePath, {
              path: relativePath,
              mtime: stats.mtimeMs,
              size: stats.size
            });
          }
        }
      }
    }
  }

  _shouldIgnore(relativePath, isDirectory) {
    // Use service config ignore patterns, with defaults
    const patterns = this.service.config?.ignorePatterns || [
      'node_modules/**', '.git/**', '.vscode/**', 'dist/**', 'build/**',
      '.next/**', 'target/**', '*.log', '*.lock', '*.map', '**/*.min.js', '**/*.d.ts'
    ];
    for (const pattern of patterns) {
      if (this._matchGlob(relativePath, pattern)) return true;
    }
    return false;
  }

  _matchGlob(path, pattern) {
    let regex = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');
    return new RegExp(`^${regex}$`).test(path);
  }

  /**
   * Get maintenance statistics
   */
  getStats() {
    return {
      ...this.stats,
      lastRun: this.lastRun,
      isRunning: this.isRunning,
      enabled: this.config.enabled,
      intervalMinutes: this.config.intervalMs / 60000
    };
  }
}
