// Queue unit test — stubbed executor, no conversions, no server.
// Run: node tests/nconvert-queue-test.mjs
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IngestQueue, CancelledError } from '../src/agents/nconvert/queue.js';

let failures = 0;
function check(name, cond, detail = '') {
    if (cond) console.log(`  ok   ${name}`);
    else { failures++; console.error(`  FAIL ${name} ${detail}`); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function waitFor(q, id, state, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        if (q.get(id)?.state === state) return q.get(id);
        await tick(10);
    }
    throw new Error(`timeout waiting for ${id} → ${state} (was ${q.get(id)?.state})`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nconvert-queue-'));
const store = path.join(tmp, 'jobs.json');

// executor that walks steps and can gate on a test-controlled promise
let gate = null;
const executor = async (job, progress) => {
    for (const s of job.steps.map((s) => s.id)) {
        progress.checkCancelled();
        if (gate) await gate.promise;
        await progress.step(s, { i: 1, n: 2 });
    }
    return { item: `ingest/fake_${job.id}`, format: 'pdf', depth: 'deep', words: 10, warnings: 0, responseText: 'ok' };
};

const q = new IngestQueue({ file: store, executor });

// ── enqueue + dedup ── (a gated so 'running' is observable deterministically)
gate = Promise.withResolvers();
const a = q.enqueue({ source: 'H:/a.pdf', args: { depth: 'deep' }, sha: 'aa', heavy: true, steps: ['converting', 'rendering', 'vision', 'summarizing'] });
const dup = q.enqueue({ source: 'H:/a.pdf', args: { depth: 'deep' }, sha: 'aa', heavy: true, steps: ['converting'] });
check('dedup returns same job', dup.job.id === a.job.id && dup.deduped);
const b = q.enqueue({ source: 'H:/b.pdf', args: { depth: 'deep' }, sha: 'bb', heavy: true, steps: ['converting'] });
check('second heavy job queued', q.get(b.job.id)?.state === 'queued');

await waitFor(q, a.job.id, 'running');
check('first job runs', true);
const queuedB = q.list({ state: 'queued' })[0];
check('second still queued with position', queuedB?.id === b.job.id && queuedB?.position === 1);
gate.resolve();

const aDone = await waitFor(q, a.job.id, 'done');
check('first done with steps', aDone.steps.every((s) => s.status === 'done'), JSON.stringify(aDone.steps));

const bDone = await waitFor(q, b.job.id, 'done');
check('second job ran after first (FIFO, one at a time)', bDone.state === 'done');

// ── persistence round-trip + restart recovery ──
gate = Promise.withResolvers();
const c = q.enqueue({ source: 'H:/c.pdf', args: { depth: 'deep' }, sha: 'cc', heavy: true, steps: ['converting', 'summarizing'] });
await waitFor(q, c.job.id, 'running');
check('c is running', q.get(c.job.id)?.state === 'running');

const q2 = new IngestQueue({ file: store, executor }); // simulate restart
check('running job re-queued after restart', q2.get(c.job.id)?.state === 'queued' && q2.get(c.job.id)?.requeued === true);

// ── cancel while queued ──
const d = q2.enqueue({ source: 'H:/d.pdf', args: { depth: 'deep' }, sha: 'dd', heavy: true, steps: ['converting'] });
q2.cancel(d.job.id);
check('queued cancel immediate', q2.get(d.job.id)?.state === 'cancelled');

// ── cancel while running (cooperative, deterministic gate) ──
// q2's executor still awaits the ORIGINAL gate promise; releasing it after
// the cancel flag is set makes checkCancelled throw at the next boundary.
await waitFor(q2, c.job.id, 'running');
q2.cancel(c.job.id);
check('cancel flag set on running job', q2.get(c.job.id)?.cancelRequested === true);
gate.resolve(); // executor proceeds → checkCancelled throws
await waitFor(q2, c.job.id, 'cancelled', 3000).then(
    () => check('running job cancelled at checkpoint', true),
    (e) => check('running job cancelled at checkpoint', false, e.message)
);

// ── events reach subscribers ──
const seen = [];
const unsub = q2.subscribe((evt) => seen.push(evt.type));
const f = q2.enqueue({ source: 'H:/f.pdf', args: { depth: 'deep' }, sha: 'ff', heavy: true, steps: ['converting'] });
await waitFor(q2, f.job.id, 'done');
unsub();
check('event stream saw lifecycle', seen.includes('job.queued') && seen.includes('job.done'), seen.join(','));

// ── inline jobs record but never queue ──
const g = await q2.runInline({ source: 'H:/g.txt', args: { depth: 'mechanical' }, sha: 'gg', steps: ['converting', 'summarizing'] });
check('inline job completes inline', g.state === 'done' && g.heavy === false);
check('inline result recorded', g.result?.item === `ingest/fake_${g.id}`);

// ── retention pruning ──
const q4 = new IngestQueue({ file: store, executor, maxHistory: 5 });
for (let i = 0; i < 8; i++) {
    const j = await q4.runInline({ source: `H:/i${i}.txt`, args: {}, sha: `s${i}`, steps: ['converting'] });
    if (j.state !== 'done') { check('retention setup failed', false, j.state); break; }
}
const finished = q4.jobs.filter((j) => j.state === 'done');
check('retention prunes history', finished.length <= 5, `${finished.length}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
