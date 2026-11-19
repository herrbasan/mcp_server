#!/usr/bin/env node
// Candidate-aware storage comparison for the memory refactor lab.
//
// Compares the canonical OLD storage collection in <snapshot>/work/ against the
// clean rebuild in <snapshot>/candidate/nvdb (written by
// rebuild-memory-lab-storage.mjs) WITHOUT renaming the candidate over work. It
// opens both nVDB directories read-only in spirit (no insert/delete/flush), needs
// only the "storage" collection on each side, and never touches memory/chat.
//
// Per side it reports: missing vectors, bad vectors, distinct vector hashes,
// duplicate groups split into SAME-content (legitimate) and CROSS-content
// (the #82 corruption signature), and the five explicit golden vectors.
// Per golden storage query it embeds ONCE and replays the same vector against
// both collections with the Phase 0 lane (cosine, exact, min-max, dedup, per-path
// cap), reporting target ranks, final-window overlap and per-side timings.
//
// Content evidence always resolves against work/storage (canonical text);
// payload.absolutePath is never followed.
//
// A candidate is only compared once its rebuild report says status "ok" — a
// rebuild still running has no (or an older) report, and opening a collection
// another process is writing is refused unless --allow-incomplete is explicit.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import {
    resolveLiveRoots,
    resolveSnapshotLayout,
    createSnapshotGuard,
    loadGoldenSuite,
    wrapEmbedder,
    analyzeVector,
    explicitVectorProbe,
    storageLaneFromVector,
    sha256File,
    durationSummary
} from './memory-lab-phase0.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GOLDEN_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'memory-lab-phase0-golden.json');

export const TOOL = 'compare-memory-lab-storage-candidate';
export const REPORT_VERSION = 1;
const MAX_SAMPLES = 10;

// Chunk ids of CANONICAL entries only. Alias entries (duplicateOf) are content
// duplicates that hold no vectors; counting them would report phantom missing ids.
export function canonicalChunkIds(scanIndex) {
    const files = scanIndex?.files;
    if (!files || typeof files !== 'object') throw new Error('canonicalChunkIds: scan-index has no files map');
    const ids = [];
    let aliasFiles = 0;
    let canonicalFiles = 0;
    for (const [base, entry] of Object.entries(files)) {
        if (entry.duplicateOf) { aliasFiles++; continue; }
        const chunks = entry.chunks;
        if (!Number.isInteger(chunks) || chunks < 1) throw new Error(`canonicalChunkIds: invalid chunk count for ${base}: ${chunks}`);
        canonicalFiles++;
        if (chunks === 1) ids.push(base);
        else for (let i = 0; i < chunks; i++) ids.push(`${base}#${i}`);
    }
    return { ids, canonicalFiles, aliasFiles };
}

// Exact text of one chunk from canonical work/storage, hashed. Evidence that
// cannot be resolved is reported with a reason — never treated as proof of
// anything.
function chunkTextHash(payload, storageWorkRoot, guard, cache) {
    if (!payload || typeof payload.path !== 'string' || payload.path.length === 0) return { available: false, reason: 'payload has no path' };
    if (!Number.isInteger(payload.charOffset) || !Number.isInteger(payload.charLen)) return { available: false, reason: 'payload has no charOffset/charLen' };
    const target = path.join(storageWorkRoot, payload.path.split('/').join(path.sep));
    guard.assertWork(target, `storage evidence ${payload.path}`);
    let text = cache.get(target);
    if (text === undefined) {
        if (!fs.existsSync(target)) return { available: false, reason: 'work copy file missing' };
        text = fs.readFileSync(target, 'utf8');
        cache.set(target, text);
    }
    if (payload.charOffset < 0 || payload.charOffset + payload.charLen > text.length) {
        return { available: false, reason: 'charOffset/charLen outside the work copy file' };
    }
    const slice = text.slice(payload.charOffset, payload.charOffset + payload.charLen);
    return { available: true, hash: crypto.createHash('sha256').update(slice).digest('hex') };
}

// One pass over every canonical chunk id, grouping identical vectors.
// payload.contentHash is the WHOLE-FILE hash, so a differing contentHash#splitIdx
// does not prove differing chunk text (two files can share a chunk). Groups are
// therefore classified by what the vectors were embedded from:
//   sameContent  - one contentHash#splitIdx: legitimate
//   sameText     - different files/keys, byte-identical chunk text: legitimate
//   crossContent - different chunk text under one vector: corruption (#82)
//   unverified   - some member's text could not be read: NOT proven clean
// Only members of multi-key duplicate groups are read from work/storage.
export function auditStorageSide({ ids, coll, expectedDim, storageWorkRoot, guard }) {
    if (!storageWorkRoot || !guard) throw new Error('auditStorageSide: storageWorkRoot and guard are required to verify duplicate groups');
    const byHash = new Map();
    const missing = [];
    const badDim = [];
    const nonFinite = [];
    const zeroNorm = [];
    let badDimCount = 0;
    let nonFiniteCount = 0;
    let zeroNormCount = 0;
    let present = 0;
    for (const id of ids) {
        const record = coll.get(id);
        if (!record) {
            if (missing.length < MAX_SAMPLES) missing.push(id);
            continue;
        }
        present++;
        const v = analyzeVector(record.vector, expectedDim);
        if (!v.dimOk) { badDimCount++; if (badDim.length < MAX_SAMPLES) badDim.push({ id, dim: v.dim }); }
        if (!v.finite) { nonFiniteCount++; if (nonFinite.length < MAX_SAMPLES) nonFinite.push(id); }
        if (v.finite && !v.nonzero) { zeroNormCount++; if (zeroNorm.length < MAX_SAMPLES) zeroNorm.push(id); }
        if (!v.hash) continue;
        const payload = record.payload ? JSON.parse(record.payload) : {};
        const content = payload.contentHash === undefined ? `<none>#${id}` : `${payload.contentHash}#${payload.splitIdx}`;
        const entry = { id, content, path: payload.path ?? null, payload };
        const list = byHash.get(v.hash);
        if (list) list.push(entry);
        else byHash.set(v.hash, [entry]);
    }

    let sameContentGroups = 0;
    let sameTextGroups = 0;
    let crossContentGroups = 0;
    let crossContentVectors = 0;
    let unverifiedGroups = 0;
    let unverifiedVectors = 0;
    const crossSamples = [];
    const unverifiedSamples = [];
    const brief = (e, hash) => ({ id: e.id, content: e.content, path: e.path, textSha256: hash ? hash.slice(0, 16) : null });
    for (const [hash, entries] of byHash) {
        if (entries.length < 2) continue;
        if (new Set(entries.map((e) => e.content)).size === 1) { sameContentGroups++; continue; }
        const cache = new Map();
        const resolved = entries.map((e) => ({ e, text: chunkTextHash(e.payload, storageWorkRoot, guard, cache) }));
        const unreadable = resolved.filter((r) => !r.text.available);
        if (unreadable.length > 0) {
            unverifiedGroups++;
            unverifiedVectors += entries.length;
            if (unverifiedSamples.length < MAX_SAMPLES) {
                unverifiedSamples.push({ hash: hash.slice(0, 16), count: entries.length, unreadable: unreadable.slice(0, 3).map((r) => ({ id: r.e.id, reason: r.text.reason })) });
            }
            continue;
        }
        if (new Set(resolved.map((r) => r.text.hash)).size === 1) { sameTextGroups++; continue; }
        crossContentGroups++;
        crossContentVectors += entries.length;
        if (crossSamples.length < MAX_SAMPLES) {
            crossSamples.push({ hash: hash.slice(0, 16), count: entries.length, members: resolved.slice(0, 3).map((r) => brief(r.e, r.text.hash)) });
        }
    }

    return {
        requestedIds: ids.length,
        vectorsPresent: present,
        vectorsMissing: ids.length - present,
        missingSamples: missing,
        badDimCount,
        badDimSamples: badDim,
        nonFiniteCount,
        nonFiniteSamples: nonFinite,
        zeroNormCount,
        zeroNormSamples: zeroNorm,
        distinctVectorHashes: byHash.size,
        sameContentGroups,
        sameTextGroups,
        crossContentGroups,
        crossContentVectors,
        crossContentSamples: crossSamples,
        unverifiedGroups,
        unverifiedVectors,
        unverifiedSamples
    };
}

function describe(coll) {
    return typeof coll.stats === 'function' ? coll.stats() : coll.stats;
}

function adjacentDeltas(suiteCase, old, candidate) {
    const out = {};
    for (const target of suiteCase.adjacentPaths ?? []) {
        out[target] = { old: old.adjacentRanks.final[target], candidate: candidate.adjacentRanks.final[target] };
    }
    return out;
}

function compareCase({ suiteCase, old, candidate }) {
    const oldPaths = new Set(old.final.map((r) => r.path));
    const candPaths = new Set(candidate.final.map((r) => r.path));
    const shared = [...oldPaths].filter((p) => candPaths.has(p));
    const union = new Set([...oldPaths, ...candPaths]).size;
    const targetDeltas = {};
    for (const target of suiteCase.relevantPaths ?? []) {
        const o = old.targetRanks.final[target];
        const c = candidate.targetRanks.final[target];
        targetDeltas[target] = { old: o, candidate: c, lost: o !== null && c === null, delta: o !== null && c !== null ? c - o : null };
    }
    return {
        finalOverlap: { shared: shared.length, jaccard: union === 0 ? null : shared.length / union },
        onlyOld: [...oldPaths].filter((p) => !candPaths.has(p)),
        onlyCandidate: [...candPaths].filter((p) => !oldPaths.has(p)),
        targetDeltas,
        adjacentRanks: adjacentDeltas(suiteCase, old, candidate)
    };
}

function latestRebuildReport(reportsDir) {
    if (!fs.existsSync(reportsDir)) throw new Error(`reports directory missing: ${reportsDir}`);
    const names = fs.readdirSync(reportsDir).filter((n) => /^rebuild-storage-.*\.json$/.test(n)).sort();
    if (names.length === 0) {
        throw new Error(`no rebuild-storage report in ${reportsDir}: the candidate rebuild has not finished (or is still running). Pass allowIncomplete only to inspect a partial candidate.`);
    }
    const file = path.join(reportsDir, names[names.length - 1]);
    return { file, report: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function openStorage(openNvdb, dir, label) {
    const { Database } = openNvdb();
    const db = new Database(dir);
    const collections = db.listCollections();
    if (!collections.includes('storage')) throw new Error(`${label} nVDB at ${dir} has no "storage" collection (has: ${collections.join(', ')})`);
    return { db, coll: db.getCollection('storage') };
}

export async function compareStorageCandidate(options) {
    const {
        snapshot,
        embedder: rawEmbedder,
        openNvdb,
        goldenPath = GOLDEN_PATH,
        allowIncomplete = false,
        now = () => new Date(),
        repoRoot = REPO_ROOT
    } = options || {};
    if (!snapshot) throw new Error('compareStorageCandidate: snapshot root is required');
    if (typeof openNvdb !== 'function') throw new Error('compareStorageCandidate: openNvdb loader is required');

    const startedAt = now();
    const embedder = wrapEmbedder(rawEmbedder);
    const layout = resolveSnapshotLayout(snapshot);
    const liveRoots = resolveLiveRoots(repoRoot);
    const workGuard = createSnapshotGuard(layout.workRoot, liveRoots);
    workGuard.assertNotLive(layout.root, 'snapshot root');

    const candidateRoot = path.join(layout.root, 'candidate');
    const candidateGuard = createSnapshotGuard(candidateRoot, liveRoots);
    const candidateNvdb = candidateGuard.assertWork(path.join(candidateRoot, 'nvdb'), 'candidate nVDB');
    if (!fs.existsSync(candidateNvdb)) throw new Error(`candidate nVDB missing: ${candidateNvdb}`);
    const candidateIndexPath = candidateGuard.assertWork(path.join(candidateNvdb, 'scan-index.json'), 'candidate scan-index');
    if (!fs.existsSync(candidateIndexPath)) throw new Error(`candidate scan-index missing: ${candidateIndexPath}`);
    const workNvdb = workGuard.assertWork(layout.nvdbDir, 'work nVDB');
    const workIndexPath = workGuard.assertWork(layout.scanIndexPath, 'work scan-index');
    workGuard.assertWork(layout.storageDir, 'work storage');

    const rebuild = allowIncomplete ? null : latestRebuildReport(layout.reportsDir);
    if (rebuild && rebuild.report.status !== 'ok') {
        throw new Error(`latest rebuild report ${rebuild.file} has status "${rebuild.report.status}", not "ok" (failures: ${JSON.stringify(rebuild.report.failures)})`);
    }
    if (rebuild && path.resolve(rebuild.report.candidate) !== path.resolve(candidateNvdb)) {
        throw new Error(`latest rebuild report targets ${rebuild.report.candidate}, not ${candidateNvdb}`);
    }

    const suite = loadGoldenSuite(goldenPath);
    const expectedDim = suite.dataset?.expectedEmbeddingDim ?? 2560;
    const storageTopK = suite.dataset?.storageTopK ?? 10;

    const oldIndex = JSON.parse(fs.readFileSync(workIndexPath, 'utf8'));
    const candIndex = JSON.parse(fs.readFileSync(candidateIndexPath, 'utf8'));
    const oldIds = canonicalChunkIds(oldIndex);
    const candIds = canonicalChunkIds(candIndex);
    const oldIdSet = new Set(oldIds.ids);
    const candIdSet = new Set(candIds.ids);
    const missingInCandidate = oldIds.ids.filter((id) => !candIdSet.has(id));
    const extraInCandidate = candIds.ids.filter((id) => !oldIdSet.has(id));

    const oldOpen = openStorage(openNvdb, workNvdb, 'work');
    let candOpen = null;
    const report = {
        tool: TOOL,
        version: REPORT_VERSION,
        ok: false,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        snapshot: { root: layout.root, manifestSha256: layout.manifestSha256 },
        candidate: {
            nvdb: candidateNvdb,
            scanIndexSha256: sha256File(candidateIndexPath),
            rebuildReport: rebuild ? { path: rebuild.file, status: rebuild.report.status } : { skipped: true, reason: 'allowIncomplete' }
        },
        old: { nvdb: workNvdb, scanIndexSha256: sha256File(workIndexPath) },
        golden: { path: path.resolve(goldenPath), sha256: sha256File(goldenPath), suiteVersion: suite.suiteVersion, storageCases: suite.storage.length },
        options: { expectedDim, storageTopK, allowIncomplete },
        index: {
            old: { canonicalFiles: oldIds.canonicalFiles, aliasFiles: oldIds.aliasFiles, chunkIds: oldIds.ids.length },
            candidate: { canonicalFiles: candIds.canonicalFiles, aliasFiles: candIds.aliasFiles, chunkIds: candIds.ids.length },
            missingInCandidate: { count: missingInCandidate.length, samples: missingInCandidate.slice(0, MAX_SAMPLES) },
            extraInCandidate: { count: extraInCandidate.length, samples: extraInCandidate.slice(0, MAX_SAMPLES) }
        },
        integrity: {},
        explicitVectors: {},
        cases: [],
        timings: {},
        embed: embedder.stats,
        checks: []
    };

    try {
        candOpen = openStorage(openNvdb, candidateNvdb, 'candidate');
        const sides = { old: oldOpen.coll, candidate: candOpen.coll };
        const idsBySide = { old: oldIds.ids, candidate: candIds.ids };

        for (const side of ['old', 'candidate']) {
            const stats = describe(sides[side]);
            const audit = auditStorageSide({ ids: idsBySide[side], coll: sides[side], expectedDim, storageWorkRoot: layout.storageDir, guard: workGuard });
            report.integrity[side] = {
                ...audit,
                nvdb: { config: sides[side].config, stats },
                segmentMinusPresent: stats?.totalSegmentDocs != null ? stats.totalSegmentDocs - audit.vectorsPresent : null
            };
            report.explicitVectors[side] = explicitVectorProbe({ ids: suite.explicitVectorIds ?? [], coll: sides[side], expectedDim });
        }

        for (const suiteCase of suite.storage) {
            const queryVector = await embedder.embed(suiteCase.query);
            if (!Array.isArray(queryVector) || queryVector.length !== expectedDim) {
                throw new Error(`storage case ${suiteCase.id}: query vector has dim ${queryVector?.length}, expected ${expectedDim}`);
            }
            const topK = suiteCase.top_k ?? storageTopK;
            const lane = {};
            for (const side of ['old', 'candidate']) {
                lane[side] = await storageLaneFromVector({
                    suiteCase: { ...suiteCase, top_k: suiteCase.top_k ?? storageTopK },
                    queryVector,
                    coll: sides[side],
                    storageWorkRoot: layout.storageDir,
                    guard: workGuard,
                    sourceIntent: suite.sourceIntent ?? { ownPrefixes: [], thirdPartyPrefixes: [] }
                });
            }
            report.cases.push({
                id: suiteCase.id,
                query: suiteCase.query,
                topK,
                old: lane.old,
                candidate: lane.candidate,
                comparison: compareCase({ suiteCase, old: lane.old, candidate: lane.candidate })
            });
        }
    } finally {
        for (const open of [oldOpen, candOpen]) {
            if (!open) continue;
            if (typeof open.coll.close === 'function') open.coll.close();
            if (typeof open.db.close === 'function') open.db.close();
        }
    }

    for (const side of ['old', 'candidate']) {
        report.timings[side] = durationSummary(report.cases.map((c) => c[side].timing.searchMs + c[side].timing.rankMs));
    }

    const cand = report.integrity.candidate;
    const lostTargets = report.cases.flatMap((c) => Object.entries(c.comparison.targetDeltas).filter(([, d]) => d.lost).map(([t]) => `${c.id}:${t}`));
    const check = (name, pass, detail) => report.checks.push({ name, pass, detail });
    check('candidate-no-missing-vectors', cand.vectorsMissing === 0, `${cand.vectorsMissing} missing`);
    check('candidate-index-covers-old-index', missingInCandidate.length === 0, `${missingInCandidate.length} old chunk id(s) absent from candidate index`);
    check('candidate-vectors-valid', cand.badDimCount === 0 && cand.nonFiniteCount === 0 && cand.zeroNormCount === 0, `badDim=${cand.badDimCount} nonFinite=${cand.nonFiniteCount} zeroNorm=${cand.zeroNormCount}`);
    check('candidate-no-cross-content-duplicates', cand.crossContentGroups === 0, `${cand.crossContentGroups} group(s) with different chunk text under one vector`);
    check('candidate-duplicate-groups-verified', cand.unverifiedGroups === 0, `${cand.unverifiedGroups} duplicate group(s) whose chunk text could not be read from work/storage`);
    check('candidate-five-explicit-vectors-distinct', report.explicitVectors.candidate.present === (suite.explicitVectorIds ?? []).length && report.explicitVectors.candidate.allDistinct, `present=${report.explicitVectors.candidate.present} distinct=${report.explicitVectors.candidate.distinctHashes}`);
    check('candidate-golden-targets-not-lost', lostTargets.length === 0, lostTargets.length === 0 ? 'none' : lostTargets.join(', '));
    report.ok = report.checks.every((c) => c.pass);
    report.finishedAt = now().toISOString();
    return report;
}

export function writeReport(report, reportsDir, stamp = new Date()) {
    fs.mkdirSync(reportsDir, { recursive: true });
    const file = path.join(reportsDir, `compare-storage-candidate-${stamp.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
}

export function summarize(report) {
    const fmt = (v) => (v === null || v === undefined ? 'n/a' : String(v));
    const lines = [`compare-storage-candidate  ok=${report.ok}`, `candidate  ${report.candidate.nvdb}`];
    for (const side of ['old', 'candidate']) {
        const i = report.integrity[side];
        const ex = report.explicitVectors[side];
        lines.push(`${side.padEnd(10)} ids=${i.requestedIds} present=${i.vectorsPresent} missing=${i.vectorsMissing} distinct=${i.distinctVectorHashes} crossContentGroups=${i.crossContentGroups} sameTextGroups=${i.sameTextGroups} unverifiedGroups=${i.unverifiedGroups} sameContentGroups=${i.sameContentGroups} explicit5=${ex.present}/${ex.distinctHashes} distinct p95=${report.timings[side].p95Ms}ms`);
    }
    lines.push(`index      missingInCandidate=${report.index.missingInCandidate.count} extraInCandidate=${report.index.extraInCandidate.count}`);
    for (const c of report.cases) {
        const ranks = Object.entries(c.comparison.targetDeltas).map(([t, d]) => `${t.split('/').pop()} old=${fmt(d.old)} cand=${fmt(d.candidate)}`).join('; ');
        lines.push(`case       ${c.id} jaccard=${fmt(c.comparison.finalOverlap.jaccard?.toFixed(2))} ${ranks}`);
    }
    for (const c of report.checks) lines.push(`${c.pass ? 'PASS' : 'FAIL'}       ${c.name}: ${c.detail}`);
    return lines.join('\n');
}

export function parseArgs(argv) {
    const args = { snapshot: null, allowIncomplete: false };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--snapshot') args.snapshot = argv[++i];
        else if (token.startsWith('--snapshot=')) args.snapshot = token.slice('--snapshot='.length);
        else if (token === '--allow-incomplete') args.allowIncomplete = true;
        else throw new Error(`unknown argument: ${token}`);
    }
    if (!args.snapshot) throw new Error('missing --snapshot <snapshot root>');
    return args;
}

async function createGatewayEmbedder(repoRoot) {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8'));
    const httpUrl = config.gateway?.httpUrl;
    if (!httpUrl) throw new Error('config.json gateway.httpUrl is required to embed queries');
    const client = await import(pathToFileURL(path.join(repoRoot, 'src', 'embed-client.js')).href);
    const embedClient = client.createEmbedClient(httpUrl, config.gateway?.accessKey ?? null);
    return { embed: (text) => embedClient.embed(text) };
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const report = await compareStorageCandidate({
        snapshot: args.snapshot,
        embedder: await createGatewayEmbedder(REPO_ROOT),
        openNvdb: loadNvdb,
        allowIncomplete: args.allowIncomplete
    });
    const file = writeReport(report, resolveSnapshotLayout(args.snapshot).reportsDir, new Date(report.finishedAt));
    process.stdout.write(`${summarize(report)}\n\nreport: ${file}\n`);
    if (!report.ok) process.exitCode = 1;
    return { report, file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
    main().catch((e) => {
        process.stderr.write(`${TOOL} failed: ${e.message}\n${e.stack ?? ''}\n`);
        process.exitCode = 1;
    });
}
