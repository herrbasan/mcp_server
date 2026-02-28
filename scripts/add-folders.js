#!/usr/bin/env node
/**
 * Add all subfolders of a path to codebases.json
 * 
 * Usage: node add-folders.js <path> [prefix]
 * 
 * Examples:
 *   node add-folders.js D:\\DEV\\projects
 *   node add-folders.js "D:\\My Projects" work-
 *   node add-folders.js \\\\server\\share
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODEBASES_PATH = path.join(__dirname, '..', 'data', 'codebases.json');

async function loadCodebases() {
  try {
    const data = await fs.readFile(CODEBASES_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { codebases: {} };
  }
}

async function saveCodebases(config) {
  await fs.writeFile(CODEBASES_PATH, JSON.stringify(config, null, 2));
}

// Parse args - handle paths with spaces (last arg is prefix if it doesn't exist as path)
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Add all subfolders to codebases.json');
  console.log('');
  console.log('Usage: node add-folders.js <path> [prefix]');
  console.log('');
  console.log('Examples:');
  console.log('  node add-folders.js D:\\DEV\\projects');
  console.log('  node add-folders.js "D:\\My Projects" work-');
  console.log('  node add-folders.js \\\\server\\share');
  process.exit(1);
}

// Try to find the path boundary (last arg that doesn't exist as path = prefix)
let targetPath = args[0];
let prefix = '';

for (let i = args.length - 1; i > 0; i--) {
  const testPath = args.slice(0, i).join(' ');
  const testPrefix = args.slice(i).join(' ');
  try {
    await fs.access(path.resolve(testPath));
    targetPath = testPath;
    prefix = testPrefix;
    break;
  } catch {
    continue;
  }
}

// If no boundary found, check if all args together form a valid path
try {
  await fs.access(path.resolve(args.join(' ')));
  targetPath = args.join(' ');
  prefix = '';
} catch {
  // Keep initial guess
}

const resolvedPath = path.resolve(targetPath);

try {
  await fs.access(resolvedPath);
} catch {
  console.error(`Path not found: ${targetPath}`);
  process.exit(1);
}

// Get subfolders
const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'));

if (folders.length === 0) {
  console.log('No folders found');
  process.exit(0);
}

// Load and update codebases
const codebases = await loadCodebases();
const added = [];
const skipped = [];

for (const folder of folders) {
  const name = prefix + folder.name;
  const fullPath = path.join(resolvedPath, folder.name);
  
  if (codebases.codebases[name]) {
    skipped.push(name);
  } else {
    codebases.codebases[name] = fullPath;
    added.push(name);
  }
}

await saveCodebases(codebases);

// Report
if (added.length > 0) {
  console.log(`Added ${added.length} codebases:`);
  for (const name of added) {
    console.log(`  + ${name} -> ${codebases.codebases[name]}`);
  }
}

if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} (already exist):`);
  for (const name of skipped) {
    console.log(`  = ${name}`);
  }
}

console.log(`\nTotal: ${added.length} new, ${skipped.length} existing`);
