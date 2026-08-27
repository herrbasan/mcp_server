// repair-dream-map.mjs — one-time repair: prune dangling node.connections refs
// from data/dream_map.json. Mirrors pruneConnections() in src/agents/dreaming/index.js
// (pipeline version applies on every save once the server restarts with new code).
// Backup: data/_backup/dream_map-pre-repair-<ts>.json
// Atomic write: temp file + rename in the same directory.
// Usage: node scripts/repair-dream-map.mjs
// Verify afterwards: node scripts/validate-dream-map.mjs

import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = join(root, 'data', 'dream_map.json');
const BACKUP_DIR = join(root, 'data', '_backup');

const raw = readFileSync(MAP_PATH, 'utf8');
const map = JSON.parse(raw); // throws loud on corrupt JSON

const ids = new Set(map.nodes.map(n => n.id));
let pruned = 0;
let touchedNodes = 0;
for (const n of map.nodes) {
    if (!Array.isArray(n.connections)) continue;
    const before = n.connections.length;
    n.connections = n.connections.filter(c => ids.has(c));
    const removed = before - n.connections.length;
    if (removed > 0) { pruned += removed; touchedNodes++; }
}

console.log(`nodes: ${map.nodes.length}, dangling refs pruned: ${pruned} (across ${touchedNodes} nodes)`);

if (pruned === 0) {
    console.log('nothing to repair');
    process.exit(0);
}

// Backup current file before touching it
mkdirSync(BACKUP_DIR, { recursive: true });
const backupPath = join(BACKUP_DIR, `dream_map-pre-repair-${Date.now()}.json`);
copyFileSync(MAP_PATH, backupPath);
console.log(`backup: ${backupPath}`);

// Atomic replace: write temp in same dir, then rename over target
const tmpPath = MAP_PATH + '.repair-tmp';
writeFileSync(tmpPath, JSON.stringify(map, null, 2), 'utf8');
renameSync(tmpPath, MAP_PATH);
console.log('repair written (atomic rename)');
