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
  constructor(config, memoryServer, llmServer, codeSearchServer) {
    this.config = config;
    this.memory = memoryServer;
    this.llm = llmServer;
    this.codeSearch = codeSearchServer;
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

      // Code Search endpoints
      if (path === '/api/code-search/spaces') {
        if (!this.codeSearch) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Code search not available' }));
          return;
        }
        
        const result = await this.codeSearch.callTool('get_spaces_config', {});
        const data = JSON.parse(result.content[0].text);
        globalLogger.log('web-api', 'code-search/spaces', {}, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (path === '/api/code-search/refresh-all' && req.method === 'POST') {
        const result = await this.codeSearch.callTool('refresh_all_indexes', {});
        const data = JSON.parse(result.content[0].text);
        globalLogger.log('web-api', 'code-search/refresh-all', {}, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (path === '/api/code-search/refresh' && req.method === 'POST') {
        const body = await this.readBody(req);
        const { space } = JSON.parse(body);
        
        const result = await this.codeSearch.callTool('refresh_index', { space });
        const data = JSON.parse(result.content[0].text);
        globalLogger.log('web-api', 'code-search/refresh', { space }, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (path === '/api/code-search/stats') {
        const space = url.searchParams.get('space');
        const result = await this.codeSearch.callTool('get_index_stats', { space });
        const data = JSON.parse(result.content[0].text);
        globalLogger.log('web-api', 'code-search/stats', { space }, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (path === '/api/code-search/search' && req.method === 'POST') {
        const body = await this.readBody(req);
        const { space, searchType, query } = JSON.parse(body);
        
        let result;
        if (searchType === 'semantic') {
          result = await this.codeSearch.callTool('search_semantic', { space, query });
        } else if (searchType === 'keyword') {
          result = await this.codeSearch.callTool('search_keyword', { space, pattern: query });
        } else if (searchType === 'files') {
          result = await this.codeSearch.callTool('search_files', { space, glob: query });
        } else if (searchType === 'code') {
          result = await this.codeSearch.callTool('search_code', { space, query });
        }
        
        const data = JSON.parse(result.content[0].text);
        globalLogger.log('web-api', 'code-search/search', { space, searchType, query }, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (path === '/api/code-search/file' && req.method === 'POST') {
        const body = await this.readBody(req);
        const { space, file } = JSON.parse(body);
        
        const result = await this.codeSearch.callTool('retrieve_file', { file });
        const data = JSON.parse(result.content[0].text);
        globalLogger.log('web-api', 'code-search/file', { space, file }, data);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
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
