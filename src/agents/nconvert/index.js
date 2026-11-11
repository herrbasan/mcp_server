// nConvert tool surface — HTTP proxy to the nTeligence service.
//
// The conversion engine, the job records and the artefact folders live in
// `nteligence-server` (D:\DEV\nTeligence). This file keeps the MCP tool names,
// arguments and response envelopes callers already parse, and forwards
// everything else. Nothing here touches a file, a queue *state machine* or a
// native binary — the in-repo copy of nConvert and its N-API build are gone on
// purpose (docs/rust-backend-plan.md §9).
//
// Failure posture: an unreachable service is a loud error naming the URL. There
// is no local fallback to fall back to, and no silent degradation — the deep
// lane and summary/verify answer with the service's own explicit refusal.

import { getLogger } from '../../utils/logger.js';
import { initNconvertUi, shutdownNconvertUi } from './ui-api.js';

const logger = getLogger();

const DEFAULT_SERVICE = 'http://127.0.0.1:3300';
const INGEST_TIMEOUT_MS = 10 * 60 * 1000;
const CALL_TIMEOUT_MS = 60 * 1000;

// The service rejects unknown body keys, so the forward set is explicit.
const INGEST_KEYS = ['path', 'depth', 'assets', 'keepOriginal', 'ocr', 'name', 'force'];

let serviceUrl = DEFAULT_SERVICE;
let conf = {};

export async function init(context) {
    const configured = context.config.agents?.nconvert?.serviceUrl;
    serviceUrl = String(configured || DEFAULT_SERVICE).replace(/\/+$/, '');
    conf = { ...(context.config.agents?.nconvert ?? {}) };
    delete conf.serviceUrl;

    let reachable = true;
    let converter = null;
    try {
        const health = await serviceCall('GET', '/api/health');
        converter = health.converter;
        logger.info(`nconvert: proxying to ${serviceUrl} (${converter}, ${health.items} item(s))`, null, 'nconvert');
    } catch (error) {
        reachable = false;
        // One offline service must not take the whole MCP surface down: every
        // nconvert call will fail loudly instead, naming the URL and the reason.
        logger.warn(`nconvert: service not reachable at ${serviceUrl} — ${error.message}`, null, 'nconvert');
    }

    initNconvertUi(context, { conf, submitIngest, readItemPayload, regenerateSummary, serviceCall, serviceBase: serviceBaseUrl });
    return { status: reachable ? 'proxying' : 'unreachable', service: serviceUrl, converter };
}

export function serviceBaseUrl() {
    return serviceUrl;
}

export async function shutdown() {
    shutdownNconvertUi();
}

// ─── transport ───────────────────────────────────────────────────────────

function query(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null) search.set(key, String(value));
    }
    const encoded = search.toString();
    return encoded ? `?${encoded}` : '';
}

export async function serviceCall(method, route, body, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const url = `${serviceUrl}${route}`;
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        throw new Error(
            `nconvert: nTeligence service unreachable at ${serviceUrl} (${method} ${route}) — ${error.message}. ` +
            'Start it with: cd D:\\DEV\\nTeligence; cargo run -p nteligence-server'
        );
    }
    const text = await response.text();
    let payload;
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(`nconvert: ${method} ${route} returned non-JSON (${response.status}): ${text.slice(0, 400)}`);
    }
    if (!response.ok) {
        const kind = payload?.kind ? `${payload.kind}: ` : '';
        throw new Error(`nconvert: ${method} ${route} → ${response.status} ${kind}${payload?.error ?? text}`.trim());
    }
    return payload;
}

// ─── MCP tool handlers ───────────────────────────────────────────────────

function tool(text, extra = {}) {
    return { content: [{ type: 'text', text }], isError: false, ...extra };
}

function itemUi(id) {
    return { label: 'View conversion', url: `/nconvert?item=${encodeURIComponent(id)}`, mode: 'preview' };
}

function jobUi(job) {
    return {
        label: job.state === 'done' ? 'View conversion' : 'View conversion progress',
        url: `/nconvert?job=${encodeURIComponent(job.id)}`,
        mode: 'preview'
    };
}

function ingestArgs(args) {
    if (typeof args?.path !== 'string' || !args.path.trim()) {
        throw new Error('nconvert.convert: "path" is required');
    }
    const body = {};
    const unknown = [];
    for (const [key, value] of Object.entries(args)) {
        if (INGEST_KEYS.includes(key)) body[key] = value;
        else if (value !== undefined) unknown.push(key);
    }
    if (unknown.length) {
        throw new Error(
            `nconvert: nTeligence does not accept ${unknown.join(', ')} — it belongs to a lane that ` +
            'has not moved yet. Accepted: ' + INGEST_KEYS.join(', ')
        );
    }
    return body;
}

async function convertImpl(args) {
    const payload = await serviceCall('POST', '/api/ingest', ingestArgs(args), { timeoutMs: INGEST_TIMEOUT_MS });
    const extra = { result: payload.result, ui: itemUi(payload.result.id) };
    if (payload.job) {
        extra.jobId = payload.job.id;
        extra.job = payload.job;
    }
    return tool(payload.text, extra);
}

export async function nconvert_convert(args) {
    return convertImpl(args);
}

export async function nconvert_enqueue(args) {
    return convertImpl(args);
}

export async function nconvert_jobs(args) {
    const payload = await serviceCall('GET', `/api/jobs${query({
        state: args?.state ?? undefined,
        limit: Math.min(Number(args?.limit ?? 20), 100)
    })}`);
    return tool(payload.text, { jobs: payload.jobs });
}

export async function nconvert_job(args) {
    if (!args?.id) throw new Error('nconvert.job: "id" is required');
    const payload = await serviceCall('GET', `/api/jobs/${encodeURIComponent(args.id)}${query({
        since: args?.since ?? undefined,
        activityLimit: args?.activityLimit ?? undefined
    })}`);
    return tool(payload.text, { job: payload.job, activity: payload.activity, ui: jobUi(payload.job) });
}

export async function nconvert_cancel(args) {
    if (!args?.id) throw new Error('nconvert.cancel: "id" is required');
    const payload = await serviceCall('POST', `/api/jobs/${encodeURIComponent(args.id)}/cancel`);
    return tool(payload.text, { job: payload.job, ui: jobUi(payload.job) });
}

export async function nconvert_items(args) {
    const payload = await serviceCall('GET', `/api/items${query({
        limit: Math.min(Number(args?.limit ?? 20), 100)
    })}`);
    return tool(payload.text, { items: payload.items });
}

export async function nconvert_fetch(args) {
    if (!args?.item) throw new Error('nconvert.fetch: "item" is required (see nconvert.items)');
    const payload = await serviceCall('GET', `/api/items/${encodeURIComponent(args.item)}/fetch${query({
        layer: args?.layer ?? undefined,
        section: args?.section ?? undefined,
        page: args?.page ?? undefined,
        asset: args?.asset ?? undefined,
        maxChars: args?.maxChars ?? undefined
    })}`);
    return tool(payload.text, { layer: payload.layer, kind: payload.kind, path: payload.path ?? null, url: payload.url ?? null });
}

export async function nconvert_capabilities() {
    const payload = await serviceCall('GET', '/api/capabilities');
    // The review surface belongs to this server, not the engine, so it is
    // declared here — otherwise capabilities would describe the converter and
    // hide the page, upload route and event stream a caller can actually use.
    const capabilities = { ...payload, ui: { path: '/nconvert', upload: true, events: '/nconvert/events', files: '/files' } };
    return tool(JSON.stringify(capabilities, null, 2), { capabilities });
}

export async function nconvert_verify(args) {
    if (!args?.item) throw new Error('nconvert.verify: "item" is required (see nconvert.items)');
    const payload = await serviceCall('POST', `/api/items/${encodeURIComponent(args.item)}/verify`);
    return tool(JSON.stringify(payload, null, 2));
}

export async function nconvert_summarize(args) {
    if (!args?.item) throw new Error('nconvert.summarize: "item" is required (see nconvert.items)');
    const payload = await serviceCall('POST', `/api/items/${encodeURIComponent(args.item)}/summarize`);
    return tool(payload.text ?? `summary written for ${args.item}`);
}

// ─── surfaces shared with the REST routes and the review UI ──────────────

export async function submitIngest(args) {
    return serviceCall('POST', '/api/ingest', ingestArgs(args), { timeoutMs: INGEST_TIMEOUT_MS });
}

export async function readItemPayload(id, { documentChars } = {}) {
    return serviceCall('GET', `/api/items/${encodeURIComponent(id)}/payload${query({ documentChars })}`);
}

export async function regenerateSummary(itemId) {
    const payload = await serviceCall('POST', `/api/items/${encodeURIComponent(itemId)}/summarize`);
    return tool(payload.text ?? `summary written for ${itemId}`);
}

/// Translate a service job into the shape the review UI already renders: the
/// UI reads `job.args.depth`, `job.activity`, `job.activityCount` and
/// `job.steps`. The service owns the truth; these are compatibility fields.
export function uiJob(job) {
    if (!job) return job;
    return {
        ...job,
        args: { ...(job.args ?? {}), depth: job.depth },
        activity: job.activity ?? [],
        activityCount: job.activityCount ?? 0,
        position: job.position ?? null
    };
}

function uiEventType(job) {
    switch (job.state) {
        case 'queued': return 'job.queued';
        case 'done': return 'job.done';
        case 'failed':
        case 'interrupted': return 'job.failed';
        case 'cancelled': return 'job.cancelled';
        default: return job.steps?.length ? 'job.update' : 'job.started';
    }
}

/// Subscribe to the service's SSE stream and re-emit the event vocabulary the
/// existing review UI listens for. Returns a close function.
export async function subscribeJobs(onEvent, { onError } = {}) {
    const controller = new AbortController();
    const response = await fetch(`${serviceUrl}/api/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal
    });
    if (!response.ok || !response.body) {
        throw new Error(`nconvert: event stream → ${response.status}`);
    }

    (async () => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let boundary;
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const data = frame
                        .split('\n')
                        .filter((line) => line.startsWith('data:'))
                        .map((line) => line.slice(5).trim())
                        .join('');
                    if (!data) continue;
                    const job = JSON.parse(data);
                    onEvent(uiEventType(job), { job: uiJob(job) });
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError') onError?.(error);
        }
    })();

    return () => controller.abort();
}
