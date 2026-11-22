import { createHash } from 'node:crypto';
import { getLogger } from './utils/logger.js';

const logger = getLogger();

/**
 * Embed client — talks DIRECTLY to the llama-cpp-wrapper, no gateway hop.
 *
 * Architecture (2026-08-04): the LLM Gateway was removed from the embed path
 * after the immortal-request incident (32 hung gateway-side promises: no
 * abort propagation, no body-read deadline on the gateway's embed route).
 * The wrapper + llama-server already provide the required semantics:
 *   - llama-server's slot queue serializes execution (slow, never broken)
 *   - the wrapper propagates client disconnects upstream, freeing slots
 * So the only failure modes left are: wrapper machine down (fetch fails
 * fast) or queue wait longer than the timeout. Foreground embeds (search)
 * abort at a short cap and degrade; background embeds (store/heal) use a
 * generous deadlock guard and let the queue work them off eventually.
 *
 * There is deliberately NO circuit breaker here. A breaker exists to paper
 * over hangs; with abort propagation the queue drains, so a breaker would
 * only add a stateful failure mode on top of a stateless service.
 *
 * Config (env or config.json gateway section):
 *   EMBED_URL  — gateway base URL, e.g. http://localhost:3400. Embeds always
 *                go through the gateway, which owns the embed model — this
 *                client sends NO model so the gateway uses its default.
 */

// Foreground (search queries): keep snappy — degrade to recency rather than
// making the caller wait on a saturated queue.
const EMBED_TIMEOUT_MS = 15000;
const EMBED_BATCH_TIMEOUT_MS = 30000;
// Background (store/heal): generous deadlock guard, NOT a performance target.
// Lean into llama-server's slot queue — the wrapper serializes execution and
// propagates aborts upstream, so a long wait means "eventually served", not
// "lost". Prevents the pending->heal->retry churn from premature aborts.
const EMBED_BACKGROUND_TIMEOUT_MS = 300000; // 5 min

// ── Embedding-integrity guard ────────────────────────────────────────────
// The provider can return byte-identical vectors for DIFFERENT inputs, and it
// does so across separate requests (seen across both memory and storage
// collections, not just within one batch). Two consequences drove this guard:
//   1. The per-batch duplicate check in the VDB agent only sees one response at
//      a time, so a duplicate produced by two separate calls slips through — a
//      single-text embed had no check at all.
//   2. When a batch is rejected, the VDB bisection fallback retries subsets in
//      NEW requests. Without cross-request memory, a duplicate pair split
//      across those requests becomes acceptable and gets persisted.
// So the mapping lives here, process-local, shared by every client instance and
// both entry points: vectorHash -> inputHash. An identical vector for an
// identical input is legitimate (cache/warm path, repeated query). An identical
// vector for a different input cannot be produced by a real embedder and is a
// provider fault, so it throws — and the rejected mapping is never recorded.
// Bounded so a long-running process cannot grow without limit; the window only
// needs to span the requests around one provider episode.
const MAX_REMEMBERED_VECTORS = 4096;
const vectorOwners = new Map(); // vectorHash -> inputHash (insertion order = LRU order)

// Thrown when a vector cannot legitimately belong to the input it arrived for.
// Named so callers can classify it — it is NOT a network fault and must never
// be retried as one.
export class EmbeddingIntegrityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EmbeddingIntegrityError';
    }
}

export function hashInput(text) {
    return createHash('sha256').update(text, 'utf8').digest('base64');
}

export function hashVector(vector) {
    const floats = new Float64Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
        const v = vector[i];
        // Collapse -0 onto 0: the sign bit must not hide a duplicate.
        floats[i] = v === 0 ? 0 : v;
    }
    return createHash('sha256').update(new Uint8Array(floats.buffer)).digest('base64');
}

function assertVector(vector, where) {
    const isArray = Array.isArray(vector);
    const isTyped = ArrayBuffer.isView(vector) && !(vector instanceof DataView);
    if (!isArray && !isTyped) {
        throw new Error(`${where}: embedding is not an array or typed array (got ${vector === null ? 'null' : typeof vector})`);
    }
    if (vector.length === 0) {
        throw new Error(`${where}: embedding is empty`);
    }
    let sq = 0;
    for (let i = 0; i < vector.length; i++) {
        const v = vector[i];
        if (!Number.isFinite(v)) {
            throw new Error(`${where}: embedding dim ${i} is not a finite number (${String(v)})`);
        }
        sq += v * v;
    }
    if (!Number.isFinite(sq)) {
        throw new Error(`${where}: embedding has non-finite norm — refusing to use it`);
    }
    if (sq === 0) {
        throw new Error(`${where}: embedding has zero norm — refusing to use it`);
    }
    return vector;
}

function acceptVector(inputText, vector, where) {
    const inputHash = hashInput(inputText);
    const vectorHash = hashVector(vector);
    const owner = vectorOwners.get(vectorHash);
    if (owner !== undefined && owner !== inputHash) {
        // No content in the message — request context only.
        throw new EmbeddingIntegrityError(`${where}: provider returned a byte-identical embedding for a different input (vector ${vectorHash.slice(0, 12)}…) — refusing duplicate vector`);
    }
    if (owner !== undefined) vectorOwners.delete(vectorHash);
    vectorOwners.set(vectorHash, inputHash);
    if (vectorOwners.size > MAX_REMEMBERED_VECTORS) {
        vectorOwners.delete(vectorOwners.keys().next().value);
    }
    return vector;
}

export function createEmbedClient(embedUrl, accessKey = null) {
    if (!embedUrl) throw new Error('createEmbedClient: embedUrl is required (env EMBED_URL or config gateway.embedUrl)');
    const baseUrl = embedUrl.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (accessKey) headers['Authorization'] = `Bearer ${accessKey}`;

    // An index lives in exactly one vector space, so the route that produced
    // its vectors must be selected explicitly. The Gateway serves one route per
    // embedding model (`/v1/embeddings` for qwen3-embedding-4b); anything else
    // is a typo, not a fallback. No model is sent either way — each route owns
    // its upstream model.
    const DEFAULT_EMBED_PATH = '/v1/embeddings';
    function resolvePath(opts) {
        const value = opts?.path ?? DEFAULT_EMBED_PATH;
        if (typeof value !== 'string' || !value.startsWith('/v1/embeddings')) {
            throw new TypeError(`embed: path must be a /v1/embeddings… route (got ${String(value)})`);
        }
        return value;
    }

    async function post(body, timeoutMs, embedPath) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`${baseUrl}${embedPath}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return await res.json();
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`Embedding timed out after ${timeoutMs / 1000}s — wrapper queue longer than timeout (retry is safe)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        async embed(text, opts) {
            if (typeof text !== 'string') throw new TypeError(`embed: text must be a string (got ${typeof text})`);
            const timeout = opts?.background ? EMBED_BACKGROUND_TIMEOUT_MS : EMBED_TIMEOUT_MS;
            // No model sent — the gateway resolves the route's embed model.
            const data = await post({ input: text }, timeout, resolvePath(opts));
            if (!data || !Array.isArray(data.data)) {
                throw new Error(`embed: provider response has no data array (got ${data === null ? 'null' : typeof data?.data})`);
            }
            if (data.data.length !== 1) {
                throw new Error(`embed: provider returned ${data.data.length} items for a single input — expected exactly 1`);
            }
            const item = data.data[0];
            if (item === null || typeof item !== 'object') {
                throw new Error(`embed: provider response item is not an object (got ${item === null ? 'null' : typeof item})`);
            }
            if ('index' in item && item.index !== 0) {
                throw new Error(`embed: provider returned index ${String(item.index)} for a single input — expected 0`);
            }
            const vector = assertVector(item.embedding, 'embed');
            acceptVector(text, vector, 'embed (single request)');
            return vector;
        },

        async embedBatch(texts, opts) {
            if (!Array.isArray(texts) || texts.length === 0) {
                throw new TypeError(`embedBatch: texts must be a non-empty array (got ${Array.isArray(texts) ? 'empty array' : typeof texts})`);
            }
            for (let i = 0; i < texts.length; i++) {
                if (typeof texts[i] !== 'string') throw new TypeError(`embedBatch: texts[${i}] is not a string (got ${typeof texts[i]})`);
            }
            const timeout = opts?.background ? EMBED_BACKGROUND_TIMEOUT_MS : EMBED_BATCH_TIMEOUT_MS;
            // No model sent — the gateway resolves the route's embed model.
            const data = await post({ input: texts }, timeout, resolvePath(opts));
            if (!data || !Array.isArray(data.data)) {
                throw new Error(`embedBatch: provider response has no data array (got ${data === null ? 'null' : typeof data?.data})`);
            }
            if (data.data.length !== texts.length) {
                throw new Error(`embedBatch: expected ${texts.length} embeddings, got ${data.data.length}`);
            }
            // Responses are placed by their declared index, never by array
            // position — the provider is not required to answer in order.
            const out = new Array(texts.length);
            const seen = new Set();
            for (let pos = 0; pos < data.data.length; pos++) {
                const item = data.data[pos];
                if (item === null || typeof item !== 'object') {
                    throw new Error(`embedBatch: provider response item at position ${pos} is not an object (got ${item === null ? 'null' : typeof item})`);
                }
                if (!Number.isInteger(item.index)) {
                    throw new Error(`embedBatch: provider response item at position ${pos} has no integer index (got ${String(item.index)})`);
                }
                if (item.index < 0 || item.index >= texts.length) {
                    throw new Error(`embedBatch: provider response index ${item.index} is out of range 0..${texts.length - 1}`);
                }
                if (seen.has(item.index)) {
                    throw new Error(`embedBatch: provider response repeats index ${item.index} (position ${pos})`);
                }
                seen.add(item.index);
                out[item.index] = assertVector(item.embedding, `embedBatch (response index ${item.index})`);
            }
            // length === texts.length + all indices in range + no repeats means
            // every index was supplied; the guard runs in input order so the
            // reported context names the caller's own index.
            for (let i = 0; i < texts.length; i++) {
                acceptVector(texts[i], out[i], `embedBatch (input ${i} of ${texts.length})`);
            }
            return out;
        }
    };
}
