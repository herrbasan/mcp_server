/**
 * Parser module - Tree-sitter integration with regex fallback
 * 
 * Primary: Tree-sitter for accurate AST extraction
 * Fallback: Regex parsers if tree-sitter fails
 */

import { 
  parseJavaScript as parseJavaScriptTS,
  parseTypeScript as parseTypeScriptTS,
  parsePython as parsePythonTS,
  parseRust as parseRustTS
} from './parsers/index.js';

import {
  parseJavaScriptFallback,
  parseTypeScriptFallback,
  parsePythonFallback,
  parseRustFallback
} from './fallback.js';

function withFallback(treeSitterFn, fallbackFn) {
  return (content) => {
    try {
      return treeSitterFn(content);
    } catch (err) {
      // Silently fall back to regex parser
      return fallbackFn(content);
    }
  };
}

export const parseJavaScript = withFallback(parseJavaScriptTS, parseJavaScriptFallback);
export const parseTypeScript = withFallback(parseTypeScriptTS, parseTypeScriptFallback);
export const parsePython = withFallback(parsePythonTS, parsePythonFallback);
export const parseRust = withFallback(parseRustTS, parseRustFallback);
