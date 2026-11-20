// Memory lab — clean-room STORAGE reindex runner.
//
//   node scripts/rebuild-memory-lab-storage.mjs --snapshot <root> [--resume]
//        [--max-files N] [--batch-delay-ms N] [--scan-timeout-ms N] [--fake-gateway]
//
// Builds a COMPLETELY FRESH storage collection + scan-index under
// <snapshot>\candidate\nvdb by driving the real VDB agent
// (src/agents/vdb/index.js) in a standalone process:
//
//   * the agent is initialized with context.config cloned from config.json, but
//     agents.vdb.dbPath  -> <snapshot>\candidate\nvdb
//     agents.storage.root -> <snapshot>\work\storage        (canonical text)
//     agents.vdb.indexPath -> null (derived inside the candidate dbPath)
//     agents.vdb.watch    -> { storage: { enabled: true } }
//     scanner settings (chunking, batching, ignore list, textExtensions,
//     contextEnhancement, filesPerGroup, scanTimeoutMinutes …) are preserved.
//     Only the repeating scan interval is neutralised: this is a one-shot
//     rebuild, and a periodic re-scan would re-enter while the runner flushes.
//   * the agent's own initial scan does the indexing; this runner only waits for
//     it (vdb_status until IS_SCANNING false and lastScanAt set) and then calls
//     shutdown(), which flushes the memtable to segments. No HTTP server, no
//     other agents, no timers left behind.
//
// Why a standalone agent rather than a re-implementation: the candidate must be
// produced by the ACTUAL pipeline (chunker, context enhancer, stored-vector
// guard, embedding guards, incremental scan-index). Forking that logic would
// make the candidate a second, unverified index.
//
// The only thing carried over from the old work nVDB is the
// `__enhancement_cache` collection — unchanged files then reuse the metadata
// that was already generated instead of paying for it again. That collection is
// not complete (the live cache only ever holds files that were enhanced), so it
// is BACKFILLED from the metadata the old work scan-index already stores per
// file: same `formatContextHeader` output, written as zero-vector cache records
// into the CANDIDATE cache collection. Only complete/valid metadata is seeded;
// anything else falls through to the enhancer and predicts normally. The old
// scan-index itself is read, never copied, and no old storage vector crosses
// over: creation mode proves the candidate has neither a scan-index nor a
// storage collection.
//
// Safety model (mirrors scripts/memory-lab-phase0.mjs):
//   * every path this script opens is inside the snapshot; the work tree is
//     opened READ-ONLY (the enhancement-cache copy and the metadata read are the
//     only reads) and the reference tree is never touched at all;
//   * every path is asserted outside the live data roots from config.json, so a
//     live index cannot be rebuilt, truncated or resumed by mistake;
//   * the candidate is created empty or resumed explicitly (--resume). A
//     nonempty candidate storage collection or an existing scan-index without
//     --resume is a loud failure, never a silent overwrite.
//
// `--max-files N` is a pre-flight cap assertion, not a scanner setting: the VDB
// scanner has no file cap (and this runner must not fork it), so a value below
// the discovered file count fails loud BEFORE anything is written. Smoke runs
// and fixtures use it to prove the snapshot is the small one they think it is.
//
// `--fake-gateway` (fixture/smoke only) replaces the LLM Gateway with a
// deterministic local embed/predict stub so the pipeline can be exercised
// without a running Gateway. The report records which gateway was used so a
// stub run can never be mistaken for a real one.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createGatewayClient } from '../src/gateway-client.js';
import { createEmbedClient } from '../src/embed-client.js';
import { init as initVdb, shutdown as shutdownVdb, vdb_status as vdbStatus } from '../src/agents/vdb/index.js';
import { formatContextHeader } from '../src/agents/vdb/context-enhancer.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import { resolveLiveRoots, resolveSnapshotLayout, createSnapshotGuard } from './memory-lab-phase0.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const TOOL = 'rebuild-memory-lab-storage';
export const REPORT_VERSION = 1;
export const STORAGE_COLLECTION = 'storage';
export const ENHANCEMENT_CACHE_COLLECTION = '__enhancement_cache';
const IGNORE_FILE_NAME = '.nvdb_ignore';
// The agent's scan limit (agents.vdb.scanTimeoutMinutes, or the --scan-timeout-ms
// override pushed into the cloned config) plus this margin is how long the
// runner waits for the initial scan.
const SCAN_WAIT_MARGIN_MS = 5 * 60 * 1000;

// ── primitives ───────────────────────────────────────────────────────────────

function fullPath(p) {
    return path.resolve(p);
}

function isInside(child, parent) {
    const rel = path.relative(fullPath(parent), fullPath(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realPath(p) {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Synchronous stdio: the process ends with an explicit exit() (the VDB agent
// arms an uncleared scan-timeout timer that would otherwise hold the loop for
// scanTimeoutMinutes), and async pipe writes can be truncated by that exit.
function emit(stream, line) {
    fs.writeSync(stream === 'err' ? 2 : 1, `${line}\n`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
    const args = { snapshot: null, resume: false, maxFiles: null, batchDelayMs: null, scanTimeoutMs: null, fakeGateway: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const valueOf = (name) => {
            const value = argv[++i];
            if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
            return value;
        };
        const intOf = (name) => {
            const raw = valueOf(name);
            if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
            return Number(raw);
        };
        if (arg === '--snapshot') args.snapshot = valueOf(arg);
        else if (arg === '--resume') args.resume = true;
        else if (arg === '--max-files') args.maxFiles = intOf(arg);
        else if (arg === '--batch-delay-ms') args.batchDelayMs = intOf(arg);
        else if (arg === '--scan-timeout-ms') args.scanTimeoutMs = intOf(arg);
        else if (arg === '--fake-gateway') args.fakeGateway = true;
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (!args.help && !args.snapshot) throw new Error('--snapshot <root> is required');
    return args;
}

export function usage() {
    return [
        'Usage: node scripts/rebuild-memory-lab-storage.mjs --snapshot <root> [options]',
        '',
        '  --snapshot <root>       lab snapshot root (contains manifest.json, work/, reports/)',
        '  --resume                continue an existing candidate (keeps its scan-index +',
        '                          storage vectors; unchanged files skip). Without this flag a',
        '                          nonempty candidate is a loud failure, never a silent overwrite.',
        '  --max-files N           pre-flight cap assertion (fails loud if the snapshot holds',
        '                          more text files than N). Not a scanner setting.',
        '  --batch-delay-ms N      override agents.vdb.batchDelayMs for this run',
        '  --scan-timeout-ms N     scan limit given to the VDB agent (default: agents.vdb.',
        '                          scanTimeoutMinutes). The runner waits 5 min longer so the',
        '                          agent fails first and its error is reported.',
        '  --fake-gateway          fixture/smoke only: deterministic local embed/predict stub,',
        '                          no LLM Gateway. Recorded in the report.'
    ].join('\n');
}

// ── path guards ──────────────────────────────────────────────────────────────

// Candidate guard: the candidate may only live under <snapshot>\candidate, must
// stay out of the work and reference trees, and may never resolve into a live
// data root (or escape its directory through a junction/symlink).
export function createCandidateGuard({ snapshotRoot, candidateRoot, workRoot, referenceRoot, liveRoots }) {
    const assertNotLive = (target, label) => {
        for (const live of liveRoots) {
            if (isInside(target, live)) {
                throw new Error(`${label} points into a LIVE data root and must not be touched: ${target} (live root: ${live})`);
            }
        }
    };
    const assertNotProtected = (target, label) => {
        if (workRoot && isInside(target, workRoot)) {
            throw new Error(`${label} is inside the snapshot WORK tree (work is read-only): ${target}`);
        }
        if (referenceRoot && isInside(target, referenceRoot)) {
            throw new Error(`${label} is inside the snapshot REFERENCE tree (reference is immutable): ${target}`);
        }
    };
    const guard = {
        candidateRoot: fullPath(candidateRoot),
        assertNotLive,
        assertNotProtected,
        assertCandidate(target, label) {
            const resolved = fullPath(target);
            // A live path is the most dangerous outcome, so it is named first;
            // the work/reference trees next (they must never be written), and
            // only then plain containment.
            assertNotLive(resolved, label);
            if (!isInside(resolved, snapshotRoot)) {
                throw new Error(`${label} is outside the snapshot root: ${resolved} (snapshot: ${snapshotRoot})`);
            }
            assertNotProtected(resolved, label);
            if (!isInside(resolved, guard.candidateRoot)) {
                throw new Error(`${label} is outside the candidate root: ${resolved} (candidate root: ${guard.candidateRoot})`);
            }
            if (fs.existsSync(resolved)) {
                const real = fullPath(realPath(resolved));
                if (!isInside(real, guard.candidateRoot)) {
                    throw new Error(`${label} resolves outside the candidate root (symlink escape): ${real}`);
                }
                assertNotLive(real, `${label} (resolved)`);
            }
            return resolved;
        }
    };
    // The candidate root itself must be inside the snapshot and free of the
    // protected trees, even before it exists.
    const rootResolved = fullPath(candidateRoot);
    if (!isInside(rootResolved, snapshotRoot)) {
        throw new Error(`candidate root is outside the snapshot root: ${rootResolved} (snapshot: ${snapshotRoot})`);
    }
    assertNotProtected(rootResolved, 'candidate root');
    assertNotLive(rootResolved, 'candidate root');
    return guard;
}

// Resolve and guard every path this run will touch. Throws before anything is
// read, copied or created when a path is not snapshot-scoped.
export function resolveTargets(snapshotRoot, repoRoot = REPO_ROOT) {
    if (!snapshotRoot) throw new Error('resolveTargets: snapshotRoot is required');
    const liveRoots = resolveLiveRoots(repoRoot);
    const layout = resolveSnapshotLayout(snapshotRoot);
    const root = layout.root;
    const workRoot = layout.workRoot;
    const referenceRoot = path.join(root, 'reference');
    const candidateRoot = path.join(root, 'candidate');
    const candidateNvdb = path.join(candidateRoot, 'nvdb');

    const workGuard = createSnapshotGuard(workRoot, liveRoots);
    const workNvdb = workGuard.assertWork(layout.nvdbDir, 'snapshot work nVDB');
    const workStorage = workGuard.assertWork(layout.storageDir, 'snapshot work storage');

    const candidateGuard = createCandidateGuard({ snapshotRoot: root, candidateRoot, workRoot, referenceRoot, liveRoots });
    candidateGuard.assertCandidate(candidateNvdb, 'candidate nVDB path');

    // Reports are written into the snapshot, never into work/reference/live.
    const reportsDir = fullPath(layout.reportsDir);
    if (!isInside(reportsDir, root)) throw new Error(`reports directory is outside the snapshot root: ${reportsDir}`);
    candidateGuard.assertNotProtected(reportsDir, 'reports directory');
    candidateGuard.assertNotLive(reportsDir, 'reports directory');

    return {
        repoRoot: fullPath(repoRoot),
        liveRoots,
        layout,
        root,
        workRoot,
        referenceRoot,
        candidateRoot,
        candidateNvdb,
        workNvdb,
        workStorage,
        reportsDir,
        indexPath: path.join(candidateNvdb, 'scan-index.json'),
        workScanIndexPath: path.join(workNvdb, 'scan-index.json'),
        candidateGuard,
        workGuard
    };
}

// ── candidate state ──────────────────────────────────────────────────────────

export function inspectCandidate(candidateNvdb) {
    const scanIndexPath = path.join(candidateNvdb, 'scan-index.json');
    const storageDir = path.join(candidateNvdb, STORAGE_COLLECTION);
    const enhancementCacheDir = path.join(candidateNvdb, ENHANCEMENT_CACHE_COLLECTION);
    const storageEntries = fs.existsSync(storageDir) ? fs.readdirSync(storageDir) : [];
    const storageSegmentsDir = path.join(storageDir, 'segments');
    const storageSegments = fs.existsSync(storageSegmentsDir) ? fs.readdirSync(storageSegmentsDir) : [];
    return {
        exists: fs.existsSync(candidateNvdb),
        hasScanIndex: fs.existsSync(scanIndexPath),
        hasStorageCollection: storageEntries.length > 0,
        storageSegments,
        hasEnhancementCache: fs.existsSync(enhancementCacheDir)
    };
}

// Creation must prove the candidate is clean; resume may keep what is there.
export function prepareCandidate({ candidateNvdb, resume = false }) {
    const state = inspectCandidate(candidateNvdb);
    if (resume) {
        return { mode: 'resume', state, resumeScanIndex: state.hasScanIndex, resumeStorageCollection: state.hasStorageCollection };
    }
    if (state.hasScanIndex) {
        throw new Error(
            `candidate already holds a scan-index and this run is not a resume: ${path.join(candidateNvdb, 'scan-index.json')}. `
            + 'A fresh candidate must have no old scan-index — delete the candidate directory or pass --resume.'
        );
    }
    if (state.hasStorageCollection) {
        throw new Error(
            `candidate already holds a nonempty storage collection: ${path.join(candidateNvdb, STORAGE_COLLECTION)} `
            + `(${state.storageSegments.length} segment file(s)). A fresh candidate must start with no storage collection — `
            + 'delete the candidate directory or pass --resume.'
        );
    }
    return { mode: 'create', state, resumeScanIndex: false, resumeStorageCollection: false };
}

// ── enhancement cache carry-over ─────────────────────────────────────────────

function readCollectionMeta(collectionDir) {
    const metaPath = path.join(collectionDir, 'meta.json');
    if (!fs.existsSync(metaPath)) return { docs: null, segments: null, walSeq: null };
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const segments = Array.isArray(meta.segments) ? meta.segments : null;
    return {
        docs: segments ? segments.reduce((sum, s) => sum + (Number(s.doc_count) || 0), 0) : null,
        segments: segments ? segments.length : null,
        walSeq: Number(meta.last_wal_seq) || 0
    };
}

// Copy ONLY __enhancement_cache from the work nVDB. Nothing else crosses over:
// no storage collection, no scan-index, no other collection directories.
export function copyEnhancementCache({ workNvdb, candidateNvdb, resume = false, candidateGuard = null }) {
    const source = path.join(workNvdb, ENHANCEMENT_CACHE_COLLECTION);
    const dest = path.join(candidateNvdb, ENHANCEMENT_CACHE_COLLECTION);
    if (candidateGuard) candidateGuard.assertCandidate(candidateNvdb, 'candidate nVDB path');
    if (!fs.existsSync(source)) {
        throw new Error(`enhancement cache is missing in the snapshot work nVDB: ${source} — the candidate would regenerate every file's metadata`);
    }
    const stats = readCollectionMeta(source);
    if (resume && fs.existsSync(dest)) {
        const kept = readCollectionMeta(dest);
        return { action: 'kept', source, dest, sourceDocs: stats.docs, cacheDocs: kept.docs, segments: kept.segments };
    }
    fs.mkdirSync(candidateNvdb, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    // LOCK is a 0-byte advisory file owned by the native library; a copied one
    // would be meaningless in the candidate, so it is left behind.
    fs.cpSync(source, dest, { recursive: true, filter: (src) => path.basename(src) !== 'LOCK' });
    const copied = readCollectionMeta(dest);
    // The database-level manifest must name the carried collection; the nVDB
    // Database loads this manifest on open and createCollection() appends to it.
    fs.writeFileSync(
        path.join(candidateNvdb, 'meta.json'),
        `${JSON.stringify({ version: 1, collections: [ENHANCEMENT_CACHE_COLLECTION] }, null, 2)}\n`,
        'utf8'
    );
    return { action: 'copied', source, dest, sourceDocs: stats.docs, cacheDocs: copied.docs, segments: copied.segments };
}

// vdb_status() stats every collection the agent knows about, and reading a
// collection that does not exist CREATES it. Monitoring the scan therefore
// leaves an empty `memory` collection in the candidate; the rebuild never
// indexes it, so it is removed rather than left to look like provenance. A
// non-default collection holding data is a loud error — that would mean
// something wrote vectors this runner did not intend.
export function pruneMonitorCollections(candidateNvdb) {
    const removed = [];
    if (!fs.existsSync(candidateNvdb)) return removed;
    for (const entry of fs.readdirSync(candidateNvdb, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === STORAGE_COLLECTION || entry.name === ENHANCEMENT_CACHE_COLLECTION) continue;
        const dir = path.join(candidateNvdb, entry.name);
        const meta = readCollectionMeta(dir);
        if ((meta.docs ?? 0) > 0 || meta.walSeq > 0) {
            throw new Error(
                `candidate holds an unexpected collection "${entry.name}" with data `
                + `(${meta.docs ?? 'unknown'} doc(s), wal seq ${meta.walSeq}) — refusing to present it as a clean-room candidate`
            );
        }
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(entry.name);
    }
    if (removed.length > 0) {
        const metaPath = path.join(candidateNvdb, 'meta.json');
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            meta.collections = (meta.collections || []).filter((name) => !removed.includes(name));
            fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
        }
    }
    return removed;
}

// ── enhancement cache backfill from work metadata ───────────────────────────
// The copied cache only holds files the live run happened to enhance, so a full
// rebuild would still ask the local model for the rest and could produce
// different metadata for the same bytes. The work scan-index already stores the
// metadata that went into every file's embedding header, so it is the exact
// source: same fields, same formatContextHeader output, zero-vector cache record
// under the file's contentHash — the identical record the enhancer would have
// written. The scan-index is read; nothing from it is copied into the candidate.

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/i;

// Only metadata that is complete enough to reproduce the header is seeded;
// anything else returns null and that file may predict normally.
export function cacheableMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    if (metadata.contextEnhanced !== true) return null;
    const summary = typeof metadata.summary === 'string' ? metadata.summary.trim() : '';
    const docType = typeof metadata.docType === 'string' ? metadata.docType.trim() : '';
    if (!summary || !docType) return null;
    if (!Array.isArray(metadata.keywords) || !Array.isArray(metadata.entities)) return null;
    const keywords = metadata.keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim());
    const entities = metadata.entities.filter((entity) => typeof entity === 'string' && entity.trim());
    if (keywords.length !== metadata.keywords.length || entities.length !== metadata.entities.length) return null;
    const meta = { summary, keywords, entities, docType };
    // A header-less record would be a cache hit that changes the embedding
    // input, so it is not seeded at all.
    if (!formatContextHeader(meta)) return null;
    return meta;
}

export function seedEnhancementCache({ workScanIndexPath, candidateNvdb, embeddingDim, discoveredPaths, candidateGuard = null }) {
    if (!Array.isArray(discoveredPaths)) throw new Error('seedEnhancementCache: discoveredPaths must be an array of work-relative file paths');
    if (candidateGuard) candidateGuard.assertCandidate(candidateNvdb, 'candidate nVDB path');
    if (!fs.existsSync(workScanIndexPath)) {
        throw new Error(`work scan-index is missing: ${workScanIndexPath} — the enhancement cache cannot be backfilled from it`);
    }
    const workIndex = JSON.parse(fs.readFileSync(workScanIndexPath, 'utf8'));
    const indexEntries = Object.values(workIndex.files || {});
    // Every discovered file only needs ONE record, keyed by content hash, so
    // duplicates (aliases) are folded onto their canonical entry.
    const entryByPath = new Map();
    for (const entry of indexEntries) {
        if (typeof entry.path !== 'string') continue;
        const known = entryByPath.get(entry.path);
        if (!known || (known.duplicateOf && !entry.duplicateOf)) entryByPath.set(entry.path, entry);
    }

    const { Database } = loadNvdb();
    const db = new Database(candidateNvdb);
    const coll = db.getCollection(ENHANCEMENT_CACHE_COLLECTION);
    const zeroVector = new Array(embeddingDim).fill(0);
    const stats = { reused: 0, seeded: 0, missing: 0, invalidMetadata: 0, notInWorkIndex: 0 };
    try {
        for (const relPath of discoveredPaths) {
            const entry = entryByPath.get(relPath);
            if (!entry) {
                // The work index never saw this file: it has no metadata to reuse.
                stats.notInWorkIndex++;
                continue;
            }
            const contentHash = typeof entry.contentHash === 'string' ? entry.contentHash.toLowerCase() : '';
            if (!CONTENT_HASH_RE.test(contentHash)) {
                stats.missing++;
                stats.invalidMetadata++;
                continue;
            }
            if (coll.get(contentHash)) {
                stats.reused++;
                continue;
            }
            const meta = cacheableMetadata(entry.metadata);
            if (!meta) {
                stats.missing++;
                stats.invalidMetadata++;
                continue;
            }
            coll.insert(contentHash, zeroVector, JSON.stringify({ meta, header: formatContextHeader(meta) }));
            stats.seeded++;
        }
        coll.flush();
    } finally {
        // The agent init() re-opens this collection in this same process; an
        // exclusive collection lock held here would make that init fail.
        coll.close();
        db.close();
    }
    return {
        sourceIndex: workScanIndexPath,
        workIndexEntries: indexEntries.filter((entry) => !entry.duplicateOf).length,
        discoveredFiles: discoveredPaths.length,
        ...stats,
        // Files that will still ask the model: no usable metadata in the work
        // index, plus everything the work index has never seen.
        willPredict: stats.missing + stats.notInWorkIndex
    };
}

// ── agent config clone ──────────────────────────────────────────────────────

// One-shot run: the repeating scanner is neutralised (the interval is the one
// setting that cannot be preserved). Everything that shapes the index —
// chunking, batching, textExtensions, ignore, contextEnhancement, filesPerGroup,
// embeddingDim and the default scanTimeoutMinutes — is carried from config.json;
// an explicit scanTimeoutMs overrides only that scan limit. A
// periodic re-scan has nothing to add to a single rebuild and would re-enter
// while the runner is flushing the memtable at shutdown. The value stays inside
// Node's 32-bit setTimeout limit (~24.8 days): anything larger overflows and
// Node fires the timer after 1 ms, which would start a second scan instantly.
export const ONE_SHOT_SCAN_INTERVAL_MINUTES = 60 * 24 * 20; // 20 days

export function buildAgentConfig(baseConfig, { candidateNvdb, workStorage, batchDelayMs = null, scanTimeoutMs = null }) {
    if (!baseConfig?.agents?.vdb) throw new Error('config.json has no agents.vdb section');
    if (scanTimeoutMs !== null && (!Number.isFinite(scanTimeoutMs) || scanTimeoutMs <= 0)) {
        throw new Error(`buildAgentConfig: scanTimeoutMs must be a positive number (got ${scanTimeoutMs})`);
    }
    const config = JSON.parse(JSON.stringify(baseConfig));
    config.agents.storage = { ...(config.agents.storage || {}), root: workStorage };
    config.agents.vdb = {
        ...config.agents.vdb,
        dbPath: candidateNvdb,
        // Derived from dbPath by the agent; an absolute indexPath in config
        // would point the candidate at the live index.
        indexPath: null,
        scanIntervalMinutes: ONE_SHOT_SCAN_INTERVAL_MINUTES,
        // This tool drives its own scan against the candidate; the delta
        // reconciler must never compete with it.
        delta: { ...(config.agents.vdb.delta || {}), enabled: false },
        watch: { [STORAGE_COLLECTION]: { enabled: true } }
    };
    if (batchDelayMs !== null && batchDelayMs !== undefined) config.agents.vdb.batchDelayMs = batchDelayMs;
    // The agent enforces its own scan limit; an explicit override must reach it,
    // otherwise the agent times out at the configured value while the runner waits longer.
    if (scanTimeoutMs !== null) config.agents.vdb.scanTimeoutMinutes = scanTimeoutMs / 60000;
    return config;
}

// The agent's scan limit (what withTimeout enforces) in ms; the runner waits
// SCAN_WAIT_MARGIN_MS longer so the agent always fails first, with a lastScanError.
export function effectiveScanLimitMs(config) {
    return (config.agents.vdb.scanTimeoutMinutes ?? 30) * 60 * 1000;
}

// Assert the resolved agent paths are exactly the ones this run intends, before
// the agent opens anything. Guards the two ways a config clone can go wrong:
// a live path surviving the clone, and a derived path escaping the candidate.
export function assertAgentConfig(config, paths) {
    const vdb = config.agents.vdb;
    if (fullPath(vdb.dbPath) !== fullPath(paths.candidateNvdb)) {
        throw new Error(`agents.vdb.dbPath must resolve to the candidate nVDB: ${vdb.dbPath} (expected ${paths.candidateNvdb})`);
    }
    if (fullPath(config.agents.storage.root) !== fullPath(paths.workStorage)) {
        throw new Error(`agents.storage.root must resolve to the snapshot work storage: ${config.agents.storage.root} (expected ${paths.workStorage})`);
    }
    if (vdb.indexPath) {
        throw new Error(`agents.vdb.indexPath must be null so the scan-index lands in the candidate (got ${vdb.indexPath})`);
    }
    const watched = Object.keys(vdb.watch || {});
    if (watched.length !== 1 || watched[0] !== STORAGE_COLLECTION || vdb.watch[STORAGE_COLLECTION]?.enabled === false) {
        throw new Error(`the candidate run watches exactly one collection: ${STORAGE_COLLECTION} (got ${JSON.stringify(vdb.watch)})`);
    }
    paths.candidateGuard.assertCandidate(vdb.dbPath, 'agents.vdb.dbPath');
    paths.workGuard.assertWork(config.agents.storage.root, 'agents.storage.root');
    return {
        dbPath: fullPath(vdb.dbPath),
        storageRoot: fullPath(config.agents.storage.root),
        indexPath: path.join(fullPath(vdb.dbPath), 'scan-index.json'),
        embeddingDim: vdb.embeddingDim,
        batchDelayMs: vdb.batchDelayMs,
        scanIntervalMinutes: vdb.scanIntervalMinutes,
        watch: watched
    };
}

// ── file discovery (cap guard + completeness report) ─────────────────────────
// NOT a scanner: the VDB agent enumerates and indexes; this walk only answers
// "how many text files does the snapshot hold" for the --max-files assertion and
// "which of them has no scan-index entry" for the report. It mirrors the
// agent's two config rules (textExtensions, ignore) plus per-directory
// .nvdb_ignore files, which is what keeps the two lists comparable.

function matchIgnorePattern(name, pattern) {
    if (pattern === '*') return true;
    if (pattern.includes('*') || pattern.includes('?')) {
        const regex = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        return regex.test(name);
    }
    return name === pattern;
}

export function enumerateTextFiles(root, { textExtensions, ignore } = {}) {
    if (!Array.isArray(textExtensions) || textExtensions.length === 0) {
        throw new Error('enumerateTextFiles: textExtensions is required (agents.vdb.textExtensions)');
    }
    if (!fs.existsSync(root)) throw new Error(`enumerateTextFiles: storage root missing: ${root}`);
    const extensions = new Set(textExtensions.map((ext) => ext.toLowerCase()));
    const relPaths = [];
    const walkDir = (dir) => {
        const patterns = [...(ignore || [])];
        const ignoreFile = path.join(dir, IGNORE_FILE_NAME);
        if (fs.existsSync(ignoreFile)) {
            for (const line of fs.readFileSync(ignoreFile, 'utf8').split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) patterns.push(trimmed);
            }
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === IGNORE_FILE_NAME) continue;
            if (patterns.some((pattern) => matchIgnorePattern(entry.name, pattern))) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walkDir(full);
            else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
                relPaths.push(path.relative(root, full).split(path.sep).join('/'));
            }
        }
    };
    walkDir(root);
    return { count: relPaths.length, relPaths };
}

// ── gateways ─────────────────────────────────────────────────────────────────

function gatewayConfig(baseConfig) {
    return {
        wsUrl: process.env.GATEWAY_URL || baseConfig.gateway?.wsUrl || 'ws://localhost:3400/v1/realtime',
        httpUrl: process.env.GATEWAY_HTTP_URL || baseConfig.gateway?.httpUrl || 'http://localhost:3400',
        accessKey: process.env.GATEWAY_ACCESS_KEY || baseConfig.gateway?.accessKey || null
    };
}

// Same wiring as src/server.js; the Gateway must already be running.
export function createRealGateway(baseConfig) {
    const { wsUrl, httpUrl, accessKey } = gatewayConfig(baseConfig);
    const embedUrl = process.env.EMBED_URL || httpUrl;
    const embedClient = createEmbedClient(embedUrl, accessKey);
    return createGatewayClient(wsUrl, httpUrl, accessKey, embedClient);
}

// Deterministic stub: distinct text -> distinct unit-ish vector of the
// configured dimension, and stable metadata. Counts calls so a test can prove
// the enhancement cache actually suppressed a predict().
export function createFakeGateway(dimension) {
    if (!Number.isInteger(dimension) || dimension <= 0) throw new Error(`createFakeGateway: invalid dimension ${dimension}`);
    const vectorFor = (text) => {
        const out = new Array(dimension);
        let block = crypto.createHash('sha256').update(String(text), 'utf8').digest();
        for (let i = 0; i < dimension; i++) {
            if (i > 0 && i % 32 === 0) block = crypto.createHash('sha256').update(block).update(String(i)).digest();
            out[i] = (block[i % 32] / 255) - 0.5;
        }
        return out;
    };
    const stats = { predictCalls: 0, embedCalls: 0, embedTexts: 0 };
    return {
        stats,
        connected: true,
        async embed(text) {
            stats.embedCalls++;
            stats.embedTexts++;
            return vectorFor(text);
        },
        async embedText(text) {
            return this.embed(text);
        },
        async embedBatch(texts) {
            stats.embedCalls++;
            stats.embedTexts += texts.length;
            return texts.map(vectorFor);
        },
        async embedBatchBackground(texts) {
            return this.embedBatch(texts);
        },
        async predict({ prompt }) {
            stats.predictCalls++;
            const filePath = /File path: (.*)/.exec(prompt || '')?.[1] || 'unknown';
            return {
                summary: `stub metadata for ${filePath}`,
                keywords: ['stub', 'fixture', 'rebuild'],
                entities: [],
                docType: 'note'
            };
        },
        async chat() {
            return { content: '{"summary":"stub","keywords":[],"entities":[],"docType":"note"}' };
        },
        async listModels() {
            return [];
        }
    };
}

// ── scan wait ────────────────────────────────────────────────────────────────

async function readStatus() {
    const result = await vdbStatus();
    return JSON.parse(result.content[0].text);
}

// The agent starts its initial scan ~2 s after init (setTimeout in init()) and
// sets LAST_SCAN_AT only when a scan finishes. Nothing else in this standalone
// process can set it, so "lastScanAt set and not scanning" is the completion
// signal. A failed scan (e.g. the agent's own scan timeout) never sets
// LAST_SCAN_AT; it sets lastScanError, which is thrown at once instead of
// being polled until this runner's own deadline.
export async function waitForInitialScan({ timeoutMs, pollMs = 250 }) {
    const deadline = Date.now() + timeoutMs;
    let sawScanning = false;
    let last = null;
    while (Date.now() < deadline) {
        last = await readStatus();
        if (last.lastScanError) {
            throw new Error(`initial scan failed: ${last.lastScanError} (lastScanStats=${JSON.stringify(last.lastScanStats)})`);
        }
        if (last.isScanning) sawScanning = true;
        else if (last.lastScanAt) return { status: last, sawScanning };
        await sleep(pollMs);
    }
    throw new Error(
        `initial scan did not complete within ${Math.round(timeoutMs / 1000)}s `
        + `(isScanning=${last?.isScanning}, lastScanAt=${last?.lastScanAt ?? 'null'}, `
        + `lastScanStats=${JSON.stringify(last?.lastScanStats)})`
    );
}

// ── run ──────────────────────────────────────────────────────────────────────

function timestampSlug(date) {
    return date.toISOString().replace(/[:.]/g, '-');
}

function writeReport(reportsDir, name, report) {
    fs.mkdirSync(reportsDir, { recursive: true });
    const file = path.join(reportsDir, name);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return file;
}

export async function runRebuild({
    snapshotRoot,
    resume = false,
    maxFiles = null,
    batchDelayMs = null,
    scanTimeoutMs = null,
    fakeGateway = process.env.MEMORY_LAB_FAKE_GATEWAY === '1',
    gatewayFactory = null,
    pollMs = 250,
    repoRoot = REPO_ROOT
} = {}) {
    if (!snapshotRoot) throw new Error('runRebuild: snapshotRoot is required');
    if (maxFiles !== null && (!Number.isInteger(maxFiles) || maxFiles <= 0)) {
        throw new Error(`runRebuild: maxFiles must be a positive integer (got ${maxFiles})`);
    }
    const startedAt = new Date();
    const startedMs = Date.now();
    const paths = resolveTargets(snapshotRoot, repoRoot);

    const baseConfig = JSON.parse(fs.readFileSync(path.join(paths.repoRoot, 'config.json'), 'utf8'));

    // 1. discovery + cap assertion — before anything is written, so a refused
    //    --max-files leaves the snapshot exactly as it was.
    const discovery = enumerateTextFiles(paths.workStorage, {
        textExtensions: baseConfig.agents.vdb.textExtensions,
        ignore: baseConfig.agents.vdb.ignore || []
    });
    if (maxFiles !== null && discovery.count > maxFiles) {
        throw new Error(
            `--max-files ${maxFiles} refused: the snapshot work storage holds ${discovery.count} text file(s), `
            + 'so this is not the small run the cap was meant to guard. Nothing was written.'
        );
    }

    // 2. creation/resume proof, before anything is written.
    const candidate = prepareCandidate({ candidateNvdb: paths.candidateNvdb, resume });

    // 3. carry the enhancement cache only.
    const enhancementCache = copyEnhancementCache({
        workNvdb: paths.workNvdb,
        candidateNvdb: paths.candidateNvdb,
        resume,
        candidateGuard: paths.candidateGuard
    });

    // 4. backfill the cache from the metadata the work scan-index already holds,
    //    so unchanged files keep their exact embedding headers instead of asking
    //    the model again. The work scan-index is read; it is never copied.
    const cacheSeeding = seedEnhancementCache({
        workScanIndexPath: paths.workScanIndexPath,
        candidateNvdb: paths.candidateNvdb,
        embeddingDim: baseConfig.agents.vdb.embeddingDim,
        discoveredPaths: discovery.relPaths,
        candidateGuard: paths.candidateGuard
    });
    enhancementCache.seeding = cacheSeeding;

    // 5. config clone + path assertions.
    const config = buildAgentConfig(baseConfig, {
        candidateNvdb: paths.candidateNvdb,
        workStorage: paths.workStorage,
        batchDelayMs,
        scanTimeoutMs
    });
    const resolved = assertAgentConfig(config, paths);

    // 6. gateway + standalone agent init.
    const dimension = config.agents.vdb.embeddingDim;
    const gateway = gatewayFactory ? gatewayFactory({ config }) : (fakeGateway ? createFakeGateway(dimension) : createRealGateway(config));
    let initResult;
    try {
        initResult = await initVdb({ config, gateway });
    } catch (error) {
        throw new Error(`VDB agent init failed: ${error.message}`);
    }
    if (!initResult || initResult.enabled !== true) {
        throw new Error(`VDB agent did not initialize: ${JSON.stringify(initResult)}`);
    }
    if (fullPath(initResult.dbPath) !== fullPath(paths.candidateNvdb)) {
        throw new Error(`VDB agent opened ${initResult.dbPath}, expected the candidate ${paths.candidateNvdb}`);
    }

    // 7. wait for the agent's own initial scan, then flush and stop the timer.
    const waitMs = effectiveScanLimitMs(config) + SCAN_WAIT_MARGIN_MS;
    const scanWait = await waitForInitialScan({ timeoutMs: waitMs, pollMs });
    await shutdownVdb(); // flushes memtable -> segments and clears the scan timer
    const finalStatus = await readStatus();
    // The status read above created every collection the agent knows about;
    // the empty extras it left behind are removed so the candidate carries only
    // the storage collection and the carried enhancement cache.
    const prunedCollections = pruneMonitorCollections(paths.candidateNvdb);

    // 8. index analysis + loud assertions about what landed in the candidate.
    if (!fs.existsSync(paths.indexPath)) {
        throw new Error(`candidate scan-index was not written: ${paths.indexPath}`);
    }
    const index = JSON.parse(fs.readFileSync(paths.indexPath, 'utf8'));
    const indexEntries = Object.values(index.files || {});
    const canonicalEntries = indexEntries.filter((entry) => !entry.duplicateOf);
    const aliases = indexEntries.length - canonicalEntries.length;
    const expectedVectors = canonicalEntries.reduce((sum, entry) => sum + (entry.chunks || 0), 0);
    const storageCollection = finalStatus.collections?.[STORAGE_COLLECTION];
    const collectionDocs = storageCollection?.docs ?? null;
    if (collectionDocs === null) {
        throw new Error(`candidate storage collection is unreadable after the scan: ${JSON.stringify(storageCollection)}`);
    }

    const foreignSources = canonicalEntries
        .filter((entry) => !entry.absolutePath || !isInside(entry.absolutePath, paths.workStorage))
        .map((entry) => entry.absolutePath ?? `(no absolutePath) ${entry.path}`);
    if (foreignSources.length > 0) {
        throw new Error(
            `candidate vectors were built from sources outside the snapshot work storage: ${foreignSources.slice(0, 5).join(', ')}`
            + `${foreignSources.length > 5 ? ` (+${foreignSources.length - 5} more)` : ''}`
        );
    }

    const indexedDocIds = new Set(Object.keys(index.files || {}));
    const notIndexed = discovery.relPaths.filter((relPath) => !indexedDocIds.has(`${STORAGE_COLLECTION}:${relPath}`));
    const scanStats = scanWait.status.lastScanStats || finalStatus.lastScanStats || {};

    const failures = [];
    if (scanStats.errors > 0) failures.push(`${scanStats.errors} file(s) failed during the scan`);
    if (scanStats.pending > 0) failures.push(`${scanStats.pending} file(s) still pending embedding`);
    if (collectionDocs !== expectedVectors) failures.push(`collection holds ${collectionDocs} vector(s) but the scan-index expects ${expectedVectors}`);

    const finishedAt = new Date();
    const report = {
        tool: TOOL,
        reportVersion: REPORT_VERSION,
        // A candidate whose scan reported file failures is NOT a clean-room
        // index: 'incomplete' is stated, never smoothed over into 'ok'.
        status: failures.length > 0 ? 'incomplete' : 'ok',
        gateway: gatewayFactory ? 'injected' : (fakeGateway ? 'fake' : 'real'),
        mode: candidate.mode,
        snapshot: paths.root,
        candidate: paths.candidateNvdb,
        candidateStorageCollection: path.join(paths.candidateNvdb, STORAGE_COLLECTION),
        candidateScanIndex: paths.indexPath,
        workStorage: paths.workStorage,
        workNvdb: paths.workNvdb,
        watch: resolved.watch,
        batchDelayMs: resolved.batchDelayMs,
        scanIntervalMinutes: resolved.scanIntervalMinutes,
        embeddingDim: resolved.embeddingDim,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedMs,
        creation: candidate.mode === 'create'
            ? { proof: { scanIndexPresent: false, storageCollectionPresent: false }, observed: candidate.state }
            : { resume: { scanIndexPresent: candidate.resumeScanIndex, storageCollectionPresent: candidate.resumeStorageCollection }, observed: candidate.state },
        enhancementCache,
        // Cache coverage accounting (files the work index knows about):
        // reused = record already in the copied cache, seeded = written from the
        // work scan-index metadata, missing = no record and no usable metadata
        // (that file will predict normally).
        cacheReused: cacheSeeding.reused,
        cacheSeeded: cacheSeeding.seeded,
        cacheMissing: cacheSeeding.missing,
        prunedCollections,
        discovery: { textFiles: discovery.count, maxFiles, failedFiles: notIndexed },
        scan: {
            added: scanStats.added ?? 0,
            updated: scanStats.updated ?? 0,
            removed: scanStats.removed ?? 0,
            skipped: scanStats.skipped ?? 0,
            errors: scanStats.errors ?? 0,
            pending: scanStats.pending ?? 0,
            lastScanAt: scanWait.status.lastScanAt,
            sawScanning: scanWait.sawScanning,
            waitedMs: waitMs
        },
        collections: finalStatus.collections,
        index: {
            files: indexEntries.length,
            canonicalFiles: canonicalEntries.length,
            aliasFiles: aliases,
            chunks: expectedVectors,
            collectionDocs,
            vectorsMatchIndex: collectionDocs === expectedVectors
        },
        gatewayStats: gateway.stats ? { ...gateway.stats } : null,
        failures
    };
    report.reportPath = writeReport(paths.reportsDir, `rebuild-storage-${timestampSlug(startedAt)}.json`, report);
    return report;
}

// ── CLI entry ────────────────────────────────────────────────────────────────

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (error) {
        emit('err', `[rebuild] ${error.message}`);
        emit('err', usage());
        process.exit(2);
    }
    if (args.help) {
        emit('out', usage());
        process.exit(0);
    }

    const startedAt = new Date();
    try {
        const report = await runRebuild({
            snapshotRoot: args.snapshot,
            resume: args.resume,
            maxFiles: args.maxFiles,
            batchDelayMs: args.batchDelayMs,
            scanTimeoutMs: args.scanTimeoutMs,
            fakeGateway: args.fakeGateway || process.env.MEMORY_LAB_FAKE_GATEWAY === '1'
        });
        emit('out', `[rebuild] candidate: ${report.candidate} (${report.mode})`);
        emit('out', `[rebuild] files: added=${report.scan.added} skipped=${report.scan.skipped} errors=${report.scan.errors} pending=${report.scan.pending}`);
        emit('out', `[rebuild] collection: docs=${report.index.collectionDocs} chunks=${report.index.chunks} alias=${report.index.aliasFiles} match=${report.index.vectorsMatchIndex}`);
        emit('out', `[rebuild] enhancement cache: ${report.enhancementCache.action} (${report.enhancementCache.cacheDocs ?? '?'} doc(s))`);
        emit('out', `[rebuild] cache coverage: reused=${report.cacheReused} seeded=${report.cacheSeeded} missing=${report.cacheMissing} (will predict ≈${report.enhancementCache.seeding.willPredict})`);
        emit('out', `[rebuild] duration: ${(report.durationMs / 1000).toFixed(1)}s`);
        if (report.failures.length > 0) for (const failure of report.failures) emit('err', `[rebuild] warning: ${failure}`);
        emit('out', `[rebuild] report: ${report.reportPath}`);
        if (report.status !== 'ok') {
            emit('err', `[rebuild] candidate is ${report.status}: ${report.failures.length} failure(s) — resolve them, then re-run with --resume`);
            process.exit(1);
        }
        process.exit(0);
    } catch (error) {
        const message = error?.stack || String(error);
        // A failure report is a deliverable: it lives under snapshot/reports
        // when the snapshot itself is resolvable, and never inside work.
        try {
            const paths = resolveTargets(args.snapshot);
            const file = writeReport(paths.reportsDir, `rebuild-storage-${timestampSlug(startedAt)}.json`, {
                tool: TOOL,
                reportVersion: REPORT_VERSION,
                status: 'failed',
                gateway: args.fakeGateway ? 'fake' : 'real',
                mode: args.resume ? 'resume' : 'create',
                snapshot: paths.root,
                candidate: paths.candidateNvdb,
                workStorage: paths.workStorage,
                startedAt: startedAt.toISOString(),
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - startedAt.getTime(),
                error: error?.message ?? String(error),
                stack: message
            });
            emit('err', `[rebuild] failure report: ${file}`);
        } catch (reportError) {
            emit('err', `[rebuild] could not write a failure report: ${reportError.message}`);
        }
        emit('err', `[rebuild] FAILED: ${message}`);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
    main();
}
