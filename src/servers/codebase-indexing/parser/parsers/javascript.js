/**
 * JavaScript/TypeScript parser using Tree-sitter
 * 
 * Extracts accurate AST information:
 * - Functions: declarations, expressions, arrow functions, methods
 * - Classes: declarations with method lists
 * - Imports: ES6 imports with specifiers
 */

import { parseWithTreeSitter } from '../tree-sitter.js';

export function parseJavaScript(content) {
  return parseWithTreeSitter(content, 'javascript');
}

export function parseTypeScript(content) {
  return parseWithTreeSitter(content, 'typescript');
}
