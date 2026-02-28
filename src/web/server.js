import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { globalLogger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

export class WebServer {
  constructor(config, memoryServer, llmServer, codebaseServer = null, autoIndexer = null) {
    this.config = config;
    this.memory = memoryServer;
    this.llm = llmServer;
    this.codebase = codebaseServer;
    this.autoIndexer = autoIndexer;
  }

  handleStatic(req, res) {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    let fullPath;
    
    // Serve from nui_wc2 if path starts with /nui_wc2/
    if (filePath.startsWith('/nui_wc2/')) {
      fullPath = join(__dirname, 'public', filePath);
    } else if (filePath.startsWith('/web/public/')) {
      // Serve from web/public folder
      fullPath = join(__dirname, '..', filePath);
    } else {
      // Default to web/public folder for root files
      fullPath = join(__dirname, 'public', filePath);
    }

    try {
      const content = readFileSync(fullPath);
      const ext = extname(fullPath);
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      
      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(content);
      return true;
    } catch (err) {
      return false;
    }
  }

  async handleAPI(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    
    console.log('[WEB] API request:', req.method, path);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Memory endpoints
      if (path === '/api/memory/list') {
        const category = url.searchParams.get('category');
        const domain = url.searchParams.get('domain');
        
        const memories = this.memory.getMemories({ category, domain });
        
        globalLogger.log('web-api', 'memory/list', { category, domain }, { count: memories.length });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ memories }));
        return;
      }

      if (path === '/api/memory/search' && req.method === 'POST') {
        const body = await this.readBody(req);
        const { query, limit = 10, category } = JSON.parse(body);
        
        const result = await this.memory.callTool('recall', { query, limit, category });
        globalLogger.log('web-api', 'memory/search', { query, limit, category }, result);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (path === '/api/memory/create' && req.method === 'POST') {
        const body = await this.readBody(req);
        const { text, category } = JSON.parse(body);
        
        const result = await this.memory.callTool('remember', { text, category });
        globalLogger.log('web-api', 'memory/create', { text, category }, result);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (path.startsWith('/api/memory/') && req.method === 'PUT') {
        const id = parseInt(path.split('/')[3]);
        const body = await this.readBody(req);
        const { text, category } = JSON.parse(body);
        
        const result = await this.memory.callTool('update_memory', { id, text, category });
        globalLogger.log('web-api', 'memory/update', { id, text, category }, result);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (path.startsWith('/api/memory/') && req.method === 'DELETE') {
        const id = parseInt(path.split('/')[3]);
        
        const result = await this.memory.callTool('forget', { id });
        globalLogger.log('web-api', 'memory/delete', { id }, result);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // LLM endpoints
      if (path === '/api/llm/models') {
        const result = await this.llm.callTool('list_available_models', {});
        globalLogger.log('web-api', 'llm/models', {}, result);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (path === '/api/llm/loaded') {
        const result = await this.llm.callTool('get_loaded_model', {});
        globalLogger.log('web-api', 'llm/loaded', {}, result);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      // Logs endpoint
      if (path === '/api/logs') {
        const limit = parseInt(url.searchParams.get('limit') || '100');
        const type = url.searchParams.get('type');
        
        const logs = globalLogger.getLogs(limit, type);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ logs }));
        return;
      }

      // SSE endpoint for real-time logs
      if (path === '/api/logs/stream') {
        console.error('[SSE] Client connected for log stream');
        console.error('[SSE] Current log count:', globalLogger.logs.length);
        console.error('[SSE] Active listeners:', globalLogger.listeners.size);
        
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        // Send initial logs
        const logs = globalLogger.getLogs(50);
        console.error(`[SSE] Sending ${logs.length} initial logs`);
        res.write(`data: ${JSON.stringify({ type: 'initial', logs })}\n\n`);

        // Subscribe to new logs
        const listener = (entry) => {
          console.error('[SSE] Broadcasting new log:', entry.type, entry.tool);
          try {
            res.write(`data: ${JSON.stringify({ type: 'log', log: entry })}\n\n`);
          } catch (err) {
            console.error('[SSE] Error writing to stream:', err.message);
          }
        };
        
        globalLogger.addListener(listener);
        console.error('[SSE] Listener added, total listeners:', globalLogger.listeners.size);

        // Heartbeat to keep connection alive
        const heartbeat = setInterval(() => {
          try {
            res.write(': heartbeat\n\n');
          } catch (err) {
            clearInterval(heartbeat);
          }
        }, 30000);

        // Cleanup on disconnect
        req.on('close', () => {
          console.error('[SSE] Client disconnected');
          clearInterval(heartbeat);
          globalLogger.removeListener(listener);
          console.error('[SSE] Listener removed, total listeners:', globalLogger.listeners.size);
          res.end();
        });
        
        return;
      }

      if (path === '/api/logs/clear' && req.method === 'POST') {
        globalLogger.clear();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // Codebase Indexing endpoints
      if (path === '/api/codebase/config' && req.method === 'GET') {
        const config = this.codebase ? {
          dataDir: this.codebase.config.dataDir,
          embeddingDimension: this.codebase.config.embeddingDimension,
          embeddingModel: this.codebase.config.embeddingModel,
          embeddingProvider: this.codebase.config.embeddingProvider || 'lmstudio',
          maxFileSize: this.codebase.config.maxFileSize
        } : { error: 'Codebase service not available' };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
      }

      if (path === '/api/codebase/list' && req.method === 'GET') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const codebases = await this.codebase.listCodebases();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ codebases }));
        return;
      }

      if (path === '/api/codebase/status' && req.method === 'GET') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const codebase = url.searchParams.get('codebase');
        if (!codebase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'codebase parameter required' }));
          return;
        }
        
        const status = await this.codebase.checkCodebaseStatus({ codebase });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }

      if (path === '/api/codebase/index' && req.method === 'POST') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const body = await this.readBody(req);
        const { name, source } = JSON.parse(body);
        
        if (!name || !source) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name and source required' }));
          return;
        }
        
        try {
          const result = await this.codebase.indexCodebase({ name, source }, (progress) => {
            console.log(`[Index ${name}] ${progress.message}`);
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (path === '/api/codebase/refresh' && req.method === 'POST') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const body = await this.readBody(req);
        const { name } = JSON.parse(body);
        
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name required' }));
          return;
        }
        
        try {
          const result = await this.codebase.refreshCodebase({ name }, (progress) => {
            console.log(`[Refresh ${name}] ${progress.message}`);
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (path === '/api/codebase/remove' && req.method === 'POST') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const body = await this.readBody(req);
        const { name } = JSON.parse(body);
        
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name required' }));
          return;
        }
        
        try {
          // Remove from index
          const result = await this.codebase.removeCodebase({ name });
          // Also remove from auto-index config so it doesn't get re-created
          if (this.autoIndexer) {
            await this.autoIndexer.remove(name);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (path === '/api/codebase/maintenance-stats' && req.method === 'GET') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const stats = this.codebase.getMaintenanceStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
      }

      // LLM Analysis endpoints
      if (path === '/api/codebase/description' && req.method === 'GET') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const codebase = url.searchParams.get('codebase');
        if (!codebase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'codebase parameter required' }));
          return;
        }
        
        try {
          const result = await this.codebase.getCodebaseDescription({ name: codebase });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      if (path === '/api/codebase/analyze' && req.method === 'POST') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const body = await this.readBody(req);
        const { name } = JSON.parse(body);
        
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name required' }));
          return;
        }
        
        try {
          console.log(`[WEB] Starting analysis for ${name}`);
          const result = await this.codebase.analyzeCodebase({ name }, (progress) => {
            console.log(`[Analyze ${name}] ${progress.message}`);
          });
          console.log(`[WEB] Analysis complete for ${name}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[WEB] Analysis failed for ${name}:`, err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message, stack: err.stack }));
        }
        return;
      }

      if (path === '/api/codebase/run-maintenance' && req.method === 'POST') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        try {
          const result = await this.codebase.runMaintenance({});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // File tree endpoint
      if (path === '/api/codebase/file-tree' && req.method === 'GET') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const codebase = url.searchParams.get('codebase');
        if (!codebase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'codebase parameter required' }));
          return;
        }
        
        try {
          const tree = await this.codebase.getFileTree({ codebase });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tree }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Symbols endpoint
      if (path === '/api/codebase/symbols' && req.method === 'GET') {
        if (!this.codebase) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Codebase service not available' }));
          return;
        }
        
        const codebaseName = url.searchParams.get('codebase');
        if (!codebaseName) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'codebase parameter required' }));
          return;
        }
        
        try {
          // Use the prioritized files endpoint to get files, then get symbols
          const filesResult = await this.codebase.getPrioritizedFiles({ name: codebaseName });
          const allFiles = filesResult?.prioritized?.high || [];
          // Add some medium priority files too
          if (filesResult?.prioritized?.medium) {
            allFiles.push(...filesResult.prioritized.medium.slice(0, 50));
          }
          
          const symbols = [];
          
          for (const filePath of allFiles.slice(0, 100)) { // Limit to first 100 files
            try {
              const fileInfo = await this.codebase.getFileInfo({ codebase: codebaseName, path: filePath });
              if (fileInfo.functions?.length || fileInfo.classes?.length) {
                symbols.push({
                  path: filePath,
                  functions: fileInfo.functions || [],
                  classes: fileInfo.classes || []
                });
              }
            } catch {
              // Skip files that can't be read
            }
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ symbols }));
        } catch (err) {
          console.error('[API] Symbols error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      console.error('API error:', err);
      globalLogger.log('web-api', path, { method: req.method }, null, err);
      
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  start() {
    const server = createServer(async (req, res) => {
      // API requests
      if (req.url.startsWith('/api/')) {
        await this.handleAPI(req, res);
        return;
      }

      // Static files
      if (this.handleStatic(req, res)) return;

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    server.on('error', (err) => {
      console.error('[WEB] Server error:', err);
      globalLogger.log('system', 'web-server-error', { host: this.config.host, port: this.config.port }, null, err);
    });

    server.listen(this.config.port, this.config.host, () => {
      console.error(`🌐 Web interface: http://${this.config.host}:${this.config.port}`);
    });

    return server;
  }
}
