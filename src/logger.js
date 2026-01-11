export class Logger {
  constructor(maxLogs = 1000) {
    this.logs = [];
    this.maxLogs = maxLogs;
  }

  log(type, tool, request, response, error = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      tool,
      request,
      response,
      error: error ? { message: error.message, stack: error.stack } : null
    };
    
    this.logs.unshift(entry);
    if (this.logs.length > this.maxLogs) this.logs.pop();
    
    return entry;
  }

  getLogs(limit = 100, type = null) {
    let logs = this.logs;
    if (type) logs = logs.filter(l => l.type === type);
    return logs.slice(0, limit);
  }

  clear() {
    this.logs = [];
  }
}

export const globalLogger = new Logger(1000);
