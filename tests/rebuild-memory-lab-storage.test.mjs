// Focused test for scripts/rebuild-memory-lab-storage.mjs — the clean-room
// STORAGE reindex runner.
//   node tests/rebuild-memory-lab-storage.test.mjs
//
// Unit part (in-process): CLI parsing, candidate guards, creation/resume proof,
// agent-config clone assertions, discovery rules.
//
// E2E part (child processes, fake Gateway): builds a tiny lab snapshot whose
// WORK nVDB already holds a poisoned storage collection, a poisoned scan-index
// and a seeded __enhancement_cache, then:
//   1. creates the candidate  -> only the work storage is indexed, absolutePath
//      points into the work fixture, no old vector survives, and the cache is
//      backfilled from the work scan-index metadata: one record reused from the
//      copied cache, one seeded (no predict, exact header), one incomplete
//      metadata file still predicts. Work nVDB untouched;
//   2. resumes               -> 0 added, every file skipped, 0 predict();
//   3. refuses a dirty candidate without --resume;
//   4. refuses --max-files below the snapshot's file count without writing;
//   5. surfaces scanner errors (oversized file) in the report.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import { formatContextHeader } from '../src/agents/vdb/context-enhancer.js';
import { resolveLiveRoots, sha256File } from '../scripts/memory-lab-phase0.mjs';
import { vdb_status as vdbStatus } from '../src/agents/vdb/index.js';
import {
    ENHANCEMENT_CACHE_COLLECTION,
    ONE_SHOT_SCAN_INTERVAL_MINUTES,
    buildAgentConfig,
    cacheableMetadata,
    createCandidateGuard,
    createFakeGateway,
    effectiveScanLimitMs,
    enumerateTextFiles,
    parseArgs,
    prepareCandidate,
    resolveTargets,
    runRebuild
} from '../scripts/rebuild-memory-lab-storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'rebuild-memory-lab-storage.mjs');
const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
const EMBEDDING_DIM = CONFIG.agents.vdb.embeddingDim;
const SCAN_TIMEOUT = '60000';

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL  ${name}\n      ${error.message}`);
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256Text(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function createNvdbCollection(dbDir, collection, { dimension = EMBEDDING_DIM, docs = [] } = {}) {
    const { Database } = loadNvdb();
    const db = new Database(dbDir);
    const coll = db.createCollection(collection, dimension, { durability: 'sync' });
    for (const doc of docs) coll.insert(doc.id, doc.vector, doc.payload);
    coll.flush();
}

// Tiny snapshot with the four roles resolveSnapshotLayout() requires. The work
// nVDB deliberately carries everything a clean-room candidate must NOT inherit,
// plus the metadata a rebuild is allowed to READ (the work scan-index).
function buildSnapshot(root, { files, cacheSeed = [], indexEntries = {}, poison = true }) {
    const work = path.join(root, 'work');
    const workStorage = path.join(work, 'storage');
    const workData = path.join(work, 'mcp-server', 'data');
    const workNvdb = path.join(workData, 'nvdb');
    const workMemory = path.join(workData, 'memories', 'data.jsonl');
    const workChat = path.join(work, 'chatdata');

    for (const [relPath, content] of Object.entries(files)) {
        const target = path.join(workStorage, relPath.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
    }
    fs.mkdirSync(workChat, { recursive: true });
    fs.mkdirSync(path.dirname(workMemory), { recursive: true });
    fs.writeFileSync(workMemory, '{"description":"lab memory"}\n', 'utf8');

    createNvdbCollection(workNvdb, ENHANCEMENT_CACHE_COLLECTION, {
        docs: cacheSeed.map(({ content, meta }) => ({
            id: sha256Text(content),
            vector: new Array(EMBEDDING_DIM).fill(0),
            payload: JSON.stringify({ meta, header: formatContextHeader(meta) })
        }))
    });
    const scanIndexFiles = { ...indexEntries };
    if (poison) {
        createNvdbCollection(workNvdb, 'storage', {
            docs: [{
                id: 'storage:poison.md',
                vector: new Array(EMBEDDING_DIM).fill(0.01),
                payload: JSON.stringify({ path: 'poison.md', absolutePath: 'C:/live/poison.md', collection: 'storage', chunks: 1 })
            }]
        });
        scanIndexFiles['storage:poison.md'] = {
            collection: 'storage',
            path: 'poison.md',
            absolutePath: 'C:/live/poison.md',
            contentHash: 'deadbeef',
            chunks: 1
        };
    }
    writeJson(path.join(workNvdb, 'scan-index.json'), { files: scanIndexFiles });
    fs.mkdirSync(path.join(root, 'reference'), { recursive: true });

    const manifest = {
        version: 1,
        flow: 'live -> reference -> work',
        mode: 'test-fixture',
        sources: [
            { name: 'memory-ndb', role: 'memory-ndb', kind: 'dir', workPath: path.dirname(workMemory) },
            { name: 'nvdb', role: 'nvdb', kind: 'dir', workPath: workNvdb },
            { name: 'storage', role: 'storage', kind: 'dir', workPath: workStorage },
            { name: 'chat-data', role: 'chat-data', kind: 'dir', workPath: workChat }
        ]
    };
    writeJson(path.join(root, 'manifest.json'), manifest);
    return { work, workStorage, workNvdb, candidateNvdb: path.join(root, 'candidate', 'nvdb'), reports: path.join(root, 'reports') };
}

function runCli(snapshot, extraArgs = []) {
    return spawnSync(process.execPath, [SCRIPT, '--snapshot', snapshot, '--fake-gateway', '--scan-timeout-ms', SCAN_TIMEOUT, ...extraArgs], {
        encoding: 'utf8',
        timeout: 300000
    });
}

function latestReport(reportsDir) {
    const files = fs.readdirSync(reportsDir).filter((name) => name.endsWith('.json')).sort();
    if (files.length === 0) throw new Error(`no report written under ${reportsDir}`);
    return JSON.parse(fs.readFileSync(path.join(reportsDir, files[files.length - 1]), 'utf8'));
}

const tmpRoot = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-rebuild-lab-'));

const CACHED_CONTENT = '# Cached doc\n\nStable content used to prove the enhancement cache is reused.\n';
const CACHED_META = { summary: 'cached summary for the fixture', keywords: ['cached', 'fixture'], entities: [], docType: 'note', contextEnhanced: true };
const PLAIN_CONTENT = '# Plain doc\n\nSome text that gets no pre-seeded metadata.\n';
const PLAIN_META = {
    summary: 'seeded summary taken from the work scan-index',
    keywords: ['seeded', 'header'],
    entities: ['RebuildFixture'],
    docType: 'spec',
    contextEnhanced: true
};
const SECOND_CONTENT = '# Second guide\n\nAnother file in the work storage fixture.\n';
const FILES = {
    'docs/cached.md': CACHED_CONTENT,
    'docs/plain.md': PLAIN_CONTENT,
    'guides/second.md': SECOND_CONTENT
};
// The work scan-index carries the metadata that produced each file's embedding
// header. cached.md is ALSO in the copied cache (reused), plain.md is only in
// the index (seeded), second.md has incomplete metadata (predicts normally).
const WORK_INDEX_ENTRIES = {
    'storage:docs/cached.md': { path: 'docs/cached.md', contentHash: sha256Text(CACHED_CONTENT), chunks: 1, metadata: CACHED_META },
    'storage:docs/plain.md': { path: 'docs/plain.md', contentHash: sha256Text(PLAIN_CONTENT), chunks: 1, metadata: PLAIN_META },
    'storage:guides/second.md': {
        path: 'guides/second.md',
        contentHash: sha256Text(SECOND_CONTENT),
        chunks: 1,
        metadata: { summary: 'never enhanced', keywords: [], entities: [], docType: 'note', contextEnhanced: false }
    }
};

try {
    // ── unit: CLI ────────────────────────────────────────────────────────────
    await test('parseArgs requires --snapshot and rejects unknown flags', () => {
        assert.throws(() => parseArgs([]), /--snapshot <root> is required/);
        assert.throws(() => parseArgs(['--snapshot', 'x', '--wat']), /unknown argument/);
        assert.throws(() => parseArgs(['--snapshot', 'x', '--max-files', 'abc']), /non-negative integer/);
        const args = parseArgs(['--snapshot', 'D:/lab/snap', '--resume', '--max-files', '5', '--batch-delay-ms', '0']);
        assert.equal(args.snapshot, 'D:/lab/snap');
        assert.equal(args.resume, true);
        assert.equal(args.maxFiles, 5);
        assert.equal(args.batchDelayMs, 0);
        assert.equal(args.fakeGateway, false);
    });

    // ── unit: candidate guards ───────────────────────────────────────────────
    await test('candidate guard refuses work, reference, live and outside-snapshot paths', () => {
        const snapshotRoot = path.join(tmpRoot, 'guard-snap');
        const candidateRoot = path.join(snapshotRoot, 'candidate');
        const liveRoots = resolveLiveRoots(REPO_ROOT);
        const liveStorage = path.resolve(CONFIG.agents.storage.root);
        const guard = createCandidateGuard({
            snapshotRoot,
            candidateRoot,
            workRoot: path.join(snapshotRoot, 'work'),
            referenceRoot: path.join(snapshotRoot, 'reference'),
            liveRoots
        });
        assert.throws(() => guard.assertCandidate(path.join(snapshotRoot, 'work', 'storage', 'a.md'), 'candidate'), /WORK tree/);
        assert.throws(() => guard.assertCandidate(path.join(snapshotRoot, 'reference', 'nvdb'), 'candidate'), /REFERENCE tree/);
        assert.throws(() => guard.assertCandidate(path.join(liveStorage, 'docs'), 'candidate'), /LIVE data root/);
        assert.throws(() => guard.assertCandidate(path.join(snapshotRoot, 'elsewhere', 'nvdb'), 'candidate'), /outside the candidate root/);
        assert.equal(guard.assertCandidate(path.join(candidateRoot, 'nvdb'), 'candidate'), path.join(candidateRoot, 'nvdb'));
    });

    await test('candidate guard refuses a candidate root outside the snapshot or inside a live root', () => {
        const liveRoots = resolveLiveRoots(REPO_ROOT);
        assert.throws(() => createCandidateGuard({
            snapshotRoot: path.join(tmpRoot, 'snap-a'),
            candidateRoot: path.join(tmpRoot, 'other', 'candidate'),
            workRoot: path.join(tmpRoot, 'snap-a', 'work'),
            referenceRoot: path.join(tmpRoot, 'snap-a', 'reference'),
            liveRoots
        }), /outside the snapshot root/);
        assert.throws(() => createCandidateGuard({
            snapshotRoot: path.resolve(CONFIG.agents.storage.root),
            candidateRoot: path.join(path.resolve(CONFIG.agents.storage.root), 'candidate'),
            workRoot: path.join(path.resolve(CONFIG.agents.storage.root), 'work'),
            referenceRoot: path.join(path.resolve(CONFIG.agents.storage.root), 'reference'),
            liveRoots
        }), /LIVE data root/);
    });

    // ── unit: creation proof ─────────────────────────────────────────────────
    await test('prepareCandidate refuses a dirty candidate unless --resume', () => {
        const candidateNvdb = path.join(tmpRoot, 'proof', 'candidate', 'nvdb');
        fs.mkdirSync(path.join(candidateNvdb, 'storage', 'segments'), { recursive: true });
        writeJson(path.join(candidateNvdb, 'scan-index.json'), { files: {} });

        assert.throws(() => prepareCandidate({ candidateNvdb, resume: false }), /no old scan-index/);
        const resumed = prepareCandidate({ candidateNvdb, resume: true });
        assert.equal(resumed.mode, 'resume');
        assert.equal(resumed.resumeScanIndex, true);

        fs.rmSync(path.join(candidateNvdb, 'scan-index.json'));
        assert.throws(() => prepareCandidate({ candidateNvdb, resume: false }), /nonempty storage collection/);
        const clean = prepareCandidate({ candidateNvdb: path.join(tmpRoot, 'clean', 'nvdb'), resume: false });
        assert.equal(clean.mode, 'create');
        assert.deepEqual(clean.state, { exists: false, hasScanIndex: false, hasStorageCollection: false, storageSegments: [], hasEnhancementCache: false });
    });

    // ── unit: agent config clone ─────────────────────────────────────────────
    await test('buildAgentConfig redirects dbPath/indexPath/storage while keeping scanner settings', () => {
        const snapshotRoot = path.join(tmpRoot, 'cfg-snap');
        const config = buildAgentConfig(CONFIG, {
            candidateNvdb: path.join(snapshotRoot, 'candidate', 'nvdb'),
            workStorage: path.join(snapshotRoot, 'work', 'storage'),
            batchDelayMs: 0
        });
        assert.equal(config.agents.vdb.dbPath, path.join(snapshotRoot, 'candidate', 'nvdb'));
        assert.equal(config.agents.vdb.indexPath, null);
        assert.deepEqual(Object.keys(config.agents.vdb.watch), ['storage']);
        assert.equal(config.agents.storage.root, path.join(snapshotRoot, 'work', 'storage'));
        assert.equal(config.agents.vdb.batchDelayMs, 0);
        assert.equal(config.agents.vdb.scanIntervalMinutes, ONE_SHOT_SCAN_INTERVAL_MINUTES, 'the repeating scanner is neutralised for a one-shot rebuild');
        assert.equal(config.agents.vdb.scanTimeoutMinutes, CONFIG.agents.vdb.scanTimeoutMinutes);
        assert.equal(config.agents.vdb.chunkMaxTokens, CONFIG.agents.vdb.chunkMaxTokens);
        assert.equal(config.agents.vdb.embeddingDim, CONFIG.agents.vdb.embeddingDim);
        assert.deepEqual(config.agents.vdb.textExtensions, CONFIG.agents.vdb.textExtensions);
        assert.equal(config.agents.vdb.contextEnhancement.enabled, CONFIG.agents.vdb.contextEnhancement.enabled);
        // The clone must not alias the loaded config object.
        config.agents.vdb.ignore.push('mutated');
        assert.ok(!CONFIG.agents.vdb.ignore.includes('mutated'));
    });

    // ── unit: cache metadata validity ────────────────────────────────────────
    await test('cacheableMetadata accepts only complete, header-bearing metadata', () => {
        assert.deepEqual(cacheableMetadata(PLAIN_META), {
            summary: PLAIN_META.summary,
            keywords: PLAIN_META.keywords,
            entities: PLAIN_META.entities,
            docType: PLAIN_META.docType
        });
        assert.equal(cacheableMetadata(null), null);
        assert.equal(cacheableMetadata({ ...PLAIN_META, contextEnhanced: false }), null, 'unenhanced metadata must not be seeded');
        assert.equal(cacheableMetadata({ ...PLAIN_META, contextEnhanced: undefined }), null);
        assert.equal(cacheableMetadata({ ...PLAIN_META, summary: '   ' }), null, 'no summary means no header');
        assert.equal(cacheableMetadata({ ...PLAIN_META, docType: '' }), null);
        assert.equal(cacheableMetadata({ ...PLAIN_META, keywords: [1, 'ok'] }), null, 'non-string keywords are rejected');
        assert.equal(cacheableMetadata({ ...PLAIN_META, entities: 'nope' }), null);
    });

    // ── unit: discovery rules ────────────────────────────────────────────────
    await test('enumerateTextFiles honours extensions, config ignore and .nvdb_ignore', () => {
        const root = path.join(tmpRoot, 'discovery');
        fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
        fs.mkdirSync(path.join(root, 'temp'), { recursive: true });
        fs.writeFileSync(path.join(root, 'docs', 'a.md'), 'a', 'utf8');
        fs.writeFileSync(path.join(root, 'docs', 'skip.txt'), 'b', 'utf8');
        fs.writeFileSync(path.join(root, 'docs', 'image.png'), 'c', 'utf8');
        fs.writeFileSync(path.join(root, 'temp', 'ignored.md'), 'd', 'utf8');
        fs.writeFileSync(path.join(root, 'docs', '.nvdb_ignore'), 'skip.txt\n', 'utf8');
        const result = enumerateTextFiles(root, { textExtensions: ['.md', '.txt'], ignore: ['temp'] });
        assert.deepEqual(result.relPaths, ['docs/a.md']);
        assert.equal(result.count, 1);
    });

    // ── e2e: create ──────────────────────────────────────────────────────────
    const snap = path.join(tmpRoot, 'snap');
    const layout = buildSnapshot(snap, {
        files: FILES,
        cacheSeed: [{ content: CACHED_CONTENT, meta: CACHED_META }],
        indexEntries: WORK_INDEX_ENTRIES
    });
    const workStorageBefore = enumerateTextFiles(layout.workStorage, { textExtensions: CONFIG.agents.vdb.textExtensions });
    const workNvdbScanIndexBefore = sha256File(path.join(layout.workNvdb, 'scan-index.json'));
    const workNvdbStorageSegmentBefore = sha256File(path.join(layout.workNvdb, 'storage', 'segments', fs.readdirSync(path.join(layout.workNvdb, 'storage', 'segments'))[0]));

    let createReport = null;
    await test('create: fresh candidate is built from the work storage by the real pipeline', () => {
        assert.equal(workStorageBefore.count, 3);
        const run = runCli(snap);
        assert.equal(run.status, 0, `runner failed:\n${run.stderr}\n${run.stdout}`);
        createReport = latestReport(layout.reports);
        assert.equal(createReport.status, 'ok');
        assert.equal(createReport.mode, 'create');
        assert.equal(createReport.gateway, 'fake');
        assert.equal(createReport.candidate, layout.candidateNvdb);
        assert.deepEqual(createReport.creation.proof, { scanIndexPresent: false, storageCollectionPresent: false });
        assert.equal(createReport.scan.added, 3, 'all three work files indexed');
        assert.equal(createReport.scan.errors, 0);
        assert.equal(createReport.scan.pending, 0);
        assert.match(String(createReport.scan.lastScanAt), /^\d{4}-\d{2}-\d{2}T/, 'the agent initial scan completed');
        assert.ok(createReport.durationMs > 0);
        assert.equal(createReport.index.vectorsMatchIndex, true);
        assert.deepEqual(createReport.discovery.failedFiles, []);
        assert.ok(fs.existsSync(path.join(layout.candidateNvdb, 'scan-index.json')), 'candidate scan-index written');
        assert.ok(fs.existsSync(path.join(layout.candidateNvdb, 'storage', 'segments')), 'candidate storage collection written');
        for (const absent of ['documentation', 'memory']) {
            assert.ok(!fs.existsSync(path.join(layout.candidateNvdb, absent)), `${absent} collection must not exist in the candidate`);
        }
        assert.deepEqual(createReport.prunedCollections, ['memory'], 'the status-read collections are pruned, leaving storage + enhancement cache only');
    });

    await test('create: enhancement cache carried over, everything else left behind', () => {
        assert.equal(createReport.enhancementCache.action, 'copied');
        assert.equal(createReport.enhancementCache.cacheDocs, 1);
        assert.ok(fs.existsSync(path.join(layout.candidateNvdb, ENHANCEMENT_CACHE_COLLECTION, 'segments')));
        const index = JSON.parse(fs.readFileSync(path.join(layout.candidateNvdb, 'scan-index.json'), 'utf8'));
        assert.ok(!('storage:poison.md' in index.files), 'old scan-index entry was not inherited');
        for (const entry of Object.values(index.files)) {
            assert.ok(entry.absolutePath.startsWith(layout.workStorage), `absolutePath points outside the work fixture: ${entry.absolutePath}`);
        }
    });

    await test('create: cache is backfilled from the work scan-index metadata, one file still predicts', () => {
        // cached.md was already in the copied cache, plain.md exists only as
        // scan-index metadata, second.md has incomplete metadata.
        assert.equal(createReport.cacheReused, 1);
        assert.equal(createReport.cacheSeeded, 1);
        assert.equal(createReport.cacheMissing, 1);
        assert.equal(createReport.enhancementCache.seeding.invalidMetadata, 1);
        assert.equal(createReport.enhancementCache.seeding.notInWorkIndex, 0);
        assert.equal(createReport.enhancementCache.seeding.willPredict, 1);
        assert.equal(createReport.enhancementCache.seeding.discoveredFiles, 3);
        assert.equal(createReport.gatewayStats.predictCalls, 1, 'only the file without usable metadata asked the model');
    });

    await test('create: the work nVDB is untouched', () => {
        assert.equal(sha256File(path.join(layout.workNvdb, 'scan-index.json')), workNvdbScanIndexBefore);
        assert.equal(
            sha256File(path.join(layout.workNvdb, 'storage', 'segments', fs.readdirSync(path.join(layout.workNvdb, 'storage', 'segments'))[0])),
            workNvdbStorageSegmentBefore
        );
    });

    // ── e2e: resume ──────────────────────────────────────────────────────────
    await test('resume: unchanged files skip, nothing is re-embedded or re-enhanced', () => {
        const docsBefore = createReport.index.collectionDocs;
        const run = runCli(snap, ['--resume']);
        assert.equal(run.status, 0, `resume failed:\n${run.stderr}\n${run.stdout}`);
        const report = latestReport(layout.reports);
        assert.equal(report.status, 'ok');
        assert.equal(report.mode, 'resume');
        assert.equal(report.creation.resume.scanIndexPresent, true);
        assert.equal(report.scan.added, 0);
        assert.equal(report.scan.updated, 0);
        assert.equal(report.scan.skipped, 3);
        assert.equal(report.gatewayStats.predictCalls, 0);
        assert.equal(report.gatewayStats.embedTexts, 0);
        assert.equal(report.index.collectionDocs, docsBefore);
        assert.equal(report.index.vectorsMatchIndex, true);
        assert.equal(report.enhancementCache.action, 'kept');
        // Run 1 seeded plain.md and the enhancer cached second.md, so the
        // resumed run finds a record for every file and predicts nothing.
        assert.equal(report.cacheReused, 3);
        assert.equal(report.cacheSeeded, 0);
        assert.equal(report.cacheMissing, 0);
        assert.equal(report.enhancementCache.seeding.willPredict, 0);
        assert.deepEqual(report.discovery.failedFiles, []);
    });

    // Opened last on this snapshot: nVDB collections take an exclusive lock, so
    // the candidate must not be held while a child run indexes it.
    await test('candidate uses the seeded header for an uncached file, and only work-derived vectors', () => {
        const { Database } = loadNvdb();
        const db = new Database(layout.candidateNvdb);
        const coll = db.getCollection('storage');
        const poison = coll.get('storage:poison.md');
        assert.ok(poison === null || poison === undefined, 'old vector must not be copied');

        const cached = JSON.parse(coll.get('storage:docs/cached.md').payload);
        assert.equal(cached.absolutePath, path.join(layout.workStorage, 'docs', 'cached.md'));
        assert.equal(cached.contextEnhanced, true);
        assert.equal(cached.summary, CACHED_META.summary, 'metadata came from the carried enhancement cache');

        // Absent from the copied cache, present as work scan-index metadata:
        // the chunk payload carries that metadata and the header it produced.
        const plain = JSON.parse(coll.get('storage:docs/plain.md').payload);
        assert.equal(plain.absolutePath, path.join(layout.workStorage, 'docs', 'plain.md'));
        assert.equal(plain.summary, PLAIN_META.summary);
        assert.deepEqual(plain.keywords, PLAIN_META.keywords);
        assert.deepEqual(plain.entities, PLAIN_META.entities);
        assert.equal(plain.docType, PLAIN_META.docType);
        assert.equal(plain.contextEnhanced, true);

        const second = JSON.parse(coll.get('storage:guides/second.md').payload);
        assert.match(second.summary, /stub metadata/, 'the incomplete-metadata file was enhanced by the (stub) model');

        const cache = db.getCollection(ENHANCEMENT_CACHE_COLLECTION);
        const seeded = JSON.parse(cache.get(sha256Text(PLAIN_CONTENT)).payload);
        assert.deepEqual(seeded.meta, {
            summary: PLAIN_META.summary,
            keywords: PLAIN_META.keywords,
            entities: PLAIN_META.entities,
            docType: PLAIN_META.docType
        });
        assert.equal(seeded.header, formatContextHeader(seeded.meta), 'seeded record carries the exact header');
        // second.md had unusable metadata, so the enhancer (not the seeder)
        // wrote its record — the invalid summary never reached the cache.
        const fromEnhancer = JSON.parse(cache.get(sha256Text(SECOND_CONTENT)).payload);
        assert.match(fromEnhancer.meta.summary, /stub metadata/);
        assert.notEqual(fromEnhancer.meta.summary, 'never enhanced');
    });

    // ── e2e: guards ──────────────────────────────────────────────────────────
    await test('a dirty candidate without --resume is refused and left unchanged', () => {
        const indexPath = path.join(layout.candidateNvdb, 'scan-index.json');
        const before = sha256File(indexPath);
        const run = runCli(snap);
        assert.notEqual(run.status, 0, 'runner must refuse a nonempty candidate');
        assert.match(run.stderr, /no old scan-index/);
        assert.equal(sha256File(indexPath), before, 'the candidate scan-index must not be rewritten');
        const report = latestReport(layout.reports);
        assert.equal(report.status, 'failed');
        assert.match(report.error, /no old scan-index/);
    });

    await test('--max-files below the file count refuses before writing anything', () => {
        const freshSnap = path.join(tmpRoot, 'cap-snap');
        const fresh = buildSnapshot(freshSnap, { files: FILES, cacheSeed: [] });
        const run = runCli(freshSnap, ['--max-files', '1']);
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /--max-files 1 refused/);
        assert.ok(!fs.existsSync(fresh.candidateNvdb), 'nothing may be created when the cap refuses');
    });

    await test('scanner errors surface in the report instead of being swallowed', () => {
        const errSnap = path.join(tmpRoot, 'error-snap');
        const errLayout = buildSnapshot(errSnap, {
            files: { 'docs/ok.md': '# fine\n', 'docs/oversize.md': 'x'.repeat(CONFIG.agents.vdb.maxFileSizeBytes + 1024) },
            cacheSeed: []
        });
        const run = runCli(errSnap);
        assert.notEqual(run.status, 0, 'an incomplete candidate must not report success');
        const report = latestReport(errLayout.reports);
        assert.equal(report.status, 'incomplete');
        assert.equal(report.scan.added, 1);
        assert.equal(report.scan.errors, 1);
        assert.deepEqual(report.discovery.failedFiles, ['docs/oversize.md']);
        assert.ok(report.failures.some((line) => /failed during the scan/.test(line)), 'failure list names the scan errors');
        assert.ok(report.index.vectorsMatchIndex);
    });

    await test('duplicate-file aliases survive in the candidate checkpoint', () => {
        const duplicateSnap = path.join(tmpRoot, 'duplicate-snap');
        const duplicateLayout = buildSnapshot(duplicateSnap, {
            files: { 'docs/original.md': '# Same content\n', 'docs/alias.md': '# Same content\n' },
            cacheSeed: []
        });
        const run = runCli(duplicateSnap);
        assert.equal(run.status, 0, run.stderr);
        const index = JSON.parse(fs.readFileSync(path.join(duplicateLayout.candidateNvdb, 'scan-index.json'), 'utf8'));
        const entries = Object.values(index.files);
        const alias = entries.find(entry => entry.duplicateOf);
        const canonical = entries.find(entry => !entry.duplicateOf);
        assert.ok(alias, 'one file must be recorded as an alias');
        assert.ok(canonical, 'one file must own the vector');
        assert.equal(alias.chunks, 0);
        assert.equal(canonical.chunks, 1);
        assert.equal(index.files[alias.duplicateOf], canonical);
    });

    // ── unit: scan limit alignment ───────────────────────────────────────────
    await test('scan limit: default untouched, --scan-timeout-ms reaches the agent config', () => {
        const target = { candidateNvdb: path.join(tmpRoot, 'a', 'candidate', 'nvdb'), workStorage: path.join(tmpRoot, 'a', 'work', 'storage') };
        const plain = buildAgentConfig(CONFIG, target);
        assert.equal(plain.agents.vdb.scanTimeoutMinutes, CONFIG.agents.vdb.scanTimeoutMinutes);
        assert.equal(effectiveScanLimitMs(plain), CONFIG.agents.vdb.scanTimeoutMinutes * 60000);
        const overridden = buildAgentConfig(CONFIG, { ...target, scanTimeoutMs: 90000 });
        assert.equal(overridden.agents.vdb.scanTimeoutMinutes, 1.5);
        assert.equal(effectiveScanLimitMs(overridden), 90000);
        assert.throws(() => buildAgentConfig(CONFIG, { ...target, scanTimeoutMs: 0 }), /positive number/);
    });

    // Leaves the module-global VDB agent initialised with a hung scan; later
    // tests must not use it (the process exits at the end).
    await test('a timed-out agent scan fails the wait at once with lastScanError and published failure stats', async () => {
        const hangSnap = path.join(tmpRoot, 'hang-snap');
        buildSnapshot(hangSnap, { files: { 'docs/ok.md': '# fine\n' }, cacheSeed: [] });
        const never = () => new Promise(() => {});
        const started = Date.now();
        await assert.rejects(
            runRebuild({
                snapshotRoot: hangSnap,
                scanTimeoutMs: 1500,
                pollMs: 50,
                gatewayFactory: ({ config }) => ({
                    ...createFakeGateway(config.agents.vdb.embeddingDim),
                    embed: never,
                    embedText: never,
                    embedBatch: never,
                    embedBatchBackground: never,
                    predict: never
                })
            }),
            /initial scan failed: Scan timed out after 1500ms .*"errors":1/
        );
        // Agent limit 1.5 s; the runner's own deadline would have been 301.5 s.
        assert.ok(Date.now() - started < 30000, 'the failure must surface at the agent timeout, not the runner deadline');
        const status = JSON.parse((await vdbStatus()).content[0].text);
        assert.equal(status.lastScanAt, null, 'a failed scan must not look completed');
        assert.equal(status.isScanning, false);
        assert.match(status.lastScanError, /Scan timed out after 1500ms/);
        assert.equal(status.lastScanStats.errors, 1);
    });

    // ── e2e: layout resolution is snapshot-scoped ────────────────────────────
    await test('resolveTargets keeps every path inside the snapshot and out of live roots', () => {
        const targets = resolveTargets(snap);
        assert.equal(targets.candidateNvdb, path.join(snap, 'candidate', 'nvdb'));
        assert.equal(targets.reportsDir, path.join(snap, 'reports'));
        for (const live of targets.liveRoots) {
            assert.ok(!targets.candidateNvdb.startsWith(live), `candidate must not sit inside live root ${live}`);
        }
        assert.throws(() => resolveTargets(path.join(REPO_ROOT, 'no-such-snapshot')), /snapshot root missing/);
    });
} finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
