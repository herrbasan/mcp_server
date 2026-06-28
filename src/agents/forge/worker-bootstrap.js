import { workerData, parentPort } from 'worker_threads';
import { pathToFileURL } from 'url';
import { writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ── Worker Bootstrap ──────────────────────────────────────────────────────────
// Runs inside each worker_thread. Receives { source, args, payload, workspacePath,
// toolStatePath, captureLogs } via workerData, and { gatewayPort, progressPort }
// via the init message.
//
// The tool source is written to a temp file and dynamically imported.
// Gateway and progress are proxied via MessagePort to the main thread.

let gatewayPort = null;
let progressPort = null;
let initialized = false;
let initData = {};
let defaultModel = null;

// Console capture — ALWAYS ON. The LLM authoring the tool needs to see its
// console.log/error output for debugging. This relays everything to the
// orchestrator, which includes it in the forge_call response.
{
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...a) => { parentPort.postMessage({ type: 'log', level: 'log', message: a.map(String).join(' ') }); origLog(...a); };
    console.warn = (...a) => { parentPort.postMessage({ type: 'log', level: 'warn', message: a.map(String).join(' ') }); origWarn(...a); };
    console.error = (...a) => { parentPort.postMessage({ type: 'log', level: 'error', message: a.map(String).join(' ') }); origError(...a); };
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    const { source, args, payload, workspacePath, toolStatePath, storagePath } = { ...workerData, ...initData };

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

    // Build context
    const ctx = {
        gateway: createGatewayProxy(gatewayPort),
        progress: createProgressProxy(progressPort),
        payload: resolvedPayload,
        workspacePath,
        toolStatePath,
        storagePath,
        args
    };

    // Execute — tool return value can be anything, including undefined
    const result = await mod.default(args, ctx);
    parentPort.postMessage({ type: 'result', result });
}

// ── Message Handler ──────────────────────────────────────────────────────────
parentPort.on('message', async (msg) => {
    if (msg.type === 'init') {
        if (initialized) return;
        initialized = true;

        gatewayPort = msg.gatewayPort;
        progressPort = msg.progressPort;
        defaultModel = msg.defaultModel || null;
        initData = { payload: msg.payload || [] };

        try {
            await run();
        } catch (err) {
            parentPort.postMessage({ type: 'error', error: err.message, stack: err.stack });
        }
    }
});

// Handle uncaught errors in the worker — crash loudly, don't hang
process.on('unhandledRejection', (err) => {
    parentPort.postMessage({ type: 'error', error: `Unhandled rejection: ${err?.message || err}`, stack: err?.stack });
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
    parentPort.postMessage({ type: 'error', error: `Uncaught exception: ${err.message}`, stack: err.stack });
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
});
