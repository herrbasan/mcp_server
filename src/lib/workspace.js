import fs from 'fs/promises';
import path from 'path';

export class WorkspaceResolver {
  constructor(config) {
    this.workspaces = config || {};
  }

  getWorkspacePath(workspace) {
    if (!this.workspaces[workspace]) {
      const available = Object.keys(this.workspaces).join(', ');
      throw new Error(`Unknown workspace: ${workspace}. Available: ${available}`);
    }
    return this.workspaces[workspace];
  }

  parseFileId(fileId) {
    const colonIdx = fileId.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Invalid file identifier (missing ':'): ${fileId}`);
    }
    const workspace = fileId.substring(0, colonIdx);
    const relativePath = fileId.substring(colonIdx + 1);
    
    if (relativePath.includes('..')) {
      throw new Error(`Path traversal not allowed: ${fileId}`);
    }
    
    return { workspace, relativePath };
  }

  resolveFileId(fileId) {
    const { workspace, relativePath } = this.parseFileId(fileId);
    const workspacePath = this.getWorkspacePath(workspace);
    return path.join(workspacePath, relativePath);
  }

  createFileId(workspace, relativePath) {
    return `${workspace}:${relativePath.replace(/\\/g, '/')}`;
  }

  getWorkspaces() {
    return Object.entries(this.workspaces).map(([name, uncPath]) => ({ name, uncPath }));
  }

  async validatePath(uncPath, workspace) {
    const workspacePath = this.getWorkspacePath(workspace);
    
    try {
      const realPath = await fs.realpath(uncPath);
      const normalizedReal = realPath.toLowerCase().replace(/\//g, '\\');
      const normalizedWorkspace = workspacePath.toLowerCase().replace(/\//g, '\\');

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
