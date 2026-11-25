/**
 * Thin HTTP/1.1 client for `ndb serve` (nDB v2, multi-DB service).
 *
 * Every non-2xx response throws NdbError with the server's explicit HTTP
 * status and structured error `code`. No retries, no silent fallbacks.
 *
 * Wire shapes verified against D:\DEV\nDB\src\server.rs (Phase 1a+1b @ b6eea08):
 *   GET  /health                      -> { ok, engine, version, dbs: [name], allow_create }
 *   GET  /v2/dbs                      -> { ok, dbs: [descriptor] }
 *   POST /v2/dbs                      -> 201 { ok, db }
 *   GET  /v2/dbs/:n/stats             -> { ok, documents, lineage }
 *   GET  /v2/dbs/:n/lineage           -> { ok, source_epoch_uuid, last_seq, min_available_seq }
 *   GET  /v2/dbs/:n/doc/:id           -> { ok, doc }
 *   PUT  /v2/dbs/:n/doc?prefix=       -> 201 { ok, id, doc, seq }
 *   PUT  /v2/dbs/:n/doc/:id           -> { ok, id, doc, seq }
 *   PATCH /v2/dbs/:n/doc/:id          -> { ok, applied, seq, doc }
 *   DELETE /v2/dbs/:n/doc/:id         -> { ok, deleted, seq }
 *   POST /v2/dbs/:n/doc/:id/restore   -> { ok, doc, seq }
 *   POST /v2/dbs/:n/docs/mget         -> { ok, docs: { id: doc }, missing: [id] }
 *   POST /v2/dbs/:n/query             -> { ok, total, count, results, took_ms, scanned_docs, used_indexes, next_cursor }
 *   POST /v2/dbs/:n/search            -> same envelope as /query (text required)
 *   POST /v2/dbs/:n/find              -> { ok, count, results, took_ms }
 *   POST /v2/dbs/:n/facets            -> { ok, facets }
 *   GET  /v2/dbs/:n/schema            -> { ok, schema }
 *   PUT  /v2/dbs/:n/schema            -> { ok, schema }
 *   POST /v2/dbs/:n/profile/classification -> { ok, schema }
 *   POST /v2/dbs/:n/doc/:id/peek       -> { ok, id, seq, doc, ranges }
 *   POST /v2/dbs/:n/index             -> { ok, field, type, created }
 *   POST /v2/dbs/:n/compact           -> { ok, lineage }
 *   POST /v2/dbs/:n/flush             -> { ok }
 *   GET  /v2/dbs/:n/changes?since=    -> { ok, source_epoch_uuid, from_seq, to_seq, last_seq, has_more, changes }
 *   GET  /v2/dbs/:n/snapshot?...      -> { ok, source_epoch_uuid, watermark_seq, snapshot_id, total, count, docs }
 *   PUT  /v2/dbs/:n/files/:bucket     -> 201 { ok, ref, hash, ext, size }
 *   GET  /v2/dbs/:n/files/:bucket     -> { ok, files }
 *   GET  /v2/dbs/:n/files/:bucket/:f  -> raw bytes (Content-Type from extension)
 *   DELETE /v2/dbs/:n/files/:bucket/:f -> { ok, deleted } | 409 { error: "file_referenced" }
 *   POST /v2/dbs/:n/files/gc          -> { ok, moved }
 * Error bodies under /v2/ are { ok: false, error: <code>, message }.
 */

const MGET_MAX_IDS = 1_000;

export class NdbError extends Error {
    constructor(status, code, message, route, body) {
        super(`ndb ${route} (${status} ${code}): ${message}`);
        this.name = 'NdbError';
        this.status = status;
        this.code = code;
        this.body = body;
        this.route = route;
    }
}

function encodeName(kind, name) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') {
        throw new TypeError(`Invalid ${kind} name: ${String(name)}`);
    }
    return encodeURIComponent(name);
}

function encodeComponent(kind, name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\]/.test(name)) {
        throw new TypeError(`Invalid ${kind}: ${String(name)}`);
    }
    return encodeURIComponent(name);
}

function assertPositiveInt(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
        throw new TypeError(`${label} must be a positive integer, got ${String(value)}`);
    }
    return n;
}

/** Accepts a legacy `{field, dir}` object or an array of sort keys; returns sort_keys. */
function normalizeSortKeys(sort, sortKeys) {
    const input = sortKeys ?? (Array.isArray(sort) ? sort : sort ? [sort] : null);
    if (input == null) return null;
    if (!Array.isArray(input) || input.length === 0) {
        throw new TypeError('sort_keys must be a non-empty array of {field, dir?} entries');
    }
    return input.map((k, i) => {
        if (!k || typeof k !== 'object' || typeof k.field !== 'string' || !k.field) {
            throw new TypeError(`sort_keys[${i}]: field is required`);
        }
        const out = { field: k.field };
        if (k.dir !== undefined) {
            if (k.dir !== 'asc' && k.dir !== 'desc') {
                throw new TypeError(`sort_keys[${i}]: dir must be 'asc' or 'desc', got ${String(k.dir)}`);
            }
            out.dir = k.dir;
        }
        if (k.missing !== undefined) {
            if (k.missing !== 'first' && k.missing !== 'last') {
                throw new TypeError(`sort_keys[${i}]: missing must be 'first' or 'last', got ${String(k.missing)}`);
            }
            out.missing = k.missing;
        }
        return out;
    });
}

/** Accepts a plain query string or a `{query, fields}` object; returns the wire object. */
function normalizeText(text) {
    if (text == null) return null;
    if (typeof text === 'string') {
        if (!text) throw new TypeError('text must not be empty');
        return { query: text };
    }
    if (typeof text !== 'object' || Array.isArray(text) || typeof text.query !== 'string' || !text.query) {
        throw new TypeError('text must be a non-empty string or an object with a non-empty query string');
    }
    const out = { query: text.query };
    if (text.fields !== undefined) {
        if (!Array.isArray(text.fields) || text.fields.length === 0) {
            throw new TypeError('text.fields must be a non-empty string array');
        }
        out.fields = text.fields;
    }
    return out;
}

export function createNdbClient(baseUrl, { token = null, timeoutMs = 30_000 } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
        throw new Error('createNdbClient: baseUrl is required (e.g. http://127.0.0.1:8323)');
    }
    const root = baseUrl.replace(/\/+$/, '');
    const auth = token ? { Authorization: `Bearer ${token}` } : {};

    async function send(method, path, { json, body, headers = {}, timeoutMs: reqTimeoutMs } = {}) {
        const url = `${root}${path}`;
        const ctrl = new AbortController();
        const budget = reqTimeoutMs ?? timeoutMs;
        const timer = setTimeout(() => ctrl.abort(), budget);
        const init = { method, signal: ctrl.signal, headers: { ...auth, ...headers } };
        if (json !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(json);
        } else if (body !== undefined) {
            init.body = body;
        }

        let res;
        try {
            res = await fetch(url, init);
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`ndb ${method} ${path} timed out after ${budget}ms (${root})`);
            }
            throw new Error(`ndb ${method} ${path} unreachable at ${root}: ${err.message}`);
        } finally {
            clearTimeout(timer);
        }
        return res;
    }

    async function request(method, path, opts = {}) {
        const res = await send(method, path, opts);
        const raw = await res.text();
        let data = null;
        if (raw.length > 0) {
            try {
                data = JSON.parse(raw);
            } catch {
                if (!res.ok) {
                    throw new NdbError(res.status, 'non_json_error', raw.slice(0, 300), `${method} ${path}`, raw.slice(0, 300));
                }
                throw new Error(`ndb ${method} ${path} returned non-JSON body: ${raw.slice(0, 200)}`);
            }
        }

        if (!res.ok) {
            const code = data?.error || `http_${res.status}`;
            const message = data?.message || data?.error || raw.slice(0, 300) || res.statusText;
            throw new NdbError(res.status, code, message, `${method} ${path}`, data);
        }
        return data;
    }

    async function requestRaw(method, path, opts = {}) {
        const res = await send(method, path, opts);
        if (res.status === 404) return null;
        if (!res.ok) {
            const raw = await res.text();
            let data = null;
            try {
                data = raw.length > 0 ? JSON.parse(raw) : null;
            } catch {
                data = raw.slice(0, 300);
            }
            const code = data?.error || `http_${res.status}`;
            const message = data?.message || (typeof data === 'string' ? data : null) || res.statusText;
            throw new NdbError(res.status, code, message, `${method} ${path}`, data);
        }
        return {
            buffer: Buffer.from(await res.arrayBuffer()),
            contentType: res.headers.get('content-type') || 'application/octet-stream',
        };
    }

    function db(name) {
        const dbName = encodeName('database', name);
        const base = `/v2/dbs/${dbName}`;

        const handle = {
            name,
            baseUrl: root,

            /** GET /stats -> { documents, lineage } */
            async stats() {
                const r = await request('GET', `${base}/stats`);
                return { documents: r.documents, lineage: r.lineage };
            },

            /** GET /lineage -> { source_epoch_uuid, last_seq, min_available_seq } */
            async lineage() {
                const r = await request('GET', `${base}/lineage`);
                return {
                    source_epoch_uuid: r.source_epoch_uuid,
                    last_seq: r.last_seq,
                    min_available_seq: r.min_available_seq,
                };
            },

            /** GET /doc/:id -> doc | null (404) */
            async get(id, { fields } = {}) {
                const qs = fields?.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
                try {
                    const r = await request('GET', `${base}/doc/${encodeURIComponent(id)}${qs}`);
                    return r.doc;
                } catch (err) {
                    if (err instanceof NdbError && err.status === 404 && err.code === 'not_found') return null;
                    throw err;
                }
            },

            /** POST /docs/mget -> { docs: { id: doc }, missing: [id] } */
            async mget(ids, { fields } = {}) {
                if (!Array.isArray(ids)) throw new TypeError(`mget: ids must be an array (got ${typeof ids})`);
                const unique = [...new Set(ids)];
                const docs = {};
                const missing = [];
                for (let i = 0; i < unique.length; i += MGET_MAX_IDS) {
                    const chunk = unique.slice(i, i + MGET_MAX_IDS);
                    const body = { ids: chunk };
                    if (fields?.length) body.fields = fields;
                    const r = await request('POST', `${base}/docs/mget`, { json: body });
                    Object.assign(docs, r.docs || {});
                    if (r.missing) missing.push(...r.missing);
                }
                return { docs, missing };
            },

            /** PUT /doc?prefix= -> { id, doc, seq } */
            async insert(doc, { prefix } = {}) {
                const qs = prefix === undefined ? '' : `?prefix=${encodeURIComponent(prefix)}`;
                const r = await request('PUT', `${base}/doc${qs}`, { json: doc });
                return { id: r.id, doc: r.doc, seq: r.seq };
            },

            /** PUT /doc/:id -> { id, doc, seq } */
            async update(id, doc, { ifSeq } = {}) {
                const qs = ifSeq === undefined ? '' : `?if_seq=${ifSeq}`;
                const r = await request('PUT', `${base}/doc/${encodeURIComponent(id)}${qs}`, { json: doc });
                return { id: r.id, doc: r.doc, seq: r.seq };
            },

            /** PATCH /doc/:id -> { applied, seq, doc } */
            async patch(id, ops, { ifSeq } = {}) {
                if (!Array.isArray(ops) || ops.length === 0) {
                    throw new TypeError('patch: ops must be a non-empty array');
                }
                const qs = ifSeq === undefined ? '' : `?if_seq=${ifSeq}`;
                const r = await request('PATCH', `${base}/doc/${encodeURIComponent(id)}${qs}`, { json: { ops } });
                return { applied: r.applied, seq: r.seq, doc: r.doc };
            },

            /** DELETE /doc/:id -> { deleted, seq } */
            async delete(id) {
                const r = await request('DELETE', `${base}/doc/${encodeURIComponent(id)}`);
                return { deleted: r.deleted, seq: r.seq };
            },

            /** POST /doc/:id/restore -> { doc, seq } */
            async restore(id) {
                const r = await request('POST', `${base}/doc/${encodeURIComponent(id)}/restore`);
                return { doc: r.doc, seq: r.seq };
            },

            /**
             * POST /query -> { total, count, results, took_ms, scanned_docs, used_indexes, next_cursor }
             *
             * Phase 4A passthroughs (all optional, strictly additive):
             *   sortKeys / sort_keys  -> multi-key deterministic order (+ _id tie-break server-side)
             *   cursor                -> opaque next_cursor from the previous page
             *   text                  -> standalone lexical query ({query, fields})
             *   maxScanDocs           -> mandatory scan budget (422 scan_budget_exceeded)
             * Legacy `sort`, `offset`, `limit`, `fields` and the `sort_by`/`sort_dir`
             * convenience pair keep their exact previous behaviour.
             */
            async query({
                filter = {},
                sort = null,
                sortKeys = null,
                sort_keys = null,
                sort_by = null,
                sort_dir = null,
                offset = 0,
                limit = 1000,
                fields = null,
                cursor = null,
                text = null,
                maxScanDocs = null,
                max_scan_docs = null,
            } = {}) {
                const body = { filter, offset, limit };
                if (sort_by !== null) {
                    if (typeof sort_by !== 'string' || !sort_by) {
                        throw new TypeError('query: sort_by must be a field name');
                    }
                    body.sort = sort_dir ? { field: sort_by, dir: sort_dir } : { field: sort_by };
                } else if (sort) {
                    body.sort = sort;
                }
                const keys = normalizeSortKeys(null, sortKeys ?? sort_keys);
                if (keys) body.sort_keys = keys;
                if (fields?.length) body.fields = fields;
                if (cursor !== null) {
                    if (typeof cursor !== 'string' || !cursor) {
                        throw new TypeError('query: cursor must be a non-empty string');
                    }
                    body.cursor = cursor;
                }
                const textQuery = normalizeText(text);
                if (textQuery) body.text = textQuery;
                const scanBudget = maxScanDocs ?? max_scan_docs;
                if (scanBudget !== null) body.max_scan_docs = scanBudget;
                const r = await request('POST', `${base}/query`, { json: body });
                return {
                    total: r.total,
                    count: r.count,
                    results: r.results,
                    took_ms: r.took_ms,
                    scanned_docs: r.scanned_docs,
                    used_indexes: r.used_indexes,
                    next_cursor: r.next_cursor ?? null,
                };
            },

            /**
             * POST /search -> same envelope as /query, with `text` required.
             * Standalone lexical search (term AND + quoted phrases), no nVDB needed.
             */
            async searchText({
                text,
                filter = {},
                sort = null,
                sortKeys = null,
                sort_keys = null,
                offset = 0,
                limit = 1000,
                fields = null,
                cursor = null,
                maxScanDocs = null,
                max_scan_docs = null,
            } = {}) {
                const textQuery = normalizeText(text);
                if (!textQuery) throw new TypeError('searchText: text is required');
                const body = { text: textQuery, filter, offset, limit };
                if (sort) body.sort = sort;
                const keys = normalizeSortKeys(null, sortKeys ?? sort_keys);
                if (keys) body.sort_keys = keys;
                if (fields?.length) body.fields = fields;
                if (cursor !== null) {
                    if (typeof cursor !== 'string' || !cursor) {
                        throw new TypeError('searchText: cursor must be a non-empty string');
                    }
                    body.cursor = cursor;
                }
                const scanBudget = maxScanDocs ?? max_scan_docs;
                if (scanBudget !== null) body.max_scan_docs = scanBudget;
                const r = await request('POST', `${base}/search`, { json: body });
                return {
                    total: r.total,
                    count: r.count,
                    results: r.results,
                    took_ms: r.took_ms,
                    scanned_docs: r.scanned_docs,
                    used_indexes: r.used_indexes,
                    next_cursor: r.next_cursor ?? null,
                };
            },

            /** GET /schema -> { classification_profile, field_mapping, indexes } */
            async getSchema() {
                const r = await request('GET', `${base}/schema`);
                return r.schema;
            },

            /** PUT /schema -> { classification_profile, field_mapping, indexes } */
            async setFieldMapping(fieldMapping) {
                if (!Array.isArray(fieldMapping)) {
                    throw new TypeError('setFieldMapping: fieldMapping must be an array');
                }
                const r = await request('PUT', `${base}/schema`, { json: { field_mapping: fieldMapping } });
                return r.schema;
            },

            /** POST /profile/classification -> { classification_profile, field_mapping, indexes } */
            async enableClassificationProfile({ enabled = true, backfillEmpty = false } = {}) {
                const r = await request('POST', `${base}/profile/classification`, {
                    json: { enabled, backfill_empty: backfillEmpty },
                });
                return r.schema;
            },

            /**
             * POST /doc/:id/peek -> { id, seq, doc, ranges }
             * Range offsets count Unicode scalar values (text) / array elements (slices).
             * `expectedSeq` pins the read: a moved document answers 409 conflict.
             */
            async peekItem(id, { fields, textRanges, arraySlices, expectedSeq } = {}) {
                if (typeof id !== 'string' || !id) throw new TypeError('peekItem: id is required');
                const body = {};
                if (fields?.length) body.fields = fields;
                if (textRanges !== undefined) {
                    if (!Array.isArray(textRanges)) throw new TypeError('peekItem: textRanges must be an array');
                    body.text_ranges = textRanges;
                }
                if (arraySlices !== undefined) {
                    if (!Array.isArray(arraySlices)) throw new TypeError('peekItem: arraySlices must be an array');
                    body.array_slices = arraySlices;
                }
                if (expectedSeq !== undefined) {
                    if (!Number.isInteger(expectedSeq) || expectedSeq < 0) {
                        throw new TypeError('peekItem: expectedSeq must be a non-negative integer');
                    }
                    body.expected_seq = expectedSeq;
                }
                const r = await request('POST', `${base}/doc/${encodeURIComponent(id)}/peek`, { json: body });
                return { id: r.id, seq: r.seq, doc: r.doc, ranges: r.ranges ?? {} };
            },

            /** POST /find -> { count, results, took_ms } */
            async find(field, value) {
                if (typeof field !== 'string' || !field) throw new TypeError('find: field is required');
                const r = await request('POST', `${base}/find`, { json: { field, value } });
                return { count: r.count, results: r.results, took_ms: r.took_ms };
            },

            /** POST /find (range form) -> { count, results, took_ms } */
            async findRange(field, min, max) {
                if (typeof field !== 'string' || !field) throw new TypeError('findRange: field is required');
                const r = await request('POST', `${base}/find`, { json: { field, min, max } });
                return { count: r.count, results: r.results, took_ms: r.took_ms };
            },

            /** POST /facets -> facets object */
            async facets(fields) {
                if (!Array.isArray(fields) || fields.length === 0) {
                    throw new TypeError('facets: fields must be a non-empty string array');
                }
                const r = await request('POST', `${base}/facets`, { json: { fields } });
                return r.facets;
            },

            /** POST /index -> { field, type, created } */
            async createIndex(field, type = 'hash') {
                if (typeof field !== 'string' || !field) throw new TypeError('createIndex: field is required');
                const r = await request('POST', `${base}/index`, { json: { field, type } });
                return { field: r.field, type: r.type, created: r.created };
            },

            /** POST /compact -> lineage */
            async compact() {
                const r = await request('POST', `${base}/compact`, { timeoutMs: 300_000 });
                return r.lineage;
            },

            /** POST /flush -> { ok } */
            async flush() {
                const r = await request('POST', `${base}/flush`);
                return { ok: r.ok };
            },

            /** GET /changes?since=&limit= -> { source_epoch_uuid, from_seq, to_seq, last_seq, has_more, changes } */
            async changes(since, { limit } = {}) {
                if (!Number.isInteger(since) || since < 0) {
                    throw new TypeError(`changes: since must be a non-negative integer (got ${String(since)})`);
                }
                const qs = new URLSearchParams({ since: String(since) });
                if (limit !== undefined) qs.set('limit', String(assertPositiveInt(limit, 'changes: limit')));
                const r = await request('GET', `${base}/changes?${qs}`);
                return {
                    source_epoch_uuid: r.source_epoch_uuid,
                    from_seq: r.from_seq,
                    to_seq: r.to_seq,
                    last_seq: r.last_seq,
                    has_more: r.has_more,
                    changes: r.changes,
                };
            },

            /** GET /snapshot -> { source_epoch_uuid, watermark_seq, snapshot_id, total, count, docs } */
            async snapshot({ offset, limit, snapshotId } = {}) {
                const qs = new URLSearchParams();
                if (offset !== undefined) qs.set('offset', String(offset));
                if (limit !== undefined) qs.set('limit', String(assertPositiveInt(limit, 'snapshot: limit')));
                if (snapshotId !== undefined) qs.set('snapshot_id', snapshotId);
                const suffix = qs.toString() ? `?${qs}` : '';
                const r = await request('GET', `${base}/snapshot${suffix}`, { timeoutMs: 120_000 });
                return {
                    source_epoch_uuid: r.source_epoch_uuid,
                    watermark_seq: r.watermark_seq,
                    snapshot_id: r.snapshot_id,
                    total: r.total,
                    count: r.count,
                    docs: r.docs,
                };
            },

            /**
             * Pages through a pinned snapshot until every document is collected.
             * The pin (the server freezes the state for 300 s) is what keeps the
             * result drift-free while writes continue.
             */
            async allSnapshotDocs({ pageSize = 5_000 } = {}) {
                const size = assertPositiveInt(pageSize, 'allSnapshotDocs: pageSize');
                const first = await handle.snapshot({ offset: 0, limit: size });
                const docs = [...first.docs];
                if (docs.length >= first.total) return docs;
                if (!first.snapshot_id) {
                    throw new Error(`ndb snapshot: ${first.total} docs but no snapshot_id to page with (would drift)`);
                }
                while (docs.length < first.total) {
                    const page = await handle.snapshot({ offset: docs.length, limit: size, snapshotId: first.snapshot_id });
                    if (page.docs.length === 0) {
                        throw new Error(`ndb snapshot ${first.snapshot_id}: empty page at offset ${docs.length} of ${first.total}`);
                    }
                    docs.push(...page.docs);
                }
                return docs;
            },

            /** PUT /files/:bucket -> { ref, hash, ext, size } */
            async storeFile(bucket, buffer, filename) {
                if (!Buffer.isBuffer(buffer)) throw new TypeError('storeFile: buffer must be a Buffer');
                const b = encodeComponent('bucket', bucket);
                encodeComponent('filename', filename);
                const r = await request('PUT', `${base}/files/${b}`, {
                    body: buffer,
                    headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': filename },
                    timeoutMs: 120_000,
                });
                return { ref: r.ref, hash: r.hash, ext: r.ext, size: r.size };
            },

            /** GET /files/:bucket/:filename -> { buffer, contentType } | null (404) */
            async getFile(bucket, filename) {
                const b = encodeComponent('bucket', bucket);
                const f = encodeComponent('filename', filename);
                return requestRaw('GET', `${base}/files/${b}/${f}`, { timeoutMs: 120_000 });
            },

            /** DELETE /files/:bucket/:filename -> { deleted } (409 file_referenced unless force) */
            async releaseFile(bucket, filename, { force = false } = {}) {
                const b = encodeComponent('bucket', bucket);
                const f = encodeComponent('filename', filename);
                const qs = force ? '?force=true' : '';
                const r = await request('DELETE', `${base}/files/${b}/${f}${qs}`);
                return { deleted: r.deleted };
            },

            /** GET /files/:bucket -> [filename] */
            async listFiles(bucket) {
                const b = encodeComponent('bucket', bucket);
                const r = await request('GET', `${base}/files/${b}`);
                return r.files;
            },

            /** POST /files/gc -> { moved } */
            async gcBuckets() {
                const r = await request('POST', `${base}/files/gc`, { timeoutMs: 120_000 });
                return { moved: r.moved };
            },
        };

        return handle;
    }

    return {
        baseUrl: root,

        /** GET /health -> { ok, engine, version, dbs, allow_create } */
        health() {
            return request('GET', '/health');
        },

        /** GET /v2/dbs -> [descriptor] */
        async listDbs() {
            const r = await request('GET', '/v2/dbs');
            return r.dbs;
        },

        /** POST /v2/dbs -> db descriptor (201) */
        async createDb(name, { persistence } = {}) {
            encodeName('database', name);
            const body = persistence === undefined ? { name } : { name, persistence };
            const r = await request('POST', '/v2/dbs', { json: body });
            return r.db;
        },

        db,
    };
}
