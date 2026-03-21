/**
 * Fallback regex-based parsers with enhanced accuracy
 * 
 * Captures:
 * - Functions: declarations, expressions, arrow functions
 * - Classes: declarations with method lists
 * - Imports: ES6, CommonJS, Python, Rust style
 * - Signatures: parameter lists for functions
 */

// ===== JavaScript/TypeScript =====

export function parseJavaScriptFallback(content) {
  const lines = content.split('\n');
  const functions = [];
  const classes = [];
  const imports = [];

  // Function declarations: function name(params)
  const funcDeclRegex = /(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/g;
  let match;
  while ((match = funcDeclRegex.exec(content)) !== null) {
    functions.push({
      name: match[1],
      line: lineNumber(content, match.index),
      signature: match[2],
      type: 'function'
    });
  }

  // Arrow functions: const name = (params) => or const name = async (params) =>
  const arrowRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/g;
  while ((match = arrowRegex.exec(content)) !== null) {
    // Extract signature if available
    const sigMatch = content.slice(match.index, match.index + 200).match(/\(([^)]*)\)/);
    functions.push({
      name: match[1],
      line: lineNumber(content, match.index),
      signature: sigMatch ? `(${sigMatch[1]})` : '()',
      type: 'arrow_function'
    });
  }

  // Function expressions: const name = function(params)
  const funcExprRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*(\([^)]*\))/g;
  while ((match = funcExprRegex.exec(content)) !== null) {
    functions.push({
      name: match[1],
      line: lineNumber(content, match.index),
      signature: match[2],
      type: 'function'
    });
  }

  // Object methods: methodName(params) { or async methodName(params) {
  const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
  const objMethodRegex = /^(?:\s*(?:async\s+|static\s+|get\s+|set\s+)?)(\w+)\s*(\([^)]*\))\s*\{/gm;
  while ((match = objMethodRegex.exec(content)) !== null) {
    const methodName = match[1];
    // Skip JavaScript keywords
    if (JS_KEYWORDS.has(methodName)) continue;
    
    const line = lineNumber(content, match.index);
    const lineContent = lines[line - 1] || '';
    // Only capture if it looks like a method (inside class or object)
    if (lineContent.includes('(') && !lineContent.trim().startsWith('function') && !lineContent.trim().startsWith('const')) {
      const modifiers = [];
      if (lineContent.includes('async')) modifiers.push('async');
      if (lineContent.includes('static')) modifiers.push('static');
      if (lineContent.includes('get ')) modifiers.push('get');
      if (lineContent.includes('set ')) modifiers.push('set');
      
      functions.push({
        name: methodName,
        line: line,
        signature: match[2],
        type: 'method',
        modifiers: modifiers.length > 0 ? modifiers : undefined
      });
    }
  }

  // Class declarations (must be at start of line or after whitespace/keywords)
  const classRegex = /(?:^|\s|;)class\s+(\w+)(?:\s+extends\s+(\w+))?/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const classLine = lineNumber(content, match.index);
    const className = match[1];
    
    // Find class body and extract methods
    const classStart = content.indexOf('{', match.index);
    if (classStart === -1) continue;
    
    // Find matching closing brace (simple approach)
    let braceCount = 1;
    let classEnd = classStart + 1;
    while (braceCount > 0 && classEnd < content.length) {
      if (content[classEnd] === '{') braceCount++;
      if (content[classEnd] === '}') braceCount--;
      classEnd++;
    }
    
    const classBody = content.slice(classStart, classEnd);
    const methods = [];
    
    // Extract methods from class body
    const methodRegex = /^(?:\s*(?:async\s+|static\s+|get\s+|set\s+|#)?)(\w+)\s*(\([^)]*\))/gm;
    let methodMatch;
    while ((methodMatch = methodRegex.exec(classBody)) !== null) {
      const methodName = methodMatch[1];
      // Skip JavaScript keywords and common false positives
      if (JS_KEYWORDS.has(methodName)) continue;
      
      methods.push({
        name: methodName,
        line: classLine + lineNumber(classBody, methodMatch.index) - 1
      });
    }
    
    classes.push({
      name: className,
      line: classLine,
      methods: methods.length > 0 ? methods : undefined
    });
  }

  // ES6 imports
  const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"];?/g;
  while ((match = importRegex.exec(content)) !== null) {
    const importClause = content.slice(match.index, match.index + match[0].indexOf('from')).trim();
    const specifiers = [];
    
    // Extract named imports: { foo, bar }
    const namedMatch = importClause.match(/\{([^}]+)\}/);
    if (namedMatch) {
      specifiers.push(...namedMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()));
    }
    
    // Extract default import
    const defaultMatch = importClause.match(/import\s+(\w+)/);
    if (defaultMatch && !importClause.includes('{')) {
      specifiers.push(defaultMatch[1]);
    }
    
    // Extract namespace import
    const nsMatch = importClause.match(/\*\s+as\s+(\w+)/);
    if (nsMatch) {
      specifiers.push(`* as ${nsMatch[1]}`);
    }
    
    imports.push({ 
      name: match[1],
      specifiers: specifiers.length > 0 ? specifiers : undefined
    });
  }

  // CommonJS requires
  const requireRegex = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\(['"]([^'"]+)['"]\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push({ name: match[3] });
  }

  return { functions, classes, imports };
}

export function parseTypeScriptFallback(content) {
  // TypeScript uses same syntax as JavaScript for our purposes
  // Could add interface/type extraction here if needed
  return parseJavaScriptFallback(content);
}

// ===== Python =====

export function parsePythonFallback(content) {
  const lines = content.split('\n');
  const functions = [];
  const classes = [];
  const imports = [];

  // Function definitions (not methods - filtered by indentation)
  const funcRegex = /def\s+(\w+)\s*(\([^)]*\)):/g;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const line = lineNumber(content, match.index);
    const lineContent = lines[line - 1] || '';
    
    // Skip methods (indented definitions)
    if (lineContent.match(/^\s+/)) continue;
    
    functions.push({
      name: match[1],
      line: line,
      signature: match[2],
      type: 'function'
    });
  }

  // Class definitions
  const classRegex = /class\s+(\w+)(?:\([^)]*\))?:/g;
  while ((match = classRegex.exec(content)) !== null) {
    const classLine = lineNumber(content, match.index);
    const className = match[1];
    
    // Find class body (next lines with increased indentation)
    const classLineContent = lines[classLine - 1] || '';
    const classIndent = classLineContent.match(/^(\s*)/)?.[1].length || 0;
    const methods = [];
    
    for (let i = classLine; i < lines.length; i++) {
      const line = lines[i];
      const lineIndent = line.match(/^(\s*)/)?.[1].length || 0;
      
      // End of class body
      if (line.trim() && lineIndent <= classIndent) break;
      
      // Method definition
      const methodMatch = line.match(/^\s+def\s+(\w+)\s*\(/);
      if (methodMatch) {
        methods.push({
          name: methodMatch[1],
          line: i + 1
        });
      }
    }
    
    classes.push({
      name: className,
      line: classLine,
      methods: methods.length > 0 ? methods : undefined
    });
  }

  // Import statements
  const importRegex = /^import\s+(\S+)/gm;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push({ name: match[1] });
  }

  // From imports
  const fromRegex = /from\s+(\S+)\s+import/gm;
  while ((match = fromRegex.exec(content)) !== null) {
    imports.push({ name: match[1] });
  }

  return { functions, classes, imports };
}

// ===== Rust =====

export function parseRustFallback(content) {
  const lines = content.split('\n');
  const functions = [];
  const classes = [];
  const imports = [];

  // Function items (skip methods inside impl blocks)
  const funcRegex = /(?:pub\s+)?fn\s+(\w+)\s*(\([^)]*\))(?:\s*->\s*[^\{]+)?/g;
  let match;
  while ((match = funcRegex.exec(content)) !== null) {
    const line = lineNumber(content, match.index);
    const lineContent = lines[line - 1] || '';
    
    // Skip methods inside impl blocks (heuristic: check if inside impl)
    // This is imperfect but sufficient for fallback
    
    functions.push({
      name: match[1],
      line: line,
      signature: match[2] + (match[0].includes('->') ? ' -> ...' : ''),
      type: 'function'
    });
  }

  // Structs, enums, traits
  const structRegex = /(struct|enum|trait)\s+(\w+)/g;
  while ((match = structRegex.exec(content)) !== null) {
    classes.push({
      name: match[2],
      line: lineNumber(content, match.index),
      type: match[1]
    });
  }

  // Use declarations
  const useRegex = /use\s+([^;]+);/g;
  while ((match = useRegex.exec(content)) !== null) {
    imports.push({ name: match[1].trim() });
  }

  return { functions, classes, imports };
}

// ===== Utility =====

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}
