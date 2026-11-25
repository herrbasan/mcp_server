/**
 * Embedded query facade — coordinates `ndb serve` (authoritative) with an
 * optional `nvdb serve` (derived accelerator). There is no third service.
 *
 * Routing rules (spec_ndb-standalone-contract.md §1, §5):
 *   - Objects, writes, peeks and schema always go to NDB. nVDB is never the
 *     source of truth for current state.
 *   - `listItems` prefers nVDB only when the class allows it, the DB field
 *     mapping projects every requested field, nVDB is online (not rebuilding)
 *     and its `as_of_seq` covers the facade's read-your-writes watermark.
 *     Otherwise the identical task runs on NDB and says so (`engine: 'ndb'`).
 *   - `searchItems({ mode: 'lexical' })` uses nVDB when it is online and fresh,
 *     otherwise NDB's standalone lexical search.
 *   - `vector` / `hybrid` / `rerank` genuinely require nVDB. If it is missing,
 *     unreachable, rebuilding or stale they throw NvdbUnavailableError. No
 *     silent downgrade to a lexical scan.
 */

const CONSISTENCY_MODES = new Set(['read_your_writes', 'strong', 'eventual']);
const REQUIRED_NDB_METHODS = [
    'get', 'mget', 'insert', 'update', 'patch', 'delete', 'restore',
    'query', 'searchText', 'facets', 'getSchema', 'setFieldMapping',
    'enableClassificationProfile', 'peekItem',
];

export class NvdbUnavailableError extends Error {
    constructor(mode, reason) {
        super(`nVDB is required for ${mode} search but is unavailable: ${reason}`);
        this.name = 'NvdbUnavailableError';
        this.code = 'NVDB_UNAVAILABLE';
        this.mode = mode;
        this.reason = reason;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSort(sort) {
    if (sort == null) return null;
    const list = Array.isArray(sort) ? sort : [sort];
    if (list.length === 0) throw new TypeError('sort must be a sort key or a non-empty array of sort keys');
    return list.map((k, i) => {
        if (!k || typeof k !== 'object' || typeof k.field !== 'string' || !k.field) {
            throw new TypeError(`sort[${i}]: field is required`);
        }
        const out = { field: k.field };
        if (k.dir !== undefined) {
            if (k.dir !== 'asc' && k.dir !== 'desc') {
                throw new TypeError(`sort[${i}]: dir must be 'asc' or 'desc', got ${String(k.dir)}`);
            }
            out.dir = k.dir;
        }
        if (k.missing !== undefined) {
            if (k.missing !== 'first' && k.missing !== 'last') {
                throw new TypeError(`sort[${i}]: missing must be 'first' or 'last', got ${String(k.missing)}`);
            }
            out.missing = k.missing;
        }
        return out;
    });
}

/** The watermark nVDB reports for `collection`, or null when it does not say. */
function readAsOfSeq(health, collection) {
    if (Number.isInteger(health?.as_of_seq)) return health.as_of_seq;
    if (Number.isInteger(health?.watermark)) return health.watermark;
    const cols = health?.collections;
    if (Array.isArray(cols)) {
        for (const entry of cols) {
            if (!entry || typeof entry !== 'object' || entry.name !== collection) continue;
            const v = entry.as_of_seq ?? entry.watermark ?? entry.synced_seq;
            if (Number.isInteger(v)) return v;
        }
    } else if (cols && typeof cols === 'object') {
        const entry = cols[collection];
        const v = entry?.as_of_seq ?? entry?.watermark ?? entry?.synced_seq;
        if (Number.isInteger(v)) return v;
    }
    return null;
}

/** Field names referenced by a filter, sort and projection. */
function collectFieldRefs({ filter, sortKeys, fields }) {
    const refs = new Set();
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === '$and' || key === '$or' || key === '$not' || key === '$nor') {
                walk(value);
                continue;
            }
            if (!key.startsWith('$')) refs.add(key);
        }
    };
    walk(filter);
    for (const key of sortKeys ?? []) refs.add(key.field);
    for (const field of fields ?? []) refs.add(field);
    return refs;
}

function projectionCovers(schema, refs) {
    const mapping = new Map((schema?.field_mapping ?? []).map(entry => [entry.field, entry]));
    for (const ref of refs) {
        if (ref === '_id') continue;
        const entry = mapping.get(ref);
        if (!entry || entry.project !== true) return false;
    }
    return true;
}

function normalizeNvdbHits(response) {
    const hits = response?.hits ?? response?.results ?? [];
    const results = hits.map((hit) => {
        if (!hit || typeof hit !== 'object') {
            throw new Error(`nVDB returned a non-object hit: ${JSON.stringify(hit)}`);
        }
        const rawDoc = hit.doc ?? hit.document ?? (hit._id !== undefined ? hit : null);
        const id = hit.id ?? hit._id ?? rawDoc?._id ?? rawDoc?.id;
        if (!id) throw new Error(`nVDB returned a hit without an id: ${JSON.stringify(hit)}`);
        const base = rawDoc ? { ...rawDoc } : {};
        base._id = base._id ?? id;
        const meta = {};
        if (typeof hit.score === 'number') meta.score = hit.score;
        if (hit.snippet !== undefined) meta.snippet = hit.snippet;
        if (hit.offsets !== undefined) meta.offsets = hit.offsets;
        if (hit.snippet_offsets !== undefined) meta.offsets = hit.snippet_offsets;
        if (Object.keys(meta).length > 0) base._search = meta;
        return base;
    });
    return {
        results,
        total: response?.total ?? results.length,
        count: response?.count ?? results.length,
        next_cursor: response?.next_cursor ?? null,
        scanned_docs: response?.scanned_docs ?? null,
        used_indexes: response?.used_indexes ?? null,
        took_ms: response?.took_ms ?? null,
    };
}

export function createQueryFacade({
    ndbDb,
    nvdbClient = null,
    collection = null,
    readYourWritesMs = 2_000,
    pollIntervalMs = 25,
    preferNvdbList = false,
} = {}) {
    if (!ndbDb || typeof ndbDb !== 'object') {
        throw new TypeError('createQueryFacade: ndbDb (a db handle from createNdbClient(...).db(name)) is required');
    }
    for (const method of REQUIRED_NDB_METHODS) {
        if (typeof ndbDb[method] !== 'function') {
            throw new TypeError(`createQueryFacade: ndbDb.${method}() is required (extend src/lib/ndb-client.js)`);
        }
    }
    if (nvdbClient !== null) {
        if (typeof nvdbClient !== 'object' || typeof nvdbClient.health !== 'function') {
            throw new TypeError('createQueryFacade: nvdbClient must expose health() (see src/agents/vdb/v2-client.js)');
        }
        if (typeof collection !== 'string' || !collection) {
            throw new TypeError('createQueryFacade: collection is required when nvdbClient is configured');
        }
    }
    if (!Number.isInteger(readYourWritesMs) || readYourWritesMs < 0) {
        throw new TypeError('createQueryFacade: readYourWritesMs must be a non-negative integer');
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
        throw new TypeError('createQueryFacade: pollIntervalMs must be a positive integer');
    }

    let lastWriteSeq = 0;

    function trackSeq(seq) {
        if (Number.isInteger(seq) && seq > lastWriteSeq) lastWriteSeq = seq;
        return seq;
    }

    function requiredSeqFor(consistency, minSeq) {
        if (minSeq !== undefined && (!Number.isInteger(minSeq) || minSeq < 0)) {
            throw new TypeError(`minSeq must be a non-negative integer, got ${String(minSeq)}`);
        }
        if (!CONSISTENCY_MODES.has(consistency)) {
            throw new TypeError(`consistency must be one of ${[...CONSISTENCY_MODES].join(', ')}; got ${String(consistency)}`);
        }
        const floor = minSeq ?? 0;
        return consistency === 'read_your_writes' ? Math.max(floor, lastWriteSeq) : floor;
    }

    async function probeNvdb() {
        if (!nvdbClient) return { state: 'absent', reason: 'no nVDB client configured' };
        let health;
        try {
            health = await nvdbClient.health();
        } catch (err) {
            if (err.status === 503 || err.code === 'rebuilding') {
                return { state: 'rebuilding', reason: `nVDB is rebuilding (${err.message})` };
            }
            return { state: 'unreachable', reason: err.message };
        }
        if (!health || health.ok !== true) {
            return { state: 'unhealthy', reason: `health answered ok=${JSON.stringify(health?.ok)}` };
        }
        if (health.rebuilding === true || health.status === 'rebuilding') {
            return { state: 'rebuilding', reason: 'nVDB is rebuilding' };
        }
        return { state: 'online', asOfSeq: readAsOfSeq(health, collection) };
    }

    function isFresh(status, requiredSeq) {
        return requiredSeq <= 0 || (Number.isInteger(status.asOfSeq) && status.asOfSeq >= requiredSeq);
    }

    async function waitForFreshness(requiredSeq) {
        let status = await probeNvdb();
        if (status.state !== 'online' || isFresh(status, requiredSeq)) return status;
        const deadline = Date.now() + readYourWritesMs;
        while (Date.now() < deadline) {
            await sleep(pollIntervalMs);
            status = await probeNvdb();
            if (status.state !== 'online' || isFresh(status, requiredSeq)) return status;
        }
        return status;
    }

    function freshnessReason(status, requiredSeq) {
        if (status.asOfSeq === null || status.asOfSeq === undefined) {
            return `nVDB did not report as_of_seq, so read-your-writes for seq ${requiredSeq} cannot be proven`;
        }
        return `nVDB as_of_seq ${status.asOfSeq} is behind required seq ${requiredSeq} after ${readYourWritesMs}ms`;
    }

    const handle = {
        collection,
        readYourWritesMs,
        pollIntervalMs,
        preferNvdbList,
        get lastWriteSeq() {
            return lastWriteSeq;
        },

        // ── writes (NDB is authoritative; track the watermark) ──────────────
        async createItem(doc, opts = {}) {
            const r = await ndbDb.insert(doc, opts);
            trackSeq(r.seq);
            return r;
        },
        async replaceItem(id, doc, opts = {}) {
            const r = await ndbDb.update(id, doc, opts);
            trackSeq(r.seq);
            return r;
        },
        async patchItem(id, ops, opts = {}) {
            const r = await ndbDb.patch(id, ops, opts);
            trackSeq(r.seq);
            return r;
        },
        async deleteItem(id) {
            const r = await ndbDb.delete(id);
            trackSeq(r.seq);
            return r;
        },
        async restoreItem(id) {
            const r = await ndbDb.restore(id);
            trackSeq(r.seq);
            return r;
        },

        // ── authoritative object reads ──────────────────────────────────────
        getItem(id, { fields } = {}) {
            return ndbDb.get(id, { fields });
        },
        mgetItems(ids, { fields } = {}) {
            return ndbDb.mget(ids, { fields });
        },
        peekItem(id, opts = {}) {
            return ndbDb.peekItem(id, opts);
        },

        /**
         * Continue a peeked object at the same seq. Omitted `offset`s continue
         * from `prevPeek.ranges[path].next_offset`; the pin is `prevPeek.seq`,
         * so a document that moved mid-read surfaces as 409 conflict.
         */
        async readMore(prevPeek, { fields, textRanges, arraySlices } = {}) {
            if (!prevPeek || typeof prevPeek !== 'object' || !Number.isInteger(prevPeek.seq)) {
                throw new TypeError('readMore: prevPeek must be the object returned by peekItem (with an integer seq)');
            }
            if (typeof prevPeek.id !== 'string' || !prevPeek.id) {
                throw new TypeError('readMore: prevPeek.id is required');
            }
            const previousRanges = prevPeek.ranges ?? {};
            const continueRange = (list, label) => (list ?? []).map((range, i) => {
                if (!range || typeof range.path !== 'string' || !range.path) {
                    throw new TypeError(`readMore: ${label}[${i}].path is required`);
                }
                if (range.offset !== undefined) {
                    if (!Number.isInteger(range.offset) || range.offset < 0) {
                        throw new TypeError(`readMore: ${label}[${i}].offset must be a non-negative integer`);
                    }
                    return { ...range };
                }
                const previous = previousRanges[range.path];
                if (!previous) {
                    throw new Error(
                        `readMore: ${label} "${range.path}" was not part of seq ${prevPeek.seq}; pass offset explicitly`
                    );
                }
                if (previous.has_more === false) {
                    throw new Error(
                        `readMore: ${label} "${range.path}" is exhausted at seq ${prevPeek.seq}`
                    );
                }
                if (!Number.isInteger(previous.next_offset)) {
                    throw new Error(
                        `readMore: ${label} "${range.path}" has no next_offset at seq ${prevPeek.seq}`
                    );
                }
                return { ...range, offset: previous.next_offset };
            });
            return ndbDb.peekItem(prevPeek.id, {
                fields,
                textRanges: continueRange(textRanges, 'textRanges'),
                arraySlices: continueRange(arraySlices, 'arraySlices'),
                expectedSeq: prevPeek.seq,
            });
        },

        // ── schema / classification ─────────────────────────────────────────
        getSchema() {
            return ndbDb.getSchema();
        },
        setFieldMapping(mapping) {
            return ndbDb.setFieldMapping(mapping);
        },
        enableClassificationProfile(opts = {}) {
            return ndbDb.enableClassificationProfile(opts);
        },

        /**
         * Facet counts under the same filter semantics as listItems.
         * Unfiltered counts use the server's native /facets; a filtered count
         * walks the matching set through the query cursor (string fields and
         * string array elements, exactly like the native endpoint).
         */
        async facets(filter = {}, fields) {
            if (Array.isArray(filter)) {
                if (fields !== undefined) {
                    throw new TypeError('facets: pass either facets(fields) or facets(filter, fields), not both');
                }
                fields = filter;
                filter = {};
            }
            if (!Array.isArray(fields) || fields.length === 0) {
                throw new TypeError('facets: fields must be a non-empty string array');
            }
            if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
                throw new TypeError('facets: filter must be an object');
            }
            if (Object.keys(filter).length === 0) return ndbDb.facets(fields);

            const counts = {};
            for (const field of fields) counts[field] = {};
            let cursor = null;
            do {
                const page = await ndbDb.query({ filter, fields, limit: 5_000, cursor });
                for (const doc of page.results) {
                    for (const field of fields) {
                        const value = doc[field];
                        if (typeof value === 'string') {
                            counts[field][value] = (counts[field][value] ?? 0) + 1;
                        } else if (Array.isArray(value)) {
                            for (const entry of value) {
                                if (typeof entry === 'string') {
                                    counts[field][entry] = (counts[field][entry] ?? 0) + 1;
                                }
                            }
                        }
                    }
                }
                cursor = page.next_cursor;
            } while (cursor);
            return counts;
        },

        // ── list ────────────────────────────────────────────────────────────
        async listItems({
            filter = {},
            sort = null,
            fields = null,
            limit,
            offset,
            cursor = null,
            maxScanDocs = null,
            consistency = 'read_your_writes',
            minSeq,
        } = {}) {
            const requiredSeq = requiredSeqFor(consistency, minSeq);
            const sortKeys = normalizeSort(sort);
            const wantsNvdb = preferNvdbList && nvdbClient !== null && consistency !== 'strong';
            let nvdbError = null;

            if (wantsNvdb && typeof nvdbClient.list === 'function' && Array.isArray(fields) && fields.length > 0) {
                const schema = await ndbDb.getSchema();
                const refs = collectFieldRefs({ filter, sortKeys, fields });
                if (projectionCovers(schema, refs)) {
                    const status = await waitForFreshness(requiredSeq);
                    if (status.state === 'online' && isFresh(status, requiredSeq)) {
                        try {
                            const response = await nvdbClient.list(collection, {
                                filter,
                                sort_keys: sortKeys,
                                fields,
                                limit,
                                offset,
                                cursor,
                                max_scan_docs: maxScanDocs,
                            });
                            const normalized = normalizeNvdbHits(response);
                            return {
                                ...normalized,
                                engine: 'nvdb',
                                as_of_seq: status.asOfSeq ?? response?.as_of_seq ?? null,
                            };
                        } catch (err) {
                            nvdbError = err.message;
                        }
                    }
                }
            }

            const r = await ndbDb.query({
                filter,
                sortKeys,
                fields,
                limit,
                offset,
                cursor,
                maxScanDocs,
            });
            return {
                results: r.results,
                total: r.total,
                count: r.count,
                next_cursor: r.next_cursor ?? null,
                scanned_docs: r.scanned_docs ?? null,
                used_indexes: r.used_indexes ?? [],
                took_ms: r.took_ms,
                engine: 'ndb',
                ...(nvdbError ? { nvdb_error: nvdbError } : {}),
            };
        },

        // ── search ──────────────────────────────────────────────────────────
        async searchItems({
            query,
            mode = 'lexical',
            fields = null,
            filter = {},
            sort = null,
            limit,
            offset,
            cursor = null,
            maxScanDocs = null,
            consistency = 'read_your_writes',
            minSeq,
            snippet = true,
        } = {}) {
            if (typeof query !== 'string' || !query) {
                throw new TypeError('searchItems: query must be a non-empty string');
            }
            const requiredSeq = requiredSeqFor(consistency, minSeq);
            const sortKeys = normalizeSort(sort);

            if (mode === 'lexical') {
                let nvdbError = null;
                if (nvdbClient && typeof nvdbClient.search === 'function') {
                    const status = await waitForFreshness(requiredSeq);
                    if (status.state === 'online' && isFresh(status, requiredSeq)) {
                        try {
                            const response = await nvdbClient.search(collection, {
                                text: query,
                                fields,
                                filter,
                                sort_keys: sortKeys,
                                limit,
                                offset,
                                cursor,
                                max_scan_docs: maxScanDocs,
                                snippet,
                            });
                            const normalized = normalizeNvdbHits(response);
                            return {
                                ...normalized,
                                engine: 'nvdb',
                                as_of_seq: status.asOfSeq ?? response?.as_of_seq ?? null,
                            };
                        } catch (err) {
                            nvdbError = err.message;
                        }
                    }
                }
                const r = await ndbDb.searchText({
                    text: query,
                    fields,
                    filter,
                    sortKeys,
                    limit,
                    offset,
                    cursor,
                    maxScanDocs,
                });
                return {
                    results: r.results,
                    total: r.total,
                    count: r.count,
                    next_cursor: r.next_cursor ?? null,
                    scanned_docs: r.scanned_docs ?? null,
                    used_indexes: r.used_indexes ?? [],
                    took_ms: r.took_ms,
                    engine: 'ndb',
                    ...(nvdbError ? { nvdb_error: nvdbError } : {}),
                };
            }

            if (mode !== 'vector' && mode !== 'hybrid' && mode !== 'rerank') {
                throw new TypeError(`searchItems: mode must be lexical, vector, hybrid or rerank; got ${String(mode)}`);
            }
            if (!nvdbClient) throw new NvdbUnavailableError(mode, 'no nVDB client configured');
            const method = mode === 'vector' ? 'vectorSearch' : mode === 'hybrid' ? 'hybridSearch' : 'rerank';
            if (typeof nvdbClient[method] !== 'function') {
                throw new NvdbUnavailableError(mode, `nVDB client exposes no ${method}() method`);
            }
            const status = await waitForFreshness(requiredSeq);
            if (status.state !== 'online') throw new NvdbUnavailableError(mode, status.reason);
            if (!isFresh(status, requiredSeq)) throw new NvdbUnavailableError(mode, freshnessReason(status, requiredSeq));

            const response = await nvdbClient[method](collection, {
                text: query,
                query,
                fields,
                filter,
                sort_keys: sortKeys,
                limit,
                offset,
                cursor,
                max_scan_docs: maxScanDocs,
                snippet,
            });
            const normalized = normalizeNvdbHits(response);
            return { ...normalized, engine: 'nvdb', as_of_seq: status.asOfSeq ?? response?.as_of_seq ?? null };
        },

        /** Health/freshness snapshot — read-only diagnostics. */
        nvdbStatus() {
            return probeNvdb();
        },
    };

    return handle;
}
