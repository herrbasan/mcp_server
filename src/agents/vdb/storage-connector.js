import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { makeChunker } from './chunker.js';
import { documentHashes } from './v2-hash.js';

const DEFAULT_YIELD_BUDGET_MS = 50;
const UPSERT_BATCH_SIZE = 200;
const MAX_EXCERPT_BYTES = 1024;

function matchesIgnorePattern(name, pattern) {
    if (pattern === '*') return true;
    if (!pattern.includes('*')) return name === pattern;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(name);
}

async function readLocalIgnore(dir) {
    try {
        const raw = await fsp.readFile(path.join(dir, '.nvdb_ignore'), 'utf8');
        return raw.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

function truncateUtf8(str, maxBytes) {
    const buf = Buffer.from(str, 'utf8');
    if (buf.length <= maxBytes) return str;
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString('utf8');
}

function extractTitle(text, relPath) {
    // Check YAML frontmatter title first
    if (text.startsWith('---')) {
        const end = text.indexOf('\n---', 3);
        if (end !== -1) {
            const fm = text.slice(3, end);
            const m = fm.match(/^\s*title\s*:\s*["']?(.+?)["']?\s*$/m);
            if (m && m[1].trim()) return m[1].trim();
        }
    }
    // First markdown H1
    const h1 = text.match(/^#\s+(.+)$/m);
    if (h1 && h1[1].trim()) return h1[1].trim();
    // Fallback: filename without extension
    const base = path.posix.basename(relPath);
    const ext = path.posix.extname(base);
    return ext ? base.slice(0, -ext.length) : base;
}

function extractHeadings(chunkText) {
    const lines = [];
    for (const line of chunkText.split('\n')) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        if (m && m[1].trim()) lines.push(m[1].trim());
    }
    return lines.join('\n');
}

export function storageChunkId(relPath, chunkIndex) {
    return `${relPath}#${chunkIndex}`;
}

export function parseStorageChunkId(id) {
    const hash = id.lastIndexOf('#');
    if (hash === -1) return { relPath: id, chunkIndex: 0 };
    const idx = Number(id.slice(hash + 1));
    if (!Number.isInteger(idx) || idx < 0) return { relPath: id, chunkIndex: 0 };
    return { relPath: id.slice(0, hash), chunkIndex: idx };
}

export function createStorageConnector({
    client,
    storageRoot,
    collection = 'storage',
    principals = ['default'],
    modelVersion = 'qwen3-embedding-4b',
    textExtensions = ['.md', '.txt', '.json', '.js', '.mjs', '.css', '.html', '.htm', '.log', '.yaml', '.yml', '.xml', '.csv', '.tsv', '.sql'],
    ignore = ['forge', 'temp', '_trash', '.backups', 'charts', 'prints', 'item.json', 'meta.json'],
    maxFileSizeBytes = 10 * 1024 * 1024,
    chunkMaxTokens = 1024,
    chunkOverlapTokens = 128,
    chunkTokCharsRatio = 2.5,
    yieldBudgetMs = DEFAULT_YIELD_BUDGET_MS,
    logger = console,
}) {
    if (!client) throw new Error('createStorageConnector: client is required');
    if (!storageRoot) throw new Error('createStorageConnector: storageRoot is required');

    const extSet = new Set(textExtensions.map(e => e.toLowerCase()));
    const globalIgnore = new Set(ignore);
    const chunkText = makeChunker({
        maxTokens: chunkMaxTokens,
        overlapTokens: chunkOverlapTokens,
        tokCharsRatio: chunkTokCharsRatio,
    });

    async function listFiles() {
        const results = [];
        let lastYield = Date.now();

        async function walk(dir, relPrefix) {
            const localPatterns = await readLocalIgnore(dir);
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch (err) {
                if (err.code === 'ENOENT' || err.code === 'EACCES') return;
                throw err;
            }

            for (const entry of entries) {
                if (Date.now() - lastYield >= yieldBudgetMs) {
                    await new Promise(r => setImmediate(r));
                    lastYield = Date.now();
                }

                const name = entry.name;
                if (name.startsWith('.') && name !== '.nvdb_ignore') continue;
                if (globalIgnore.has(name)) continue;
                if (localPatterns.some(p => matchesIgnorePattern(name, p))) continue;

                const fullPath = path.join(dir, name);
                const relPath = relPrefix ? `${relPrefix}/${name}` : name;

                if (entry.isDirectory()) {
                    await walk(fullPath, relPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(name).toLowerCase();
                    if (!extSet.has(ext)) continue;
                    let stat;
                    try {
                        stat = await fsp.stat(fullPath);
                    } catch {
                        continue;
                    }
                    if (stat.size === 0 || stat.size > maxFileSizeBytes) continue;
                    results.push({ relPath, fullPath, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
                }
            }
        }

        await walk(storageRoot, '');
        return results;
    }

    function buildDocsForText(relPath, text, mtimeMs) {
        const chunks = chunkText(text);
        if (chunks.length === 0) return [];
        const title = extractTitle(text, relPath);
        const name = path.posix.basename(relPath);
        const slashIdx = relPath.indexOf('/');
        const folder = slashIdx === -1 ? null : relPath.slice(0, slashIdx);
        const rawExt = path.posix.extname(relPath).toLowerCase();
        const ext = rawExt.startsWith('.') ? rawExt.slice(1) : (rawExt || null);
        const updatedAt = Number.isFinite(mtimeMs) ? Math.floor(mtimeMs / 1000) : null;

        return chunks.map((chunk, i) => ({
            id: storageChunkId(relPath, i),
            parent_id: relPath,
            chunk_index: i,
            kind: 'doc',
            title,
            name,
            path: relPath,
            headings: extractHeadings(chunk.text),
            categories: [],
            tags: [],
            body: chunk.text,
            folder,
            ext,
            mime: null,
            status: 'active',
            created_at: updatedAt,
            updated_at: updatedAt,
            acl: principals,
            metadata: {
                charOffset: chunk.charOffset,
                charLen: chunk.charLen,
                splitIdx: chunk.splitIdx,
                isLastChunk: chunk.isLastChunk,
            },
            excerpt: truncateUtf8(chunk.text, MAX_EXCERPT_BYTES),
        }));
    }

    async function readChunkContent(id) {
        const { relPath, chunkIndex } = parseStorageChunkId(id);
        const fullPath = path.join(storageRoot, ...relPath.split('/'));
        let text;
        try {
            text = await fsp.readFile(fullPath, 'utf8');
        } catch (err) {
            if (err.code === 'ENOENT') return null;
            throw err;
        }
        const chunks = chunkText(text);
        if (chunkIndex < 0 || chunkIndex >= chunks.length) return null;
        return chunks[chunkIndex].text;
    }

    async function sync({ onProgress } = {}) {
        const started = Date.now();
        const fpRes = await client.fingerprints(collection);
        const existing = new Map();
        for (const entry of fpRes.entries || []) {
            existing.set(entry.id, entry);
        }

        const files = await listFiles();
        const liveIds = new Set();
        const toUpsert = [];
        let unchanged = 0;
        let lastYield = Date.now();

        for (let i = 0; i < files.length; i++) {
            if (Date.now() - lastYield >= yieldBudgetMs) {
                await new Promise(r => setImmediate(r));
                lastYield = Date.now();
            }
            const file = files[i];
            let text;
            try {
                text = await fsp.readFile(file.fullPath, 'utf8');
            } catch (err) {
                if (err.code === 'ENOENT') continue;
                throw err;
            }
            const docs = buildDocsForText(file.relPath, text, file.mtimeMs);
            for (const doc of docs) {
                liveIds.add(doc.id);
                const hashes = documentHashes(doc);
                const prev = existing.get(doc.id);
                if (prev && prev.envelope_hash === hashes.envelope_hash) {
                    unchanged++;
                } else {
                    toUpsert.push(doc);
                }
            }
            if (onProgress && i % 200 === 0) {
                onProgress(`Scanning storage (${i}/${files.length} files)`, Math.round((i / Math.max(1, files.length)) * 50));
            }
        }

        const toDelete = [];
        for (const id of existing.keys()) {
            if (!liveIds.has(id)) toDelete.push(id);
        }

        let upserted = 0;
        for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH_SIZE) {
            const batch = toUpsert.slice(i, i + UPSERT_BATCH_SIZE);
            await client.upsert(collection, batch, { commit: false });
            upserted += batch.length;
        }

        let deleted = 0;
        if (toDelete.length > 0) {
            for (let i = 0; i < toDelete.length; i += UPSERT_BATCH_SIZE) {
                const batch = toDelete.slice(i, i + UPSERT_BATCH_SIZE);
                const res = await client.deleteIds(collection, batch, { commit: false });
                deleted += res.deleted ?? batch.length;
            }
        }

        if (upserted > 0 || deleted > 0) {
            await client.commit(collection);
        }

        return {
            files: files.length,
            chunks: liveIds.size,
            upserted,
            deleted,
            unchanged,
            durationMs: Date.now() - started,
        };
    }

    async function drainPendingEmbeddings({
        embedBatch,
        embeddingPath,
        batchSize = 4,
        maxItems = 500,
        onProgress,
    }) {
        if (typeof embedBatch !== 'function') {
            throw new Error('drainPendingEmbeddings: embedBatch function is required');
        }
        let attachedTotal = 0;
        let staleSkipped = 0;
        let missingSkipped = 0;

        while (attachedTotal + staleSkipped + missingSkipped < maxItems) {
            const remaining = maxItems - (attachedTotal + staleSkipped + missingSkipped);
            const fetchLimit = Math.min(remaining, 128);
            const res = await client.pendingEmbeddings(collection, fetchLimit);
            const pending = res.pending || [];
            if (pending.length === 0) break;

            // Resolve disk text + verify content_hash before embedding
            const work = [];
            const fileCache = new Map();
            for (const item of pending) {
                const { relPath, chunkIndex } = parseStorageChunkId(item.id);
                let docs = fileCache.get(relPath);
                if (docs === undefined) {
                    const fullPath = path.join(storageRoot, ...relPath.split('/'));
                    try {
                        const [text, stat] = await Promise.all([
                            fsp.readFile(fullPath, 'utf8'),
                            fsp.stat(fullPath),
                        ]);
                        docs = buildDocsForText(relPath, text, Math.floor(stat.mtimeMs));
                    } catch (err) {
                        if (err.code === 'ENOENT') docs = null;
                        else throw err;
                    }
                    fileCache.set(relPath, docs);
                }
                const doc = docs?.[chunkIndex];
                if (!doc) {
                    missingSkipped++;
                    continue;
                }
                const hashes = documentHashes(doc);
                if (hashes.content_hash !== item.content_hash) {
                    staleSkipped++;
                    continue;
                }
                work.push({
                    id: item.id,
                    content_hash: item.content_hash,
                    text: `Title: ${doc.title}\nPath: ${doc.path}\n\n${doc.body}`,
                });
            }

            if (work.length === 0) break;

            // Buffer all embeddings for this page and flush in a single attachVectors
            // call so nvdb's vectors.bin persist runs once per page instead of per 4 items.
            const attachments = [];
            for (let i = 0; i < work.length; i += batchSize) {
                const slice = work.slice(i, i + batchSize);
                const vectors = await embedBatch(
                    slice.map(w => w.text),
                    { background: true, path: embeddingPath }
                );
                for (let idx = 0; idx < slice.length; idx++) {
                    attachments.push({
                        id: slice[idx].id,
                        content_hash: slice[idx].content_hash,
                        model_version: modelVersion,
                        vector: vectors[idx],
                    });
                }
            }

            try {
                const attachRes = await client.attachVectors(collection, attachments);
                attachedTotal += attachRes.attached ?? attachments.length;
            } catch (err) {
                if (err.status === 409 && err.code === 'stale_vector_cas') {
                    // One or more files changed mid-embed; retry individually so fresh items still land.
                    for (const att of attachments) {
                        try {
                            const singleRes = await client.attachVectors(collection, [att]);
                            attachedTotal += singleRes.attached ?? 1;
                        } catch (inner) {
                            if (inner.status === 409 && inner.code === 'stale_vector_cas') {
                                staleSkipped++;
                            } else {
                                throw inner;
                            }
                        }
                    }
                    logger.warn?.(`[VDB] Stale vector CAS during storage batch — skipped ${staleSkipped} stale items`);
                } else {
                    throw err;
                }
            }

            if (onProgress) {
                onProgress(`Embedded ${attachedTotal} storage chunks`, null);
            }

            if (pending.length < fetchLimit) break;
        }

        return { attached: attachedTotal, staleSkipped, missingSkipped };
    }

    async function integrityCheck({ checkVectors = false } = {}) {
        const files = await listFiles();
        const expected = [];
        let lastYield = Date.now();
        for (const file of files) {
            if (Date.now() - lastYield >= yieldBudgetMs) {
                await new Promise(r => setImmediate(r));
                lastYield = Date.now();
            }
            let text;
            try {
                text = await fsp.readFile(file.fullPath, 'utf8');
            } catch (err) {
                if (err.code === 'ENOENT') continue;
                throw err;
            }
            const docs = buildDocsForText(file.relPath, text, file.mtimeMs);
            for (const doc of docs) {
                const { content_hash, envelope_hash } = documentHashes(doc);
                expected.push({ id: doc.id, content_hash, envelope_hash });
            }
        }
        return client.integrityCheck(collection, expected, { checkVectors });
    }

    return {
        collection,
        listFiles,
        buildDocsForText,
        readChunkContent,
        sync,
        drainPendingEmbeddings,
        integrityCheck,
    };
}
