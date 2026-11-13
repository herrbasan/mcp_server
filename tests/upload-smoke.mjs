#!/usr/bin/env node
// Smoke test for the upload handoff routes (docs/upload-handoff-spec.md).
// Boots the routes on an ephemeral port with throwaway config — no live server,
// no nTeligence. Writes only its own dirs under data/uploads; everything it
// creates is removed again (by DELETE or by the sweeper).
//
//   node tests/upload-smoke.mjs

import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { PassThrough } from 'stream';
import { initUploadRoutes, UPLOAD_ROOT, readUploadMeta } from '../src/upload.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const failures = [];

function check(name, condition, detail = '') {
    if (condition) console.log(`ok   ${name}`);
    else {
        failures.push(name);
        console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function dumpLeftovers(tag) {
    const leftovers = fs.readdirSync(UPLOAD_ROOT).map((id) => {
        const metaPath = path.join(UPLOAD_ROOT, id, 'meta.json');
        let who = 'no meta (incomplete write)';
        try { who = JSON.parse(fs.readFileSync(metaPath, 'utf8')).name; } catch {}
        return `${id} (${who})`;
    });
    return `${tag}: ${leftovers.length ? leftovers.join(', ') : 'none'}`;
}

async function startServer(uploadConf) {
    const app = express();
    const routes = await initUploadRoutes(app, { agents: { upload: uploadConf } }, silentLogger);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return {
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

const post = (base, query, body, init = {}) =>
    fetch(`${base}/upload${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...init.headers },
        body,
        duplex: init.duplex
    });

// ── seed one expired and one interrupted upload — both must be swept at startup ──
const expiredId = crypto.randomUUID();
const interruptedId = crypto.randomUUID();
fs.mkdirSync(path.join(UPLOAD_ROOT, expiredId), { recursive: true });
fs.writeFileSync(path.join(UPLOAD_ROOT, expiredId, 'payload.bin'), 'x'.repeat(1024));
fs.writeFileSync(path.join(UPLOAD_ROOT, expiredId, 'meta.json'), JSON.stringify({
    id: expiredId, name: 'payload.bin', bytes: 1024, sha256: '00',
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 3600 * 1000).toISOString()
}));
fs.mkdirSync(path.join(UPLOAD_ROOT, interruptedId), { recursive: true });
fs.writeFileSync(path.join(UPLOAD_ROOT, interruptedId, 'partial.bin'), 'y'.repeat(512));

const server = await startServer({ maxBytes: 16 * 1048576, ttlHours: 24, minFreeGb: 20, sweepMinutes: 60 });
check('startup sweep removed expired upload', !fs.existsSync(path.join(UPLOAD_ROOT, expiredId)));
check('startup sweep removed interrupted upload', !fs.existsSync(path.join(UPLOAD_ROOT, interruptedId)));

// Dirs this run created — previous crashed runs and real uploads may leave
// non-expired dirs in the shared root, so absolute counts would be lies.
const baseline = new Set(fs.readdirSync(UPLOAD_ROOT));
const newDirs = () => fs.readdirSync(UPLOAD_ROOT).filter((d) => !baseline.has(d));

// ── happy path ──
const payload = Buffer.from('upload handoff smoke test payload');
const sha = crypto.createHash('sha256').update(payload).digest('hex');
let res = await post(server.base, '?filename=smoke test.txt', payload);
check('POST /upload 200', res.status === 200, `status ${res.status}`);
const handle = await res.json();
check('response shape { id, path, bytes, sha256, expiresAt }',
    !!(handle.id && handle.path && handle.bytes === payload.length && handle.sha256 === sha && handle.expiresAt),
    JSON.stringify(handle));
check('bytes readable at returned path', fs.readFileSync(handle.path).equals(payload));
check('meta.json written last = completeness marker', !!readUploadMeta(handle.id));

res = await fetch(`${server.base}/upload/${handle.id}`);
const meta = await res.json();
check('GET /upload/:id is metadata, not bytes',
    res.status === 200 && meta.path === handle.path && meta.bytes === payload.length && meta.sha256 === sha
    && res.headers.get('content-type').includes('application/json'));

// ── streamed body (createReadStream), unicode + spaces preserved in the name ──
const bigFile = path.join(os.tmpdir(), 'upload-smoke-streamed.bin');
fs.writeFileSync(bigFile, Buffer.alloc(1048576, 7));
res = await post(server.base, `?filename=${encodeURIComponent('deck (v2 – final).pptx')}`,
    fs.createReadStream(bigFile), { duplex: 'half' });
const streamed = await res.json();
check('streamed 1 MB upload lands complete',
    res.status === 200 && streamed.bytes === 1048576
    && fs.statSync(streamed.path).size === 1048576, JSON.stringify(streamed));
// uploadName keeps letters (incl. non-ASCII), digits, spaces, dots, parens, hyphens,
// underscores; the en-dash is Pd punctuation → '_'. Spec §3 fixes this exact set.
check('unicode/spaces filename sanitized per uploadName', path.basename(streamed.path) === 'deck (v2 _ final).pptx', streamed.path);

// ── TTL floor ──
res = await post(server.base, '?filename=floor.txt&ttl=0.01', payload);
const floored = await res.json();
const ttlHours = (Date.parse(floored.expiresAt) - Date.now()) / 3600e3;
check('ttl clamped to the 1 h floor', ttlHours > 0.98 && ttlHours <= 1.02, `ttl=${ttlHours}`);

// ── failure modes ──
// The floored upload is still alive through this section — it is only deleted
// in the final cleanup — so the baseline here is exactly its one directory.
res = await post(server.base, '', payload);
let text = await res.text();
check('missing filename 400', res.status === 400 && text.includes('filename'), text);
res = await post(server.base, '?filename=x.json', '{}', { headers: { 'Content-Type': 'application/json' } });
text = await res.text();
check('wrong content-type 400 naming octet-stream', res.status === 400 && text.includes('octet-stream'), text);
res = await post(server.base, '?filename=empty.txt', Buffer.alloc(0));
text = await res.text();
check('empty body 400', res.status === 400, text);
res = await post(server.base, '?filename=x.txt&ttl=nope', payload);
text = await res.text();
check('non-numeric ttl 400', res.status === 400, text);
const stillAlive = () => [handle.id, streamed.id, floored.id];
check('failed uploads leave nothing behind', newDirs().filter((d) => !stillAlive().includes(d)).length === 0, dumpLeftovers('leftovers'));

// ── client abort mid-upload: directory must be removed ──
const pt = new PassThrough();
const aborted = post(server.base, '?filename=abort.bin', pt, { duplex: 'half' });
aborted.catch(() => {}); // the client side rejects when the stream is destroyed — expected
pt.write('a'.repeat(4096));
await new Promise((r) => setTimeout(r, 200));
pt.destroy();
let abortedClean = false;
for (let i = 0; i < 50 && !abortedClean; i++) {
    await new Promise((r) => setTimeout(r, 100));
    abortedClean = newDirs().filter((d) => !stillAlive().includes(d)).length === 0;
}
check('aborted upload cleaned up within 5 s', abortedClean, dumpLeftovers('leftovers'));

// cleanup the handles the happy path left
for (const id of [handle.id, streamed.id, floored.id]) {
    const del = await fetch(`${server.base}/upload/${id}`, { method: 'DELETE' });
    if (del.status !== 200) console.error(`cleanup ${id}: HTTP ${del.status} ${await del.text()}`);
}
check('test handles all removed', newDirs().length === 0, dumpLeftovers('leftovers'));
await server.close();

// ── body cap: 413 naming agents.upload.maxBytes ──
const tiny = await startServer({ maxBytes: 16, ttlHours: 24, minFreeGb: 20, sweepMinutes: 60 });
res = await post(tiny.base, '?filename=big.bin', payload);
text = await res.text();
check('over-cap 413 naming agents.upload.maxBytes', res.status === 413 && text.includes('agents.upload.maxBytes'), text);
res = await post(tiny.base, '?filename=big.bin', payload);
text = await res.text();
check('content-length early reject 413', res.status === 413, text);
check('413 leaves nothing behind', newDirs().length === 0, dumpLeftovers('leftovers'));
await tiny.close();

// ── disk guard: 507 before anything is created ──
const full = await startServer({ maxBytes: 16 * 1048576, ttlHours: 24, minFreeGb: 102400, sweepMinutes: 60 });
res = await post(full.base, '?filename=guarded.bin', payload);
text = await res.text();
check('low-disk 507 naming agents.upload.minFreeGb', res.status === 507 && text.includes('agents.upload.minFreeGb'), text);
check('507 creates no directory', newDirs().length === 0, dumpLeftovers('leftovers'));
await full.close();

if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
}
console.log('\nall upload handoff checks passed');
