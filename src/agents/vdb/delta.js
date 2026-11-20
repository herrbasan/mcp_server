// Incremental storage freshness for the snapshot index.
//
// The candidate index is a fixed build. Without this reconciler, files created
// or edited after the build are invisible and deleted files keep their chunks.
// It does NOT rebuild and does NOT re-embed the snapshot: it appends only the
// difference, using the snapshot's own chunk ids and payload shape.
//
// Why a separate module and a separate checkpoint:
//   - `snapshot: true` keeps the full scanner off the candidate index (a scan
//     would re-embed all 21k chunks and rewrite payloads the builder owns);
//   - the checkpoint (delta-checkpoint.json) is the delta manifest — content
//     hash and chunk count per file — so a restart resumes instead of starting
//     over, and so deletions can be honoured without reading the whole index.
//
// Failure semantics: for one file, every chunk is embedded BEFORE anything is
// written. A provider failure therefore leaves the previous chunks intact and
// the file stays pending; the checkpoint is only advanced after the write, so
// the next cycle retries exactly that file. A restart re-reads the checkpoint
// and continues.
//
// Compaction is not automatic: deletes leave tombstones that search already
// skips, and rewriting the 100 MB+ segments on every few-file change is the
// stall this project removed once already. `compactAfterDeletes` exists for an
// operator that wants it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CHECKPOINT_VERSION = 1;
const MAX_PROBED_CHUNKS = 5000;

function chunkIds(relPath, count) {
    const base = `storage:${relPath}`;
    return count === 1 ? [base] : Array.from({ length: count }, (_, i) => `${base}#${i}`);
}

function titleOf(relPath) {
    return relPath.split('/').pop().replace(/\.[^.]+$/, '');
}

// Same shape as the snapshot builder: the embedded text and the payload's
// `content` are the same string, so reranking and the lexical lane see what the
// vector was computed from.
function chunkContent(relPath, title, text) {
    return `Title: ${title}\nPath: ${relPath}\n\n${text}`;
}

function cryptoHash(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createDeltaReconciler({
    checkpointPath,
    storageRoot,
    getCollection,
    chunker,
    embedMany,
    listFiles,
    snapshotBuiltAt = null,
    logger,
    compactAfterDeletes = false
}) {
    if (!checkpointPath) throw new Error('delta: checkpointPath is required');
    if (!storageRoot) throw new Error('delta: storageRoot is required');
    if (typeof getCollection !== 'function') throw new Error('delta: getCollection is required');
    if (typeof chunker !== 'function') throw new Error('delta: chunker is required');
    if (typeof embedMany !== 'function') throw new Error('delta: embedMany is required');
    if (typeof listFiles !== 'function') throw new Error('delta: listFiles is required');

    let running = false;
    let cached = null;

    function load() {
        if (cached) return cached;
        if (fs.existsSync(checkpointPath)) {
            const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
            if (parsed.version !== CHECKPOINT_VERSION) {
                throw new Error(`delta: checkpoint ${checkpointPath} has version ${parsed.version}, expected ${CHECKPOINT_VERSION}`);
            }
            cached = parsed;
        } else {
            cached = { version: CHECKPOINT_VERSION, initialized: false, initializedAt: null, files: {}, lastRunAt: null, lastError: null };
        }
        return cached;
    }

    function save(checkpoint) {
        fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
        const tmp = `${checkpointPath}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, checkpointPath);
    }

    function collection() {
        return getCollection('storage');
    }

    // The snapshot does not record a chunk count, so an adopted file's existing
    // chunks are discovered by probing ids. Only the bootstrap pays this, and it
    // is what lets a later edit prune the snapshot's stale chunks.
    function detectChunkCount(relPath) {
        const coll = collection();
        if (coll.get(`storage:${relPath}`) !== null) return 1;
        let count = 0;
        while (count < MAX_PROBED_CHUNKS && coll.get(`storage:${relPath}#${count}`) !== null) count++;
        return count;
    }

    function deleteFile(relPath, chunkCount) {
        const coll = collection();
        let removed = 0;
        for (const id of chunkIds(relPath, chunkCount)) {
            if (coll.delete(id)) removed++;
        }
        return removed;
    }

    async function reconcileFile({ relPath, content, previous }) {
        const chunks = chunker(content);
        const title = titleOf(relPath);
        const texts = chunks.map(chunk => chunkContent(relPath, title, chunk.text));
        if (texts.length === 0) {
            // An empty file has nothing to embed; make sure no stale chunks stay.
            if (previous) deleteFile(relPath, previous.chunks);
            return { chunks: 0, embedded: 0, pruned: 0 };
        }
        // Embed everything first: a failure here writes nothing and the previous
        // chunks survive untouched.
        const embeddings = await embedMany(texts);
        const coll = collection();
        const ids = chunkIds(relPath, texts.length);
        for (let i = 0; i < texts.length; i++) {
            coll.insert(ids[i], embeddings[i], JSON.stringify({ path: relPath, title, content: texts[i] }));
        }
        // Prune ids this file owned before and no longer has (a shrinking edit).
        let pruned = 0;
        if (previous && previous.chunks > ids.length) {
            for (const id of chunkIds(relPath, previous.chunks).slice(ids.length)) {
                if (coll.delete(id)) pruned++;
            }
        }
        return { chunks: ids.length, embedded: texts.length, pruned };
    }

    async function run() {
        if (running) return { skipped: 'already running' };
        running = true;
        const started = Date.now();
        const checkpoint = load();
        const result = { scanned: 0, added: 0, updated: 0, removed: 0, unchanged: 0, adopted: 0, failed: 0, chunksAdded: 0, errors: [] };
        try {
            const files = await listFiles();
            const current = new Map(files.map(file => [file.relPath, file]));
            const bootstrap = checkpoint.initialized !== true;

            // 1. Deletions: checkpoint paths that no longer exist on disk.
            for (const relPath of Object.keys(checkpoint.files)) {
                if (current.has(relPath)) continue;
                deleteFile(relPath, checkpoint.files[relPath].chunks);
                delete checkpoint.files[relPath];
                result.removed++;
            }

            // 2. Additions and edits.
            for (const file of current.values()) {
                result.scanned++;
                const previous = checkpoint.files[file.relPath];
                let content;
                try {
                    content = await fs.promises.readFile(file.absolutePath, 'utf8');
                } catch (error) {
                    result.failed++;
                    result.errors.push({ relPath: file.relPath, error: error.message });
                    continue;
                }
                const contentHash = cryptoHash(content);

                if (previous && previous.contentHash === contentHash) {
                    result.unchanged++;
                    continue;
                }

                if (bootstrap && !previous) {
                    const existingChunks = detectChunkCount(file.relPath);
                    if (existingChunks > 0 && !(snapshotBuiltAt && file.mtimeMs > snapshotBuiltAt)) {
                        // The snapshot already covers this file and it has not been
                        // touched since the build: adopt it without spending an
                        // embedding. (A file edited between the build and this
                        // first run is caught by mtime; see the handover boundary.)
                        checkpoint.files[file.relPath] = {
                            contentHash, chunks: existingChunks, mtimeMs: file.mtimeMs, size: file.size, indexedAt: null, adopted: true
                        };
                        result.adopted++;
                        save(checkpoint);
                        continue;
                    }
                }

                const isUpdate = Boolean(previous) || detectChunkCount(file.relPath) > 0;
                try {
                    const written = await reconcileFile({ ...file, content, previous });
                    checkpoint.files[file.relPath] = {
                        contentHash,
                        chunks: written.chunks,
                        mtimeMs: file.mtimeMs,
                        size: file.size,
                        indexedAt: new Date().toISOString()
                    };
                    result.chunksAdded += written.embedded;
                    if (isUpdate) result.updated++;
                    else result.added++;
                    checkpoint.lastError = null;
                } catch (error) {
                    // Provider or disk failure: nothing was written for this file,
                    // its previous chunks (if any) are intact, and the checkpoint
                    // still holds the old hash so the next cycle retries it.
                    result.failed++;
                    result.errors.push({ relPath: file.relPath, error: error.message });
                    checkpoint.lastError = `${file.relPath}: ${error.message}`;
                    save(checkpoint);
                    logger.error(`[VDB:delta] embed failed for ${file.relPath}: ${error.message} — state unchanged, retry next cycle`, null, 'VDB');
                    break; // the provider is likely down; do not hammer the rest
                }
                save(checkpoint);
            }

            if (bootstrap) {
                checkpoint.initialized = true;
                checkpoint.initializedAt = new Date().toISOString();
                checkpoint.snapshotBuiltAt = snapshotBuiltAt ?? null;
            }
            checkpoint.lastRunAt = new Date().toISOString();
            save(checkpoint);

            if (compactAfterDeletes && result.removed > 0) {
                collection().compact();
                result.compacted = true;
            }

            logger.info(`[VDB:delta] scanned=${result.scanned} added=${result.added} updated=${result.updated} removed=${result.removed} unchanged=${result.unchanged} adopted=${result.adopted} failed=${result.failed} chunks=${result.chunksAdded} in ${Date.now() - started} ms`, null, 'VDB');
            return result;
        } catch (error) {
            checkpoint.lastError = error.message;
            save(checkpoint);
            logger.error(`[VDB:delta] reconcile failed: ${error.message}`, null, 'VDB');
            throw error;
        } finally {
            running = false;
        }
    }

    function status() {
        const checkpoint = load();
        return {
            checkpointPath,
            initialized: checkpoint.initialized === true,
            initializedAt: checkpoint.initializedAt,
            snapshotBuiltAt: checkpoint.snapshotBuiltAt ?? null,
            lastRunAt: checkpoint.lastRunAt,
            lastError: checkpoint.lastError,
            trackedFiles: Object.keys(checkpoint.files).length,
            running,
            compactAfterDeletes
        };
    }

    return { run, status, checkpointPath };
}
