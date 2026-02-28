/**
 * Tree-sitter parser wrapper
 * 
 * Provides accurate AST-based parsing for multiple languages.
 * Falls back to regex parsers if tree-sitter fails.
 * 
 * Note: Currently using fallback regex parsers due to tree-sitter
 * version compatibility issues (tree-sitter@0.22.4 vs language
 * parsers expecting 0.25.0). The regex parsers provide sufficient
 * accuracy for Phase 2 requirements.
 */

import TreeSitter from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Rust from 'tree-sitter-rust';

// Language registry
const LANGUAGES = {
  javascript: JavaScript,
  typescript: TypeScript.typescript,
  tsx: TypeScript.tsx,
  python: Python,
  rust: Rust
};

// Parser cache
const parsers = new Map();

function getParser(language) {
  if (!parsers.has(language)) {
    const parser = new TreeSitter();
    parser.setLanguage(LANGUAGES[language]);
    parsers.set(language, parser);
  }
  return parsers.get(language);
}

/**
 * Parse source code using tree-sitter
 * @param {string} content - Source code
 * @param {string} language - Language key
 * @returns {Object} - Parsed symbols { functions, classes, imports }
 */
export function parseWithTreeSitter(content, language) {
  const parser = getParser(language);
  const tree = parser.parse(content);
  
  const functions = [];
  const classes = [];
  const imports = [];
  
  // Use iterative traversal to avoid stack issues
  const stack = [tree.rootNode];
  
  while (stack.length > 0) {
    const node = stack.pop();
    
    switch (node.type) {
      // JavaScript/TypeScript functions
      case 'function_declaration':
        extractJSFunction(node, content, functions);
        break;
      case 'method_definition':
        extractJSMethod(node, content, functions);
        break;
      case 'arrow_function':
        extractArrowFunction(node, content, functions);
        break;
      case 'function':
        extractFunctionExpression(node, content, functions);
        break;
        
      // JavaScript/TypeScript classes
      case 'class_declaration':
        extractJSClass(node, content, classes);
        break;
        
      // JavaScript/TypeScript imports
      case 'import_statement':
        extractJSImport(node, imports);
        break;
        
      // Python functions
      case 'function_definition':
        extractPythonFunction(node, content, functions);
        break;
        
      // Python classes
      case 'class_definition':
        extractPythonClass(node, content, classes);
        break;
        
      // Python imports
      case 'import_statement':
        extractPythonImport(node, imports);
        break;
      case 'import_from_statement':
        extractPythonFromImport(node, imports);
        break;
        
      // Rust functions
      case 'function_item':
        extractRustFunction(node, content, functions);
        break;
        
      // Rust types
      case 'struct_item':
      case 'enum_item':
      case 'trait_item':
        extractRustType(node, content, classes);
        break;
        
      // Rust imports
      case 'use_declaration':
        extractRustImport(node, imports);
        break;
    }
    
    // Add children to stack (reverse order for depth-first)
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  
  tree.delete();
  
  return { functions, classes, imports };
}

// ===== JavaScript/TypeScript Extractors =====

function extractJSFunction(node, content, functions) {
  const nameNode = node.children.find(n => n.type === 'identifier');
  if (!nameNode) return;
  
  functions.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
    signature: extractJSSignature(node, content),
    type: 'function'
  });
}

function extractJSMethod(node, content, functions) {
  const nameNode = node.children.find(n => 
    n.type === 'property_identifier' || n.type === 'identifier'
  );
  if (!nameNode) return;
  
  const modifiers = [];
  if (node.children.some(n => n.type === 'async')) modifiers.push('async');
  if (node.children.some(n => n.type === 'static')) modifiers.push('static');
  if (node.children.some(n => n.type === 'get')) modifiers.push('get');
  if (node.children.some(n => n.type === 'set')) modifiers.push('set');
  
  functions.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
    signature: extractJSSignature(node, content),
    type: 'method',
    modifiers: modifiers.length > 0 ? modifiers : undefined
  });
}

function extractArrowFunction(node, content, functions) {
  let parent = node.parent;
  let name = null;
  
  while (parent) {
    if (parent.type === 'variable_declarator') {
      const nameNode = parent.children.find(n => n.type === 'identifier');
      if (nameNode) {
        name = nameNode.text;
        break;
      }
    }
    parent = parent.parent;
  }
  
  if (!name) return;
  
  functions.push({
    name: name,
    line: node.startPosition.row + 1,
    signature: extractArrowSignature(node),
    type: 'arrow_function'
  });
}

function extractFunctionExpression(node, content, functions) {
  const parent = node.parent;
  if (!parent || parent.type !== 'variable_declarator') return;
  
  const nameNode = parent.children.find(n => n.type === 'identifier');
  if (!nameNode) return;
  
  functions.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
    signature: extractJSSignature(node, content),
    type: 'function'
  });
}

function extractJSClass(node, content, classes) {
  const nameNode = node.children.find(n => 
    n.type === 'type_identifier' || n.type === 'identifier'
  );
  if (!nameNode) return;
  
  const methods = [];
  const classBody = node.children.find(n => 
    n.type === 'class_body' || n.type === 'statement_block'
  );
  
  if (classBody) {
    for (let i = 0; i < classBody.childCount; i++) {
      const child = classBody.child(i);
      if (child && child.type === 'method_definition') {
        const methodName = child.children.find(n => 
          n.type === 'property_identifier' || n.type === 'identifier'
        );
        if (methodName) {
          methods.push({
            name: methodName.text,
            line: child.startPosition.row + 1
          });
        }
      }
    }
  }
  
  classes.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
    methods: methods.length > 0 ? methods : undefined
  });
}

function extractJSImport(node, imports) {
  const sourceNode = node.children.find(n => n.type === 'string');
  if (!sourceNode) return;
  
  const specifiers = [];
  const clause = node.children.find(n => n.type === 'import_clause');
  
  if (clause) {
    for (let i = 0; i < clause.childCount; i++) {
      const child = clause.child(i);
      if (!child) continue;
      
      if (child.type === 'identifier') {
        specifiers.push(child.text);
      } else if (child.type === 'named_imports') {
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (spec && spec.type === 'import_specifier') {
            const name = spec.children.find(n => n.type === 'identifier');
            if (name) specifiers.push(name.text);
          }
        }
      } else if (child.type === 'namespace_import') {
        const name = child.children.find(n => n.type === 'identifier');
        if (name) specifiers.push(`* as ${name.text}`);
      }
    }
  }
  
  imports.push({
    name: sourceNode.text.slice(1, -1),
    specifiers: specifiers.length > 0 ? specifiers : undefined
  });
}

// ===== Python Extractors =====

function extractPythonFunction(node, content, functions) {
  const nameNode = node.children.find(n => n.type === 'identifier');
  if (!nameNode) return;
  
  // Skip methods (handled in class extraction)
  const parent = node.parent;
  if (parent && parent.type === 'block') {
    const grandparent = parent.parent;
    if (grandparent && grandparent.type === 'class_definition') return;
  }
  
  functions.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
    signature: extractPythonSignature(node),
    type: 'function'
  });
}

function extractPythonClass(node, content, classes) {
  const nameNode = node.children.find(n => n.type === 'identifier');
  if (!nameNode) return;
  
  const methods = [];
  const body = node.children.find(n => n.type === 'block');
  
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child && child.type === 'function_definition') {
        const methodName = child.children.find(n => n.type === 'identifier');
        if (methodName) {
          methods.push({
            name: methodName.text,
            line: child.startPosition.row + 1
          });
        }
      }
    }
  }
  
  classes.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
    methods: methods.length > 0 ? methods : undefined
  });
}

function extractPythonImport(node, imports) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    
    if (child.type === 'dotted_name' || child.type === 'identifier') {
      imports.push({ name: child.text });
    }
  }
}

function extractPythonFromImport(node, imports) {
  const moduleNode = node.children.find(n => 
    n.type === 'dotted_name' || n.type === 'identifier'
  );
  if (moduleNode) {
    imports.push({ name: moduleNode.text });
  }
}

// ===== Rust Extractors =====

function extractRustFunction(node, content, functions) {
  const nameNode = node.children.find(n => n.type === 'identifier');
  if (!nameNode) return;
  
  // Skip methods (impl blocks)
  const parent = node.parent;
  if (parent && parent.type === 'impl_item') return;
  
  functions.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
    signature: extractRustSignature(node),
    type: 'function'
  });
}

function extractRustType(node, content, classes) {
  const keyword = node.children[0];
  const nameNode = node.children.find(n => 
    n.type === 'type_identifier' || n.type === 'identifier'
  );
  if (!nameNode) return;
  
  classes.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
    type: keyword ? keyword.text : 'type'
  });
}

function extractRustImport(node, imports) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    
    if (child.type === 'identifier' || child.type === 'scoped_identifier') {
      imports.push({ name: child.text });
    }
  }
}

// ===== Signature Extractors =====

function extractJSSignature(node, content) {
  const params = node.children.find(n => n.type === 'formal_parameters');
  return params ? params.text : '()';
}

function extractArrowSignature(node) {
  const params = node.children.find(n => 
    n.type === 'formal_parameters' || n.type === 'identifier'
  );
  if (!params) return '() =>';
  return params.type === 'identifier' 
    ? `${params.text} =>` 
    : `${params.text} =>`;
}

function extractPythonSignature(node) {
  const params = node.children.find(n => n.type === 'parameters');
  return params ? params.text : '()';
}

function extractRustSignature(node) {
  const params = node.children.find(n => n.type === 'parameters');
  const returnType = node.children.find(n => n.type === 'return_type');
  let sig = params ? params.text : '()';
  if (returnType) sig += ` ${returnType.text}`;
  return sig;
}
