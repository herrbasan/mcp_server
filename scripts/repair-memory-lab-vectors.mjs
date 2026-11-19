// Lab-only vector repair utility for a memory-refactor snapshot.
//
//   node scripts/repair-memory-lab-vectors.mjs --snapshot D:\MCP_Lab\memory-refactor\<name> [--apply] [--storage-only|--memory-only]
//
// Default (no --apply) is AUDIT + PROBE: it never writes to a database. The
// probe re-embeds ONLY the five golden explicit storage chunks TWICE — once as a
// single batch of five (the production indexing shape) and once as five
// sequential single requests — and reports per-input hashes, stored-vector
// collisions and batch-vs-single equality/cosine for each mode. Every distinct
// stored collision OWNER is then re-embedded sequentially as well, which decides
// which side of a collision is stale: fresh candidate == fresh owner means the
// CURRENT provider duplicates (current-provider-faulty); fresh candidate !=
// fresh owner while the stored vectors still collide means the stored owner holds
// old corruption and must be repaired together with the candidate
// (stored-owner-corrupt). Nothing is inserted.
//
// With --apply it repairs every SUSPICIOUS record (see below) in the work copy:
// the new vector is embedded with the same guarded client, validated as a set,
// checked against the WHOLE audited population (a byte-identical vector already
// stored for a different input is a provider duplicate, never a legitimate
// repair), and only then written with the ORIGINAL payload. Probe-adjudicated
// stored-owner corruption (classification 'stored-owner-corrupt') is REPAIRABLE:
// those owners are added to the same write plan with their original payload and
// reconstructed current input, so candidate and owner are fixed together and the
// post-reaudit can reach zero suspicious groups. A live provider fault
// ('current-provider-faulty') or an undetermined collision still refuses every
// write. One recorded re-embed retry covers an intermittent provider duplicate,
// and one recorded transient-fetch retry covers a dropped connection. The work
// copy is flushed and closed; a timestamped before/after report pair is written
// under <snapshot>\reports. scan-index content hashes and the memory nDB content/
// status are never touched.
//
// Damage definition (deliberate, so legitimate duplicates are never "repaired"):
//   storage  chunks are grouped by full Float64 SHA-256 of the stored vector. A
//            group is suspicious ONLY when its records carry different
//            payload.contentHash values — two chunks with identical content
//            legitimately embed identically.
//   memory   active mem_ documents are grouped the same way; a group is
//            suspicious ONLY when the computed embed inputs (description plus
//            serialized data, truncated like production) differ.
//
// Safety model (mirrors scripts/memory-lab-phase0.mjs / validate-memory-lab.mjs):
//   * only <snapshot>\work is opened, every path is asserted inside it and
//     outside every live data root AND outside <snapshot>\reference;
//   * payload.absolutePath is NEVER followed — chunk source text is read from
//     the work copy of storage through payload.path + charOffset/charLen;
//   * the memory nDB journal is opened from a SCRATCH COPY under
//     <snapshot>\scratch\repair-<pid> (createTextIndex rewrites an .fti cache)
//     and teardown refuses to delete anything outside that scratch area;
//   * no agent init(), no timers, no scanners, no service start.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import {
    analyzeVector,
    assertScratchLocation,
    chunkIdsFromScanIndex,
    createSnapshotGuard,
    loadGoldenSuite,
    removeScratch,
    resolveLiveRoots,
    resolveScratchArea,
    resolveSnapshotLayout,
    sha256File,
    vectorHash,
    isTransientFetchError
} from './memory-lab-phase0.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GOLDEN_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'memory-lab-phase0-golden.json');

export const TOOL = 'repair-memory-lab-vectors';
export const REPORT_VERSION = 1;
export const REPAIR_BATCH_SIZE = 8;
export const MEMORY_INPUT_MAX_CHARS = 6000;
export const EXPLICIT_VECTOR_COUNT = 5;
// Owner re-embeds are sequential and only for actual collisions; the cap keeps a
// pathological index from turning the probe into a long run. Anything skipped is
// reported and blocks repair as 'undetermined'.
export const MAX_OWNER_PROBES = 200;
export const MAX_RECORDED_PAIRS = 50;

// ── primitives ───────────────────────────────────────────────────────────────

function fullPath(p) {
    return path.resolve(p);
}

function isInside(child, parent) {
    const rel = path.relative(fullPath(parent), fullPath(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function sha256Text(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// The lab guard, plus the reference tree: the snapshot's reference copy is a
// baseline artefact and is never opened by this tool, not even for reading.
export function createRepairGuard({ workRoot, referenceRoot, liveRoots }) {
    if (!workRoot) throw new Error('createRepairGuard: workRoot is required');
    if (!Array.isArray(liveRoots) || liveRoots.length === 0) {
        throw new Error('createRepairGuard: liveRoots must be a non-empty array of live data roots');
    }
    const base = createSnapshotGuard(workRoot, liveRoots);
    return {
        assertNotLive: base.assertNotLive,
        assertWork(target, label) {
            const resolved = fullPath(target);
            if (referenceRoot && isInside(resolved, referenceRoot)) {
                throw new Error(`${label} points into the REFERENCE tree and must not be opened: ${resolved}`);
            }
            return base.assertWork(resolved, label);
        }
    };
}

// ── embed-input reconstruction (production parity) ───────────────────────────

// Verbatim from src/agents/vdb/context-enhancer.js formatHeader().
export function formatContextHeader(meta = {}) {
    const keywords = Array.isArray(meta.keywords) ? meta.keywords.join(', ') : '';
    const entities = Array.isArray(meta.entities) ? meta.entities.join(', ') : '';
    const parts = [
        meta.docType ? `Type: ${meta.docType}` : '',
        keywords ? `Keywords: ${keywords}` : '',
        entities ? `Entities: ${entities}` : '',
        meta.summary ? `Summary: ${meta.summary}` : ''
    ].filter(Boolean);
    if (parts.length === 0) return '';
    return `[${parts.join(' | ')}]\n\n`;
}

// Storage chunk embed text = context header + the exact source slice. The slice
// is read from the WORK copy of storage (payload.path), never payload.absolutePath.
export function reconstructStorageChunk({ payload, storageWorkRoot, guard = null }) {
    if (!payload || typeof payload !== 'object') return { available: false, reason: 'record has no payload object' };
    if (typeof payload.path !== 'string' || payload.path.length === 0) return { available: false, reason: 'payload has no path' };
    if (!Number.isInteger(payload.charOffset) || !Number.isInteger(payload.charLen) || payload.charLen <= 0) {
        return { available: false, reason: 'payload has no integer charOffset/charLen' };
    }
    const target = path.join(storageWorkRoot, payload.path.split('/').join(path.sep));
    if (guard) {
        try {
            guard.assertWork(target, `storage chunk source ${payload.path}`);
        } catch (e) {
            return { available: false, reason: `guard refused source: ${e.message}` };
        }
    }
    if (!fs.existsSync(target)) return { available: false, reason: 'work copy file missing', workPath: target };
    const source = fs.readFileSync(target, 'utf8');
    const end = payload.charOffset + payload.charLen;
    if (end > source.length) {
        return { available: false, reason: `char range ${payload.charOffset}+${payload.charLen} exceeds source length ${source.length}`, workPath: target };
    }
    const chunkText = source.slice(payload.charOffset, end);
    if (chunkText.trim().length === 0) return { available: false, reason: 'source slice is empty', workPath: target };
    const header = formatContextHeader(payload);
    return {
        available: true,
        workPath: target,
        sourcePath: payload.path,
        header,
        chunkText,
        embedText: header + chunkText
    };
}

// Verbatim from src/agents/memory/index.js serializeData().
export function serializeMemoryData(data) {
    if (data == null || data === '') return '';
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

// Verbatim from src/agents/memory/index.js embedText(): description, then a
// single space plus the serialized data, truncated to maxMemoryChars (6000).
export function memoryInputText(doc, maxChars = MEMORY_INPUT_MAX_CHARS) {
    if (!doc || typeof doc._id !== 'string' || doc._id.length === 0) {
        throw new Error('memoryInputText: document has no _id');
    }
    if (typeof doc.description !== 'string' || doc.description.length === 0) {
        throw new Error(`memoryInputText: memory ${doc._id} has no description`);
    }
    const parts = [doc.description];
    const data = serializeMemoryData(doc.data);
    if (data) parts.push(data);
    const combined = parts.join(' ');
    return combined.length > maxChars ? combined.slice(0, maxChars) : combined;
}

// ── audits ───────────────────────────────────────────────────────────────────

function pushHashGroup(map, hash, record) {
    const list = map.get(hash);
    if (list) list.push(record);
    else map.set(hash, [record]);
}

// The whole audited population indexed by vector hash. This is what a fresh
// embedding must be compared against: the shared provider guard is process-local
// and only knows inputs embedded in THIS run, so a byte-identical vector for a
// different input that is already stored in the index is invisible to it.
function indexOfGroups(byHash, project) {
    const index = new Map();
    for (const [hash, records] of byHash) index.set(hash, records.map(project));
    return index;
}

function parsePayloadString(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

// Groups storage chunks by full Float64 vector SHA-256 over every id the scanner
// would have produced. `repairRecords` carries the internal repair material
// (embed text + original payload string) keyed by chunk id; it is never written
// into the report.
export function auditStorageVectors({ ids, coll, storageWorkRoot, guard = null, expectedDim }) {
    const present = [];
    const missing = [];
    for (const id of ids) {
        const record = coll.get(id);
        if (!record) {
            missing.push(id);
            continue;
        }
        const v = analyzeVector(record.vector, expectedDim);
        const payload = parsePayloadString(record.payload);
        present.push({
            id,
            vectorHash: v.hash,
            dim: v.dim,
            dimOk: v.dimOk,
            finite: v.finite,
            nonzero: v.nonzero,
            payloadString: typeof record.payload === 'string' ? record.payload : null,
            payload,
            contentHash: payload && typeof payload.contentHash === 'string' ? payload.contentHash : null,
            storagePath: payload && typeof payload.path === 'string' ? payload.path : null,
            splitIdx: payload && Number.isInteger(payload.splitIdx) ? payload.splitIdx : null
        });
    }

    const byHash = new Map();
    for (const record of present) if (record.vectorHash) pushHashGroup(byHash, record.vectorHash, record);

    const duplicateGroups = [];
    const legitimateGroups = [];
    const suspiciousGroups = [];
    const repairRecords = new Map();
    const affectedIds = [];

    for (const [hash, records] of byHash) {
        if (records.length < 2) continue;
        const contentValues = new Set(records.map((r) => r.contentHash ?? '<no-contentHash>'));
        const suspicious = contentValues.size > 1;
        duplicateGroups.push({
            vectorHash: hash,
            count: records.length,
            ids: records.map((r) => r.id),
            contentHashes: records.map((r) => ({ id: r.id, contentHash: r.contentHash })),
            suspicious
        });
        if (!suspicious) {
            legitimateGroups.push({ vectorHash: hash, count: records.length, ids: records.map((r) => r.id), contentHash: records[0].contentHash });
            continue;
        }
        for (const r of records) affectedIds.push(r.id);
        suspiciousGroups.push({
            vectorHash: hash,
            suspicious: true,
            count: records.length,
            ids: records.map((r) => r.id),
            contentHashes: records.map((r) => ({ id: r.id, contentHash: r.contentHash })),
            records: records.map((r) => {
                const src = reconstructStorageChunk({ payload: r.payload, storageWorkRoot, guard });
                if (src.available && r.payloadString) {
                    repairRecords.set(r.id, { collection: 'storage', id: r.id, payloadString: r.payloadString, embedText: src.embedText });
                }
                return {
                    id: r.id,
                    contentHash: r.contentHash,
                    path: r.storagePath,
                    splitIdx: r.splitIdx,
                    dim: r.dim,
                    dimOk: r.dimOk,
                    finite: r.finite,
                    nonzero: r.nonzero,
                    payloadAvailable: !!r.payloadString,
                    sourceAvailable: src.available,
                    sourceReason: src.reason ?? null,
                    embedTextSha256: src.available ? sha256Text(src.embedText) : null
                };
            })
        });
    }

    return {
        summary: {
            requestedIds: ids.length,
            vectorsPresent: present.length,
            vectorsMissing: ids.length - present.length,
            missingSamples: missing.slice(0, 10),
            distinctVectorHashes: byHash.size,
            duplicateGroups: duplicateGroups.length,
            suspiciousGroups: suspiciousGroups.length,
            legitimateSameContentGroups: legitimateGroups.length,
            affectedIds
        },
        duplicateGroups,
        legitimateGroups,
        suspiciousGroups,
        repairRecords,
        vectorHashes: new Set(present.map((r) => r.vectorHash).filter(Boolean)),
        vectorIndex: indexOfGroups(byHash, (r) => ({ id: r.id, contentHash: r.contentHash, payload: r.payload }))
    };
}

// Groups active mem_ documents by full vector SHA-256; suspicious only when the
// computed embed inputs differ. The nDB copy is read-only here.
export function auditMemoryVectors({ docs, coll, expectedDim, maxChars = MEMORY_INPUT_MAX_CHARS }) {
    const active = docs.filter((d) => typeof d._id === 'string' && d._id.startsWith('mem_'));
    const present = [];
    const missing = [];
    const inputErrors = [];

    for (const doc of active) {
        const record = coll.get(doc._id);
        if (!record) {
            missing.push(doc._id);
            continue;
        }
        let inputText = null;
        let inputError = null;
        try {
            inputText = memoryInputText(doc, maxChars);
        } catch (e) {
            inputError = e.message;
            inputErrors.push({ _id: doc._id, error: e.message });
        }
        const v = analyzeVector(record.vector, expectedDim);
        present.push({
            _id: doc._id,
            memId: doc.id ?? null,
            vectorHash: v.hash,
            dim: v.dim,
            dimOk: v.dimOk,
            finite: v.finite,
            nonzero: v.nonzero,
            payloadString: typeof record.payload === 'string' ? record.payload : null,
            inputText,
            inputHash: inputText === null ? null : sha256Text(inputText),
            inputError
        });
    }

    const byHash = new Map();
    for (const record of present) if (record.vectorHash) pushHashGroup(byHash, record.vectorHash, record);

    const duplicateGroups = [];
    const legitimateGroups = [];
    const suspiciousGroups = [];
    const repairRecords = new Map();
    const affectedIds = [];

    for (const [hash, records] of byHash) {
        if (records.length < 2) continue;
        // A record whose input could not be computed cannot be classified: it is
        // reported separately and the group is treated as suspicious (it needs a
        // human), never silently accepted as legitimate.
        const inputValues = new Set(records.map((r) => r.inputHash ?? `<uncomputable:${r._id}>`));
        const suspicious = inputValues.size > 1;
        duplicateGroups.push({
            vectorHash: hash,
            count: records.length,
            ids: records.map((r) => r._id),
            inputHashes: records.map((r) => ({ _id: r._id, inputHash: r.inputHash })),
            suspicious
        });
        if (!suspicious) {
            legitimateGroups.push({ vectorHash: hash, count: records.length, ids: records.map((r) => r._id), inputHash: records[0].inputHash });
            continue;
        }
        for (const r of records) affectedIds.push(r._id);
        suspiciousGroups.push({
            vectorHash: hash,
            suspicious: true,
            count: records.length,
            ids: records.map((r) => r._id),
            records: records.map((r) => {
                const payloadString = r.payloadString ?? (r.memId !== null ? JSON.stringify({ id: r.memId }) : null);
                if (r.inputText !== null && payloadString) {
                    repairRecords.set(r._id, { collection: 'memory', id: r._id, payloadString, embedText: r.inputText });
                }
                return {
                    _id: r._id,
                    memId: r.memId,
                    dim: r.dim,
                    dimOk: r.dimOk,
                    finite: r.finite,
                    nonzero: r.nonzero,
                    inputHash: r.inputHash,
                    inputError: r.inputError,
                    payloadAvailable: !!payloadString,
                    sourceAvailable: r.inputText !== null && !!payloadString,
                    sourceReason: r.inputError ?? (payloadString ? null : 'vector record has no payload and the document has no integer id')
                };
            })
        });
    }

    return {
        summary: {
            activeMemDocuments: active.length,
            vectorsPresent: present.length,
            vectorsMissing: active.length - present.length,
            missingSamples: missing.slice(0, 10),
            distinctVectorHashes: byHash.size,
            duplicateGroups: duplicateGroups.length,
            suspiciousGroups: suspiciousGroups.length,
            legitimateSameContentGroups: legitimateGroups.length,
            unknownDocuments: inputErrors.length,
            affectedIds
        },
        duplicateGroups,
        legitimateGroups,
        suspiciousGroups,
        repairRecords,
        inputErrors,
        vectorHashes: new Set(present.map((r) => r.vectorHash).filter(Boolean)),
        // inputText rides along so the probe can re-embed an owner's input to test
        // whether the stored vector or the fresh one is the wrong one.
        vectorIndex: indexOfGroups(byHash, (r) => ({ _id: r._id, inputHash: r.inputHash, inputText: r.inputText })),
        inputTextById: new Map(present.filter((r) => r.inputText !== null).map((r) => [r._id, r.inputText]))
    };
}

// Repeated vectors across collections are noted, never classified as damage.
export function crossCollectionNote(storageHashes, memoryHashes) {
    const shared = [];
    for (const hash of storageHashes) if (memoryHashes.has(hash)) shared.push(hash);
    return {
        sharedVectorHashes: shared.length,
        samples: shared.slice(0, 5),
        note: 'a vector hash present in both collections is reported for information only — same-content duplicates are not damage and are never repaired'
    };
}

// ── embeddings ───────────────────────────────────────────────────────────────

function embeddingOf(embedder, batch) {
    if (typeof embedder?.embedBatch === 'function') return embedder.embedBatch(batch, { background: true });
    if (typeof embedder?.embed === 'function') {
        return (async () => {
            const out = [];
            for (const text of batch) out.push(await embedder.embed(text, { background: true }));
            return out;
        })();
    }
    throw new Error('repair: embedder must expose embedBatch(texts) or embed(text)');
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Phase 0's retry rule applied to BOTH entry points over one shared stats
// object: exactly one bounded retry for a transient TypeError / "fetch failed",
// recorded; anything else is thrown immediately with no retry. Both arms are
// wrapped because a single-arm wrapper would silently degrade a batch call into
// N single calls (losing the background batch and the batch-level guard).
export function wrapRepairEmbedder(embedder, { retryDelayMs = 250, sleep = defaultSleep } = {}) {
    if (!embedder || (typeof embedder.embedBatch !== 'function' && typeof embedder.embed !== 'function')) {
        throw new Error('wrapRepairEmbedder: embedder with embedBatch(texts) or embed(text) is required');
    }
    const stats = {
        calls: 0,
        chars: 0,
        attempts: 0,
        retries: 0,
        recovered: 0,
        transientFailures: [],
        failures: []
    };

    async function attempt(label, chars, call) {
        stats.calls++;
        stats.chars += chars;
        stats.attempts++;
        try {
            return await call();
        } catch (e) {
            if (!isTransientFetchError(e)) {
                stats.failures.push({ text: label, error: e.message, transient: false, attempts: 1 });
                throw e;
            }
            stats.transientFailures.push({ text: label, error: e.message, retryDelayMs });
            stats.retries++;
            await sleep(retryDelayMs);
            stats.attempts++;
            try {
                const value = await call();
                stats.recovered++;
                return value;
            } catch (e2) {
                stats.failures.push({ text: label, error: e2.message, transient: isTransientFetchError(e2), attempts: 2 });
                throw e2;
            }
        }
    }

    const wrapped = { stats, embed: null, embedBatch: null };
    if (typeof embedder.embed === 'function') {
        wrapped.embed = (text, opts) => attempt(previewText(text), String(text ?? '').length, () => embedder.embed(text, opts));
    }
    if (typeof embedder.embedBatch === 'function') {
        wrapped.embedBatch = (texts, opts) => attempt(
            `batch of ${texts.length}`,
            texts.reduce((n, t) => n + String(t ?? '').length, 0),
            () => embedder.embedBatch(texts, opts)
        );
    }
    return wrapped;
}

function previewText(text) {
    const s = String(text ?? '');
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

export async function embedBatchTexts(embedder, texts, { batchSize = REPAIR_BATCH_SIZE } = {}) {    if (!Array.isArray(texts) || texts.length === 0) throw new Error('embedBatchTexts: texts must be a non-empty array');
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`embedBatchTexts: invalid batchSize ${batchSize}`);
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const vectors = await embeddingOf(embedder, batch);
        if (!Array.isArray(vectors) || vectors.length !== batch.length) {
            throw new Error(`embedBatchTexts: expected ${batch.length} embeddings for batch ${i / batchSize}, got ${Array.isArray(vectors) ? vectors.length : typeof vectors}`);
        }
        out.push(...vectors);
    }
    return out;
}

// Validates one embedding structurally. Throws: a bad vector must never reach a
// write path.
export function assertUsableVector(vector, expectedDim, label) {
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
        throw new Error(`${label}: embedding is not an array or typed array (got ${vector === null ? 'null' : typeof vector})`);
    }
    if (vector.length !== expectedDim) {
        throw new Error(`${label}: embedding dim ${vector.length} — expected ${expectedDim}`);
    }
    let sumSquares = 0;
    for (let i = 0; i < vector.length; i++) {
        const v = vector[i];
        if (!Number.isFinite(v)) throw new Error(`${label}: embedding dim ${i} is not a finite number (${String(v)})`);
        sumSquares += v * v;
    }
    if (sumSquares === 0) throw new Error(`${label}: embedding has zero norm — refusing to use it`);
    return { dim: vector.length, finite: true, nonzero: true, norm: Math.sqrt(sumSquares), hash: vectorHash(vector) };
}

// Cross-input duplicate check over one embedding set: an identical vector for a
// different input cannot come from a real embedder. Identical input -> identical
// vector stays legitimate (that is the whole point of de-duplicating repair
// inputs), so the check keys on the input text.
export function validateEmbeddingSet(entries, expectedDim) {
    const ownerByVector = new Map();
    for (const entry of entries) {
        const analysis = assertUsableVector(entry.vector, expectedDim, entry.label);
        const owner = ownerByVector.get(analysis.hash);
        if (owner !== undefined && owner.inputHash !== entry.inputHash) {
            throw new Error(`provider returned a byte-identical embedding for different inputs (${owner.label} and ${entry.label}) — refusing every write`);
        }
        if (owner === undefined) ownerByVector.set(analysis.hash, { inputHash: entry.inputHash, label: entry.label });
        entry.analysis = analysis;
    }
    return {
        count: entries.length,
        distinctVectorHashes: ownerByVector.size,
        allDimOk: entries.every((e) => e.analysis.dim === expectedDim),
        // Always 0 after a successful pass — a cross-input duplicate throws.
        crossInputDuplicates: 0,
        // Identical inputs sharing one vector is legitimate and expected here.
        sharedInputVectors: entries.length - ownerByVector.size
    };
}

// ── stored-population collision check ────────────────────────────────────────
//
// The damaged provider returns byte-identical vectors for DIFFERENT inputs, and
// it does so across requests (documented in src/embed-client.js). Its guard is
// process-local: it sees only what was embedded in this run. A fresh vector that
// collides with a vector ALREADY IN THE INDEX — produced by an earlier run for a
// different input — therefore passes every in-run check and still lands in the
// work copy as a new cross-content duplicate (measured 2026-11-17: 6 of 215).
// So the audit's whole population is the reference set a repair must not collide
// with.

// Identity of a stored record's embed input. Memory documents carry it from the
// audit; storage chunks are reconstructed from the work copy on demand (only for
// the few records that actually collide).
export function storedOwnerInputHash({ collection, owner, storageWorkRoot, guard = null, cache = new Map() }) {
    if (collection === 'memory') return owner.inputHash ?? null;
    if (!owner.payload) return null;
    if (cache.has(owner.id)) return cache.get(owner.id);
    const src = reconstructStorageChunk({ payload: owner.payload, storageWorkRoot, guard });
    const value = src.available ? sha256Text(src.embedText) : null;
    cache.set(owner.id, value);
    return value;
}

// The owner's actual embed TEXT, so the probe can re-embed it and decide which
// side of a stored collision is wrong.
export function storedOwnerInputText({ collection, owner, storageWorkRoot, guard = null }) {
    if (collection === 'memory') {
        if (typeof owner.inputText !== 'string' || owner.inputText.length === 0) {
            return { available: false, reason: 'memory document has no usable embed input', text: null };
        }
        return { available: true, text: owner.inputText };
    }
    if (!owner.payload) return { available: false, reason: 'storage chunk has no payload', text: null };
    const src = reconstructStorageChunk({ payload: owner.payload, storageWorkRoot, guard });
    if (!src.available) return { available: false, reason: src.reason, text: null };
    return { available: true, text: src.embedText };
}

// Storage chunk ids already carry their collection prefix ("storage:rel#i"),
// memory nVDB ids do not ("mem_…"). One canonical key for both, so a display
// key never doubles the prefix while comparisons stay exact.
export function collectionKeyOf(collection, rawId) {
    const prefix = `${collection}:`;
    return String(rawId).startsWith(prefix) ? String(rawId) : `${prefix}${rawId}`;
}

// A planned vector may coincide with a stored one only when it is the SAME input
// (identical input -> identical vector is legitimate) or the owner is itself
// being replaced in this run. Anything else is the provider fault and must
// refuse the write set.
export function findStoredCollisions({
    entries,
    storageIndex = null,
    memoryIndex = null,
    replacedKeys = new Set(),
    storageWorkRoot = null,
    guard = null,
    identityCache = new Map(),
    stats = null
}) {
    const collisions = [];
    for (const entry of entries) {
        const hash = entry.vectorHash ?? vectorHash(entry.vector);
        const entryKey = entry.key ?? collectionKeyOf(entry.collection, entry.id);
        for (const [collection, index] of [['storage', storageIndex], ['memory', memoryIndex]]) {
            if (!index) continue;
            const owners = index.get(hash);
            if (!owners) continue;
            for (const owner of owners) {
                const ownerId = collection === 'storage' ? owner.id : owner._id;
                const ownerKey = collectionKeyOf(collection, ownerId);
                if (ownerKey === entryKey) continue;
                if (replacedKeys.has(ownerKey)) {
                    if (stats) stats.allowedByReplacement = (stats.allowedByReplacement ?? 0) + 1;
                    continue;
                }
                const ownerInputHash = storedOwnerInputHash({ collection, owner, storageWorkRoot, guard, cache: identityCache });
                if (ownerInputHash !== null && ownerInputHash === entry.inputHash) {
                    if (stats) stats.allowedBySameInput = (stats.allowedBySameInput ?? 0) + 1;
                    continue;
                }
                collisions.push({
                    collection: entry.collection,
                    id: entry.id,
                    inputHash: entry.inputHash,
                    vectorHash: hash,
                    inputIndex: entry.inputIndex ?? null,
                    owner: { collection, id: ownerId, key: ownerKey, inputHash: ownerInputHash, contentHash: owner.contentHash ?? null }
                });
            }
        }
    }
    return collisions;
}

// ── repair plan ──────────────────────────────────────────────────────────────
// Unique embed inputs are embedded once and reused; identical repair inputs can
// never legitimately produce different vectors, so sharing is safe.
export function buildRepairPlan({ storageAudit = null, memoryAudit = null, scope = 'both', ownerRepairs = [] }) {
    const items = [];
    const unavailable = [];
    const sources = [];
    if (scope !== 'memory') sources.push(['storage', storageAudit]);
    if (scope !== 'storage') sources.push(['memory', memoryAudit]);
    for (const [collection, audit] of sources) {
        if (!audit) continue;
        for (const group of audit.suspiciousGroups) {
            for (const record of group.records) {
                const id = collection === 'storage' ? record.id : record._id;
                if (!record.sourceAvailable) {
                    unavailable.push({ collection, id, reason: record.sourceReason ?? 'no usable source' });
                    continue;
                }
                const repair = audit.repairRecords.get(id);
                if (!repair) {
                    unavailable.push({ collection, id, reason: 'no repair input material was collected' });
                    continue;
                }
                items.push({ collection, id, payloadString: repair.payloadString, embedText: repair.embedText });
            }
        }
    }
    // Probe-adjudicated owners hold old corruption but are not necessarily in any
    // suspicious audit group (their stored vector is unique in the collection), so
    // they are added explicitly and repaired together with the candidates.
    let ownerItems = 0;
    for (const owner of ownerRepairs) {
        if (items.some((item) => item.collection === owner.collection && item.id === owner.id)) continue;
        items.push({ collection: owner.collection, id: owner.id, payloadString: owner.payloadString, embedText: owner.embedText, fromProbe: true });
        ownerItems++;
    }
    const uniqueInputs = [];
    const indexByText = new Map();
    for (const item of items) {
        let index = indexByText.get(item.embedText);
        if (index === undefined) {
            index = uniqueInputs.length;
            indexByText.set(item.embedText, index);
            uniqueInputs.push({ text: item.embedText, inputHash: sha256Text(item.embedText) });
        }
        item.uniqueInputIndex = index;
    }
    return {
        items,
        unavailable,
        uniqueInputs,
        ownerItems,
        counts: {
            storage: items.filter((i) => i.collection === 'storage').length,
            memory: items.filter((i) => i.collection === 'memory').length
        }
    };
}

// Every probe-adjudicated owner that must be repaired with its candidate: read
// the work record (original payload) and reconstruct the CURRENT embed input.
export function planOwnerRepairs({ ownerKeys = [], storageColl = null, memoryColl = null, storageWorkRoot = null, guard = null, inputTextById = new Map() }) {
    const repairs = [];
    const unavailable = [];
    for (const key of ownerKeys) {
        const separator = key.indexOf(':');
        const collection = separator > 0 ? key.slice(0, separator) : '';
        if (collection !== 'storage' && collection !== 'memory') {
            unavailable.push({ key, reason: 'unparseable owner key' });
            continue;
        }
        // storage chunk ids already carry their prefix (`storage:rel#i`) and ARE the
        // nVDB record id; memory nVDB ids carry no collection prefix.
        const id = collection === 'memory' ? key.slice(separator + 1) : key;
        const coll = collection === 'storage' ? storageColl : memoryColl;
        if (!coll) {
            unavailable.push({ key, reason: `the ${collection} collection is not open in this scope` });
            continue;
        }
        const record = coll.get(id);
        if (!record) {
            unavailable.push({ key, reason: 'owner is not present in the work collection' });
            continue;
        }
        const payloadString = typeof record.payload === 'string' ? record.payload : null;
        if (!payloadString) {
            unavailable.push({ key, reason: 'owner has no original payload string to preserve' });
            continue;
        }
        let embedText = null;
        if (collection === 'memory') {
            embedText = inputTextById.get(id) ?? null;
            if (!embedText) {
                unavailable.push({ key, reason: 'no audited embed input for this memory document' });
                continue;
            }
        } else {
            const src = reconstructStorageChunk({ payload: parsePayloadString(payloadString), storageWorkRoot, guard });
            if (!src.available) {
                unavailable.push({ key, reason: src.reason });
                continue;
            }
            embedText = src.embedText;
        }
        repairs.push({ collection, id, payloadString, embedText, fromProbe: true });
    }
    return { repairs, unavailable };
}

// ── probe ────────────────────────────────────────────────────────────────────

export function cosineSimilarity(a, b) {
    if (!Array.isArray(a) && !ArrayBuffer.isView(a)) throw new Error('cosineSimilarity: first vector is not array-like');
    if (!Array.isArray(b) && !ArrayBuffer.isView(b)) throw new Error('cosineSimilarity: second vector is not array-like');
    if (a.length !== b.length) throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
    if (a.length === 0) throw new Error('cosineSimilarity: empty vectors');
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`cosineSimilarity: non-finite component at ${i}`);
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na === 0 || nb === 0) return null;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Structural description of one vector — non-throwing, because the whole point
// of the probe is to record a broken provider, not to abort on it.
function describeProbeVector(vector, expectedDim) {
    const analysis = analyzeVector(vector, expectedDim);
    if (!analysis.present) return { present: false, dim: null, dimOk: false, finite: false, nonzero: false, hash: null };
    return {
        present: true,
        dim: analysis.dim,
        dimOk: analysis.dimOk,
        finite: analysis.finite,
        nonzero: analysis.nonzero,
        hash: analysis.hash
    };
}

// Scores one mode: per-input vector description, within-mode duplicate groups and
// every fresh vector that already exists in the index for a different input.
function scoreProbeMode({ mode, ids, inputs, vectors, expectedDim, storageIndex, memoryIndex, replacedKeys, storageWorkRoot, guard }) {
    const records = ids.map((id, i) => ({ id, inputHash: inputs[i].embedTextSha256, ...describeProbeVector(vectors[i], expectedDim) }));
    const byHash = new Map();
    for (const record of records) {
        if (!record.hash) continue;
        const list = byHash.get(record.hash);
        if (list) list.push(record.id);
        else byHash.set(record.hash, [record.id]);
    }
    const duplicateGroups = [...byHash.entries()]
        .filter(([, groupIds]) => groupIds.length > 1)
        .map(([vectorHash, groupIds]) => ({ vectorHash, ids: groupIds }));
    const storedCollisions = findStoredCollisions({
        entries: records.filter((r) => r.hash).map((r) => ({
            collection: 'storage',
            id: r.id,
            key: collectionKeyOf('storage', r.id),
            inputHash: r.inputHash,
            vectorHash: r.hash
        })),
        storageIndex,
        memoryIndex,
        replacedKeys,
        storageWorkRoot,
        guard
    });
    return {
        mode,
        records,
        presentVectors: records.filter((r) => r.hash).length,
        distinctHashes: byHash.size,
        pairwiseDistinct: byHash.size === records.filter((r) => r.hash).length,
        duplicateGroups,
        storedCollisions,
        allDimOk: records.filter((r) => r.present).every((r) => r.dimOk),
        allFinite: records.filter((r) => r.present).every((r) => r.finite),
        allNonzero: records.filter((r) => r.present).every((r) => r.nonzero)
    };
}

// Two deliberate probe modes over the SAME five golden chunk inputs, nothing
// inserted:
//   batch  — one embedBatch() call of five inputs (production indexing shape)
//   single — five sequential embed() calls (one request per input)
// Both are measured independently: pairwise distinctness, collisions against the
// stored index, and per-input hash equality + cosine. That separates a batch
// index/response-mapping fault (batch wrong, single right) from a single-request
// runtime/cache fault (both wrong) — the distinction the residual evidence
// needed. There is NO fallback: missing either capability is a hard error.
export async function probeExplicitVectors({
    explicitIds,
    coll,
    storageWorkRoot,
    guard,
    embedder,
    expectedDim,
    storageIndex = null,
    memoryIndex = null,
    replacedKeys = new Set()
}) {
    if (!Array.isArray(explicitIds) || explicitIds.length !== EXPLICIT_VECTOR_COUNT) {
        throw new Error(`probe: the golden suite must declare exactly ${EXPLICIT_VECTOR_COUNT} explicitVectorIds (got ${Array.isArray(explicitIds) ? explicitIds.length : typeof explicitIds})`);
    }
    if (typeof embedder?.embedBatch !== 'function') {
        throw new Error('probe: the embedder must expose embedBatch(texts) — the batch mode has no sequential fallback');
    }
    if (typeof embedder?.embed !== 'function') {
        throw new Error('probe: the embedder must expose embed(text) — the single-call mode is required');
    }
    const prepared = explicitIds.map((id) => {
        const record = coll.get(id);
        if (!record) throw new Error(`probe: golden explicit chunk ${id} is not present in the storage collection — refusing to probe`);
        const payload = parsePayloadString(record.payload);
        const src = reconstructStorageChunk({ payload, storageWorkRoot, guard });
        if (!src.available) throw new Error(`probe: golden explicit chunk ${id} has no usable source (${src.reason})`);
        const before = analyzeVector(record.vector, expectedDim);
        return { id, before, embedText: src.embedText, header: src.header, sourcePath: src.sourcePath };
    });
    const texts = prepared.map((p) => p.embedText);
    const inputs = prepared.map((p) => ({
        id: p.id,
        path: p.sourcePath,
        headerPresent: p.header.length > 0,
        embedTextSha256: sha256Text(p.embedText),
        storedHash: p.before.hash,
        storedDim: p.before.dim ?? null,
        storedFinite: p.before.finite ?? null
    }));

    // (a) one batch of five — the production indexing shape
    const batchVectors = new Array(texts.length).fill(undefined);
    let batchError = null;
    let batchCalls = 1;
    try {
        const response = await embedder.embedBatch(texts, { background: true });
        if (!Array.isArray(response) || response.length !== texts.length) {
            batchError = `batch returned ${Array.isArray(response) ? response.length : typeof response} vectors for ${texts.length} inputs`;
        } else {
            for (let i = 0; i < texts.length; i++) batchVectors[i] = response[i];
        }
    } catch (e) {
        batchError = `${e.name ?? 'Error'}: ${e.message}`;
    }

    // (b) five sequential single calls — one request per input, no fallback
    const singleVectors = new Array(texts.length).fill(undefined);
    const singleErrors = [];
    let singleCalls = 0;
    for (let i = 0; i < texts.length; i++) {
        singleCalls++;
        try {
            singleVectors[i] = await embedder.embed(texts[i], { background: true });
        } catch (e) {
            singleErrors.push({ id: explicitIds[i], error: `${e.name ?? 'Error'}: ${e.message}` });
        }
    }

    const scoreOptions = { expectedDim, storageIndex, memoryIndex, replacedKeys, storageWorkRoot, guard };
    const batch = {
        calls: batchCalls,
        error: batchError,
        provider: 'embedBatch(texts, { background: true }) — one request for all five',
        ...scoreProbeMode({ mode: 'batch', ids: explicitIds, inputs, vectors: batchVectors, ...scoreOptions })
    };
    const single = {
        calls: singleCalls,
        errors: singleErrors,
        provider: 'embed(text, { background: true }) — one request per input',
        ...scoreProbeMode({ mode: 'single', ids: explicitIds, inputs, vectors: singleVectors, ...scoreOptions })
    };

    const perInput = explicitIds.map((id, i) => {
        const batchRecord = batch.records[i];
        const singleRecord = single.records[i];
        let cosine = null;
        if (batchRecord.present && singleRecord.present) {
            try {
                cosine = cosineSimilarity(batchVectors[i], singleVectors[i]);
            } catch {
                cosine = null;
            }
        }
        return {
            id,
            batchHash: batchRecord.hash,
            singleHash: singleRecord.hash,
            equal: batchRecord.hash !== null && batchRecord.hash === singleRecord.hash,
            cosine
        };
    });

    // (c) every unique stored collision owner is re-embedded too, sequentially, so
    // the probe can tell WHICH side of a collision is stale: a fresh candidate that
    // no longer matches the fresh owner means the stored owner holds old corruption
    // (the candidate is correct and both must be repaired together); a fresh pair
    // that IS byte-identical for different inputs means the current provider is
    // duplicating. A pair whose modes disagree is adjudicated as a MODE fault —
    // the stored data cannot be blamed for an unstable response.
    const ownerCache = new Map();
    for (const collision of [...batch.storedCollisions, ...single.storedCollisions]) {
        const key = collision.owner.key;
        if (!ownerCache.has(key)) ownerCache.set(key, { owner: collision.owner, storedHash: collision.vectorHash });
    }
    const ownerEvidence = new Map();
    let ownerEmbedCalls = 0;
    let ownerProbesSkipped = 0;
    for (const [key, entry] of ownerCache) {
        if (ownerEvidence.size >= MAX_OWNER_PROBES) {
            ownerProbesSkipped++;
            continue;
        }
        // The collision record is deliberately lean; the full index entry carries
        // the payload / embed input the owner probe needs.
        const index = entry.owner.collection === 'storage' ? storageIndex : memoryIndex;
        const indexed = index?.get(entry.storedHash) ?? [];
        const fullOwner = indexed.find((o) => (o.id ?? o._id) === entry.owner.id) ?? entry.owner;
        const resolved = storedOwnerInputText({ collection: entry.owner.collection, owner: fullOwner, storageWorkRoot, guard });
        const base = {
            key,
            collection: entry.owner.collection,
            id: entry.owner.id,
            storedHash: entry.storedHash,
            freshHash: null,
            vector: null
        };
        if (!resolved.available) {
            ownerEvidence.set(key, { ...base, available: false, reason: resolved.reason, guardRejected: false });
            continue;
        }
        ownerEmbedCalls++;
        try {
            const vector = await embedder.embed(resolved.text, { background: true });
            ownerEvidence.set(key, { ...base, inputHash: sha256Text(resolved.text), available: true, freshHash: describeProbeVector(vector, expectedDim).hash, vector });
        } catch (e) {
            ownerEvidence.set(key, {
                ...base,
                inputHash: sha256Text(resolved.text),
                available: false,
                reason: `${e.name ?? 'Error'}: ${e.message}`,
                guardRejected: /byte-identical/.test(e.message)
            });
        }
    }

    const collisionPairs = [];
    for (const [modeName, modeVectors] of [['batch', batchVectors], ['single', singleVectors]]) {
        const mode = modeName === 'batch' ? batch : single;
        for (const collision of mode.storedCollisions) {
            const candidateIndex = explicitIds.indexOf(collision.id);
            const candidateVector = candidateIndex >= 0 ? modeVectors[candidateIndex] : null;
            const owner = ownerEvidence.get(collision.owner.key) ?? { available: false, reason: 'owner was not probed (limit reached)' };
            const candidateFreshHash = collision.vectorHash;
            const modesAgree = candidateIndex >= 0 && perInput[candidateIndex]?.equal === true;
            const finding = !modesAgree
                ? 'mode-specific-fault'
                : (!owner.available
                    ? (owner.guardRejected ? 'current-provider-faulty' : 'undetermined')
                    : (owner.freshHash === candidateFreshHash ? 'current-provider-faulty' : 'stored-owner-corrupt'));
            let cosineFresh = null;
            if (owner.available && candidateVector && owner.vector) {
                try {
                    cosineFresh = cosineSimilarity(candidateVector, owner.vector);
                } catch {
                    cosineFresh = null;
                }
            }
            collisionPairs.push({
                mode: modeName,
                candidateId: collision.id,
                candidateInputHash: collision.inputHash,
                candidateFreshHash,
                candidateStoredHash: inputs[candidateIndex]?.storedHash ?? null,
                ownerKey: collision.owner.key,
                ownerCollection: collision.owner.collection,
                ownerId: collision.owner.id,
                ownerStoredHash: collision.vectorHash,
                ownerFreshHash: owner.freshHash ?? null,
                ownerAvailable: owner.available,
                ownerReason: owner.reason ?? null,
                ownerGuardRejected: !!owner.guardRejected,
                freshEqual: owner.available ? owner.freshHash === candidateFreshHash : null,
                storedEqual: (inputs[candidateIndex]?.storedHash ?? null) === collision.vectorHash,
                modesAgree,
                cosineFresh,
                finding,
                note: !modesAgree
                    ? `the ${modeName} vector for this input differs from the other mode's, so the collision is attributed to that mode, not to the stored data`
                    : owner.guardRejected
                        ? 'the guard rejected the owner re-embed as a byte-identical duplicate of a different input'
                        : finding === 'stored-owner-corrupt'
                            ? "the owner's stored vector is not what its own input produces now — old corruption, not a current provider fault"
                            : undefined
            });
        }
    }

    const collisionSummary = {
        total: collisionPairs.length,
        counts: {
            currentProviderFaulty: collisionPairs.filter((p) => p.finding === 'current-provider-faulty').length,
            storedOwnerCorrupt: collisionPairs.filter((p) => p.finding === 'stored-owner-corrupt').length,
            modeSpecific: collisionPairs.filter((p) => p.finding === 'mode-specific-fault').length,
            undetermined: collisionPairs.filter((p) => p.finding === 'undetermined').length
        },
        modeSpecificByMode: {
            batch: collisionPairs.filter((p) => p.finding === 'mode-specific-fault' && p.mode === 'batch').length,
            single: collisionPairs.filter((p) => p.finding === 'mode-specific-fault' && p.mode === 'single').length
        },
        byOwner: [...ownerEvidence.values()].map((o) => ({
            key: o.key,
            collection: o.collection,
            id: o.id,
            storedHash: o.storedHash,
            inputHash: o.inputHash ?? null,
            freshHash: o.freshHash,
            ownerSelfConsistent: o.available ? o.freshHash === o.storedHash : null,
            available: o.available,
            reason: o.reason ?? null,
            guardRejected: !!o.guardRejected
        })),
        ownersToRepairTogether: [...new Set(collisionPairs.filter((p) => p.finding === 'stored-owner-corrupt').map((p) => p.ownerKey))],
        pairs: collisionPairs.slice(0, MAX_RECORDED_PAIRS),
        pairsTruncated: collisionPairs.length > MAX_RECORDED_PAIRS,
        ownerEmbedCalls,
        ownerProbesSkipped
    };

    const cosines = perInput.map((p) => p.cosine).filter((c) => typeof c === 'number');
    const comparison = {
        perInput,
        equalInputs: perInput.filter((p) => p.equal).length,
        differingInputs: perInput.filter((p) => p.batchHash !== null && p.singleHash !== null && !p.equal).length,
        missingInputs: perInput.filter((p) => p.batchHash === null || p.singleHash === null).length,
        minCosine: cosines.length > 0 ? Math.min(...cosines) : null,
        meanCosine: cosines.length > 0 ? cosines.reduce((a, b) => a + b, 0) / cosines.length : null
    };

    const batchBad = batch.error !== null || batch.duplicateGroups.length > 0 || !batch.allDimOk || !batch.allFinite || !batch.allNonzero || batch.presentVectors !== explicitIds.length;
    const singleBad = singleErrors.length > 0 || single.duplicateGroups.length > 0 || !single.allDimOk || !single.allFinite || !single.allNonzero || single.presentVectors !== explicitIds.length;
    const unstable = !batchBad && !singleBad && collisionSummary.total === 0 && comparison.equalInputs < explicitIds.length;
    const classification = classifyProbe({ batchBad, singleBad, unstable, batch, single, comparison, collisions: collisionSummary });

    return {
        ids: explicitIds,
        inputs,
        batch,
        single,
        comparison,
        collisions: collisionSummary,
        storedCollisions: { batch: batch.storedCollisions.length, single: single.storedCollisions.length },
        classification,
        // Batch-mode pairwise distinctness is the historical health signal.
        pairwiseDistinct: batch.pairwiseDistinct,
        guardAccepted: { batch: batch.error === null, single: singleErrors.length === 0 },
        note: 'both modes and every stored collision owner are measured; no mode falls back to another'
    };
}

// Names the fault mode from evidence, never from assumption.
export function classifyProbe({ batchBad, singleBad, unstable, batch, single, comparison, collisions = null }) {
    const describe = (mode) => {
        const bits = [];
        if (mode.error) bits.push(`request failed (${mode.error})`);
        if (mode.duplicateGroups.length > 0) bits.push(`${mode.duplicateGroups.length} within-mode duplicate group(s)`);
        if (mode.storedCollisions.length > 0) bits.push(`${mode.storedCollisions.length} stored-vector collision(s)`);
        if (mode.presentVectors > 0 && (!mode.allDimOk || !mode.allFinite || !mode.allNonzero)) bits.push('degenerate vector');
        if (mode.presentVectors === 0) bits.push('no usable vector returned');
        return bits.join(', ') || 'no fault recorded';
    };
    const collide = collisions ?? { total: 0, counts: { currentProviderFaulty: 0, storedOwnerCorrupt: 0, modeSpecific: 0, undetermined: 0 }, modeSpecificByMode: { batch: 0, single: 0 }, ownersToRepairTogether: [], ownerProbesSkipped: 0 };
    const providerFaulty = collide.counts.currentProviderFaulty > 0;
    const storedOwnerCorrupt = collide.counts.storedOwnerCorrupt > 0;
    const modeSpecificByMode = collide.modeSpecificByMode ?? { batch: 0, single: 0 };
    const modeSpecificBatchOnly = (collide.counts.modeSpecific ?? 0) > 0 && modeSpecificByMode.single === 0;
    const modeSpecificSingleOnly = (collide.counts.modeSpecific ?? 0) > 0 && modeSpecificByMode.batch === 0;
    const undetermined = collide.counts.undetermined > 0 || (collide.ownerProbesSkipped ?? 0) > 0;
    const base = {
        providerFaulty,
        storedOwnerCorrupt,
        collisions: {
            total: collide.total,
            ...collide.counts,
            ownersToRepairTogether: collide.ownersToRepairTogether ?? []
        }
    };
    // A corrupt batch poisons the process-wide guard: the single calls then get
    // rejected for reusing the batch's own vectors. That is a CONSEQUENCE of the
    // batch fault, not evidence that single requests are broken.
    const singleOnlyEchoesBatch = batchBad
        && single.errors.length > 0
        && single.errors.every((e) => /byte-identical/.test(e.error))
        && single.duplicateGroups.length === 0
        && single.storedCollisions.length === 0
        && single.presentVectors === 0;
    if (batchBad && singleBad && !singleOnlyEchoesBatch) {
        return {
            ...base,
            code: 'both-modes-faulty',
            blocksRepair: true,
            verdict: `both modes are faulty — a single-request runtime/cache fault: batch[${describe(batch)}]; single[${describe(single)}]`
        };
    }
    if (singleBad && !batchBad) {
        return {
            ...base,
            code: 'single-request-faulty',
            blocksRepair: true,
            verdict: `batch is clean but single requests are not — a per-request runtime/cache fault: single[${describe(single)}]`
        };
    }
    if (batchBad) {
        return {
            ...base,
            code: 'batch-mapping-faulty',
            blocksRepair: true,
            verdict: singleOnlyEchoesBatch
                ? `the batch is faulty and its vectors then made the guard reject every single call — a batch index/response-mapping fault: batch[${describe(batch)}]; single[all ${single.errors.length} calls refused the batch's own vectors]`
                : `single requests are clean but the batch is not — a batch index/response-mapping fault: batch[${describe(batch)}]`
        };
    }
    if (providerFaulty && !modeSpecificBatchOnly && !modeSpecificSingleOnly) {
        return {
            ...base,
            code: 'current-provider-faulty',
            blocksRepair: true,
            verdict: `the CURRENT provider returns a byte-identical vector for different inputs: ${collide.counts.currentProviderFaulty} of ${collide.total} collision(s) reproduce with a fresh owner embed (a fresh candidate equal to its fresh owner) — a live provider fault, not stored data`
        };
    }
    if (modeSpecificBatchOnly) {
        return {
            ...base,
            code: 'batch-mapping-faulty',
            blocksRepair: true,
            verdict: `${modeSpecificByMode.batch} stored collision(s) appear only in the batch, and the batch disagrees with the single responses for those inputs — a batch index/response-mapping fault; the stored vectors are not implicated`
        };
    }
    if (modeSpecificSingleOnly) {
        return {
            ...base,
            code: 'single-request-faulty',
            blocksRepair: true,
            verdict: `${modeSpecificByMode.single} stored collision(s) appear only in the single calls, which disagree with the batch for those inputs — a per-request runtime/cache fault; the stored vectors are not implicated`
        };
    }
    if ((collide.counts.modeSpecific ?? 0) > 0) {
        return {
            ...base,
            code: 'both-modes-faulty',
            blocksRepair: true,
            verdict: `stored collisions appear in both modes while the modes disagree per input (batch=${modeSpecificByMode.batch}, single=${modeSpecificByMode.single}) — responses are unstable`
        };
    }
    if (storedOwnerCorrupt) {
        return {
            ...base,
            code: 'stored-owner-corrupt',
            // Repairable: the current provider is healthy. `apply` repairs the
            // candidates AND these owners; an audit only reports the old damage.
            blocksRepair: false,
            repairable: true,
            verdict: `the current provider is healthy and deterministic: ${collide.counts.storedOwnerCorrupt} of ${collide.total} collision(s) do NOT reproduce when the owner's own input is embedded now (fresh candidate != fresh owner), so the named stored owner(s) [${(collide.ownersToRepairTogether ?? []).join(', ')}] hold old corruption — repair the candidate AND those owners together; do not blame the current provider`
        };
    }
    if (undetermined) {
        return {
            ...base,
            code: 'undetermined-collision',
            blocksRepair: true,
            verdict: `${collide.total} stored collision(s) could not be adjudicated (owner input unavailable or owner probe limit reached) — refusing to guess`
        };
    }
    if (unstable) {
        return {
            ...base,
            code: 'input-unstable',
            blocksRepair: false,
            verdict: `both modes are internally clean but only ${comparison.equalInputs}/${comparison.perInput.length} inputs came back byte-identical between modes (min cosine ${comparison.minCosine}) — the provider is nondeterministic for the same input`
        };
    }
    return {
        ...base,
        code: 'healthy',
        blocksRepair: false,
        verdict: `both modes: ${batch.distinctHashes}/${batch.records.length} distinct, 0 stored collisions, ${comparison.equalInputs}/${comparison.perInput.length} inputs byte-identical between modes`
    };
}

// ── scratch / nDB staging ────────────────────────────────────────────────────

function stageMemoryCopy({ guard, memoryDir, scratchDir }) {
    guard.assertWork(memoryDir, 'memory nDB directory');
    fs.mkdirSync(scratchDir, { recursive: true });
    const files = [];
    for (const name of fs.readdirSync(memoryDir)) {
        const src = path.join(memoryDir, name);
        if (!fs.statSync(src).isFile()) continue;
        fs.copyFileSync(src, path.join(scratchDir, name));
        files.push(name);
    }
    const journals = files.filter((name) => name.endsWith('.jsonl'));
    if (journals.length !== 1) {
        throw new Error(`memory nDB directory must hold exactly one .jsonl journal, found ${journals.length}: ${memoryDir}`);
    }
    return { dir: scratchDir, journalPath: path.join(scratchDir, journals[0]), files };
}

// ── reports ──────────────────────────────────────────────────────────────────

export function writeRepairReport(report, reportsDir, stamp = new Date(), suffix = '') {
    fs.mkdirSync(reportsDir, { recursive: true });
    const name = `repair-${stamp.toISOString().replace(/[:.]/g, '-')}${suffix}.json`;
    const file = path.join(reportsDir, name);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
}

export function summarize(report) {
    const lines = [];
    lines.push(`${TOOL}  ok=${report.ok}  mode=${report.mode}`);
    lines.push(`snapshot   ${report.snapshot.root}`);
    lines.push(`scope      ${report.options.scope}  expectedDim=${report.expectedDim}  apply=${report.options.apply}`);
    const s = report.audit.storage;
    if (s.skipped) lines.push(`storage    skipped (${s.reason})`);
    else lines.push(`storage    ids=${s.requestedIds} present=${s.vectorsPresent} missing=${s.vectorsMissing} dupGroups=${s.duplicateGroups} suspicious=${s.suspiciousGroups} legitimate=${s.legitimateSameContentGroups}`);
    const m = report.audit.memory;
    if (m.skipped) lines.push(`memory     skipped (${m.reason})`);
    else lines.push(`memory     active=${m.activeMemDocuments} present=${m.vectorsPresent} missing=${m.vectorsMissing} dupGroups=${m.duplicateGroups} suspicious=${m.suspiciousGroups} legitimate=${m.legitimateSameContentGroups}`);
    if (report.probe.skipped) lines.push(`probe      skipped (${report.probe.reason})`);
    else {
        lines.push(`probe      ${report.probe.classification.code}  blocksRepair=${report.probe.classification.blocksRepair}`);
        lines.push(`  batch    ${report.probe.batch.distinctHashes}/${report.probe.batch.records.length} distinct, storedCollisions=${report.probe.batch.storedCollisions.length}, calls=${report.probe.batch.calls}${report.probe.batch.error ? `, error=${report.probe.batch.error}` : ''}`);
        lines.push(`  single   ${report.probe.single.distinctHashes}/${report.probe.single.records.length} distinct, storedCollisions=${report.probe.single.storedCollisions.length}, calls=${report.probe.single.calls}, errors=${report.probe.single.errors.length}`);
        lines.push(`  compare  equal=${report.probe.comparison.equalInputs}/${report.probe.comparison.perInput.length} differing=${report.probe.comparison.differingInputs} minCosine=${report.probe.comparison.minCosine}`);
        const collisions = report.probe.collisions;
        if (collisions) {
            lines.push(`  collide  total=${collisions.total} providerFaulty=${collisions.counts.currentProviderFaulty} storedOwnerCorrupt=${collisions.counts.storedOwnerCorrupt} undetermined=${collisions.counts.undetermined} ownerEmbeds=${collisions.ownerEmbedCalls}`);
            if (collisions.ownersToRepairTogether.length > 0) lines.push(`  owners   repair together: ${collisions.ownersToRepairTogether.join(', ')}`);
        }
    }
    lines.push(`repairs    planned=${report.repairs.planned} storage=${report.repairs.counts.storage} memory=${report.repairs.counts.memory} owners=${report.repairs.ownersPlanned ?? 0} inserted=${report.repairs.inserted.length}`);
    lines.push(`collisions detected=${report.repairs.collisions.detected} resolvedByRetry=${report.repairs.collisions.resolvedByRetry} remaining=${report.repairs.collisions.remaining.length} reembedRetries=${report.repairs.reembedRetries}`);
    if (report.embed) lines.push(`embeds     ${report.embed.calls} call(s) ${report.embed.attempts} attempt(s) retries=${report.embed.retries} recovered=${report.embed.recovered}`);
    if (report.repairs.refusal) lines.push(`REFUSED    ${report.repairs.refusal}`);
    if (report.repairs.failure) lines.push(`WRITE-FAIL ${report.repairs.failure.id}: ${report.repairs.failure.error}`);
    for (const warning of report.warnings ?? []) lines.push(`WARNING    ${warning}`);
    if (report.verification) {
        lines.push(`verify     storageSuspicious=${report.verification.storageSuspiciousGroups} memorySuspicious=${report.verification.memorySuspiciousGroups} ok=${report.verification.ok}`);
    }
    for (const err of report.errors ?? []) lines.push(`ERROR      ${err.bucket}/${err.id}: ${err.error}`);
    lines.push(`duration   ${report.totalDurationMs}ms`);
    return lines.join('\n');
}

// ── orchestration ────────────────────────────────────────────────────────────

function normalizeOptions(options) {
    const opts = options || {};
    if (!opts.snapshot) throw new Error('runRepair: snapshot root is required');
    if (opts.storageOnly && opts.memoryOnly) throw new Error('runRepair: --storage-only and --memory-only are mutually exclusive');
    return {
        snapshot: opts.snapshot,
        embedder: opts.embedder,
        apply: !!opts.apply,
        storageOnly: !!opts.storageOnly,
        memoryOnly: !!opts.memoryOnly,
        goldenPath: opts.goldenPath ?? GOLDEN_PATH,
        expectedDim: opts.expectedDim ?? null,
        repoRoot: opts.repoRoot ?? REPO_ROOT,
        openNdb: opts.openNdb ?? loadNdb,
        openNvdb: opts.openNvdb ?? loadNvdb,
        batchSize: opts.batchSize ?? REPAIR_BATCH_SIZE,
        retryDelayMs: opts.retryDelayMs ?? 250,
        now: opts.now ?? (() => new Date())
    };
}

export async function runRepair(options) {
    const opts = normalizeOptions(options);
    if (!opts.embedder) throw new Error('runRepair: an embedder (embedBatch/embed) is required');
    // One bounded, recorded retry for a transient transport failure (Phase 0
    // rule): a dropped connection must not turn a valid repair into an
    // unverified one. Permanent errors still surface on the second attempt.
    const embedder = wrapRepairEmbedder(opts.embedder, { retryDelayMs: opts.retryDelayMs });
    const scope = opts.storageOnly ? 'storage' : opts.memoryOnly ? 'memory' : 'both';
    const startedAt = opts.now();

    const layout = resolveSnapshotLayout(opts.snapshot);
    const liveRoots = resolveLiveRoots(opts.repoRoot);
    const referenceRoot = path.join(layout.root, 'reference');
    const guard = createRepairGuard({ workRoot: layout.workRoot, referenceRoot, liveRoots });
    guard.assertNotLive(layout.root, 'snapshot root');
    const scratchArea = resolveScratchArea(layout.root);
    const scratchDir = assertScratchLocation(path.join(scratchArea.scratchArea, `repair-${process.pid}`), scratchArea);

    const suite = loadGoldenSuite(opts.goldenPath);
    const expectedDim = opts.expectedDim ?? suite.dataset?.expectedEmbeddingDim ?? 2560;
    if (!Number.isInteger(expectedDim) || expectedDim <= 0) throw new Error(`runRepair: invalid expected embedding dim ${expectedDim}`);

    const errors = [];
    const report = {
        tool: TOOL,
        version: REPORT_VERSION,
        ok: true,
        mode: opts.apply ? 'apply' : 'audit',
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        totalDurationMs: null,
        snapshot: {
            root: layout.root,
            workRoot: layout.workRoot,
            referenceRoot,
            reportsDir: layout.reportsDir,
            manifestPath: layout.manifestPath,
            manifestSha256: layout.manifestSha256,
            manifestName: layout.manifest.name ?? null,
            manifestMode: layout.manifest.mode ?? null
        },
        options: {
            apply: opts.apply,
            scope,
            expectedDim,
            batchSize: opts.batchSize,
            goldenPath: fullPath(opts.goldenPath),
            scratchDir,
            embedRetryDelayMs: opts.retryDelayMs,
            note: opts.apply
                ? 'writes only the snapshot work copy (nVDB work collections) and the reports directory'
                : 'AUDIT/PROBE only — no database writes'
        },
        expectedDim,
        audit: {
            storage: { skipped: true, reason: scope === 'memory' ? '--memory-only' : 'not reached' },
            memory: { skipped: true, reason: scope === 'storage' ? '--storage-only' : 'not reached' },
            crossCollection: { skipped: true, reason: 'not reached' }
        },
        probe: { skipped: true, reason: scope === 'memory' ? '--memory-only' : 'not reached' },
        probeAfter: null,
        repairs: {
            planned: 0,
            uniqueInputs: 0,
            counts: { storage: 0, memory: 0 },
            unavailable: [],
            collisions: { detected: 0, allowedWithReplaced: 0, allowedBySameInput: 0, resolvedByRetry: 0, remaining: [] },
            reembedRetries: 0,
            ownersToRepairTogether: [],
            ownersPlanned: 0,
            ownerItems: 0,
            ownersUnavailable: [],
            inserted: [],
            refusal: null,
            failure: null
        },
        verification: null,
        embed: embedder.stats,
        warnings: [],
        reports: [],
        errors
    };

    const { Database: NvdbDatabase } = opts.openNvdb();
    const nvdb = new NvdbDatabase(layout.nvdbDir);
    let storageColl = null;
    let memoryColl = null;
    let memoryDb = null;
    let staged = null;

    const closeCollections = () => {
        if (typeof storageColl?.close === 'function') {
            try { storageColl.close(); } catch (e) { errors.push({ bucket: 'teardown', id: 'close-storage-collection', error: e.message }); }
        }
        if (typeof memoryColl?.close === 'function') {
            try { memoryColl.close(); } catch (e) { errors.push({ bucket: 'teardown', id: 'close-memory-collection', error: e.message }); }
        }
    };

    try {
        guard.assertWork(layout.nvdbDir, 'nVDB work copy');
        const collections = nvdb.listCollections();
        const needStorage = scope !== 'memory';
        const needMemory = scope !== 'storage';
        if (needStorage && !collections.includes('storage')) {
            throw new Error(`nVDB at ${layout.nvdbDir} has no "storage" collection (has: ${collections.join(', ') || '<none>'})`);
        }
        if (needMemory && !collections.includes('memory')) {
            throw new Error(`nVDB at ${layout.nvdbDir} has no "memory" collection (has: ${collections.join(', ') || '<none>'})`);
        }
        if (needStorage) storageColl = nvdb.getCollection('storage');
        if (needMemory) memoryColl = nvdb.getCollection('memory');

        // ── storage audit ────────────────────────────────────────────────
        let storageAudit = null;
        if (needStorage) {
            const scanIndexPath = guard.assertWork(layout.scanIndexPath, 'nvdb scan-index.json');
            if (!fs.existsSync(scanIndexPath)) throw new Error(`scan-index.json missing: ${scanIndexPath}`);
            const scanIndex = JSON.parse(fs.readFileSync(scanIndexPath, 'utf8'));
            const chunkIds = chunkIdsFromScanIndex(scanIndex);
            guard.assertWork(layout.storageDir, 'storage work copy');
            storageAudit = auditStorageVectors({
                ids: chunkIds,
                coll: storageColl,
                storageWorkRoot: layout.storageDir,
                guard,
                expectedDim
            });
            report.audit.storage = {
                ...storageAudit.summary,
                scanIndex: {
                    path: scanIndexPath,
                    sha256: sha256File(scanIndexPath),
                    chunkIds: chunkIds.length
                },
                ...(storageAudit.summary.suspiciousGroups > 0 ? { suspicious: storageAudit.suspiciousGroups } : {}),
                ...(storageAudit.summary.legitimateSameContentGroups > 0 ? { legitimate: storageAudit.legitimateGroups } : {})
            };
        }

        // ── memory audit (staged scratch copy of the nDB journal) ────────
        let memoryAudit = null;
        if (needMemory) {
            staged = stageMemoryCopy({ guard, memoryDir: layout.memoryDir, scratchDir });
            const { Database } = opts.openNdb();
            memoryDb = Database.open(staged.journalPath, { persistence: 'lazy' });
            const docs = memoryDb.iter();
            memoryAudit = auditMemoryVectors({ docs, coll: memoryColl, expectedDim });
            report.audit.memory = {
                ...memoryAudit.summary,
                ...(memoryAudit.summary.suspiciousGroups > 0 ? { suspicious: memoryAudit.suspiciousGroups } : {}),
                ...(memoryAudit.summary.legitimateSameContentGroups > 0 ? { legitimate: memoryAudit.legitimateGroups } : {}),
                ...(memoryAudit.inputErrors.length > 0 ? { inputErrors: memoryAudit.inputErrors } : {}),
                textIndexSource: {
                    stagedCopy: true,
                    stagedFile: staged.journalPath,
                    note: 'the memory nDB journal is read from a scratch copy because nDB rewrites .fti caches; the lab copy is never opened for writing'
                }
            };
        }

        if (storageAudit && memoryAudit) {
            report.audit.crossCollection = crossCollectionNote(storageAudit.vectorHashes, memoryAudit.vectorHashes);
        } else {
            report.audit.crossCollection = { skipped: true, reason: `scope is ${scope}` };
        }

        // ── probe (always before any audit result is acted on) ──────────
        const explicitIds = suite.explicitVectorIds ?? [];
        if (scope === 'memory') {
            report.probe = { skipped: true, reason: '--memory-only: the golden explicit ids are storage chunks' };
        } else {
            // A missing/mis-sized golden set is a broken precondition: fail loud
            // before embedding anything.
            if (explicitIds.length !== EXPLICIT_VECTOR_COUNT) {
                throw new Error(`the golden suite must declare exactly ${EXPLICIT_VECTOR_COUNT} explicitVectorIds (got ${explicitIds.length}) — refusing to probe or repair`);
            }
            const replacedByRun = new Set([
                ...(storageAudit?.summary.affectedIds ?? []).map((id) => collectionKeyOf('storage', id)),
                ...(memoryAudit?.summary.affectedIds ?? []).map((id) => collectionKeyOf('memory', id))
            ]);
            try {
                report.probe = await probeExplicitVectors({
                    explicitIds,
                    coll: storageColl,
                    storageWorkRoot: layout.storageDir,
                    guard,
                    embedder,
                    expectedDim,
                    storageIndex: storageAudit?.vectorIndex ?? null,
                    memoryIndex: memoryAudit?.vectorIndex ?? null,
                    replacedKeys: replacedByRun
                });
            } catch (e) {
                // Broken preconditions (missing chunk/source/capability) are not a
                // provider finding: fail loud and write nothing.
                report.probe = { skipped: true, reason: `probe could not run: ${e.message}` };
                report.repairs.refusal = `probe could not run — refusing every write: ${e.message}`;
                errors.push({ bucket: 'probe', id: 'explicit-five', error: e.message });
                report.finishedAt = opts.now().toISOString();
                report.totalDurationMs = opts.now().getTime() - startedAt.getTime();
                report.ok = false;
                report.reports.push(writeRepairReport(report, layout.reportsDir, startedAt, opts.apply ? '-before' : ''));
                return { report, files: report.reports };
            }

            if (report.probe.classification.blocksRepair) {
                // The provider is the thing under test. Record the finding with
                // full per-mode evidence and stop before any write.
                const owners = report.probe.classification.collisions?.ownersToRepairTogether ?? [];
                const message = `probe unhealthy (${report.probe.classification.code}): ${report.probe.classification.verdict}`
                    + (owners.length > 0 ? ` | repair together: ${owners.join(', ')}` : '');
                report.repairs.refusal = `probe failed — refusing every write: ${message}`;
                errors.push({ bucket: 'probe', id: 'explicit-five', error: message });
                report.finishedAt = opts.now().toISOString();
                report.totalDurationMs = opts.now().getTime() - startedAt.getTime();
                report.ok = false;
                report.reports.push(writeRepairReport(report, layout.reportsDir, startedAt, opts.apply ? '-before' : ''));
                return { report, files: report.reports };
            }
            if (report.probe.classification.code === 'stored-owner-corrupt') {
                const owners = report.probe.collisions?.ownersToRepairTogether ?? [];
                report.warnings.push(
                    `probe: stored-owner-corrupt — ${report.probe.collisions.counts.storedOwnerCorrupt} collision(s) are old stored damage (not a current provider fault); owner(s) to repair together with the candidates: ${owners.join(', ')}`
                );
            }
            if (report.probe.classification.code === 'input-unstable') {
                report.warnings.push(`probe: ${report.probe.classification.verdict}`);
            }
        }

        if (!opts.apply) {
            // Audit/probe only: nothing was inserted, nothing is flushed.
            report.finishedAt = opts.now().toISOString();
            report.totalDurationMs = opts.now().getTime() - startedAt.getTime();
            report.ok = errors.length === 0;
            report.reports.push(writeRepairReport(report, layout.reportsDir, startedAt));
            return { report, files: report.reports };
        }

        // ── apply ───────────────────────────────────────────────────────
        const ownerKeys = report.probe.collisions?.ownersToRepairTogether ?? [];
        const ownerPlan = planOwnerRepairs({
            ownerKeys,
            storageColl,
            memoryColl,
            storageWorkRoot: layout.storageDir,
            guard,
            inputTextById: memoryAudit?.inputTextById ?? new Map()
        });
        report.repairs.ownersToRepairTogether = ownerKeys;
        report.repairs.ownersPlanned = ownerPlan.repairs.length;
        report.repairs.ownersUnavailable = ownerPlan.unavailable;

        const plan = buildRepairPlan({ storageAudit, memoryAudit, scope, ownerRepairs: ownerPlan.repairs });
        report.repairs.planned = plan.items.length;
        report.repairs.uniqueInputs = plan.uniqueInputs.length;
        report.repairs.ownerItems = plan.ownerItems;
        report.repairs.counts = plan.counts;
        report.repairs.unavailable = [...plan.unavailable, ...ownerPlan.unavailable];

        if (report.repairs.unavailable.length > 0) {
            report.repairs.refusal = `cannot repair ${report.repairs.unavailable.length} suspicious record(s) without a usable source — refusing every write`;
            for (const item of report.repairs.unavailable) {
                const id = item.id ?? item.key ?? 'unknown';
                errors.push({ bucket: 'refusal', id, error: `${item.collection ?? 'owner'}: ${item.reason}` });
            }
        } else if (plan.items.length > 0) {
            let vectors = null;
            const replacedKeys = new Set(plan.items.map((item) => collectionKeyOf(item.collection, item.id)));
            let entries = null;
            let collisions = [];
            try {
                const embedded = await embedBatchTexts(embedder, plan.uniqueInputs.map((u) => u.text), { batchSize: opts.batchSize });
                entries = plan.uniqueInputs.map((input, index) => ({
                    label: `repair input ${index}`,
                    inputHash: input.inputHash,
                    inputIndex: index,
                    vector: embedded[index]
                }));
                report.repairs.validation = validateEmbeddingSet(entries, expectedDim);

                // A fresh vector must not recreate a cross-content duplicate that
                // already exists in the index (provider fault across requests).
                const toEntry = (item) => ({
                    collection: item.collection,
                    id: item.id,
                    key: collectionKeyOf(item.collection, item.id),
                    inputHash: plan.uniqueInputs[item.uniqueInputIndex].inputHash,
                    inputIndex: item.uniqueInputIndex,
                    vectorHash: entries[item.uniqueInputIndex].analysis.hash
                });
                const planEntries = plan.items.map(toEntry);
                const collisionStats = {};
                collisions = findStoredCollisions({
                    entries: planEntries,
                    storageIndex: storageAudit?.vectorIndex ?? null,
                    memoryIndex: memoryAudit?.vectorIndex ?? null,
                    replacedKeys,
                    storageWorkRoot: layout.storageDir,
                    guard,
                    stats: collisionStats
                });
                report.repairs.collisions.detected = collisions.length;
                report.repairs.collisions.allowedWithReplaced = collisionStats.allowedByReplacement ?? 0;
                report.repairs.collisions.allowedBySameInput = collisionStats.allowedBySameInput ?? 0;

                if (collisions.length > 0) {
                    // One recorded re-embed of ONLY the colliding inputs: the
                    // documented fault is intermittent across requests.
                    const retryIndexes = [...new Set(collisions.map((c) => c.inputIndex))];
                    const retryVectors = await embedBatchTexts(embedder, retryIndexes.map((i) => plan.uniqueInputs[i].text), { batchSize: opts.batchSize });
                    retryIndexes.forEach((inputIndex, k) => { entries[inputIndex].vector = retryVectors[k]; });
                    report.repairs.reembedRetries = retryIndexes.length;
                    report.repairs.validation = validateEmbeddingSet(entries, expectedDim);
                    collisions = findStoredCollisions({
                        entries: plan.items.map((item) => ({
                            collection: item.collection,
                            id: item.id,
                            key: collectionKeyOf(item.collection, item.id),
                            inputHash: plan.uniqueInputs[item.uniqueInputIndex].inputHash,
                            inputIndex: item.uniqueInputIndex,
                            vectorHash: entries[item.uniqueInputIndex].analysis.hash
                        })),
                        storageIndex: storageAudit?.vectorIndex ?? null,
                        memoryIndex: memoryAudit?.vectorIndex ?? null,
                        replacedKeys,
                        storageWorkRoot: layout.storageDir,
                        guard
                    });
                    report.repairs.collisions.resolvedByRetry = report.repairs.collisions.detected - collisions.length;
                }

                if (collisions.length > 0) {
                    report.repairs.collisions.remaining = collisions.slice(0, 25);
                    vectors = null;
                    report.repairs.refusal = `refusing every write: ${collisions.length} fresh vector(s) are byte-identical to a vector already stored for a different input (provider duplicate) — e.g. ${collisions[0].id} == ${collisions[0].owner.key}`;
                    errors.push({ bucket: 'refusal', id: 'stored-collision', error: report.repairs.refusal });
                } else {
                    vectors = entries.map((e) => e.vector);
                }
            } catch (e) {
                report.repairs.refusal = `embedding/validation failed before any write: ${e.message}`;
                errors.push({ bucket: 'refusal', id: 'embed', error: e.message });
                vectors = null;
            }

            if (vectors) {
                // The before state is on disk before the first insert.
                report.reports.push(writeRepairReport({ ...report, phase: 'before' }, layout.reportsDir, startedAt, '-before'));

                const touched = new Map();
                for (const item of plan.items) {
                    const coll = item.collection === 'storage' ? storageColl : memoryColl;
                    touched.set(item.collection, coll);
                }
                try {
                    for (const item of plan.items) {
                        const coll = touched.get(item.collection);
                        coll.insert(item.id, vectors[item.uniqueInputIndex], item.payloadString);
                        report.repairs.inserted.push({ collection: item.collection, id: item.id });
                    }
                } catch (e) {
                    report.repairs.failure = {
                        id: report.repairs.inserted.length < plan.items.length
                            ? (plan.items[report.repairs.inserted.length]?.id ?? 'unknown')
                            : 'flush',
                        error: e.message,
                        note: 'no transaction was claimed: the ids listed in repairs.inserted may already be durable, everything else is untouched'
                    };
                    errors.push({ bucket: 'write', id: report.repairs.failure.id, error: e.message });
                } finally {
                    // Flush whatever is chosen to be durable, then verify what the
                    // work copy actually holds now.
                    for (const [name, coll] of touched) {
                        if (typeof coll?.flush !== 'function') continue;
                        try { coll.flush(); } catch (e) { errors.push({ bucket: 'flush', id: name, error: e.message }); }
                    }
                }
            }
        } else {
            report.repairs.note = 'no suspicious records in scope — nothing to write';
        }

        // ── verification (in-place re-audit of the work copy) ───────────
        const verifyStorage = storageAudit
            ? auditStorageVectors({
                ids: chunkIdsFromScanIndex(JSON.parse(fs.readFileSync(guard.assertWork(layout.scanIndexPath, 'nvdb scan-index.json'), 'utf8'))),
                coll: storageColl,
                storageWorkRoot: layout.storageDir,
                guard,
                expectedDim
            })
            : null;
        const verifyMemory = memoryAudit
            ? auditMemoryVectors({ docs: memoryDb.iter(), coll: memoryColl, expectedDim })
            : null;
        report.verification = {
            storageSuspiciousGroups: verifyStorage ? verifyStorage.summary.suspiciousGroups : null,
            memorySuspiciousGroups: verifyMemory ? verifyMemory.summary.suspiciousGroups : null,
            storageAffectedIds: verifyStorage ? verifyStorage.summary.affectedIds : null,
            memoryAffectedIds: verifyMemory ? verifyMemory.summary.affectedIds : null,
            ok: (verifyStorage ? verifyStorage.summary.suspiciousGroups === 0 : true)
                && (verifyMemory ? verifyMemory.summary.suspiciousGroups === 0 : true)
        };
        if (!report.verification.ok) {
            errors.push({
                bucket: 'verification',
                id: 'residual-duplicates',
                error: `suspicious duplicate groups remain after repair: storage=${report.verification.storageSuspiciousGroups} memory=${report.verification.memorySuspiciousGroups}`
            });
        }
        if (report.repairs.inserted.length === 0) {
            report.verification.note = 'no repair was written — this is the unchanged pre-repair state';
        }

        // Targeted five: distinctness after repair (fresh provider call).
        if (!storageColl) {
            report.probeAfter = { skipped: true, reason: '--memory-only' };
        } else if (report.repairs.inserted.length === 0) {
            report.probeAfter = { skipped: true, reason: 'no repair was written' };
        } else {
            try {
                report.probeAfter = await probeExplicitVectors({
                    explicitIds,
                    coll: storageColl,
                    storageWorkRoot: layout.storageDir,
                    guard,
                    embedder,
                    expectedDim,
                    // the state AFTER the repair, so a residual stored collision
                    // shows up in the post-probe too
                    storageIndex: verifyStorage?.vectorIndex ?? null,
                    memoryIndex: verifyMemory?.vectorIndex ?? null
                });
                if (report.probeAfter.classification.providerFaulty) {
                    errors.push({
                        bucket: 'probe-after',
                        id: 'current-provider-faulty',
                        error: `the post-repair probe still shows a current-provider fault: ${report.probeAfter.classification.verdict}`
                    });
                }
                if (report.probeAfter.classification.code !== 'healthy' && !report.probeAfter.classification.providerFaulty) {
                    report.warnings.push(`post-repair probe: ${report.probeAfter.classification.code} — ${report.probeAfter.classification.verdict}`);
                }
            } catch (e) {
                // The re-audit above already proved what the work copy holds; a
                // transport/provider failure on this supplementary probe must not
                // turn a verified repair into an unverified one.
                report.probeAfter = { skipped: true, reason: `post-repair probe failed: ${e.message}` };
                report.warnings.push(`post-repair distinctness probe failed after a verified repair: ${e.message}`);
            }
        }

        report.finishedAt = opts.now().toISOString();
        report.totalDurationMs = opts.now().getTime() - startedAt.getTime();
        report.ok = errors.length === 0 && !report.repairs.refusal && !report.repairs.failure && report.verification.ok;
        report.reports.push(writeRepairReport({ ...report, phase: 'after' }, layout.reportsDir, startedAt, '-after'));
        return { report, files: report.reports };
    } finally {
        if (memoryDb) {
            try { memoryDb.close(); } catch (e) { errors.push({ bucket: 'teardown', id: 'close-memory-db', error: e.message }); }
        }
        closeCollections();
        if (typeof nvdb.close === 'function') {
            try { nvdb.close(); } catch (e) { errors.push({ bucket: 'teardown', id: 'close-nvdb', error: e.message }); }
        }
        removeScratch(staged?.dir ?? scratchDir, scratchArea);
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
    const args = { snapshot: null, apply: false, storageOnly: false, memoryOnly: false };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--snapshot' || token === '--snapshot-root' || token === '--snapshotRoot') args.snapshot = argv[++i];
        else if (token.startsWith('--snapshot=')) args.snapshot = token.slice('--snapshot='.length);
        else if (token === '--apply') args.apply = true;
        else if (token === '--storage-only') args.storageOnly = true;
        else if (token === '--memory-only') args.memoryOnly = true;
        else throw new Error(`unknown argument: ${token}`);
    }
    if (!args.snapshot) throw new Error('missing --snapshot <snapshot root>');
    if (args.storageOnly && args.memoryOnly) throw new Error('--storage-only and --memory-only are mutually exclusive');
    return args;
}

// The embed client from src/embed-client.js, configured from config.json. The
// access key is passed through and never printed or written to the report.
async function createGatewayEmbedder(repoRoot) {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8'));
    const httpUrl = config.gateway?.httpUrl;
    if (!httpUrl) throw new Error('config.json gateway.httpUrl is required to embed repair inputs');
    const client = await import(pathToFileURL(path.join(repoRoot, 'src', 'embed-client.js')).href);
    return client.createEmbedClient(httpUrl, config.gateway?.accessKey ?? null);
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const embedder = await createGatewayEmbedder(REPO_ROOT);
    const { report, files } = await runRepair({
        snapshot: args.snapshot,
        embedder,
        apply: args.apply,
        storageOnly: args.storageOnly,
        memoryOnly: args.memoryOnly
    });
    process.stdout.write(`${summarize(report)}\n\nreports:\n${files.map((f) => `  ${f}`).join('\n')}\n`);
    if (!report.ok) process.exitCode = 1;
    return { report, files };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);
if (invokedDirectly) {
    main().catch((e) => {
        process.stderr.write(`repair-memory-lab-vectors failed: ${e.message}\n${e.stack ?? ''}\n`);
        process.exitCode = 1;
    });
}
