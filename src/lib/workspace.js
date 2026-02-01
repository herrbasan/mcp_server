import fs from 'fs/promises';
import path from 'path';

/**
 * Workspace path resolver - translates local paths to UNC paths
 * Shared by Local Agent and Code Search modules
 */
export class WorkspaceResolver {
  constructor(config) {
    this.defaultMachine = config.defaultMachine || null;
    this.machines = config.machines || {};
  }

  /**
   * Resolve local path to UNC path using configured share mappings
   * @param {string} localPath - Local path (e.g., D:\Work\Project)
   * @param {string|null} machine - Machine name (null = use default)
   * @returns {string} UNC path (e.g., \\COOLKID\Work\Project)
   * @throws {Error} If no share configured for path
   */
  resolvePath(localPath, machine = null) {
    // Reject paths with .. before processing
    if (localPath.includes('..')) {
      throw new Error(`Path traversal not allowed: ${localPath}`);
    }

    const targetMachine = machine || this.defaultMachine;
    if (!targetMachine) {
      throw new Error('No machine specified and no default machine configured');
    }

    if (!this.machines[targetMachine]) {
      const available = Object.keys(this.machines).join(', ');
      throw new Error(`Unknown machine: ${targetMachine}. Available: ${available}`);
    }

    // 1. Normalize: lowercase, forward slashes, no trailing slash
    const normalized = localPath
      .toLowerCase()
      .replace(/\\/g, '/')
      .replace(/\/$/, '');

    // 2. Get shares for machine, sorted by prefix length DESCENDING (longest match first)
    const shares = Object.entries(this.machines[targetMachine])
      .map(([local, unc]) => ({
        local: local.toLowerCase().replace(/\\/g, '/').replace(/\/$/, ''),
        unc
      }))
      .sort((a, b) => b.local.length - a.local.length);

    // 3. Find longest matching prefix
    for (const share of shares) {
      if (normalized.startsWith(share.local)) {
        const remainder = normalized.slice(share.local.length);
        return share.unc + remainder.replace(/\//g, '\\');
      }
    }

    const configured = shares.map(s => s.local).join(', ');
    throw new Error(
      `No share configured for path: ${localPath} on machine: ${targetMachine}. ` +
      `Configured shares: ${configured}`
    );
  }

  /**
   * Validate resolved UNC path is within allowed shares (post-realpath check)
   * MUST be called after resolvePath to catch symlink escapes
   * @param {string} uncPath - UNC path returned by resolvePath()
   * @param {string[]} allowedShares - Array of UNC share prefixes
   * @returns {Promise<string>} Real path after symlink resolution
   * @throws {Error} If path escapes allowed shares
   */
  async validateResolvedPath(uncPath, allowedShares) {
    try {
      // 1. Resolve to real path (follows symlinks/junctions)
      const realPath = await fs.realpath(uncPath);

      // 2. Normalize for comparison
      const normalizedReal = realPath.toLowerCase().replace(/\//g, '\\');

      // 3. Check real path is still within allowed shares
      const isAllowed = allowedShares.some(share =>
        normalizedReal.startsWith(share.toLowerCase().replace(/\//g, '\\'))
      );

      if (!isAllowed) {
        throw new Error(
          `Path escapes allowed shares: ${uncPath} resolved to ${realPath}. ` +
          `Allowed shares: ${allowedShares.join(', ')}`
        );
      }

      return realPath;
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTFOUND') {
        throw new Error(`Share unreachable: ${uncPath}. Check: 1) Machine online, 2) Share exists, 3) Firewall allows SMB`);
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        throw new Error(`Share access denied: ${uncPath}. Check share permissions for MCP server machine account`);
      }
      throw err;
    }
  }

  /**
   * Get all configured machines
   * @returns {string[]} Machine names
   */
  listMachines() {
    return Object.keys(this.machines);
  }

  /**
   * Get shares for a specific machine
   * @param {string} machine - Machine name
   * @returns {Object} Share mappings { localPath: uncPath }
   */
  getShares(machine) {
    return this.machines[machine] || {};
  }

  /**
   * Get all UNC share prefixes for a machine (for validation)
   * @param {string|null} machine - Machine name (null = default)
   * @returns {string[]} UNC share prefixes
   */
  getAllowedShares(machine = null) {
    const targetMachine = machine || this.defaultMachine;
    if (!targetMachine || !this.machines[targetMachine]) {
      return [];
    }
    return Object.values(this.machines[targetMachine]);
  }

  /**
   * Generate index path for a workspace
   * Used by Code Search module
   * @param {string} localPath - Local workspace path
   * @param {string|null} machine - Machine name
   * @returns {string} Sanitized index filename (machine-share.json)
   */
  getIndexPath(localPath, machine = null) {
    const targetMachine = machine || this.defaultMachine;
    
    // Find which share this path belongs to
    const normalized = localPath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
    const shares = Object.entries(this.machines[targetMachine] || {})
      .map(([local, unc]) => ({
        local: local.toLowerCase().replace(/\\/g, '/').replace(/\/$/, ''),
        shareName: local.replace(/[:\\\/]/g, '-') // Sanitize for filename
      }))
      .sort((a, b) => b.local.length - a.local.length);

    for (const share of shares) {
      if (normalized.startsWith(share.local)) {
        return `${targetMachine}-${share.shareName}.json`;
      }
    }

    // Fallback: hash the path
    const hash = localPath.split(/[:\\\/]/).filter(Boolean).join('-');
    return `${targetMachine}-${hash}.json`;
  }
}
