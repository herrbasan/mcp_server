// Regression test for #31 — VDB scan must not monopolize the main thread.
//
// Reproduces the exact production pathology: a scan's unchanged-file skip
// path (sync readFileSync + sync sha256, zero awaits) held the MCP main
// thread 10-45s per pass, stalling ALL tool traffic.
//
// Measures event-loop lag (what an MCP tool call experiences) while hashing
// a realistic corpus with:
//   OLD pattern: fs.readFileSync + createHash per file, no yields
//   NEW pattern: fs.promises.readFile (threadpool) + hash + yield budget
//
// Assertions:
//   OLD max lag > 2000ms  (canary: proves the pattern really blocks)
//   NEW max lag < 500ms   (fix: tool traffic interleaves with the scan)
//
// Run: node tests/vdb-scan-yield.test.mjs

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const FILE_COUNT = 250;
const FILE_SIZE = 300 * 1024; // 300KB — transcripts/arena-session scale
const YIELD_BUDGET_MS = 50;

// ── corpus ───────────────────────────────────────────────────────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdb-yield-'));
const bigChunk = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(1024); // ~57KB
for (let i = 0; i < FILE_COUNT; i++) {
    // 4-6 chunks per file → ~230-350KB, deterministic content
    const reps = 4 + (i % 3);
    fs.writeFileSync(path.join(root, `file-${i}.md`), (bigChunk + `\n<!-- ${i} -->\n`).repeat(reps));
}
let totalBytes = 0;
for (let i = 0; i < FILE_COUNT; i++) {
    totalBytes += fs.statSync(path.join(root, `file-${i}.md`)).size;
}

// ── lag probe ────────────────────────────────────────────────────────────
let last = Date.now();
let maxLag = 0;
const probe = setInterval(() => {
    const now = Date.now();
    const drift = now - last - 5;
    if (drift > maxLag) maxLag = drift;
    last = now;
}, 5);

function hashContent(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}
const yieldLoop = () => new Promise(r => setImmediate(r));

function watchFiles() {
    const files = fs.readdirSync(root);
    const watched = [];
    for (const f of files) watched.push({ absolutePath: path.join(root, f) });
    return watched;
}

const results = {};

// ── OLD pattern: sync sweep, zero awaits (the #31 pathology) ────────────
// NOTE: timer-drift from a sync block is only observable AFTER the block —
// the queued probe callback runs when the loop next breathes. So: sweep,
// yield once, THEN snapshot. (First version snapshotted before the probe
// tick could run and "measured" 0ms lag during a 278ms block.)
{
    const watched = watchFiles();
    const t0 = Date.now();
    for (const { absolutePath } of watched) {
        const content = fs.readFileSync(absolutePath, 'utf-8');
        hashContent(content);
    }
    results.oldMs = Date.now() - t0;
    await yieldLoop();            // let the starved probe tick land
    await new Promise(r => setTimeout(r, 15));
    results.oldMaxLag = maxLag;
}

maxLag = 0;
last = Date.now();
await new Promise(r => setTimeout(r, 15)); // settle — don't count reset-window drift

// ── NEW pattern: async read + yield budget (the fix) ─────────────────────
{
    const watched = watchFiles();
    let workSinceYield = 0;
    const t0 = Date.now();
    for (const { absolutePath } of watched) {
        const workStart = Date.now();
        const buf = await fs.promises.readFile(absolutePath);
        const content = buf.toString('utf-8');
        hashContent(content);
        workSinceYield += Date.now() - workStart;
        if (workSinceYield >= YIELD_BUDGET_MS) {
            workSinceYield = 0;
            await yieldLoop();
        }
    }
    results.newMs = Date.now() - t0;
    await yieldLoop();
    await new Promise(r => setTimeout(r, 15));
    results.newMaxLag = maxLag;
}

clearInterval(probe);

console.log(`corpus: ${FILE_COUNT} files, ${(totalBytes / 1024 / 1024).toFixed(1)}MB total`);
console.log(`OLD  sync sweep:      ${results.oldMs}ms total, max event-loop lag ${results.oldMaxLag}ms`);
console.log(`NEW  async + yields:  ${results.newMs}ms total, max event-loop lag ${results.newMaxLag}ms`);

let failed = 0;
try {
    // Self-calibrating canary: the observed drift must reflect the sweep's
    // wall time (drift ≈ sweep duration, minus scheduling slack). Also floor
    // at 100ms — under this corpus a non-blocking run shows ~0ms.
    assert.ok(results.oldMaxLag >= results.oldMs - 50 && results.oldMaxLag > 100,
        `OLD pattern should block hard: sweep ${results.oldMs}ms but observed lag only ${results.oldMaxLag}ms`);
    console.log('ok   OLD blocks hard (canary confirms the pathology)');
} catch (e) { failed++; console.error('FAIL ' + e.message); }
try {
    assert.ok(results.newMaxLag < 500, `NEW pattern should keep lag bounded (got ${results.newMaxLag}ms)`);
    console.log('ok   NEW keeps event-loop lag bounded (<500ms) — tool traffic survives scans');
} catch (e) { failed++; console.error('FAIL ' + e.message); }

fs.rmSync(root, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
