import fs from 'fs/promises';
import path from 'path';

/**
 * Workspace resolver - maps workspace names to UNC paths
 * Files are identified as "workspace:relativePath" (e.g., "BADKID-DEV:src/http-server.js")
 */
export class WorkspaceResolver {
  constructor(config) {
    // Config is now simple: { "workspace-name": "\\\\UNC\\Path", ... }
    this.workspaces = config || {};
  }

  /**
   * Get UNC path for a workspace
   * @param {string} workspace - Workspace name (e.g., "BADKID-DEV")
   * @returns {string} UNC path (e.g., "\\\\BADKID\\Stuff\\DEV")
   */
  getWorkspacePath(workspace) {
    if (!this.workspaces[workspace]) {
      const available = Object.keys(this.workspaces).join(', ');
      throw new Error(`Unknown workspace: ${workspace}. Available: ${available}`);
    }
    return this.workspaces[workspace];
  }

  /**
   * Parse file identifier into workspace and relative path
   * @param {string} fileId - File identifier (e.g., "BADKID-DEV:src/http-server.js")
   * @returns {{ workspace: string, relativePath: string }}
   */
  parseFileId(fileId) {
    const colonIdx = fileId.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Invalid file identifier (missing ':'): ${fileId}`);
    }
    const workspace = fileId.substring(0, colonIdx);
    const relativePath = fileId.substring(colonIdx + 1);
    
    // Security: reject path traversal
    if (relativePath.includes('..')) {
      throw new Error(`Path traversal not allowed: ${fileId}`);
    }
    
    return { workspace, relativePath };
  }

  /**
   * Resolve file identifier to UNC path
   * @param {string} fileId - File identifier (e.g., "BADKID-DEV:src/http-server.js")
   * @returns {string} Full UNC path
   */
  resolveFileId(fileId) {
    const { workspace, relativePath } = this.parseFileId(fileId);
    const workspacePath = this.getWorkspacePath(workspace);
    return path.join(workspacePath, relativePath);
  }

  /**
   * Create file identifier from workspace and relative path
   * @param {string} workspace - Workspace name
   * @param {string} relativePath - Relative path within workspace
   * @returns {string} File identifier
   */
  createFileId(workspace, relativePath) {
    return `${workspace}:${relativePath.replace(/\\/g, '/')}`;
  }

  /**
   * Get list of configured workspaces
   * @returns {Array<{name: string, uncPath: string}>}
   */
  getWorkspaces() {
    return Object.entries(this.workspaces).map(([name, uncPath]) => ({ name, uncPath }));
  }

  /**
   * Validate UNC path is accessible (check symlinks, permissions)
   * @param {string} uncPath - Full UNC path to validate
   * @param {string} workspace - Workspace name (for error messages)
   * @returns {Promise<string>} Real path after symlink resolution
   * @throws {Error} If path is inaccessible or escapes workspace
   */
  async validatePath(uncPath, workspace) {
    const workspacePath = this.getWorkspacePath(workspace);
    
    try {
      // Resolve to real path (follows symlinks/junctions)
      const realPath = await fs.realpath(uncPath);

      // Normalize for comparison
      const normalizedReal = realPath.toLowerCase().replace(/\//g, '\\');
      const normalizedWorkspace = workspacePath.toLowerCase().replace(/\//g, '\\');

      // Check real path is still within workspace
      if (!normalizedReal.startsWith(normalizedWorkspace)) {
        throw new Error(
          `Path escapes workspace: ${uncPath} resolved to ${realPath}. ` +
          `Workspace root: ${workspacePath}`
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
}
