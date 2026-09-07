// Runtime tests for snapshot-before-mutate (issue #26) and atomicWrite temp
// cleanup (issue #28). Engine-level only: instantiates createFileOps on a
// throwaway temp root — never touches the live storage box.
// Run: node tests/fileops-snapshot.test.js

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createFileOps } from '../src/lib/fileops.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-snap-'));
const ops = createFileOps({ root });
let passed = 0;
let failed = 0;

function test(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => { passed++; console.log(`  ok  ${name}`); })
        .catch((e) => { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); });
}

// ---------- #26: snapshots ----------

await test('write to new file → previousVersion null, no backup', async () => {
    const r = await ops.write('a/b/file.md', 'V1\n', { overwrite: true });
    assert.strictEqual(r.previousVersion, null);
    assert.strictEqual(fs.existsSync(path.join(root, '.backups')), false);
});

await test('overwrite write → previousVersion points at backup holding V1', async () => {
    const r = await ops.write('a/b/file.md', 'V2\n', { overwrite: true });
    assert.ok(r.previousVersion, 'previousVersion missing');
    assert.ok(r.previousVersion.startsWith('.backups/a/b/file.md.'), `unexpected path: ${r.previousVersion}`);
    assert.match(r.previousVersion, /\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{2})?$/);
    const backup = fs.readFileSync(path.join(root, r.previousVersion), 'utf8');
    assert.strictEqual(backup, 'V1\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'a/b/file.md'), 'utf8'), 'V2\n');
});

await test('replace → previousVersion holds pre-replace content', async () => {
    await ops.write('rep.md', 'AAA\nBBB\n', { overwrite: true });
    const r = await ops.replace('rep.md', 'AAA', 'CCC');
    assert.strictEqual(r.replacements, 1);
    assert.ok(r.previousVersion?.startsWith('.backups/rep.md.'));
    assert.strictEqual(fs.readFileSync(path.join(root, r.previousVersion), 'utf8'), 'AAA\nBBB\n');
});

await test('remove file → previousVersion holds final content', async () => {
    await ops.write('gone.md', 'BYE\n', { overwrite: true });
    const r = await ops.remove('gone.md');
    assert.strictEqual(r.deleted, true);
    assert.ok(r.previousVersion?.startsWith('.backups/gone.md.'));
    assert.strictEqual(fs.readFileSync(path.join(root, r.previousVersion), 'utf8'), 'BYE\n');
    assert.strictEqual(fs.existsSync(path.join(root, 'gone.md')), false);
});

await test('copy overwrite → previousVersion holds target prior content', async () => {
    await ops.write('src.md', 'SRC\n', { overwrite: true });
    await ops.write('dst.md', 'OLD-DST\n', { overwrite: true });
    const r = await ops.copy('src.md', 'dst.md', { overwrite: true });
    assert.strictEqual(r.size, 4);
    assert.ok(r.previousVersion?.startsWith('.backups/dst.md.'));
    assert.strictEqual(fs.readFileSync(path.join(root, r.previousVersion), 'utf8'), 'OLD-DST\n');
});

await test('copy to new target → previousVersion null', async () => {
    const r = await ops.copy('src.md', 'dst2.md');
    assert.strictEqual(r.previousVersion, null);
});

await test('remove directory → previousVersion null (dirs not snapshotted)', async () => {
    await ops.write('dirx/inner.md', 'X\n', { overwrite: true });
    const r = await ops.remove('dirx', { recursive: true });
    assert.strictEqual(r.previousVersion, null);
});

await test('retention: 12 overwrites → exactly 10 backups, newest kept', async () => {
    for (let i = 1; i <= 12; i++) {
        await ops.write('rot.md', `V${i}\n`, { overwrite: true });
    }
    const dir = path.join(root, '.backups');
    const snaps = fs.readdirSync(dir).filter(n => n.startsWith('rot.md.'));
    assert.strictEqual(snaps.length, 10, `expected 10 backups, got ${snaps.length}`);
    snaps.sort();
    // 12 same-second writes → counter-suffixed backups. The FIRST write has
    // no prior content (no snapshot), so 11 snapshots hold V1..V11; pruning
    // to 10 drops exactly V1. Oldest surviving = V2, newest = V11 (V12 is
    // the live file).
    assert.strictEqual(fs.readFileSync(path.join(dir, snaps[0]), 'utf8'), 'V2\n');
    assert.strictEqual(fs.readFileSync(path.join(dir, snaps[9]), 'utf8'), 'V11\n');
});

await test('.backups excluded from recursive list', async () => {
    const { entries } = await ops.list('', { recursive: true });
    assert.strictEqual(entries.filter(e => e.path.includes('.backups')).length, 0);
});

await test('.backups never self-snapshots; _trash skipped', async () => {
    await ops.write('.backups/manual.md', 'MANUAL\n', { overwrite: true });
    await ops.write('_trash/junk.md', 'JUNK\n', { overwrite: true });
    const listing = fs.readdirSync(path.join(root, '.backups'));
    assert.strictEqual(listing.filter(n => n.includes('manual.md.')).length, 0, '.backups self-snapshotted');
    assert.strictEqual(listing.filter(n => n.includes('junk.md.')).length, 0, '_trash snapshotted');
});

await test('writeFromUrl is engine-parked — snapshot path via atomicWrite covered by write()', async () => {
    // writeFromUrl fetches remote content; no network in tests. Its snapshot
    // behavior flows through the same atomicWrite exercised above.
    assert.strictEqual(typeof ops.writeFromUrl, 'function');
});

// ---------- #28: temp leak on failed rename ----------

await test('failed rename → temp cleaned up, error surfaced, target intact', async () => {
    await ops.write('victim.md', 'PRECIOUS\n', { overwrite: true });
    const realRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
        calls++;
        if (String(from).includes('.fileops-tmp-')) {
            throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
        }
        return realRename(from, to);
    };
    let threw = null;
    try {
        await ops.write('victim.md', 'LOST\n', { overwrite: true });
    } catch (e) {
        threw = e;
    } finally {
        fs.renameSync = realRename;
    }
    assert.ok(threw, 'write should have thrown');
    assert.strictEqual(threw.code, 'EPERM', 'original error must surface, not be swallowed');
    assert.strictEqual(fs.readFileSync(path.join(root, 'victim.md'), 'utf8'), 'PRECIOUS\n', 'target must be untouched');
    const leaked = fs.readdirSync(root).filter(n => n.startsWith('.fileops-tmp-'));
    assert.deepStrictEqual(leaked, [], `temp file leaked: ${leaked.join(', ')}`);
    assert.ok(calls > 0, 'rename interceptor must have been hit');
});

await test('failed write still produced a snapshot of prior content (recoverable)', async () => {
    const snaps = fs.readdirSync(path.join(root, '.backups')).filter(n => n.startsWith('victim.md.'));
    assert.strictEqual(snaps.length, 1, 'exactly one victim.md snapshot expected');
    assert.strictEqual(fs.readFileSync(path.join(root, '.backups', snaps[0]), 'utf8'), 'PRECIOUS\n');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
