import fs from 'fs/promises';
import path from 'path';

export class SpaceResolver {
  constructor(config) {
    this.spaces = {};
    // Normalize: support both string and array of paths per workspace
    // { "name": "\\server\share" } or { "name": ["\\server\share", "D:\\local"] }
    // Skip entries starting with underscore (like "_comment")
    for (const [name, val] of Object.entries(config || {})) {
      if (name.startsWith('_')) continue; // Skip comments/metadata
      this.spaces[name] = Array.isArray(val) ? val : [val];
    }
  }

  getSpacePath(space) {
    if (!this.spaces[space]) {
      const available = Object.keys(this.spaces).join(', ');
      throw new Error(`Unknown space: ${space}. Available: ${available}`);
    }
    // Return first path as primary
    return this.spaces[space][0];
  }
  
  getAllSpacePaths(space) {
    if (!this.spaces[space]) {
      const available = Object.keys(this.spaces).join(', ');
      throw new Error(`Unknown space: ${space}. Available: ${available}`);
    }
    return this.spaces[space];
  }

  parseFileId(fileId) {
    const colonIdx = fileId.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Invalid file identifier (missing ':'): ${fileId}`);
    }
    const space = fileId.substring(0, colonIdx);
    const relativePath = fileId.substring(colonIdx + 1);
    
    if (relativePath.includes('..')) {
      throw new Error(`Path traversal not allowed: ${fileId}`);
    }
    
    return { space, relativePath };
  }

  resolveFileId(fileId) {
    const { space, relativePath } = this.parseFileId(fileId);
    const spacePath = this.getSpacePath(space);
    return path.join(spacePath, relativePath);
  }

  createFileId(space, relativePath) {
    return `${space}:${relativePath.replace(/\\/g, '/')}`;
  }

  getSpaces() {
    // Return all paths flattened
    const result = [];
    for (const [name, paths] of Object.entries(this.spaces)) {
      for (const uncPath of paths) {
        result.push({ name, uncPath });
      }
    }
    return result;
  }

  /**
   * Find workspace by prefix matching on full absolute paths
   * Simple and reliable: checks if absolutePath starts with any configured workspace path
   * @param {string} absolutePath - The absolute path to match
   * @returns {{workspace: string, basePath: string, relativePath: string} | null}
   */
  findMatchingSpacePath(absolutePath) {
    // Normalize input for matching: lowercase, forward slashes to backslashes
    const normalizedInput = absolutePath.toLowerCase().replace(/\//g, '\\');
    
    // Sort by path length (longest first) to handle nested spaces correctly
    const sortedSpaces = [];
    for (const [name, paths] of Object.entries(this.spaces)) {
      for (const basePath of paths) {
        sortedSpaces.push({
          name,
          basePath,
          normalizedBase: basePath.toLowerCase().replace(/\//g, '\\'),
          allPaths: paths
        });
      }
    }
    sortedSpaces.sort((a, b) => b.normalizedBase.length - a.normalizedBase.length);
    
    // Find first matching space (longest match wins)
    for (const { name, basePath, normalizedBase, allPaths } of sortedSpaces) {
      if (normalizedInput.startsWith(normalizedBase)) {
        // Extract relative path from ORIGINAL input (preserve case)
        const normalizedBaseLength = normalizedBase.length;
        // Find where the base path ends in the original (case-preserved) string
        // by matching character count, accounting for possible case differences
        let originalBaseLength = 0;
        let normalizedIdx = 0;
        for (let i = 0; i < absolutePath.length && normalizedIdx < normalizedBaseLength; i++) {
          const origChar = absolutePath[i].toLowerCase();
          const normChar = normalizedInput[normalizedIdx];
          if (origChar === normChar || (origChar === '/' && normChar === '\\') || (origChar === '\\' && normChar === '/')) {
            normalizedIdx++;
            originalBaseLength = i + 1;
          }
        }
        
        let relativePath = absolutePath.substring(originalBaseLength);
        relativePath = relativePath.replace(/^[\\/]/, '').replace(/\\/g, '/');
        
        // Use UNC path (first entry) for actual file access, not the matched local path
        // This allows matching "d:\Work" but accessing via "\\COOLKID\Work\Work"
        const accessPath = allPaths[0];
        
        return {
          space: name,
          basePath: accessPath,
          relativePath
        };
      }
    }
    
    return null;
  }

  async validatePath(filePath, space) {
    const paths = this.getAllSpacePaths(space);
    
    // Determine if this looks like a local path or UNC
    const isUnc = filePath.startsWith('\\\\');
    
    try {
      const realPath = await fs.realpath(filePath);
      const normalizedReal = realPath.toLowerCase().replace(/\//g, '\\');
      
      // Check against ALL space paths
      for (const spacePath of paths) {
        const normalizedSpace = spacePath.toLowerCase().replace(/\//g, '\\');
        if (normalizedReal.startsWith(normalizedSpace)) {
          return realPath; // Valid
        }
      }
      
      throw new Error(
        `Path escapes space: ${filePath} resolved to ${realPath}. ` +
        `Space roots: ${paths.join(', ')}`
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        const pathType = isUnc ? 'UNC share' : 'File/directory';
        throw new Error(`${pathType} not found: ${filePath}. Check that the path exists and is accessible.`);
      }
      if (err.code === 'ENOTFOUND') {
        throw new Error(`Network path not found: ${filePath}. Check: 1) Machine online, 2) Share exists, 3) Firewall allows SMB`);
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        const pathType = isUnc ? 'Share' : 'File';
        throw new Error(`${pathType} access denied: ${filePath}. Check permissions.`);
      }
      throw err;
    }
  }
}
