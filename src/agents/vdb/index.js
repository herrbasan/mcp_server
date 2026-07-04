import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { loadNvdb, isNvdbAvailable } from './nvdb-loader.js';
import { makeChunker, isGarbageChunk, isGarbageFile } from './chunker.js';

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
    textExtensions: ['.md', '.txt', '.json', '.js', '.mjs', '.css', '.html', '.htm', '.log', '.yaml', '.yml', '.xml', '.csv', '.tsv', '.sql']
};

const COLLECTIONS = {
    storage: { description: 'Storage files under agents.storage.root' },
    documentation: { description: 'Documentation under agents.documentation.llmDocsPath and mcp_documentation' },
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
let SCAN_STATS = { added: 0, updated: 0, removed: 0, errors: 0, skipped: 0 };
let GATEWAY = null;
let GATEWAY_HTTP_URL = null;
let STORAGE_ROOT = null;
let DOCS_ROOT = null;
let MCP_DOCS_ROOT = null;
let CHUNKER = null;

const INDEX_PATH = () => path.resolve(PROJECT_ROOT, CONFIG?.indexPath || path.join(CONFIG?.dbPath || DEFAULTS.dbPath, 'scan-index.json'));

function hashContent(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
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

function toLocalStoragePath(userPath) {
    if (STORAGE_TRANSLATOR) return STORAGE_TRANSLATOR.toLocal(userPath);
    return userPath;
}

function getCollection(name) {
    if (COLLECTION_INSTANCES.has(name)) return COLLECTION_INSTANCES.get(name);
    if (!DATABASE) throw new Error('VDB not initialized');

    let coll;
    try {
        coll = DATABASE.getCollection(name);
    } catch {
        coll = DATABASE.createCollection(name, CONFIG.embeddingDim, { durability: 'buffered' });
    }
    COLLECTION_INSTANCES.set(name, coll);
    return coll;
}

async function embedText(text) {
    if (!GATEWAY) throw new Error('VDB: gateway not available');
    const embedding = await GATEWAY.embed(text);
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
    if (!GATEWAY_HTTP_URL) throw new Error('VDB: gateway HTTP URL not configured');
    const url = `${GATEWAY_HTTP_URL}/v1/embeddings`;
    const body = JSON.stringify({ input: texts, task: 'embed' });
    retries = retries ?? CONFIG.maxRetries ?? 1;
    let lastErr;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Long timeout: the endpoint is local but large batches can take 10-20s.
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(5 * 60 * 1000)
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => 'unknown');
                throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
            }
            const data = await res.json();
            if (data.error) {
                throw new Error(data.error.message || JSON.stringify(data.error).slice(0, 200));
            }
            const embeddings = data.data?.map(d => d.embedding);
            if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
                throw new Error(`VDB: expected ${texts.length} embeddings, got ${Array.isArray(embeddings) ? embeddings.length : typeof embeddings}`);
            }
            for (const emb of embeddings) {
                if (!Array.isArray(emb) || emb.length !== CONFIG.embeddingDim) {
                    throw new Error(`VDB: expected embedding dim ${CONFIG.embeddingDim}, got ${Array.isArray(emb) ? emb.length : typeof emb}`);
                }
            }
            return embeddings;
        } catch (err) {
            lastErr = err;
            const isNetwork = err.message && (err.message.includes('timeout') || err.message.includes('ECONNRESET') || err.message.includes('fetch failed'));
            if (attempt < retries && isNetwork) {
                const wait = Math.min(1000 * Math.pow(2, attempt), 10000);
                logger.warn(`[VDB] Embedding request network error (attempt ${attempt + 1}/${retries + 1}): ${err.message}. Retrying in ${wait}ms...`, null, 'VDB');
                await sleep(wait);
            } else {
                throw err;
            }
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
        // Defensive fallback: if a batch somehow still fails, split it. This should not happen if batching is correct.
        logger.warn(`[VDB] Batch of ${batch.length} failed (${err.message}), splitting in half as fallback...`, null, 'VDB');
        const mid = Math.ceil(batch.length / 2);
        const left = await embedBatchSplittable(batch.slice(0, mid));
        const right = await embedBatchSplittable(batch.slice(mid));
        return [...left, ...right];
    }
}

async function embedInBatches(texts) {
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

function prepareFileForIndexing(collectionName, absolutePath, sourceRoot, metadata = {}) {
    const relPath = safeRel(sourceRoot, absolutePath);
    const content = readTextFile(absolutePath);

    // File-level garbage gate: reject the whole file before chunking if the
    // opening sample is filler, hex dump, or binary. Saves the chunker work
    // and keeps pure-garbage files out of the index entirely.
    const fileCheck = isGarbageFile(content);
    if (!fileCheck.ok) {
        logger.warn(`[VDB] Skipping garbage file ${absolutePath}: ${fileCheck.reason}`, null, 'VDB');
        return null;
    }

    const contentHash = hashContent(content);
    const chunks = CHUNKER(content);
    const ext = path.extname(absolutePath).toLowerCase();
    const docBaseId = `${collectionName}:${relPath}`;

    // Per-chunk garbage gate: a large file may have some good chunks and some
    // bad ones (e.g. a diary with an embedded hex dump). Filter individually.
    // splitIdx is preserved from the original chunker output so include_content
    // can still re-locate the chunk by its original index.
    const preparedChunks = [];
    let rejected = 0;
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const check = isGarbageChunk(chunk.text);
        if (!check.ok) {
            rejected++;
            continue;
        }
        preparedChunks.push({
            docId: chunks.length === 1 ? docBaseId : `${docBaseId}#${i}`,
            text: chunk.text,
            splitIdx: chunk.splitIdx,
            charOffset: chunk.charOffset,
            isLastChunk: chunk.isLastChunk,
            tokEst: chunk.tokEst
        });
    }

    if (preparedChunks.length === 0) {
        logger.warn(`[VDB] All ${chunks.length} chunks rejected for ${absolutePath} (${rejected} garbage)`, null, 'VDB');
        return null;
    }
    if (rejected > 0) {
        logger.info(`[VDB] ${absolutePath}: ${rejected}/${chunks.length} chunks rejected as garbage`, null, 'VDB');
    }

    return {
        docBaseId,
        collectionName,
        relPath,
        absolutePath,
        contentHash,
        extension: ext,
        metadata,
        chunks: preparedChunks
    };
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
}

// Delete vectors for a file that has no scan-index entry (e.g. garbage file
// whose index entry was removed, or a file that was indexed before the scan
// index existed). Tries chunk IDs #0..#maxChunks-1 plus the bare docBaseId.
// nVDB delete() returns false for unknown ids, so over-scanning is safe.
const ORPHAN_SCAN_MAX_CHUNKS = 500;
function deleteOrphanChunks(collectionName, docBaseId) {
    const coll = getCollection(collectionName);
    let deleted = 0;
    // Try single-chunk form first.
    try { if (coll.delete(docBaseId)) deleted++; } catch (e) {
        logger.warn(`[VDB] deleteOrphanChunks: failed to delete ${docBaseId}: ${e.message}`, null, 'VDB');
    }
    // Try multi-chunk form #0..#N.
    for (let i = 0; i < ORPHAN_SCAN_MAX_CHUNKS; i++) {
        const chunkId = `${docBaseId}#${i}`;
        try {
            if (coll.delete(chunkId)) deleted++;
        } catch (e) {
            // delete() throws on missing id in some nVDB versions — stop scanning.
            break;
        }
    }
    if (deleted > 0) {
        logger.info(`[VDB] deleteOrphanChunks: removed ${deleted} orphaned chunks for ${docBaseId}`, null, 'VDB');
    }
    return deleted;
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

function insertPreparedFile(prepared, embeddings) {
    const coll = getCollection(prepared.collectionName);
    const { docBaseId, relPath, absolutePath, contentHash, extension, metadata } = prepared;

    for (let i = 0; i < prepared.chunks.length; i++) {
        const chunk = prepared.chunks[i];
        const payload = {
            path: relPath,
            absolutePath,
            collection: prepared.collectionName,
            extension,
            splitIdx: chunk.splitIdx,
            charOffset: chunk.charOffset,
            isLastChunk: chunk.isLastChunk,
            tokEst: chunk.tokEst,
            contentHash,
            ...metadata
        };
        coll.insert(chunk.docId, embeddings[i], JSON.stringify(payload));
    }

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
        unregisterHash(index, existing.contentHash);
    }
    delete index.files[docBaseId];
    saveIndex(index);
    return true;
}

function listWatchedFiles(collectionName) {
    const files = [];
    if (collectionName === 'storage') {
        if (!STORAGE_ROOT || !fs.existsSync(STORAGE_ROOT)) return files;
        walk(STORAGE_ROOT, STORAGE_ROOT, files, { collection: 'storage' });
    } else if (collectionName === 'documentation') {
        if (DOCS_ROOT && fs.existsSync(DOCS_ROOT)) {
            walk(DOCS_ROOT, DOCS_ROOT, files, { collection: 'documentation', sourceType: 'llm_docs' });
        }
        if (MCP_DOCS_ROOT && fs.existsSync(MCP_DOCS_ROOT)) {
            walk(MCP_DOCS_ROOT, MCP_DOCS_ROOT, files, { collection: 'documentation', sourceType: 'mcp_docs' });
        }
    }
    return files;
}

function walk(dir, root, out, baseMeta) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, root, out, baseMeta);
        } else if (entry.isFile() && isTextFile(full)) {
            let metadata = { ...baseMeta };
            if (baseMeta.collection === 'storage') {
                metadata.folder = safeRel(STORAGE_ROOT, path.dirname(full)).split('/')[0] || 'root';
            } else if (baseMeta.collection === 'documentation') {
                if (baseMeta.sourceType === 'mcp_docs') {
                    metadata.domain = 'Workshop';
                } else {
                    const relDir = safeRel(root, path.dirname(full));
                    metadata.domain = relDir.split('/')[0] || 'root';
                }
            }
            out.push({ absolutePath: full, root, metadata });
        }
    }
}

async function scanCollection(collectionName) {
    const stats = { added: 0, updated: 0, removed: 0, errors: 0, skipped: 0 };
    const index = loadIndex();
    const currentFiles = new Set();
    const toIndex = [];
    // Track content hashes seen in THIS scan pass so duplicates within the
    // same batch are caught before embedding. The index.hashToDoc only has
    // entries from previous scans (registerHash runs in insertPreparedFile,
    // which fires after embedding).
    const scanHashes = new Map(); // contentHash -> docBaseId (first seen this scan)

    const watched = listWatchedFiles(collectionName);
    for (const { absolutePath, root, metadata } of watched) {
        const relPath = safeRel(root, absolutePath);
        const docBaseId = `${collectionName}:${relPath}`;
        currentFiles.add(docBaseId);

        try {
            const stat = fs.statSync(absolutePath);
            const existing = index.files[docBaseId];
            if (existing && existing.mtime === stat.mtimeMs && existing.size === stat.size) {
                stats.skipped++;
                continue;
            }

            if (existing) {
                stats.updated++;
                deleteExistingChunks(docBaseId);
            } else {
                stats.added++;
            }

            const prepared = prepareFileForIndexing(collectionName, absolutePath, root, metadata);
            if (prepared === null) {
                // Garbage file — don't index. Back out the added/updated count
                // and remove from the scan index so it's not tracked as known.
                if (existing) stats.updated--;
                else stats.added--;
                stats.skipped++;
                // Delete old vectors: if the file was previously indexed,
                // deleteExistingChunks handles it. If the scan-index entry was
                // removed (e.g. manual cleanup), deleteOrphanChunks sweeps the
                // DB for any surviving vectors under this docBaseId.
                if (existing) {
                    deleteExistingChunks(docBaseId);
                } else {
                    deleteOrphanChunks(collectionName, docBaseId);
                }
                delete index.files[docBaseId];
                unregisterHash(index, existing?.contentHash);
                continue;
            }

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
    }

    // Process files in groups so memory stays bounded and progress is saved incrementally.
    const groupSize = CONFIG.filesPerGroup || 100;
    for (let g = 0; g < toIndex.length; g += groupSize) {
        const group = toIndex.slice(g, g + groupSize);
        logger.info(`[VDB] ${collectionName}: indexing group ${Math.floor(g / groupSize) + 1}/${Math.ceil(toIndex.length / groupSize)} (${group.length} files)`, null, 'VDB');

        const allChunkTexts = [];
        const chunkOffsets = [];
        let offset = 0;
        for (const prepared of group) {
            const count = prepared.chunks.length;
            chunkOffsets.push({ prepared, start: offset, count });
            offset += count;
            for (const chunk of prepared.chunks) allChunkTexts.push(chunk.text);
        }

        try {
            const allEmbeddings = await embedInBatches(allChunkTexts);
            for (const { prepared, start, count } of chunkOffsets) {
                const embeddings = allEmbeddings.slice(start, start + count);
                insertPreparedFile(prepared, embeddings);
            }
        } catch (e) {
            logger.error(`[VDB] Group embedding failed: ${e.message}`, null, 'VDB');
            stats.errors += group.length;
            stats.added = Math.max(0, stats.added - group.length);
            stats.updated = Math.max(0, stats.updated - group.length);
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
    try {
        const before = coll.stats || {};
        const compactResult = await coll.compact();
        const after = coll.stats || {};
        logger.info(`[VDB] ${collectionName}: compacted`, {
            docsBefore: compactResult?.docsBefore ?? compactResult?.docs_before ?? before.totalSegmentDocs,
            docsAfter: compactResult?.docsAfter ?? compactResult?.docs_after ?? after.totalSegmentDocs,
            segmentsMerged: compactResult?.segmentsMerged ?? compactResult?.segments_merged ?? null
        }, 'VDB');
    } catch (e) {
        logger.warn(`[VDB] ${collectionName}: compaction failed: ${e.message}`, null, 'VDB');
    }

    return stats;
}

async function runScan() {
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
    const totalStats = { added: 0, updated: 0, removed: 0, errors: 0, skipped: 0 };

    const scanTimeoutMs = (CONFIG.scanTimeoutMinutes ?? DEFAULTS.scanTimeoutMinutes) * 60 * 1000;

    try {
        const scanPromise = (async () => {
            for (const name of Object.keys(CONFIG.watch || {})) {
                if (!COLLECTIONS[name]) continue;
                logger.info(`[VDB] Scanning collection: ${name}`, null, 'VDB');
                const stats = await scanCollection(name);
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
        else if (collectionName === 'documentation') filters.push(FILTER_BUILDER.eq('domain', folder));
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

export async function searchDocuments({ query, collections, folder, extension, top_k = 10, approximate = false, include_content = false } = {}) {
    if (!DATABASE) throw new Error('VDB agent is not initialized or nVDB is unavailable. Check logs.');
    if (!query) throw new Error('searchDocuments: query is required');

    const targetCollections = (collections && collections.length > 0)
        ? collections.filter(c => Object.keys(COLLECTIONS).includes(c) && CONFIG.watch?.[c])
        : Object.keys(CONFIG.watch || {});

    if (targetCollections.length === 0) throw new Error('searchDocuments: no enabled collections to search');

    const queryEmbedding = await embedText(query);

    // Per-collection search with min-max score normalization.
    // Raw cosine scores are NOT comparable across collections (different content
    // types cluster in different regions of the embedding space with different
    // score ranges). We normalize each collection's scores to [0,1] before
    // merging, so a documentation match at 0.55 (near that collection's max)
    // can compete with a storage match at 0.95.
    //
    // We over-fetch per collection (top_k * 3) so the diversity cap and
    // dedup have headroom to work with.
    const perCollection = [];

    for (const collectionName of targetCollections) {
        const coll = getCollection(collectionName);
        const filter = buildFilter(collectionName, folder, extension);
        const fetchK = Math.max(top_k * 3, 30);
        const searchResults = coll.search({
            vector: queryEmbedding,
            topK: fetchK,
            distance: 'cosine',
            approximate,
            ...(filter ? { filter } : {})
        });

        if (searchResults.length === 0) continue;

        // Min-max normalize scores within this collection.
        const scores = searchResults.map(r => r.score);
        const min = Math.min(...scores);
        const max = Math.max(...scores);
        const range = max - min || 1; // avoid divide-by-zero when all scores equal

        for (const match of searchResults) {
            const payload = JSON.parse(match.payload || '{}');
            const result = {
                collection: collectionName,
                id: match.id,
                score: match.score,
                normalizedScore: (match.score - min) / range,
                path: payload.path,
                absolutePath: payload.absolutePath,
                folder: payload.folder,
                domain: payload.domain,
                contentHash: payload.contentHash,
                splitIdx: payload.splitIdx,
                charOffset: payload.charOffset,
                tokEst: payload.tokEst
            };
            if (include_content) {
                result.content = readChunkContent(payload, CHUNKER);
            }
            perCollection.push(result);
        }
    }

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
        // Fast path: slice by charOffset + estimated chunk length.
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

// ── Tool handlers ─────────────────────────────────────────────────────

export async function vdb_search(args, context) {
    const top = await searchDocuments(args || {});

    const summary = top.map(r =>
        `[${r.collection}] ${r.path} (score: ${r.score.toFixed(4)}, norm: ${r.normalizedScore?.toFixed(3) ?? 'n/a'})${r.folder ? ` [folder:${r.folder}]` : ''}${r.domain ? ` [domain:${r.domain}]` : ''}${r.splitIdx > 0 ? ` chunk:${r.splitIdx}` : ''}`
    ).join('\n');

    return {
        content: [{
            type: 'text',
            text: `Found ${top.length} matches:\n\n${summary}\n\nRaw results:\n${JSON.stringify(top, null, 2)}`
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
            scanIntervalMinutes: CONFIG?.scanIntervalMinutes,
            embeddingDim: CONFIG?.embeddingDim,
            chunkMaxTokens: CONFIG?.chunkMaxTokens,
            chunkOverlapTokens: CONFIG?.chunkOverlapTokens,
            batchDelayMs: CONFIG?.batchDelayMs
        },
        collections: {},
        lastScanAt: LAST_SCAN_AT,
        isScanning: IS_SCANNING,
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
                    watched: !!CONFIG.watch?.[name]
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
    const result = await runScan();
    if (result.alreadyRunning) {
        return { content: [{ type: 'text', text: 'Scan already in progress; request ignored.' }] };
    }
    return {
        content: [{
            type: 'text',
            text: `Scan complete. added=${result.added} updated=${result.updated} removed=${result.removed} skipped=${result.skipped} errors=${result.errors}`
        }]
    };
}

export async function vdb_build_index(args, context) {
    if (!DATABASE) throw new Error('VDB agent is not initialized');
    const targets = (args?.collections || []).filter(c => Object.keys(COLLECTIONS).includes(c) && CONFIG.watch?.[c]);
    const names = targets.length > 0 ? targets : Object.keys(CONFIG.watch || {});
    const results = [];
    for (const name of names) {
        try {
            const coll = getCollection(name);
            coll.flush();
            coll.rebuildIndex();
            results.push({ collection: name, ok: true, hasIndex: coll.hasIndex() });
        } catch (e) {
            results.push({ collection: name, ok: false, error: e.message });
        }
    }
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
        watch: agentConfig.watch || { storage: true, documentation: true }
    };

    GATEWAY = context.gateway;
    GATEWAY_HTTP_URL = context.config?.gateway?.httpUrl;
    if (!GATEWAY) throw new Error('vdb.init: gateway is required');
    if (!GATEWAY_HTTP_URL) throw new Error('vdb.init: context.config.gateway.httpUrl is required');

    // Pull storage root from storage agent config
    const storageConfig = context.config?.agents?.storage;
    if (storageConfig?.root) {
        STORAGE_ROOT = path.resolve(PROJECT_ROOT, storageConfig.root);
    }

    // Pull documentation root from documentation agent config.
    // The natural structure is D:\DEV\LLM_Docs\Documentation\<Domain>\*.md,
    // so we point the watch root at the Documentation folder.
    const docsConfig = context.config?.agents?.documentation;
    if (docsConfig?.llmDocsPath) {
        DOCS_ROOT = path.resolve(path.resolve(PROJECT_ROOT, docsConfig.llmDocsPath), 'Documentation');
    }
    MCP_DOCS_ROOT = path.resolve(PROJECT_ROOT, 'mcp_documentation');

    CHUNKER = makeChunker({
        maxTokens: CONFIG.chunkMaxTokens,
        overlapTokens: CONFIG.chunkOverlapTokens,
        tokCharsRatio: CONFIG.chunkTokCharsRatio
    });

    if (!isNvdbAvailable()) {
        logger.error('[VDB] nVDB native module not available. VDB tools will fail until built.', null, 'VDB');
        return { enabled: false, error: 'nVDB native module not available' };
    }

    const { Database, FilterBuilder } = loadNvdb();
    FILTER_BUILDER = FilterBuilder;

    const dbPath = path.resolve(PROJECT_ROOT, CONFIG.dbPath);
    fs.mkdirSync(dbPath, { recursive: true });
    DATABASE = new Database(dbPath);

    // Pre-open configured collections so stats work
    for (const name of Object.keys(CONFIG.watch || {})) {
        if (Object.keys(COLLECTIONS).includes(name)) getCollection(name);
    }

    startScanner();

    // Run an initial scan soon after startup (don't block init)
    setTimeout(() => runScan().catch(e => logger.error(`[VDB] Initial scan failed: ${e.message}`, null, 'VDB')), 2000);

    logger.info(`[VDB] Initialized at ${dbPath}`, null, 'VDB');
    return { enabled: true, dbPath };
}

export async function shutdown() {
    if (SCAN_TIMER) clearInterval(SCAN_TIMER);
    if (DATABASE) {
        for (const coll of COLLECTION_INSTANCES.values()) {
            try { coll.flush(); } catch {}
        }
    }
}
