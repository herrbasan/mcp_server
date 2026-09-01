import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const DEFAULTS = {
    dir: 'data/chat/sessions',
    maxHopsPerSend: 25,
    maxConcurrentRuns: 4,
    toolsExclude: [],
    requestTimeoutMs: 120000
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

function buildDispatcherDescription() {
    const methods = advertisedMethods();
    return [
        'Call workshop MCP tools through this single dispatcher.',
        'Provide { "method": "<agent.action>", "payload": { ...args } }.',
        'The response is { content: [{ type: "text", text }], isError } — the real result is in content[0].text; isError:true means the call failed.',
        'AVAILABLE METHODS:',
        ...methods.map(m => `  ${m}`)
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
async function executeToolCall(toolCall, ctx, chain, sessionName) {
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
    const router = toolRouter();
    let result;
    try {
        result = await router.call(method, payload ?? {}, nestedCtx);
    } catch (err) {
        return fail(err.message);
    }
    const text = Array.isArray(result?.content)
        ? result.content.map(c => c.text ?? '').join('\n')
        : JSON.stringify(result);
    const status = result?.isError ? 'error' : 'success';
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

async function runSend({ name, message, model: modelOverride, ctx, chain }) {
    if (activeRuns >= CONFIG.maxConcurrentRuns) {
        throw new Error(`chat_send: maxConcurrentRuns reached (${activeRuns}/${CONFIG.maxConcurrentRuns} active) — retry later`);
    }
    activeRuns++;
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
            const res = await GATEWAY.chat({
                model,
                messages: wire,
                stream: false,
                tools: [dispatcherDef()],
                timeoutMs: CONFIG.requestTimeoutMs
            });
            mergeUsage(usageTotal, res.usage);

            if (res.finish_reason === 'tool_calls') {
                if (!Array.isArray(res.tool_calls) || res.tool_calls.length === 0) {
                    throw new Error(`chat_send: gateway returned finish_reason 'tool_calls' with an empty tool_calls list (session '${name}')`);
                }
                newMessages.push({ role: 'assistant', content: res.content ?? null, createdAt: now(), tool_calls: res.tool_calls });
                for (const tc of res.tool_calls) {
                    const outcome = await executeToolCall(tc, ctx, chain, name);
                    newMessages.push(outcome.stored);
                    toolCallSummaries.push({ name: outcome.stored.toolName, status: outcome.status });
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
        requestTimeoutMs: agentConfig.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs
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
        for (const f of files) {
            if (typeof f !== 'string' || !f) throw new Error('chat_inject: every file path must be a non-empty string');
            // prompts: fresh Map — our ctx.prompts is the re-scoped plain object,
            // but routeToolCall expects the global Map (prompts.get(agentName)).
            const result = await router.call('storage.read', { path: f }, { ...ctx, prompts: new Map() });
            const text = Array.isArray(result?.content)
                ? result.content.map(c => c.text ?? '').join('\n')
                : null;
            if (result?.isError || text == null) {
                throw new Error(`chat_inject: storage read failed for '${f}': ${text ?? 'no content returned'}`);
            }
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
