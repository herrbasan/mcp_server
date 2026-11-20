import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { createProgressReporter } from '../../utils/progress-reporter.js';
import { loadNvdb, isNvdbAvailable } from './nvdb-loader.js';
import { makeChunker } from './chunker.js';
import { createContextEnhancer, formatContextHeader } from './context-enhancer.js';
import { embedGroupWithPersistence } from './embedding-persistence.js';
import { createStoredVectorGuard } from '../../embed-client.js';
import { resolveSearchOptions, describeSearchOptions, selectLanes } from './search-options.js';
import { resolveRelevanceFloor, assessRelevance } from './relevance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const logger = getLogger();

const DEFAULTS = {
    enabled: true,
    dbPath: 'data/nvdb',
    scanIntervalMinutes: 5,
    scanTimeoutMinutes: 30,
    embeddingDim: 2560,
    chunkMaxTokens: 1024,
    chunkOverlapTokens: 128,
    chunkTokCharsRatio: 2.5,
    maxFileSizeBytes: 10 * 1024 * 1024,
    batchTokenLimit: 29000,
    maxBatchTexts: 32,
    filesPerGroup: 100,
    maxRetries: 1,
    batchDelayMs: 100,
    textExtensions: ['.md', '.txt', '.json', '.js', '.mjs', '.css', '.html', '.htm', '.log', '.yaml', '.yml', '.xml', '.csv', '.tsv', '.sql'],
    ignore: [],
    // A snapshot index is a fixed, externally built collection set: no watch,
    // no scan, no compaction. Its payload schema is the builder's, not this
    // agent's (see searchDocuments).
    snapshot: false,
    // Route that produced the index's vectors. Mixing routes mixes vector
    // spaces and produces confident nonsense.
    embeddingPath: null,
    hybrid: {
        enabled: false,
        rrfK: 10,
        candidateK: 200,
        vectorWeight: 1.0,
        lexicalWeight: 1.0,
        diversityField: null,
        maxPerDocument: 2
    },
    rerank: {
        enabled: false,
        modelPath: null,
        tokenizerPath: null,
        textField: 'content',
        maxLength: 64,
        batchSize: 10,
        shortlist: 10,
        weight: 0.2
    }
};

const COLLECTIONS = {
    storage: { description: 'Storage files under agents.storage.root' },
    memory: { description: 'Memories (reserved for future migration)' }
};

let CONFIG = null;
let DATABASE = null;
let FILTER_BUILDER = null;
let COLLECTION_INSTANCES = new Map();
let SCAN_TIMER = null;
let IS_SCANNING = false;
let SCAN_STARTED_AT = null;
let LAST_SCAN_AT = null;
let LAST_SCAN_ERROR = null;
let SCAN_STATS = { added: 0, updated: 0, removed: 0, errors: 0, skipped: 0 };
let GATEWAY = null;
let STORAGE_ROOT = null;
let CHUNKER = null;
let CONTEXT_ENHANCER = null;
let RERANKER = null;
// Stored-vector guard for every chunk vector this agent writes (see
// createStoredVectorGuard). Built from the live index in init(): the
// process-local guard inside embed-client cannot see vectors that an earlier
// process stored for different text.
let STORED_VECTOR_GUARD = null;
// Set when a scan produces tombstones; cleared by a successful compaction. The
// marker file makes that survive a restart, so a clean boot does not force a
// 100 MB segment rewrite (which stalled unrelated requests for ~20 s).
let compactionDirty = false;

const COMPACTION_FLAG = () => path.resolve(PROJECT_ROOT, CONFIG?.dbPath || DEFAULTS.dbPath, 'compaction-pending');

function markCompactionDirty() {
    compactionDirty = true;
    try {
        fs.mkdirSync(path.dirname(COMPACTION_FLAG()), { recursive: true });
        fs.writeFileSync(COMPACTION_FLAG(), new Date().toISOString(), 'utf8');
    } catch (e) {
        logger.warn(`[VDB] cannot write compaction marker: ${e.message}`, null, 'VDB');
    }
}

function clearCompactionDirty() {
    compactionDirty = false;
    try {
        fs.rmSync(COMPACTION_FLAG(), { force: true });
    } catch (e) {
        logger.warn(`[VDB] cannot clear compaction marker: ${e.message}`, null, 'VDB');
    }
}

const INDEX_PATH = () => path.resolve(PROJECT_ROOT, CONFIG?.indexPath || path.join(CONFIG?.dbPath || DEFAULTS.dbPath, 'scan-index.json'));

function hashContent(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

// Yield the main thread back to the event loop. setImmediate runs in the
// check phase — AFTER pending I/O results, port messages, and due timers
// have processed — so one yield lets every queued task through before the
// scan continues. This is what keeps MCP tool handling alive during scans
// (#31): the scan previously swept 586+ files with zero awaits, holding
// the main thread 10-45s per pass.
function yieldLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

// Async read for the scan path: fs.promises.readFile runs on the libuv
// threadpool, so the main thread only pays for string decode + hash — not
// the disk wait. Same oversize contract as readTextFile (#31).
async function readTextFileAsync(absolutePath) {
    const buf = await fs.promises.readFile(absolutePath);
    if (buf.length > CONFIG.maxFileSizeBytes) {
        throw new Error(`File exceeds maxFileSizeBytes (${CONFIG.maxFileSizeBytes}): ${absolutePath}`);
    }
    return buf.toString('utf-8');
}

function loadIndex() {
    const p = INDEX_PATH();
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
        logger.warn(`[VDB] Failed to load scan index: ${e.message}`, null, 'VDB');
    }
    return { files: {} };
}

function saveIndex(index) {
    const p = INDEX_PATH();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(index, null, 2));
}

function isTextFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return CONFIG.textExtensions.includes(ext);
}

function safeRel(root, absolutePath) {
    return path.relative(root, absolutePath).replace(/\\/g, '/');
}

// ── Ignore logic (.nvdb_ignore files + config defaults) ──────────────

const IGNORE_FILE_NAME = '.nvdb_ignore';

function parseIgnoreFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const patterns = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        patterns.push(trimmed);
    }
    return patterns;
}

function matchIgnorePattern(name, pattern) {
    if (pattern === '*') return true;
    if (pattern.includes('*') || pattern.includes('?')) {
        // Minimal glob: only * and ? supported.
        const regex = new RegExp(
            '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        return regex.test(name);
    }
    return name === pattern;
}

function isIgnored(name, patterns) {
    if (!patterns || patterns.length === 0) return false;
    for (const pattern of patterns) {
        if (matchIgnorePattern(name, pattern)) return true;
    }
    return false;
}

// Collect ignore patterns that apply to a directory.
// Includes .nvdb_ignore in that directory plus any inherited directory-level
// "*" rules from parents? For now keep it simple: only local .nvdb_ignore.
function getIgnorePatternsForDir(dir, collectionDefaults) {
    const filePatterns = parseIgnoreFile(path.join(dir, IGNORE_FILE_NAME));
    const defaults = collectionDefaults || [];
    if (!filePatterns) return defaults;
    return [...defaults, ...filePatterns];
}

const ENHANCEMENT_CACHE_COLLECTION = '__enhancement_cache';

function getCollection(name) {
    if (COLLECTION_INSTANCES.has(name)) return COLLECTION_INSTANCES.get(name);
    if (!DATABASE) throw new Error('VDB not initialized');

    // Decide by presence, never by swallowing the error: a failed open is a
    // real fault (best case another process holds the index LOCK), and the old
    // catch-all reported it as "collection already exists" — pointing at the
    // wrong cause entirely.
    const exists = DATABASE.listCollections().includes(name);
    const coll = exists
        ? DATABASE.getCollection(name)
        : DATABASE.createCollection(name, CONFIG.embeddingDim, { durability: 'buffered' });
    COLLECTION_INSTANCES.set(name, coll);
    return coll;
}

function createEnhancementCache() {
    if (!DATABASE) return null;
    const coll = getCollection(ENHANCEMENT_CACHE_COLLECTION);
    // nVDB requires a vector even though we only use get(id). Zero vector is fine.
    const zeroVector = new Array(CONFIG.embeddingDim).fill(0);

    return {
        get(contentHash) {
            try {
                // coll.get() returns a DocumentJs object {id, vector, payload} —
                // the cached JSON lives in .payload (issue #34: parsing the
                // whole object yielded "[object Object]" is not valid JSON and
                // defeated the cache on every lookup).
                const raw = coll.get(contentHash);
                if (!raw || raw.payload === undefined || raw.payload === null) return null;
                return JSON.parse(raw.payload);
            } catch (e) {
                logger.warn(`[VDB] Enhancement cache get failed: ${e.message}`, null, 'VDB');
                return null;
            }
        },
        set(contentHash, value) {
            try {
                coll.insert(contentHash, zeroVector, JSON.stringify(value));
            } catch (e) {
                logger.warn(`[VDB] Enhancement cache set failed: ${e.message}`, null, 'VDB');
            }
        }
    };
}

async function embedText(text) {
    if (!GATEWAY) throw new Error('VDB: gateway not available');
    const embedding = await GATEWAY.embed(text, { path: CONFIG.embeddingPath });
    if (!Array.isArray(embedding) || embedding.length !== CONFIG.embeddingDim) {
        throw new Error(`VDB: expected embedding dim ${CONFIG.embeddingDim}, got ${Array.isArray(embedding) ? embedding.length : typeof embedding}`);
    }
    return embedding;
}

function estimateTokens(text) {
    return Math.ceil(text.length / (CONFIG.chunkTokCharsRatio || 2.5));
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
    ]);
}

async function embedViaGateway(texts, retries) {
    // Embeds go through the gateway, which proxies to the llama-cpp-wrapper
    // (the gateway owns the embed model). Uses the BACKGROUND tier (5-min
    // deadlock guard): VDB indexing is a background task and must never abort
    // at the 30s foreground cap — premature aborts leave dirty llama-server
    // slots behind (known upstream wedge class), which then head-of-line block
    // every later request. "Eventually served" beats "abort and re-churn".
    if (!GATEWAY) throw new Error('VDB: gateway not available');
    retries = retries ?? CONFIG.maxRetries ?? 1;
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const embeddings = await GATEWAY.embedBatchBackground(texts, { path: CONFIG.embeddingPath });
            if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
                throw new Error(`VDB: expected ${texts.length} embeddings, got ${Array.isArray(embeddings) ? embeddings.length : typeof embeddings}`);
            }
            for (const emb of embeddings) {
                if (!Array.isArray(emb) || emb.length !== CONFIG.embeddingDim) {
                    throw new Error(`VDB: expected embedding dim ${CONFIG.embeddingDim}, got ${Array.isArray(emb) ? emb.length : typeof emb}`);
                }
            }
            // Degenerate-embedding guard (fail loud, never persist bad vectors).
            // The 2026-08-14 incident: llama-server --parallel 4 returned
            // byte-identical vectors for distinct texts and a wrong first-call
            // vector. Those poisoned the index with spurious score-1.0 matches.
            // Guards: (1) zero/NaN norm, (2) exact duplicates within one batch
            // (distinct texts CANNOT legitimately embed identically).
            for (let i = 0; i < embeddings.length; i++) {
                const emb = embeddings[i];
                let sq = 0;
                for (const v of emb) sq += v * v;
                if (!Number.isFinite(sq) || sq === 0) {
                    throw new Error(`VDB: degenerate embedding (norm²=${sq}) for batch item ${i} — refusing to persist`);
                }
            }
            if (embeddings.length > 1) {
                const seen = new Map(); // first-8-dims key -> batch index
                for (let i = 0; i < embeddings.length; i++) {
                    const key = embeddings[i].slice(0, 8).join(',');
                    const first = seen.get(key);
                    if (first !== undefined && texts[first] !== texts[i]) {
                        throw new Error(`VDB: duplicate embedding for distinct texts (batch items ${first} and ${i} identical in first 8 dims) — refusing to persist batch`);
                    }
                    seen.set(key, i);
                }
            }
            return embeddings;
        } catch (err) {
            lastErr = err;
            // Network/timeout: the wrapper is down or its queue outlasted the
            // timeout. Don't retry within this scan — pending files re-embed
            // on the next scan. No circuit breaker: the queue drains, so the
            // next scan simply tries again.
            const isNetwork = err.name === 'AbortError'
                || err.name === 'TimeoutError'
                || err.name === 'TypeError'
                || (err.message && (err.message.includes('timed out') || err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')));
            if (isNetwork) {
                logger.warn(`[VDB] Embedding provider unreachable (${err.message}) — ${texts.length} text(s) pending until next scan`, null, 'VDB');
                break;
            }
            // Non-network error (e.g. dim mismatch): retry as configured.
            if (attempt < retries) continue;
        }
    }
    throw lastErr;
}

async function embedBatchSplittable(batch) {
    if (batch.length <= 1) {
        return embedViaGateway(batch);
    }
    try {
        return await embedViaGateway(batch);
    } catch (err) {
        // Network/timeout: propagate — abort the scan (handled by caller).
        const isNetwork = err.name === 'AbortError'
            || err.name === 'TimeoutError'
            || err.name === 'TypeError'
            || (err.message && (err.message.includes('timed out') || err.message.includes('ECONNRESET') || err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')));
        if (isNetwork) throw err;
        // Defensive fallback: if a batch somehow still fails (e.g. per-request
        // size limit), split it in half. This should not happen if batching is correct.
        logger.warn(`[VDB] Batch of ${batch.length} failed (${err.message}), splitting in half as fallback...`, null, 'VDB');
        const mid = Math.ceil(batch.length / 2);
        const left = await embedBatchSplittable(batch.slice(0, mid));
        const right = await embedBatchSplittable(batch.slice(mid));
        return [...left, ...right];
    }
}

async function embedInBatches(texts, onBatch = null) {
    if (!GATEWAY) throw new Error('VDB: gateway not available');
    if (!Array.isArray(texts) || texts.length === 0) return [];

    const maxTokens = CONFIG.batchTokenLimit;
    const maxTexts = CONFIG.maxBatchTexts;
    const batches = [];
    let currentBatch = [];
    let currentTokens = 0;

    for (const text of texts) {
        const tokens = estimateTokens(text);
        const wouldExceedTokens = currentBatch.length > 0 && currentTokens + tokens > maxTokens;
        const wouldExceedCount = currentBatch.length >= maxTexts;
        if (wouldExceedTokens || wouldExceedCount) {
            batches.push({ batch: currentBatch, tokens: currentTokens });
            currentBatch = [text];
            currentTokens = tokens;
        } else {
            currentBatch.push(text);
            currentTokens += tokens;
        }
    }
    if (currentBatch.length > 0) batches.push({ batch: currentBatch, tokens: currentTokens });

    const allEmbeddings = [];
    for (let i = 0; i < batches.length; i++) {
        const { batch, tokens } = batches[i];
        logger.info(`[VDB] Embedding batch ${i + 1}/${batches.length} (${batch.length} texts, ~${tokens} tokens)`, null, 'VDB');
        const embeddings = await embedBatchSplittable(batch);
        allEmbeddings.push(...embeddings);
        onBatch?.(allEmbeddings);
        if (CONFIG.batchDelayMs > 0 && i < batches.length - 1) {
            await sleep(CONFIG.batchDelayMs);
        }
    }

    return allEmbeddings;
}

function readTextFile(absolutePath) {
    const stat = fs.statSync(absolutePath);
    if (stat.size > CONFIG.maxFileSizeBytes) {
        throw new Error(`File exceeds maxFileSizeBytes (${CONFIG.maxFileSizeBytes}): ${absolutePath}`);
    }
    return fs.readFileSync(absolutePath, 'utf-8');
}

async function prepareFileForIndexing(collectionName, absolutePath, sourceRoot, metadata = {}, preReadContent = null, preReadHash = null) {
    const relPath = safeRel(sourceRoot, absolutePath);
    const content = preReadContent ?? readTextFile(absolutePath);
    const contentHash = preReadHash ?? hashContent(content);
    const chunks = CHUNKER(content);
    const ext = path.extname(absolutePath).toLowerCase();
    const docBaseId = `${collectionName}:${relPath}`;
    const tokCharsRatio = CONFIG.chunkTokCharsRatio || 2.5;

    const preparedChunks = chunks.map((chunk, i) => ({
        docId: chunks.length === 1 ? docBaseId : `${docBaseId}#${i}`,
        text: chunk.text,
        splitIdx: chunk.splitIdx,
        charOffset: chunk.charOffset,
        charLen: chunk.charLen,
        isLastChunk: chunk.isLastChunk,
        tokEst: chunk.tokEst
    }));

    const stat = fs.statSync(absolutePath);
    let prepared = {
        docBaseId,
        collectionName,
        relPath,
        absolutePath,
        contentHash,
        extension: ext,
        tokCharsRatio,
        size: stat.size,
        content,
        metadata,
        chunks: preparedChunks
    };

    if (CONTEXT_ENHANCER) {
        prepared = await CONTEXT_ENHANCER.enhance(prepared);
    }

    return prepared;
}

// ── Stored-vector guard ──────────────────────────────────────────────
// Chunk ids are stable (`<collection>:<relPath>` or `…#<i>`), so one guard can
// cover every collection this agent indexes. Vector hashes must come from the
// stored vectors themselves; a file's contentHash is NOT enough because each
// chunk embeds a different slice (plus the enhancement header).
//
// The existing input for a stored chunk is rebuilt lazily — only when a fresh
// vector collides — from the chunk's payload coordinates read out of the
// current source file, with the same context header the enhancer applied. If
// the source no longer matches the payload's contentHash the reconstruction
// would be a guess, so it fails loud instead of comparing the wrong text.
export function storedChunkInput({ coll, chunkId, storageRoot }) {
    if (!coll || !chunkId) throw new Error('VDB: storedChunkInput needs coll and chunkId');
    const stored = coll.get(chunkId);
    if (!stored || stored.payload === undefined || stored.payload === null) {
        throw new Error(`VDB: stored vector ${chunkId} has no payload — cannot resolve its embedding input`);
    }
    const payload = JSON.parse(stored.payload);
    if (!Number.isInteger(payload.charOffset) || !Number.isInteger(payload.charLen)) {
        throw new Error(`VDB: stored vector ${chunkId} has no chunk coordinates (legacy payload) — re-index this file before it can be verified`);
    }
    // Prefer the configured storage root: payload.path is relative to it and is
    // where the index reads from, while payload.absolutePath can be a copy/lab
    // path that no longer holds the indexed bytes. The contentHash check still
    // decides whether the bytes are the ones that produced the stored vector.
    const candidates = [
        payload.path && storageRoot ? path.join(storageRoot, payload.path) : null,
        payload.absolutePath
    ].filter(Boolean);
    const sourcePath = candidates.find((p) => fs.existsSync(p));
    if (!sourcePath) {
        throw new Error(`VDB: stored vector ${chunkId} source file is missing (${candidates.join(', ') || 'no path in payload'}) — cannot resolve its embedding input`);
    }
    const content = fs.readFileSync(sourcePath, 'utf-8');
    if (payload.contentHash && hashContent(content) !== payload.contentHash) {
        throw new Error(`VDB: stored vector ${chunkId} was built from different content (${payload.path} changed since it was indexed) — re-index required before it can be verified`);
    }
    const chunkText = content.slice(payload.charOffset, payload.charOffset + payload.charLen);
    const header = payload.contextEnhanced ? formatContextHeader(payload) : '';
    return header + chunkText;
}

export function buildChunkVectorGuard({ collections, storageRoot }) {
    if (!Array.isArray(collections)) throw new Error('VDB: buildChunkVectorGuard needs a collections array');
    const guard = createStoredVectorGuard('vdb');
    const stats = { registered: 0, missing: 0 };
    for (const { name, coll, index } of collections) {
        for (const [docBaseId, entry] of Object.entries(index?.files || {})) {
            if (entry.collection !== name) continue;
            // Alias entries (content-hash duplicates) hold no vectors.
            if (!entry.chunks) continue;
            for (let i = 0; i < entry.chunks; i++) {
                const chunkId = entry.chunks === 1 ? docBaseId : `${docBaseId}#${i}`;
                const stored = coll.get(chunkId);
                if (!stored || !stored.vector) {
                    stats.missing++;
                    continue;
                }
                guard.register(chunkId, stored.vector, () => storedChunkInput({ coll, chunkId, storageRoot }));
                stats.registered++;
            }
        }
    }
    return { guard, ...stats };
}

// Assert EVERY chunk vector before the caller inserts any of them: a batch that
// reuses one stored vector must leave the file untouched, not half indexed.
export function assertPreparedChunkVectors(guard, prepared, embeddings) {
    if (!guard) throw new Error('VDB: stored-vector guard is not initialized — refusing to insert embeddings');
    if (!Array.isArray(embeddings) || embeddings.length !== prepared.chunks.length) {
        throw new Error(`VDB: ${prepared.docBaseId} has ${prepared.chunks.length} chunk(s) but ${Array.isArray(embeddings) ? embeddings.length : typeof embeddings} embedding(s)`);
    }
    guard.assertMany(prepared.chunks.map((chunk, i) => ({
        id: chunk.docId,
        vector: embeddings[i],
        input: chunk.text,
        where: `VDB ${prepared.collectionName}:${prepared.relPath} chunk ${i}`
    })));
}

export function registerPreparedChunkVectors(guard, prepared, embeddings) {
    if (!guard) throw new Error('VDB: stored-vector guard is not initialized — refusing to track embeddings');
    for (let i = 0; i < prepared.chunks.length; i++) {
        guard.register(prepared.chunks[i].docId, embeddings[i], prepared.chunks[i].text);
    }
}

export function releaseDocumentVectors(guard, docBaseId, chunkCount) {
    if (!guard) throw new Error('VDB: stored-vector guard is not initialized — refusing to release vectors');
    if (!chunkCount) return;
    for (let i = 0; i < chunkCount; i++) {
        guard.remove(chunkCount === 1 ? docBaseId : `${docBaseId}#${i}`);
    }
}

function deleteExistingChunks(docBaseId) {
    const index = loadIndex();
    const existing = index.files[docBaseId];
    if (!existing || !existing.chunks) return;
    const coll = getCollection(existing.collection);
    for (let i = 0; i < existing.chunks; i++) {
        // nVDB delete() returns false for unknown ids; that's expected when
        // the memtable was already flushed. Only throw on real errors.
        const chunkId = existing.chunks === 1 ? docBaseId : `${docBaseId}#${i}`;
        try { coll.delete(chunkId); } catch (e) {
            logger.warn(`[VDB] deleteExistingChunks: failed to delete ${chunkId}: ${e.message}`, null, 'VDB');
        }
    }
    releaseDocumentVectors(STORED_VECTOR_GUARD, docBaseId, existing.chunks);
}

// ── Content-hash dedup ───────────────────────────────────────────────
// The scan index carries a `hashToDoc` map: contentHash -> canonical docBaseId.
// When a new file's hash matches an existing entry, we skip indexing it and
// record it as an alias. This is path-agnostic: four copies of the same file
// in different folders get indexed once.

function findDuplicateByHash(index, contentHash, docBaseId) {
    if (!contentHash || !index.hashToDoc) return null;
    const canonical = index.hashToDoc[contentHash];
    if (!canonical || canonical === docBaseId) return null;
    if (!index.files[canonical]) return null; // canonical was deleted, stale entry
    return canonical;
}

function registerHash(index, contentHash, docBaseId) {
    if (!contentHash) return;
    if (!index.hashToDoc) index.hashToDoc = {};
    // Only register if no canonical exists yet. First-seen wins.
    if (!index.hashToDoc[contentHash]) {
        index.hashToDoc[contentHash] = docBaseId;
    }
}

function unregisterHash(index, contentHash) {
    if (!contentHash || !index.hashToDoc) return;
    // If this doc was the canonical, remove the mapping. A future scan will
    // re-register whichever duplicate it encounters first.
    if (index.hashToDoc[contentHash]) {
        delete index.hashToDoc[contentHash];
    }
}

// Assert → insert → register for one prepared file. Split out of
// insertPreparedFile so the ordering (nothing inserted when any chunk collides)
// is a single, testable step.
export function insertPreparedVectors({ coll, guard, prepared, embeddings }) {
    if (!coll) throw new Error('VDB: insertPreparedVectors needs a collection');
    assertPreparedChunkVectors(guard, prepared, embeddings);
    const { relPath, absolutePath, contentHash, extension, metadata } = prepared;
    for (let i = 0; i < prepared.chunks.length; i++) {
        const chunk = prepared.chunks[i];
        const payload = {
            path: relPath,
            absolutePath,
            collection: prepared.collectionName,
            extension,
            splitIdx: chunk.splitIdx,
            charOffset: chunk.charOffset,
            charLen: chunk.charLen,
            isLastChunk: chunk.isLastChunk,
            tokEst: chunk.tokEst,
            contentHash,
            ...metadata
        };
        coll.insert(chunk.docId, embeddings[i], JSON.stringify(payload));
    }
    registerPreparedChunkVectors(guard, prepared, embeddings);
}

function insertPreparedFile(prepared, embeddings) {
    const coll = getCollection(prepared.collectionName);
    const { docBaseId, relPath, absolutePath, contentHash, metadata } = prepared;

    insertPreparedVectors({ coll, guard: STORED_VECTOR_GUARD, prepared, embeddings });

    const index = loadIndex();
    const fileStat = fs.statSync(absolutePath);
    index.files[docBaseId] = {
        collection: prepared.collectionName,
        path: relPath,
        absolutePath,
        contentHash,
        mtime: fileStat.mtimeMs,
        // Store actual file size (stat.size), NOT the sum of chunk text lengths.
        // The skip check compares against stat.size — if these don't match,
        // every file gets re-embedded on every scan.
        size: fileStat.size,
        chunks: prepared.chunks.length,
        indexedAt: new Date().toISOString(),
        metadata
    };
    registerHash(index, contentHash, docBaseId);
    saveIndex(index);

    return { docId: docBaseId, chunks: prepared.chunks.length };
}

function deleteFileFromIndex(docBaseId) {
    const index = loadIndex();
    const existing = index.files[docBaseId];
    if (!existing) return false;

    // Only delete vectors if this is the canonical (non-alias) entry.
    if (!existing.duplicateOf && existing.chunks > 0) {
        const coll = getCollection(existing.collection);
        for (let i = 0; i < existing.chunks; i++) {
            const chunkId = existing.chunks === 1 ? docBaseId : `${docBaseId}#${i}`;
            try { coll.delete(chunkId); } catch (e) {
                logger.warn(`[VDB] deleteFileFromIndex: failed to delete ${chunkId}: ${e.message}`, null, 'VDB');
            }
        }
        releaseDocumentVectors(STORED_VECTOR_GUARD, docBaseId, existing.chunks);
        unregisterHash(index, existing.contentHash);
    }
    delete index.files[docBaseId];
    saveIndex(index);
    return true;
}

async function listWatchedFiles(collectionName) {
    const files = [];
    const collectionDefaults = CONFIG.ignore || [];
    if (collectionName === 'storage') {
        if (!STORAGE_ROOT || !fs.existsSync(STORAGE_ROOT)) return files;
        const watchFolders = CONFIG.watchFolders;
        if (Array.isArray(watchFolders) && watchFolders.length > 0) {
            for (const folder of watchFolders) {
                const folderPath = path.join(STORAGE_ROOT, folder);
                if (!fs.existsSync(folderPath)) {
                    logger.warn(`[VDB] watchFolders entry not found: ${folderPath}`, null, 'VDB');
                    continue;
                }
                await walk(folderPath, STORAGE_ROOT, files, { collection: 'storage', watchFolder: folder }, collectionDefaults);
            }
        } else {
            await walk(STORAGE_ROOT, STORAGE_ROOT, files, { collection: 'storage' }, collectionDefaults);
        }
    }
    return files;
}

// readdirSync here used to block the whole server: enumerating ~9.7k files took
// ~20 s, and every HTTP request during it queued behind the scan (measured with
// a 250 ms poll of a static file: p95 13 s, max 20 s). readdir is async, so the
// walk yields between directories and requests keep moving.
async function walk(dir, root, out, baseMeta, collectionDefaults) {
    const ignorePatterns = getIgnorePatternsForDir(dir, collectionDefaults);
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
        logger.warn(`[VDB] Cannot read directory ${dir}: ${e.message}`, null, 'VDB');
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const name = entry.name;
        if (name === IGNORE_FILE_NAME) continue;
        if (isIgnored(name, ignorePatterns)) {
            logger.debug(`[VDB] Ignoring ${full} by pattern`, null, 'VDB');
            continue;
        }
        if (entry.isDirectory()) {
            await walk(full, root, out, baseMeta, collectionDefaults);
        } else if (entry.isFile() && isTextFile(full)) {
            let metadata = { ...baseMeta };
            if (baseMeta.collection === 'storage') {
                metadata.folder = safeRel(STORAGE_ROOT, path.dirname(full)).split('/')[0] || 'root';
            }
            out.push({ absolutePath: full, root, metadata });
        }
    }
}

async function scanCollection(collectionName, onPhase = null) {
    const stats = { added: 0, updated: 0, removed: 0, errors: 0, skipped: 0, pending: 0 };
    // Max continuous main-thread work (hash + string decode) before the scan
    // yields to the event loop. Without this the unchanged-file skip path —
    // the vast majority of any scan — is a fully synchronous read+hash sweep
    // with zero awaits (#31).
    const yieldBudgetMs = CONFIG.scanYieldBudgetMs || 50;
    let workSinceYield = 0;
    const index = loadIndex();
    const currentFiles = new Set();
    const toIndex = [];
    // Track content hashes seen in THIS scan pass so duplicates within the
    // same batch are caught before embedding. The index.hashToDoc only has
    // entries from previous scans (registerHash runs in insertPreparedFile,
    // which fires after embedding).
    const scanHashes = new Map(); // contentHash -> docBaseId (first seen this scan)

    onPhase?.(5, `Scanning ${collectionName}: listing files...`);

    const watched = await listWatchedFiles(collectionName);
    for (const { absolutePath, root, metadata } of watched) {
        const workStart = Date.now();
        const relPath = safeRel(root, absolutePath);
        const docBaseId = `${collectionName}:${relPath}`;
        currentFiles.add(docBaseId);

        try {
            const stat = fs.statSync(absolutePath);
            const existing = index.files[docBaseId];
            // Content-hash change detection, NOT mtime+size. A rewrite that
            // preserves timestamps (sync tools, timestamp-restoring writers)
            // defeats an mtime+size heuristic and silently leaves stale vectors
            // behind. Reading + hashing text files is cheap next to embedding,
            // so verify the actual content on every scan.
            const content = await readTextFileAsync(absolutePath);
            const contentHash = hashContent(content);
            if (existing && existing.contentHash === contentHash) {
                stats.skipped++;
                continue;
            }

            if (existing) {
                stats.updated++;
                deleteExistingChunks(docBaseId);
            } else {
                stats.added++;
            }

            const prepared = await prepareFileForIndexing(collectionName, absolutePath, root, metadata, content, contentHash);

            // Content-hash dedup: if another file with identical content is
            // already indexed (previous scan) OR already prepared in this scan,
            // skip embedding this one. Record it as an alias.
            const dupOf = findDuplicateByHash(index, prepared.contentHash, docBaseId)
                || scanHashes.get(prepared.contentHash);
            if (dupOf) {
                if (existing) stats.updated--;
                else stats.added--;
                stats.skipped++;
                logger.info(`[VDB] ${absolutePath} is a duplicate of ${dupOf} (same content hash) — skipping`, null, 'VDB');
                // Track as alias so we know it exists, but mark non-canonical.
                index.files[docBaseId] = {
                    collection: collectionName,
                    path: relPath,
                    absolutePath,
                    contentHash: prepared.contentHash,
                    mtime: stat.mtimeMs,
                    size: stat.size,
                    chunks: 0,
                    indexedAt: new Date().toISOString(),
                    metadata,
                    duplicateOf: dupOf
                };
                saveIndex(index);
                continue;
            }

            toIndex.push(prepared);
            // Register in scanHashes so subsequent files in this scan with the
            // same content are caught as duplicates before embedding.
            scanHashes.set(prepared.contentHash, docBaseId);
        } catch (e) {
            logger.error(`[VDB] Failed to prepare ${absolutePath}: ${e.message}`, null, 'VDB');
            stats.errors++;
        }

        // Yield between files once the budget is spent (see yieldBudgetMs).
        // prepareFileForIndexing awaits the gateway for changed files, so they
        // yield naturally; the budget covers the skip path, which has no
        // other await point.
        workSinceYield += Date.now() - workStart;
        if (workSinceYield >= yieldBudgetMs) {
            workSinceYield = 0;
            await yieldLoop();
        }
    }

    // Process files in groups so memory stays bounded and progress is saved incrementally.
    const groupSize = CONFIG.filesPerGroup || 100;
    const groupCount = Math.ceil(toIndex.length / groupSize);
    onPhase?.(25, `Scanning ${collectionName}: prepared ${toIndex.length} files, embedding in ${groupCount} group${groupCount === 1 ? '' : 's'}...`);
    for (let g = 0; g < toIndex.length; g += groupSize) {
        const group = toIndex.slice(g, g + groupSize);
        const groupNum = Math.floor(g / groupSize) + 1;
        logger.info(`[VDB] ${collectionName}: indexing group ${groupNum}/${groupCount} (${group.length} files)`, null, 'VDB');
        onPhase?.(25 + Math.round((60 * groupNum) / Math.max(groupCount, 1)), `Scanning ${collectionName}: embedding group ${groupNum}/${groupCount}...`);

        try {
            await embedGroupWithPersistence(group, embedInBatches, insertPreparedFile);
        } catch (e) {
            const persisted = new Set(e.persistedFiles ?? []);
            const remaining = group.filter((prepared) => !persisted.has(prepared.docBaseId));
            // Embedding provider unreachable: abort the scan instead of churning
            // through every remaining group burning timeouts. Completed files
            // have already been persisted by embedGroupWithPersistence.
            const isNetwork = e.name === 'AbortError'
                || e.name === 'TimeoutError'
                || e.name === 'TypeError'
                || (e.message && (e.message.includes('timed out') || e.message.includes('ECONNRESET') || e.message.includes('ECONNREFUSED') || e.message.includes('fetch failed')));
            if (isNetwork) {
                const pendingCount = toIndex.length - g - persisted.size;
                logger.error(`[VDB] ${collectionName}: embedding provider unreachable (${e.message}) — aborting after group ${groupNum}/${groupCount}; ${persisted.size} file(s) persisted, ${pendingCount} pending: ${remaining.map((p) => p.relPath).join(', ')}`, null, 'VDB');
                stats.errors += remaining.length;
                stats.pending += pendingCount;
                break;
            }
            logger.error(`[VDB] Group embedding failed after ${persisted.size} file(s) persisted: ${e.message}; unindexed: ${remaining.map((p) => p.relPath).join(', ')}`, null, 'VDB');
            stats.errors += remaining.length;
            stats.added = Math.max(0, stats.added - remaining.length);
            stats.updated = Math.max(0, stats.updated - remaining.length);
        }
    }

    // Remove deleted files
    for (const docBaseId of Object.keys(index.files)) {
        if (index.files[docBaseId].collection !== collectionName) continue;
        if (!currentFiles.has(docBaseId)) {
            if (deleteFileFromIndex(docBaseId)) stats.removed++;
        }
    }

    const coll = getCollection(collectionName);

    // Compact to physically remove deleted docs and merge segments.
    // nVDB exact_search does not apply memtable delete markers to segments,
    // so re-indexed files would otherwise appear as duplicate search results.
    //
    // IMPORTANT: do NOT flush before compacting. flush() swaps the memtable
    // (including tombstones) into a new segment and replaces it with an empty
    // one. compact() then collects deleted IDs from the (now empty) memtable
    // and finds nothing to remove. The tombstones must be in the memtable
    // when compact() runs.
    //
    // Only run it when this scan actually produced tombstones. A no-op scan is
    // the normal case every five minutes, and compacting anyway rewrote the
    // 104 MB segment — enough disk saturation to stall unrelated HTTP requests
    // for ~20 s. compactionDirty starts true so tombstones left behind by a
    // failed compaction (or by a previous process) are collected once at boot.
    if (stats.removed > 0 || stats.updated > 0) markCompactionDirty();
    onPhase?.(95, `Scanning ${collectionName}: ${compactionDirty ? 'compacting...' : 'no compaction needed'}`);
    if (compactionDirty) {
        try {
            const before = coll.stats || {};
            const compactResult = await coll.compact();
            const after = coll.stats || {};
            clearCompactionDirty();
            logger.info(`[VDB] ${collectionName}: compacted`, {
                docsBefore: compactResult?.docsBefore ?? compactResult?.docs_before ?? before.totalSegmentDocs,
                docsAfter: compactResult?.docsAfter ?? compactResult?.docs_after ?? after.totalSegmentDocs,
                segmentsMerged: compactResult?.segmentsMerged ?? compactResult?.segments_merged ?? null
            }, 'VDB');
        } catch (e) {
            logger.warn(`[VDB] ${collectionName}: compaction failed: ${e.message}`, null, 'VDB');
        }
    } else {
        logger.debug(`[VDB] ${collectionName}: compaction skipped (no deletes or updates this scan)`, null, 'VDB');
    }

    onPhase?.(100, `Scanning ${collectionName}: +${stats.added} new, ~${stats.updated} updated, -${stats.removed} removed, ${stats.errors} errors`);
    return stats;
}

async function runScan(onProgress = null) {
    if (IS_SCANNING) {
        const elapsed = SCAN_STARTED_AT ? Date.now() - SCAN_STARTED_AT : 0;
        const timeoutMs = (CONFIG.scanTimeoutMinutes ?? DEFAULTS.scanTimeoutMinutes) * 60 * 1000;
        if (elapsed < timeoutMs) {
            return { alreadyRunning: true, elapsedMs: elapsed };
        }
        logger.error(`[VDB] Previous scan has been running for ${(elapsed / 1000 / 60).toFixed(1)} minutes — treating as hung and forcing a new scan.`, null, 'VDB');
        // Force release the lock. The hung scan's fetches may still complete in the background,
        // but its results are no longer trusted to update shared state reliably.
        IS_SCANNING = false;
    }

    IS_SCANNING = true;
    SCAN_STARTED_AT = Date.now();
    LAST_SCAN_ERROR = null;
    const totalStats = { added: 0, updated: 0, removed: 0, errors: 0, skipped: 0, pending: 0 };

    const scanTimeoutMs = (CONFIG.scanTimeoutMinutes ?? DEFAULTS.scanTimeoutMinutes) * 60 * 1000;

    try {
        const scanPromise = (async () => {
            // Pre-compute the enabled collection list so progress windows are accurate.
            const names = Object.keys(CONFIG.watch || {}).filter(name =>
                COLLECTIONS[name] && CONFIG.watch[name]?.enabled !== false
            );
            if (onProgress) onProgress('Scanning storage...', 2);
            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                const collStart = Math.round((i / names.length) * 100);
                const collEnd = Math.round(((i + 1) / names.length) * 100);
                logger.info(`[VDB] Scanning collection: ${name}`, null, 'VDB');
                const stats = await scanCollection(name, (phasePct, msg) => {
                    if (onProgress) onProgress(msg, collStart + Math.round((phasePct / 100) * (collEnd - collStart)));
                });
                for (const k of Object.keys(totalStats)) totalStats[k] += stats[k];
            }
            return totalStats;
        })();

        await withTimeout(scanPromise, scanTimeoutMs, 'Scan');
        LAST_SCAN_AT = new Date().toISOString();
        SCAN_STATS = totalStats;
        logger.info(`[VDB] Scan complete`, totalStats, 'VDB');
    } catch (e) {
        logger.error(`[VDB] Scan failed: ${e.message}`, null, 'VDB');
        totalStats.errors++;
        LAST_SCAN_ERROR = e.message;
        // Snapshot: a timed-out scan keeps running and still mutates totalStats.
        SCAN_STATS = { ...totalStats };
    } finally {
        IS_SCANNING = false;
        SCAN_STARTED_AT = null;
    }

    return totalStats;
}

function startScanner() {
    if (SCAN_TIMER) clearInterval(SCAN_TIMER);
    const intervalMs = (CONFIG.scanIntervalMinutes || DEFAULTS.scanIntervalMinutes) * 60 * 1000;
    SCAN_TIMER = setInterval(() => runScan(), intervalMs);
    logger.info(`[VDB] Scanner scheduled every ${CONFIG.scanIntervalMinutes || DEFAULTS.scanIntervalMinutes} minutes`, null, 'VDB');
}

function buildFilter(collectionName, folder, extension) {
    const filters = [];
    if (folder) {
        if (collectionName === 'storage') filters.push(FILTER_BUILDER.eq('folder', folder));
    }
    if (extension) filters.push(FILTER_BUILDER.eq('extension', extension.toLowerCase()));
    if (filters.length === 0) return null;
    if (filters.length === 1) return filters[0];
    return FILTER_BUILDER.and(filters);
}

// ── Search API (used by other agents) ─────────────────────────────────

// Per-file diversity cap: max chunks returned from any single source file.
// Stops one long/broad document from filling all result slots.
const MAX_CHUNKS_PER_FILE = 3;

// Resolve the layers for one request. `search` is the caller's override object
// (see search-options.js); null means "use the configured defaults".
function resolveRequestOptions(search) {
    if (!CONFIG.hybrid.enabled) {
        if (search) throw new Error('per-request layers need agents.vdb.hybrid.enabled — the bound index is vector-only');
        return null;
    }
    return resolveSearchOptions({
        overrides: search,
        hybrid: CONFIG.hybrid,
        rerank: CONFIG.rerank,
        rerankerAvailable: RERANKER !== null,
        diversityField: CONFIG.hybrid.diversityField
    });
}

// Public: the effective mode for a request, for tool output and A/B logs.
export function describeSearchRequest(search = null) {
    if (!CONFIG) throw new Error('VDB not initialized');
    const options = resolveRequestOptions(search);
    return options ? describeSearchOptions(options) : 'vector-only';
}

// Mode plus the relevance contract for one request: a rejection is only
// possible when the cross-encoder ran, because it is the only calibrated
// signal (see relevance.js).
export function searchRequestInfo(search = null) {
    if (!CONFIG) throw new Error('VDB not initialized');
    const options = resolveRequestOptions(search);
    return {
        mode: options ? describeSearchOptions(options) : 'vector-only',
        rerankActive: Boolean(options?.rerank),
        floor: CONFIG.relevanceFloor
    };
}

export function relevanceFloor() {
    if (!CONFIG) throw new Error('VDB not initialized');
    return CONFIG.relevanceFloor;
}

// Evidence text for a rejected (nonsense / no-confident-match) request. The
// candidates are listed, not hidden: hiding them would be presentation, and the
// report explicitly rules that out.
export function describeRejection(assessment, rows, label = 'matches') {
    const best = assessment.best === null ? 'n/a' : `${(assessment.best * 100).toFixed(2)}%`;
    const lines = rows.slice(0, 5).map((row, i) => {
        const score = typeof row.rerankScore === 'number' ? `${(row.rerankScore * 100).toFixed(2)}%` : 'n/a';
        return `  ${i + 1}. ${row.path ?? `#${row.id}`} (relevance ${score})`;
    }).join('\n');
    return `No relevant ${label}: the best cross-encoder score is ${best}, below the ${(assessment.floor * 100).toFixed(1)}% relevance floor.\n`
        + `The candidates below are returned as low-relevance evidence, not as answers:\n${lines}`;
}

// Per-request layer selection cannot change what the native call computes, so a
// single-lane request fetches headroom and drops the other lane afterwards.
async function runHybridSearch(coll, { vector, text, fetchK, filter, options }) {
    const singleLane = !(options.dense && options.lexical);
    const nativeTopK = singleLane ? Math.max(fetchK * 4, 40) : fetchK;
    const native = {
        vector,
        text,
        topK: nativeTopK,
        candidateK: Math.max(options.candidateK, nativeTopK),
        distance: 'cosine',
        rrfK: options.rrfK,
        // A dense-off request passes a zero vector; the lane weight must be 0 or
        // its constant 0.0 scores would still enter the fusion.
        vectorWeight: options.dense ? options.vectorWeight : 0,
        lexicalWeight: options.lexicalWeight,
        ...(options.diversity
            ? { groupBy: options.diversityField, maxPerDocument: options.maxPerDocument }
            : {}),
        ...(filter ? { filter } : {})
    };
    const rows = options.rerank
        ? await coll.hybridSearchReranked(native, RERANKER, options.rerankTextField, options.rerankWeight, options.shortlist)
        : await coll.hybridSearch(native);
    return selectLanes(rows, options, fetchK);
}

function collectionHasPayloadFields(collectionName) {
    // The live index is written by this agent's scanner (absolutePath, folder,
    // contentHash, folder, charOffset…). A snapshot index is written by its
    // builder and carries only path/title/content per chunk. An index filter on
    // a field the snapshot does not have matches NOTHING — silently.
    return !CONFIG.snapshot && collectionName === 'storage';
}

function chunkIndexFromId(id) {
    const hash = id.lastIndexOf('#');
    if (hash === -1) return 0;
    const parsed = Number.parseInt(id.slice(hash + 1), 10);
    return Number.isInteger(parsed) ? parsed : 0;
}

// Filters are a contract, not a hint. `md` and `.md` name the same suffix, so
// they must produce the same request (the old code built `..md` and matched
// nothing); anything that cannot be a suffix is rejected instead of quietly
// returning zero.
function normalizeExtension(extension) {
    if (extension === undefined || extension === null) return null;
    if (typeof extension !== 'string') {
        throw new Error(`extension must be a string like "md" or ".md" (got ${extension === null ? 'null' : typeof extension})`);
    }
    const value = extension.trim().toLowerCase();
    const bare = value.startsWith('.') ? value.slice(1) : value;
    if (!/^[a-z0-9]+$/.test(bare)) {
        throw new Error(`extension must be one bare suffix like "md" or ".md" (got ${JSON.stringify(extension)})`);
    }
    return `.${bare}`;
}

function normalizeFolder(folder) {
    if (folder === undefined || folder === null) return null;
    if (typeof folder !== 'string') {
        throw new Error(`folder must be a string (got ${folder === null ? 'null' : typeof folder})`);
    }
    const value = folder.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (value === '' || value.split('/').includes('..')) {
        throw new Error(`folder must be a storage-relative directory path (got ${JSON.stringify(folder)})`);
    }
    return value;
}

export async function searchDocuments({ query, collections, folder, extension, top_k = 10, approximate = false, include_content = false, search = null, onProgress = null } = {}) {
    if (!DATABASE) throw new Error('VDB agent is not initialized or nVDB is unavailable. Check logs.');
    if (!query) throw new Error('searchDocuments: query is required');

    // Resolve before embedding: an invalid layer selection must not spend a
    // gateway round trip.
    const options = resolveRequestOptions(search);
    // Same for the filters: normalize once so every path (index filter and
    // client filter) sees one spelling, and reject what cannot be a suffix.
    const folderFilter = normalizeFolder(folder);
    const extensionFilter = normalizeExtension(extension);

    const targetCollections = (collections && collections.length > 0)
        ? collections.filter(c => Object.keys(COLLECTIONS).includes(c) && CONFIG.watch?.[c])
        : Object.keys(CONFIG.watch || {});

    if (targetCollections.length === 0) throw new Error('searchDocuments: no enabled collections to search');

    onProgress?.('Embedding query...', 20);
    // A dense-off request must not touch the embedder: the native fusion takes a
    // vector, and a zero vector scores exactly 0.0 for every document (the
    // cosine guard in distance.rs), which the zero lane weight neutralises and
    // selectLanes then drops. Lexical-only A/B therefore works while the
    // embedding backend is down.
    const queryEmbedding = options && !options.dense
        ? new Array(CONFIG.embeddingDim).fill(0)
        : await embedText(query);
    onProgress?.('Searching collections...', 40);

    // Per-collection search with min-max score normalization.
    // Raw scores are NOT comparable across collections (different content types
    // cluster in different regions of the embedding space with different score
    // ranges). We normalize each collection's scores to [0,1] before merging,
    // so a memory match near that collection's max can compete with a storage
    // match near its max.
    //
    // We over-fetch per collection (top_k * 3) so the diversity cap and
    // dedup have headroom to work with.
    const perCollection = [];

    for (let ci = 0; ci < targetCollections.length; ci++) {
        const collectionName = targetCollections[ci];
        const coll = getCollection(collectionName);
        const indexFiltered = collectionHasPayloadFields(collectionName);
        // A filter on fields the snapshot payload does not have would match
        // nothing — silently. Apply it to the mapped results instead.
        const clientFiltered = Boolean(folderFilter || extensionFilter) && !indexFiltered;
        const indexFilter = indexFiltered ? buildFilter(collectionName, folderFilter, extensionFilter) : null;
        // A filter applied after the native call can reject most of the pool, so
        // the pool must be deep enough to survive it. At the old depth the .md
        // hits for one query sat below the cut and the filtered result was empty
        // — or, because the truncation follows a near-tie rerank order, differed
        // between two identical requests.
        const fetchK = clientFiltered
            ? Math.max(top_k * 3, CONFIG.hybrid.candidateK ?? 200)
            : Math.max(top_k * 3, 30);
        const searchResults = options
            ? await runHybridSearch(coll, { vector: queryEmbedding, text: query, fetchK, filter: indexFilter, options })
            : await coll.search({
                vector: queryEmbedding,
                topK: fetchK,
                distance: 'cosine',
                approximate,
                ...(indexFilter ? { filter: indexFilter } : {})
            });

        if (searchResults.length === 0) continue;

        const matches = [];
        for (const match of searchResults) {
            const payload = JSON.parse(match.payload || '{}');
            const relPath = payload.path ?? null;
            const result = {
                collection: collectionName,
                id: match.id,
                score: match.score,
                path: relPath,
                title: payload.title,
                absolutePath: payload.absolutePath
                    ?? (relPath && STORAGE_ROOT ? path.resolve(STORAGE_ROOT, relPath) : undefined),
                folder: payload.folder,
                domain: payload.domain,
                contentHash: payload.contentHash,
                splitIdx: payload.splitIdx ?? chunkIndexFromId(match.id),
                charOffset: payload.charOffset,
                tokEst: payload.tokEst
            };
            if (options) {
                result.rrfScore = match.rrfScore;
                result.rerankScore = match.rerankScore ?? null;
                result.vectorRank = match.vectorRank ?? null;
                result.lexicalRank = match.lexicalRank ?? null;
            }
            if (clientFiltered) {
                if (folderFilter && !(relPath || '').toLowerCase().startsWith(`${folderFilter.toLowerCase()}/`)) continue;
                if (extensionFilter && path.extname(relPath || '').toLowerCase() !== extensionFilter) continue;
            }
            if (include_content) {
                result.content = payload.content ?? readChunkContent(payload, CHUNKER);
            }
            matches.push(result);
        }

        if (matches.length === 0) continue;

        // Score normalization. Vector-only: min-max over the collection's
        // similarities. Hybrid: RRF is a RANK fusion, and the native call
        // already returns the intended order (reranked head first) — its raw
        // scores are not monotonic across the rerank shortlist boundary, so
        // re-sorting by them would promote the unscored tail over the ranked
        // head. Rank position is the comparable signal, so encode that.
        if (options) {
            const last = matches.length - 1;
            matches.forEach((result, index) => {
                result.normalizedScore = last === 0 ? 1 : 1 - index / last;
            });
        } else {
            const scores = matches.map(r => r.score);
            const min = Math.min(...scores);
            const max = Math.max(...scores);
            const range = max - min || 1; // avoid divide-by-zero when all scores equal
            for (const result of matches) {
                result.normalizedScore = (result.score - min) / range;
            }
        }
        perCollection.push(...matches);
        onProgress?.(`Searched ${collectionName} (${ci + 1}/${targetCollections.length})`, 40 + Math.round((60 * (ci + 1)) / targetCollections.length));
    }

    onProgress?.('Ranking results...', 95);

    // Sort by normalized score so cross-collection results are comparable.
    perCollection.sort((a, b) => b.normalizedScore - a.normalizedScore);

    // Deduplicate by ID (nVDB may return same ID from multiple segments).
    const seenIds = new Set();
    // Deduplicate by contentHash + splitIdx (same content indexed under
    // different paths before dedup was added, or aliases that slipped through).
    const seenContent = new Set();
    // Per-file diversity cap.
    const perFileCount = new Map();

    const deduped = [];
    for (const r of perCollection) {
        if (seenIds.has(r.id)) continue;
        seenIds.add(r.id);

        // Content-level dedup: same file content + same chunk index = duplicate.
        const contentKey = r.contentHash && r.splitIdx !== undefined
            ? `${r.contentHash}#${r.splitIdx}`
            : null;
        if (contentKey) {
            if (seenContent.has(contentKey)) continue;
            seenContent.add(contentKey);
        }

        // Per-file diversity cap: limit chunks from the same source file.
        const fileKey = r.path;
        const count = perFileCount.get(fileKey) || 0;
        if (count >= MAX_CHUNKS_PER_FILE) continue;
        perFileCount.set(fileKey, count + 1);

        deduped.push(r);
        if (deduped.length >= top_k) break;
    }

    return deduped;
}

// Read a specific chunk from a file by its charOffset, without re-chunkging
// the whole file. Falls back to re-chunkging only if charOffset is missing
// (legacy payloads).
function readChunkContent(payload, chunker) {
    if (!payload?.absolutePath) return '';
    try {
        // Fast path: exact slice by charOffset + charLen (structure-aware chunks).
        if (payload.charOffset !== undefined && payload.charLen !== undefined) {
            const content = fs.readFileSync(payload.absolutePath, 'utf-8');
            return content.slice(payload.charOffset, payload.charOffset + payload.charLen);
        }
        // Legacy path: estimate chunk length from tokEst (char-slice chunks).
        if (payload.charOffset !== undefined && payload.tokEst !== undefined) {
            const content = fs.readFileSync(payload.absolutePath, 'utf-8');
            const chunkLen = payload.tokEst * (CONFIG?.chunkTokCharsRatio || 2.5);
            return content.slice(payload.charOffset, payload.charOffset + Math.ceil(chunkLen));
        }
        // Legacy fallback: re-chunk and pick by splitIdx.
        const content = fs.readFileSync(payload.absolutePath, 'utf-8');
        const chunks = chunker(content);
        const chunk = chunks[payload.splitIdx] || chunks[0];
        return chunk?.text || '';
    } catch (e) {
        return '';
    }
}

// ── Filename-query handling ───────────────────────────────────────────
// Embedding a filename produces semantic noise (every doc scores ~0.5),
// so queries that look like a file reference are matched against the
// indexed file paths directly. Uses listWatchedFiles (same enumeration
// and ignore rules as the scanner) — nVDB itself has no path iteration API.

// Single token ending in a common extension, or anything with a path separator.
function looksLikeFileQuery(query) {
    const q = (query || '').trim();
    if (!q || q.length > 200) return false;
    if (/\\/.test(q)) return true;
    if (/^\S+\.[a-z0-9]{1,8}$/i.test(q)) return true;
    return false;
}

// Case-insensitive substring match over indexed storage file paths.
// Basename-exact matches sort first.
async function findPathMatches(query) {
    const needle = query.trim().toLowerCase();
    const matches = [];
    for (const { absolutePath, root, metadata } of await listWatchedFiles('storage')) {
        const rel = safeRel(root, absolutePath);
        const relLower = rel.toLowerCase();
        const isMatch = relLower === needle
            || path.basename(relLower) === needle
            || relLower.endsWith('/' + needle)
            || relLower.includes(needle);
        if (isMatch) {
            matches.push({
                collection: 'storage',
                path: rel,
                absolutePath,
                folder: metadata.folder,
                matchType: path.basename(relLower) === needle ? 'exact-name' : 'substring'
            });
        }
    }
    matches.sort((a, b) => (a.matchType === 'exact-name' ? -1 : 1) - (b.matchType === 'exact-name' ? -1 : 1));
    return matches;
}

const FILE_MATCH_LIMIT = 20;

// ── Tool handlers ─────────────────────────────────────────────────────

export async function vdb_search(args, context) {
    const pr = createProgressReporter(context?.progress);
    // Validate the requested layers before anything else: an invalid selection
    // must fail, not fall through to the filename path or a default search.
    const info = searchRequestInfo(args?.search ?? null);
    const mode = info.mode;

    // Filename-like queries bypass semantic search entirely — the embedding
    // of a filename carries no meaning, only noise.
    if (looksLikeFileQuery(args?.query)) {
        const matches = (await findPathMatches(args.query)).slice(0, FILE_MATCH_LIMIT);
        if (matches.length > 0) {
            pr.done('Filename match');
            const lines = matches.map(m =>
                `[${m.collection}] ${m.path} (${m.matchType})${m.folder ? ` [folder:${m.folder}]` : ''}`
            ).join('\n');
            return {
                content: [{
                    type: 'text',
                    text: `Query is filename-like — matched against indexed file paths instead of semantic search.\nFound ${matches.length} file(s):\n\n${lines}\n\nRaw results:\n${JSON.stringify(matches, null, 2)}`
                }]
            };
        }
        pr.done('No filename match');
        return {
            content: [{
                type: 'text',
                text: `Query is filename-like, but no indexed storage file matches "${args.query}". Note: only text files (.md .txt .json .js ...) under the storage root are indexed — use storage.list to browse the full tree.`
            }]
        };
    }

    const top = await searchDocuments({ ...(args || {}), onProgress: (msg, pct) => pr.set(msg, pct) });
    pr.done('Search complete');

    const assessment = assessRelevance(top, { rerankActive: info.rerankActive, floor: info.floor });
    if (assessment.rejected) {
        return {
            content: [{
                type: 'text',
                text: `mode: ${mode}\n${describeRejection(assessment, top, 'storage matches')}\n\nRaw results:\n${JSON.stringify(top, null, 2)}`
            }]
        };
    }

    const summary = top.map((r, i) => {
        const detail = r.rrfScore === undefined
            ? `score: ${r.score.toFixed(4)}, norm: ${r.normalizedScore?.toFixed(3) ?? 'n/a'}`
            : `rrf: ${r.rrfScore.toFixed(4)}${r.rerankScore !== null && r.rerankScore !== undefined ? `, rerank: ${r.rerankScore.toFixed(3)}` : ''}, vec#${r.vectorRank ?? '-'}/lex#${r.lexicalRank ?? '-'}`;
        return `${i + 1}. [${r.collection}] ${r.path} (${detail})${r.folder ? ` [folder:${r.folder}]` : ''}${r.domain ? ` [domain:${r.domain}]` : ''}${r.splitIdx > 0 ? ` chunk:${r.splitIdx}` : ''}`;
    }).join('\n');

    return {
        content: [{
            type: 'text',
            text: `mode: ${mode}\nFound ${top.length} matches:\n\n${summary}\n\nRaw results:\n${JSON.stringify(top, null, 2)}`
        }]
    };
}

export async function vdb_status(args, context) {
    const available = isNvdbAvailable();
    const status = {
        available,
        initialized: DATABASE !== null,
        config: {
            enabled: CONFIG?.enabled,
            dbPath: CONFIG?.dbPath,
            snapshot: CONFIG?.snapshot,
            embeddingPath: CONFIG?.embeddingPath,
            scanIntervalMinutes: CONFIG?.scanIntervalMinutes,
            embeddingDim: CONFIG?.embeddingDim,
            chunkMaxTokens: CONFIG?.chunkMaxTokens,
            chunkOverlapTokens: CONFIG?.chunkOverlapTokens,
            batchDelayMs: CONFIG?.batchDelayMs,
            contextEnhancement: CONFIG?.contextEnhancement,
            relevanceFloor: CONFIG?.relevanceFloor,
            hybrid: CONFIG?.hybrid,
            rerank: CONFIG?.rerank ? { ...CONFIG.rerank, loaded: RERANKER !== null } : null,
            nativePath: DATABASE ? loadNvdb().nativePath : null
        },
        collections: {},
        lastScanAt: LAST_SCAN_AT,
        isScanning: IS_SCANNING,
        lastScanError: LAST_SCAN_ERROR,
        lastScanStats: SCAN_STATS
    };

    if (DATABASE) {
        for (const name of Object.keys(COLLECTIONS)) {
            try {
                const coll = getCollection(name);
                const stats = coll.stats || {};
                status.collections[name] = {
                    docs: (stats.memtableDocs || 0) + (stats.totalSegmentDocs || 0),
                    memtableDocs: stats.memtableDocs,
                    totalSegmentDocs: stats.totalSegmentDocs,
                    segmentCount: stats.segmentCount,
                    hasIndex: coll.hasIndex ? coll.hasIndex() : false,
                    watched: CONFIG.watch?.[name]?.enabled !== false
                };
            } catch (e) {
                status.collections[name] = { error: e.message };
            }
        }
    }

    return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
}

export async function vdb_trigger_scan(args, context) {
    if (!DATABASE) throw new Error('VDB agent is not initialized');
    if (CONFIG.snapshot) {
        throw new Error(`VDB: ${CONFIG.dbPath} is a fixed snapshot index — scanning would re-embed and mutate it. Define a delta/ingest path before enabling scans.`);
    }
    const pr = createProgressReporter(context?.progress);
    const result = await runScan((msg, pct) => pr.set(msg, pct));
    if (result.alreadyRunning) {
        pr.done('Scan already in progress');
        return { content: [{ type: 'text', text: 'Scan already in progress; request ignored.' }] };
    }
    pr.done('Scan complete');
    return {
        content: [{
            type: 'text',
            text: `Scan complete. added=${result.added} updated=${result.updated} removed=${result.removed} skipped=${result.skipped} errors=${result.errors}${result.pending ? ` pending=${result.pending} (embed provider down?)` : ''}`
        }]
    };
}

export async function vdb_build_index(args, context) {
    if (!DATABASE) throw new Error('VDB agent is not initialized');
    const pr = createProgressReporter(context?.progress);
    const targets = (args?.collections || []).filter(c => Object.keys(COLLECTIONS).includes(c) && CONFIG.watch?.[c]);
    const names = targets.length > 0 ? targets : Object.keys(CONFIG.watch || {});
    const results = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        pr.step(i + 1, names.length, `Building index for ${name} (${i + 1}/${names.length})...`);
        try {
            const coll = getCollection(name);
            coll.flush();
            coll.rebuildIndex();
            results.push({ collection: name, ok: true, hasIndex: coll.hasIndex() });
        } catch (e) {
            results.push({ collection: name, ok: false, error: e.message });
        }
    }
    pr.done('Index build complete');
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
}

// ── Init / Shutdown ───────────────────────────────────────────────────

export async function init(context) {
    const agentConfig = context.config?.agents?.vdb;
    if (!agentConfig) throw new Error('vdb.init: context.config.agents.vdb is required');
    if (agentConfig.enabled === false) {
        logger.info('[VDB] Agent disabled via config', null, 'VDB');
        return {};
    }

    CONFIG = {
        enabled: agentConfig.enabled ?? DEFAULTS.enabled,
        dbPath: agentConfig.dbPath ?? DEFAULTS.dbPath,
        indexPath: agentConfig.indexPath || null,
        scanIntervalMinutes: agentConfig.scanIntervalMinutes ?? DEFAULTS.scanIntervalMinutes,
        scanTimeoutMinutes: agentConfig.scanTimeoutMinutes ?? DEFAULTS.scanTimeoutMinutes,
        embeddingDim: agentConfig.embeddingDim ?? DEFAULTS.embeddingDim,
        chunkMaxTokens: agentConfig.chunkMaxTokens ?? DEFAULTS.chunkMaxTokens,
        chunkOverlapTokens: agentConfig.chunkOverlapTokens ?? DEFAULTS.chunkOverlapTokens,
        chunkTokCharsRatio: agentConfig.chunkTokCharsRatio ?? DEFAULTS.chunkTokCharsRatio,
        maxFileSizeBytes: agentConfig.maxFileSizeBytes ?? DEFAULTS.maxFileSizeBytes,
        batchTokenLimit: agentConfig.batchTokenLimit ?? DEFAULTS.batchTokenLimit,
        maxBatchTexts: agentConfig.maxBatchTexts ?? DEFAULTS.maxBatchTexts,
        filesPerGroup: agentConfig.filesPerGroup ?? DEFAULTS.filesPerGroup,
        maxRetries: agentConfig.maxRetries ?? DEFAULTS.maxRetries,
        batchDelayMs: agentConfig.batchDelayMs ?? DEFAULTS.batchDelayMs,
        textExtensions: agentConfig.textExtensions ?? DEFAULTS.textExtensions,
        ignore: agentConfig.ignore ?? DEFAULTS.ignore,
        watchFolders: agentConfig.watchFolders ?? null,
        watch: agentConfig.watch || { storage: true },
        contextEnhancement: agentConfig.contextEnhancement || { enabled: false },
        snapshot: agentConfig.snapshot ?? DEFAULTS.snapshot,
        embeddingPath: agentConfig.embeddingPath ?? DEFAULTS.embeddingPath,
        relevanceFloor: resolveRelevanceFloor(agentConfig.relevanceFloor),
        hybrid: { ...DEFAULTS.hybrid, ...(agentConfig.hybrid || {}) },
        rerank: { ...DEFAULTS.rerank, ...(agentConfig.rerank || {}) }
    };

    GATEWAY = context.gateway;
    if (!GATEWAY) throw new Error('vdb.init: gateway is required');

    // Pull storage root from storage agent config
    const storageConfig = context.config?.agents?.storage;
    if (storageConfig?.root) {
        STORAGE_ROOT = path.resolve(PROJECT_ROOT, storageConfig.root);
    }

    CHUNKER = makeChunker({
        maxTokens: CONFIG.chunkMaxTokens,
        overlapTokens: CONFIG.chunkOverlapTokens,
        tokCharsRatio: CONFIG.chunkTokCharsRatio
    });

    if (!isNvdbAvailable()) {
        logger.error('[VDB] nVDB native module not available. VDB tools will fail until built.', null, 'VDB');
        return { enabled: false, error: 'nVDB native module not available' };
    }

    const { Database, FilterBuilder, Reranker, nativePath } = loadNvdb();
    FILTER_BUILDER = FilterBuilder;
    logger.info(`[VDB] nVDB addon: ${nativePath}`, null, 'VDB');

    if (CONFIG.rerank.enabled) {
        RERANKER = createReranker({ Reranker, config: CONFIG.rerank });
        logger.info(`[VDB] Reranker active: ${CONFIG.rerank.modelPath} (shortlist=${CONFIG.rerank.shortlist}, weight=${CONFIG.rerank.weight}, textField=${CONFIG.rerank.textField})`, null, 'VDB');
    }

    const dbPath = path.resolve(PROJECT_ROOT, CONFIG.dbPath);
    fs.mkdirSync(dbPath, { recursive: true });
    DATABASE = new Database(dbPath);
    compactionDirty = CONFIG.snapshot ? false : fs.existsSync(COMPACTION_FLAG());
    if (compactionDirty) logger.info('[VDB] Tombstones pending from a previous run — the next scan will compact', null, 'VDB');

    // Pre-open configured collections so stats work
    for (const name of Object.keys(CONFIG.watch || {})) {
        if (Object.keys(COLLECTIONS).includes(name)) getCollection(name);
    }

    if (CONFIG.snapshot) {
        // The snapshot's collections carry lexical fields and a payload schema
        // this agent did not write. Creating derived collections or running a
        // scan would mutate a fixed index and invalidate the vectors.
        CONTEXT_ENHANCER = null;
        STORED_VECTOR_GUARD = createStoredVectorGuard('vdb');
        logger.info('[VDB] Snapshot index: scanning, compaction and context enhancement are disabled', null, 'VDB');
    } else {
        const enhancementCache = createEnhancementCache();
        CONTEXT_ENHANCER = createContextEnhancer(CONFIG.contextEnhancement, GATEWAY, logger, enhancementCache);
        if (CONTEXT_ENHANCER) {
            logger.info(`[VDB] Context enhancement enabled (task=${CONFIG.contextEnhancement.task || 'local'})`, null, 'VDB');
        }

        // Build the stored-vector guard from what is actually in the index BEFORE
        // any scan runs: a vector stored by an earlier process is invisible to the
        // process-local guard, and the first scan must not be able to write a
        // reused one. Only vector hashes are computed here; each chunk's input hash
        // stays lazy (it re-reads its source only when a candidate collides).
        const watchedCollections = Object.keys(CONFIG.watch || {}).filter(name =>
            Object.keys(COLLECTIONS).includes(name) && CONFIG.watch[name]?.enabled !== false
        );
        const scanIndex = loadIndex();
        const built = buildChunkVectorGuard({
            collections: watchedCollections.map(name => ({ name, coll: getCollection(name), index: scanIndex })),
            storageRoot: STORAGE_ROOT
        });
        STORED_VECTOR_GUARD = built.guard;
        logger.info(`[VDB] Stored-vector guard: ${built.registered} chunk vector(s) tracked${built.missing ? `, ${built.missing} chunk id(s) in the scan index have no stored vector` : ''}`, null, 'VDB');

        startScanner();

        // Run an initial scan soon after startup (don't block init)
        setTimeout(() => runScan().catch(e => logger.error(`[VDB] Initial scan failed: ${e.message}`, null, 'VDB')), 2000);
    }

    logger.info(`[VDB] Initialized at ${dbPath}${CONFIG.hybrid.enabled ? ` (hybrid: rrfK=${CONFIG.hybrid.rrfK}, lexicalWeight=${CONFIG.hybrid.lexicalWeight}, diversity=${CONFIG.hybrid.diversityField ?? 'off'})` : ' (vector only)'}`, null, 'VDB');
    return {
        enabled: true,
        dbPath,
        // Expose collection access for other agents (e.g. memory agent uses the 'memory' collection)
        getCollection: (name) => getCollection(name),
        embeddingDim: CONFIG.embeddingDim,
        embeddingPath: CONFIG.embeddingPath,
        relevanceFloor: CONFIG.relevanceFloor,
        reranker: RERANKER,
        hybrid: CONFIG.hybrid,
        rerank: CONFIG.rerank,
        snapshot: CONFIG.snapshot
    };
}

// A reranker that cannot load is a startup failure, not a degraded mode: the
// index was chosen and measured with reranking on, so silently serving
// without it would be a different (unmeasured) system.
function createReranker({ Reranker, config }) {
    if (typeof Reranker !== 'function') {
        throw new Error('VDB: agents.vdb.rerank.enabled is true but the loaded nVDB addon exports no Reranker — rebuild with --features rerank-onnx');
    }
    if (typeof config.modelPath !== 'string' || !fs.existsSync(config.modelPath)) {
        throw new Error(`VDB: rerank model not found: ${config.modelPath}`);
    }
    if (typeof config.tokenizerPath !== 'string' || !fs.existsSync(config.tokenizerPath)) {
        throw new Error(`VDB: rerank tokenizer not found: ${config.tokenizerPath}`);
    }
    return new Reranker({
        modelPath: config.modelPath,
        tokenizerPath: config.tokenizerPath,
        maxLength: config.maxLength,
        batchSize: config.batchSize
    });
}

export async function shutdown() {
    if (SCAN_TIMER) clearInterval(SCAN_TIMER);
    if (DATABASE) {
        for (const coll of COLLECTION_INSTANCES.values()) {
            try { coll.flush(); } catch {}
        }
    }
}
