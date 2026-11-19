// Lab vector-repair utility — offline fixture tests.
//
//   node tests/memory-lab-vector-repair.test.mjs
//
// Every fixture is a tiny native nDB / nVDB database with 8-dim vectors, built
// under tests/fixtures/.tmp-repair-<pid> and removed afterwards. Nothing here
// touches the real lab snapshot, live storage, the Gateway or any service: the
// embed transport is a scripted globalThis.fetch answering the REAL guarded
// createEmbedClient, so the shared embedding-integrity guard is exercised
// exactly as in production.

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import { createEmbedClient } from '../src/embed-client.js';
import {
    TOOL,
    REPORT_VERSION,
    MEMORY_INPUT_MAX_CHARS,
    createRepairGuard,
    formatContextHeader,
    reconstructStorageChunk,
    serializeMemoryData,
    memoryInputText,
    auditStorageVectors,
    auditMemoryVectors,
    buildRepairPlan,
    probeExplicitVectors,
    validateEmbeddingSet,
    findStoredCollisions,
    storedOwnerInputHash,
    storedOwnerInputText,
    wrapRepairEmbedder,
    cosineSimilarity,
    classifyProbe,
    writeRepairReport,
    summarize,
    parseArgs,
    runRepair,
    sha256Text
} from '../scripts/repair-memory-lab-vectors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP = path.join(REPO_ROOT, 'tests', 'fixtures', `.tmp-repair-${process.pid}`);

const DIM = 8;

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        process.stdout.write(`ok    ${name}\n`);
    } catch (e) {
        failures.push({ name, error: e.message });
        const where = String(e.stack ?? '').split('\n').find((line) => line.includes('memory-lab-vector-repair.test.mjs'));
        process.stdout.write(`FAIL  ${name}\n      ${e.message}\n      ${where ?? ''}\n`);
    }
}

function freshDir(name) {
    const dir = path.join(TMP, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function basis(index, dim = DIM) {
    const v = new Array(dim).fill(0);
    v[index] = 1;
    return v;
}

function hashFile(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashDir(dir) {
    const h = crypto.createHash('sha256');
    const walk = (d) => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) {
                h.update(`D:${path.relative(dir, p)}\n`);
                walk(p);
            } else {
                h.update(`F:${path.relative(dir, p)}:${hashFile(p)}\n`);
            }
        }
    };
    walk(dir);
    return h.digest('hex');
}

// ── scripted embed transport (no network) ────────────────────────────────────

const DUP_VEC = [0.123456789, 0.234567891, 0.345678912, 0.456789123, 0.567891234, 0.678912345, 0.789123456, 0.891234567];

function vectorFor(text) {
    const digest = crypto.createHash('sha256').update(text, 'utf8').digest();
    const v = new Array(DIM).fill(0);
    for (let i = 0; i < DIM; i++) v[i] = (digest[i] + 1) / 256;
    return v;
}

const fetchState = { mode: 'deterministic', requests: [], overrides: new Map(), overrideOnce: new Map(), batchOverrides: new Map(), failAfterCalls: null, failuresLeft: 0 };

globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const isBatch = Array.isArray(body.input);
    const inputs = isBatch ? body.input : [body.input];
    fetchState.requests.push({ url, inputs, batch: isBatch });
    if (fetchState.failAfterCalls !== null && fetchState.requests.length > fetchState.failAfterCalls && fetchState.failuresLeft > 0) {
        fetchState.failuresLeft--;
        throw new TypeError('fetch failed');
    }
    const data = inputs.map((text, index) => {
        let embedding;
        if (isBatch && fetchState.batchOverrides.has(text)) {
            embedding = fetchState.batchOverrides.get(text);
        } else if (fetchState.overrides.has(text)) {
            embedding = fetchState.overrides.get(text);
        } else if (fetchState.overrideOnce.has(text)) {
            embedding = fetchState.overrideOnce.get(text);
            fetchState.overrideOnce.delete(text);
        } else {
            embedding = fetchState.mode === 'duplicate' ? [...DUP_VEC] : vectorFor(text);
        }
        return { index, embedding: [...embedding] };
    });
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data }),
        text: async () => JSON.stringify({ data })
    };
};

function setProvider(mode) {
    fetchState.mode = mode;
    fetchState.requests.length = 0;
    fetchState.overrides.clear();
    fetchState.overrideOnce.clear();
    fetchState.batchOverrides.clear();
    fetchState.failAfterCalls = null;
    fetchState.failuresLeft = 0;
}

// Fail every call after the first `afterCalls` requests (one bounded retry means
// two consecutive failures are needed to surface a permanent error).
function failFromCall(afterCalls, count = 2) {
    fetchState.failAfterCalls = afterCalls;
    fetchState.failuresLeft = count;
}

// ── fixture ──────────────────────────────────────────────────────────────────

const STORAGE = {
    'notes/dup-a.md': 'alpha source text for dup a',
    'notes/dup-b.md': 'beta duplicate source text b',
    'notes/same-1.md': 'shared legacy content one',
    'notes/same-2.md': 'shared legacy content one',
    'notes/solo.md': 'unrelated solo document text',
    'notes/extra-1.md': 'extra document one distinct text',
    'notes/extra-2.md': 'extra document two distinct text'
};

// The five golden explicit chunks. The same-content pair is deliberately NOT
// among them: two chunks with identical text legitimately embed identically, so
// the probe's distinctness requirement would be wrong for that pair.
const EXPLICIT = [
    'storage:notes/dup-a.md',
    'storage:notes/dup-b.md',
    'storage:notes/solo.md',
    'storage:notes/extra-1.md',
    'storage:notes/extra-2.md'
];

// The exact embed text production builds: context header + source slice.
const STORAGE_HEADERS = {
    'notes/dup-a.md': { docType: 'note', keywords: ['alpha'], entities: ['Alpha'], summary: 'Alpha note' },
    'notes/dup-b.md': { docType: 'note', keywords: ['beta'], entities: ['Beta'], summary: 'Beta note' }
};

function storageEmbedText(rel) {
    return formatContextHeader(STORAGE_HEADERS[rel] ?? { docType: 'note' }) + STORAGE[rel];
}

function buildSnapshot(root) {
    const work = path.join(root, 'work');
    const memoryDir = path.join(work, 'mcp-server', 'data', 'memories');
    const nvdbDir = path.join(work, 'mcp-server', 'data', 'nvdb');
    const storageDir = path.join(work, 'storage');
    const chatDataDir = path.join(work, 'chat-data');
    const referenceDir = path.join(root, 'reference');
    for (const d of [memoryDir, nvdbDir, storageDir, chatDataDir, path.join(referenceDir, 'storage')]) {
        fs.mkdirSync(d, { recursive: true });
    }
    fs.writeFileSync(path.join(referenceDir, 'storage', 'secret.md'), 'REFERENCE BASELINE — never read');

    // storage work files
    for (const [rel, text] of Object.entries(STORAGE)) {
        const target = path.join(storageDir, rel.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
    }
    // decoy outside the work tree: a live-shaped absolutePath pointing at it
    const decoyDir = path.join(root, 'decoy');
    fs.mkdirSync(decoyDir, { recursive: true });
    for (const rel of Object.keys(STORAGE)) {
        fs.writeFileSync(path.join(decoyDir, path.basename(rel)), 'DECOY NEVER READ');
    }

    const payloadFor = (rel, contentHash, extra = {}) => ({
        path: rel,
        // points at the decoy — the tool must resolve payload.path in the work copy instead
        absolutePath: path.join(decoyDir, path.basename(rel)),
        collection: 'storage',
        extension: '.md',
        splitIdx: 0,
        charOffset: 0,
        charLen: STORAGE[rel].length,
        isLastChunk: true,
        tokEst: 10,
        contentHash,
        docType: 'note',
        ...extra
    });

    const storageDocs = [
        { id: 'storage:notes/dup-a.md', vector: basis(0), payload: payloadFor('notes/dup-a.md', 'h-dup-a', { keywords: ['alpha'], entities: ['Alpha'], summary: 'Alpha note' }) },
        { id: 'storage:notes/dup-b.md', vector: basis(0), payload: payloadFor('notes/dup-b.md', 'h-dup-b', { keywords: ['beta'], entities: ['Beta'], summary: 'Beta note' }) },
        { id: 'storage:notes/same-1.md', vector: basis(1), payload: payloadFor('notes/same-1.md', 'h-same') },
        { id: 'storage:notes/same-2.md', vector: basis(1), payload: payloadFor('notes/same-2.md', 'h-same') },
        { id: 'storage:notes/solo.md', vector: basis(2), payload: payloadFor('notes/solo.md', 'h-solo') },
        { id: 'storage:notes/extra-1.md', vector: basis(3), payload: payloadFor('notes/extra-1.md', 'h-extra-1') },
        { id: 'storage:notes/extra-2.md', vector: basis(4), payload: payloadFor('notes/extra-2.md', 'h-extra-2') }
    ];

    // memory nDB
    const { Database } = loadNdb();
    const memDb = Database.open(path.join(memoryDir, 'data.jsonl'), { persistence: 'immediate' });
    const memIds = [
        memDb.insertWithPrefix('mem', { id: 101, description: 'first memory about vectors', data: { k: 'v' }, embedStatus: 'embedded' }),
        memDb.insertWithPrefix('mem', { id: 102, description: 'second memory about vectors', data: { k: 'v' }, embedStatus: 'embedded' }),
        memDb.insertWithPrefix('mem', { id: 103, description: 'twin memory text', embedStatus: 'embedded' }),
        memDb.insertWithPrefix('mem', { id: 104, description: 'twin memory text', embedStatus: 'embedded' }),
        memDb.insertWithPrefix('mem', { id: 105, description: 'unique memory', embedStatus: 'embedded' })
    ];
    memDb.flush();
    memDb.close();

    const memoryDocs = [
        { id: memIds[0], vector: basis(5), payload: { id: 101 } },
        { id: memIds[1], vector: basis(5), payload: { id: 102 } },
        { id: memIds[2], vector: basis(6), payload: { id: 103 } },
        { id: memIds[3], vector: basis(6), payload: { id: 104 } },
        { id: memIds[4], vector: basis(7), payload: { id: 105 } }
    ];

    const { Database: NvdbDatabase } = loadNvdb();
    const nvdb = new NvdbDatabase(nvdbDir);
    for (const [name, docs] of [['memory', memoryDocs], ['storage', storageDocs]]) {
        const coll = nvdb.createCollection(name, DIM);
        for (const doc of docs) coll.insert(doc.id, doc.vector, JSON.stringify(doc.payload));
        coll.flush();
        coll.close();
    }
    nvdb.close();

    fs.writeFileSync(path.join(nvdbDir, 'scan-index.json'), JSON.stringify({
        files: Object.fromEntries(Object.keys(STORAGE).map((rel) => [`storage:${rel}`, { collection: 'storage', path: rel, chunks: 1 }])),
        hashToDoc: {}
    }, null, 2));

    const manifest = {
        tool: 'snapshot-memory-lab',
        version: 1,
        name: 'repair-fixture',
        createdAt: '2026-11-17T00:00:00.000Z',
        mode: 'crash-consistent-copy',
        pointInTime: false,
        warning: 'fixture',
        workRoot: work,
        sources: [
            { name: 'memory-ndb', role: 'memory-ndb', workPath: memoryDir },
            { name: 'nvdb', role: 'nvdb', workPath: nvdbDir },
            { name: 'storage', role: 'storage', workPath: storageDir },
            { name: 'chat-data', role: 'chat-data', workPath: chatDataDir }
        ]
    };
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(root, 'MANIFEST.sha256'), `${hashFile(manifestPath)}  manifest.json\n`);

    const goldenPath = path.join(root, 'golden.json');
    fs.writeFileSync(goldenPath, JSON.stringify({
        tool: 'memory-lab-phase0-golden',
        suiteVersion: 'repair-fixture-1',
        version: 1,
        dataset: { expectedEmbeddingDim: DIM },
        memory: [],
        storage: [],
        chat: [],
        explicitVectorIds: EXPLICIT
    }, null, 2));

    return { root, work, memoryDir, nvdbDir, storageDir, referenceDir, decoyDir, goldenPath, memIds, explicitIds: EXPLICIT };
}

function readColl(nvdbDir, collection, ids) {
    const { Database } = loadNvdb();
    const db = new Database(nvdbDir);
    const coll = db.getCollection(collection);
    const out = {};
    try {
        for (const id of ids) {
            const record = coll.get(id);
            out[id] = record ? { vector: record.vector, payload: record.payload } : null;
        }
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof db.close === 'function') db.close();
    }
    return out;
}

function vectorHashOf(vector) {
    const f = new Float64Array(vector.length);
    for (let i = 0; i < vector.length; i++) f[i] = vector[i] === 0 ? 0 : vector[i];
    return crypto.createHash('sha256').update(Buffer.from(f.buffer, f.byteOffset, f.byteLength)).digest('hex');
}

// ── unit: header reconstruction and source remap ─────────────────────────────

await test('context header matches the production format exactly', () => {
    assert.equal(
        formatContextHeader({ docType: 'note', keywords: ['alpha', 'beta'], entities: ['Alpha'], summary: 'Alpha note' }),
        '[Type: note | Keywords: alpha, beta | Entities: Alpha | Summary: Alpha note]\n\n'
    );
    assert.equal(formatContextHeader({ keywords: ['only'] }), '[Keywords: only]\n\n');
    assert.equal(formatContextHeader({}), '');
    assert.equal(formatContextHeader({ keywords: 'not-an-array' }), '');
});

await test('storage embed text = header + work-copy slice, never payload.absolutePath', () => {
    const root = freshDir('remap');
    const fixture = buildSnapshot(root);
    const guard = createRepairGuard({
        workRoot: fixture.work,
        referenceRoot: fixture.referenceDir,
        liveRoots: [path.join(root, 'live')]
    });
    const payload = {
        path: 'notes/dup-a.md',
        absolutePath: path.join(fixture.decoyDir, 'dup-a.md'),
        charOffset: 0,
        charLen: STORAGE['notes/dup-a.md'].length,
        docType: 'note',
        keywords: ['alpha'],
        entities: ['Alpha'],
        summary: 'Alpha note'
    };
    const result = reconstructStorageChunk({ payload, storageWorkRoot: fixture.storageDir, guard });
    assert.equal(result.available, true, result.reason);
    assert.equal(
        result.embedText,
        '[Type: note | Keywords: alpha | Entities: Alpha | Summary: Alpha note]\n\n' + STORAGE['notes/dup-a.md']
    );
    assert.ok(!result.embedText.includes('DECOY'), 'the decoy absolutePath content must never be read');
    assert.equal(result.workPath, path.join(fixture.storageDir, 'notes', 'dup-a.md'));

    // char range is honoured
    const sliced = reconstructStorageChunk({ payload: { ...payload, charOffset: 6, charLen: 6 }, storageWorkRoot: fixture.storageDir, guard });
    assert.equal(sliced.chunkText, STORAGE['notes/dup-a.md'].slice(6, 12));

    // missing source is reported, not invented
    const missing = reconstructStorageChunk({ payload: { ...payload, path: 'notes/nope.md' }, storageWorkRoot: fixture.storageDir, guard });
    assert.equal(missing.available, false);
    assert.match(missing.reason, /missing/);
});

await test('guards reject live roots, the reference tree and path escapes', () => {
    const root = freshDir('guards');
    const fixture = buildSnapshot(root);
    const liveRoot = path.join(root, 'live');
    fs.mkdirSync(liveRoot, { recursive: true });
    fs.writeFileSync(path.join(liveRoot, 'data.jsonl'), '{}');
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [liveRoot] });

    assert.throws(() => guard.assertNotLive(path.join(liveRoot, 'data.jsonl'), 'live file'), /LIVE data root/);
    assert.throws(() => guard.assertWork(path.join(liveRoot, 'data.jsonl'), 'live file'), /outside the lab work root/);
    assert.throws(() => guard.assertWork(path.join(fixture.referenceDir, 'storage', 'secret.md'), 'reference file'), /REFERENCE tree/);

    // a payload path that escapes work into the reference tree is refused
    const escaped = reconstructStorageChunk({
        payload: { path: '../../reference/storage/secret.md', charOffset: 0, charLen: 4 },
        storageWorkRoot: fixture.storageDir,
        guard
    });
    assert.equal(escaped.available, false);
    assert.match(escaped.reason, /guard refused source/);
});

// ── unit: memory input serialization / truncation ────────────────────────────

await test('memory input is description + " " + JSON.stringify(data, null, 2), truncated at 6000', () => {
    assert.equal(serializeMemoryData(null), '');
    assert.equal(serializeMemoryData(''), '');
    assert.equal(serializeMemoryData('raw string'), 'raw string');
    assert.equal(serializeMemoryData({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));

    assert.equal(memoryInputText({ _id: 'mem_1', description: 'plain' }), 'plain');
    assert.equal(
        memoryInputText({ _id: 'mem_2', description: 'desc', data: { k: 'v' } }),
        `desc ${JSON.stringify({ k: 'v' }, null, 2)}`
    );

    const long = 'x'.repeat(7000);
    const truncated = memoryInputText({ _id: 'mem_3', description: long });
    assert.equal(truncated.length, MEMORY_INPUT_MAX_CHARS);
    assert.equal(MEMORY_INPUT_MAX_CHARS, 6000);

    const exact = memoryInputText({ _id: 'mem_4', description: 'y'.repeat(MEMORY_INPUT_MAX_CHARS) });
    assert.equal(exact.length, MEMORY_INPUT_MAX_CHARS);

    assert.throws(() => memoryInputText({ _id: 'mem_5' }), /no description/);
    assert.throws(() => memoryInputText({ description: 'x' }), /no _id/);

    // data truncated together with the description (single combined string)
    const combined = memoryInputText({ _id: 'mem_6', description: 'd'.repeat(5990), data: { long: 'z'.repeat(100) } });
    assert.equal(combined.length, MEMORY_INPUT_MAX_CHARS);
    assert.ok(combined.startsWith('d'.repeat(5990) + ' '));
});

// ── audit classification ─────────────────────────────────────────────────────

await test('same-content duplicates are legitimate, different-content duplicates are suspicious (storage)', () => {
    const root = freshDir('audit-storage');
    const fixture = buildSnapshot(root);
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [path.join(root, 'live')] });
    const { Database } = loadNvdb();
    const db = new Database(fixture.nvdbDir);
    const coll = db.getCollection('storage');
    try {
        const ids = Object.keys(STORAGE).map((rel) => `storage:${rel}`);
        const audit = auditStorageVectors({ ids, coll, storageWorkRoot: fixture.storageDir, guard, expectedDim: DIM });
        assert.equal(audit.summary.requestedIds, 7);
        assert.equal(audit.summary.vectorsPresent, 7);
        assert.equal(audit.summary.duplicateGroups, 2);
        assert.equal(audit.summary.suspiciousGroups, 1);
        assert.equal(audit.summary.legitimateSameContentGroups, 1);

        assert.deepEqual(audit.summary.affectedIds.sort(), ['storage:notes/dup-a.md', 'storage:notes/dup-b.md']);
        assert.deepEqual(audit.legitimateGroups[0].ids.sort(), ['storage:notes/same-1.md', 'storage:notes/same-2.md']);

        const group = audit.suspiciousGroups[0];
        assert.equal(group.suspicious, true);
        assert.equal(group.records.length, 2);
        for (const record of group.records) {
            assert.equal(record.sourceAvailable, true, record.sourceReason);
            assert.match(record.embedTextSha256, /^[0-9a-f]{64}$/);
        }
        // repair material resolves the work-copy text, not the decoy
        const repair = audit.repairRecords.get('storage:notes/dup-a.md');
        assert.ok(repair.embedText.includes(STORAGE['notes/dup-a.md']));
        assert.ok(!repair.embedText.includes('DECOY'));
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof db.close === 'function') db.close();
    }
});

await test('memory duplicates are suspicious only when the computed inputs differ', () => {
    const root = freshDir('audit-memory');
    const fixture = buildSnapshot(root);
    const { Database: NdbDatabase } = loadNdb();
    const memDb = NdbDatabase.open(path.join(fixture.memoryDir, 'data.jsonl'), { persistence: 'lazy' });
    const { Database } = loadNvdb();
    const nvdb = new Database(fixture.nvdbDir);
    const coll = nvdb.getCollection('memory');
    try {
        const audit = auditMemoryVectors({ docs: memDb.iter(), coll, expectedDim: DIM });
        assert.equal(audit.summary.activeMemDocuments, 5);
        assert.equal(audit.summary.vectorsPresent, 5);
        assert.equal(audit.summary.duplicateGroups, 2);
        assert.equal(audit.summary.suspiciousGroups, 1);
        assert.equal(audit.summary.legitimateSameContentGroups, 1);
        assert.deepEqual(audit.summary.affectedIds.sort(), [fixture.memIds[0], fixture.memIds[1]].sort());
        assert.deepEqual(audit.legitimateGroups[0].ids.sort(), [fixture.memIds[2], fixture.memIds[3]].sort());
        for (const record of audit.suspiciousGroups[0].records) {
            assert.equal(record.sourceAvailable, true, record.sourceReason);
            assert.match(record.inputHash, /^[0-9a-f]{64}$/);
        }
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof nvdb.close === 'function') nvdb.close();
        memDb.close();
    }
});

await test('repair plan de-duplicates identical inputs and refuses missing sources', () => {
    const plan = buildRepairPlan({
        storageAudit: {
            suspiciousGroups: [
                {
                    records: [
                        { id: 'a', sourceAvailable: true },
                        { id: 'b', sourceAvailable: true },
                        { id: 'c', sourceAvailable: false, sourceReason: 'work copy file missing' }
                    ]
                }
            ],
            repairRecords: new Map([
                ['a', { collection: 'storage', id: 'a', payloadString: '{"p":1}', embedText: 'same text' }],
                ['b', { collection: 'storage', id: 'b', payloadString: '{"p":2}', embedText: 'same text' }]
            ])
        },
        memoryAudit: null,
        scope: 'storage'
    });
    assert.equal(plan.items.length, 2);
    assert.equal(plan.uniqueInputs.length, 1);
    assert.equal(plan.unavailable.length, 1);
    assert.equal(plan.unavailable[0].id, 'c');
    assert.equal(plan.counts.storage, 2);
});

// ── probe: five golden chunks ────────────────────────────────────────────────

await test('probe measures both modes on exactly the five golden chunks and fails loud when fewer are present', async () => {
    const root = freshDir('probe');
    const fixture = buildSnapshot(root);
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [path.join(root, 'live')] });
    const { Database } = loadNvdb();
    const nvdb = new Database(fixture.nvdbDir);
    const coll = nvdb.getCollection('storage');
    const embedder = createEmbedClient('http://embed.test:8080');
    setProvider('deterministic');
    try {
        const ids = fixture.explicitIds;
        const probe = await probeExplicitVectors({
            explicitIds: ids,
            coll,
            storageWorkRoot: fixture.storageDir,
            guard,
            embedder,
            expectedDim: DIM
        });
        // both modes measured, one batch call and five single calls
        assert.equal(probe.inputs.length, 5);
        assert.equal(probe.batch.calls, 1);
        assert.equal(probe.single.calls, 5);
        assert.equal(probe.batch.distinctHashes, 5);
        assert.equal(probe.batch.pairwiseDistinct, true);
        assert.equal(probe.single.distinctHashes, 5);
        assert.equal(probe.single.pairwiseDistinct, true);
        assert.deepEqual(probe.storedCollisions, { batch: 0, single: 0 });
        assert.equal(probe.classification.code, 'healthy', probe.classification.verdict);
        assert.equal(probe.classification.blocksRepair, false);

        // healthy provider: every input is byte-identical across modes, cosine 1
        assert.equal(probe.comparison.equalInputs, 5);        assert.equal(probe.comparison.differingInputs, 0);
        assert.ok(probe.comparison.minCosine > 1 - 1e-9, `cosine ${probe.comparison.minCosine}`);
        for (const entry of probe.comparison.perInput) {
            assert.equal(entry.equal, true);
            assert.equal(entry.batchHash, entry.singleHash);
        }
        // stored provenance is recorded per input (no absolutePath)
        assert.equal(new Set(probe.inputs.map((i) => i.storedHash)).size, 4, 'dup-a/dup-b share one stored vector');
        // no stored collisions, so no owner re-embeds were needed
        assert.equal(probe.collisions.total, 0);
        assert.equal(probe.collisions.ownerEmbedCalls, 0);
        assert.equal(probe.classification.providerFaulty, false);
        assert.equal(probe.classification.storedOwnerCorrupt, false);

        await assert.rejects(
            () => probeExplicitVectors({ explicitIds: ids.slice(0, 4), coll, storageWorkRoot: fixture.storageDir, guard, embedder, expectedDim: DIM }),
            /exactly 5 explicitVectorIds/
        );
        // no silent sequential fallback: both capabilities are mandatory
        await assert.rejects(
            () => probeExplicitVectors({ explicitIds: ids, coll, storageWorkRoot: fixture.storageDir, guard, expectedDim: DIM, embedder: { embed: async () => basis(0) } }),
            /embedBatch\(texts\).*no sequential fallback/
        );
        await assert.rejects(
            () => probeExplicitVectors({ explicitIds: ids, coll, storageWorkRoot: fixture.storageDir, guard, expectedDim: DIM, embedder: { embedBatch: async () => [] } }),
            /must expose embed\(text\)/
        );
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof nvdb.close === 'function') nvdb.close();
    }
});

// The reported symptom: every fresh batch vector is distinct inside the batch but
// equals another stored chunk (fresh #0 == stored #1). Batch-only corruption with
// healthy sequential responses must be named as a batch mapping fault.
await test('batch-only corruption with healthy sequential responses is named a batch mapping fault', async () => {
    const root = freshDir('probe-batch-fault');
    const fixture = buildSnapshot(root);
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [path.join(root, 'live')] });
    const { Database } = loadNvdb();
    const nvdb = new Database(fixture.nvdbDir);
    const coll = nvdb.getCollection('storage');
    const storageAudit = auditStorageVectors({
        ids: Object.keys(STORAGE).map((rel) => `storage:${rel}`),
        coll,
        storageWorkRoot: fixture.storageDir,
        guard,
        expectedDim: DIM
    });
    const embedder = createEmbedClient('http://embed.test:8080');
    setProvider('deterministic');
    // Batch responses are the STORED vectors of other chunks (a response-mapping
    // fault); single responses stay healthy.
    fetchState.batchOverrides.set(storageEmbedText('notes/dup-a.md'), basis(3)); // extra-1's stored vector
    fetchState.batchOverrides.set(storageEmbedText('notes/dup-b.md'), basis(4)); // extra-2
    fetchState.batchOverrides.set(storageEmbedText('notes/solo.md'), basis(1)); // same-1/same-2
    fetchState.batchOverrides.set(storageEmbedText('notes/extra-1.md'), basis(2)); // solo
    fetchState.batchOverrides.set(storageEmbedText('notes/extra-2.md'), basis(0)); // dup-a/dup-b
    try {
        const probe = await probeExplicitVectors({
            explicitIds: fixture.explicitIds,
            coll,
            storageWorkRoot: fixture.storageDir,
            guard,
            embedder,
            expectedDim: DIM,
            storageIndex: storageAudit.vectorIndex
        });
        // distinct within the batch — exactly the "all 5 distinct" symptom
        assert.equal(probe.batch.distinctHashes, 5);
        assert.equal(probe.batch.pairwiseDistinct, true);
        assert.ok(probe.batch.storedCollisions.length >= 5, `batch collisions ${probe.batch.storedCollisions.length}`);
        // every batch vector collides with a DIFFERENT stored chunk
        const dupA = probe.batch.storedCollisions.find((c) => c.id === 'storage:notes/dup-a.md');
        assert.equal(dupA.owner.key, 'storage:notes/extra-1.md', 'display key has a single prefix');
        assert.equal(dupA.owner.collection, 'storage');
        // sequential responses are clean
        assert.equal(probe.single.storedCollisions.length, 0);
        assert.equal(probe.single.distinctHashes, 5);
        assert.equal(probe.single.errors.length, 0);
        // and the two modes disagree per input
        assert.equal(probe.comparison.equalInputs, 0);
        assert.equal(probe.comparison.differingInputs, 5);
        assert.ok(probe.comparison.minCosine < 0.999, 'different vectors, low cosine');

        assert.equal(probe.classification.code, 'batch-mapping-faulty');
        assert.equal(probe.classification.blocksRepair, true);
        assert.match(probe.classification.verdict, /batch index\/response-mapping fault/);
        // the single responses disagree with the batch, so no stored owner may be
        // blamed and no provider duplicate is claimed
        assert.equal(probe.classification.providerFaulty, false);
        assert.equal(probe.classification.storedOwnerCorrupt, false);
        assert.ok(probe.collisions.counts.modeSpecific >= 5);
        assert.equal(probe.collisions.counts.storedOwnerCorrupt, 0);
        assert.equal(probe.collisions.ownersToRepairTogether.length, 0);
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof nvdb.close === 'function') nvdb.close();
    }
});

// A shifted batch response is invisible to a distinctness check, and it then makes
// the guard refuse the correct single responses — that must still be named a batch
// fault, not a single-request fault.
await test('a batch whose vectors poison the guard downstream is classified as a batch fault', () => {
    const batch = {
        mode: 'batch',
        records: [],
        presentVectors: 0,
        distinctHashes: 0,
        pairwiseDistinct: true,
        duplicateGroups: [],
        storedCollisions: [],
        allDimOk: true,
        allFinite: true,
        allNonzero: true,
        error: 'EmbeddingIntegrityError: embedBatch (input 2 of 5): byte-identical embedding for a different input'
    };
    const single = {
        mode: 'single',
        records: [],
        presentVectors: 0,
        distinctHashes: 0,
        pairwiseDistinct: true,
        duplicateGroups: [],
        storedCollisions: [],
        allDimOk: true,
        allFinite: true,
        allNonzero: true,
        errors: [1, 2, 3, 4, 5].map((n) => ({ id: `storage:x#${n}`, error: 'EmbeddingIntegrityError: byte-identical embedding for a different input' }))
    };
    const comparison = { equalInputs: 0, differingInputs: 0, perInput: [], minCosine: null, meanCosine: null };

    const echoed = classifyProbe({ batchBad: true, singleBad: true, unstable: false, batch, single, comparison });
    assert.equal(echoed.code, 'batch-mapping-faulty');
    assert.match(echoed.verdict, /refused the batch's own vectors/);

    // a single-mode fault ON TOP of the batch fault is genuinely both modes
    const both = classifyProbe({
        batchBad: true,
        singleBad: true,
        unstable: false,
        batch,
        single: { ...single, presentVectors: 1, storedCollisions: [{ id: 'storage:x#1', owner: { id: 'storage:y' } }] },
        comparison
    });
    assert.equal(both.code, 'both-modes-faulty');
});

// ── transient transport failures ────────────────────────────────────────────

await test('corrupt batch AND corrupt single responses are named a single-request fault (both modes)', async () => {
    const root = freshDir('probe-both-fault');
    const fixture = buildSnapshot(root);
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [path.join(root, 'live')] });
    const { Database } = loadNvdb();
    const nvdb = new Database(fixture.nvdbDir);
    const coll = nvdb.getCollection('storage');
    const storageAudit = auditStorageVectors({
        ids: Object.keys(STORAGE).map((rel) => `storage:${rel}`),
        coll,
        storageWorkRoot: fixture.storageDir,
        guard,
        expectedDim: DIM
    });
    const embedder = createEmbedClient('http://embed.test:8080');
    setProvider('deterministic');
    // Same wrong vector in BOTH modes for every input: stored extra-1's vector for
    // all five inputs (distinct-input duplicate, caught by nothing in-run).
    const texts = Object.keys(STORAGE).map((rel) => storageEmbedText(rel));
    for (const text of texts) fetchState.overrides.set(text, basis(3));
    try {
        const probe = await probeExplicitVectors({
            explicitIds: fixture.explicitIds,
            coll,
            storageWorkRoot: fixture.storageDir,
            guard,
            embedder,
            expectedDim: DIM,
            storageIndex: storageAudit.vectorIndex
        });
        // the batch is rejected by the shared guard, and every single call with it
        assert.equal(probe.batch.error !== null || probe.batch.duplicateGroups.length > 0, true);
        assert.ok(probe.single.errors.length > 0 || probe.single.storedCollisions.length > 0 || probe.single.duplicateGroups.length > 0);
        assert.equal(probe.classification.code, 'both-modes-faulty');
        assert.equal(probe.classification.blocksRepair, true);
        assert.match(probe.classification.verdict, /single-request runtime\/cache fault/);
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof nvdb.close === 'function') nvdb.close();
    }
});

// ── end-to-end: default audit/probe writes nothing ───────────────────────────

await test('default run is audit/probe only — no database writes, report written', async () => {
    const root = freshDir('audit-run');
    const fixture = buildSnapshot(root);
    const before = { nvdb: hashDir(fixture.nvdbDir), memory: hashFile(path.join(fixture.memoryDir, 'data.jsonl')), scan: hashFile(path.join(fixture.nvdbDir, 'scan-index.json')) };
    setProvider('deterministic');

    const { report, files } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath
    });

    assert.equal(report.mode, 'audit');
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.probe.classification.code, 'healthy', report.probe.classification.verdict);
    assert.equal(report.probe.batch.calls, 1);
    assert.equal(report.probe.single.calls, 5);
    assert.equal(report.probe.comparison.equalInputs, 5);
    assert.equal(report.repairs.inserted.length, 0);
    assert.equal(report.audit.storage.suspiciousGroups, 1);
    assert.equal(report.audit.memory.suspiciousGroups, 1);

    assert.equal(hashDir(fixture.nvdbDir), before.nvdb, 'audit mode must not touch the nVDB work copy');
    assert.equal(hashFile(path.join(fixture.memoryDir, 'data.jsonl')), before.memory, 'audit mode must not touch the memory nDB');
    assert.equal(hashFile(path.join(fixture.nvdbDir, 'scan-index.json')), before.scan);

    assert.equal(files.length, 1);
    assert.ok(fs.existsSync(files[0]));
    const written = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    assert.equal(written.tool, TOOL);
    assert.equal(written.version, REPORT_VERSION);
    assert.equal(written.mode, 'audit');
    assert.ok(written.audit && written.probe && written.repairs);
    const summary = summarize(report);
    assert.match(summary, /probe\s+healthy/);
    assert.match(summary, /batch\s+5\/5 distinct/);
    assert.match(summary, /single\s+5\/5 distinct/);
    assert.match(summary, /compare\s+equal=5\/5/);
    assert.ok(!fs.existsSync(path.join(root, 'scratch', `repair-${process.pid}`)), 'scratch copy must be cleaned up');
});

// ── end-to-end: apply ────────────────────────────────────────────────────────

await test('apply repairs suspicious records only after distinct valid outputs are proven', async () => {
    const root = freshDir('apply-run');
    const fixture = buildSnapshot(root);
    const memoryBefore = hashFile(path.join(fixture.memoryDir, 'data.jsonl'));
    const scanBefore = hashFile(path.join(fixture.nvdbDir, 'scan-index.json'));
    const sameBefore = readColl(fixture.nvdbDir, 'storage', ['storage:notes/same-1.md', 'storage:notes/same-2.md']);
    setProvider('deterministic');

    const { report, files } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        apply: true
    });

    assert.equal(report.mode, 'apply');
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.repairs.planned, 4);
    assert.equal(report.repairs.uniqueInputs, 4);
    assert.deepEqual(
        report.repairs.inserted.map((i) => i.id).sort(),
        ['storage:notes/dup-a.md', 'storage:notes/dup-b.md', ...fixture.memIds.slice(0, 2)].sort()
    );
    assert.equal(report.repairs.validation.crossInputDuplicates, 0);
    assert.equal(report.repairs.collisions.detected, 0);
    assert.equal(report.verification.ok, true);
    assert.equal(report.verification.storageSuspiciousGroups, 0);
    assert.equal(report.verification.memorySuspiciousGroups, 0);
    assert.equal(report.probeAfter.classification.code, 'healthy');

    // two timestamped reports: before and after
    assert.equal(files.length, 2);
    assert.match(files[0], /-before\.json$/);
    assert.match(files[1], /-after\.json$/);
    for (const file of files) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(parsed.tool, TOOL);
    }

    // the repaired vectors are distinct now
    const after = readColl(fixture.nvdbDir, 'storage', ['storage:notes/dup-a.md', 'storage:notes/dup-b.md', 'storage:notes/same-1.md', 'storage:notes/same-2.md']);
    const dupAHash = vectorHashOf(after['storage:notes/dup-a.md'].vector);
    const dupBHash = vectorHashOf(after['storage:notes/dup-b.md'].vector);
    assert.notEqual(dupAHash, dupBHash);

    // same-content duplicates were left alone
    assert.deepEqual(after['storage:notes/same-1.md'].vector, sameBefore['storage:notes/same-1.md'].vector);
    assert.deepEqual(after['storage:notes/same-2.md'].vector, sameBefore['storage:notes/same-2.md'].vector);

    // payloads preserved verbatim
    assert.equal(JSON.parse(after['storage:notes/dup-a.md'].payload).contentHash, 'h-dup-a');
    assert.equal(JSON.parse(after['storage:notes/dup-b.md'].payload).contentHash, 'h-dup-b');

    // memory vectors distinct, payload preserved, nDB + scan-index untouched
    const memAfter = readColl(fixture.nvdbDir, 'memory', fixture.memIds);
    assert.notEqual(vectorHashOf(memAfter[fixture.memIds[0]].vector), vectorHashOf(memAfter[fixture.memIds[1]].vector));
    assert.deepEqual(JSON.parse(memAfter[fixture.memIds[0]].payload), { id: 101 });
    assert.equal(hashFile(path.join(fixture.memoryDir, 'data.jsonl')), memoryBefore, 'memory nDB content/status must be untouched');
    assert.equal(hashFile(path.join(fixture.nvdbDir, 'scan-index.json')), scanBefore, 'scan-index content hashes must be untouched');
});

await test('a provider that repeats one vector for different inputs refuses every write', async () => {
    const root = freshDir('apply-duplicate');
    const fixture = buildSnapshot(root);
    const before = { nvdb: hashDir(fixture.nvdbDir), memory: hashFile(path.join(fixture.memoryDir, 'data.jsonl')) };
    setProvider('duplicate');

    const { report } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        apply: true
    });

    assert.equal(report.ok, false);
    assert.equal(report.probe.classification.code, 'both-modes-faulty');
    assert.equal(report.probe.classification.blocksRepair, true);
    assert.match(report.repairs.refusal, /probe failed — refusing every write/);
    assert.equal(report.repairs.inserted.length, 0);

    assert.equal(hashDir(fixture.nvdbDir), before.nvdb, 'a refused repair must leave the work copy untouched');
    assert.equal(hashFile(path.join(fixture.memoryDir, 'data.jsonl')), before.memory);
});

await test('a duplicate produced during repair embedding is refused before the first insert', async () => {
    const root = freshDir('apply-dup-late');
    const fixture = buildSnapshot(root);
    const before = hashDir(fixture.nvdbDir);
    setProvider('deterministic');

    const embedder = createEmbedClient('http://embed.test:8080');
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, init) => {
        calls++;
        // the probe (6 calls: 1 batch + 5 single) is real and distinct; every
        // later request answers one constant vector for all inputs.
        if (calls <= 6) return realFetch(url, init);
        const body = JSON.parse(init.body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ data: inputs.map((_, index) => ({ index, embedding: [...DUP_VEC] })) }),
            text: async () => ''
        };
    };
    try {
        const { report } = await runRepair({
            snapshot: root,
            embedder,
            goldenPath: fixture.goldenPath,
            apply: true,
            batchSize: 4
        });
        assert.equal(report.ok, false);
        assert.equal(report.probe.pairwiseDistinct, true, 'the probe itself succeeded');
        assert.match(report.repairs.refusal, /byte-identical|different inputs/);
        assert.equal(report.repairs.inserted.length, 0);
        assert.equal(hashDir(fixture.nvdbDir), before, 'no write may happen after a duplicate embedding');
    } finally {
        globalThis.fetch = realFetch;
    }
});

await test('storage-only and memory-only scope narrow the audit and the repair set', async () => {
    const root = freshDir('scope');
    const fixture = buildSnapshot(root);
    setProvider('deterministic');

    const storageOnly = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        storageOnly: true
    });
    assert.equal(storageOnly.report.options.scope, 'storage');
    assert.equal(storageOnly.report.audit.memory.skipped, true);
    assert.equal(storageOnly.report.audit.storage.suspiciousGroups, 1);
    assert.equal(storageOnly.report.probe.classification.code, 'healthy');

    const memoryOnly = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        memoryOnly: true
    });
    assert.equal(memoryOnly.report.options.scope, 'memory');
    assert.equal(memoryOnly.report.audit.storage.skipped, true);
    assert.equal(memoryOnly.report.audit.memory.suspiciousGroups, 1);
    assert.equal(memoryOnly.report.probe.skipped, true);
});

// ── validation helpers and CLI ───────────────────────────────────────────────

await test('validateEmbeddingSet rejects wrong dims, zero vectors and cross-input duplicates', () => {
    const a = { label: 'a', inputHash: sha256Text('a'), vector: basis(0) };
    const b = { label: 'b', inputHash: sha256Text('b'), vector: basis(1) };
    const summary = validateEmbeddingSet([a, b], DIM);
    assert.equal(summary.count, 2);
    assert.equal(summary.distinctVectorHashes, 2);
    assert.equal(summary.crossInputDuplicates, 0);
    assert.equal(summary.sharedInputVectors, 0);

    // identical input + identical vector stays legitimate
    const c = { label: 'c', inputHash: sha256Text('a'), vector: basis(0) };
    const shared = validateEmbeddingSet([{ label: 'a2', inputHash: sha256Text('a'), vector: basis(0) }, c], DIM);
    assert.equal(shared.crossInputDuplicates, 0);
    assert.equal(shared.sharedInputVectors, 1);

    assert.throws(() => validateEmbeddingSet([a, { label: 'd', inputHash: sha256Text('d'), vector: basis(0) }], DIM), /byte-identical embedding for different inputs/);
    assert.throws(() => validateEmbeddingSet([{ label: 'e', inputHash: sha256Text('e'), vector: basis(0).slice(0, 4) }], DIM), /dim 4 — expected 8/);
    assert.throws(() => validateEmbeddingSet([{ label: 'f', inputHash: sha256Text('f'), vector: new Array(DIM).fill(0) }], DIM), /zero norm/);
    assert.throws(() => validateEmbeddingSet([{ label: 'g', inputHash: sha256Text('g'), vector: [1, 2, NaN, 0, 0, 0, 0, 1] }], DIM), /not a finite number/);
});

// ── stored-population collisions (2026-11-17 residual root cause) ────────────

// The embed input for a memory document, exactly as production builds it.
function memoryInputFor(description, data) {
    return memoryInputText({ _id: 'mem_x', description, data });
}

await test('a fresh vector identical to a stored vector for a different input is refused before any write', async () => {
    const root = freshDir('collide-refuse');
    const fixture = buildSnapshot(root);
    const before = { nvdb: hashDir(fixture.nvdbDir), memory: hashFile(path.join(fixture.memoryDir, 'data.jsonl')) };
    setProvider('deterministic');
    // mem 101 (a suspicious record) is given the vector of the legitimate twin pair
    // (mem 103/104) — a real provider duplicate across requests. Every in-run
    // check passes: the repair set stays 215/215 distinct.
    fetchState.overrides.set(memoryInputFor('first memory about vectors', { k: 'v' }), basis(6));

    const { report } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        apply: true,
        retryDelayMs: 1
    });

    assert.equal(report.ok, false);
    assert.equal(report.repairs.validation.crossInputDuplicates, 0, 'the in-run set is clean — that is why the guard alone misses it');
    assert.equal(report.repairs.collisions.detected, 2, 'one per colliding owner (the legitimate twin pair)');
    assert.equal(report.repairs.collisions.resolvedByRetry, 0);
    assert.equal(report.repairs.collisions.remaining.length, 2);
    assert.equal(report.repairs.collisions.remaining[0].id, fixture.memIds[0]);
    assert.equal(report.repairs.collisions.remaining[0].owner.collection, 'memory');
    assert.ok([fixture.memIds[2], fixture.memIds[3]].includes(report.repairs.collisions.remaining[0].owner.id));
    assert.match(report.repairs.collisions.remaining[0].owner.inputHash, /^[0-9a-f]{64}$/);
    assert.notEqual(report.repairs.collisions.remaining[0].owner.inputHash, report.repairs.collisions.remaining[0].inputHash);
    assert.match(report.repairs.refusal, /byte-identical to a vector already stored for a different input/);
    assert.equal(report.repairs.inserted.length, 0);

    assert.equal(hashDir(fixture.nvdbDir), before.nvdb, 'a refused repair must leave the work copy untouched');
    assert.equal(hashFile(path.join(fixture.memoryDir, 'data.jsonl')), before.memory);
});

await test('one recorded re-embed retry resolves an intermittent provider duplicate', async () => {
    const root = freshDir('collide-retry');
    const fixture = buildSnapshot(root);
    setProvider('deterministic');
    // first repair embedding of mem 101 collides with the twin pair's stored
    // vector; the retry returns the healthy vector.
    fetchState.overrideOnce.set(memoryInputFor('first memory about vectors', { k: 'v' }), basis(6));

    const { report } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        apply: true,
        retryDelayMs: 1
    });

    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.repairs.collisions.detected, 2);
    assert.equal(report.repairs.collisions.resolvedByRetry, 2);
    assert.equal(report.repairs.reembedRetries, 1, 'one unique input re-embedded');
    assert.equal(report.repairs.collisions.remaining.length, 0);
    assert.equal(report.repairs.inserted.length, 4);
    assert.equal(report.verification.ok, true);
});

await test('a collision with a record this run replaces is allowed', async () => {
    const root = freshDir('collide-replaced');
    const fixture = buildSnapshot(root);
    setProvider('deterministic');
    // mem 101 gets the OLD damaged vector shared with mem 102 — both are being
    // replaced, so the old vector disappears and nothing is left duplicated.
    fetchState.overrides.set(memoryInputFor('first memory about vectors', { k: 'v' }), basis(5));

    const { report } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        apply: true,
        retryDelayMs: 1
    });

    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.repairs.collisions.detected, 0);
    assert.ok(report.repairs.collisions.allowedWithReplaced >= 1, 'the replaced owner must be reported as allowed');
    assert.equal(report.verification.ok, true);
    assert.equal(report.verification.memorySuspiciousGroups, 0);
});

await test('stored-owner identity for storage chunks is read from the work copy, and identical inputs are legitimate', () => {
    const root = freshDir('collide-identity');
    const fixture = buildSnapshot(root);
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [path.join(root, 'live')] });
    const { Database } = loadNvdb();
    const db = new Database(fixture.nvdbDir);
    const coll = db.getCollection('storage');
    try {
        const ids = Object.keys(STORAGE).map((rel) => `storage:${rel}`);
        const audit = auditStorageVectors({ ids, coll, storageWorkRoot: fixture.storageDir, guard, expectedDim: DIM });

        // a brand-new input whose vector equals same-1's stored vector: collision
        const foreign = findStoredCollisions({
            entries: [{ collection: 'memory', id: 'mem_new', key: 'memory:mem_new', inputHash: sha256Text('a brand new input'), vector: basis(1) }],
            storageIndex: audit.vectorIndex,
            storageWorkRoot: fixture.storageDir,
            guard
        });
        assert.equal(foreign.length, 2, 'both same-content owners are reported');
        assert.deepEqual(foreign.map((c) => c.owner.id).sort(), ['storage:notes/same-1.md', 'storage:notes/same-2.md']);
        assert.deepEqual(foreign.map((c) => c.owner.key).sort(), ['storage:notes/same-1.md', 'storage:notes/same-2.md'], 'owner key carries exactly one collection prefix');
        assert.match(foreign[0].owner.inputHash, /^[0-9a-f]{64}$/);

        // the very same input as same-1: legitimate, never a collision
        const sameInputText = storageEmbedText('notes/same-1.md');
        const legit = findStoredCollisions({
            entries: [{ collection: 'memory', id: 'mem_dup', key: 'memory:mem_dup', inputHash: sha256Text(sameInputText), vector: basis(1) }],
            storageIndex: audit.vectorIndex,
            storageWorkRoot: fixture.storageDir,
            guard
        });
        assert.equal(legit.length, 0);

        // identity of a storage owner comes from the work copy, never absolutePath
        const owner = audit.vectorIndex.get(vectorHashOf(basis(1)))[0];
        assert.equal(storedOwnerInputHash({ collection: 'storage', owner, storageWorkRoot: fixture.storageDir, guard }), sha256Text(sameInputText));
        assert.equal(storedOwnerInputText({ collection: 'storage', owner, storageWorkRoot: fixture.storageDir, guard }).text, sameInputText);

        // memory owners carry their embed input from the audit index
        assert.deepEqual(storedOwnerInputText({ collection: 'memory', owner: { _id: 'mem_x', inputText: 'memory text' } }), { available: true, text: 'memory text' });
        assert.equal(storedOwnerInputText({ collection: 'memory', owner: { _id: 'mem_x' } }).available, false);
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof db.close === 'function') db.close();
    }
});

// ── transient transport failures ────────────────────────────────────────────

function setStoredVector(nvdbDir, collection, id, vector) {
    const { Database } = loadNvdb();
    const db = new Database(nvdbDir);
    const coll = db.getCollection(collection);
    try {
        const record = coll.get(id);
        if (!record) throw new Error(`setStoredVector: ${id} not present`);
        coll.insert(id, vector, record.payload);
        coll.flush();
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof db.close === 'function') db.close();
    }
}

// The real-lab situation: both modes agree and are internally distinct, but each
// fresh vector equals one OTHER stored chunk. If the owner's own input no longer
// produces that vector, the owner's stored value is the stale one.
await test('a collision whose owner no longer reproduces its stored vector is stored-owner-corrupt', async () => {
    const root = freshDir('probe-owner-corrupt');
    const fixture = buildSnapshot(root);
    // old corruption: solo's stored vector is dup-a's correct fresh vector
    setStoredVector(fixture.nvdbDir, 'storage', 'storage:notes/solo.md', vectorFor(storageEmbedText('notes/dup-a.md')));
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [path.join(root, 'live')] });
    const { Database } = loadNvdb();
    const nvdb = new Database(fixture.nvdbDir);
    const coll = nvdb.getCollection('storage');
    const storageAudit = auditStorageVectors({
        ids: Object.keys(STORAGE).map((rel) => `storage:${rel}`),
        coll,
        storageWorkRoot: fixture.storageDir,
        guard,
        expectedDim: DIM
    });
    const embedder = createEmbedClient('http://embed.test:8080');
    setProvider('deterministic');
    try {
        const probe = await probeExplicitVectors({
            explicitIds: fixture.explicitIds,
            coll,
            storageWorkRoot: fixture.storageDir,
            guard,
            embedder,
            expectedDim: DIM,
            storageIndex: storageAudit.vectorIndex
        });
        // deterministic and internally clean in both modes
        assert.equal(probe.batch.distinctHashes, 5);
        assert.equal(probe.single.distinctHashes, 5);
        assert.equal(probe.comparison.equalInputs, 5);
        // exactly one colliding candidate, in both modes, against solo
        assert.deepEqual(probe.storedCollisions, { batch: 1, single: 1 });
        assert.equal(probe.collisions.ownerEmbedCalls, 1);
        for (const pair of probe.collisions.pairs) {
            assert.equal(pair.candidateId, 'storage:notes/dup-a.md');
            assert.equal(pair.ownerKey, 'storage:notes/solo.md', 'normalized display key');
            assert.equal(pair.modesAgree, true);
            assert.equal(pair.ownerStoredHash, pair.candidateFreshHash, 'stored owner still holds the colliding vector');
            assert.equal(pair.freshEqual, false, 'the owner no longer reproduces that vector');
            assert.ok(pair.cosineFresh < 0.999, `cosine ${pair.cosineFresh}`);
            assert.equal(pair.finding, 'stored-owner-corrupt');
        }
        const owner = probe.collisions.byOwner[0];
        assert.equal(owner.ownerSelfConsistent, false);
        assert.notEqual(owner.freshHash, owner.storedHash);
        assert.deepEqual(probe.collisions.ownersToRepairTogether, ['storage:notes/solo.md']);

        assert.equal(probe.classification.code, 'stored-owner-corrupt');
        assert.equal(probe.classification.blocksRepair, false, 'stored owner damage is repairable, not a provider failure');
        assert.equal(probe.classification.repairable, true);
        assert.equal(probe.classification.providerFaulty, false);
        assert.equal(probe.classification.storedOwnerCorrupt, true);
        assert.match(probe.classification.verdict, /do not blame the current provider/);
        assert.match(probe.classification.verdict, /storage:notes\/solo\.md/);
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof nvdb.close === 'function') nvdb.close();
    }
});

// The opposite adjudication: the owner DOES reproduce the colliding vector, so the
// current provider is genuinely returning one vector for two different inputs.
await test('a collision whose owner reproduces the vector is a current provider fault', async () => {
    const root = freshDir('probe-provider-faulty');
    const fixture = buildSnapshot(root);
    // A fresh provider duplicate against owners that hold the same vector: a vector
    // unique to this test, so no earlier guarded mapping can interfere.
    const OWNER_VEC = vectorFor('probe-owner-vector-not-used-elsewhere');
    setStoredVector(fixture.nvdbDir, 'storage', 'storage:notes/same-1.md', OWNER_VEC);
    setStoredVector(fixture.nvdbDir, 'storage', 'storage:notes/same-2.md', OWNER_VEC);
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [path.join(root, 'live')] });
    const { Database } = loadNvdb();
    const nvdb = new Database(fixture.nvdbDir);
    const coll = nvdb.getCollection('storage');
    const storageAudit = auditStorageVectors({
        ids: Object.keys(STORAGE).map((rel) => `storage:${rel}`),
        coll,
        storageWorkRoot: fixture.storageDir,
        guard,
        expectedDim: DIM
    });
    const embedder = createEmbedClient('http://embed.test:8080');
    setProvider('deterministic');
    fetchState.overrides.set(storageEmbedText('notes/dup-a.md'), OWNER_VEC);
    fetchState.overrides.set(storageEmbedText('notes/same-1.md'), OWNER_VEC);
    fetchState.overrides.set(storageEmbedText('notes/same-2.md'), OWNER_VEC);
    try {
        const probe = await probeExplicitVectors({
            explicitIds: fixture.explicitIds,
            coll,
            storageWorkRoot: fixture.storageDir,
            guard,
            embedder,
            expectedDim: DIM,
            storageIndex: storageAudit.vectorIndex
        });
        assert.deepEqual(probe.storedCollisions, { batch: 2, single: 2 }, 'both same-content owners');
        // the guard refuses to re-embed an owner onto the same vector for another input
        assert.equal(probe.collisions.counts.currentProviderFaulty, 4);
        assert.equal(probe.collisions.counts.storedOwnerCorrupt, 0);
        for (const pair of probe.collisions.pairs) {
            assert.equal(pair.modesAgree, true);
            assert.equal(pair.ownerAvailable, false);
            assert.equal(pair.ownerGuardRejected, true);
            assert.equal(pair.finding, 'current-provider-faulty');
            assert.match(pair.note, /byte-identical duplicate/);
            assert.ok(['storage:notes/same-1.md', 'storage:notes/same-2.md'].includes(pair.ownerKey));
        }
        assert.equal(probe.classification.code, 'current-provider-faulty');
        assert.equal(probe.classification.blocksRepair, true);
        assert.equal(probe.classification.providerFaulty, true);
        assert.equal(probe.classification.storedOwnerCorrupt, false);
        assert.match(probe.classification.verdict, /CURRENT provider returns a byte-identical vector/);
        assert.deepEqual(probe.collisions.ownersToRepairTogether, []);
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof nvdb.close === 'function') nvdb.close();
    }
});

// Without the guard in the way, the fresh-vs-fresh comparison itself must decide.
await test('fresh candidate vs fresh owner decides the verdict (fake embedder, no guard)', async () => {
    const root = freshDir('probe-fake-owner');
    const fixture = buildSnapshot(root);
    const guard = createRepairGuard({ workRoot: fixture.work, referenceRoot: fixture.referenceDir, liveRoots: [path.join(root, 'live')] });
    const { Database } = loadNvdb();
    const nvdb = new Database(fixture.nvdbDir);
    const coll = nvdb.getCollection('storage');
    const storageAudit = auditStorageVectors({
        ids: Object.keys(STORAGE).map((rel) => `storage:${rel}`),
        coll,
        storageWorkRoot: fixture.storageDir,
        guard,
        expectedDim: DIM
    });
    setProvider('deterministic');
    // same-1 (an owner, not one of the five) re-embeds to the same fresh vector as
    // dup-a: an unambiguous current-provider duplicate.
    const fake = {
        async embedBatch(texts) {
            return texts.map((text) => (text === storageEmbedText('notes/dup-a.md') ? basis(1) : vectorFor(text)));
        },
        async embed(text) {
            if (text === storageEmbedText('notes/dup-a.md')) return basis(1);
            if (text === storageEmbedText('notes/same-1.md')) return basis(1);
            return vectorFor(text);
        }
    };
    try {
        const probe = await probeExplicitVectors({
            explicitIds: fixture.explicitIds,
            coll,
            storageWorkRoot: fixture.storageDir,
            guard,
            embedder: fake,
            expectedDim: DIM,
            storageIndex: storageAudit.vectorIndex
        });
        assert.equal(probe.collisions.ownerEmbedCalls, 2);
        const sameOne = probe.collisions.pairs.find((p) => p.ownerKey === 'storage:notes/same-1.md');
        assert.equal(sameOne.ownerAvailable, true);
        assert.equal(sameOne.freshEqual, true);
        assert.ok(sameOne.cosineFresh > 1 - 1e-9);
        assert.equal(sameOne.finding, 'current-provider-faulty');
        assert.equal(probe.classification.code, 'current-provider-faulty');
    } finally {
        if (typeof coll.close === 'function') coll.close();
        if (typeof nvdb.close === 'function') nvdb.close();
    }
});

await test('apply repairs the candidate AND the probe-adjudicated corrupt owner together', async () => {
    const root = freshDir('apply-owner');
    const fixture = buildSnapshot(root);
    // old corruption: solo holds dup-a's correct fresh vector and is in NO
    // suspicious audit group (its stored vector is unique in the collection)
    setStoredVector(fixture.nvdbDir, 'storage', 'storage:notes/solo.md', vectorFor(storageEmbedText('notes/dup-a.md')));
    const memoryBefore = hashFile(path.join(fixture.memoryDir, 'data.jsonl'));
    const scanBefore = hashFile(path.join(fixture.nvdbDir, 'scan-index.json'));
    setProvider('deterministic');

    const { report, files } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        apply: true,
        retryDelayMs: 1
    });

    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.probe.classification.code, 'stored-owner-corrupt');
    assert.deepEqual(report.repairs.ownersToRepairTogether, ['storage:notes/solo.md']);
    assert.equal(report.repairs.ownersPlanned, 1);
    assert.equal(report.repairs.ownerItems, 1);
    // 4 suspicious records (2 storage + 2 memory) + the probe-adjudicated owner
    assert.equal(report.repairs.planned, 5);
    assert.deepEqual(
        report.repairs.inserted.map((i) => i.id).sort(),
        ['storage:notes/dup-a.md', 'storage:notes/dup-b.md', 'storage:notes/solo.md', ...fixture.memIds.slice(0, 2)].sort()
    );

    // the owner's old corruption is gone and both sides now hold their own vectors
    const after = readColl(fixture.nvdbDir, 'storage', ['storage:notes/dup-a.md', 'storage:notes/dup-b.md', 'storage:notes/solo.md']);
    assert.equal(vectorHashOf(after['storage:notes/dup-a.md'].vector), vectorHashOf(vectorFor(storageEmbedText('notes/dup-a.md'))));
    assert.equal(vectorHashOf(after['storage:notes/solo.md'].vector), vectorHashOf(vectorFor(storageEmbedText('notes/solo.md'))));
    assert.notEqual(vectorHashOf(after['storage:notes/solo.md'].vector), vectorHashOf(vectorFor(storageEmbedText('notes/dup-a.md'))));
    // original payloads preserved on both sides
    assert.equal(JSON.parse(after['storage:notes/solo.md'].payload).contentHash, 'h-solo');
    assert.equal(JSON.parse(after['storage:notes/dup-a.md'].payload).contentHash, 'h-dup-a');

    // zero suspicious groups remain and no current-provider fault post-repair
    assert.equal(report.verification.ok, true);
    assert.equal(report.verification.storageSuspiciousGroups, 0);
    assert.equal(report.verification.memorySuspiciousGroups, 0);
    assert.equal(report.probeAfter.classification.providerFaulty, false);
    assert.equal(report.probeAfter.collisions.total, 0, 'no residual stored collision after repairing the owner too');
    assert.equal(report.probeAfter.classification.code, 'healthy');

    assert.equal(hashFile(path.join(fixture.memoryDir, 'data.jsonl')), memoryBefore);
    assert.equal(hashFile(path.join(fixture.nvdbDir, 'scan-index.json')), scanBefore);
    assert.equal(files.length, 2);
});

await test('an audit reports stored-owner damage as old damage, never as a current provider failure', async () => {
    const root = freshDir('audit-owner');
    const fixture = buildSnapshot(root);
    setStoredVector(fixture.nvdbDir, 'storage', 'storage:notes/solo.md', vectorFor(storageEmbedText('notes/dup-a.md')));
    const before = hashDir(fixture.nvdbDir);
    setProvider('deterministic');

    const { report } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath
    });

    assert.equal(report.mode, 'audit');
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.probe.classification.code, 'stored-owner-corrupt');
    assert.equal(report.probe.classification.blocksRepair, false);
    assert.equal(report.probe.classification.providerFaulty, false);
    assert.ok(report.warnings.some((w) => /stored-owner-corrupt — .*old stored damage \(not a current provider fault\)/.test(w)), JSON.stringify(report.warnings));
    assert.ok(!report.errors.some((e) => /current-provider-faulty/.test(JSON.stringify(e))));
    assert.equal(hashDir(fixture.nvdbDir), before, 'an audit never writes');
});

await test('apply still refuses when the probe finds a current provider fault', async () => {
    const root = freshDir('apply-provider-fault');
    const fixture = buildSnapshot(root);
    const OWNER_VEC = vectorFor('apply-provider-fault-unique-owner-vector');
    setStoredVector(fixture.nvdbDir, 'storage', 'storage:notes/same-1.md', OWNER_VEC);
    setStoredVector(fixture.nvdbDir, 'storage', 'storage:notes/same-2.md', OWNER_VEC);
    const before = hashDir(fixture.nvdbDir);
    setProvider('deterministic');
    fetchState.overrides.set(storageEmbedText('notes/dup-a.md'), OWNER_VEC);
    fetchState.overrides.set(storageEmbedText('notes/same-1.md'), OWNER_VEC);
    fetchState.overrides.set(storageEmbedText('notes/same-2.md'), OWNER_VEC);

    const { report } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        apply: true,
        retryDelayMs: 1
    });

    assert.equal(report.ok, false);
    assert.equal(report.probe.classification.code, 'current-provider-faulty');
    assert.equal(report.probe.classification.blocksRepair, true);
    assert.match(report.repairs.refusal, /probe failed — refusing every write/);
    assert.equal(report.repairs.inserted.length, 0);
    assert.equal(hashDir(fixture.nvdbDir), before, 'a provider fault must leave the work copy untouched');
});

await test('one transient fetch failure is retried and recorded instead of aborting the run', async () => {
    const root = freshDir('transient');
    const fixture = buildSnapshot(root);
    setProvider('deterministic');
    fetchState.failAfterCalls = 0;
    fetchState.failuresLeft = 1; // the first call fails once, the retry succeeds

    const { report } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        retryDelayMs: 1
    });

    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.embed.retries, 1);
    assert.equal(report.embed.recovered, 1);
    assert.equal(report.embed.transientFailures.length, 1);
    assert.equal(report.probe.classification.code, 'healthy');
});

await test('a post-repair probe network failure does not unverify a proven repair', async () => {
    const root = freshDir('post-probe-fail');
    const fixture = buildSnapshot(root);
    setProvider('deterministic');
    // calls: 1 batch + 5 single = the probe, 7 = repair embedding, 8+ = post-repair probe (fails twice)
    fetchState.failAfterCalls = 7;
    fetchState.failuresLeft = 2;

    const { report, files } = await runRepair({
        snapshot: root,
        embedder: createEmbedClient('http://embed.test:8080'),
        goldenPath: fixture.goldenPath,
        apply: true,
        retryDelayMs: 1
    });

    assert.equal(report.verification.ok, true);
    assert.equal(report.repairs.inserted.length, 4);
    // the post-repair probe's batch request failed twice (one recorded retry); its
    // single calls were clean, so the diagnostic says "batch request failed"
    assert.equal(report.probeAfter.classification.code, 'batch-mapping-faulty');
    assert.equal(report.ok, true, 'the re-audit is the authority; the supplementary probe must not flip the verdict');
    assert.equal(report.embed.retries, 1);
    assert.ok(report.warnings.some((w) => /post-repair probe: batch-mapping-faulty/.test(w)));
    assert.equal(files.length, 2);
});

await test('wrapRepairEmbedder retries the batch arm exactly once and never a permanent failure', async () => {
    let calls = 0;
    const flaky = {
        async embedBatch(texts) {
            calls++;
            if (calls === 1) throw new TypeError('fetch failed');
            return texts.map((text) => vectorFor(text));
        }
    };
    const wrapped = wrapRepairEmbedder(flaky, { retryDelayMs: 1 });
    const vectors = await wrapped.embedBatch(['a', 'b'], { background: true });
    assert.equal(vectors.length, 2);
    assert.equal(calls, 2);
    assert.equal(wrapped.stats.retries, 1);
    assert.equal(wrapped.stats.recovered, 1);

    let permanentCalls = 0;
    const broken = { async embedBatch() { permanentCalls++; throw new TypeError('fetch failed'); } };
    await assert.rejects(() => wrapRepairEmbedder(broken, { retryDelayMs: 1 }).embedBatch(['a']), /fetch failed/);
    assert.equal(permanentCalls, 2, 'one retry, then the error surfaces');

    let fatalCalls = 0;
    const fatal = { async embedBatch() { fatalCalls++; throw new Error('HTTP 500: boom'); } };
    await assert.rejects(() => wrapRepairEmbedder(fatal, { retryDelayMs: 1 }).embedBatch(['a']), /HTTP 500/);
    assert.equal(fatalCalls, 1, 'a non-transient error is never retried');
});

await test('cosineSimilarity is exact for identical, orthogonal and opposite vectors', () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.equal(cosineSimilarity([0, 0], [1, 0]), null);
    assert.throws(() => cosineSimilarity([1, 0], [1, 0, 0]), /dimension mismatch/);
    assert.throws(() => cosineSimilarity([1, Number.NaN], [1, 1]), /non-finite/);
});

await test('CLI parses the documented flags and rejects conflicts', () => {    const args = parseArgs(['--snapshot', 'D:\\lab\\x', '--apply', '--storage-only']);
    assert.equal(args.snapshot, 'D:\\lab\\x');
    assert.equal(args.apply, true);
    assert.equal(args.storageOnly, true);
    assert.equal(parseArgs(['--snapshot=D:\\lab\\y']).memoryOnly, false);
    assert.throws(() => parseArgs([]), /missing --snapshot/);
    assert.throws(() => parseArgs(['--snapshot', 'x', '--storage-only', '--memory-only']), /mutually exclusive/);
    assert.throws(() => parseArgs(['--snapshot', 'x', '--bogus']), /unknown argument/);
});

await test('report writer produces a timestamped, parseable JSON file', () => {
    const root = freshDir('report-writer');
    const stamp = new Date('2026-11-17T10:11:12.345Z');
    const file = writeRepairReport({ tool: TOOL, version: REPORT_VERSION, ok: true }, path.join(root, 'reports'), stamp);
    assert.match(path.basename(file), /^repair-2026-11-17T10-11-12-345Z\.json$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { tool: TOOL, version: REPORT_VERSION, ok: true });
});

// ── teardown ─────────────────────────────────────────────────────────────────

fs.rmSync(TMP, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  FAIL ${failure.name}: ${failure.error}\n`);
    process.exitCode = 1;
}
