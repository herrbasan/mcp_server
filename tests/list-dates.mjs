// Throwaway verification for the created/modified listing change (2026-10-02).
// Run: node tests/list-dates.mjs
import fs from 'fs';
import path from 'path';
import { createFileOps } from '../src/lib/fileops.js';

const root = path.resolve('data', '_test', 'list-dates');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'sub'), { recursive: true });

const OPS = createFileOps({ root });
await OPS.write('old-article.md', 'written first', { overwrite: true });
// ensure a real mtime gap so the modified-sort has something to order
await new Promise(r => setTimeout(r, 60));
await OPS.write('new-article.md', 'written second', { overwrite: true });
await OPS.write('sub/nested.md', 'nested', { overwrite: true });

const { entries } = await OPS.list('', {});
const fail = [];
for (const e of entries) {
    if (!(e.created instanceof Date) || Number.isNaN(e.created.getTime())) fail.push(`no created Date: ${e.path}`);
    if (!(e.modified instanceof Date) || Number.isNaN(e.modified.getTime())) fail.push(`no modified Date: ${e.path}`);
}

const st = await OPS.stat('old-article.md');
if (!(st.created instanceof Date)) fail.push('stat: no created');

// storage-level render: reuse the normalization + sort logic shape
const norm = entries.map(e => ({ ...e, created: new Date(e.created).toISOString(), modified: new Date(e.modified).toISOString() }));
const files = norm.filter(e => e.type === 'file').sort((a, b) => b.modified.localeCompare(a.modified));
if (files[0].name !== 'new-article.md') fail.push(`modified-sort wrong top: ${files[0].name}`);

fs.rmSync(root, { recursive: true, force: true });
if (fail.length) {
    console.error('FAIL\n' + fail.join('\n'));
    process.exit(1);
}
console.log(`OK: ${entries.length} entries carry created+modified; stat.created present; sort-by-modified correct`);
