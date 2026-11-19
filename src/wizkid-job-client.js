import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { hashInput, hashVector, EmbeddingIntegrityError } from './embed-client.js';

export const WIZKID_MODEL = 'qwen3-embedding-4b';
export const WIZKID_DIM = 2560;

const INPUT_ID = /^[A-Za-z0-9._:#-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export class WizkidHttpError extends Error {
    constructor(status, body, retryAfter = null) {
        const detail = body?.error?.message || body?.message || `HTTP ${status}`;
        super(`Wizkid HTTP ${status}: ${detail}`);
        this.name = 'WizkidHttpError';
        this.status = status;
        this.code = body?.error?.code || body?.code || null;
        this.requestId = body?.error?.request_id || body?.request_id || null;
        this.retryAfter = retryAfter;
    }
}

export function retryAfterMs(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    if (/^\d+$/.test(String(value))) return Number(value) * 1000;
    const at = Date.parse(String(value));
    return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function loadWizkidToken({ token = process.env.OVEM_API_TOKEN, tokenFile = process.env.OVEM_TOKEN_FILE } = {}) {
    if (token) return token.trim();
    if (!tokenFile) throw new Error('Wizkid auth requires OVEM_API_TOKEN or OVEM_TOKEN_FILE');
    const text = fs.readFileSync(tokenFile, 'utf8');
    const match = text.match(/^OVEM_API_TOKEN\s*=\s*(.+?)\s*$/m);
    if (!match) throw new Error(`Wizkid token file has no OVEM_API_TOKEN: ${tokenFile}`);
    return match[1].replace(/^['"]|['"]$/g, '');
}

function parseBody(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { message: text.slice(0, 500) }; }
}

function assertVector(vector, expectedId) {
    if (!Array.isArray(vector) || vector.length !== WIZKID_DIM) {
        throw new Error(`Wizkid result ${expectedId}: expected ${WIZKID_DIM} dimensions, got ${Array.isArray(vector) ? vector.length : typeof vector}`);
    }
    let sum = 0;
    for (let i = 0; i < vector.length; i++) {
        const value = vector[i];
        if (!Number.isFinite(value)) throw new Error(`Wizkid result ${expectedId}: non-finite dimension ${i}`);
        sum += value * value;
    }
    const norm = Math.sqrt(sum);
    if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-3) {
        throw new Error(`Wizkid result ${expectedId}: expected a normalized vector, norm=${norm}`);
    }
}

export function createWizkidJobClient({
    baseUrl = 'http://wizkid:8765',
    token,
    callerId,
    fetchImpl = fetch,
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 250,
    requestTimeoutMs = 120000,
    maxTransientRetries = 20,
    onRetry = null,
    onProgress = null
}) {
    if (!token) throw new Error('createWizkidJobClient: token is required');
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(callerId || '')) throw new Error('createWizkidJobClient: invalid callerId');
    const root = baseUrl.replace(/\/+$/, '');
    const vectorOwners = new Map();

    async function request(method, route, body = null) {
        let networkFailures = 0;
        for (let attempt = 0; ; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
            let response;
            let text;
            try {
                response = await fetchImpl(`${root}${route}`, {
                    method,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        ...(body === null ? {} : { 'Content-Type': 'application/json' })
                    },
                    ...(body === null ? {} : { body: JSON.stringify(body) }),
                    signal: controller.signal
                });
                text = await response.text();
            } catch (error) {
                if (networkFailures < 3) {
                    networkFailures++;
                    const delayMs = 1000 * networkFailures;
                    onRetry?.({ status: 0, code: 'network', delayMs, attempt: networkFailures, route, method });
                    await sleep(delayMs);
                    continue;
                }
                throw new Error(`Wizkid ${method} ${route} failed: ${error.message}`, { cause: error });
            } finally {
                clearTimeout(timer);
            }
            const data = parseBody(text);
            if (response.status === 429 || response.status === 503) {
                const retryAfter = response.headers.get('retry-after');
                const delay = retryAfterMs(retryAfter);
                if (delay === null) throw new WizkidHttpError(response.status, data, retryAfter);
                if (attempt >= maxTransientRetries) throw new WizkidHttpError(response.status, data, retryAfter);
                onRetry?.({ status: response.status, code: data?.error?.code || data?.code || null, delayMs: delay, attempt: attempt + 1 });
                await sleep(delay);
                continue;
            }
            if (!response.ok) throw new WizkidHttpError(response.status, data, response.headers.get('retry-after'));
            return data;
        }
    }

    async function limits() {
        const data = await request('GET', '/v1/embeddings/limits');
        if (data.model !== WIZKID_MODEL || data.dim !== WIZKID_DIM || data.max_batch !== 4 || data.max_input_tokens !== 8192) {
            throw new Error(`Wizkid limits mismatch: ${JSON.stringify({ model: data.model, dim: data.dim, max_batch: data.max_batch, max_input_tokens: data.max_input_tokens })}`);
        }
        return data;
    }

    async function submit(inputs, idempotencyKey) {
        if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 512) throw new Error('Wizkid submit requires 1..512 inputs');
        if (!IDEMPOTENCY_KEY.test(idempotencyKey || '')) throw new Error(`Invalid Wizkid idempotency key: ${idempotencyKey}`);
        const ids = new Set();
        for (const input of inputs) {
            if (!INPUT_ID.test(input?.id || '')) throw new Error(`Invalid Wizkid input id: ${input?.id}`);
            if (ids.has(input.id)) throw new Error(`Duplicate Wizkid input id: ${input.id}`);
            if (typeof input.text !== 'string' || !input.text.trim()) throw new Error(`Wizkid input ${input.id} must be non-empty text`);
            ids.add(input.id);
        }
        return request('POST', '/v1/embeddings/jobs', {
            model: WIZKID_MODEL,
            caller_id: callerId,
            idempotency_key: idempotencyKey,
            inputs
        });
    }

    async function status(jobId) {
        if (!/^job_[0-9a-f]{32}$/.test(jobId || '')) throw new Error(`Invalid Wizkid job id: ${jobId}`);
        return request('GET', `/v1/embeddings/jobs/${jobId}`);
    }

    async function cancel(jobId) {
        if (!/^job_[0-9a-f]{32}$/.test(jobId || '')) throw new Error(`Invalid Wizkid job id: ${jobId}`);
        return request('DELETE', `/v1/embeddings/jobs/${jobId}`);
    }

    async function wait(jobId) {
        for (;;) {
            const state = await status(jobId);
            onProgress?.(state);
            if (state.status === 'succeeded') return state;
            if (state.status === 'failed') throw new Error(`Wizkid job ${jobId} failed: ${state.error?.code || 'unknown'}: ${state.error?.message || 'no detail'}`);
            if (state.status === 'cancelled') throw new Error(`Wizkid job ${jobId} was cancelled`);
            if (state.status !== 'queued' && state.status !== 'running') throw new Error(`Wizkid job ${jobId} has unknown status ${state.status}`);
            await sleep(pollMs);
        }
    }

    async function embed(inputs, { idempotencyKey }) {
        const submitted = await submit(inputs, idempotencyKey);
        if (!submitted?.job_id) throw new Error('Wizkid submission returned no job_id');
        await wait(submitted.job_id);
        const result = await request('GET', `/v1/embeddings/jobs/${submitted.job_id}/result`);
        if (result.model !== WIZKID_MODEL || result.dim !== WIZKID_DIM || !Array.isArray(result.results) || result.results.length !== inputs.length) {
            throw new Error(`Wizkid job ${submitted.job_id} returned an invalid result envelope`);
        }
        const byId = new Map(result.results.map(item => [item.input_id, item]));
        const vectors = [];
        for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            const item = byId.get(input.id);
            if (!item || item.index !== i) throw new Error(`Wizkid job ${submitted.job_id} has missing or misordered input ${input.id}`);
            assertVector(item.embedding, input.id);
            const vectorHash = hashVector(item.embedding);
            const inputHash = hashInput(input.text);
            const owner = vectorOwners.get(vectorHash);
            if (owner && owner !== inputHash) {
                throw new EmbeddingIntegrityError(`Wizkid returned one vector for different inputs (${input.id})`);
            }
            vectorOwners.set(vectorHash, inputHash);
            vectors.push(item.embedding);
        }
        return { vectors, jobId: submitted.job_id, usage: result.usage || null };
    }

    return { limits, submit, status, wait, cancel, embed };
}

export function batchIdempotencyKey(runId, inputs) {
    const hash = createHash('sha256');
    for (const input of inputs) hash.update(input.id).update('\0').update(input.text).update('\0');
    return `${runId}:${hash.digest('hex').slice(0, 40)}`;
}
