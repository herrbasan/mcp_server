/**
 * One-shot (resumable) dense vector backfill for nVDB v2 (`nvdb serve`).
 *
 * Usage:
 *   node scripts/backfill-nvdb-v2-vectors.mjs --probe
 *   node scripts/backfill-nvdb-v2-vectors.mjs [--collections memory,storage] [--batch 8] [--concurrency 2]
 *
 * Uses `pending_embeddings` + `attach_vectors` (CAS by content_hash), so it is
 * idempotent and safe to interrupt and resume at any time.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmbedClient } from '../src/embed-client.js';
import { createV2Client } from '../src/agents/vdb/v2-client.js';
import { createStorageConnector, parseStorageChunkId } from '../src/agents/vdb/storage-connector.js';
import { memoryVectorInput, memoryToV2Doc } from '../src/agents/memory/index.js';
import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { documentHashes } from '../src/agents/vdb/v2-hash.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
    const out = { probe: false, collections: ['memory', 'storage'], batch: 8, attachBatch: 256, sync: true, check: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--probe') out.probe = true;
        else if (a === '--no-sync') out.sync = false;
        else if (a === '--no-check') out.check = false;
        else if (a === '--collections' && argv[i + 1]) out.collections = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--batch' && argv[i + 1]) out.batch = Number(argv[++i]);
        else if (a === '--attach-batch' && argv[i + 1]) out.attachBatch = Number(argv[++i]);
    }
    if (!Number.isInteger(out.batch) || out.batch <= 0) throw new Error(`Invalid --batch: ${out.batch}`);
    if (!Number.isInteger(out.attachBatch) || out.attachBatch <= 0) throw new Error(`Invalid --attach-batch: ${out.attachBatch}`);
    return out;
}

async function loadConfig() {
    const raw = await fs.readFile(path.join(PROJECT_ROOT, 'config.json'), 'utf8');
    return JSON.parse(raw);
}

async function runProbe(embedClient, embedPath) {
    const t0 = Date.now();
    const single = await embedClient.embed('nVDB v2 OpenVINO embedding probe', { path: embedPath });
    const t1 = Date.now();
    const batchTexts = [
        'Consciousness Is the Record — epistemic grounding in AI',
        'MD-Blocks structured markdown authoring specification',
        'Prototype Fund German open source grant funding decision',
        'Rechtsschutzversicherung Vertragskündigung Hinweise',
    ];
    const batch = await embedClient.embedBatch(batchTexts, { path: embedPath, background: true });
    const t2 = Date.now();
    console.log(JSON.stringify({
        ok: true,
        embedPath,
        dim: single.length,
        singleMs: t1 - t0,
        batch4Ms: t2 - t1,
        perItemMs: Math.round((t2 - t1) / batch.length),
    }, null, 2));
}

async function backfillMemory({ client, embedClient, cfg, batchSize, attachBatch, doCheck }) {
    const memCfg = cfg.agents.memory || {};
    const vdbCfg = cfg.agents.vdb || {};
    const dbPath = path.resolve(PROJECT_ROOT, memCfg.dbPath || 'data/memories/data.jsonl');
    const maxChars = memCfg.maxMemoryChars || 6000;
    const modelVersion = vdbCfg.modelVersion || 'qwen3-embedding-4b';
    const embedPath = vdbCfg.embeddingPath || '/v1/embeddings';
    const principals = vdbCfg.principals || ['default'];

    const { Database } = loadNdb();
    const db = Database.open(dbPath, { persistence: 'buffered' });
    const memById = new Map();
    for (const doc of db.iter()) {
        if (doc._id?.startsWith('mem_')) memById.set(doc._id, doc);
    }

    const total = memById.size;
    const started = Date.now();
    let attached = 0;
    let skipped = 0;

    while (true) {
        const res = await client.pendingEmbeddings('memory', attachBatch);
        const pending = res.pending || [];
        if (pending.length === 0) break;

        const work = [];
        for (const item of pending) {
            const mem = memById.get(item.id);
            if (!mem) {
                skipped++;
                continue;
            }
            const v2Doc = memoryToV2Doc(mem, { maxChars, principals });
            const { content_hash } = documentHashes(v2Doc);
            if (content_hash !== item.content_hash) {
                skipped++;
                continue;
            }
            work.push({
                id: item.id,
                content_hash: item.content_hash,
                text: memoryVectorInput(mem.description || '', mem.data, maxChars),
            });
        }
        if (work.length === 0) break;

        const tEmbed0 = Date.now();
        const attachments = [];
        for (let i = 0; i < work.length; i += batchSize) {
            const slice = work.slice(i, i + batchSize);
            const vectors = await embedClient.embedBatch(
                slice.map(w => w.text),
                { background: true, path: embedPath }
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
        const embedMs = Date.now() - tEmbed0;
        const tAttach0 = Date.now();
        const r = await client.attachVectors('memory', attachments);
        const attachMs = Date.now() - tAttach0;
        attached += r.attached ?? attachments.length;

        const elapsed = (Date.now() - started) / 1000;
        const rate = attached / Math.max(0.1, elapsed);
        const etaSec = Math.max(0, (total - attached) / Math.max(0.1, rate));
        console.log(`[memory] +${attachments.length} attached=${attached}/${total} rate=${rate.toFixed(1)}/s (embed=${(embedMs / 1000).toFixed(1)}s attach=${(attachMs / 1000).toFixed(2)}s) eta=${Math.round(etaSec)}s`);
    }

    const elapsed = (Date.now() - started) / 1000;
    console.log(`[memory] DONE attached=${attached} skipped=${skipped} in ${elapsed.toFixed(1)}s`);

    if (doCheck) {
        const expected = [];
        for (const mem of memById.values()) {
            const v2Doc = memoryToV2Doc(mem, { maxChars, principals });
            const { content_hash, envelope_hash } = documentHashes(v2Doc);
            expected.push({ id: v2Doc.id, content_hash, envelope_hash });
        }
        const chk = await client.integrityCheck('memory', expected, { checkVectors: true });
        console.log('[memory] integrity_check(checkVectors=true):', JSON.stringify({
            clean: chk.clean,
            missing: chk.missing.length,
            extra: chk.extra.length,
            content_mismatched: chk.content_mismatched.length,
            envelope_mismatched: chk.envelope_mismatched.length,
            missing_vectors: chk.missing_vectors.length,
        }));
    }

    return { attached, skipped, elapsedSec: Number(elapsed.toFixed(1)) };
}

function makeStorageConnector({ client, cfg }) {
    const vdbCfg = cfg.agents.vdb || {};
    const storageRoot = path.resolve(cfg.agents.storage.root);
    return createStorageConnector({
        client,
        storageRoot,
        collection: 'storage',
        principals: vdbCfg.principals || ['default'],
        modelVersion: vdbCfg.modelVersion || 'qwen3-embedding-4b',
        textExtensions: vdbCfg.textExtensions,
        ignore: vdbCfg.ignore,
        maxFileSizeBytes: vdbCfg.maxFileSizeBytes,
        chunkMaxTokens: vdbCfg.chunkMaxTokens,
        chunkOverlapTokens: vdbCfg.chunkOverlapTokens,
        chunkTokCharsRatio: vdbCfg.chunkTokCharsRatio,
    });
}

async function backfillStorage({ client, embedClient, cfg, batchSize, attachBatch, connector, totalChunks }) {
    const vdbCfg = cfg.agents.vdb || {};
    const storageRoot = path.resolve(cfg.agents.storage.root);
    const modelVersion = vdbCfg.modelVersion || 'qwen3-embedding-4b';
    const embedPath = vdbCfg.embeddingPath || '/v1/embeddings';

    const fp = await client.fingerprints('storage');
    const initialDone = (fp.entries || []).filter(e => e.has_vector).length;
    const total = totalChunks || fp.doc_count || 0;
    const started = Date.now();
    let attached = 0;
    let skipped = 0;
    const fileCache = new Map();

    while (true) {
        const res = await client.pendingEmbeddings('storage', attachBatch);
        const pending = res.pending || [];
        if (pending.length === 0) break;

        const work = [];
        for (const item of pending) {
            const { relPath, chunkIndex } = parseStorageChunkId(item.id);
            let docs = fileCache.get(relPath);
            if (docs === undefined) {
                const fullPath = path.join(storageRoot, ...relPath.split('/'));
                try {
                    const [text, stat] = await Promise.all([
                        fs.readFile(fullPath, 'utf8'),
                        fs.stat(fullPath),
                    ]);
                    docs = connector.buildDocsForText(relPath, text, Math.floor(stat.mtimeMs));
                } catch (err) {
                    if (err.code === 'ENOENT') docs = null;
                    else throw err;
                }
                if (fileCache.size > 500) fileCache.clear();
                fileCache.set(relPath, docs);
            }
            const doc = docs?.[chunkIndex];
            if (!doc) {
                skipped++;
                continue;
            }
            const { content_hash } = documentHashes(doc);
            if (content_hash !== item.content_hash) {
                skipped++;
                continue;
            }
            work.push({
                id: item.id,
                content_hash: item.content_hash,
                text: `Title: ${doc.title}\nPath: ${doc.path}\n\n${doc.body}`,
            });
        }
        if (work.length === 0) break;

        const tEmbed0 = Date.now();
        const attachments = [];
        for (let i = 0; i < work.length; i += batchSize) {
            const slice = work.slice(i, i + batchSize);
            const vectors = await embedClient.embedBatch(
                slice.map(w => w.text),
                { background: true, path: embedPath }
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
        const embedMs = Date.now() - tEmbed0;
        const tAttach0 = Date.now();
        const r = await client.attachVectors('storage', attachments);
        const attachMs = Date.now() - tAttach0;
        attached += r.attached ?? attachments.length;

        const doneNow = initialDone + attached;
        const elapsed = (Date.now() - started) / 1000;
        const rate = attached / Math.max(0.1, elapsed);
        const remaining = Math.max(0, total - doneNow);
        const etaStr = total > 0 ? ` eta=${Math.round(remaining / Math.max(0.1, rate))}s` : '';
        console.log(`[storage] +${attachments.length} total=${doneNow}/${total} rate=${rate.toFixed(1)}/s (embed=${(embedMs / 1000).toFixed(1)}s attach=${(attachMs / 1000).toFixed(2)}s)${etaStr}`);
    }

    const elapsed = (Date.now() - started) / 1000;
    console.log(`[storage] DONE attached=${attached} skipped=${skipped} in ${elapsed.toFixed(1)}s`);
    return { connector, attached, skipped, elapsedSec: Number(elapsed.toFixed(1)) };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cfg = await loadConfig();
    const vdbCfg = cfg.agents.vdb;
    const embedClient = createEmbedClient(cfg.gateway.httpUrl, cfg.gateway.accessKey);
    const embedPath = vdbCfg.embeddingPath || '/v1/embeddings';

    if (args.probe) {
        await runProbe(embedClient, embedPath);
        return;
    }

    const client = createV2Client(vdbCfg.serviceUrl, { timeoutMs: 120_000 });
    const health = await client.health();
    if (!health?.ok) throw new Error(`nvdb serve unhealthy at ${vdbCfg.serviceUrl}`);
    console.log(`Connected to nvdb serve (${vdbCfg.serviceUrl}, reranker_loaded=${health.reranker_loaded})`);

    let storageConnector = null;
    let storageTotalChunks = 0;
    if (args.collections.includes('storage')) {
        storageConnector = makeStorageConnector({ client, cfg });
        if (args.sync) {
            const s = await storageConnector.sync();
            storageTotalChunks = s.chunks;
            console.log(`[storage] sync: files=${s.files} chunks=${s.chunks} upserted=${s.upserted} deleted=${s.deleted} unchanged=${s.unchanged} (${s.durationMs}ms)`);
        }
    }

    for (const coll of args.collections) {
        if (coll === 'memory') {
            await backfillMemory({ client, embedClient, cfg, batchSize: args.batch, attachBatch: args.attachBatch, doCheck: args.check });
        } else if (coll === 'storage') {
            const res = await backfillStorage({ client, embedClient, cfg, batchSize: args.batch, attachBatch: args.attachBatch, connector: storageConnector, totalChunks: storageTotalChunks });
            if (args.check) {
                const chk = await res.connector.integrityCheck({ checkVectors: true });
                console.log('[storage] integrity_check(checkVectors=true):', JSON.stringify({
                    clean: chk.clean,
                    missing: chk.missing.length,
                    extra: chk.extra.length,
                    content_mismatched: chk.content_mismatched.length,
                    envelope_mismatched: chk.envelope_mismatched.length,
                    missing_vectors: chk.missing_vectors.length,
                }));
            }
        } else {
            throw new Error(`Unknown collection: ${coll}`);
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
