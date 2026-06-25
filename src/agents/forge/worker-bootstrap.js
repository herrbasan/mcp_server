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

// ── Console capture (optional) ───────────────────────────────────────────────
if (workerData?.captureLogs) {
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
            if (msg.error) resolver.reject(new Error(msg.error));
            else resolver.resolve(msg.result);
        }
    });
    port.start();

    function call(type, params) {
        const id = ++reqId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            port.postMessage({ type: 'gateway-call', id, task: type, params });
        });
    }

    function embed(text) {
        const id = ++reqId;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            port.postMessage({ type: 'gateway-embed', id, text });
        });
    }

    return {
        // Primary API: gateway.chat({ task, messages, systemPrompt, ... })
        chat: (params) => call(params?.task || 'query', params),

        // Embedding shortcut
        embed: embed,
        embedText: embed,

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

    // Write tool source to temp file and import it
    const tempFile = join(tmpdir(), `forge-${randomUUID()}.mjs`);
    await writeFile(tempFile, source);

    let mod;
    try {
        mod = await import(pathToFileURL(tempFile).href);
    } finally {
        // Clean up temp file after import (module is cached in worker memory)
        await import('fs/promises').then(fs => fs.unlink(tempFile).catch(() => {}));
    }

    if (typeof mod.default !== 'function') {
        throw new Error('Forged tool must export a default async function(args, ctx)');
    }

    // Build context
    const ctx = {
        gateway: createGatewayProxy(gatewayPort),
        progress: createProgressProxy(progressPort),
        payload: payload || [],
        workspacePath,
        toolStatePath,
        storagePath,
        args
    };

    // Execute
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
        initData = { payload: msg.payload || [] };

        try {
            await run();
        } catch (err) {
            parentPort.postMessage({ type: 'error', error: err.message, stack: err.stack });
        }
    }
});

// Handle uncaught errors in the worker
process.on('unhandledRejection', (err) => {
    parentPort.postMessage({ type: 'error', error: `Unhandled rejection: ${err?.message || err}` });
});
