/**
 * Auto-Indexing - Background indexing of configured codebases
 * 
 * Design principle: LLM should never manage indexing.
 * - Admin configures codebases in data/codebases.json
 * - Server auto-indexes on startup
 * - Maintenance keeps indexes fresh
 * - LLM only searches
 */

import fs from 'fs/promises';
import path from 'path';

export class AutoIndexer {
  constructor(service, configPath = 'data/codebases.json') {
    this.service = service;
    this.configPath = configPath;
    this.config = { codebases: {} };
  }

  /**
   * Load configured codebases from file
   */
  async loadConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      this.config = JSON.parse(data);
      console.log(`[AutoIndexer] Loaded config: ${Object.keys(this.config.codebases).length} codebases`);
      return this.config;
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[AutoIndexer] No config file, creating empty one');
        await this.saveConfig();
        return this.config;
      }
      throw err;
    }
  }

  /**
   * Save config to file
   */
  async saveConfig() {
    await fs.writeFile(
      this.configPath, 
      JSON.stringify(this.config, null, 2)
    );
  }

  /**
   * Auto-index all configured codebases that aren't indexed yet
   */
  async indexAll(onProgress) {
    const configured = Object.entries(this.config.codebases);
    if (configured.length === 0) {
      console.log('[AutoIndexer] No codebases configured');
      return [];
    }

    const results = [];
    
    for (const [name, sourcePath] of configured) {
      try {
        // Check if already indexed
        const existing = await this.service.listCodebases();
        const alreadyIndexed = existing.find(cb => cb.name === name);
        
        if (alreadyIndexed) {
          console.log(`[AutoIndexer] ${name}: Already indexed (${alreadyIndexed.files} files)`);
          results.push({ name, status: 'already_indexed', files: alreadyIndexed.files });
          continue;
        }

        // Index it
        console.log(`[AutoIndexer] ${name}: Starting indexing from ${sourcePath}`);
        const result = await this.service.indexCodebase(
          { name, source: sourcePath },
          onProgress || ((p) => console.log(`[${name}] ${p.message}`))
        );
        
        results.push({ 
          name, 
          status: 'indexed', 
          files: result.indexed,
          duration: result.duration 
        });
        
        console.log(`[AutoIndexer] ${name}: Indexed ${result.indexed} files in ${result.duration}ms`);
        
      } catch (err) {
        console.error(`[AutoIndexer] ${name}: Failed - ${err.message}`);
        results.push({ name, status: 'error', error: err.message });
      }
    }
    
    return results;
  }

  /**
   * Add a new codebase to config and optionally index it
   */
  async add(name, sourcePath, autoIndex = false) {
    this.config.codebases[name] = sourcePath;
    await this.saveConfig();
    
    if (autoIndex) {
      return this.service.indexCodebase({ name, source: sourcePath });
    }
    
    return { name, source: sourcePath, configured: true };
  }

  /**
   * Remove a codebase from config
   */
  async remove(name) {
    delete this.config.codebases[name];
    await this.saveConfig();
    
    // Also remove the index if it exists
    try {
      await this.service.removeCodebase({ name });
    } catch {
      // Ignore if not indexed
    }
    
    return { name, removed: true };
  }

  /**
   * List configured codebases
   */
  listConfigured() {
    return Object.entries(this.config.codebases).map(([name, source]) => ({
      name,
      source
    }));
  }

  /**
   * Get config path for a project
   */
  getSourcePath(name) {
    return this.config.codebases[name];
  }
}
