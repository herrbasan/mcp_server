import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { createFileOps } from '../src/lib/fileops.js';
import { createPathTranslator } from '../src/agents/storage/path-translator.js';

function freshRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'fileops-test-'));
}

function cleanup(root) {
    fs.rmSync(root, { recursive: true, force: true });
}

// ============================================
// Confinement
// ============================================

test('confinement: ../ escape throws', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await assert.rejects(() => ops.read('../../etc/passwd'), /escapes root/);
    cleanup(root);
});

test('confinement: absolute path outside root throws', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const outside = path.join(os.tmpdir(), 'fileops-outside-' + Date.now());
    await assert.rejects(() => ops.read(outside), /escapes root/);
    cleanup(root);
});

test('confinement: symlink pointing outside root throws', async (t) => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const outside = path.join(os.tmpdir(), 'fileops-outside-target-' + Date.now());
    fs.writeFileSync(outside, 'secret');
    const linkPath = path.join(root, 'evil-link');
    try {
        fs.symlinkSync(outside, linkPath);
    } catch (e) {
        if (e.code === 'EPERM' || e.code === 'EACCES') {
            fs.unlinkSync(outside);
            t.skip('symlinks not permitted on this platform (needs admin/dev mode)');
            return;
        }
        throw e;
    }
    await assert.rejects(() => ops.read('evil-link'), /escapes root/);
    fs.unlinkSync(outside);
    cleanup(root);
});

test('confinement: UNC-form path translates when translator configured', async () => {
    const root = freshRoot();
    const realRoot = fs.realpathSync(root);
    const translator = createPathTranslator({
        localRoot: realRoot,
        uncShare: '\\\\FAKESHARE\\storage'
    });
    const ops = createFileOps({ root, translator });
    await ops.write('unc-test.txt', 'data');
    // UNC path should resolve to the same file
    const r = await ops.read('\\\\FAKESHARE\\storage\\unc-test.txt');
    assert.equal(r.content, 'data');
    cleanup(root);
});

test('confinement: write to not-yet-created nested path works', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('a/b/c/d/deep.txt', 'nested');
    const r = await ops.read('a/b/c/d/deep.txt');
    assert.equal(r.content, 'nested');
    cleanup(root);
});

// ============================================
// write / overwrite guard
// ============================================

test('write: overwrite without flag throws', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('exists.txt', 'first');
    await assert.rejects(() => ops.write('exists.txt', 'second'), /target exists/);
    cleanup(root);
});

test('write: overwrite with flag succeeds', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('exists.txt', 'first');
    await ops.write('exists.txt', 'second', { overwrite: true });
    const r = await ops.read('exists.txt');
    assert.equal(r.content, 'second');
    cleanup(root);
});

// ============================================
// copy
// ============================================

test('copy: file', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('src.txt', 'copy me');
    const r = await ops.copy('src.txt', 'dst.txt');
    const c = await ops.read('dst.txt');
    assert.equal(c.content, 'copy me');
    assert.equal(r.size, 7);
    cleanup(root);
});

test('copy: dir', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('srcdir/a.txt', 'a');
    await ops.write('srcdir/sub/b.txt', 'b');
    await ops.copy('srcdir', 'dstdir');
    const a = await ops.read('dstdir/a.txt');
    const b = await ops.read('dstdir/sub/b.txt');
    assert.equal(a.content, 'a');
    assert.equal(b.content, 'b');
    cleanup(root);
});

test('copy: refuse-overwrite', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('src.txt', 'x');
    await ops.write('dst.txt', 'y');
    await assert.rejects(() => ops.copy('src.txt', 'dst.txt'), /target exists/);
    cleanup(root);
});

test('copy: overwrite:true', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('src.txt', 'new');
    await ops.write('dst.txt', 'old');
    await ops.copy('src.txt', 'dst.txt', { overwrite: true });
    const c = await ops.read('dst.txt');
    assert.equal(c.content, 'new');
    cleanup(root);
});

// ============================================
// append
// ============================================

test('append: creates missing file', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.append('new.txt', 'first\n');
    const r = await ops.read('new.txt');
    assert.equal(r.content, 'first\n');
    cleanup(root);
});

test('append: appends to existing', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('log.txt', 'line1\n');
    await ops.append('log.txt', 'line2\n');
    const r = await ops.read('log.txt');
    assert.equal(r.content, 'line1\nline2\n');
    cleanup(root);
});

test('append: after snapshot exists (nlink>1) version bytes unchanged', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('shared.txt', 'ORIGINAL');
    // overwrite creates a version (snapshot of ORIGINAL)
    await ops.write('shared.txt', 'V2', { overwrite: true });
    // now append — nlink > 1 because V2 is hardlinked in .versions
    await ops.append('shared.txt', '_APPENDED');

    const live = await ops.read('shared.txt');
    assert.equal(live.content, 'V2_APPENDED');

    // the version (ORIGINAL) must be unchanged
    const hist = await ops.history('shared.txt');
    const versionsDir = path.join(root, '.versions', 'shared.txt');
    const versionFiles = fs.readdirSync(versionsDir).sort();
    const oldestBytes = fs.readFileSync(path.join(versionsDir, versionFiles[0]), 'utf8');
    assert.equal(oldestBytes, 'ORIGINAL', 'version bytes must be unchanged after append');
    cleanup(root);
});

// ============================================
// readWindow
// ============================================

test('readWindow: offset/length', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('win.txt', '0123456789ABCDEFGHIJ');
    const r = await ops.readWindow('win.txt', { offset: 10, length: 5 });
    assert.equal(r.content, 'ABCDE');
    assert.deepEqual(r.window, { offset: 10, length: 5, bytesRead: 5 });
    cleanup(root);
});

test('readWindow: head N', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('lines.txt', 'one\ntwo\nthree\nfour\nfive');
    const r = await ops.readWindow('lines.txt', { head: 2 });
    assert.equal(r.content, 'one\ntwo');
    cleanup(root);
});

test('readWindow: tail N on 10000-line file', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const lines = Array.from({ length: 10000 }, (_, i) => `line${i}`).join('\n');
    await ops.write('big.txt', lines);
    const r = await ops.readWindow('big.txt', { tail: 3 });
    assert.equal(r.content, 'line9997\nline9998\nline9999');
    cleanup(root);
});

test('readWindow: tail larger than file', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('small.txt', 'a\nb\nc');
    const r = await ops.readWindow('small.txt', { tail: 100 });
    assert.equal(r.content, 'a\nb\nc');
    cleanup(root);
});

test('readWindow: no mode throws', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('x.txt', 'data');
    await assert.rejects(() => ops.readWindow('x.txt', {}), /must specify/);
    cleanup(root);
});

// ============================================
// grep
// ============================================

test('grep: matches across nested files', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('grep/a.md', 'hello world\nfoo');
    await ops.write('grep/sub/b.md', 'hello again');
    await ops.write('grep/c.md', 'no match');
    const r = await ops.grep('grep', 'hello');
    assert.equal(r.matches.length, 2);
    cleanup(root);
});

test('grep: maxMatches sets truncated', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('many.txt', Array.from({ length: 50 }, () => 'match').join('\n'));
    const r = await ops.grep('many.txt', 'match', { maxMatches: 5 });
    assert.equal(r.matches.length, 5);
    assert.equal(r.truncated, true);
    cleanup(root);
});

test('grep: context lines', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('ctx.txt', 'l0\nl1\nTARGET\nl3\nl4');
    const r = await ops.grep('ctx.txt', 'TARGET', { context: 1 });
    assert.equal(r.matches.length, 1);
    assert.deepEqual(r.matches[0].before, ['l1']);
    assert.deepEqual(r.matches[0].after, ['l3']);
    cleanup(root);
});

test('grep: no-match returns empty', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('nm.txt', 'nothing here');
    const r = await ops.grep('nm.txt', 'xyzzy');
    assert.equal(r.matches.length, 0);
    assert.equal(r.truncated, false);
    cleanup(root);
});

test('grep: .versions/ content is not searched', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('live.txt', 'FINDME');
    await ops.write('live.txt', 'changed', { overwrite: true }); // creates version
    // .versions/live.txt/<stamp>_write contains "FINDME"
    const r = await ops.grep('', 'FINDME');
    assert.equal(r.matches.length, 0, 'should not search .versions/');
    cleanup(root);
});

// ============================================
// batch
// ============================================

test('batch: all-ok', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'a.txt', content: 'x' },
        { op: 'write', path: 'b.txt', content: 'y' },
        { op: 'read', path: 'a.txt' }
    ]);
    assert.equal(r.results.length, 3);
    assert.ok(r.results.every(x => x.ok));
    cleanup(root);
});

test('batch: collect-on-error partial results', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'a.txt', content: 'x' },
        { op: 'read', path: 'nope.txt' },
        { op: 'write', path: 'b.txt', content: 'y' }
    ], { onError: 'collect' });
    assert.equal(r.results.length, 3);
    assert.equal(r.results[1].ok, false);
    assert.equal(r.results[2].ok, true);
    cleanup(root);
});

test('batch: abort-on-error stops', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'a.txt', content: 'x' },
        { op: 'read', path: 'nope.txt' },
        { op: 'write', path: 'b.txt', content: 'y' }
    ], { onError: 'abort' });
    assert.equal(r.results.length, 2);
    assert.equal(r.results[1].ok, false);
    cleanup(root);
});

test('batch: unknown op name is per-item failure', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'a.txt', content: 'x' },
        { op: 'frobnicate' }
    ]);
    assert.equal(r.results[1].ok, false);
    assert.match(r.results[1].error, /unknown op/);
    cleanup(root);
});

// ============================================
// writeFromUrl
// ============================================

test('writeFromUrl: serves from in-test http server', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('from-server');
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/f.txt`;
    const r = await ops.writeFromUrl('dl.txt', url, { allowedPrefixes: ['http://127.0.0.1'] });
    assert.equal(r.size, 11);
    assert.equal(r.mime, 'text/plain');
    const c = await ops.read('dl.txt');
    assert.equal(c.content, 'from-server');
    server.close();
    cleanup(root);
});

test('writeFromUrl: prefix rejection', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await assert.rejects(
        () => ops.writeFromUrl('dl.txt', 'http://evil.com/x', { allowedPrefixes: ['http://127.0.0.1'] }),
        /not in allowedPrefixes/
    );
    cleanup(root);
});

test('writeFromUrl: empty allowedPrefixes throws', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await assert.rejects(
        () => ops.writeFromUrl('dl.txt', 'http://127.0.0.1/x'),
        /no allowedPrefixes/
    );
    cleanup(root);
});

// ============================================
// hash
// ============================================

test('hash: deterministic', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('h.txt', 'consistent');
    const h1 = await ops.hash('h.txt');
    const h2 = await ops.hash('h.txt');
    assert.equal(h1.hash, h2.hash);
    assert.equal(h1.hash.length, 64); // sha256 hex
    cleanup(root);
});

test('hash: changes when content changes', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('h.txt', 'before');
    const h1 = await ops.hash('h.txt');
    await ops.write('h.txt', 'after', { overwrite: true });
    const h2 = await ops.hash('h.txt');
    assert.notEqual(h1.hash, h2.hash);
    cleanup(root);
});

// ============================================
// list glob
// ============================================

test('list glob: *.md top-level', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('a.md', 'x');
    await ops.write('b.md', 'x');
    await ops.write('c.txt', 'x');
    const r = await ops.list('', { pattern: '*.md' });
    assert.equal(r.entries.length, 2);
    cleanup(root);
});

test('list glob: **/*.md recursive', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('top.md', 'x');
    await ops.write('sub/deep.md', 'x');
    await ops.write('sub/nested/even.md', 'x');
    await ops.write('sub/data.txt', 'x');
    // ** matches any chars including /, so **/*.md matches paths with at least one /
    const r = await ops.list('', { recursive: true, pattern: '**/*.md' });
    assert.equal(r.entries.length, 2);
    // **.md (no slash after **) matches everything including top-level
    const r2 = await ops.list('', { recursive: true, pattern: '**.md' });
    assert.equal(r2.entries.length, 3);
    cleanup(root);
});

test('list: .versions excluded', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('live.txt', 'v1');
    await ops.write('live.txt', 'v2', { overwrite: true }); // creates .versions/
    const r = await ops.list('', { recursive: true });
    assert.ok(!r.entries.some(e => e.path.startsWith('.versions')));
    cleanup(root);
});

// ============================================
// versioning
// ============================================

test('versioning: snapshot → modify → version bytes intact', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('v.txt', 'ORIGINAL');
    await ops.write('v.txt', 'MODIFIED', { overwrite: true });
    const versionsDir = path.join(root, '.versions', 'v.txt');
    const files = fs.readdirSync(versionsDir).sort();
    const bytes = fs.readFileSync(path.join(versionsDir, files[0]), 'utf8');
    assert.equal(bytes, 'ORIGINAL');
    cleanup(root);
});

test('versioning: retention prunes to keepVersions', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root, keepVersions: 3 });
    for (let i = 0; i < 8; i++) {
        await ops.write('r.txt', `v${i}`, { overwrite: true });
    }
    const h = await ops.history('r.txt');
    assert.ok(h.versions.length <= 3);
    cleanup(root);
});

test('versioning: restore round-trip', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('rt.txt', 'FIRST');
    await ops.write('rt.txt', 'SECOND', { overwrite: true });
    await ops.restore('rt.txt', { steps: 1 });
    const c = await ops.read('rt.txt');
    assert.equal(c.content, 'FIRST');
    cleanup(root);
});

test('versioning: restore-of-restore (undo is undoable)', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('rr.txt', 'A');
    await ops.write('rr.txt', 'B', { overwrite: true });
    // restore to A
    await ops.restore('rr.txt', { steps: 1 });
    let c = await ops.read('rr.txt');
    assert.equal(c.content, 'A');
    // now restore back to B (the pre-restore state was snapshotted)
    await ops.restore('rr.txt', { steps: 1 });
    c = await ops.read('rr.txt');
    assert.equal(c.content, 'B');
    cleanup(root);
});

test('versioning: history empty when no versions', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('fresh.txt', 'x');
    const h = await ops.history('fresh.txt');
    assert.equal(h.versions.length, 0);
    cleanup(root);
});

test('versioning: restore steps > available throws', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('x.txt', 'v1');
    await ops.write('x.txt', 'v2', { overwrite: true });
    await assert.rejects(() => ops.restore('x.txt', { steps: 99 }), /only 1 versions/);
    cleanup(root);
});

// ============================================
// isolation
// ============================================

test('isolation: two instances on different roots do not cross', async () => {
    const root1 = freshRoot();
    const root2 = freshRoot();
    const ops1 = createFileOps({ root: root1 });
    const ops2 = createFileOps({ root: root2 });
    await ops1.write('only-in-1.txt', 'data');
    const s = await ops2.stat('only-in-1.txt');
    assert.equal(s.exists, false);
    const l1 = await ops1.list('');
    assert.equal(l1.entries.length, 1);
    cleanup(root1);
    cleanup(root2);
});

// ============================================
// stat edge cases
// ============================================

test('stat: missing path returns exists:false', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const s = await ops.stat('nope.txt');
    assert.equal(s.exists, false);
    cleanup(root);
});

test('stat: directory', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('dir/a.txt', 'x');
    const s = await ops.stat('dir');
    assert.equal(s.exists, true);
    assert.equal(s.type, 'dir');
    cleanup(root);
});

// ============================================
// batch
// ============================================

test('batch: all-ok mixed ops return per-op results', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'a.txt', content: 'alpha' },
        { op: 'copy', from: 'a.txt', to: 'b.txt' },
        { op: 'append', path: 'b.txt', content: '-beta' }
    ]);
    assert.equal(r.results.length, 3);
    assert.ok(r.results.every(x => x.ok));
    const readBack = await ops.read('b.txt');
    assert.equal(readBack.content, 'alpha-beta');
    cleanup(root);
});

test('batch: write with overwrite option succeeds (named args, not positional)', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    // Regression: options must route by name. Object.values() positional spread
    // passed the options object as the wrong argument and this op failed.
    const r = await ops.batch([
        { op: 'write', path: 'c.txt', content: 'v1' },
        { op: 'write', path: 'c.txt', content: 'v2', overwrite: true }
    ]);
    assert.equal(r.results.length, 2);
    assert.ok(r.results[0].ok, 'first write should succeed');
    assert.ok(r.results[1].ok, 'overwrite write should succeed: ' + (r.results[1].error || ''));
    const readBack = await ops.read('c.txt');
    assert.equal(readBack.content, 'v2');
    cleanup(root);
});

test('batch: readWindow with tail option works inside batch', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'lines.txt', content: 'one\ntwo\nthree' },
        { op: 'readWindow', path: 'lines.txt', tail: 1 }
    ]);
    assert.ok(r.results[1].ok, 'readWindow in batch should succeed: ' + (r.results[1].error || ''));
    assert.equal(r.results[1].content, 'three');
    cleanup(root);
});

test('batch: collect-on-error continues and reports partial results', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'ok1.txt', content: 'a' },
        { op: 'read', path: 'does-not-exist.txt' },
        { op: 'write', path: 'ok2.txt', content: 'b' }
    ], { onError: 'collect' });
    assert.equal(r.results.length, 3);
    assert.ok(r.results[0].ok);
    assert.equal(r.results[1].ok, false);
    assert.ok(r.results[2].ok, 'op after a failure should still run in collect mode');
    cleanup(root);
});

test('batch: abort-on-error stops at first failure', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'ok1.txt', content: 'a' },
        { op: 'read', path: 'does-not-exist.txt' },
        { op: 'write', path: 'ok2.txt', content: 'b' }
    ], { onError: 'abort' });
    assert.equal(r.results.length, 2, 'abort stops after the failing op');
    assert.equal(r.results[1].ok, false);
    const s = await ops.stat('ok2.txt');
    assert.equal(s.exists, false, 'third op must not run after abort');
    cleanup(root);
});

test('batch: unknown op is a per-item failure, not a throw', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    const r = await ops.batch([
        { op: 'write', path: 'x.txt', content: 'a' },
        { op: 'nonexistentOp', path: 'x.txt' },
        { op: 'stat', path: 'x.txt' }
    ]);
    assert.equal(r.results.length, 3);
    assert.equal(r.results[1].ok, false);
    assert.match(r.results[1].error, /unknown op/);
    assert.ok(r.results[2].ok);
    cleanup(root);
});

// ============================================
// remove
// ============================================

test('remove: non-empty dir without recursive throws', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('dir/a.txt', 'x');
    await assert.rejects(() => ops.remove('dir'), /not empty/);
    cleanup(root);
});

test('remove: recursive removes non-empty dir', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('dir/a.txt', 'x');
    await ops.remove('dir', { recursive: true });
    const s = await ops.stat('dir');
    assert.equal(s.exists, false);
    cleanup(root);
});

// ============================================
// move
// ============================================

test('move: destination exists throws', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('a.txt', 'x');
    await ops.write('b.txt', 'y');
    await assert.rejects(() => ops.move('a.txt', 'b.txt'), /destination exists/);
    cleanup(root);
});

// ============================================
// snapshotDir / diffSnapshots
// ============================================

test('snapshotDir + diffSnapshots: detects added/removed/modified', async () => {
    const root = freshRoot();
    const ops = createFileOps({ root });
    await ops.write('keep.txt', 'same');
    await ops.write('change.txt', 'before');
    await ops.write('remove.txt', 'gone');
    const before = await ops.snapshotDir('');
    await ops.write('change.txt', 'after', { overwrite: true });
    await ops.remove('remove.txt');
    await ops.write('new.txt', 'added');
    const after = await ops.snapshotDir('');
    const diff = ops.diffSnapshots(before, after);
    assert.ok(diff.added.includes('new.txt'));
    assert.ok(diff.removed.includes('remove.txt'));
    assert.ok(diff.modified.includes('change.txt'));
    cleanup(root);
});
