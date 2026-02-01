#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import modules
import { WorkspaceResolver } from '../src/lib/workspace.js';
import { CodeSearchServer } from '../src/servers/code-search.js';
import { LocalAgentServer } from '../src/servers/local-agent.js';
import { LLMRouter } from '../src/llm/router.js';

async function main() {
  console.log('🔍 Testing SoundApp Search\n');
  console.log('='.repeat(60));

  // Load config
  const configPath = path.join(__dirname, '..', 'config.json');
  let configText = await fs.readFile(configPath, 'utf-8');
  configText = configText.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return process.env[varName] || match;
  });
  const config = JSON.parse(configText);

  // Initialize modules
  const workspace = new WorkspaceResolver(config.workspaces || {});
  const llmRouter = new LLMRouter(config.llm);
  const codeSearch = new CodeSearchServer(config.servers['code-search'], workspace, llmRouter);
  const localAgent = new LocalAgentServer(
    config.servers['local-agent'],
    workspace,
    llmRouter,
    () => {} // Mock sendProgress
  );

  console.log('\n✓ Modules initialized\n');

  // Step 1: Get workspace config
  console.log('Step 1: Discovering workspaces...');
  console.log('-'.repeat(60));
  const workspaceConfig = await codeSearch.callTool('get_workspace_config', {});
  const workspaces = JSON.parse(workspaceConfig.content[0].text);
  console.log('Available workspaces:');
  for (const [name, info] of Object.entries(workspaces.workspaces)) {
    console.log(`  ${name}: ${info.indexed ? '✓' : '✗'} indexed, ${info.fileCount || 0} files`);
  }

  // Step 2: Search for SoundApp in COOLKID-Work
  console.log('\n\nStep 2: Searching for SoundApp files...');
  console.log('-'.repeat(60));
  
  const fileResults = await codeSearch.callTool('search_files', {
    workspace: 'COOLKID-Work',
    glob: '**/SoundApp/**/*.js'
  });
  
  const files = JSON.parse(fileResults.content[0].text);
  console.log(`Found ${files.results?.length || 0} JavaScript files in SoundApp`);
  
  if (files.results && files.results.length > 0) {
    console.log('Sample files:');
    files.results.slice(0, 5).forEach(f => console.log(`  - ${f.file}`));
  }

  // Step 3: Semantic search for audio player
  console.log('\n\nStep 3: Semantic search for "audio player implementation"...');
  console.log('-'.repeat(60));
  
  const semanticResults = await codeSearch.callTool('search_semantic', {
    workspace: 'COOLKID-Work',
    query: 'audio player implementation',
    limit: 5
  });
  
  const semantic = JSON.parse(semanticResults.content[0].text);
  if (semantic.results && semantic.results.length > 0) {
    console.log(`Top ${semantic.results.length} results:`);
    semantic.results.forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.file} (${Math.round(r.similarity * 100)}% match)`);
    });

    // Step 4: Retrieve a file to understand the project
    const topFile = semantic.results[0].file;
    console.log(`\n\nStep 4: Retrieving top match: ${topFile}`);
    console.log('-'.repeat(60));
    
    const fileContent = await localAgent.callTool('retrieve_file', {
      file: topFile
    });
    
    const content = JSON.parse(fileContent.content[0].text);
    console.log(`File: ${content.path}`);
    console.log(`Lines: ${content.lines}`);
    console.log(`Size: ${content.size_bytes} bytes`);
    console.log(`\nFirst 30 lines:`);
    console.log('-'.repeat(60));
    const firstLines = content.content.split('\n').slice(0, 30).join('\n');
    console.log(firstLines);

    // Step 5: Search for specific patterns
    console.log('\n\nStep 5: Keyword search for "AudioWorklet"...');
    console.log('-'.repeat(60));
    
    const keywordResults = await codeSearch.callTool('search_keyword', {
      workspace: 'COOLKID-Work',
      pattern: 'AudioWorklet',
      limit: 5
    });
    
    const keyword = JSON.parse(keywordResults.content[0].text);
    console.log(`Found ${keyword.totalMatches || 0} matches in ${keyword.results?.length || 0} files`);
    if (keyword.results && keyword.results.length > 0) {
      keyword.results.slice(0, 3).forEach(r => {
        console.log(`\n  ${r.file}: ${r.matches.length} matches`);
        r.matches.slice(0, 2).forEach(m => {
          console.log(`    Line ${m.line}: ${m.text.trim().substring(0, 80)}`);
        });
      });
    }
  } else {
    console.log('No semantic results found. Index may not exist for COOLKID-Work.');
  }

  console.log('\n' + '='.repeat(60));
  console.log('✓ Test complete');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
