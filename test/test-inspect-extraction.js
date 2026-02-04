import fs from 'fs/promises';

async function testExtraction() {
  const content = await fs.readFile('src/servers/local-agent.js', 'utf8');
  const functionName = 'parseToolCall';
  
  const patterns = [
    new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*{`, 'm'),
    new RegExp(`const\\s+${functionName}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>`, 'm'),
    new RegExp(`${functionName}\\s*:\\s*(?:async\\s+)?function\\s*\\([^)]*\\)\\s*{`, 'm'),
    new RegExp(`async\\s+function\\s+${functionName}\\s*\\([^)]*\\)\\s*{`, 'm')
  ];
  
  let match = null;
  for (const pattern of patterns) {
    match = pattern.exec(content);
    if (match) {
      console.log('Found match with pattern:', pattern.source);
      break;
    }
  }
  
  if (!match) {
    console.log('No match found');
    return;
  }
  
  const startIdx = match.index;
  const lines = content.substring(startIdx).split('\n');
  let endLine = lines.length;
  
  for (let i = 1; i < lines.length && i < 200; i++) {
    if (/^(export\s+)?(async\s+)?function\s+\w+/.test(lines[i]) || 
        /^(export\s+)?const\s+\w+\s*=/.test(lines[i]) ||
        /^}/.test(lines[i])) {
      endLine = i;
      break;
    }
  }
  
  const extracted = lines.slice(0, endLine).join('\n');
  console.log(`\nExtracted ${endLine} lines, ${extracted.length} chars`);
  console.log('\nFunction code:');
  console.log(extracted);
}

testExtraction().catch(console.error);
