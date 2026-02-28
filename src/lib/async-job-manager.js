/**
 * Async Job Manager for long-running MCP operations
 * Allows tools to return immediately with a job ID while processing continues in background
 */

export class AsyncJobManager {
  constructor(options = {}) {
    this.jobs = new Map();
    this.ttlMs = options.ttlMs || 300000; // 5 minutes default TTL
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60000; // Cleanup every minute
    this.onJobComplete = options.onJobComplete || null;
    
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
  }
  
  /**
   * Create a new async job
   * @param {string} type - Job type (e.g., 'research')
   * @param {Function} executor - Async function that performs the work
   * @param {Object} metadata - Additional job metadata
   * @returns {string} jobId
   */
  createJob(type, executor, metadata = {}) {
    const jobId = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const job = {
      id: jobId,
      type,
      status: 'pending',
      progress: 0,
      message: 'Starting...',
      result: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata
    };
    
    this.jobs.set(jobId, job);
    
    // Execute job asynchronously
    this.executeJob(jobId, executor);
    
    return jobId;
  }
  
  async executeJob(jobId, executor) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    
    job.status = 'running';
    job.message = 'Processing...';
    job.updatedAt = Date.now();
    
    // Progress callback
    const onProgress = (progress, total, message) => {
      console.error(`[AsyncJobManager] Job ${jobId} progress: ${progress}/${total} - ${message}`);
      job.progress = Math.min(progress, total);
      job.message = message || `Progress: ${progress}/${total} (poll again in ~15 seconds)`;
      job.updatedAt = Date.now();
    };
    
    try {
      const result = await executor(onProgress);
      job.result = result;
      job.status = 'completed';
      job.progress = 100;
      job.message = 'Completed';
      job.completedAt = Date.now();
      
      if (this.onJobComplete) {
        this.onJobComplete(jobId, job);
      }
    } catch (err) {
      job.error = err.message;
      job.status = 'failed';
      job.message = `Failed: ${err.message}`;
      job.failedAt = Date.now();
    } finally {
      job.updatedAt = Date.now();
    }
  }
  
  /**
   * Get job status
   * @param {string} jobId
   * @returns {Object|null} job status or null if not found
   */
  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    
    // Return a copy without internal fields
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      message: job.message,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      failedAt: job.failedAt,
      metadata: job.metadata
    };
  }
  
  /**
   * Clean up old completed/failed jobs
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [jobId, job] of this.jobs.entries()) {
      const age = now - job.updatedAt;
      
      // Remove completed/failed jobs after TTL
      if ((job.status === 'completed' || job.status === 'failed') && age > this.ttlMs) {
        this.jobs.delete(jobId);
        cleaned++;
      }
      
      // Fail jobs that have been running too long (2x TTL)
      if (job.status === 'running' && age > this.ttlMs * 2) {
        job.status = 'failed';
        job.error = 'Job timed out';
        job.message = 'Timed out after ' + Math.round(age / 1000) + 's';
        job.failedAt = now;
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      console.error(`[AsyncJobManager] Cleaned up ${cleaned} old jobs, ${this.jobs.size} remaining`);
    }
  }
  
  /**
   * Stop the cleanup interval
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
  
  /**
   * Get stats about current jobs
   */
  getStats() {
    const stats = { pending: 0, running: 0, completed: 0, failed: 0, total: this.jobs.size };
    for (const job of this.jobs.values()) {
      stats[job.status]++;
    }
    return stats;
  }
}

// Singleton instance for the application
let globalJobManager = null;

export function getGlobalJobManager() {
  if (!globalJobManager) {
    globalJobManager = new AsyncJobManager();
  }
  return globalJobManager;
}

export function resetGlobalJobManager() {
  if (globalJobManager) {
    globalJobManager.stop();
  }
  globalJobManager = null;
}
