import { pathToFileURL } from 'url';
import { spawn as cpSpawn } from 'child_process';
import { register } from 'node:module';
import { writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createFileOps } from '../../lib/fileops.js';
import { createPathTranslator } from '../storage/path-translator.js';

// ── Tool sandbox: refuse the process/thread modules (issue #38) ───────────────
// The guide forbids a direct child_process import because a PID started that way
// is never registered with the orchestrator, so neither the timeout nor
// forge_stop can reap it (observed: an orphaned spawnSync grandchild survived a
// worker termination in data/_test/forge-terminate-uninterruptible.cjs). That
// rule was documentation only until now. Registering a resolve hook here turns it
// into an enforced, loud failure.
//
// Sequencing: this file's own static imports are resolved when the module is
// instantiated, so `spawn` above is already linked and is unaffected. The hook
// applies to everything imported afterwards, which is the tool source (written to
// a temp file and imported inside run()).
//
// Boundary, measured not assumed (data/_test/forge-sandbox-probe.cjs): the hook
// catches static imports, dynamic import(), and string-built specifiers. It does
// NOT catch createRequire(...)('child_process'), which goes through the CJS
// loader. This is a guardrail against an LLM author taking the obvious shortcut,
// not a sandbox against an adversary — and the guide says exactly that.
register(new URL('./deny-hooks.mjs', import.meta.url).href);

// ── Worker Bootstrap ──────────────────────────────────────────────────────────
// Runs inside a forked CHILD PROCESS (one per forge_call). Everything it needs —
// source, args, payload, paths, limits — arrives in the init message, because a
// forked child has no workerData.

let initialized = false;
let initData = {};
let defaultModel = null;
let mcpDepth = 0;

// ── IPC transport ─────────────────────────────────────────────────────────────
// The tool runs in a forked child process rather than a worker thread (issue
// #37). The reason is measured, not theoretical: a V8 heap-limit failure inside a
// worker thread aborts the ENTIRE server process even with resourceLimits set,
// taking every client's session with it. data/_test/forge-oom-probe.cjs
// reproduces that — object churn under a 512 MB cap exits 134 with "FATAL ERROR:
// Reached heap limit". A forked child owns its address space, so an abort there
// kills the tool and nothing else, and taskkill /T reaches it unconditionally
// without asking V8 about safepoints.
//
// The four logical channels (gateway, browser, mcp, progress) are multiplexed over
// the single IPC channel, tagged by `channel`. That is a deliberate simplification:
// the only bulk transfer is the init payload, which arrives BEFORE the tool starts,
// so there is no in-flight relay traffic for it to block. Everything after init is
// small.
//
// channelPort() presents the MessagePort surface the proxies were written against
// (on('message') / postMessage / start / close), so the proxy bodies themselves
// needed no changes for the transport swap. Minimum diff on the most dangerous
// code path is worth a thin adapter.
const CHANNEL_HANDLERS = new Map();

// The parent may be gone while we still have work in flight (cancel, timeout,
// crash). Writing to a closed IPC channel throws ERR_IPC_CHANNEL_CLOSED, and it
// would throw from inside console.log, turning a tool's log line into a crash.
// Dropping the message is the correct answer: nobody is listening.
function safeSend(msg) {
    if (!process.connected) return;
    try {
        process.send(msg);
    } catch {
        // Channel closed between the check and the write — same conclusion.
    }
}

function channelPort(name) {
    return {
        on(event, fn) { if (event === 'message') CHANNEL_HANDLERS.set(name, fn); },
        start() { /* no-op: the process-wide dispatcher below is already live */ },
        close() { CHANNEL_HANDLERS.delete(name); },
        postMessage(msg) { safeSend({ channel: name, ...msg }); }
    };
}

// Lifecycle messages (ready, result, error, log, spawn bookkeeping) carry no
// request/response id and are routed by type on the parent side.
function sendLifecycle(type, payload = {}) {
    safeSend({ channel: 'lifecycle', type, ...payload });
}

// Console capture — ALWAYS ON. The LLM authoring the tool needs to see its
// console.log/error output for debugging; this relays it to the orchestrator,
// which includes it in the forge_call response.
//
// Bounded (issue #49). The cost of a captured line is the structured clone to the
// main thread, so the per-line cap is applied HERE, before postMessage —
// truncating on the receiving side would save nothing. Past the entry limit the
// line is counted, not sent. Main-thread memory is then bounded by
// entries × lineChars, and the channel by entries + one keepalive per interval.
//
// The keepalive is TIME-based, deliberately. A count-based ping (every N dropped
// lines) has a hole exactly where a healthy tool lives: a tool logging slowly —
// below N lines per idle window — goes silent once it passes the cap and gets
// killed for looking hung, where before this change its own logs kept it alive.
// The main thread counts ANY worker message as activity, so one ping per interval
// suffices and the rate is bounded no matter how much the tool logs.
const SUPPRESS_PING_MS = 30000;
let logEntryLimit = 1000;
let logLineChars = 4000;
let logEntriesSent = 0;
let logLinesDropped = 0;
let lastSuppressPingAt = 0;

function truncateLine(s) {
    if (s.length <= logLineChars) return s;
    return `${s.slice(0, logLineChars)}… [+${s.length - logLineChars} chars]`;
}

function emitLog(level, message) {
    if (logEntriesSent < logEntryLimit) {
        logEntriesSent++;
        sendLifecycle('log', { level, message: truncateLine(message) });
        return;
    }
    logLinesDropped++;
    const now = Date.now();
    if (now - lastSuppressPingAt >= SUPPRESS_PING_MS) {
        lastSuppressPingAt = now;
        sendLifecycle('log-suppressed', { count: logLinesDropped });
    }
}

function flushLogSuppressed() {
    if (logLinesDropped > 0) {
        sendLifecycle('log-suppressed', { count: logLinesDropped });
    }
}

{
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...a) => { emitLog('log', a.map(String).join(' ')); origLog(...a); };
    console.warn = (...a) => { emitLog('warn', a.map(String).join(' ')); origWarn(...a); };
    console.error = (...a) => { emitLog('error', a.map(String).join(' ')); origError(...a); };
}

// ── Gateway Proxy ────────────────────────────────────────────────────────────
// The worker gets a proxy object. Calls to gateway.chat() serialize through the
// MessagePort to the main thread, which forwards to the real Gateway WebSocket.
function createGatewayProxy(port) {
    let reqId = 0;
    const pending = new Map();

    port.on('message', (msg) => {
        if (msg.type === 'gateway-result') {
            const resolver = pending.get(msg.id);
            if (!resolver) return;
            pending.delete(msg.id);
            clearTimeout(resolver.timer);
            if (msg.error) resolver.reject(new Error(msg.error));
            else resolver.resolve(msg.result);
        }
    });
    port.start();

    function call(type, params, timeoutMs = 300000) {
        const id = ++reqId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Gateway proxy call timed out after ${timeoutMs}ms (task: ${type})`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });

            // Resolve routing for this single call. Precedence:
            //   1. Explicit per-call `model` in params — wins over everything.
            //   2. Explicit per-call `task` (any non-default) — wins over worker default model.
            //   3. Worker-level `defaultModel` (set via forge_call's `model` arg) — applied silently.
            //   4. Original `type` arg — Gateway's task-based default routing.
            // This keeps tool authors model-agnostic while letting callers pin a model
            // at the call site or per forge_call without breaking compatibility.
            const callParams = params || {};
            const callerModel = callParams.model != null;
            const callerTask = type != null && type !== 'query';

            let resolvedTask, finalParams;
            if (callerModel) {
                resolvedTask = null;
                finalParams = { ...callParams };
            } else if (callerTask) {
                resolvedTask = type;
                finalParams = { ...callParams };
            } else if (defaultModel) {
                resolvedTask = null;
                finalParams = { ...callParams, model: defaultModel };
            } else {
                resolvedTask = type || null;
                finalParams = { ...callParams };
            }

            port.postMessage({ type: 'gateway-call', id, task: resolvedTask, params: finalParams });
        });
    }

    function embed(text, timeoutMs = 60000) {
        const id = ++reqId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Gateway embed timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            port.postMessage({ type: 'gateway-embed', id, text });
        });
    }

    function listModels(type, timeoutMs = 30000) {
        const id = ++reqId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Gateway listModels timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            port.postMessage({ type: 'gateway-list-models', id, type: type || null });
        });
    }

    return {
        // Primary API: gateway.chat({ task, model?, messages, systemPrompt, ... })
        // - task selects the Gateway-resolved default for that task
        // - model overrides the task default with a specific model ID (e.g. "badkid-llama-chat")
        // For compatibility: omit both to use the Gateway's default routing.
        chat: (params) => call(params?.task || 'query', params),

        // Embedding shortcut
        embed: embed,
        embedText: embed,

        // List available models from the Gateway (forwarded as a MessagePort call)
        listModels: listModels,

        // Predict adapter (for tools that use the older API shape)
        predict: (params) => call(params?.task || 'query', params),

        // Raw call for flexibility
        call: (task, params) => call(task, params)
    };
}

// ── Browser Proxy ────────────────────────────────────────────────────────────
// Mirrors the gateway proxy pattern. The worker gets a proxy object with one
// method per browser agent operation. Calls serialize through the MessagePort
// to the main thread, which dispatches to the browser agent's handler directly.
//
// The proxy exposes the full browser API surface:
//   session_create, session_list, session_close, goto, content, click, fill,
//   evaluate, scroll, type, inspect, console, wait, metadata
//
// Each method takes the same args object as the corresponding browser_session_*
// MCP tool and returns the parsed result (text or JSON object).
function createBrowserProxy(port) {
    let reqId = 0;
    const pending = new Map();

    port.on('message', (msg) => {
        if (msg.type === 'browser-result') {
            const resolver = pending.get(msg.id);
            if (!resolver) return;
            pending.delete(msg.id);
            clearTimeout(resolver.timer);
            if (msg.error) resolver.reject(new Error(msg.error));
            else if (msg.result?.isError) resolver.reject(new Error(typeof msg.result.data === 'string' ? msg.result.data : JSON.stringify(msg.result.data)));
            else resolver.resolve(msg.result?.data ?? msg.result);
        }
    });
    port.start();

    function call(method, args, timeoutMs = 120000) {
        const id = ++reqId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Browser proxy call timed out after ${timeoutMs}ms (method: ${method})`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            port.postMessage({ type: 'browser-call', id, method, args: args || {} });
        });
    }

    // Build a proxy object with one method per browser operation.
    // Maps the DOCUMENTED short API name → the browser agent's exported handler.
    // session_create/session_list/session_close keep their prefix; the rest are
    // short (goto, content, ...). Explicit map = no prefix ambiguity.
    const methods = {
        session_create: 'browser_session_create',
        session_list: 'browser_session_list',
        session_close: 'browser_session_close',
        goto: 'browser_session_goto',
        content: 'browser_session_content',
        click: 'browser_session_click',
        fill: 'browser_session_fill',
        evaluate: 'browser_session_evaluate',
        scroll: 'browser_session_scroll',
        type: 'browser_session_type',
        inspect: 'browser_session_inspect',
        console: 'browser_session_console',
        wait: 'browser_session_wait',
        metadata: 'browser_session_metadata'
    };
    const proxy = {};
    for (const [shortName, fullName] of Object.entries(methods)) {
        proxy[shortName] = (args) => call(fullName, args);
    }
    return proxy;
}

// ── MCP Proxy ───────────────────────────────────────────────────────────────
// Relay to the workshop dispatcher on the main thread. Lets forged tools call
// any MCP method (git.*, storage.*, memory.*, vdb.*, llm.*, chat.*, forge.*)
// without holding credentials — GIT_TOKEN etc. stay on the main thread.
// Recursion depth is enforced main-side (nested forge.call gets _depth+1).
function createMcpProxy(port, depth) {
    let reqId = 0;
    const pending = new Map();

    port.on('message', (msg) => {
        if (msg.type === 'mcp-result') {
            const resolver = pending.get(msg.id);
            if (!resolver) return;
            pending.delete(msg.id);
            clearTimeout(resolver.timer);
            if (msg.error) resolver.reject(new Error(msg.error));
            else resolver.resolve(msg.result);
        }
    });
    port.start();

    async function call(method, payload, timeoutMs = 300000) {
        if (typeof method !== 'string' || !method.includes('.')) {
            throw new Error(`ctx.mcp.call: method must be 'agent.action' format, e.g. 'git.issue_list' (got: ${method})`);
        }
        const id = ++reqId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`MCP relay call timed out after ${timeoutMs}ms (method: ${method})`));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            port.postMessage({ type: 'mcp-call', id, method, payload: payload || {} });
        });
    }

    return { call, depth };
}

// ── Progress Proxy ───────────────────────────────────────────────────────────
function createProgressProxy(port) {
    return function progress(message, progressVal, total) {
        // Accept both { message, progress, total } object and (message, progress, total) args
        if (typeof message === 'object' && message !== null) {
            port.postMessage({ type: 'progress', ...message });
        } else {
            port.postMessage({ type: 'progress', message, progress: progressVal, total });
        }
    };
}

// ── Spawn Proxy (issue #43) ──────────────────────────────────────────────────
// ctx.spawn() is THE way forged tools start child processes. Every spawned PID is
// registered with the orchestrator so teardown (timeout, cancel, crash, forge_stop)
// kills the whole tree. With the tool now in its own process (issue #37) the
// orchestrator kills that process with taskkill /T, which reaches these children as
// a subtree — the bookkeeping is what makes the tool's own PID and its children
// addressable, and what lets a child that exited cleanly opt out of being killed.
function createSpawnProxy() {
    return function spawn(cmd, spawnArgs = [], opts = {}) {
        const child = cpSpawn(cmd, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
        if (child.pid) sendLifecycle('spawned', { pid: child.pid });
        const deregister = () => sendLifecycle('spawn-exited', { pid: child.pid });
        child.on('exit', deregister);
        child.on('error', deregister);
        return child;
    };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    const { source, args, payload, workspacePath, toolStatePath, storagePath, vendorPath, uncShare, localRoot } = initData;

    // Payload items arrive as Uint8Arrays after structured clone (postMessage strips
    // Buffer prototype). Convert them back so Buffer.isBuffer() and .toString() work.
    const resolvedPayload = (payload || []).map(item => {
        if (item instanceof Uint8Array && !Buffer.isBuffer(item)) {
            return Buffer.from(item.buffer, item.byteOffset, item.byteLength);
        }
        return item;
    });

    // Write tool source to temp file and import it
    const tempFile = join(tmpdir(), `forge-${randomUUID()}.mjs`);
    await writeFile(tempFile, source);

    let mod;
    try {
        mod = await import(pathToFileURL(tempFile).href);
    } catch (importErr) {
        // Surface the actual error with source line context for self-debugging
        const lines = source.split('\n');
        throw new Error(
            `Import failed: ${importErr.message}\n` +
            `Source preview (first 10 lines):\n${lines.slice(0, 10).map((l, i) => `  ${i + 1}: ${l}`).join('\n')}`
        );
    } finally {
        // Clean up temp file after import (module is cached in worker memory)
        await import('fs/promises').then(fs => fs.unlink(tempFile).catch(() => {}));
    }

    if (typeof mod.default !== 'function') {
        const exports = Object.keys(mod).filter(k => k !== 'default' && !k.startsWith('_'));
        throw new Error(
            `Forged tool must export a default async function(args, ctx). ` +
            `Got default type: ${typeof mod.default}. ` +
            (exports.length ? `Non-default exports found: ${exports.join(', ')}` : 'No exports found.')
        );
    }

    // Build ctx.fileops — confined file ops rooted at THIS tool's
    // storage dir. Forged tools should prefer this over raw fs: every mutation
    // is atomic, and confinement prevents path escapes.
    // workspacePath/toolStatePath intentionally stay raw — ephemeral per-call
    // scratch and git-internal state don't need the fileops engine.
    const translator = (uncShare && localRoot) ? createPathTranslator({ uncShare, localRoot }) : null;
    const fileops = createFileOps({ root: storagePath, translator });

    // Build context
    const ctx = {
        gateway: createGatewayProxy(channelPort('gateway')),
        browser: initData.hasBrowser ? createBrowserProxy(channelPort('browser')) : null,
        mcp: initData.hasMcp ? createMcpProxy(channelPort('mcp'), mcpDepth) : null,
        progress: createProgressProxy(channelPort('progress')),
        spawn: createSpawnProxy(),
        payload: resolvedPayload,
        workspacePath,
        toolStatePath,
        storagePath,
        // Durable, non-output artifacts (a vendored binary, a model blob). Lives
        // outside the source checkout and outside storagePath, so ctx.spawn can
        // reach it and it never shows up in _outputs (issue #39).
        toolVendorPath: vendorPath,
        fileops,
        args
    };

    // Execute — tool return value can be anything, including undefined
    const result = await mod.default(args, ctx);
    flushLogSuppressed();
    sendLifecycle('result', { result });
}

// ── Message Dispatch ────────────────────────────────────────────────────────
// One process-wide listener routes everything: tagged channel traffic to the
// proxy that registered for it, and the init handshake.
process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    const channelHandler = CHANNEL_HANDLERS.get(msg.channel);
    if (channelHandler) {
        channelHandler(msg);
        return;
    }

    if (msg.channel === 'init') {
        if (initialized) return;
        initialized = true;

        defaultModel = msg.defaultModel || null;
        mcpDepth = msg.mcpDepth || 0;
        // Everything the tool needs is in the message now; there is no workerData.
        initData = msg;
        if (Number.isFinite(msg.maxLogEntries)) logEntryLimit = msg.maxLogEntries;
        if (Number.isFinite(msg.maxLogLineChars)) logLineChars = msg.maxLogLineChars;

        // Tell the orchestrator we are wired up. The idle watchdog only arms on
        // this — boot time (module compile under load can exceed the idle window)
        // is covered by the hard runtime cap instead.
        sendLifecycle('ready');

        try {
            await run();
        } catch (err) {
            flushLogSuppressed();
            sendLifecycle('error', { error: err.message, stack: err.stack });
        }
    }
});

// Handle uncaught errors here — crash loudly, don't hang
process.on('unhandledRejection', (err) => {
    sendLifecycle('error', { error: `Unhandled rejection: ${err?.message || err}`, stack: err?.stack });
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
    sendLifecycle('error', { error: `Uncaught exception: ${err.message}`, stack: err.stack });
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
});
