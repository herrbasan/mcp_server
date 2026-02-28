/**
 * Rust parser using Tree-sitter
 * 
 * Extracts accurate AST information:
 * - Functions: fn items with signatures
 * - Types: structs, enums, traits
 * - Imports: use declarations
 */

import { parseWithTreeSitter } from '../tree-sitter.js';

export function parseRust(content) {
  return parseWithTreeSitter(content, 'rust');
}
