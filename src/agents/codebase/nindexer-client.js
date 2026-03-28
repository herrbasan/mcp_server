/**
 * nIndexer WebSocket Client
 *
 * Connects to nIndexer service (JSON-RPC 2.0 over WebSocket) and provides
 * a clean Promise-based API matching the existing codebase agent methods.
 */

const DEFAULT_CONFIG = {
  wsUrl: 'ws://localhost:3666',
  connectTimeout: 5000,
  requestTimeout: 30000,
  reconnectInterval: 3000,
  maxReconnectAttempts: 5
};

export class NIndexerClient {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ws = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.connected = false;
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
    this.messageHandler = null;
  }

  /**
   * Connect to nIndexer WebSocket server
   */
  async connect() {
    if (this.connected || this.connecting) return;

    this.connecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.config.connectTimeout}ms`));
      }, this.config.connectTimeout);

      try {
        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          this.connected = true;
          this.connecting = false;
          this.reconnectAttempts = 0;
          console.log('[nIndexer] Connected to', this.config.wsUrl);
          resolve();
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeout);
          this.connected = false;
          this.connecting = false;

          if (this.shouldReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
            this._scheduleReconnect();
          }

          if (this.messageHandler) {
            this.messageHandler({ type: 'close', code: event.code });
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(timeout);
          this.connected = false;
          this.connecting = false;
          console.error('[nIndexer] WebSocket error:', error.message);
          reject(error);
        };

        this.ws.onmessage = (event) => {
          this._handleMessage(event.data);
        };
      } catch (err) {
        clearTimeout(timeout);
        this.connecting = false;
        reject(err);
      }
    });
  }

  /**
   * Disconnect from nIndexer
   */
  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  /**
   * Set message handler for notifications
   */
  onMessage(handler) {
    this.messageHandler = handler;
  }

  /**
   * Send JSON-RPC request and wait for response
   */
  async request(method, params = {}) {
    if (!this.connected) {
      await this.connect();
    }

    const id = String(++this.requestId);
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, this.config.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.ws.send(JSON.stringify(request));
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  _handleMessage(data) {
    try {
      const message = JSON.parse(data);

      // Handle response
      if (message.id) {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.id);

          if (message.error) {
            pending.reject(new Error(message.error.message || `RPC Error ${message.error.code}`));
          } else {
            pending.resolve(message.result);
          }
        }
      }
      // Handle notification (no id)
      else if (this.messageHandler) {
        this.messageHandler(message);
      }
    } catch (err) {
      console.error('[nIndexer] Failed to parse message:', err);
    }
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    console.log(`[nIndexer] Scheduling reconnect attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts}`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        console.warn(`[nIndexer] Reconnect failed: ${err.message}`);
      }
    }, this.config.reconnectInterval);
  }

  // ========== nIndexer Tool Wrappers ==========

  /**
   * Health check
   */
  async ping() {
    return this.request('ping');
  }

  /**
   * List all indexed codebases
   */
  async listCodebases() {
    return this.request('list_codebases');
  }

  /**
   * Index a new codebase
   * @param {string} name - Codebase name
   * @param {string} source - Absolute path to source directory
   * @param {boolean} analyze - Run LLM analysis after indexing
   */
  async indexCodebase(name, source, analyze = false) {
    return this.request('index_codebase', { name, source, analyze });
  }

  /**
   * Refresh (incrementally update) a codebase
   * @param {string} name - Codebase name
   * @param {boolean} analyze - Re-run LLM analysis if stale
   */
  async refreshCodebase(name, analyze = false) {
    return this.request('refresh_codebase', { name, analyze });
  }

  /**
   * Remove a codebase
   * @param {string} name - Codebase name
   * @param {boolean} permanent - Permanently delete vs move to trash
   */
  async removeCodebase(name, permanent = false) {
    return this.request('remove_codebase', { name, permanent });
  }

  /**
   * Hybrid search - combines semantic + keyword
   * @param {string} codebase - Codebase name
   * @param {string} query - Search query
   * @param {number} limit - Max results
   * @param {object} filter - Optional filter (e.g., { language: 'javascript' })
   */
  async search(codebase, query, limit = 10, filter = null) {
    const params = { codebase, query, strategy: 'hybrid', limit };
    if (filter) params.filter = filter;
    return this.request('search', params);
  }

  /**
   * Pure semantic search
   */
  async searchSemantic(codebase, query, limit = 10, filter = null) {
    const params = { codebase, query, limit };
    if (filter) params.filter = filter;
    return this.request('search_semantic', params);
  }

  /**
   * Keyword search
   */
  async searchKeyword(codebase, query, limit = 20, searchContent = true) {
    return this.request('search_keyword', { codebase, query, limit, searchContent });
  }

  /**
   * Grep search using ripgrep
   */
  async grepCodebase(codebase, pattern, options = {}) {
    const params = { codebase, pattern, ...options };
    return this.request('grep_codebase', params);
  }

  /**
   * Search across all codebases
   */
  async searchAll(query, strategy = 'hybrid', limit = 20, perCodebaseLimit = 5) {
    return this.request('search_all_codebases', { query, strategy, limit, perCodebaseLimit });
  }

  /**
   * Get file content with staleness check
   */
  async getFile(codebase, path) {
    return this.request('get_file', { codebase, path });
  }

  /**
   * Get file info (functions, classes, imports)
   */
  async getFileInfo(codebase, path) {
    return this.request('get_file_info', { codebase, path });
  }

  /**
   * Get file tree
   */
  async getFileTree(codebase, path = '') {
    return this.request('get_file_tree', { codebase, path });
  }

  /**
   * Check codebase staleness status
   */
  async checkCodebaseStatus(codebase) {
    return this.request('check_codebase_status', { codebase });
  }

  /**
   * Run maintenance
   * @param {string} codebase - Optional specific codebase
   * @param {string} reindex - 'if_missing', 'changed', 'always', or null
   * @param {boolean} analyze - Run LLM analysis after
   */
  async runMaintenance(codebase = null, reindex = null, analyze = false) {
    const params = {};
    if (codebase) params.codebase = codebase;
    if (reindex) params.reindex = reindex;
    if (analyze) params.analyze = analyze;
    return this.request('run_maintenance', params);
  }

  /**
   * Get maintenance statistics
   */
  async getMaintenanceStats() {
    return this.request('get_maintenance_stats');
  }

  /**
   * Analyze codebase with LLM
   */
  async analyzeCodebase(name) {
    return this.request('analyze_codebase', { name });
  }

  /**
   * Get LLM-generated description with staleness check
   */
  async getCodebaseDescription(name) {
    return this.request('get_codebase_description', { name });
  }

  /**
   * Get prioritized file list
   */
  async getPrioritizedFiles(name) {
    return this.request('get_prioritized_files', { name });
  }
}
