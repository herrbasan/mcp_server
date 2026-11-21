import path from 'node:path';
import { getLogger } from '../../utils/logger.js';
import { createProgressReporter } from '../../utils/progress-reporter.js';
import { createV2Client } from './v2-client.js';
import { createStorageConnector } from './storage-connector.js';
import { resolveSearchOptions, describeSearchOptions } from './search-options.js';
import { resolveRelevanceFloor, assessRelevance } from './relevance.js';

const logger = getLogger();

const DEFAULT_QUERY_INSTRUCT = 'Given a web search query, retrieve relevant passages that answer the query';

const DEFAULTS = {
    enabled: true,
    serviceUrl: 'http://127.0.0.1:3510',
    principals: ['default'],
    modelVersion: 'qwen3-embedding-4b',
    embeddingDim: 2560,
    embeddingPath: '/v1/embeddings',
    queryInstruct: DEFAULT_QUERY_INSTRUCT,
    fuzzyEdits: 1,
    relevanceFloor: 0.02,
    autoSync: true,
    scanIntervalMinutes: 5,
    maxBatchTexts: 4,
    chunkMaxTokens: 1024,
    chunkOverlapTokens: 128,
    chunkTokCharsRatio: 2.5,
    maxFileSizeBytes: 10 * 1024 * 1024,
    textExtensions: ['.md', '.txt', '.json', '.js', '.mjs', '.css', '.html', '.htm', '.log', '.yaml', '.yml', '.xml', '.csv', '.tsv', '.sql'],
    ignore: ['forge', 'temp', '_trash', '.backups', 'charts', 'prints', 'item.json', 'meta.json'],
    hybrid: {
        enabled: true,
        rrfK: 60,
        candidateK: 200,
        lexicalWeight: 1.0,
        vectorWeight: 0.3,
        diversityField: 'parent_id',
        maxPerDocument: 2,
    },
    rerank: {
        enabled: true,
        shortlist: 20,
        weight: 0.2,
    },
};

let CFG = { ...DEFAULTS };
let CLIENT = null;
let GATEWAY = null;
let STORAGE_ROOT = null;
let STORAGE_CONNECTOR = null;
let RERANKER_LOADED = false;
let RELEVANCE_FLOOR = DEFAULTS.relevanceFloor;
let SYNC_TIMER = null;
let SYNC_IN_PROGRESS = false;
let LAST_SYNC = null;

export function formatQueryForEmbedding(query) {
    if (typeof query !== 'string') throw new TypeError(`query must be a string (got ${typeof query})`);
    const instruct = CFG.queryInstruct;
    if (!instruct) return query;
    return `Instruct: ${instruct}\nQuery: ${query}`;
}

export function normalizeExtension(ext) {
    if (ext === null || ext === undefined) return null;
    if (typeof ext !== 'string') throw new TypeError(`extension must be a string (got ${typeof ext})`);
    const trimmed = ext.trim();
    if (!trimmed) throw new Error('extension must not be empty');
    const clean = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
    if (!clean || !/^[a-zA-Z0-9]+$/.test(clean)) {
        throw new Error(`Invalid extension "${ext}" — expected alphanumeric extension like "md" or ".md"`);
    }
    return clean.toLowerCase();
}

export function normalizeFolder(folder) {
    if (folder === null || folder === undefined) return null;
    if (typeof folder !== 'string') throw new TypeError(`folder must be a string (got ${typeof folder})`);
    const clean = folder.trim().replace(/^[/\\]+|[/\\]+$/g, '');
    if (!clean) throw new Error('folder must not be empty');
    return clean;
}

export function relevanceFloor() {
    return RELEVANCE_FLOOR;
}

export function searchRequestInfo(search = null) {
    const options = resolveSearchOptions({
        overrides: search,
        hybrid: CFG.hybrid,
        rerank: CFG.rerank,
        rerankerAvailable: RERANKER_LOADED,
        diversityField: CFG.hybrid.diversityField,
    });
    return {
        options,
        mode: describeSearchOptions(options),
        rerankActive: options.rerank,
        floor: RELEVANCE_FLOOR,
    };
}

export function describeSearchRequest(search = null) {
    return searchRequestInfo(search).mode;
}

export function describeRejection(assessment, rows, label = 'matches') {
    const best = typeof assessment?.best === 'number' ? assessment.best.toFixed(4) : '0.0000';
    const floor = typeof assessment?.floor === 'number' ? assessment.floor.toFixed(4) : RELEVANCE_FLOOR.toFixed(4);
    return `No relevant ${label} (best rerank score ${best} < floor ${floor}; ${rows.length} candidate(s) rejected).`;
}

function buildCollectionConfig(name) {
    const base = {
        store_excerpt: true,
        vector_lane: {
            dim: CFG.embeddingDim,
            distance: 'Cosine',
            model_version: CFG.modelVersion,
            flat_search_cutoff: 50000,
        },
    };
    if (name === 'memory') {
        base.promoted_fields = [{ name: 'category', field_type: 'String' }];
    }
    return base;
}

async function runStorageSync({ onProgress } = {}) {
    if (!STORAGE_CONNECTOR) throw new Error('VDB storage connector is not initialized');
    if (SYNC_IN_PROGRESS) return { skipped: true, reason: 'sync already running' };
    SYNC_IN_PROGRESS = true;
    try {
        const syncStats = await STORAGE_CONNECTOR.sync({ onProgress });
        const embedStats = await STORAGE_CONNECTOR.drainPendingEmbeddings({
            embedBatch: (texts, opts) => GATEWAY.embedBatch(texts, opts),
            embeddingPath: CFG.embeddingPath,
            batchSize: CFG.maxBatchTexts,
            onProgress,
        });
        LAST_SYNC = {
            at: new Date().toISOString(),
            ...syncStats,
            ...embedStats,
        };
        return LAST_SYNC;
    } finally {
        SYNC_IN_PROGRESS = false;
    }
}

export async function init(context) {
    const userCfg = context.config?.agents?.vdb || {};
    CFG = {
        ...DEFAULTS,
        ...userCfg,
        hybrid: { ...DEFAULTS.hybrid, ...(userCfg.hybrid || {}) },
        rerank: { ...DEFAULTS.rerank, ...(userCfg.rerank || {}) },
    };

    if (!CFG.enabled) {
        logger.info('[VDB] Disabled by config', null, 'VDB');
        return { enabled: false };
    }

    GATEWAY = context.gateway;
    if (!GATEWAY) throw new Error('[VDB] gateway client is required');

    STORAGE_ROOT = context.config?.agents?.storage?.root
        ? path.resolve(context.config.agents.storage.root)
        : null;

    RELEVANCE_FLOOR = resolveRelevanceFloor(CFG.relevanceFloor);

    CLIENT = createV2Client(CFG.serviceUrl);
    const health = await CLIENT.health();
    if (!health?.ok) {
        throw new Error(`[VDB] nvdb serve unhealthy at ${CFG.serviceUrl}: ${JSON.stringify(health)}`);
    }

    RERANKER_LOADED = Boolean(health.reranker_loaded);
    if (CFG.rerank.enabled && !RERANKER_LOADED) {
        throw new Error(
            `[VDB] agents.vdb.rerank.enabled is true, but nvdb serve at ${CFG.serviceUrl} has reranker_loaded=false. Start nvdb serve with --reranker-model.`
        );
    }

    await CLIENT.createCollection('storage', buildCollectionConfig('storage'));
    await CLIENT.createCollection('memory', buildCollectionConfig('memory'));

    if (STORAGE_ROOT) {
        STORAGE_CONNECTOR = createStorageConnector({
            client: CLIENT,
            storageRoot: STORAGE_ROOT,
            collection: 'storage',
            principals: CFG.principals,
            modelVersion: CFG.modelVersion,
            textExtensions: CFG.textExtensions,
            ignore: CFG.ignore,
            maxFileSizeBytes: CFG.maxFileSizeBytes,
            chunkMaxTokens: CFG.chunkMaxTokens,
            chunkOverlapTokens: CFG.chunkOverlapTokens,
            chunkTokCharsRatio: CFG.chunkTokCharsRatio,
            logger,
        });
    }

    if (SYNC_TIMER) {
        clearInterval(SYNC_TIMER);
        SYNC_TIMER = null;
    }
    if (CFG.autoSync && CFG.scanIntervalMinutes > 0 && STORAGE_CONNECTOR) {
        const ms = CFG.scanIntervalMinutes * 60_000;
        SYNC_TIMER = setInterval(() => {
            runStorageSync().catch(err => {
                logger.error(`[VDB] Scheduled storage sync failed: ${err.message}`, null, 'VDB');
            });
        }, ms);
        if (typeof SYNC_TIMER.unref === 'function') SYNC_TIMER.unref();
    }

    logger.info(
        `[VDB] Connected to nvdb serve at ${CFG.serviceUrl} (reranker_loaded=${RERANKER_LOADED}, model=${CFG.modelVersion})`,
        null,
        'VDB'
    );

    return {
        enabled: true,
        serviceUrl: CFG.serviceUrl,
        client: CLIENT,
        principals: CFG.principals,
        modelVersion: CFG.modelVersion,
        embeddingDim: CFG.embeddingDim,
        embeddingPath: CFG.embeddingPath,
        queryInstruct: CFG.queryInstruct,
        fuzzyEdits: CFG.fuzzyEdits,
        formatQueryForEmbedding,
        relevanceFloor: RELEVANCE_FLOOR,
        rerankerLoaded: RERANKER_LOADED,
        hybrid: CFG.hybrid,
        rerank: CFG.rerank,
        storageConnector: STORAGE_CONNECTOR,
    };
}

export async function searchDocuments({
    query,
    collections = ['storage'],
    folder = null,
    extension = null,
    top_k = 10,
    include_content = false,
    search = null,
    onProgress = null,
}) {
    if (!CLIENT) throw new Error('[VDB] Agent is not initialized');
    if (typeof query !== 'string' || !query.trim()) {
        throw new Error('query must be a non-empty string');
    }

    const { options } = searchRequestInfo(search);
    const normFolder = normalizeFolder(folder);
    const normExt = normalizeExtension(extension);

    let queryVector = null;
    if (options.dense) {
        onProgress?.('Embedding query', 20);
        queryVector = await GATEWAY.embed(formatQueryForEmbedding(query), { path: CFG.embeddingPath });
    }

    const targets = Array.isArray(collections) && collections.length > 0 ? collections : ['storage'];
    const allRows = [];

    for (const collName of targets) {
        const filters = {};
        if (collName === 'storage') {
            if (normFolder) filters.folder = normFolder;
            if (normExt) filters.ext = normExt;
        }

        const hybridQuery = {
            lexical: {
                text: query,
                top_k: options.rerank ? Math.max(top_k, options.shortlist) : top_k,
                principals: CFG.principals,
                fuzzy_edits: CFG.fuzzyEdits,
                explain: false,
                group_by_parent: options.diversity ? { max_per_parent: options.maxPerDocument } : null,
                filters,
            },
            query_vector: queryVector,
            dense: options.dense,
            lexical_enabled: options.lexical,
            candidate_k: options.candidateK,
            rrf_k: options.rrfK,
            lexical_weight: options.lexicalWeight,
            vector_weight: options.vectorWeight,
        };

        onProgress?.(`Searching ${collName}`, 50);
        const res = await CLIENT.hybridSearch(collName, hybridQuery);
        const rawHits = res.hits || [];

        if (options.rerank && rawHits.length > 0) {
            onProgress?.(`Reranking ${collName}`, 75);
            const l2 = await CLIENT.level2(collName, {
                query_text: query,
                principals: CFG.principals,
                hits: rawHits,
                shortlist: options.shortlist,
                rerank_weight: options.rerankWeight,
                relevance_floor: RELEVANCE_FLOOR,
            });
            for (const item of l2.hits || []) {
                const h = item.hybrid;
                const doc = h.hit;
                const relPath = doc.path || doc.parent_id || doc.id;
                const slash = relPath.indexOf('/');
                allRows.push({
                    id: doc.id,
                    parentId: doc.parent_id ?? null,
                    chunkIndex: doc.chunk_index ?? null,
                    collection: collName,
                    path: relPath,
                    title: doc.title || '',
                    folder: slash === -1 ? null : relPath.slice(0, slash),
                    score: h.rrf_score,
                    rrfScore: h.rrf_score,
                    rerankScore: item.rerank_score ?? null,
                    lexicalScore: h.lexical_score ?? null,
                    lexicalRank: h.lexical_rank ?? null,
                    vectorScore: h.vector_score ?? null,
                    vectorRank: h.vector_rank ?? null,
                    excerpt: doc.excerpt ?? null,
                    content: item.hydrated_text ?? doc.excerpt ?? null,
                    rejected: Boolean(l2.rejected),
                });
            }
        } else {
            for (const h of rawHits) {
                const doc = h.hit;
                const relPath = doc.path || doc.parent_id || doc.id;
                const slash = relPath.indexOf('/');
                allRows.push({
                    id: doc.id,
                    parentId: doc.parent_id ?? null,
                    chunkIndex: doc.chunk_index ?? null,
                    collection: collName,
                    path: relPath,
                    title: doc.title || '',
                    folder: slash === -1 ? null : relPath.slice(0, slash),
                    score: h.rrf_score,
                    rrfScore: h.rrf_score,
                    rerankScore: null,
                    lexicalScore: h.lexical_score ?? null,
                    lexicalRank: h.lexical_rank ?? null,
                    vectorScore: h.vector_score ?? null,
                    vectorRank: h.vector_rank ?? null,
                    excerpt: doc.excerpt ?? null,
                    content: doc.excerpt ?? null,
                    rejected: false,
                });
            }
        }
    }

    // Preserve nvdb serve's exact ordering for single-collection queries; only
    // merge-sort when multiple collections were requested together.
    if (targets.length > 1) {
        allRows.sort((a, b) => {
            if (options.rerank && a.rerankScore !== null && b.rerankScore !== null) {
                return b.rerankScore - a.rerankScore;
            }
            return b.rrfScore - a.rrfScore;
        });
    }

    const sliced = allRows.slice(0, top_k);

    if (include_content && STORAGE_CONNECTOR) {
        for (const row of sliced) {
            if (row.collection === 'storage') {
                const full = await STORAGE_CONNECTOR.readChunkContent(row.id);
                if (full !== null) row.content = full;
            }
        }
    }

    return sliced;
}

export async function vdb_search(args, context) {
    const {
        query,
        collections = ['storage', 'memory'],
        folder = null,
        extension = null,
        top_k = 10,
        include_content = false,
        search = null,
    } = args;

    const pr = createProgressReporter(context?.progress);
    const info = searchRequestInfo(search);
    const results = await searchDocuments({
        query,
        collections,
        folder,
        extension,
        top_k,
        include_content,
        search,
        onProgress: (msg, pct) => pr.set(msg, pct),
    });
    pr.done('Search complete');

    const assessment = assessRelevance(results, { rerankActive: info.rerankActive, floor: info.floor });
    if (assessment.rejected) {
        return {
            content: [{
                type: 'text',
                text: `mode: ${info.mode}\n${describeRejection(assessment, results, 'vdb matches')}\n\nRaw results:\n${JSON.stringify(results, null, 2)}`,
            }],
            isError: false,
        };
    }

    const formatted = results.map((r, i) => {
        const lanes = [
            r.vectorRank != null ? `vec#${r.vectorRank}` : null,
            r.lexicalRank != null ? `lex#${r.lexicalRank}` : null,
        ].filter(Boolean).join('/');
        const rerankPart = r.rerankScore != null ? `, rerank: ${r.rerankScore.toFixed(3)}` : '';
        const head = `${i + 1}. [${r.collection}:${r.path}] rrf: ${r.rrfScore.toFixed(4)}${rerankPart}${lanes ? ` (${lanes})` : ''}`;
        if (include_content && r.content) {
            return `${head}\n${r.content.slice(0, 500)}${r.content.length > 500 ? '...' : ''}`;
        }
        return head;
    }).join('\n');

    return {
        content: [{
            type: 'text',
            text: `mode: ${info.mode}\nFound ${results.length} match(es):\n\n${formatted || 'No matches.'}`,
        }],
        isError: false,
    };
}

export async function vdb_status() {
    if (!CLIENT) {
        return { content: [{ type: 'text', text: 'VDB is disabled or not initialized.' }], isError: false };
    }
    const [health, colls] = await Promise.all([
        CLIENT.health(),
        CLIENT.listCollections(),
    ]);
    const details = [];
    for (const c of colls.collections || []) {
        const pending = await CLIENT.pendingEmbeddings(c.name, 100);
        details.push({
            ...c,
            pending_embeddings_sample: pending.count,
        });
    }
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                engine: health.engine,
                serviceUrl: CFG.serviceUrl,
                rerankerLoaded: Boolean(health.reranker_loaded),
                modelVersion: CFG.modelVersion,
                collections: details,
                syncInProgress: SYNC_IN_PROGRESS,
                lastSync: LAST_SYNC,
            }, null, 2),
        }],
        isError: false,
    };
}

export async function vdb_trigger_scan(args, context) {
    const pr = createProgressReporter(context?.progress);
    const stats = await runStorageSync({ onProgress: (msg, pct) => pr.set(msg, pct) });
    pr.done('Sync complete');
    return {
        content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
        isError: false,
    };
}

export async function vdb_build_index() {
    if (!CLIENT) throw new Error('[VDB] Agent is not initialized');
    const colls = await CLIENT.listCollections();
    const committed = [];
    for (const c of colls.collections || []) {
        const res = await CLIENT.commit(c.name);
        committed.push({ name: c.name, doc_count: res.doc_count });
    }
    return {
        content: [{
            type: 'text',
            text: `nVDB v2 manages vector search automatically (flat SIMD scan below cutoff). Committed collections: ${JSON.stringify(committed)}`,
        }],
        isError: false,
    };
}

export async function integrityCheck({ collection = 'storage', checkVectors = false } = {}) {
    if (collection === 'storage') {
        if (!STORAGE_CONNECTOR) throw new Error('[VDB] storage connector is not initialized');
        return STORAGE_CONNECTOR.integrityCheck({ checkVectors });
    }
    throw new Error(`integrityCheck: unsupported collection "${collection}" (use memory connector for memory)`);
}
