// Mocked-HTTP + real-temp-nVDB tests for the embedding pipeline provenance
// probe. No live service, no lab database, no production file is touched: the
// four stages are exercised through injected/mocked HTTP and a disposable nVDB
// under .cache, matching the real probe's contract.
//
//   node tests/embedding-pipeline.test.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmbedClient } from '../src/embed-client.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import { runPipelineProvenance, STAGE_NAMES } from '../scripts/verify-embedding-pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(REPO_ROOT, '.cache', `embedding-pipeline-test-${process.pid}`);
const DIM = 8;
const IDS = [
    'storage:notes/golden-a.md#0',
    'storage:notes/golden-b.md#0',
    'storage:notes/golden-c.md#2',
    'storage:fetch/golden-d.md#14',
    'storage:notes/golden-e.md#39'
];
const ACCESS_KEY = 'sk-live-SECRET-KEY-123';
const DIRECT = 'http://direct.test:4081';
const WRAPPER = 'http://wrapper.test:4080';
const GATEWAY = 'http://gateway.test:3400';

let passed = 0;
function ok(condition, label) {
    assert.ok(condition, label);
    passed++;
    console.log(`  ok  ${label}`);
}

// A stable, f32-exact vector per text so every stage can be byte-identical.
function vecFor(text) {
    const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
    const vector = new Array(DIM);
    for (let i = 0; i < DIM; i++) vector[i] = Math.fround(digest[i] / 255 + i / 1000);
    return vector;
}

function inputsFor(tag) {
    return IDS.map((id, i) => ({
        id,
        text: `${tag} private passage ${i}: PRIVATE-TEXT-MARKER-${i} ${'lorem ipsum '.repeat(3)}`,
        payload: { path: `notes/golden-${i}.md`, chunk: i, contentHash: `hash-${tag}-${i}` }
    }));
}

// Handlers receive (texts, mode) and return either plain vectors or explicit
// { index, embedding } items — the latter is how a batch index-label fault is
// injected. A handler that throws models an unreachable stage.
function createMock(handlers) {
    const calls = [];
    async function mockFetch(url, init) {
        const body = JSON.parse(init.body);
        const single = typeof body.input === 'string';
        const texts = single ? [body.input] : body.input;
        const stage = url.startsWith(DIRECT) ? 'direct' : url.startsWith(WRAPPER) ? 'wrapper' : url.startsWith(GATEWAY) ? 'gateway' : null;
        if (!stage) throw new Error(`mockFetch: unexpected url ${url}`);
        const handler = handlers[stage];
        if (typeof handler !== 'function') throw new Error(`mockFetch: no handler for ${stage}`);
        calls.push({ stage, mode: single ? 'single' : 'batch' });
        const result = handler(texts, single ? 'single' : 'batch');
        const items = result.map((item, i) => (Array.isArray(item) ? { object: 'embedding', index: i, embedding: item } : { object: 'embedding', ...item }));
        return { ok: true, status: 200, text: async () => '', json: async () => ({ object: 'list', data: items, model: body.model ?? null }) };
    }
    return { mockFetch, calls };
}

function embedderFor() {
    return createEmbedClient(GATEWAY, ACCESS_KEY);
}

async function probe({ handlers, inputs }) {
    const { mockFetch } = createMock(handlers);
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch;
    try {
        return await runPipelineProvenance({ inputs, directUrl: DIRECT, wrapperUrl: WRAPPER, embedder: embedderFor(), expectedDim: DIM, tmpRoot: TMP_ROOT });
    } finally {
        globalThis.fetch = original;
    }
}

const same = (texts) => texts.map(vecFor);

// ── 1. all stages agree ──────────────────────────────────────────────────────
{
    const inputs = inputsFor('all-match');
    const report = await probe({ handlers: { direct: same, wrapper: same, gateway: same }, inputs });
    ok(report.ok === true, 'all four stages bit-identical → report.ok');
    ok(report.firstMismatch === null, 'all-match run reports no first mismatch');
    ok(report.comparisons.every((c) => c.equal === true), 'every comparison is equal (none skipped)');
    ok(STAGE_NAMES.every((name) => report.stages[name].available), 'every stage and mode is available');
    ok(STAGE_NAMES.every((name) => report.stages[name].distinct === true), 'every stage keeps the five inputs distinct');
    ok(report.stages['nvdb-single'].entries.every((e) => e.payloadMatch === true), 'golden payloads survive nVDB insert/get/reopen');
    ok(report.stages['nvdb-single'].entries.every((e) => e.preInsertHashF32 === e.hashF32), 'nVDB readback equals the pre-insert f32 hash exactly');
    ok(report.verdict === 'all stages agree bit for bit in both modes', 'verdict names a fully healthy pipeline');
    ok(fs.readdirSync(TMP_ROOT).length === 0, 'temp nVDB directories are removed after close');
}

// ── 2. direct vs wrapper mismatch names the first stage ─────────────────────
{
    const inputs = inputsFor('direct-vs-wrapper');
    const report = await probe({
        handlers: {
            direct: same,
            wrapper: (texts) => texts.map((t) => (t.includes('private passage 2') ? [0.5, ...vecFor(t).slice(1)] : vecFor(t))),
            gateway: same
        },
        inputs
    });
    ok(report.ok === false, 'a wrapper divergence fails the report');
    ok(report.firstMismatch?.stageA === 'direct-single' && report.firstMismatch?.stageB === 'wrapper-single', 'first mismatch names direct-single vs wrapper-single');
    ok(report.firstMismatch?.inputId === IDS[2], 'first mismatch names the divergent input id');
    ok(report.verdict.startsWith('FIRST MISMATCH'), 'verdict leads with the first mismatch');
}

// ── 3. wrapper vs mcp mismatch ──────────────────────────────────────────────
{
    const inputs = inputsFor('wrapper-vs-mcp');
    const report = await probe({
        handlers: {
            direct: same,
            wrapper: same,
            gateway: (texts) => texts.map((t) => (t.includes('private passage 1') ? [0.25, ...vecFor(t).slice(1)] : vecFor(t)))
        },
        inputs
    });
    ok(report.ok === false, 'an mcp/gateway divergence fails the report');
    ok(report.firstMismatch?.stageA === 'wrapper-single' && report.firstMismatch?.stageB === 'mcp-single', 'first mismatch names wrapper-single vs mcp-single');
    ok(report.firstMismatch?.inputId === IDS[1], 'mcp mismatch names the divergent input id');
}

// ── 4. pre-insert vs readback mismatch (real nVDB, corrupted read) ──────────
function corruptingNvdbFactory({ id, delta }) {
    const real = loadNvdb();
    function Database(dir) {
        const db = new real.Database(dir);
        return {
            listCollections: () => db.listCollections(),
            createCollection: (name, dim) => db.createCollection(name, dim),
            getCollection(name) {
                const coll = db.getCollection(name);
                return {
                    insert: (...args) => coll.insert(...args),
                    flush: () => coll.flush(),
                    close: () => coll.close(),
                    get(docId) {
                        const doc = coll.get(docId);
                        if (doc && docId === id) {
                            const vector = Array.from(doc.vector);
                            vector[0] = Math.fround(vector[0] + delta);
                            return { ...doc, vector };
                        }
                        return doc;
                    }
                };
            },
            close: () => db.close()
        };
    }
    return { Database };
}
{
    const inputs = inputsFor('readback');
    const { mockFetch } = createMock({ direct: same, wrapper: same, gateway: same });
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch;
    let report;
    try {
        report = await runPipelineProvenance({
            inputs,
            directUrl: DIRECT,
            wrapperUrl: WRAPPER,
            embedder: embedderFor(),
            expectedDim: DIM,
            tmpRoot: TMP_ROOT,
            nvdbFactory: () => corruptingNvdbFactory({ id: IDS[3], delta: 0.5 })
        });
    } finally {
        globalThis.fetch = original;
    }
    const boundary = report.comparisons.find((c) => c.pair === 'nvdb-single pre-insert vs readback');
    ok(boundary.equal === false, 'pre-insert vs readback comparison fails when the stored vector changes');
    ok(boundary.mismatches[0].inputId === IDS[3], 'the readback mismatch names the corrupted input id');
    ok(report.ok === false && report.firstMismatch?.stageB === 'nvdb-single', 'first mismatch localizes the fault to the nVDB readback stage');
}

// ── 5. batch index mapping mismatch ─────────────────────────────────────────
{
    const inputs = inputsFor('batch-index');
    const swapped = (texts, mode) => (mode === 'single'
        ? texts.map(vecFor)
        : texts.map((t, i) => ({ index: i === 0 ? 1 : i === 1 ? 0 : i, embedding: vecFor(t) })));
    const report = await probe({ handlers: { direct: swapped, wrapper: same, gateway: same }, inputs });
    const pair = report.comparisons.find((c) => c.pair === 'direct-batch vs wrapper-batch');
    ok(pair.equal === false, 'a mislabeled batch index is caught by direct-batch vs wrapper-batch');
    ok(pair.mismatches.length === 2 && pair.mismatches.every((m) => [IDS[0], IDS[1]].includes(m.inputId)), 'both swapped inputs are named');
    ok(report.firstMismatch?.stageA === 'direct-batch' && [IDS[0], IDS[1]].includes(report.firstMismatch?.inputId), 'first mismatch is the batch stage and a swapped input');
    ok(report.comparisons.filter((c) => c.pair.endsWith('-single vs direct-batch')).every((c) => c.equal === false), 'single-vs-batch catches the same mapping fault');
}

// ── 6. unavailable stage fails loud ─────────────────────────────────────────
{
    const inputs = inputsFor('unavailable');
    const report = await probe({
        handlers: {
            direct: same,
            wrapper: () => { throw new Error('connect ECONNREFUSED 192.168.0.145:4080'); },
            gateway: same
        },
        inputs
    });
    ok(report.ok === false, 'an unreachable stage can never yield a healthy verdict');
    ok(report.unavailable.map((u) => u.stage).includes('wrapper-single'), 'single-mode unavailable stage is named');
    ok(report.unavailable.map((u) => u.stage).includes('wrapper-batch'), 'batch-mode unavailable stage is named');
    ok(report.verdict.startsWith('STAGE UNAVAILABLE'), 'verdict states the unavailable stage instead of healthy');
    ok(report.firstMismatch === null, 'an unavailable stage is not reported as a mismatch');
    ok(report.comparisons.filter((c) => c.pair.includes('wrapper')).every((c) => c.equal === null), 'comparisons touching the unavailable stage are skipped, not claimed equal');
    ok(report.stages['direct-single'].distinct === true, 'available stages still report their own evidence');
}

// ── 7. no secret or private text in the report ──────────────────────────────
{
    const inputs = inputsFor('leak');
    const report = await probe({ handlers: { direct: same, wrapper: same, gateway: same }, inputs });
    const serialized = JSON.stringify(report);
    ok(!serialized.includes(ACCESS_KEY), 'access key never appears in the report');
    ok(!serialized.includes('PRIVATE-TEXT-MARKER'), 'private input text never appears in the report');
    ok(inputs.every((input) => serialized.includes(input.id)), 'every input id is present');
    ok(report.inputs.every((entry) => /^[0-9a-f]{64}$/.test(entry.textSha256) && entry.label.length > 0), 'inputs are represented by SHA-256 and a short label only');
    ok(!serialized.includes('"embedding"'), 'no raw vector array is serialized into the report');
}

fs.rmSync(TMP_ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed`);
