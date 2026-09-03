import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { createProgressReporter } from '../../utils/progress-reporter.js';

const logger = getLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const DEFAULTS = {
    dir: 'data/chat/sessions',
    maxHopsPerSend: 25,
    maxConcurrentRuns: 4,
    toolsExclude: [],
    requestTimeoutMs: 120000,
    // Hard cap per injected file. storage.read returns a POINTER envelope
    // above its inline threshold (an MCP transport limit, irrelevant
    // in-process) — injecting that pointer would be silent data loss (round-2
    // feedback). inject stats the file and reads one full-size offset/length
    // window (plain text, no envelope, no UTF-8 boundary splits). Beyond this
    // cap the caller must pre-chunk — fail loud, never inject a fragment.
    maxInjectFileBytes: 5 * 1024 * 1024
};

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Fixed extractive summary prompt (spec §9 R6 — no knob; callers wanting a
// custom summary do history → external summarize → inject + truncate).
const SUMMARY_PROMPT = 'Compress the following conversation segment, preserving facts, decisions, and open threads. Output only the compressed summary.';

let CONFIG;
let SESSIONS_DIR;
let GATEWAY;
let TOOL_ROUTER; // { call(method, payload, ctx), methods[] } — holder captured at
                 // init, filled by server.js once routeCompactCall exists.

// Per-session promise-chain queue: concurrent sends to one session execute in
// arrival order; each caller gets its own reply (spec §2.3).
const QUEUES = new Map();

// Cross-session concurrency bound (spec §2.2). Sessions executing a run right now.
let activeRuns = 0;

// ── Run-activity registry (chat_status) ──────────────────────────────────────
// Pure in-memory record of running/last runs per session, for outside
// observers polling chat.status. Never touches the per-session queue and
// never reads session files. Nothing persisted — the registry dies with the
// process (documented, acceptable: it describes live/recent activity only).
// Entry: { phase, hops, currentTool, detail, phaseSince, startedAt, updatedAt, tokensSoFar, lastEvents }
// phase: 'queued' | 'waiting-gateway' | 'tool-call' | 'idle' | 'error'
// detail: latest fine-grained progress message from INSIDE the running tool
// (workshop tools emit ctx.progress; captured here instead of discarded).
// phaseSince: when the current phase began — observers render elapsed time.
const ACTIVITY = new Map(); // sessionName -> entry
const LAST_EVENTS_CAP = 20;

function updateActivity(name, event, patch = {}) {
    let entry = ACTIVITY.get(name);
    if (!entry) {
        entry = { phase: 'queued', hops: 0, currentTool: null, detail: null, phaseSince: now(), startedAt: now(), updatedAt: now(), tokensSoFar: 0, lastEvents: [] };
        ACTIVITY.set(name, entry);
    }
    if (event) {
        entry.lastEvents.push({ at: now(), event });
        if (entry.lastEvents.length > LAST_EVENTS_CAP) {
            entry.lastEvents.splice(0, entry.lastEvents.length - LAST_EVENTS_CAP);
        }
    }
    Object.assign(entry, patch);
    entry.updatedAt = now();
    return entry;
}

const now = () => new Date().toISOString();

function requireString(args, field) {
    const v = args?.[field];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`chat: '${field}' is required (non-empty string)`);
    return v;
}

function toMcp(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function sessionPath(name) {
    return path.join(SESSIONS_DIR, `${name}.json`);
}

function loadSession(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
        throw new Error(`Invalid session name: ${name} (allowed charset: [a-z0-9][a-z0-9._-]*)`);
    }
    const p = sessionPath(name);
    if (!fs.existsSync(p)) throw new Error(`session not found: ${name}`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function persist(session) {
    session.updatedAt = now();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(sessionPath(session.name), JSON.stringify(session, null, 2));
}

function historyBytes(messages) {
    return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

async function assertKnownModel(model) {
    const models = await GATEWAY.listModels('chat');
    if (!Array.isArray(models) || !models.some(m => m.id === model)) {
        throw new Error(`Unknown gateway chat model: ${model} (validated against listModels('chat'))`);
    }
}

// The tool router holder is captured at init but filled by server.js after
// loadAgents returns — resolve lazily per call and fail loud if absent.
function toolRouter() {
    if (typeof TOOL_ROUTER.call !== 'function') {
        throw new Error('chat: tool router not wired — server startup incomplete');
    }
    return TOOL_ROUTER;
}

function advertisedMethods() {
    const { methods } = toolRouter();
    if (!Array.isArray(methods) || methods.length === 0) {
        throw new Error('chat: tool router has no method catalog — server startup incomplete');
    }
    return methods.filter(m => !CONFIG.toolsExclude.some(prefix => m.startsWith(prefix)));
}

function isExcluded(method) {
    return CONFIG.toolsExclude.some(prefix => method.startsWith(prefix));
}

// Extract the per-method signature lines ("  agent.action — { payload shape }")
// from the full server catalog prose, restricted to advertised methods. Arg
// shapes on the wire stop spawned models from guessing field names (round-2
// feedback: research.topic called with {topic} instead of {query}).
function catalogSignatures(methods) {
    const description = toolRouter().description;
    if (typeof description !== 'string' || !description) return methods.map(m => `  ${m}`);
    const wanted = new Set(methods);
    const lines = [];
    for (const line of description.split('\n')) {
        const m = line.match(/^\s{2}([a-z_]+\.[a-z_]+)\s+—\s+(.*)$/i);
        if (m && wanted.has(m[1])) lines.push(`  ${m[1]} — ${m[2].trim()}`);
    }
    // Any advertised method without a prose signature still appears (name only).
    const covered = new Set(lines.map(l => l.trim().split(' ')[0]));
    for (const m of methods) if (!covered.has(m)) lines.push(`  ${m}`);
    return lines;
}

function buildDispatcherDescription() {
    const methods = advertisedMethods();
    return [
        'Call workshop MCP tools through this single dispatcher.',
        'Provide { "method": "<agent.action>", "payload": { ...args } }.',
        'The response is { content: [{ type: "text", text }], isError } — the real result is in content[0].text; isError:true means the call failed.',
        'AVAILABLE METHODS (name — payload shape, * = required):',
        ...catalogSignatures(methods)
    ].join('\n');
}

function dispatcherDef() {
    return {
        type: 'function',
        function: {
            name: 'workshop',
            description: buildDispatcherDescription(),
            parameters: {
                type: 'object',
                properties: {
                    method: { type: 'string', description: "agent.action method, e.g. 'memory.recall'" },
                    payload: { type: 'object', description: 'Arguments for the method' }
                },
                required: ['method']
            }
        }
    };
}

// Stored messages carry extra fields (createdAt, toolName, toolStatus, model,
// usage). The wire form carries only what the chat-completions API expects.
function toWire(messages) {
    return messages.map(m => {
        const w = { role: m.role, content: m.content };
        if (m.tool_calls) w.tool_calls = m.tool_calls;
        if (m.tool_call_id) w.tool_call_id = m.tool_call_id;
        return w;
    });
}

function mergeUsage(total, usage) {
    if (!usage) return;
    total.prompt_tokens += usage.prompt_tokens || 0;
    total.completion_tokens += usage.completion_tokens || 0;
    total.total_tokens += usage.total_tokens || 0;
}

// One tool call from the session model → one stored tool-result message.
// Failures become toolStatus:"error" results the model can see and adapt to
// (spec §6) — the loop stays alive.
async function executeToolCall(toolCall, ctx, chain, sessionName, pr, hop) {
    const fn = toolCall.function || {};
    const fail = (msg) => ({
        stored: {
            role: 'tool',
            content: `Tool error: ${msg}`,
            createdAt: now(),
            tool_call_id: toolCall.id,
            toolName: fn.name,
            toolStatus: 'error'
        },
        status: 'error'
    });

    if (fn.name !== 'workshop') {
        return fail(`unknown tool '${fn.name}' — only the 'workshop' dispatcher is available`);
    }
    let parsed;
    try {
        parsed = JSON.parse(fn.arguments);
    } catch (err) {
        return fail(`invalid JSON arguments: ${err.message} (raw: ${String(fn.arguments).slice(0, 200)})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fail(`dispatcher arguments must be an object {method, payload}, got: ${JSON.stringify(parsed).slice(0, 200)}`);
    }
    const { method, payload } = parsed;
    if (typeof method !== 'string' || !method.trim()) {
        return fail(`dispatcher payload must include a string 'method' (agent.action form), got: ${JSON.stringify(parsed).slice(0, 200)}`);
    }
    if (isExcluded(method)) {
        return fail(`method '${method}' is excluded from this session's tool catalog (agents.chat.toolsExclude)`);
    }

    // Thread the run chain into the nested call: ancestors + this session.
    // A nested chat.send whose target is already in the chain throws inside
    // routeToolCall and comes back here as a tool-result error (spec §2.2.1).
    // prompts must be a Map: routeToolCall re-scopes via prompts.get(agentName),
    // but our ctx.prompts was already re-scoped to a plain object by our own
    // dispatch — passing it through would crash every nested call.
    const nestedCtx = { ...ctx, runChain: [...chain, sessionName], prompts: new Map() };
    // Capture the tool's OWN progress messages into the registry (round-3
    // feedback: workshop tools report phases via ctx.progress — research,
    // storage batch, memory ops — and they were discarded at the session
    // boundary). detail is a field, not a ring event: progress chatter would
    // flood lastEvents. The original progress fn still fires (outer caller's
    // progressToken keeps its events).
    const outerProgress = typeof ctx?.progress === 'function' ? ctx.progress : null;
    nestedCtx.progress = (msg, pct, total) => {
        updateActivity(sessionName, null, { detail: typeof msg === 'string' ? msg.slice(0, 300) : String(msg) });
        if (outerProgress) outerProgress(msg, pct, total);
    };
    const router = toolRouter();

    // Progress + registry: executing → ok/error with duration. Nested sends
    // inherit ctx (spread above), so their events flow to the outer caller's
    // progressToken — desired: nested activity surfaces at top level.
    const startedAt = Date.now();
    const executing = `hop ${hop}: executing ${method}`;
    pr.set(executing, Math.min(95, hop * 5), true);
    updateActivity(sessionName, executing, { phase: 'tool-call', hops: hop, currentTool: method, detail: null, phaseSince: now() });

    const toolDone = (status) => {
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        const event = `hop ${hop}: ${method} ${status} (${secs}s)`;
        pr.set(event, Math.min(95, hop * 5 + 3), true);
        updateActivity(sessionName, event, { currentTool: null, detail: null });
    };

    let result;
    try {
        result = await router.call(method, payload ?? {}, nestedCtx);
    } catch (err) {
        toolDone('error');
        return fail(err.message);
    }
    const text = Array.isArray(result?.content)
        ? result.content.map(c => c.text ?? '').join('\n')
        : JSON.stringify(result);
    const status = result?.isError ? 'error' : 'success';
    toolDone(status);
    return {
        stored: {
            role: 'tool',
            content: text,
            createdAt: now(),
            tool_call_id: toolCall.id,
            toolName: method,
            toolStatus: status
        },
        method,
        status
    };
}

// Serialize per session: the queued tail never rejects (a failed run must not
// poison the next caller), but the caller-facing promise does (routeToolCall
// wraps the throw as a tool-result error).
function enqueue(name, task) {
    const prev = QUEUES.get(name) || Promise.resolve();
    const run = prev.then(task);
    QUEUES.set(name, run.catch(() => {}));
    return run;
}

// One retry on CONNECTION-LEVEL gateway failures only ('fetch failed',
// ECONNREFUSED — gateway process unreachable, e.g. a restart blip). HTTP
// errors, timeouts, and tool errors are NOT retried — they carry information
// the caller must see. If the retry also fails, the error is re-thrown with
// model-readable guidance: a transient failure made one calling model abandon
// the chat tool entirely as 'broken' (2026-09-03) — the message must make
// clear the session and its history are intact and retrying is safe.
const TRANSIENT_RETRY_DELAY_MS = 3000;

function isConnectionFailure(err) {
    return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|Gateway connection failed/i.test(err?.message || '');
}

async function chatWithTransientRetry({ model, wire, name, hops }) {
    const call = () => GATEWAY.chat({
        model,
        messages: wire,
        stream: false,
        tools: [dispatcherDef()],
        timeoutMs: CONFIG.requestTimeoutMs
    });
    try {
        return await call();
    } catch (err) {
        if (!isConnectionFailure(err)) throw err;
        logger.warn(`[Chat] hop ${hops} gateway connection failed for session '${name}' — retrying once in ${TRANSIENT_RETRY_DELAY_MS / 1000}s (${err.message})`, null, 'Chat');
        updateActivity(name, `hop ${hops}: gateway unreachable — retrying once`, { detail: 'gateway retry' });
        await new Promise(r => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
        try {
            return await call();
        } catch (retryErr) {
            if (!isConnectionFailure(retryErr)) throw retryErr;
            throw new Error(
                `chat_send: gateway unreachable after 2 attempts (${retryErr.message}). ` +
                `This is a TRANSIENT infrastructure failure, not a session problem: session '${name}' and its history are intact and unchanged. ` +
                `Wait a few seconds and retry the same chat.send — do NOT treat the chat tool as broken.`
            );
        }
    }
}

async function runSend({ name, message, model: modelOverride, ctx, chain }) {
    if (activeRuns >= CONFIG.maxConcurrentRuns) {
        throw new Error(`chat_send: maxConcurrentRuns reached (${activeRuns}/${CONFIG.maxConcurrentRuns} active) — retry later`);
    }
    activeRuns++;
    // Fresh registry entry for this run (resets any previous idle/error
    // summary) + progress reporter bound to the caller's progressToken.
    updateActivity(name, null, { phase: 'queued', hops: 0, currentTool: null, tokensSoFar: 0, lastEvents: [], startedAt: now() });
    const pr = createProgressReporter(ctx?.progress);
    try {
        const session = loadSession(name);
        const model = modelOverride || session.model;
        // Send atomicity (spec §6 R2): the user message is persisted only with
        // the first hop's outcome — a failed send leaves no trace.
        const newMessages = [{ role: 'user', content: message, createdAt: now() }];
        const toolCallSummaries = [];
        const usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let hops = 0;
        let reply = null;

        while (true) {
            hops++;
            if (hops > CONFIG.maxHopsPerSend) {
                throw new Error(`chat_send: hop cap exceeded (${CONFIG.maxHopsPerSend}) on session '${name}' after ${hops - 1} completed hops — history persists through the last completed hop; inspect via chat.history and continue with a new send`);
            }
            const wire = [
                ...(session.systemPrompt ? [{ role: 'system', content: session.systemPrompt }] : []),
                ...toWire(session.messages),
                ...toWire(newMessages)
            ];
            const waiting = `hop ${hops}: waiting for gateway`;
            pr.set(waiting, Math.min(95, hops * 5), true);
            updateActivity(name, waiting, { phase: 'waiting-gateway', hops, detail: null, phaseSince: now() });
            const res = await chatWithTransientRetry({ model, wire, name, hops });
            mergeUsage(usageTotal, res.usage);
            updateActivity(name, null, { tokensSoFar: usageTotal.total_tokens });

            if (res.finish_reason === 'tool_calls') {
                if (!Array.isArray(res.tool_calls) || res.tool_calls.length === 0) {
                    throw new Error(`chat_send: gateway returned finish_reason 'tool_calls' with an empty tool_calls list (session '${name}')`);
                }
                // Sanitize malformed tool-call arguments BEFORE they enter
                // history: a truncated args string persisted verbatim poisons
                // every follow-up request (provider validates history
                // tool_calls → 502 on all subsequent turns). '{}' keeps the
                // wire valid; executeToolCall's parse-error result tells the
                // model the call failed.
                for (const tc of res.tool_calls) {
                    const raw = tc?.function?.arguments;
                    if (typeof raw !== 'string') continue;
                    try { JSON.parse(raw); } catch {
                        logger.warn(`[Chat] sanitizing malformed tool-call arguments before persist (session '${name}', tool '${tc.function?.name}', raw: ${raw.slice(0, 120)})`, null, 'Chat');
                        tc.function.arguments = '{}';
                    }
                }
                newMessages.push({ role: 'assistant', content: res.content ?? null, createdAt: now(), tool_calls: res.tool_calls });
                for (const tc of res.tool_calls) {
                    const outcome = await executeToolCall(tc, ctx, chain, name, pr, hops);
                    newMessages.push(outcome.stored);
                    const summary = { name: outcome.stored.toolName, status: outcome.status };
                    if (outcome.status === 'error') summary.error = String(outcome.stored.content ?? '').slice(0, 200);
                    toolCallSummaries.push(summary);
                }
                // One atomic write per completed hop (spec §3): assistant msg +
                // all its tool results land together.
                persist({ ...session, messages: [...session.messages, ...newMessages] });
                continue;
            }
            if (res.finish_reason === 'stop') {
                newMessages.push({ role: 'assistant', content: res.content, createdAt: now(), model, ...(res.usage ? { usage: res.usage } : {}) });
                persist({ ...session, messages: [...session.messages, ...newMessages] });
                reply = res.content;
                break;
            }
            throw new Error(`chat_send: unexpected finish_reason '${res.finish_reason}' from gateway (session '${name}')`);
        }

        const messages = [...session.messages, ...newMessages];
        updateActivity(name, null, { phase: 'idle', currentTool: null });
        pr.done(`complete after ${hops} hop${hops === 1 ? '' : 's'}`);
        return toMcp({
            ok: true,
            name,
            reply,
            toolCalls: toolCallSummaries,
            hops,
            usage: usageTotal,
            messageCount: messages.length,
            historyBytes: historyBytes(messages)
        });
    } catch (err) {
        updateActivity(name, `send failed: ${String(err.message).slice(0, 200)}`, { phase: 'error', currentTool: null });
        throw err;
    } finally {
        activeRuns--;
    }
}

export async function init(context) {
    const agentConfig = context?.config?.agents?.chat;
    if (!agentConfig) throw new Error('chat.init: config.agents.chat is required');
    if (!context?.gateway) throw new Error('chat.init: context.gateway is required');
    if (!context?.toolRouter) throw new Error('chat.init: context.toolRouter is required (server must provide the tool router holder)');
    CONFIG = {
        dir: agentConfig.dir ?? DEFAULTS.dir,
        maxHopsPerSend: agentConfig.maxHopsPerSend ?? DEFAULTS.maxHopsPerSend,
        maxConcurrentRuns: agentConfig.maxConcurrentRuns ?? DEFAULTS.maxConcurrentRuns,
        toolsExclude: agentConfig.toolsExclude ?? DEFAULTS.toolsExclude,
        requestTimeoutMs: agentConfig.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
        maxInjectFileBytes: agentConfig.maxInjectFileBytes ?? DEFAULTS.maxInjectFileBytes
    };
    if (!Array.isArray(CONFIG.toolsExclude)) throw new Error('chat.init: agents.chat.toolsExclude must be an array of method prefixes');
    SESSIONS_DIR = path.resolve(PROJECT_ROOT, CONFIG.dir);
    GATEWAY = context.gateway;
    TOOL_ROUTER = context.toolRouter;
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    logger.info(`[Chat] sessions dir: ${SESSIONS_DIR} (maxHops=${CONFIG.maxHopsPerSend}, maxConcurrent=${CONFIG.maxConcurrentRuns})`, null, 'Chat');
    return { name: 'chat' };
}

export async function chat_create(args) {
    const name = requireString(args, 'name');
    const model = requireString(args, 'model');
    if (!NAME_RE.test(name)) throw new Error(`chat_create: invalid name '${name}' — must match [a-z0-9][a-z0-9._-]*`);
    if (args.systemPrompt !== undefined && typeof args.systemPrompt !== 'string') throw new Error('chat_create: systemPrompt must be a string');
    if (fs.existsSync(sessionPath(name))) throw new Error(`chat_create: session '${name}' already exists`);
    await assertKnownModel(model);
    const session = {
        name,
        model,
        systemPrompt: args.systemPrompt ?? null,
        createdAt: now(),
        updatedAt: now(),
        messages: []
    };
    persist(session);
    return toMcp({ ok: true, name, model, messageCount: 0, historyBytes: 0 });
}

export async function chat_send(args, ctx) {
    const name = requireString(args, 'name');
    const message = requireString(args, 'message');
    let modelOverride = null;
    if (args.model !== undefined) {
        if (typeof args.model !== 'string' || !args.model) throw new Error('chat_send: model must be a non-empty string when provided');
        modelOverride = args.model;
        await assertKnownModel(modelOverride);
    }
    // Run-chain cycle guard (spec §2.2.1) — checked BEFORE queueing: a cyclic
    // send fails immediately as a tool-result error, never deadlocks on the
    // per-session queue. Self-send is the trivial case (name is always in its
    // own chain). At top level the chain is empty.
    const chain = Array.isArray(ctx?.runChain) ? ctx.runChain : [];
    if (chain.includes(name)) {
        throw new Error(`session ${name} is already upstream in this call chain`);
    }
    return enqueue(name, () => runSend({ name, message, model: modelOverride, ctx, chain }));
}

export async function chat_inject(args, ctx) {
    const name = requireString(args, 'name');
    const { messages, files } = args;
    if ((messages?.length ?? 0) === 0 && (files?.length ?? 0) === 0) {
        throw new Error('chat_inject: at least one of messages[] or files[] is required');
    }
    const session = loadSession(name);
    const added = [];

    if (messages !== undefined) {
        if (!Array.isArray(messages)) throw new Error('chat_inject: messages must be an array of {role, content}');
        for (const m of messages) {
            if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
                throw new Error(`chat_inject: message role must be 'user' or 'assistant', got '${m?.role}'`);
            }
            if (typeof m.content !== 'string') throw new Error('chat_inject: message content must be a string');
            added.push({ role: m.role, content: m.content, createdAt: now() });
        }
    }

    if (files !== undefined) {
        if (!Array.isArray(files)) throw new Error('chat_inject: files must be an array of storage paths');
        const router = toolRouter();
        // prompts: fresh Map — our ctx.prompts is the re-scoped plain object,
        // but routeToolCall expects the global Map (prompts.get(agentName)).
        const toolCtx = { ...ctx, prompts: new Map() };
        const callText = async (method, payload) => {
            const result = await router.call(method, payload, toolCtx);
            const text = Array.isArray(result?.content)
                ? result.content.map(c => c.text ?? '').join('\n')
                : null;
            if (result?.isError || text == null) {
                throw new Error(`chat_inject: ${method} failed: ${text ?? 'no content returned'}`);
            }
            return text;
        };
        for (const f of files) {
            if (typeof f !== 'string' || !f) throw new Error('chat_inject: every file path must be a non-empty string');
            const stat = JSON.parse(await callText('storage.stat', { path: f }));
            if (!stat.exists) throw new Error(`chat_inject: file not found: '${f}'`);
            if (stat.size > CONFIG.maxInjectFileBytes) {
                throw new Error(`chat_inject: '${f}' is ${stat.size} bytes, above maxInjectFileBytes (${CONFIG.maxInjectFileBytes}) — pre-chunk the file and inject the parts`);
            }
            // Full-size window: raw text at any size, no pointer envelope.
            const text = stat.size > 0
                ? await callText('storage.read', { path: f, offset: 0, length: stat.size })
                : '';
            added.push({ role: 'user', content: `=== storage:${f} ===\n${text}`, createdAt: now() });
        }
    }

    session.messages.push(...added);
    persist(session);
    return toMcp({
        ok: true,
        name,
        injected: added.length,
        messageCount: session.messages.length,
        historyBytes: historyBytes(session.messages)
    });
}

export async function chat_list() {
    if (!fs.existsSync(SESSIONS_DIR)) return toMcp({ ok: true, sessions: [] });
    const sessions = fs.readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')))
        .map(s => ({
            name: s.name,
            model: s.model,
            messageCount: s.messages.length,
            historyBytes: historyBytes(s.messages),
            createdAt: s.createdAt,
            updatedAt: s.updatedAt
        }));
    return toMcp({ ok: true, sessions });
}

// Live activity of running/last runs, from the in-memory registry only.
// Never touches the per-session queue, never reads session files. Polling a
// session that has not run yet is normal — phase 'never-run', not an error.
export async function chat_status(args) {
    if (args?.name !== undefined) {
        const name = requireString(args, 'name');
        const entry = ACTIVITY.get(name);
        if (!entry) return toMcp({ ok: true, name, phase: 'never-run' });
        return toMcp({ ok: true, name, ...entry, lastEvents: [...entry.lastEvents] });
    }
    const sessions = [...ACTIVITY.entries()].map(([name, e]) => ({
        name,
        phase: e.phase,
        hops: e.hops,
        currentTool: e.currentTool,
        detail: e.detail,
        phaseSince: e.phaseSince,
        startedAt: e.startedAt,
        updatedAt: e.updatedAt,
        tokensSoFar: e.tokensSoFar,
        lastEvents: e.lastEvents.length
    }));
    return toMcp({ ok: true, sessions });
}

export async function chat_history(args) {
    const name = requireString(args, 'name');
    const session = loadSession(name);
    let messages = session.messages;
    if (args.lastN !== undefined) {
        if (typeof args.lastN !== 'number' || args.lastN < 1) throw new Error('chat_history: lastN must be a positive number');
        messages = messages.slice(-Math.floor(args.lastN));
    }
    return toMcp({ ok: true, name, messageCount: session.messages.length, historyBytes: historyBytes(session.messages), messages });
}

export async function chat_update(args) {
    const name = requireString(args, 'name');
    const session = loadSession(name);
    if (args.systemPrompt === undefined && args.model === undefined) {
        throw new Error('chat_update: at least one of systemPrompt or model is required');
    }
    if (args.systemPrompt !== undefined) {
        if (typeof args.systemPrompt !== 'string') throw new Error('chat_update: systemPrompt must be a string');
        session.systemPrompt = args.systemPrompt;
    }
    if (args.model !== undefined) {
        if (typeof args.model !== 'string' || !args.model) throw new Error('chat_update: model must be a non-empty string');
        await assertKnownModel(args.model);
        session.model = args.model;
    }
    persist(session);
    return toMcp({ ok: true, name, model: session.model, messageCount: session.messages.length, historyBytes: historyBytes(session.messages) });
}

export async function chat_compact(args, ctx) {
    const name = requireString(args, 'name');
    const strategy = requireString(args, 'strategy');
    const session = loadSession(name);

    if (strategy === 'clear') {
        const keep = args.keep ?? 0;
        if (typeof keep !== 'number' || keep < 0) throw new Error('chat_compact: keep must be a non-negative number');
        session.messages = session.messages.slice(-Math.floor(keep));
        persist(session);
        return toMcp({ ok: true, name, strategy, messageCount: session.messages.length, historyBytes: historyBytes(session.messages) });
    }

    if (strategy === 'truncate') {
        if (typeof args.keep !== 'number' || args.keep < 0) {
            throw new Error('chat_compact: truncate requires keep (number of last messages to keep)');
        }
        session.messages = session.messages.slice(-Math.floor(args.keep));
        persist(session);
        return toMcp({ ok: true, name, strategy, messageCount: session.messages.length, historyBytes: historyBytes(session.messages) });
    }

    if (strategy === 'summarize') {
        if (typeof args.upTo !== 'number' || args.upTo < 1 || args.upTo > session.messages.length) {
            throw new Error(`chat_compact: summarize requires upTo in [1..${session.messages.length}] (messages to replace, exclusive end)`);
        }
        let model = session.model;
        if (args.model !== undefined) {
            if (typeof args.model !== 'string' || !args.model) throw new Error('chat_compact: model must be a non-empty string when provided');
            model = args.model;
            await assertKnownModel(model);
        }
        const segment = session.messages.slice(0, Math.floor(args.upTo));
        const transcript = segment
            .map(m => `${m.role}: ${m.content ?? JSON.stringify(m.tool_calls)}`)
            .join('\n\n');
        const res = await GATEWAY.chat({
            model,
            messages: [{ role: 'user', content: `${SUMMARY_PROMPT}\n\n${transcript}` }],
            stream: false,
            timeoutMs: CONFIG.requestTimeoutMs
        });
        if (!res.content) throw new Error('chat_compact: summarize produced empty content — history left untouched');
        // Summary stored as role:"user" with [context summary] prefix (spec §9 R1).
        const summaryMsg = { role: 'user', content: `[context summary] ${res.content}`, createdAt: now() };
        session.messages = [summaryMsg, ...session.messages.slice(Math.floor(args.upTo))];
        persist(session);
        return toMcp({
            ok: true,
            name,
            strategy,
            summaryChars: res.content.length,
            messageCount: session.messages.length,
            historyBytes: historyBytes(session.messages),
            usage: res.usage
        });
    }

    throw new Error(`chat_compact: unknown strategy '${strategy}' (expected clear | truncate | summarize)`);
}

export async function chat_delete(args) {
    const name = requireString(args, 'name');
    loadSession(name); // throws 'session not found' for unknown names
    fs.unlinkSync(sessionPath(name));
    return toMcp({ ok: true, name, deleted: true });
}
