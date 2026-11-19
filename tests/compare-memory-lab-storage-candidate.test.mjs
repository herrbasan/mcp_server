// Candidate-aware storage comparison: old work collection vs clean candidate.
//
//   node tests/compare-memory-lab-storage-candidate.test.mjs
//
// Fixture snapshots hold ONLY a storage collection per side (no memory/chat
// collections, no candidate memory) to prove the comparison does not need them.

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import { resolveLiveRoots, createSnapshotGuard } from '../scripts/memory-lab-phase0.mjs';
import {
    compareStorageCandidate,
    canonicalChunkIds,
    auditStorageSide,
    writeReport,
    summarize,
    parseArgs
} from '../scripts/compare-memory-lab-storage-candidate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP = path.join(REPO_ROOT, 'tests', 'fixtures', `.tmp-compare-candidate-${process.pid}`);
const DIM = 8;

let passed = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        process.stdout.write(`ok    ${name}\n`);
    } catch (e) {
        failures.push({ name, error: e.message });
        process.stdout.write(`FAIL  ${name}\n      ${e.message}\n`);
    }
}

function freshDir(name) {
    const dir = path.join(TMP, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function basis(index) {
    const v = new Array(DIM).fill(0);
    v[index] = 1;
    return v;
}

const A0 = 'storage:blog/a.md#0';
const A1 = 'storage:blog/a.md#1';
const B = 'storage:blog/b.md';
const C = 'storage:fetch/c.md';
const D = 'storage:research/d.md';
const E = 'storage:research/e.md';
// F and G: different whole-file contentHash, byte-identical chunk text, same vector — legitimate
const F = 'storage:blog/f.md';
const G = 'storage:fetch/g.md';

function payloadOf(id, path_, contentHash, splitIdx) {
    return { path: path_, contentHash, splitIdx, folder: path_.split('/')[0], charOffset: 0, charLen: 10, absolutePath: `D:\\MCP_Storage\\${path_}` };
}

const PAYLOADS = {
    [A0]: payloadOf(A0, 'blog/a.md', 'h-a', 0),
    [A1]: payloadOf(A1, 'blog/a.md', 'h-a', 1),
    [B]: payloadOf(B, 'blog/b.md', 'h-b', 0),
    [C]: payloadOf(C, 'fetch/c.md', 'h-c', 0),
    [D]: payloadOf(D, 'research/d.md', 'h-d', 0),
    [E]: payloadOf(E, 'research/e.md', 'h-e', 0),
    [F]: payloadOf(F, 'blog/f.md', 'h-f', 0),
    [G]: payloadOf(G, 'fetch/g.md', 'h-g', 0)
};

const WORK_FILES = {
    'blog/a.md': 'canonical text of a.md, long enough to slice',
    'blog/b.md': 'bravo bravo bravo bravo',
    'fetch/c.md': 'charlie charlie charlie',
    'research/d.md': 'delta delta delta delta',
    'research/e.md': 'echo echo echo echo echo',
    'blog/f.md': 'shared chunk text then foxtrot tail',
    'fetch/g.md': 'shared chunk text then golf tail!!'
};

function writeStorageNvdb(dir, vectors) {
    fs.mkdirSync(dir, { recursive: true });
    const { Database } = loadNvdb();
    const db = new Database(dir);
    const coll = db.createCollection('storage', DIM);
    for (const [id, vector] of Object.entries(vectors)) coll.insert(id, vector, JSON.stringify(PAYLOADS[id]));
    if (typeof coll.flush === 'function') coll.flush();
    if (typeof coll.close === 'function') coll.close();
    if (typeof db.close === 'function') db.close();
}

function scanIndexOf(entries) {
    const files = {};
    for (const [base, spec] of Object.entries(entries)) files[base] = { collection: 'storage', ...spec };
    return { files, hashToDoc: {} };
}

const ENTRIES = {
    'storage:blog/a.md': { path: 'blog/a.md', chunks: 2 },
    [B]: { path: 'blog/b.md', chunks: 1 },
    [C]: { path: 'fetch/c.md', chunks: 1 },
    [D]: { path: 'research/d.md', chunks: 1 },
    [E]: { path: 'research/e.md', chunks: 1 },
    [F]: { path: 'blog/f.md', chunks: 1 },
    [G]: { path: 'fetch/g.md', chunks: 1 },
    'storage:blog/alias-of-b.md': { path: 'blog/alias-of-b.md', chunks: 1, duplicateOf: B }
};

// OLD work: A#0 and B share a vector for DIFFERENT text (the #82 signature),
// C and D too. CANDIDATE: every chunk distinct, except F/G whose text really is identical.
const OLD_VECTORS = { [A0]: basis(0), [A1]: basis(1), [B]: basis(0), [C]: basis(2), [D]: basis(2), [E]: basis(3), [F]: basis(6), [G]: basis(6) };
const CANDIDATE_VECTORS = { [A0]: basis(0), [A1]: basis(1), [B]: basis(4), [C]: basis(2), [D]: basis(5), [E]: basis(3), [F]: basis(6), [G]: basis(6) };

function buildSnapshot(root, { candidateVectors = CANDIDATE_VECTORS, rebuildStatus = 'ok', candidateEntries = ENTRIES, workFiles = WORK_FILES } = {}) {
    const work = path.join(root, 'work');
    const nvdbDir = path.join(work, 'mcp-server', 'data', 'nvdb');
    const storageDir = path.join(work, 'storage');
    const memoryDir = path.join(work, 'mcp-server', 'data', 'memories');
    const chatDir = path.join(work, 'chat-data');
    for (const d of [memoryDir, storageDir, chatDir, path.join(root, 'reports')]) fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(workFiles)) {
        fs.mkdirSync(path.dirname(path.join(storageDir, rel)), { recursive: true });
        fs.writeFileSync(path.join(storageDir, rel), text);
    }
    writeStorageNvdb(nvdbDir, OLD_VECTORS);
    fs.writeFileSync(path.join(nvdbDir, 'scan-index.json'), JSON.stringify(scanIndexOf(ENTRIES)));

    const candidateNvdb = path.join(root, 'candidate', 'nvdb');
    writeStorageNvdb(candidateNvdb, candidateVectors);
    fs.writeFileSync(path.join(candidateNvdb, 'scan-index.json'), JSON.stringify(scanIndexOf(candidateEntries)));

    if (rebuildStatus) {
        fs.writeFileSync(path.join(root, 'reports', 'rebuild-storage-2026-11-17T20-00-00-000Z.json'), JSON.stringify({
            tool: 'rebuild-memory-lab-storage', status: rebuildStatus, candidate: candidateNvdb, failures: rebuildStatus === 'ok' ? [] : ['1 file failed']
        }));
    }

    const manifest = {
        tool: 'snapshot-memory-lab', version: 1, name: 'compare-fixture', createdAt: '2026-11-17T00:00:00.000Z',
        mode: 'crash-consistent-copy', pointInTime: false, workRoot: work,
        sources: [
            { name: 'memory-ndb', role: 'memory-ndb', workPath: memoryDir },
            { name: 'nvdb', role: 'nvdb', workPath: nvdbDir },
            { name: 'storage', role: 'storage', workPath: storageDir },
            { name: 'chat-data', role: 'chat-data', workPath: chatDir }
        ]
    };
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(root, 'MANIFEST.sha256'), `${crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex')}  manifest.json\n`);

    const goldenPath = path.join(root, 'golden.json');
    fs.writeFileSync(goldenPath, JSON.stringify({
        suiteVersion: 'compare-fixture-1',
        dataset: { expectedEmbeddingDim: DIM, storageTopK: 10 },
        memory: [{ id: 'm', query: 'unused memory query' }],
        chat: [{ id: 'c', query: 'unused chat query', lane: 'keyword' }],
        storage: [
            { id: 'sto-a', query: 'query a', relevantPaths: ['blog/b.md'] },
            { id: 'sto-d', query: 'query d', relevantPaths: ['research/d.md'] },
            { id: 'sto-free', query: 'query free' }
        ],
        explicitVectorIds: [A0, B, C, D, E]
    }));
    return { goldenPath, candidateNvdb };
}

function countingEmbedder() {
    const map = { 'query a': basis(4), 'query d': basis(5), 'query free': basis(3) };
    const calls = [];
    return {
        calls,
        async embed(text) {
            calls.push(text);
            if (!(text in map)) throw new Error(`unexpected embed: ${text}`);
            return map[text];
        }
    };
}

const now = () => new Date('2026-11-17T20:00:00.000Z');

await test('canonicalChunkIds skips alias entries, which hold no vectors', () => {
    const { ids, canonicalFiles, aliasFiles } = canonicalChunkIds(scanIndexOf(ENTRIES));
    assert.deepEqual(ids, [A0, A1, B, C, D, E, F, G]);
    assert.equal(canonicalFiles, 7);
    assert.equal(aliasFiles, 1);
    assert.throws(() => canonicalChunkIds({}), /no files map/);
});

function openAudit(name, vectors) {
    const dir = path.join(TMP, name);
    fs.rmSync(dir, { recursive: true, force: true });
    writeStorageNvdb(dir, vectors);
    const { Database } = loadNvdb();
    return new Database(dir).getCollection('storage');
}

function auditFixture(name, { files = WORK_FILES } = {}) {
    const work = path.join(TMP, `${name}-work`);
    fs.rmSync(work, { recursive: true, force: true });
    for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
        fs.writeFileSync(path.join(work, rel), text);
    }
    return { storageWorkRoot: work, guard: createSnapshotGuard(work, resolveLiveRoots(REPO_ROOT)) };
}

await test('auditStorageSide classifies duplicates by exact chunk text, not by whole-file hash', () => {
    const coll = openAudit('audit-nvdb', OLD_VECTORS);
    const audit = auditStorageSide({ ids: [A0, A1, B, C, D, E, F, G, 'storage:gone.md'], coll, expectedDim: DIM, ...auditFixture('audit') });
    assert.equal(audit.vectorsMissing, 1);
    assert.deepEqual(audit.missingSamples, ['storage:gone.md']);
    // A0/B and C/D: same vector, different text => corruption
    assert.equal(audit.crossContentGroups, 2);
    assert.equal(audit.crossContentVectors, 4);
    // F/G: different contentHash#splitIdx but byte-identical chunk text => legitimate
    assert.equal(audit.sameTextGroups, 1);
    assert.equal(audit.unverifiedGroups, 0);
    assert.equal(audit.distinctVectorHashes, 5);
});

await test('auditStorageSide treats unreadable duplicate evidence as unverified, never clean', () => {
    const coll = openAudit('audit-unverified', OLD_VECTORS);
    const files = { ...WORK_FILES };
    delete files['fetch/g.md'];
    const audit = auditStorageSide({ ids: [F, G], coll, expectedDim: DIM, ...auditFixture('audit-unverified', { files }) });
    assert.equal(audit.sameTextGroups, 0);
    assert.equal(audit.unverifiedGroups, 1);
    assert.equal(audit.unverifiedVectors, 2);
    assert.match(audit.unverifiedSamples[0].unreadable[0].reason, /work copy file missing/);
});

await test('auditStorageSide keeps same-content groups and true bad-vector totals beyond the sample cap', () => {
    const dir = path.join(TMP, 'audit-counts');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const { Database } = loadNvdb();
    const c = new Database(dir).createCollection('storage', DIM);
    const ids = [];
    for (let i = 0; i < 12; i++) {
        ids.push(`z${i}`);
        c.insert(`z${i}`, new Array(DIM).fill(0), JSON.stringify({ path: `z/${i}.md`, contentHash: `hz${i}`, splitIdx: 0 }));
    }
    c.insert('x1', basis(0), JSON.stringify({ path: 'p/x1.md', contentHash: 'same', splitIdx: 0 }));
    c.insert('x2', basis(0), JSON.stringify({ path: 'p/x2.md', contentHash: 'same', splitIdx: 0 }));
    ids.push('x1', 'x2');
    const audit = auditStorageSide({ ids, coll: c, expectedDim: DIM, ...auditFixture('audit-counts', { files: {} }) });
    assert.equal(audit.zeroNormCount, 12);
    assert.equal(audit.zeroNormSamples.length, 10);
    assert.equal(audit.sameContentGroups, 1);
    assert.equal(audit.crossContentGroups, 0);
});

await test('compare reports old corruption vs clean candidate, embeds each query once, needs no memory/chat collection', async () => {
    const root = freshDir('full');
    const { goldenPath, candidateNvdb } = buildSnapshot(root);
    const embedder = countingEmbedder();
    const report = await compareStorageCandidate({ snapshot: root, embedder, openNvdb: loadNvdb, goldenPath, now });

    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.pass)));
    assert.equal(report.candidate.nvdb, candidateNvdb);
    assert.deepEqual(embedder.calls, ['query a', 'query d', 'query free'], 'one embed per golden storage query, shared by both sides');
    assert.equal(report.embed.calls, 3);

    assert.equal(report.index.old.aliasFiles, 1);
    assert.equal(report.integrity.old.vectorsMissing, 0, 'alias entries must not count as missing');
    assert.equal(report.integrity.old.crossContentGroups, 2);
    assert.equal(report.integrity.candidate.crossContentGroups, 0);
    assert.equal(report.integrity.candidate.sameTextGroups, 1, 'F/G share chunk text under different file hashes: legitimate');
    assert.equal(report.integrity.candidate.unverifiedGroups, 0);
    assert.equal(report.explicitVectors.old.allDistinct, false);
    assert.equal(report.explicitVectors.old.identicalPairs.length, 2);
    assert.equal(report.explicitVectors.candidate.allDistinct, true);
    assert.equal(report.index.missingInCandidate.count, 0);

    const caseA = report.cases.find((c) => c.id === 'sto-a');
    assert.equal(caseA.old.targetRanks.raw['blog/b.md'] !== null, true);
    assert.equal(caseA.candidate.targetRanks.final['blog/b.md'], 1);
    assert.equal(caseA.comparison.targetDeltas['blog/b.md'].candidate, 1);
    assert.ok(caseA.old.timing.searchMs >= 0 && caseA.candidate.timing.searchMs >= 0);
    // same lane as Phase 0: folder/normalized/contentHash/splitIdx and adjacent ranks present
    const first = caseA.candidate.final[0];
    assert.ok(first.evidence !== undefined && 'folder' in first && 'normalized' in first && 'contentHash' in first && 'splitIdx' in first);
    assert.ok(caseA.candidate.adjacentRanks && caseA.comparison.adjacentRanks);
    assert.equal(report.timings.candidate.count, 3);

    const file = writeReport(report, path.join(root, 'reports'), now());
    assert.ok(fs.existsSync(file));
    assert.match(summarize(report), /PASS\s+candidate-no-cross-content-duplicates/);
});

await test('a candidate that still carries cross-content duplicates or misses a vector fails its checks', async () => {
    const root = freshDir('bad-candidate');
    // the candidate index still lists E, the collection does not hold it
    const { [E]: dropped, ...withoutE } = OLD_VECTORS;
    const { goldenPath } = buildSnapshot(root, { candidateVectors: withoutE });
    const report = await compareStorageCandidate({ snapshot: root, embedder: countingEmbedder(), openNvdb: loadNvdb, goldenPath, now });
    assert.equal(report.ok, false);
    const failed = report.checks.filter((c) => !c.pass).map((c) => c.name);
    assert.ok(failed.includes('candidate-no-missing-vectors'), failed.join());
    assert.ok(failed.includes('candidate-no-cross-content-duplicates'), failed.join());
    assert.ok(failed.includes('candidate-five-explicit-vectors-distinct'), failed.join());
});

await test('candidate index lacking old chunk ids is reported as missingInCandidate', async () => {
    const root = freshDir('index-gap');
    const { [E]: dropped, ...rest } = ENTRIES;
    const { goldenPath } = buildSnapshot(root, { candidateEntries: rest });
    const report = await compareStorageCandidate({ snapshot: root, embedder: countingEmbedder(), openNvdb: loadNvdb, goldenPath, now });
    assert.deepEqual(report.index.missingInCandidate.samples, [E]);
    assert.equal(report.checks.find((c) => c.name === 'candidate-index-covers-old-index').pass, false);
    assert.equal(report.ok, false);
});

await test('refuses a candidate without a finished rebuild report unless allowIncomplete', async () => {
    const root = freshDir('no-report');
    const { goldenPath } = buildSnapshot(root, { rebuildStatus: null });
    const base = { snapshot: root, openNvdb: loadNvdb, goldenPath, now };
    await assert.rejects(() => compareStorageCandidate({ ...base, embedder: countingEmbedder() }), /no rebuild-storage report/);
    const report = await compareStorageCandidate({ ...base, embedder: countingEmbedder(), allowIncomplete: true });
    assert.equal(report.candidate.rebuildReport.skipped, true);

    const root2 = freshDir('incomplete-report');
    const built = buildSnapshot(root2, { rebuildStatus: 'incomplete' });
    await assert.rejects(() => compareStorageCandidate({ snapshot: root2, embedder: countingEmbedder(), openNvdb: loadNvdb, goldenPath: built.goldenPath }), /status "incomplete"/);
});

await test('refuses a missing candidate and a query vector of the wrong dimension', async () => {
    const root = freshDir('missing-candidate');
    const { goldenPath } = buildSnapshot(root);
    fs.rmSync(path.join(root, 'candidate'), { recursive: true, force: true });
    await assert.rejects(() => compareStorageCandidate({ snapshot: root, embedder: countingEmbedder(), openNvdb: loadNvdb, goldenPath, now }), /candidate nVDB missing/);

    const root2 = freshDir('bad-dim');
    const built = buildSnapshot(root2);
    await assert.rejects(() => compareStorageCandidate({ snapshot: root2, embedder: { embed: async () => [1, 2, 3] }, openNvdb: loadNvdb, goldenPath: built.goldenPath, now }), /expected 8/);
});

await test('parseArgs requires --snapshot and rejects unknown flags', () => {
    assert.deepEqual(parseArgs(['--snapshot', 'X', '--allow-incomplete']), { snapshot: 'X', allowIncomplete: true });
    assert.throws(() => parseArgs([]), /missing --snapshot/);
    assert.throws(() => parseArgs(['--snapshot', 'X', '--nope']), /unknown argument/);
});

fs.rmSync(TMP, { recursive: true, force: true });
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
