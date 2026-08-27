// Temporary migration verification (docs/migrate-memories-to-folder-mode.md Step 2).
// Usage: node scripts/_verify.mjs <path-to-data.jsonl>
// DELETE AFTER MIGRATION.
import { loadNdb } from '../src/agents/memory/ndb-loader.js';

const target = process.argv[2];
if (!target) throw new Error('usage: node scripts/_verify.mjs <path-to-data.jsonl>');

const { Database } = loadNdb();
const db = Database.open(target);
const it = db.iter();
const docs = [...it];
const memDocs = docs.filter(d => (d._id || '').startsWith('mem_'));
const metaDocs = docs.filter(d => (d._id || '').startsWith('_meta'));

console.log('path     :', target);
console.log('len      :', db.len());
console.log('mem_ docs:', memDocs.length);
console.log('_meta    :', metaDocs.length, metaDocs.map(m => m._id));
const deleted = db.deletedIds();
console.log('deleted  :', deleted.length, '(expect 14)');

const m = memDocs[0];
if (!m) throw new Error('no mem_ documents found');
console.log('find(id) :', db.find('id', m.id).length, '(expect 1)');
console.log('hasIndex :', db.hasIndex('id'));

if (db.len() !== 1574) throw new Error(`len mismatch: ${db.len()} != 1574`);
if (deleted.length !== 14) throw new Error(`deleted mismatch: ${deleted.length} != 14`);
console.log('\nPARITY OK');
