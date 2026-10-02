// Regression tests for issues #54/#55 (CRLF verify false-negative) and #46
// (frontmatter marker guard). Run: node tests/storage-replace-verify.mjs
import fs from 'fs';
import path from 'path';
import { createFileOps } from '../src/lib/fileops.js';

const root = path.resolve('data', '_test', 'storage-replace-verify');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const OPS = createFileOps({ root });
let failures = 0;
const check = (name, cond) => {
    if (cond) console.log(`ok   ${name}`);
    else { failures++; console.error(`FAIL ${name}`); }
};

// ---------- #54/#55: CRLF replace verify ----------
const crlfDoc = Array.from({ length: 100 }, (_, i) => `line ${i}: filler text`).join('\r\n') + '\r\n' +
    '## Section\n\r\nold text here\r\n';
fs.writeFileSync(path.join(root, 'crlf.md'), crlfDoc, 'utf8');

let r1;
try {
    r1 = await OPS.replace('crlf.md', 'old text here', 'new text here', {});
    check('#54 replace on CRLF file does not throw (was: size-mismatch false positive)', true);
} catch (e) {
    check('#54 replace on CRLF file does not throw (was: size-mismatch false positive)', false);
    console.error('  ' + e.message);
}
const disk1 = fs.statSync(path.join(root, 'crlf.md')).size;
check('#54 reported size equals on-disk size', r1?.size === disk1);
const content1 = fs.readFileSync(path.join(root, 'crlf.md'), 'utf8');
check('#54 edit landed', content1.includes('new text here') && !content1.includes('old text here'));
// Pure CRLF = every LF preceded by CR (lookbehind). NOTE: '\n\r' as a plain
// substring is NOT a violation — '\r\n\r\n' (blank line) contains it.
check('#54 CRLF convention preserved', content1.includes('\r\n') && (content1.match(/(?<!\r)\n/g) || []).length === 0);

// #55 repro: SECOND replace on the same path must also pass (was: bricked after first)
let r2;
try {
    r2 = await OPS.replace('crlf.md', 'line 50: filler text', 'line 50: EDITED', {});
    check('#55 second replace on same CRLF path passes', true);
} catch (e) {
    check('#55 second replace on same CRLF path passes', false);
    console.error('  ' + e.message);
}
check('#55 reported size equals on-disk size after second edit', r2?.size === fs.statSync(path.join(root, 'crlf.md')).size);

// LF file sanity: replace still works and sizes stay exact
await OPS.write('lf.md', 'alpha\nbeta\ngamma\n', { overwrite: true });
const rlf = await OPS.replace('lf.md', 'beta', 'BETA', {});
check('LF file replace size exact', rlf.size === fs.statSync(path.join(root, 'lf.md')).size);

// ---------- #46: frontmatter marker guard ----------
const w1 = await OPS.write('guarded.md', '[2026-09-25@22:39] ---\ntitle: Test\n---\n\nbody\n', { overwrite: true });
const g1 = fs.readFileSync(path.join(root, 'guarded.md'), 'utf8');
check('#46 write: timestamp marker stripped before frontmatter', g1.startsWith('---\ntitle:'));
check('#46 write: strippedMarkers reported', w1.strippedMarkers.length === 1 && w1.strippedMarkers[0] === '[2026-09-25@22:39]');

// Own-line marker variant
await OPS.write('guarded2.md', '[2026-09-25@22:39]\n---\ntitle: T\n---\nbody\n', { overwrite: true });
check('#46 write: own-line marker stripped', fs.readFileSync(path.join(root, 'guarded2.md'), 'utf8').startsWith('---\n'));

// Chunk-label marker variant
await OPS.write('guarded3.md', '[chunk_abc123] ---\ntitle: T\n---\nbody\n', { overwrite: true });
check('#46 write: chunk-label marker stripped', fs.readFileSync(path.join(root, 'guarded3.md'), 'utf8').startsWith('---\n'));

// Journal opening line WITHOUT frontmatter is content — never touched
await OPS.write('journal.md', '[2026-09-25@22:39] Today I noticed something.\n', { overwrite: true });
check('#46 journal opening line (no frontmatter) preserved',
    fs.readFileSync(path.join(root, 'journal.md'), 'utf8').startsWith('[2026-09-25@22:39]'));

// Non-marker bracketed text before frontmatter is content — never touched
await OPS.write('bracket.md', '[WIP] ---\ntitle: T\n---\nbody\n', { overwrite: true });
check('#46 non-marker bracketed text preserved',
    fs.readFileSync(path.join(root, 'bracket.md'), 'utf8').startsWith('[WIP] ---'));

// Append creating a fresh file: guard applies
const a1 = await OPS.append('append-fresh.md', '[2026-10-02@10:00] ---\ntitle: T\n---\nbody\n');
check('#46 append fresh file: marker stripped', fs.readFileSync(path.join(root, 'append-fresh.md'), 'utf8').startsWith('---\n'));
check('#46 append fresh file: strippedMarkers reported', a1.strippedMarkers.length === 1);

// Append to an EXISTING journal: a marker line is a legitimate stamp — untouched
await OPS.write('journal2.md', 'journal line one\n', { overwrite: true });
const a2 = await OPS.append('journal2.md', '[2026-10-02@10:00] stamped entry\n');
const j2 = fs.readFileSync(path.join(root, 'journal2.md'), 'utf8');
check('#46 append to existing file: marker line preserved', j2.includes('[2026-10-02@10:00] stamped entry'));
check('#46 append to existing file: nothing stripped', a2.strippedMarkers.length === 0);

// Replace result carrying a marker before frontmatter: guard applies
await OPS.write('repl.md', '# Header\n\nintro text\n', { overwrite: true });
const rp = await OPS.replace('repl.md', '# Header', '[2026-10-02@09:15] ---\ntitle: T\n---\n\n# Header', {});
check('#46 replace result: marker stripped', fs.readFileSync(path.join(root, 'repl.md'), 'utf8').startsWith('---\n'));
check('#46 replace result: strippedMarkers reported', rp.strippedMarkers.length === 1);

// CRLF file + guard combined: marker stripped on CRLF round-trip, verify exact
fs.writeFileSync(path.join(root, 'crlf-guard.md'), '[2026-10-02@08:00] ---\r\ntitle: T\r\n---\r\n\r\nbody\r\n', 'utf8');
const rg = await OPS.replace('crlf-guard.md', 'body', 'body text', {});
const cg = fs.readFileSync(path.join(root, 'crlf-guard.md'), 'utf8');
check('#46+#54 CRLF: marker stripped and frontmatter opens line 1', cg.startsWith('---\r\ntitle:'));
check('#46+#54 CRLF: size exact after strip+edit', rg.size === fs.statSync(path.join(root, 'crlf-guard.md')).size);

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nall checks passed');
