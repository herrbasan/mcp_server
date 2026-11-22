import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { createNdbClient } from '../../lib/ndb-client.js';
import { requireFields, requireId } from '../../utils/require-fields.js';
import { createProgressReporter } from '../../utils/progress-reporter.js';
import { resolveSearchOptions, describeSearchOptions } from '../vdb/search-options.js';
import { formatSearchTiming } from '../vdb/index.js';
import { formatRelevance } from '../vdb/relevance.js';
import { documentHashes } from '../vdb/v2-hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = getLogger();

const MAX_EXCERPT_BYTES = 1024;
const UPSERT_BATCH_SIZE = 200;
const MEMORY_PAGE_SIZE = 1000;

// ── State ────────────────────────────────────────────────────────────

let DB = null;            // ndb serve DB handle (authoritative store)
let NDB_URL = null;       // service URL this agent is bound to (for error messages)
let DB_NAME = null;       // mounted database name
let MEM_META_ID = null;   // _meta doc id in the memories DB
let VDB_AGENT = null;     // VDB agent instance (owns nvdb serve HTTP client)
let VDB_CLIENT = null;    // nvdb serve HTTP client
let GATEWAY = null;       // LLM Gateway client
let CONFIG = null;        // Memory agent config
let PRINCIPALS = ['default'];
let MODEL_VERSION = 'qwen3-embedding-4b';
let EMBED_PATH = '/v1/embeddings';
let FUZZY_EDITS = 1;
let RERANKER_LOADED = false;
let HYBRID = { enabled: true, adaptive: true, rrfK: 20, candidateK: 200, lexicalWeight: 0.3, vectorWeight: 1.0, diversityField: 'parent_id', maxPerDocument: 2 };
let RERANK = { enabled: true, shortlist: 12, weight: 0.6 };
let RELEVANCE_FLOOR = 0.05;

// ── Helpers ──────────────────────────────────────────────────────────

function serializeData(data) {
    if (data == null) return '';
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function truncateUtf8(str, maxBytes) {
    const buf = Buffer.from(str, 'utf8');
    if (buf.length <= maxBytes) return str;
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString('utf8');
}

export function memoryVectorInput(description, data, maxChars) {
    if (typeof description !== 'string') throw new Error(`memory: description must be a string (got ${description === null ? 'null' : typeof description})`);
    const parts = [description];
    if (data) parts.push(serializeData(data));
    const combined = parts.join(' ');
    return combined.length > maxChars ? combined.slice(0, maxChars) : combined;
}

export function memoryToV2Doc(mem, { maxChars = 6000, principals = PRINCIPALS } = {}) {
    const dataStr = serializeData(mem.data);
    const input = memoryVectorInput(mem.description || '', mem.data, maxChars);
    const ts = mem.timestamp ? Math.floor(Date.parse(mem.timestamp) / 1000) : null;
    const validTs = Number.isFinite(ts) ? ts : null;
    return {
        id: mem._id,
        parent_id: mem._id,
        chunk_index: 0,
        kind: 'memory',
        title: mem.description || '',
        name: `#${mem.id}`,
        path: `memory/${mem.id}`,
        headings: '',
        categories: mem.category ? [mem.category] : [],
        tags: [],
        body: dataStr ? `${mem.description || ''}\n${dataStr}` : (mem.description || ''),
        folder: null,
        ext: null,
        mime: null,
        status: 'active',
        created_at: validTs,
        updated_at: validTs,
        acl: principals,
        metadata: {
            memId: mem.id,
            category: mem.category || 'notes',
            confidence: mem.confidence ?? 0.5,
        },
        excerpt: truncateUtf8(input, MAX_EXCERPT_BYTES),
    };
}

function embedText(gateway, description, data, maxChars, opts) {
    return gateway.embed(memoryVectorInput(description, data, maxChars), { ...opts, path: EMBED_PATH });
}

function resolveRecallOptions(search, query = null) {
    return resolveSearchOptions({
        query,
        overrides: search,
        hybrid: HYBRID,
        rerank: RERANK,
        rerankerAvailable: RERANKER_LOADED,
        diversityField: 'parent_id',
    });
}

async function upsertAndAttachMemory(gateway, mem, { background = true } = {}) {
    if (!VDB_CLIENT) return;
    const maxChars = CONFIG.maxMemoryChars || 6000;
    const v2Doc = memoryToV2Doc(mem, { maxChars, principals: PRINCIPALS });
    const { content_hash } = documentHashes(v2Doc);

    // Upsert into nvdb serve immediately so lexical recall sees it at once.
    await VDB_CLIENT.upsert('memory', [v2Doc], { commit: true });

    // Detached embedding attach (compare-and-set by content_hash).
    embedText(gateway, mem.description, mem.data, maxChars, { background }).then(async vector => {
        try {
            await VDB_CLIENT.attachVectors('memory', [{
                id: mem._id,
                content_hash,
                model_version: MODEL_VERSION,
                vector,
            }]);
            await DB.patch(mem._id, [
                { op: 'set', path: 'embedStatus', value: 'embedded' },
                { op: 'set', path: 'embedError', value: null },
            ]);
        } catch (err) {
            if (err.status === 409 && err.code === 'stale_vector_cas') {
                logger.warn(`[Memory] stale vector CAS for #${mem.id} — superseded by newer edit`, null, 'Memory');
                return;
            }
            throw err;
        }
    }).catch(err => {
        logger.warn(`[Memory] embed of #${mem.id} failed: ${err.message || 'embed failed'} — left pending for self-heal`, null, 'Memory');
        DB.patch(mem._id, [{ op: 'set', path: 'embedError', value: err.message || 'embed failed' }])
            .catch(patchErr => logger.warn(`[Memory] could not record embed error for #${mem.id}: ${patchErr.message}`, null, 'Memory'));
    });
}

export async function syncMemories() {
    if (!VDB_CLIENT || !DB) throw new Error('memory.syncMemories: memory agent or VDB client not initialized');
    const maxChars = CONFIG.maxMemoryChars || 6000;
    const fpRes = await VDB_CLIENT.fingerprints('memory');
    const existing = new Map();
    for (const entry of fpRes.entries || []) existing.set(entry.id, entry);

    const activeMems = await iterMemoryDocs();
    const liveIds = new Set();
    const toUpsert = [];
    let unchanged = 0;

    for (const mem of activeMems) {
        const doc = memoryToV2Doc(mem, { maxChars, principals: PRINCIPALS });
        liveIds.add(doc.id);
        const { envelope_hash } = documentHashes(doc);
        const prev = existing.get(doc.id);
        if (prev && prev.envelope_hash === envelope_hash) {
            unchanged++;
        } else {
            toUpsert.push(doc);
        }
    }

    const toDelete = [];
    for (const id of existing.keys()) {
        if (!liveIds.has(id)) toDelete.push(id);
    }

    for (let i = 0; i < toUpsert.length; i += UPSERT_BATCH_SIZE) {
        await VDB_CLIENT.upsert('memory', toUpsert.slice(i, i + UPSERT_BATCH_SIZE), { commit: false });
    }
    for (let i = 0; i < toDelete.length; i += UPSERT_BATCH_SIZE) {
        await VDB_CLIENT.deleteIds('memory', toDelete.slice(i, i + UPSERT_BATCH_SIZE), { commit: false });
    }
    if (toUpsert.length > 0 || toDelete.length > 0) {
        await VDB_CLIENT.commit('memory');
    }

    return { total: activeMems.length, upserted: toUpsert.length, deleted: toDelete.length, unchanged };
}

export async function memoryIntegrityCheck({ checkVectors = false } = {}) {
    if (!VDB_CLIENT || !DB) throw new Error('memory.memoryIntegrityCheck: memory agent or VDB client not initialized');
    const maxChars = CONFIG.maxMemoryChars || 6000;
    const expected = [];
    for (const mem of await iterMemoryDocs()) {
        const doc = memoryToV2Doc(mem, { maxChars, principals: PRINCIPALS });
        const { content_hash, envelope_hash } = documentHashes(doc);
        expected.push({ id: doc.id, content_hash, envelope_hash });
    }
    return VDB_CLIENT.integrityCheck('memory', expected, { checkVectors });
}

// Tool name prefix for validation errors — keeps messages consistent.
const TOOL = 'memory';

// Find the nDB _id for a memory by its integer id field (indexed `id`).
async function findNdbIdByMemId(memId) {
    const { results } = await DB.find('id', memId);
    return results.length === 0 ? null : results[0]._id;
}

// Every live memory document (`mem_*`); the `_meta` doc is filtered out.
async function iterMemoryDocs() {
    const docs = await DB.allSnapshotDocs();
    return docs.filter(d => typeof d._id === 'string' && d._id.startsWith('mem_'));
}

// Read the _meta document id (created on first run).
async function getMetaDoc() {
    if (MEM_META_ID) {
        const doc = await DB.get(MEM_META_ID);
        if (!doc) throw new Error(`memory _meta document ${MEM_META_ID} disappeared from db "${DB_NAME}"`);
        return doc;
    }
    const { results } = await DB.query({
        filter: { id: { $exists: false } },
        fields: ['_id', 'nextId'],
        limit: 1000,
    });
    const meta = results.find(d => typeof d._id === 'string' && d._id.startsWith('_meta'));
    if (!meta) throw new Error(`memory _meta document not found in db "${DB_NAME}"`);
    MEM_META_ID = meta._id;
    return meta;
}

async function incrementNextId() {
    const meta = await getMetaDoc();
    if (typeof meta.nextId !== 'number') {
        throw new Error(`memory _meta document ${meta._id} has no numeric nextId (got ${JSON.stringify(meta.nextId)})`);
    }
    await DB.patch(meta._id, [{ op: 'set', path: 'nextId', value: meta.nextId + 1 }]);
    return meta.nextId;
}

// ── Init / Shutdown ──────────────────────────────────────────────────

export async function init(context) {
    GATEWAY = context.gateway;
    CONFIG = context.config?.agents?.memory || {};

    // Connect to `ndb serve` — the memories DB is mounted by the service.
    NDB_URL = CONFIG.ndbUrl || context.config?.ndb?.serviceUrl;
    DB_NAME = CONFIG.dbName || context.config?.ndb?.dbs?.memories;
    if (!NDB_URL) throw new Error('memory.init: no ndb service URL — set config.ndb.serviceUrl (agents.memory.ndbUrl overrides)');
    if (!DB_NAME) throw new Error('memory.init: no memories database name — set config.ndb.dbs.memories (agents.memory.dbName overrides)');

    const client = createNdbClient(NDB_URL);
    const health = await client.health();
    if (!health?.ok) throw new Error(`memory.init: ndb serve at ${NDB_URL} reported unhealthy: ${JSON.stringify(health)}`);
    const mounted = health.dbs || [];
    if (!mounted.includes(DB_NAME)) {
        throw new Error(
            `memory.init: database "${DB_NAME}" is not mounted in ndb serve at ${NDB_URL} ` +
            `(mounted: ${mounted.length ? mounted.join(', ') : 'none'}) — start the service with that DB`
        );
    }
    DB = client.db(DB_NAME);

    // Idempotent in nDB: `created` reports whether the index was new.
    await DB.createIndex('id');
    await DB.createIndex('category');
    await DB.createIndex('embedStatus');

    // Get the VDB agent (owns the nvdb serve HTTP client)
    VDB_AGENT = context.agents?.get('vdb');
    if (VDB_AGENT?.enabled && VDB_AGENT.client) {
        VDB_CLIENT = VDB_AGENT.client;
        PRINCIPALS = VDB_AGENT.principals || PRINCIPALS;
        MODEL_VERSION = VDB_AGENT.modelVersion || MODEL_VERSION;
        EMBED_PATH = VDB_AGENT.embeddingPath || EMBED_PATH;
        FUZZY_EDITS = VDB_AGENT.fuzzyEdits ?? FUZZY_EDITS;
        RERANKER_LOADED = Boolean(VDB_AGENT.rerankerLoaded);
        HYBRID = VDB_AGENT.hybrid || HYBRID;
        RERANK = VDB_AGENT.rerank || RERANK;
        RELEVANCE_FLOOR = VDB_AGENT.relevanceFloor ?? RELEVANCE_FLOOR;

        const syncStats = await syncMemories();
        logger.info(
            `[Memory] Synced with nvdb serve: ${syncStats.total} total (${syncStats.upserted} upserted, ${syncStats.deleted} deleted, ${syncStats.unchanged} unchanged)`,
            null,
            'Memory'
        );
    } else {
        VDB_CLIENT = null;
        logger.warn('[Memory] VDB agent not available — recall will degrade to recency', null, 'Memory');
    }

    // Ensure the _meta doc exists before the first store.
    try {
        await getMetaDoc();
    } catch (err) {
        const store = await DB.stats();
        if (store.documents !== 0) throw err;
        const { id } = await DB.insert({ nextId: 1 }, { prefix: '_meta' });
        MEM_META_ID = id;
        logger.info(`[Memory] Created _meta document ${id} in db "${DB_NAME}"`, null, 'Memory');
    }

    const memCount = (await DB.query({ filter: { id: { $exists: true } }, limit: 1 })).total;
    logger.info(`[Memory] Initialized: ${memCount} memories in ndb serve db "${DB_NAME}" at ${NDB_URL}`, null, 'Memory');

    return {
        // Dreaming agent compatibility: async iter() over every memory doc.
        memories: {
            iter: () => iterMemoryDocs(),
            get: async (memId) => {
                const ndbId = await findNdbIdByMemId(memId);
                return ndbId ? await DB.get(ndbId) : null;
            },
            count: async () => (await DB.query({ filter: { id: { $exists: true } }, limit: 1 })).total,
        },
        syncMemories,
        integrityCheck: memoryIntegrityCheck,
    };
}

export async function shutdown() {
    if (DB) await DB.flush();
}

// ── Tool: memory_store ───────────────────────────────────────────────

export async function memory_store(args, context) {
    const { gateway } = context;
    requireFields(args, ['description'], `${TOOL}.store`);
    const description = args.description || args.text;
    const category = args.category || 'notes';
    const confidence = args.confidence ?? 0.5;
    const { data } = args;
    const now = new Date().toISOString();

    const memId = await incrementNextId();
    const doc = {
        id: memId,
        description,
        category,
        confidence: Math.max(0, Math.min(1, confidence)),
        timestamp: now,
        embedStatus: 'pending'
    };
    if (data) doc.data = data;

    const { id: ndbId } = await DB.insert(doc, { prefix: 'mem' });
    await DB.flush();

    const storedDoc = { _id: ndbId, ...doc };
    await upsertAndAttachMemory(gateway, storedDoc, { background: true });

    const totalCount = (await DB.query({ filter: { id: { $exists: true } }, limit: 1 })).total;

    return {
        content: [{ type: 'text', text: `✓ #${memId} [${category}] stored (${totalCount} memories total). Indexed in nvdb serve; embedding runs in background.` }]
    };
}

export { memory_store as memory_remember };

// ── Tool: memory_recall ──────────────────────────────────────────────

const SCORE_FLOOR = 0.35;

function formatRecall(ranked, limit) {
    const top = ranked.slice(0, limit);
    const also = ranked.slice(limit).filter(m => typeof m.score === 'number' && Number.isFinite(m.score) && m.score >= SCORE_FLOOR);
    if (!top.length) {
        return 'No memories found. This topic is new — consider storing insights with memory_store as you learn.';
    }
    const results = top.map(m => {
        const conf = m.confidence ?? 0.5;
        const hasData = m.data ? ' [has data]' : '';
        const lanes = [
            m.vectorRank != null ? `vec#${m.vectorRank}` : null,
            m.lexicalRank != null ? `lex#${m.lexicalRank}` : null,
        ].filter(Boolean).join('/');
        const laneTag = lanes ? ` (${lanes})` : '';
        return `[#${m.id}] [${m.category}] ${formatRelevance(m.score)}${laneTag} conf:${conf.toFixed(1)}${hasData}\n${m.description}`;
    }).join('\n\n');
    let summary = '';
    if (also.length > 0) {
        const lines = also.map(m =>
            `#${m.id} [${m.category}] ${formatRelevance(m.score)}`
        ).join('  ');
        summary = `\n\n--- also found ---\n${lines}`;
    }
    const header = also.length > 0
        ? `Found ${ranked.length} memories (showing top ${top.length} with details):`
        : `Found ${top.length} memories:`;
    return `${header}\n\n${results}${summary}`;
}

export async function memory_recall(args, context) {
    const { gateway, progress } = context;
    const { query, limit = 5, category, search = null } = args;
    const pr = createProgressReporter(progress);
    const options = resolveRecallOptions(search, query);
    const mode = describeSearchOptions(options);

    const maxChars = CONFIG.maxMemoryChars || 6000;
    const safeQuery = query.length > maxChars ? query.slice(0, maxChars) : query;

    if (!VDB_CLIENT) {
        const fallback = await DB.query({
            filter: category
                ? { id: { $exists: true }, category: { $eq: category } }
                : { id: { $exists: true } },
            sort: { field: 'id', dir: 'desc' },
            limit,
        });
        const recent = fallback.results;
        pr.done('Search complete');
        if (!recent.length) {
            return { content: [{ type: 'text', text: 'No memories found. This topic is new — consider storing insights with memory_store as you learn.' }] };
        }
        const results = recent.map(m => {
            const conf = m.confidence ?? 0.5;
            const hasData = m.data ? ' [has data]' : '';
            return `[#${m.id}] [${m.category}] conf:${conf.toFixed(1)}${hasData}\n${m.description}`;
        }).join('\n\n');
        return {
            content: [{ type: 'text', text: `⚠ Semantic search unavailable (nvdb serve not connected) — returning ${recent.length} most recent memories:\n\n${results}` }]
        };
    }

    let queryVector = null;
    let denseActive = options.dense;
    let embedNotice = '';
    const t0 = performance.now();
    let embedMs = null;
    if (options.dense) {
        pr.set('Embedding query...', 20, true);
        try {
            const formatted = VDB_AGENT?.formatQueryForEmbedding
                ? VDB_AGENT.formatQueryForEmbedding(safeQuery)
                : safeQuery;
            const embedStart = performance.now();
            queryVector = await gateway.embed(formatted, { path: EMBED_PATH });
            embedMs = performance.now() - embedStart;
        } catch (err) {
            const embedError = err.message || String(err);
            logger.warn(`[Memory] recall query embed failed: ${embedError} — running lexical-only`, null, 'Memory');
            if (!options.lexical) {
                throw new Error(`memory_recall: dense-only requested but query embedding failed: ${embedError}`);
            }
            denseActive = false;
            embedNotice = `⚠ Dense embed failed (${embedError}) — lexical lane only\n`;
        }
    }

    pr.set('Searching memory index...', 50);
    const effectiveShortlist = search?.shortlist !== undefined
        ? options.shortlist
        : Math.max(limit, options.shortlist);
    const fetchK = Math.max(limit * 3, options.rerank ? effectiveShortlist : limit, 20);
    const hybridQuery = {
        lexical: {
            text: safeQuery,
            top_k: fetchK,
            principals: PRINCIPALS,
            fuzzy_edits: FUZZY_EDITS,
            explain: false,
            group_by_parent: options.diversity ? { max_per_parent: options.maxPerDocument } : null,
            filters: category
                ? { promoted: [{ field: 'category', op: 'eq', value: category }] }
                : {},
        },
        query_vector: queryVector,
        dense: denseActive,
        lexical_enabled: options.lexical,
        candidate_k: options.candidateK,
        rrf_k: options.rrfK,
        lexical_weight: options.lexicalWeight,
        vector_weight: options.vectorWeight,
    };

    const searchStart = performance.now();
    const res = await VDB_CLIENT.hybridSearch('memory', hybridQuery);
    const searchMs = Number.isFinite(res.took_ms) ? res.took_ms : performance.now() - searchStart;
    const rawHits = res.hits || [];
    let rerankMs = null;
    const timingLine = () => formatSearchTiming({ totalMs: performance.now() - t0, embedMs, searchMs, rerankMs });

    // Hydrate from the authoritative store in ONE mget round-trip; drop
    // tombstoned/missing docs before Level-2.
    const liveHits = [];
    const docsById = new Map();
    const textsById = {};
    const hitIds = [...new Set(rawHits.map(h => h.hit.id))];
    const { docs: hitDocs } = await DB.mget(hitIds);
    for (const h of rawHits) {
        const doc = hitDocs[h.hit.id];
        if (!doc || !doc._id?.startsWith('mem_')) continue;
        if (category && doc.category !== category) continue;
        liveHits.push(h);
        docsById.set(h.hit.id, doc);
        textsById[h.hit.id] = memoryVectorInput(doc.description || '', doc.data, maxChars);
    }

    if (liveHits.length === 0) {
        pr.done('Search complete');
        return { content: [{ type: 'text', text: `mode: ${mode} | ${timingLine()}\n${embedNotice}No memories found. This topic is new — consider storing insights with memory_store as you learn.` }] };
    }

    let ranked = [];
    if (options.rerank) {
        pr.set('Reranking results...', 75);
        const rerankStart = performance.now();
        const l2 = await VDB_CLIENT.level2('memory', {
            query_text: safeQuery,
            principals: PRINCIPALS,
            hits: liveHits,
            texts: textsById,
            shortlist: effectiveShortlist,
            rerank_weight: options.rerankWeight,
            relevance_floor: RELEVANCE_FLOOR,
        });
        rerankMs = Number.isFinite(l2.took_ms) ? l2.took_ms : performance.now() - rerankStart;
        for (const item of l2.hits || []) {
            const h = item.hybrid;
            const doc = docsById.get(h.hit.id);
            if (!doc) continue;
            ranked.push({
                ...doc,
                score: item.rerank_score ?? null,
                rerankScore: item.rerank_score ?? null,
                rrfScore: h.rrf_score,
                lexicalRank: h.lexical_rank ?? null,
                vectorRank: h.vector_rank ?? null,
            });
        }
        if (l2.rejected) {
            const best = typeof l2.best_rerank_score === 'number' ? l2.best_rerank_score : 0;
            const lines = ranked.slice(0, 5).map((m, i) =>
                `  ${i + 1}. [#${m.id}] [${m.category}] relevance ${formatRelevance(m.rerankScore)}`
            ).join('\n');
            pr.done('No relevant memories');
            logger.info(`[Memory] rejected: best rerank ${best.toFixed(4)} < floor ${RELEVANCE_FLOOR} for "${safeQuery}"`, null, 'Memory');
            return {
                content: [{
                    type: 'text',
                    text: `mode: ${mode} | ${timingLine()}\n${embedNotice}No relevant memories: the best cross-encoder score is ${formatRelevance(best)}, below the ${(RELEVANCE_FLOOR * 100).toFixed(1)}% relevance floor.\n`
                        + `The candidates below are low-relevance evidence, not answers:\n${lines}`
                }]
            };
        }
    } else {
        for (const h of liveHits) {
            const doc = docsById.get(h.hit.id);
            if (!doc) continue;
            ranked.push({
                ...doc,
                score: null,
                rerankScore: null,
                rrfScore: h.rrf_score,
                lexicalRank: h.lexical_rank ?? null,
                vectorRank: h.vector_rank ?? null,
            });
        }
    }

    pr.done('Search complete');
    return {
        content: [{ type: 'text', text: `mode: ${mode} | ${timingLine()}\n${embedNotice}${formatRecall(ranked, limit)}` }]
    };
}

// ── Tool: memory_get ─────────────────────────────────────────────────

export async function memory_get(args, context) {
    const id = requireId(args.id, 'id', `${TOOL}.get`);
    const ndbId = await findNdbIdByMemId(id);

    if (!ndbId) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }

    const memory = await DB.get(ndbId);
    const conf = memory.confidence ?? 0.5;
    let result = `[#${memory.id}] [${memory.category}] conf:${conf.toFixed(1)}\n`;
    result += `Description: ${memory.description}\n`;
    if (memory.data) result += `Data: ${serializeData(memory.data)}\n`;
    result += `Created: ${memory.timestamp}`;

    return { content: [{ type: 'text', text: result }] };
}

// ── Tool: memory_forget ──────────────────────────────────────────────

export async function memory_forget(args, context) {
    const id = requireId(args.id, 'id', `${TOOL}.forget`);
    const ndbId = await findNdbIdByMemId(id);

    if (!ndbId) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }

    await DB.delete(ndbId);
    await DB.flush();

    // Also remove from nvdb serve
    if (VDB_CLIENT) {
        await VDB_CLIENT.deleteIds('memory', [ndbId], { commit: true });
    }

    return { content: [{ type: 'text', text: `✓ Forgot memory #${id}.` }] };
}

// ── Tool: memory_list ────────────────────────────────────────────────

export async function memory_list(args, context) {
    const { category, limit, sort } = args;

    // Fail-fast arg validation
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) {
        throw new Error(`memory.list: limit must be a positive integer, got: ${limit}`);
    }
    if (sort !== undefined && sort !== 'newest' && sort !== 'oldest') {
        throw new Error(`memory.list: sort must be "newest" or "oldest", got: ${sort}`);
    }

    // Memory IDs are monotonic (getNextId) — ID order IS chronological order.
    // Default newest-first: the dominant use is "what happened recently"
    // (session-start ritual), and full-store dumps don't care about order.
    const order = sort ?? 'newest';
    const filter = category
        ? { id: { $exists: true }, category: { $eq: category } }
        : { id: { $exists: true } };
    const sortSpec = { field: 'id', dir: order === 'oldest' ? 'asc' : 'desc' };
    const fields = ['_id', 'id', 'category', 'confidence', 'description', 'data'];

    const page = await DB.query({ filter, sort: sortSpec, offset: 0, limit: limit ?? MEMORY_PAGE_SIZE, fields });
    const total = page.total;
    if (!total) {
        return { content: [{ type: 'text', text: 'No memories found. Memory is empty or no match for this category.' }] };
    }

    // No limit: page through everything so the full-list behavior is preserved
    // without one unbounded response.
    let shown = page.results;
    while (limit === undefined && shown.length < total) {
        const next = await DB.query({ filter, sort: sortSpec, offset: shown.length, limit: MEMORY_PAGE_SIZE, fields });
        if (next.results.length === 0) {
            throw new Error(`memory.list: query returned an empty page at offset ${shown.length} of ${total}`);
        }
        shown = shown.concat(next.results);
    }

    const scope = category ? `category "${category}"` : 'all categories';
    const truncated = shown.length < total
        ? `\n\n(${shown.length} of ${total} shown — narrow with category, or raise limit)`
        : '';
    const header = `${shown.length} memories (${scope}, ${order}-first):`;

    const formatted = shown.map(m => {
        const conf = m.confidence ?? 0.5;
        const hasData = m.data ? ' [has data]' : '';
        return `[#${m.id}] [${m.category}] conf:${conf.toFixed(1)}${hasData} - ${m.description}`;
    }).join('\n');

    return {
        content: [{ type: 'text', text: `${header}\n\n${formatted}${truncated}` }]
    };
}

// ── Tool: memory_update ──────────────────────────────────────────────

export async function memory_update(args, context) {
    const { gateway } = context;
    const id = requireId(args.id, 'id', `${TOOL}.update`);
    const { description, category, confidence, data } = args;

    const ndbId = await findNdbIdByMemId(id);
    if (!ndbId) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }

    const memory = await DB.get(ndbId);
    if (!memory) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }
    const textChanged = (description && description !== memory.description) || (data !== undefined && data !== memory.data);

    // One atomic PATCH: nDB applies the whole batch as a single journal record,
    // or refuses it entirely if any path fails to resolve.
    const ops = [];
    if (description) ops.push({ op: 'set', path: 'description', value: description });
    if (category) ops.push({ op: 'set', path: 'category', value: category });
    if (confidence !== undefined) ops.push({ op: 'set', path: 'confidence', value: Math.max(0, Math.min(1, confidence)) });
    if (data !== undefined) {
        if (data === null) {
            // `remove` on a missing path aborts the batch — only emit it when the key exists.
            if ('data' in memory) ops.push({ op: 'remove', path: 'data' });
        } else {
            ops.push({ op: 'set', path: 'data', value: data });
        }
    }
    ops.push({ op: 'set', path: 'timestamp', value: new Date().toISOString() });
    if (textChanged) ops.push({ op: 'set', path: 'embedStatus', value: 'pending' });

    const { doc: updated } = await DB.patch(ndbId, ops);
    await DB.flush();
    if (VDB_CLIENT && updated) {
        if (textChanged) {
            await upsertAndAttachMemory(gateway, updated, { background: true });
        } else {
            // Metadata/category-only edit: upsert keeps existing content_hash vector intact!
            const maxChars = CONFIG.maxMemoryChars || 6000;
            await VDB_CLIENT.upsert('memory', [memoryToV2Doc(updated, { maxChars, principals: PRINCIPALS })], { commit: true });
        }
    }

    return {
        content: [{ type: 'text', text: `Updated #${id}. Use memory_recall to verify.` }]
    };
}

// ── Self-heal: re-embed memories missing vectors in nvdb serve ───────

let lastHealAt = 0;

async function findPendingMemories() {
    const { results } = await DB.find('embedStatus', 'pending');
    return results.filter(d => typeof d._id === 'string' && d._id.startsWith('mem_'));
}

async function memoryEmbedHeal(context, batchLimit = 10, onProgress = null) {
    const { gateway } = context;
    if (!gateway) return { healed: 0, remaining: 0, skipped: 'no gateway' };
    if (!VDB_CLIENT) return { healed: 0, remaining: 0, skipped: 'no nvdb serve client' };

    const pendingRes = await VDB_CLIENT.pendingEmbeddings('memory', batchLimit);
    const pending = pendingRes.pending || [];
    if (pending.length === 0) return { healed: 0, remaining: 0 };

    const maxChars = CONFIG.maxMemoryChars || 6000;
    let healed = 0;
    for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        const m = await DB.get(item.id);
        if (!m || !m._id?.startsWith('mem_')) continue;
        try {
            const vector = await embedText(gateway, m.description, m.data, maxChars, { background: true });
            await VDB_CLIENT.attachVectors('memory', [{
                id: item.id,
                content_hash: item.content_hash,
                model_version: MODEL_VERSION,
                vector,
            }]);
            await DB.patch(m._id, [
                { op: 'set', path: 'embedStatus', value: 'embedded' },
                { op: 'set', path: 'embedError', value: null },
            ]);
            healed++;
        } catch (err) {
            if (err.status === 409 && err.code === 'stale_vector_cas') {
                logger.warn(`[Memory] heal stale CAS for #${m.id} — skipping`, null, 'Memory');
                continue;
            }
            logger.warn(`[Memory] heal of #${m.id} failed: ${err.message || 'embed failed'} — left pending`, null, 'Memory');
            await DB.patch(m._id, [{ op: 'set', path: 'embedError', value: err.message || 'embed failed' }]);
            break;
        }
        if (onProgress) onProgress(i + 1, pending.length, `Re-embedding memory #${m.id} (${i + 1}/${pending.length})`);
    }
    if (healed > 0) await DB.flush();
    const after = await VDB_CLIENT.pendingEmbeddings('memory', 1);
    return { healed, remaining: after.count > 0 ? pending.length - healed : 0 };
}

export async function memory_embed_heal(args, context) {
    const pr = createProgressReporter(context?.progress);
    const result = await memoryEmbedHeal(context, args?.batchLimit || 50, (done, total, msg) => pr.step(done, total, msg));
    pr.done(`Embed heal finished: ${result.healed} re-embedded, ${result.remaining} still pending`);
    return {
        content: [{ type: 'text', text: `Embed heal: ${result.healed} re-embedded, ${result.remaining} still pending${result.skipped ? ` (${result.skipped})` : ''}.` }]
    };
}

// ── Tool: memory_overview ────────────────────────────────────────────

function momentumArrow(momentum) {
    if (!momentum) return '';
    const delta = typeof momentum === 'object' ? momentum.delta : momentum;
    if (delta > 1) return ' ↗';
    if (delta < -1) return ' ↘';
    return '';
}

function nodeLabel(n) {
    if (n.state === 'title') return n.title || `#${n.id}`;
    return n.summary || n.title || `#${n.id}`;
}

// Summary-tier bounds. The summary is the cheap orientation pass — it must stay
// small enough to avoid client pagination. Deep detail is behind recall/full.
// (Issue #14: 242KB summary at 1177 nodes / 2036 bridges was defeating the purpose.)
const SUMMARY = {
    clusterDescChars: 160, // cluster teaser length — descs otherwise read like node summaries
    maxClusters: 20,       // max cluster lines in summary (by hub score desc)
    maxBridges: 20,        // max bridge lines, then a …and N more pointer
};

function truncate(s, max) {
    if (!s) return s;
    return s.length <= max ? s : s.slice(0, max).trimEnd() + '…';
}

export async function memory_overview(args, context) {
    const { format = 'summary' } = args;
    const mapPath = join(__dirname, '..', '..', '..', 'data', 'dream_map.json');

    // Self-heal trigger: session start is the natural cadence. Fire in the
    // background (rate-limited to 1 pass/min, 10 embeddings per pass).
    const pendingEmbedCount = (await findPendingMemories()).length;
    if (pendingEmbedCount > 0 && Date.now() - lastHealAt > 60000) {
        lastHealAt = Date.now();
        memoryEmbedHeal(context, 10).catch(() => {});
    }

    if (!existsSync(mapPath)) {
        return { content: [{ type: 'text', text: 'No knowledge map available yet. It is generated automatically every 15 minutes, or run dream_generate to create one now.' }] };
    }

    const map = JSON.parse(readFileSync(mapPath, 'utf-8'));
    const lines = [`[Your Knowledge — generated ${map.meta?.generated_at || 'unknown'}]`];
    const memCount = (await DB.query({ filter: { id: { $exists: true } }, limit: 1 })).total;
    const nodeCount = map.nodes?.length || 0;

    if (pendingEmbedCount > 0) {
        lines.push(`⚠ ${pendingEmbedCount} ${pendingEmbedCount === 1 ? 'memory' : 'memories'} pending re-embed (stored during provider outage) — self-heal running in background.\n`);
    }

    // TL;DR
    const tldrParts = [];
    if (map.clusters?.length) {
        const topClusters = [...map.clusters].sort((a, b) => {
            const aScore = map.nodes?.find(n => n.id === a.hub_id)?.score || 0;
            const bScore = map.nodes?.find(n => n.id === b.hub_id)?.score || 0;
            return bScore - aScore;
        }).slice(0, 3);
        tldrParts.push(`focused on ${topClusters.map(c => c.name).join(', ')}`);
    }
    if (map.bridges?.length) tldrParts.push(`${map.bridges.length} active bridges between topics`);
    if (tldrParts.length) lines.push(`**TL;DR**: You're ${tldrParts.join(' with ')}.\n`);

    // Dreamer self-audit
    if (map.meta?.dreamer_reflection) {
        lines.push(`> ${map.meta.dreamer_reflection}\n`);
    }

    // Delta
    const delta = map.meta?.delta;
    if (delta) {
        const parts = [];
        if (delta.new_connections?.length) parts.push(`${delta.new_connections.length} new connections`);
        if (delta.surging_nodes?.length) parts.push(`${delta.surging_nodes.length} surging ↗`);
        if (delta.decayed_nodes?.length) {
            const fadingLabels = delta.decayed_nodes.map(id => {
                const n = map.nodes?.find(n => n.id === id);
                return `#${id}${n ? ` ${nodeLabel(n)}` : ''}`;
            });
            parts.push(`${delta.decayed_nodes.length} fading ↘ (${fadingLabels.join(', ')})`);
        }
        if (delta.promoted?.length) parts.push(`${delta.promoted.length} promoted`);
        if (delta.demoted?.length) parts.push(`${delta.demoted.length} demoted`);
        if (delta.compressed_to_summary?.length) parts.push(`${delta.compressed_to_summary.length} compressed to summary`);
        if (delta.compressed_to_title?.length) parts.push(`${delta.compressed_to_title.length} compressed to title`);
        if (parts.length) lines.push(`Since last dream: ${parts.join(', ')}\n`);
    }

    lines.push(`${nodeCount} nodes covering ${memCount} memories\n`);

    // Lighter tier: clusters only (names + hub + counts). All a session start
    // needs to pick a recall query. No bridges, no top-nodes, no node detail.
    if (format === 'clusters') {
        if (map.clusters?.length) {
            lines.push('## Clusters');
            for (const c of map.clusters) {
                if (c.id === 'c_between') continue; // covered by The Between via recall
                const cNodes = map.nodes?.filter(n => n.cluster_id === c.id) || [];
                lines.push(`- **${c.name}** (${cNodes.length} nodes) [hub: #${c.hub_id}]`);
            }
            lines.push('');
        }
        lines.push(`Use format: 'summary' for bridges and top nodes, 'full' for all ${nodeCount} nodes with details.`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // The Between — dedicated second-person section (spec: the section being
    // *addressed to the instance* is what makes the region inherited, not
    // merely listed). Top-N capped; recall is the paid path for detail.
    const betweenNodes = (map.nodes || []).filter(n => n.category === 'the-between');
    if (betweenNodes.length > 0) {
        const top = [...betweenNodes].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
        lines.push('## The Between — your side (the partner\'s log)');
        for (const n of top) {
            lines.push(`- #${n.id} ${n.state === 'title' ? '(title-only — recall for detail)' : n.summary}`);
        }
        if (betweenNodes.length > top.length) {
            lines.push(`…and ${betweenNodes.length - top.length} more — use memory_recall (category: the-between) for the full log.`);
        }
        lines.push('');
    }

    // Clusters — descs truncated to teaser length, capped by hub score.
    if (map.clusters?.length) {
        // The between has its own section above — don't double-list it.
        const listedClusters = map.clusters.filter(c => c.id !== 'c_between');
        const scored = listedClusters.map(c => ({
            c,
            score: map.nodes?.find(n => n.id === c.hub_id)?.score || 0,
        })).sort((a, b) => b.score - a.score);
        for (const { c } of scored.slice(0, SUMMARY.maxClusters)) {
            const cNodes = map.nodes?.filter(n => n.cluster_id === c.id) || [];
            lines.push(`- **${c.name}** (${cNodes.length} nodes): ${truncate(c.desc, SUMMARY.clusterDescChars)} [hub: #${c.hub_id}]`);
        }
        if (scored.length > SUMMARY.maxClusters) {
            lines.push(`…and ${scored.length - SUMMARY.maxClusters} more clusters — use format: 'clusters' or 'full' to list them.`);
        }
        lines.push('');
    }

    // Bridges — capped; recall is the paid path for detail. Same elision pattern
    // as The Between. Sorted by the endpoint nodes' score (bridges carry no weight).
    if (map.bridges?.length) {
        lines.push('## Cross-Cluster Bridges');
        const scoreOf = (id) => map.nodes?.find(n => n.id === id)?.score || 0;
        const scored = [...map.bridges]
            .map(b => ({ b, s: Math.max(scoreOf(b.from_id), scoreOf(b.to_id)) }))
            .sort((a, b) => b.s - a.s);
        for (const { b } of scored.slice(0, SUMMARY.maxBridges)) {
            lines.push(`- #${b.from_id} ↔ #${b.to_id}: ${b.reason}`);
        }
        if (scored.length > SUMMARY.maxBridges) {
            lines.push(`…and ${scored.length - SUMMARY.maxBridges} more — use memory_recall to explore specific topics.`);
        }
        lines.push('');
    }

    // Wildcards
    if (map.wildcards?.length) {
        lines.push('## Wildcards');
        for (const w of map.wildcards) {
            const n = map.nodes?.find(n => n.id === w.id);
            lines.push(`- #${w.id} [${n?.category || '?'}] ${w.summary || nodeLabel(n)} (${w.reason})`);
        }
        lines.push('');
    }

    // Nodes
    if (map.nodes?.length) {
        if (format === 'full') {
            lines.push('## All Nodes');
            const byCluster = {};
            const unclustered = [];
            for (const n of map.nodes) {
                if (n.cluster_id) (byCluster[n.cluster_id] ??= []).push(n);
                else unclustered.push(n);
            }
            for (const [cid, nodes] of Object.entries(byCluster)) {
                const cluster = map.clusters?.find(c => c.id === cid);
                lines.push(`[${cluster?.name || cid}]`);
                for (const n of nodes) {
                    const bridge = n.is_bridge ? ' ★bridge' : '';
                    const arrow = momentumArrow(n.momentum);
                    if (n.state === 'title') {
                        lines.push(`  #${n.id} [${n.category}] (title-only)${bridge}${arrow}`);
                    } else {
                        lines.push(`  #${n.id} [${n.category}] ${nodeLabel(n)} (score:${n.score?.toFixed(2)})${bridge}${arrow}`);
                    }
                }
            }
            if (unclustered.length) {
                lines.push('[unclustered]');
                for (const n of unclustered) {
                    lines.push(`  #${n.id} [${n.category}] ${nodeLabel(n)}`);
                }
            }
        } else {
            lines.push('## Top Nodes by Cluster');
            const byCluster = {};
            for (const n of map.nodes) {
                if (n.cluster_id) (byCluster[n.cluster_id] ??= []).push(n);
            }
            for (const [cid, nodes] of Object.entries(byCluster)) {
                if (cid === 'c_between') continue; // dedicated The-Between section above
                const cluster = map.clusters?.find(c => c.id === cid);
                const top = nodes.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
                lines.push(`[${cluster?.name || cid}]`);
                for (const n of top) {
                    const arrow = momentumArrow(n.momentum);
                    // Summary tier: truncate the node's prose — full text lives in
                    // the 'full' tier and memory_recall. Prevents the 5×N nodes
                    // section from re-bloating the summary past pagination.
                    lines.push(`  #${n.id} [${n.category}] ${truncate(nodeLabel(n), SUMMARY.clusterDescChars)} (score:${n.score?.toFixed(2)})${arrow}`);
                }
            }
            lines.push('');
            lines.push(`Use format: 'full' to see all ${nodeCount} nodes with details.`);
        }
    }

    // Recall directive
    if (map.meta?.coverage_cutoff) {
        lines.push(`\n[Memories after ${map.meta.coverage_cutoff} are not yet mapped — use memory_recall to find recent memories.]`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
}
