/**
 * Python parser using Tree-sitter
 * 
 * Extracts accurate AST information:
 * - Functions: definitions with signatures
 * - Classes: definitions with method lists
 * - Imports: import and from/import statements
 */

import { parseWithTreeSitter } from '../tree-sitter.js';

export function parsePython(content) {
  return parseWithTreeSitter(content, 'python');
}
