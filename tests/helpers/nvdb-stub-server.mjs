/**
 * Controllable HTTP stand-in for `nvdb serve`, used to prove facade routing.
 *
 * It implements the subset of nVDB the query facade consumes — /health plus a
 * derived-projection list and lexical/vector/hybrid/rerank search — with the
 * same observable semantics as `ndb serve` for the operations the facade routes
 * (filter, multi-key sort with `_id` tie-break, cursor paging, projection).
 *
 * State is driven from the test:
 *   stub.setAsOfSeq(n)          — the watermark nVDB reports
 *   stub.catchUpTo(seq, ms)     — advance the watermark after a delay
 *   stub.setRebuilding(true)    — /health and every route answer 503
 *   stub.setDocs(docs)          — replace the derived projection
 *   await stub.stop()           — the port closes (real "offline")
 */

import http from 'node:http';

function httpError(status, code, message) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
}

function getPath(obj, dotted) {
    let node = obj;
    for (const part of dotted.split('.')) {
        if (node === null || typeof node !== 'object') return undefined;
        node = node[part];
    }
    return node;
}

function valuesEqualOrMember(value, operand) {
    if (Array.isArray(value) && !Array.isArray(operand)) return value.includes(operand);
    return JSON.stringify(value) === JSON.stringify(operand);
}

function compareValues(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matchCondition(value, condition) {
    if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
        return valuesEqualOrMember(value, condition);
    }
    for (const [op, operand] of Object.entries(condition)) {
        switch (op) {
            case '$eq': if (!valuesEqualOrMember(value, operand)) return false; break;
            case '$ne': if (valuesEqualOrMember(value, operand)) return false; break;
            case '$in': if (!operand.some(o => valuesEqualOrMember(value, o))) return false; break;
            case '$nin': if (operand.some(o => valuesEqualOrMember(value, o))) return false; break;
            case '$gt': if (!(compareValues(value, operand) > 0)) return false; break;
            case '$gte': if (!(compareValues(value, operand) >= 0)) return false; break;
            case '$lt': if (!(compareValues(value, operand) < 0)) return false; break;
            case '$lte': if (!(compareValues(value, operand) <= 0)) return false; break;
            case '$exists': if ((value !== undefined) !== Boolean(operand)) return false; break;
            default: throw httpError(400, 'invalid_filter', `stub: unsupported operator ${op}`);
        }
    }
    return true;
}

function matchesFilter(doc, filter) {
    if (filter == null) return true;
    if (typeof filter !== 'object' || Array.isArray(filter)) {
        throw httpError(400, 'invalid_filter', 'stub: filter must be an object');
    }
    for (const [key, condition] of Object.entries(filter)) {
        if (key === '$and') {
            if (!condition.every(f => matchesFilter(doc, f))) return false;
            continue;
        }
        if (key === '$or') {
            if (!condition.some(f => matchesFilter(doc, f))) return false;
            continue;
        }
        if (key === '$not') {
            if (matchesFilter(doc, condition)) return false;
            continue;
        }
        if (!matchCondition(getPath(doc, key), condition)) return false;
    }
    return true;
}

function sortDocs(docs, sortKeys) {
    const keys = Array.isArray(sortKeys) && sortKeys.length > 0 ? sortKeys : [{ field: '_id', dir: 'asc' }];
    return [...docs].sort((a, b) => {
        for (const key of keys) {
            const av = getPath(a, key.field);
            const bv = getPath(b, key.field);
            const aMissing = av === undefined || av === null;
            const bMissing = bv === undefined || bv === null;
            if (aMissing || bMissing) {
                if (aMissing && bMissing) continue;
                const missingFirst = (key.missing ?? 'last') === 'first';
                return aMissing ? (missingFirst ? -1 : 1) : (missingFirst ? 1 : -1);
            }
            const cmp = compareValues(av, bv);
            if (cmp !== 0) return key.dir === 'desc' ? -cmp : cmp;
        }
        return compareValues(a._id, b._id);
    });
}

function project(doc, fields) {
    const out = { _id: doc._id };
    for (const field of fields) out[field] = getPath(doc, field);
    return out;
}

function parseTerms(query) {
    if (typeof query !== 'string' || !query.trim()) {
        throw httpError(400, 'invalid_argument', 'stub: text query must not be empty');
    }
    const quotes = (query.match(/"/g) ?? []).length;
    if (quotes % 2 !== 0) throw httpError(400, 'invalid_argument', 'stub: unterminated quote');
    const terms = [];
    let i = 0;
    while (i < query.length) {
        if (/\s/.test(query[i])) { i += 1; continue; }
        if (query[i] === '"') {
            const end = query.indexOf('"', i + 1);
            terms.push({ phrase: query.slice(i + 1, end) });
            i = end + 1;
            continue;
        }
        let j = i;
        while (j < query.length && !/\s/.test(query[j])) j += 1;
        terms.push({ term: query.slice(i, j) });
        i = j;
    }
    return terms;
}

function stringFields(doc, restricted) {
    if (restricted?.length) return restricted.filter(f => typeof getPath(doc, f) === 'string');
    return Object.keys(doc).filter(k => k !== '_id' && typeof doc[k] === 'string');
}

function codePointOffset(haystack, index) {
    return [...haystack.slice(0, index)].length;
}

function matchLexical(doc, terms, restrictedFields = null) {
    const fields = stringFields(doc, restrictedFields);
    if (fields.length === 0) return null;
    let first = null;
    for (let t = 0; t < terms.length; t += 1) {
        const needle = (terms[t].phrase ?? terms[t].term).toLowerCase();
        let matched = null;
        for (const field of fields) {
            const haystack = doc[field];
            const idx = haystack.toLowerCase().indexOf(needle);
            if (idx >= 0) { matched = { field, idx, haystack }; break; }
        }
        if (!matched) return null;
        if (t === 0) first = matched;
    }
    const offset = codePointOffset(first.haystack, first.idx);
    return {
        path: first.field,
        offset,
        limit: 40,
        snippet: [...first.haystack].slice(offset, offset + 40).join(''),
    };
}

async function readJson(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
        return JSON.parse(raw);
    } catch {
        throw httpError(400, 'invalid_json', 'stub: body is not JSON');
    }
}

function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}

export async function startNvdbStub({ collection = 'docs', docs = [], asOfSeq = 0 } = {}) {
    const state = {
        collection,
        docs: docs.map(doc => ({ ...doc })),
        asOfSeq,
        rebuilding: false,
        stopped: false,
        catchUpTimer: null,
    };

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            const path = url.pathname;

            if (state.rebuilding) {
                send(res, 503, { ok: false, code: 'rebuilding', error: 'rebuilding' });
                return;
            }

            if (req.method === 'GET' && path === '/health') {
                send(res, 200, {
                    ok: true,
                    engine: 'nvdb-stub',
                    collections: [{ name: state.collection, as_of_seq: state.asOfSeq, watermark: state.asOfSeq }],
                    as_of_seq: state.asOfSeq,
                    reranker_loaded: true,
                });
                return;
            }

            const route = path.match(/^\/v2\/collections\/([^/]+)\/(list|search|vector_search|hybrid_search|rerank)$/);
            if (req.method === 'POST' && route) {
                const [, name, action] = route;
                if (decodeURIComponent(name) !== state.collection) {
                    send(res, 404, { ok: false, code: 'collection_not_found', error: 'collection not found' });
                    return;
                }
                const body = await readJson(req);
                const asOf = state.asOfSeq;
                const started = Date.now();
                const filtered = state.docs.filter(doc => matchesFilter(doc, body.filter ?? {}));
                const scanBudget = body.max_scan_docs;
                if (scanBudget !== undefined && scanBudget !== null && state.docs.length > scanBudget) {
                    send(res, 422, {
                        ok: false,
                        code: 'scan_budget_exceeded',
                        error: `scan budget exceeded: scanned ${state.docs.length}, budget ${scanBudget}`,
                        scanned: state.docs.length,
                        max_scan: scanBudget,
                    });
                    return;
                }

                if (action === 'search') {
                    const textSpec = typeof body.text === 'string' ? { query: body.text } : body.text;
                    if (!textSpec || typeof textSpec.query !== 'string') {
                        send(res, 400, { ok: false, code: 'text_required', error: 'text is required' });
                        return;
                    }
                    const terms = parseTerms(textSpec.query);
                    const hits = [];
                    for (const doc of filtered) {
                        const location = matchLexical(doc, terms, textSpec.fields);
                        if (!location) continue;
                        const projected = body.fields?.length ? project(doc, body.fields) : { ...doc };
                        hits.push({
                            id: doc._id,
                            score: 1,
                            doc: projected,
                            snippet: location.snippet,
                            offsets: location.path ? [{ path: location.path, offset: location.offset, limit: location.limit }] : [],
                        });
                    }
                    const ordered = sortDocs(hits.map(h => ({ ...h, _id: h.id })), body.sort_keys)
                        .map(({ _id, ...hit }) => hit);
                    const paged = pageOf(ordered, body);
                    send(res, 200, {
                        ok: true,
                        hits: paged.items,
                        total: ordered.length,
                        count: paged.items.length,
                        next_cursor: paged.next_cursor,
                        took_ms: Date.now() - started,
                        as_of_seq: asOf,
                    });
                    return;
                }

                if (action !== 'list') {
                    const mode = action === 'vector_search' ? 'vector' : action === 'hybrid_search' ? 'hybrid' : 'rerank';
                    const hits = sortDocs(filtered, body.sort_keys).map((doc, index) => ({
                        id: doc._id,
                        score: 1 - index / Math.max(1, filtered.length),
                        mode,
                        doc: body.fields?.length ? project(doc, body.fields) : { ...doc },
                    }));
                    const paged = pageOf(hits, body);
                    send(res, 200, {
                        ok: true,
                        hits: paged.items,
                        total: hits.length,
                        count: paged.items.length,
                        next_cursor: paged.next_cursor,
                        took_ms: Date.now() - started,
                        as_of_seq: asOf,
                    });
                    return;
                }

                const ordered = sortDocs(filtered, body.sort_keys);
                const paged = pageOf(ordered, body);
                const results = body.fields?.length
                    ? paged.items.map(doc => project(doc, body.fields))
                    : paged.items.map(doc => ({ ...doc }));
                send(res, 200, {
                    ok: true,
                    results,
                    total: ordered.length,
                    count: results.length,
                    next_cursor: paged.next_cursor,
                    scanned_docs: state.docs.length,
                    used_indexes: ['_stub'],
                    took_ms: Date.now() - started,
                    as_of_seq: asOf,
                });
                return;
            }

            send(res, 404, { ok: false, code: 'no_route', error: `stub: no route ${req.method} ${path}` });
        } catch (err) {
            send(res, err.status ?? 500, { ok: false, code: err.code ?? 'internal_error', error: err.message });
        }
    });

    function pageOf(items, body) {
        let start = body.offset ?? 0;
        if (body.cursor) {
            if (start !== 0) throw httpError(400, 'invalid_query', 'stub: cursor cannot be combined with offset');
            const decoded = JSON.parse(Buffer.from(body.cursor, 'base64url').toString('utf8'));
            const index = items.findIndex(item => item._id === decoded.after);
            if (index < 0) throw httpError(400, 'invalid_query', 'stub: cursor does not match the result set');
            start = index + 1;
        }
        const limit = body.limit ?? 1000;
        const page = items.slice(start, start + limit);
        const last = page[page.length - 1];
        const nextCursor = start + page.length < items.length && last
            ? Buffer.from(JSON.stringify({ after: last._id }), 'utf8').toString('base64url')
            : null;
        return { items: page, next_cursor: nextCursor };
    }

    const port = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    const url = `http://127.0.0.1:${port}`;

    async function stop() {
        if (state.stopped) return;
        state.stopped = true;
        if (state.catchUpTimer) clearTimeout(state.catchUpTimer);
        state.catchUpTimer = null;
        await new Promise(resolve => server.close(() => resolve()));
    }

    return {
        url,
        port,
        state,
        client: createStubClient(url),
        setAsOfSeq(seq) {
            if (!Number.isInteger(seq) || seq < 0) throw new TypeError('setAsOfSeq: non-negative integer required');
            state.asOfSeq = seq;
        },
        setRebuilding(value) {
            state.rebuilding = Boolean(value);
        },
        setDocs(next) {
            state.docs = next.map(doc => ({ ...doc }));
        },
        catchUpTo(seq, afterMs) {
            if (state.catchUpTimer) clearTimeout(state.catchUpTimer);
            state.catchUpTimer = setTimeout(() => {
                state.asOfSeq = seq;
                state.catchUpTimer = null;
            }, afterMs);
        },
        stop,
    };
}

/** The nVDB surface the query facade expects, spoken over HTTP. */
export function createStubClient(baseUrl) {
    const root = baseUrl.replace(/\/+$/, '');

    async function request(method, path, body) {
        const init = { method, signal: AbortSignal.timeout(5_000) };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        let res;
        try {
            res = await fetch(`${root}${path}`, init);
        } catch (err) {
            throw new Error(`nvdb-stub unreachable at ${root}: ${err.message}`);
        }
        const raw = await res.text();
        const data = raw ? JSON.parse(raw) : null;
        if (!res.ok) {
            const err = new Error(`nvdb-stub ${method} ${path} (${res.status} ${data?.code}): ${data?.error}`);
            err.status = res.status;
            err.code = data?.code;
            throw err;
        }
        return data;
    }

    const collectionPath = name => `/v2/collections/${encodeURIComponent(name)}`;
    return {
        baseUrl: root,
        health: () => request('GET', '/health'),
        list: (name, query) => request('POST', `${collectionPath(name)}/list`, query),
        search: (name, query) => request('POST', `${collectionPath(name)}/search`, query),
        vectorSearch: (name, query) => request('POST', `${collectionPath(name)}/vector_search`, query),
        hybridSearch: (name, query) => request('POST', `${collectionPath(name)}/hybrid_search`, query),
        rerank: (name, query) => request('POST', `${collectionPath(name)}/rerank`, query),
    };
}
