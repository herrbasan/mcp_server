import { readFileSync, writeFileSync } from 'fs';

// Test migration logic
const data = JSON.parse(readFileSync('d:/DEV/mcp_server/data/memories.json', 'utf-8'));

let migrated = 0;
const migrations = [];

for (const memory of data.memories) {
  if (!memory.domain && memory.text) {
    const match = memory.text.match(/^PROJECT:\s*([^—\n]+?)\s*—\s*/);
    if (match) {
      migrations.push({
        id: memory.id,
        domain: match[1].trim(),
        oldText: memory.text,
        newText: memory.text.substring(match[0].length).trim()
      });
      migrated++;
    }
  }
}

console.log(`Found ${migrated} memories to migrate:`);
migrations.slice(0, 5).forEach(m => {
  console.log(`\n[#${m.id}] Domain: "${m.domain}"`);
  console.log(`  Old: ${m.oldText.substring(0, 100)}...`);
  console.log(`  New: ${m.newText.substring(0, 100)}...`);
});

console.log(`\nTotal migrations: ${migrated}`);
