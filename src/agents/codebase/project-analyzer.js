/**
 * Project Analyzer - LLM-powered project analysis
 * 
 * Two-phase analysis:
 * 1. File tree analysis -> key file selection
 * 2. Content analysis -> project summary
 * 
 * Uses JSON schema enforcement for reliable structured output.
 */

import fs from 'fs/promises';
import path from 'path';

// JSON Schema for Phase 1: File Tree Analysis
const FILE_TREE_ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['keyFiles', 'entryPoints', 'exclude'],
  properties: {
    keyFiles: {
      type: 'object',
      required: ['high', 'medium', 'low'],
      properties: {
        high: {
          type: 'array',
          items: { type: 'string' },
          description: 'Critical files: entry points, main modules, README, config files (max 10)'
        },
        medium: {
          type: 'array',
          items: { type: 'string' },
          description: 'Important files: core implementation, utilities (max 15)'
        },
        low: {
          type: 'array',
          items: { type: 'string' },
          description: 'Less critical: tests, docs, examples, generated files'
        }
      }
    },
    entryPoints: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files that start the application or are primary exports'
    },
    exclude: {
      type: 'array',
      items: { type: 'string' },
      description: 'Patterns to exclude from analysis (node_modules, dist, etc.)'
    }
  }
};

// JSON Schema for Phase 2: Content Analysis
const CONTENT_ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['description', 'purpose', 'architecture', 'techStack', 'keyConcepts', 'coreModules'],
  properties: {
    description: {
      type: 'string',
      description: 'One-sentence summary of what the project does (under 120 chars)',
      maxLength: 150
    },
    purpose: {
      type: 'string',
      description: 'Brief explanation of the project\'s purpose and goals (2-3 sentences, under 300 chars)',
      maxLength: 400
    },
    architecture: {
      type: 'string',
      description: 'Architecture pattern: monolithic, microservices, modular, serverless, etc.'
    },
    techStack: {
      type: 'array',
      items: { type: 'string' },
      description: 'Programming languages, frameworks, databases, key libraries'
    },
    keyConcepts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Domain-specific concepts this codebase deals with'
    },
    coreModules: {
      type: 'array',
      items: { type: 'string' },
      description: 'Main functional modules or subsystems'
    }
  }
};

// Maximum file sizes for reading
const MAX_FILE_SIZE = 50000; // 50KB - skip very large files
const MAX_CONTENT_LENGTH = 10000; // 10K chars per file for analysis

/**
 * Generate file tree string from manifest
 */
function generateFileTree(files, sourcePath) {
  const tree = [];
  const dirs = new Set();
  
  for (const filePath of files) {
    const parts = filePath.split('/');
    let currentPath = '';
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      
      if (i === parts.length - 1) {
        // File
        tree.push(`  ${'  '.repeat(i)}📄 ${part}`);
      } else if (!dirs.has(currentPath)) {
        // Directory
        dirs.add(currentPath);
        tree.push(`  ${'  '.repeat(i)}📁 ${part}/`);
      }
    }
  }
  
  return tree.join('\n');
}

/**
 * Phase 1: Analyze file tree and select key files
 */
async function analyzeFileTree(router, files, sourcePath) {
  const fileList = files.slice(0, 200); // Limit to first 200 files for context
  const fileTree = generateFileTree(fileList, sourcePath);
  
  const prompt = `Analyze this codebase file tree and identify key files.

FILE TREE:
${fileTree}

TASK: Categorize files by importance for understanding the project.

RULES:
- HIGH priority (max 10): Entry points (index.js, main.py), README files, package.json, core config, main application files
- MEDIUM priority (max 15): Core implementation files, utility modules, important components
- LOW priority: Test files, documentation, examples, generated files, build outputs
- ENTRY POINTS: Files that start/run the application
- EXCLUDE: Patterns like node_modules/, dist/, build/, .git/, *.lock

Return ONLY valid JSON matching the schema.`;

  const systemPrompt = `You are a code analysis expert. Your task is to analyze file trees and identify the most important files for understanding a project.

You MUST return valid JSON with this exact structure:
{
  "keyFiles": {
    "high": ["path/to/file1", "path/to/file2"],
    "medium": ["path/to/file3"],
    "low": ["path/to/test.js"]
  },
  "entryPoints": ["src/index.js"],
  "exclude": ["node_modules/", "dist/"]
}

Guidelines:
1. Use exact file paths from the tree
2. High priority files are essential for understanding what the project does
3. Entry points are files that execute when the app starts
4. Be selective - quality over quantity`;

  const response = await router.predict({
    prompt,
    systemPrompt,
    taskType: 'analysis',
    temperature: 0.3,
    responseFormat: FILE_TREE_ANALYSIS_SCHEMA
  });

  try {
    // Response should already be parsed JSON due to schema enforcement
    if (typeof response === 'object' && response !== null) {
      return validateFileTreeResponse(response, files);
    }

    // Fallback: try to parse if it's a string
    if (typeof response === 'string') {
      // Handle markdown fences by extracting JSON between first { and last }
      let text = response.trim();
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        text = text.substring(firstBrace, lastBrace + 1);
      }
      const parsed = JSON.parse(text);
      return validateFileTreeResponse(parsed, files);
    }

    throw new Error('Unexpected response type: ' + typeof response);
  } catch (err) {
    throw new Error(`Failed to parse file tree analysis: ${err.message}`);
  }
}

/**
 * Validate and normalize file tree response
 */
function validateFileTreeResponse(response, availableFiles) {
  const availableSet = new Set(availableFiles);
  
  // Ensure arrays exist
  const keyFiles = {
    high: (response.keyFiles?.high || []).filter(f => availableSet.has(f)),
    medium: (response.keyFiles?.medium || []).filter(f => availableSet.has(f)),
    low: (response.keyFiles?.low || []).filter(f => availableSet.has(f))
  };
  
  const entryPoints = (response.entryPoints || []).filter(f => availableSet.has(f));
  const exclude = response.exclude || ['node_modules/', 'dist/', 'build/', '.git/'];
  
  return { keyFiles, entryPoints, exclude };
}

/**
 * Phase 2: Analyze content of key files
 */
async function analyzeContent(router, files, sourcePath, fileTreeAnalysis) {
  // Read high priority files
  const { keyFiles } = fileTreeAnalysis;
  const filesToRead = [...keyFiles.high, ...keyFiles.medium.slice(0, 5)];
  
  const fileContents = [];
  
  for (const filePath of filesToRead) {
    try {
      const fullPath = path.join(sourcePath, filePath);
      const stats = await fs.stat(fullPath).catch(() => null);
      
      if (!stats || stats.size > MAX_FILE_SIZE) continue;
      
      const content = await fs.readFile(fullPath, 'utf-8');
      const truncated = content.slice(0, MAX_CONTENT_LENGTH);
      
      fileContents.push({
        path: filePath,
        content: truncated,
        truncated: content.length > MAX_CONTENT_LENGTH
      });
    } catch {
      // Skip files that can't be read
    }
  }
  
  if (fileContents.length === 0) {
    throw new Error('No readable high-priority files found');
  }
  
  // Build content prompt
  const contentSections = fileContents.map(f => `
=== ${f.path}${f.truncated ? ' (truncated)' : ''} ===
${f.content}
`).join('\n');

  const prompt = `Analyze these key project files and generate a structured summary.

FILES:
${contentSections}

TASK: Generate a comprehensive project summary.

RULES:
- description: ONE sentence, under 120 characters, clear and specific
- purpose: 2-3 sentences explaining what this project does and why
- architecture: Single word or short phrase describing the pattern
- techStack: Array of technologies (languages, frameworks, databases)
- keyConcepts: Array of domain concepts (e.g., "embeddings", "API gateway", "authentication")
- coreModules: Array of main functional areas (e.g., "user-management", "search", "billing")

Return ONLY valid JSON matching the schema.`;

  const systemPrompt = `You are a technical documentation expert. Analyze source code and create CONCISE, accurate project summaries.

You MUST return valid JSON with this exact structure:
{
  "description": "Short one-sentence summary (max 120 chars)",
  "purpose": "Brief 2-3 sentence explanation of what this project does (max 300 chars)",
  "architecture": "monolithic|microservices|modular|serverless|layered",
  "techStack": ["nodejs", "express", "postgresql"],
  "keyConcepts": ["authentication", "caching", "webhooks"],
  "coreModules": ["api", "database", "workers"]
}

CRITICAL CONSTRAINTS:
- description: ONE sentence, max 120 characters, clear and specific
- purpose: 2-3 sentences ONLY, max 300 characters total. Be brief!
- techStack: 5-10 most significant technologies only
- keyConcepts: 3-7 domain concepts (e.g., "embeddings", "API gateway")
- coreModules: 3-7 main functional areas (e.g., "user-management", "search")

Guidelines:
1. Be CONCISE - avoid unnecessary elaboration
2. Be specific and accurate based on the code shown
3. Description should be informative to someone seeing it in a list
4. Tech stack should include only significant technologies
5. Core modules should reflect the actual code organization`;

  const response = await router.predict({
    prompt,
    systemPrompt,
    taskType: 'synthesis',
    temperature: 0.3,
    maxTokens: 1024,  // Strict limit - Qwen has a habit of ignoring limits and generating 80k+ tokens
    responseFormat: CONTENT_ANALYSIS_SCHEMA
  });

  try {
    if (typeof response === 'object' && response !== null) {
      return validateContentResponse(response);
    }
    
    const clean = typeof response === 'string' ? response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim() : response;
    const parsed = JSON.parse(clean);
    return validateContentResponse(parsed);
  } catch (err) {
    throw new Error(`Failed to parse content analysis: ${err.message}`);
  }
}

/**
 * Validate and normalize content analysis response
 */
function validateContentResponse(response) {
  return {
    description: String(response.description || 'Unknown project').slice(0, 120),
    purpose: String(response.purpose || 'No description available').slice(0, 300),
    architecture: String(response.architecture || 'unknown'),
    techStack: (response.techStack || []).slice(0, 10).map(String),
    keyConcepts: (response.keyConcepts || []).slice(0, 7).map(String),
    coreModules: (response.coreModules || []).slice(0, 7).map(String)
  };
}

/**
 * Generate content hashes for staleness detection
 */
async function generateSourceHashes(files, sourcePath) {
  const { createHash } = await import('crypto');
  const hashes = {};
  
  for (const filePath of files.slice(0, 20)) { // Hash first 20 key files
    try {
      const fullPath = path.join(sourcePath, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      hashes[filePath] = createHash('md5').update(content).digest('hex').slice(0, 16);
    } catch {
      // Skip files that can't be read
    }
  }
  
  return hashes;
}

/**
 * Main analysis function
 */
export async function analyzeProject(router, metadata, sourcePath, onProgress) {
  if (!router) {
    throw new Error('Router not available - LLM service is not configured');
  }
  
  if (!router.predict) {
    throw new Error('Router does not support predict() - check LLM configuration');
  }
  
  const startTime = Date.now();
  
  // Get all indexed files
  const allFiles = (await metadata.getAllFiles()).map(f => f.path);
  
  if (allFiles.length === 0) {
    throw new Error('No files to analyze');
  }
  
  onProgress?.({ phase: 'analyzing', message: 'Phase 1/2: Analyzing file structure...' });
  
  // Phase 1: File tree analysis
  const fileTreeAnalysis = await analyzeFileTree(router, allFiles, sourcePath);
  
  onProgress?.({ phase: 'analyzing', message: 'Phase 2/2: Analyzing key file contents...' });
  
  // Phase 2: Content analysis
  const contentAnalysis = await analyzeContent(router, allFiles, sourcePath, fileTreeAnalysis);
  
  // Generate source hashes for staleness detection
  const allKeyFiles = [
    ...fileTreeAnalysis.keyFiles.high,
    ...fileTreeAnalysis.keyFiles.medium
  ];
  const sourceHashes = await generateSourceHashes(allKeyFiles, sourcePath);
  
  const duration = Date.now() - startTime;
  
  return {
    analyzedAt: new Date().toISOString(),
    model: await getModelInfo(router),
    version: '1',
    
    // File selection results
    keyFiles: fileTreeAnalysis.keyFiles,
    entryPoints: fileTreeAnalysis.entryPoints,
    
    // Content analysis results
    description: contentAnalysis.description,
    purpose: contentAnalysis.purpose,
    
    // Structured insights
    insights: {
      architecture: contentAnalysis.architecture,
      techStack: contentAnalysis.techStack,
      keyConcepts: contentAnalysis.keyConcepts,
      coreModules: contentAnalysis.coreModules
    },
    
    // Staleness detection
    sourceHashes,
    
    // Metadata
    duration,
    filesAnalyzed: allKeyFiles.length
  };
}

/**
 * Get model info from router
 */
async function getModelInfo(router) {
  try {
    const meta = router.getMetadata?.('lmstudio') || 
                 router.getMetadata?.('ollama') || 
                 router.getMetadata?.('gemini') ||
                 {};
    return meta.model || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Check if analysis is stale based on source hashes
 */
export async function isAnalysisStale(analysis, sourcePath) {
  if (!analysis?.sourceHashes) return true;
  
  const { createHash } = await import('crypto');
  
  for (const [filePath, expectedHash] of Object.entries(analysis.sourceHashes)) {
    try {
      const fullPath = path.join(sourcePath, filePath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const actualHash = createHash('md5').update(content).digest('hex').slice(0, 16);
      
      if (actualHash !== expectedHash) {
        return true; // File has changed
      }
    } catch {
      return true; // File can't be read (deleted?)
    }
  }
  
  return false;
}

/**
 * Get priority-ordered file list for search
 */
export function getPrioritizedFiles(analysis, allFiles) {
  if (!analysis?.keyFiles) {
    return { high: [], medium: [], low: allFiles };
  }
  
  const highSet = new Set(analysis.keyFiles.high || []);
  const mediumSet = new Set(analysis.keyFiles.medium || []);
  const lowSet = new Set(analysis.keyFiles.low || []);
  
  // Files not categorized go to low
  const categorized = new Set([...highSet, ...mediumSet, ...lowSet]);
  const uncategorized = allFiles.filter(f => !categorized.has(f));
  
  return {
    high: analysis.keyFiles.high,
    medium: analysis.keyFiles.medium,
    low: [...(analysis.keyFiles.low || []), ...uncategorized]
  };
}
