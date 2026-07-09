import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import { MessageChannel } from 'worker_threads';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { createTranslatorFromConfig } from '../storage/path-translator.js';

const logger = getLogger();
const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ── State (set during init) ──────────────────────────────────────────────────
let FORGE_ROOT;       // data/forge/
let TOOLS_DIR;        // data/forge/tools/
let WORKSPACE_DIR;    // data/forge/workspace/
let STORAGE_ROOT;     // e.g. D:\MCP_Storage\forge\
let STORAGE_TRANSLATOR;  // null when no uncShare is configured
let PUBLIC_URL;       // e.g. http://192.168.0.100:3100 — used to build retrieval URLs
let CONFIG;
let GATEWAY_CLIENT;
let GIT_WRITE_QUEUE;
let SEMAPHORE;

// ── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
    defaultTimeout: 300000,
    maxTimeout: 600000,
    maxPayloadSize: 104857600,   // 100 MB per item
    maxPayloadItems: 10,
    maxConcurrentCalls: 8,
    queueTimeout: 30000,
    maxReturnSize: 10240,        // 10 KB inline
    maxRollbackSnapshots: 10,
    allowedPackages: [],
    requireApprovalForNewPackages: true
};

// ── Git Write Queue (serializes all git operations) ──────────────────────────
function createGitWriteQueue() {
    let chain = Promise.resolve();
    return function enqueue(fn) {
        const run = chain.then(fn, fn);
        chain = run.then(() => {}, () => {});
        return run;
    };
}

function isLocalhostUrl(url) {
    if (!url) return true;
    try {
        const u = new URL(url);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    } catch {
        return false;
    }
}

// ── Concurrency Semaphore ────────────────────────────────────────────────────
function createSemaphore(max, queueTimeout) {
    let active = 0;
    const queue = [];
    return function acquire() {
        return new Promise((resolve, reject) => {
            const tryAcquire = () => {
                if (active < max) {
                    active++;
                    resolve(() => { active--; if (queue.length) queue.shift()(); });
                } else {
                    const timer = setTimeout(() => {
                        const idx = queue.indexOf(tryAcquire);
                        if (idx !== -1) queue.splice(idx, 1);
                        reject(new Error(`Forge queue timeout after ${queueTimeout}ms — too many concurrent calls`));
                    }, queueTimeout);
                    const wrapped = () => { clearTimeout(timer); tryAcquire(); };
                    queue.push(wrapped);
                }
            };
            tryAcquire();
        });
    };
}

// ── Git Helpers ──────────────────────────────────────────────────────────────
async function git(args, opts = {}) {
    const { stdout } = await execFileAsync('git', args, {
        cwd: FORGE_ROOT,
        maxBuffer: 10 * 1024 * 1024,
        ...opts
    });
    return stdout.trim();
}

async function gitInit() {
    if (!fs.existsSync(path.join(FORGE_ROOT, '.git'))) {
        await execFileAsync('git', ['init'], { cwd: FORGE_ROOT });
        await execFileAsync('git', ['config', 'user.name', 'Forge Agent'], { cwd: FORGE_ROOT });
        await execFileAsync('git', ['config', 'user.email', 'forge@mcp.local'], { cwd: FORGE_ROOT });

        // .gitignore for state directories
        const gitignorePath = path.join(FORGE_ROOT, '.gitignore');
        const gitignoreContent = [
            '# Per-tool state directories (persistent, not versioned)',
            'tools/*/state/',
            '# Per-call workspace (ephemeral)',
            'workspace/',
            ''
        ].join('\n');
        fs.writeFileSync(gitignorePath, gitignoreContent);
        await execFileAsync('git', ['add', '.gitignore'], { cwd: FORGE_ROOT });
        await execFileAsync('git', ['commit', '-m', 'Forge: initialize repository'], { cwd: FORGE_ROOT });
    }
}

async function gitCommit(message) {
    await execFileAsync('git', ['add', '-A'], { cwd: FORGE_ROOT });
    try {
        await execFileAsync('git', ['commit', '-m', message], { cwd: FORGE_ROOT });
    } catch (e) {
        // "nothing to commit" — not an error
        if (!e.stderr?.includes('nothing to commit') && !e.stdout?.includes('nothing to commit')) throw e;
    }
}

async function gitLog(file, limit = 20) {
    const args = ['log', `--max-count=${limit}`, '--format=%H|%cI|%s'];
    if (file) args.push('--', `tools/${file}.js`);
    const out = await git(args);
    if (!out) return [];
    return out.split('\n').map(line => {
        const [hash, date, ...msgParts] = line.split('|');
        return { hash, date, message: msgParts.join('|') };
    });
}

async function gitShowFile(file, ref) {
    const refPath = ref ? `${ref}:tools/${file}.js` : `HEAD:tools/${file}.js`;
    return git(['show', refPath]);
}

// ── Tool Name Validation ─────────────────────────────────────────────────────
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
function validateName(name) {
    if (!NAME_RE.test(name)) {
        throw new Error(`Invalid tool name "${name}". Must be snake_case: lowercase letters, digits, underscores. Max 64 chars. Must start with a letter.`);
    }
    // Reserved names that could collide with built-in concepts
    const reserved = ['list', 'call', 'write', 'read', 'delete', 'update', 'history', 'rollback', 'tools', 'state', 'workspace'];
    if (reserved.includes(name)) {
        throw new Error(`Tool name "${name}" is reserved. Choose a more specific name.`);
    }
}

// ── Manifest Helpers ─────────────────────────────────────────────────────────
// The manifest is stored as a JSON sidecar: tools/{name}.manifest.json
// It contains description, args schema, packages, and metadata.
// The .js file is the source; the .manifest.json is the contract.

function manifestPath(name) {
    return path.join(TOOLS_DIR, `${name}.manifest.json`);
}

function toolPath(name) {
    return path.join(TOOLS_DIR, `${name}.js`);
}

function statePath(name) {
    return path.join(TOOLS_DIR, name, 'state');
}

function storagePath(name) {
    return path.join(STORAGE_ROOT, name);
}

function readManifest(name) {
    const mp = manifestPath(name);
    if (!fs.existsSync(mp)) return null;
    return JSON.parse(fs.readFileSync(mp, 'utf8'));
}

function writeManifest(name, manifest) {
    fs.writeFileSync(manifestPath(name), JSON.stringify(manifest, null, 2));
}

function toolExists(name) {
    return fs.existsSync(toolPath(name));
}

// ── Package Allowlist ────────────────────────────────────────────────────────
function checkPackages(packages) {
    if (!packages || packages.length === 0) return { pending: false, unapproved: [] };
    const allowed = CONFIG.allowedPackages;
    const unapproved = packages.filter(p => !allowed.includes(p));
    return {
        pending: unapproved.length > 0 && CONFIG.requireApprovalForNewPackages,
        unapproved
    };
}

// ── Payload Resolution ───────────────────────────────────────────────────────
// Resolves payload items (file paths, UNC paths, URLs) to Buffers on the main thread.
// Scenario 3.1-3.6: hostile/missing inputs must fail loudly before worker spawn.

async function resolvePayloadItem(item, index) {
    if (typeof item !== 'string') {
        throw new Error(`payload[${index}] must be a string (file path or URL), got ${typeof item}`);
    }

    // URL → fetch with abort timeout
    if (/^https?:\/\//i.test(item)) {
        const controller = new AbortController();
        const timeoutMs = 30000;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let resp;
        try {
            resp = await fetch(item, { signal: controller.signal });
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                throw new Error(`payload[${index}] fetch timed out after ${timeoutMs}ms — ${item}`);
            }
            throw new Error(`payload[${index}] fetch failed: ${e.message} — ${item}`);
        }
        clearTimeout(timer);
        if (!resp.ok) {
            throw new Error(`payload[${index}] fetch failed: ${resp.status} ${resp.statusText} — ${item}`);
        }
        const arrayBuf = await resp.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        if (buf.length > CONFIG.maxPayloadSize) {
            throw new Error(`payload[${index}] exceeds maxPayloadSize (${buf.length} > ${CONFIG.maxPayloadSize}) — ${item}`);
        }
        return buf;
    }

    // File path (local or UNC) → readFile
    // Translate UNC form of the storage share to the local form first —
    // works for both forge workers (which only see D:\MCP_Storage) and the
    // main-thread resolver (which avoids going through SMB unnecessarily).
    const translated = STORAGE_TRANSLATOR ? STORAGE_TRANSLATOR.toLocal(item) : item;
    // Resolve to absolute — relative paths are relative to PROJECT_ROOT (scenario 5.3)
    const resolved = path.isAbsolute(translated) ? translated : path.resolve(PROJECT_ROOT, translated);
    const stat = fs.statSync(resolved);  // Throws ENOENT if missing (scenario 3.1), EACCES if no access
    if (stat.isDirectory()) {
        throw new Error(`payload[${index}] is a directory, not a file: ${item} (scenario 3.2)`);
    }
    if (stat.size > CONFIG.maxPayloadSize) {
        throw new Error(`payload[${index}] exceeds maxPayloadSize (${stat.size} > ${CONFIG.maxPayloadSize}) — ${item}`);
    }
    return fs.readFileSync(resolved);
}

async function resolvePayload(payload) {
    if (!payload || payload.length === 0) return [];
    if (payload.length > CONFIG.maxPayloadItems) {
        throw new Error(`payload has ${payload.length} items, max is ${CONFIG.maxPayloadItems}`);
    }
    // Resolve all in parallel
    return Promise.all(payload.map((item, i) => resolvePayloadItem(item, i)));
}

// ── Result Size Policy ───────────────────────────────────────────────────────
// Oversized results are saved to the tool's persistent storagePath (NOT the
// ephemeral workspace — that gets deleted immediately after the call returns).
// The file then appears in _outputs like any other file the tool produced.
function enforceResultSize(result, storagePathDir) {
    const serialized = typeof result === 'string' ? result : JSON.stringify(result);
    const buf = Buffer.from(serialized, 'utf8');
    if (buf.length <= CONFIG.maxReturnSize) {
        return { result, oversized: false };
    }
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const resultFile = path.join(storagePathDir, `result-${dateStr}.json`);
    fs.writeFileSync(resultFile, serialized);
    const preview = serialized.slice(0, 500);
    return {
        result: {
            oversized: true,
            path: resultFile,
            summary: `Result was ${buf.length} bytes, saved to storagePath`,
            preview,
            totalBytes: buf.length
        },
        oversized: true
    };
}

// ── Storage Snapshot & Diff ──────────────────────────────────────────────────
// Snapshots the file list of a directory (relative paths + sizes + mtimes).
// Used before and after tool execution to detect files the tool created.
// Snapshots are stored in memory only — single call scope.
function snapshotDir(dir) {
    if (!fs.existsSync(dir)) return new Map();
    const out = new Map();
    const walk = (d) => {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.isFile()) {
                const stat = fs.statSync(full);
                const rel = path.relative(dir, full).replace(/\\/g, '/');
                out.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
            }
        }
    };
    walk(dir);
    return out;
}

function diffSnapshots(before, after) {
    const added = [];
    for (const [rel, info] of after) {
        const prev = before.get(rel);
        if (!prev || prev.mtimeMs !== info.mtimeMs) {
            added.push({ rel, size: info.size });
        }
    }
    return added;
}

// ── Workspace Lifecycle ──────────────────────────────────────────────────────
function createWorkspace() {
    const wsPath = path.join(WORKSPACE_DIR, randomUUID());
    fs.mkdirSync(wsPath, { recursive: true });
    return wsPath;
}

function cleanupWorkspace(wsPath) {
    if (wsPath && fs.existsSync(wsPath)) {
        fs.rmSync(wsPath, { recursive: true, force: true });
    }
}

// ── State Snapshot (for rollback) ────────────────────────────────────────────
function snapshotState(name) {
    const sp = statePath(name);
    if (!fs.existsSync(sp)) return;

    const rollbackDir = path.join(sp, '.rollback');
    fs.mkdirSync(rollbackDir, { recursive: true });
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotDir = path.join(rollbackDir, dateStr);
    fs.mkdirSync(snapshotDir, { recursive: true });

    // Copy everything except .rollback itself
    const entries = fs.readdirSync(sp, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '.rollback') continue;
        const src = path.join(sp, entry.name);
        const dst = path.join(snapshotDir, entry.name);
        fs.cpSync(src, dst, { recursive: true });
    }

    // Enforce cap — oldest first
    const snapshots = fs.readdirSync(rollbackDir)
        .map(d => ({ name: d, path: path.join(rollbackDir, d), mtime: fs.statSync(path.join(rollbackDir, d)).mtime }))
        .sort((a, b) => a.mtime - b.mtime);
    while (snapshots.length > CONFIG.maxRollbackSnapshots) {
        const oldest = snapshots.shift();
        fs.rmSync(oldest.path, { recursive: true, force: true });
    }
}

function resetState(name) {
    const sp = statePath(name);
    if (!fs.existsSync(sp)) return;
    const entries = fs.readdirSync(sp, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '.rollback') continue;
        fs.rmSync(path.join(sp, entry.name), { recursive: true, force: true });
    }
}

// ── MCP Result Helper ────────────────────────────────────────────────────────
function mcpOk(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function mcpError(message) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ── Worker Execution ─────────────────────────────────────────────────────────
// The worker bootstrap file path
const WORKER_BOOTSTRAP = path.join(__dirname, 'worker-bootstrap.js');

async function executeInWorker({ name, args, payloadBuffers, workspacePath, toolStatePath, storagePath, timeout, captureLogs, progress, defaultModel }) {
    const sourcePath = toolPath(name);
    const source = fs.readFileSync(sourcePath, 'utf8');
    logger.info(`[Forge:worker] Source loaded for "${name}": ${source.length} chars, spawning worker`, null, 'Forge');

    // Create MessageChannels for gateway and progress relay
    const { port1: gatewayPort1, port2: gatewayPort2 } = new MessageChannel();
    const { port1: progressPort1, port2: progressPort2 } = new MessageChannel();

    // ── Progress relay: worker → main thread → MCP notification ──
    progressPort1.on('message', (msg) => {
        if (msg.type === 'progress') {
            progress?.(msg.message, msg.progress, msg.total);
        }
    });
    progressPort1.start();

    // ── Gateway relay: worker → main thread → WebSocket ──
    // The worker posts { id, task, params } and we forward to GATEWAY_CLIENT,
    // then post the response back.
    gatewayPort1.on('message', async (msg) => {
        if (msg.type === 'gateway-call') {
            const { id, task, params } = msg;
            logger.info(`[Forge:worker] Gateway relay for "${name}": task=${task} model=${params?.model || '(default)'}`, { id }, 'Forge');
            const relayTimeout = 330000;
            try {
                const result = await Promise.race([
                    GATEWAY_CLIENT.chat({ task, ...params }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Gateway relay timed out after ${relayTimeout}ms`)), relayTimeout)
                    )
                ]);
                gatewayPort1.postMessage({ type: 'gateway-result', id, result });
            } catch (err) {
                logger.warn(`[Forge:worker] Gateway relay FAILED for "${name}": ${err.message}`, null, 'Forge');
                gatewayPort1.postMessage({ type: 'gateway-result', id, error: err.message });
            }
        } else if (msg.type === 'gateway-embed') {
            const { id, text } = msg;
            const embedTimeout = 90000;
            try {
                const vector = await Promise.race([
                    GATEWAY_CLIENT.embedText(text),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Gateway embed relay timed out after ${embedTimeout}ms`)), embedTimeout)
                    )
                ]);
                gatewayPort1.postMessage({ type: 'gateway-result', id, result: vector });
            } catch (err) {
                gatewayPort1.postMessage({ type: 'gateway-result', id, error: err.message });
            }
        } else if (msg.type === 'gateway-list-models') {
            const { id, type } = msg;
            const listTimeout = 30000;
            try {
                const models = await Promise.race([
                    GATEWAY_CLIENT.listModels(type),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Gateway listModels relay timed out after ${listTimeout}ms`)), listTimeout)
                    )
                ]);
                gatewayPort1.postMessage({ type: 'gateway-result', id, result: models });
            } catch (err) {
                logger.warn(`[Forge:worker] listModels relay FAILED for "${name}": ${err.message}`, null, 'Forge');
                gatewayPort1.postMessage({ type: 'gateway-result', id, error: err.message });
            }
        }
    });
    gatewayPort1.start();

    // ── Spawn worker ──
    // Ports and payload Buffers are transferred via postMessage (not Worker
    // constructor) for zero-copy transfer. The worker waits for 'init' before running.
    const worker = new Worker(WORKER_BOOTSTRAP, {
        workerData: {
            source,
            args: args || {},
            workspacePath,
            toolStatePath,
            storagePath,
            captureLogs: captureLogs
        },
        resourceLimits: {
            maxOldGenerationSizeMb: 512,
            maxYoungGenerationSizeMb: 128
        }
    });

    // Transfer ports to the worker. Payload Buffers are structured-cloned (copied)
    // — transferring them requires them to be the exact objects in the transferList
    // and causes issues with some Node versions. The copy overhead is acceptable.
    worker.postMessage({ type: 'init', gatewayPort: gatewayPort2, progressPort: progressPort2, payload: payloadBuffers, defaultModel }, [gatewayPort2, progressPort2]);
    logger.info(`[Forge:worker] Worker spawned for "${name}", waiting (timeout: ${timeout}ms)`, null, 'Forge');

    return new Promise((resolve, reject) => {
        let settled = false;
        let receivedResult = false;
        let logs = [];

        const cleanup = () => {
            clearTimeout(timer);
            // Close ports to prevent leaks — removeAllListeners isn't available
            // on MessagePort, so we just stop them from accepting new messages.
            try { gatewayPort1.close(); } catch {}
            try { progressPort1.close(); } catch {}
        };

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            logger.warn(`[Forge:worker] TIMEOUT for "${name}" after ${timeout}ms — terminating`, null, 'Forge');
            cleanup();
            worker.terminate().then(() => {
                reject(new Error(`Tool "${name}" timed out after ${timeout}ms — worker terminated`));
            });
        }, timeout);

        worker.on('message', (msg) => {
            if (msg.type === 'result') {
                if (settled) return;
                settled = true;
                receivedResult = true;
                logger.info(`[Forge:worker] Result from "${name}": ${typeof msg.result === 'string' ? msg.result.length + ' chars' : typeof msg.result}`, null, 'Forge');
                clearTimeout(timer);
                cleanup();
                worker.terminate();
                resolve({ result: msg.result, logs: captureLogs ? logs : undefined });
            } else if (msg.type === 'error') {
                if (settled) return;
                settled = true;
                logger.warn(`[Forge:worker] Error from "${name}": ${msg.error.slice(0, 200)}`, null, 'Forge');
                clearTimeout(timer);
                cleanup();
                worker.terminate();
                reject(new Error(msg.error + (msg.stack ? '\n' + msg.stack : '')));
            } else if (msg.type === 'log' && captureLogs) {
                logs.push(msg);
            }
        });

        worker.on('error', (err) => {
            if (settled) return;
            settled = true;
            logger.warn(`[Forge:worker] Worker error for "${name}": ${err.message}`, null, 'Forge');
            clearTimeout(timer);
            cleanup();
            reject(err);
        });

        worker.on('exit', (code) => {
            if (settled) return;
            settled = true;
            logger.warn(`[Forge:worker] Worker for "${name}" exited with code ${code} (receivedResult=${receivedResult}, logs=${logs.length})`, null, 'Forge');
            clearTimeout(timer);
            cleanup();
            // If the worker exited without sending a result or error message,
            // it crashed — DON'T resolve with undefined, report it as a failure.
            if (receivedResult) {
                resolve({ result: undefined, logs: captureLogs ? logs : undefined });
            } else {
                reject(new Error(
                    `Worker for "${name}" exited with code ${code} without sending a result. ` +
                    `This means the tool crashed or the worker was killed. ` +
                    `Check the tool source for syntax errors, infinite loops, or OOM.`
                ));
            }
        });
    });
}

// ── Tool Handlers ────────────────────────────────────────────────────────────

export async function forge_write(args, context) {
    const { name, description, code, args: argsSchema, packages } = args;

    validateName(name);
    if (!description || typeof description !== 'string') {
        return mcpError('description is required and must be a string');
    }
    if (!code || typeof code !== 'string') {
        return mcpError('code is required and must be a string');
    }

    if (toolExists(name)) {
        return mcpError(`Tool "${name}" already exists. Use forge_update to modify it.`);
    }

    const pkgCheck = checkPackages(packages);

    return GIT_WRITE_QUEUE(async () => {
        // Create tool file
        fs.mkdirSync(TOOLS_DIR, { recursive: true });
        fs.writeFileSync(toolPath(name), code);

        // Create per-tool state directory
        const sp = statePath(name);
        fs.mkdirSync(sp, { recursive: true });

        // Create per-tool storage output directory
        fs.mkdirSync(storagePath(name), { recursive: true });

        // Write manifest
        const manifest = {
            name,
            description,
            args: argsSchema || {},
            packages: packages || [],
            packagesPending: pkgCheck.pending,
            created: new Date().toISOString(),
            lastModified: new Date().toISOString()
        };
        writeManifest(name, manifest);

        await gitCommit(`Forge: create tool "${name}"${pkgCheck.pending ? ' (packages pending approval)' : ''}`);

        return mcpOk({
            op: 'write',
            name,
            packagesPending: pkgCheck.pending,
            unapprovedPackages: pkgCheck.unapproved,
            message: pkgCheck.pending
                ? `Tool created but has unapproved packages: ${pkgCheck.unapproved.join(', ')}. Add them to config.json agents.forge.allowedPackages (or set requireApprovalForNewPackages=false) and restart, then forge_call will work.`
                : `Tool created successfully.`
        });
    });
}

export async function forge_update(args, context) {
    const { name, code, message, args: argsSchema, description } = args;

    if (!toolExists(name)) {
        return mcpError(`Tool "${name}" does not exist. Use forge_write to create it.`);
    }

    return GIT_WRITE_QUEUE(async () => {
        fs.writeFileSync(toolPath(name), code);

        // Update manifest if args or description provided
        const manifest = readManifest(name);
        if (manifest) {
            if (argsSchema) manifest.args = argsSchema;
            if (description) manifest.description = description;
            manifest.lastModified = new Date().toISOString();
            writeManifest(name, manifest);
        }

        const commitMsg = message || `Forge: update tool "${name}"`;
        await gitCommit(commitMsg);

        // Get latest commit hash
        const log = await gitLog(name, 1);

        return mcpOk({
            op: 'update',
            name,
            commit: log[0]?.hash,
            message: 'Tool updated. Old version accessible via forge_read with ref.'
        });
    });
}

export async function forge_read(args, context) {
    const { name, ref } = args;

    if (!toolExists(name) && !ref) {
        return mcpError(`Tool "${name}" does not exist.`);
    }

    try {
        const source = ref ? await gitShowFile(name, ref) : fs.readFileSync(toolPath(name), 'utf8');
        return mcpOk({ name, ref: ref || 'current', source });
    } catch (e) {
        return mcpError(`Failed to read tool "${name}"${ref ? ` at ref ${ref}` : ''}: ${e.message}`);
    }
}

export async function forge_list(args, context) {
    const { name } = args;

    if (name) {
        // Full manifest for one tool
        if (!toolExists(name)) {
            return mcpError(`Tool "${name}" does not exist.`);
        }
        const manifest = readManifest(name) || { name, description: '(no manifest)', args: {} };
        const log = await gitLog(name, 1);
        const stat = fs.statSync(toolPath(name));
        return mcpOk({
            ...manifest,
            version: log[0]?.hash?.slice(0, 7),
            lastModified: manifest.lastModified || stat.mtime.toISOString()
        });
    }

    // Summary list of all tools
    if (!fs.existsSync(TOOLS_DIR)) return mcpOk({ tools: [] });

    const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });
    const tools = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        const toolName = entry.name.slice(0, -3);
        const manifest = readManifest(toolName);
        const stat = fs.statSync(path.join(TOOLS_DIR, entry.name));
        tools.push({
            name: toolName,
            description: manifest?.description || '(no description)',
            packagesPending: manifest?.packagesPending || false,
            lastModified: manifest?.lastModified || stat.mtime.toISOString()
        });
    }
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return mcpOk({ tools, count: tools.length });
}

export async function forge_delete(args, context) {
    const { name } = args;

    if (!toolExists(name)) {
        return mcpError(`Tool "${name}" does not exist.`);
    }

    return GIT_WRITE_QUEUE(async () => {
        // Remove source and manifest
        fs.unlinkSync(toolPath(name));
        const mp = manifestPath(name);
        if (fs.existsSync(mp)) fs.unlinkSync(mp);

        // Remove state directory
        const toolDir = path.join(TOOLS_DIR, name);
        if (fs.existsSync(toolDir)) {
            fs.rmSync(toolDir, { recursive: true, force: true });
        }

        // Remove storage output directory
        const sd = storagePath(name);
        if (fs.existsSync(sd)) {
            fs.rmSync(sd, { recursive: true, force: true });
        }

        await gitCommit(`Forge: delete tool "${name}"`);

        return mcpOk({
            op: 'delete',
            name,
            message: 'Tool deleted. Recoverable from git history via forge_rollback.'
        });
    });
}

export async function forge_call(args, context) {
    const { name, args: toolArgs, payload, timeout: reqTimeout, model } = args;
    const startedAt = Date.now();

    logger.info(`[Forge] forge_call START: "${name}"`, { args: toolArgs, payload, timeout: reqTimeout, model: model || '(default)' }, 'Forge');

    if (!toolExists(name)) {
        logger.warn(`[Forge] forge_call REJECT: "${name}" does not exist`, null, 'Forge');
        return mcpError(`Tool "${name}" does not exist. Use forge_list to see available tools.`);
    }

    // Check package approval status
    const manifest = readManifest(name);
    if (manifest?.packagesPending) {
        const pkgList = manifest.packages?.length ? manifest.packages.join(', ') : '(no package list)';
        logger.warn(`[Forge] forge_call REJECT: "${name}" has unapproved packages`, { packages: manifest.packages }, 'Forge');
        return mcpError(`Tool "${name}" has pending unapproved packages: ${pkgList}. Add them to config.json agents.forge.allowedPackages (or set requireApprovalForNewPackages=false) and restart, then forge_call will work.`);
    }

    const timeout = Math.min(reqTimeout || CONFIG.defaultTimeout, CONFIG.maxTimeout);

    // Resolve payload on main thread (scenario 3.x: fail before worker spawn)
    let payloadBuffers;
    try {
        payloadBuffers = await resolvePayload(payload);
        logger.info(`[Forge] Payload resolved for "${name}": ${payloadBuffers.length} buffers`, { sizes: payloadBuffers.map(b => b.length) }, 'Forge');
    } catch (e) {
        logger.warn(`[Forge] Payload resolution FAILED for "${name}": ${e.message}`, null, 'Forge');
        return mcpError(`Payload resolution failed: ${e.message}`);
    }

    // Acquire semaphore slot
    let release;
    try {
        logger.info(`[Forge] Acquiring semaphore for "${name}"...`, null, 'Forge');
        release = await SEMAPHORE();
        logger.info(`[Forge] Semaphore acquired for "${name}"`, null, 'Forge');
    } catch (e) {
        logger.warn(`[Forge] Semaphore FAILED for "${name}": ${e.message}`, null, 'Forge');
        return mcpError(e.message);
    }

    const workspacePath = createWorkspace();
    const toolStatePath = statePath(name);
    const toolStoragePath = storagePath(name);
    const progress = context.progress;

    // Snapshot storagePath BEFORE execution so we can diff after.
    // The tool may not exist yet on first call — that's fine, snapshotDir returns empty Map.
    const storageBefore = snapshotDir(toolStoragePath);

    let workerData;
    try {
        logger.info(`[Forge] Spawning worker for "${name}" (timeout: ${timeout}ms)`, null, 'Forge');
        workerData = await executeInWorker({
            name,
            args: toolArgs,
            payloadBuffers,
            workspacePath,
            toolStatePath,
            storagePath: toolStoragePath,
            timeout,
            captureLogs: true,
            progress,
            defaultModel: model || null
        });
        logger.info(`[Forge] Worker DONE for "${name}": result type ${typeof workerData.result}, ${workerData.logs?.length || 0} log lines`, null, 'Forge');
    } catch (e) {
        logger.info(`[Forge] Worker FAILED for "${name}": ${e.message}`, null, 'Forge');
        return mcpError(`Tool execution failed: ${e.message}`);
    } finally {
        release();
        cleanupWorkspace(workspacePath);
    }

    const durationMs = Date.now() - startedAt;
    const { result, logs } = workerData;
    // Oversized results go to toolStoragePath (persistent) so they survive
    // workspace cleanup and appear in _outputs.
    const sizeChecked = enforceResultSize(result, toolStoragePath);

    // Diff storagePath to find files the tool created or modified.
    const newFiles = diffSnapshots(storageBefore, snapshotDir(toolStoragePath));
    const outputs = newFiles.map(f => {
        const storageReadPath = path.posix.join('forge', name, f.rel);
        // Give callers a UNC path they can use from another LAN machine
        // (e.g. \\BADKID\Stuff\MCP_Storage\forge\<tool>\<file>) in addition
        // to the storage.read path. Skip when no translator is configured.
        const absoluteLocal = path.join(toolStoragePath, f.rel);
        const uncPath = STORAGE_TRANSLATOR ? STORAGE_TRANSLATOR.toUnc(absoluteLocal) : null;
        const url = `${PUBLIC_URL}/storage/${storageReadPath.split('/').map(encodeURIComponent).join('/')}`;
        const out = {
            name: f.rel,
            path: storageReadPath,
            url,
            ...(uncPath ? { uncPath } : {}),
            size: f.size
        };
        if (isLocalhostUrl(url)) {
            out.warning = `url points to localhost (${url}). It will fail from any machine other than the server. Configure agents.forge.publicUrl to the server's LAN IP (e.g. http://192.168.0.100:3100) and restart.`;
        }
        return out;
    });
    if (outputs.length > 0) {
        logger.info(`[Forge] "${name}" produced ${outputs.length} output file(s)`, { outputs: outputs.map(o => o.path) }, 'Forge');
    }

    // Detect silently empty results
    const resultIsEmpty = result === undefined || result === null ||
        (typeof result === 'object' && Object.keys(result).length === 0);

    const diagnostics = {
        durationMs,
        resultIsEmpty,
        logCount: logs?.length || 0,
        payloadCount: payloadBuffers?.length || 0,
    };

    if (resultIsEmpty) {
        logger.warn(`[Forge] forge_call EMPTY RESULT for "${name}" (${durationMs}ms, ${logs?.length || 0} logs)`, null, 'Forge');
    }

    logger.info(`[Forge] forge_call COMPLETE: "${name}" (${durationMs}ms, empty=${resultIsEmpty})`, null, 'Forge');

    return mcpOk({
        op: 'call',
        name,
        result: sizeChecked.result,
        _diagnostics: diagnostics,
        _outputs: outputs,
        ...(logs?.length ? { _logs: logs.map(l => ({ level: l.level, message: l.message })) } : {}),
        ...(resultIsEmpty ? { _warning: 'Tool returned an empty result (undefined, null, or empty object). This is often a bug — check your console output (_logs) for errors.' } : {}),
        ...(sizeChecked.oversized ? { _note: 'Result was oversized, saved to storagePath and listed in _outputs' } : {})
    });
}

export async function forge_history(args, context) {
    const { name, limit = 20 } = args;

    try {
        const log = await gitLog(name, limit);
        return mcpOk({ name: name || '(all tools)', commits: log, count: log.length });
    } catch (e) {
        return mcpError(`Failed to get history: ${e.message}`);
    }
}

export async function forge_rollback(args, context) {
    const { name, commit } = args;

    if (!toolExists(name)) {
        return mcpError(`Tool "${name}" does not exist.`);
    }
    if (!commit) {
        return mcpError('commit hash is required for rollback');
    }

    return GIT_WRITE_QUEUE(async () => {
        // Snapshot current state (scenario 2.5: protect against rollback during state mismatch)
        snapshotState(name);

        // Get the historical source
        let oldSource;
        try {
            oldSource = await gitShowFile(name, commit);
        } catch (e) {
            return mcpError(`Commit ${commit} not found for tool "${name}": ${e.message}`);
        }

        // Restore the source
        fs.writeFileSync(toolPath(name), oldSource);

        // Reset state to empty (new code may expect clean state)
        resetState(name);

        await gitCommit(`Forge: rollback tool "${name}" to ${commit.slice(0, 7)}`);

        const log = await gitLog(name, 1);
        return mcpOk({
            op: 'rollback',
            name,
            restoredTo: commit,
            newCommit: log[0]?.hash,
            message: 'Tool restored. Previous state snapshotted to state/.rollback/. State reset to empty.'
        });
    });
}

// ── Help / Authoring Guide ───────────────────────────────────────────────────
const HELP_TEXT = `FORGE — Tool Authoring Guide
============================

THE ctx OBJECT
Every forged tool receives (args, ctx). The ctx object provides:

  ctx.gateway    — LLM Gateway proxy (relayed via MessagePort to main thread)
  ctx.progress   — Progress reporter (relayed to MCP client as notifications)
  ctx.payload    — Array of Buffers (resolved from payload[] file paths/URLs)
  ctx.workspacePath    — Absolute path to ephemeral per-call directory (deleted after call)
  ctx.toolStatePath    — Absolute path to persistent per-tool state directory (survives across calls)
  ctx.storagePath      — Absolute path to persistent per-tool output directory (survives across calls, user-visible)
  ctx.args       — The args object passed to forge_call (same as first parameter)

ctx.gateway API
  await ctx.gateway.chat({ task, model?, messages, systemPrompt?, maxTokens?, temperature? })
    → { content: string, ...meta }
    task: "query" | "inspect" | "synthesis" | "analysis" | "vision" | "embed"
    model: optional Gateway model id (e.g. "badkid-llama-chat"). Overrides the default
            routing for THIS call. If you don't know what models exist, call
            ctx.gateway.listModels() first — DO NOT hardcode model ids.
    For backward compatibility: omit both task and model to use the Gateway default.
    Compatibility note: forge_call can pin a default model for the whole tool — but
    tools SHOULD NOT depend on a specific model. Write tools that work with whatever
    the Gateway resolves for each task. The model param is for callers (top-level LLMs)
    who want to route a particular call through a specific model.

  await ctx.gateway.listModels(type?)  → [{ id, type, capabilities, ... }]
    Lists models available on the Gateway. Use this to discover which model IDs are
    valid before passing one to chat({ model: ... }). type filter: "chat" | "embedding".

  await ctx.gateway.embed(text)  → number[] (embedding vector)
  await ctx.gateway.embedText(text)  → number[] (alias)
  await ctx.gateway.predict({ task, prompt, systemPrompt?, maxTokens? })  → { content, ... }
  await ctx.gateway.call(task, params)  → raw gateway response (flexible)

ctx.progress API
  ctx.progress({ message: string, progress: number, total: number })
  ctx.progress("Working...", 50, 100)  — also accepts positional args

ctx.payload
  Array of Node.js Buffers. Each item corresponds to a payload[] entry passed to forge_call.
  payload: ["C:\\\\path\\\\to\\\\file.pdf", "https://example.com/data.csv"]
  → ctx.payload[0] is the PDF Buffer, ctx.payload[1] is the CSV Buffer.
  Empty array if no payload was passed.

WRITING A TOOL
  export default async function(args, ctx) {
    // Your code here. Return a string, object, or Buffer.
    // Returned objects are JSON-serialized. Results > 10KB are saved to workspace.
    return { summary: "done", rows: 42 };
  }

STATE PATTERNS
  Persistent state (survives across calls, internal to tool):
    import { readFile, writeFile } from 'fs/promises';
    import { join } from 'path';
    const cacheFile = join(ctx.toolStatePath, 'cache.json');
    await writeFile(cacheFile, JSON.stringify(data));

  Persistent output (survives across calls, user-visible via storage):
    const outFile = join(ctx.storagePath, 'report.md');
    await writeFile(outFile, markdown);

  Ephemeral temp files (deleted after call):
    const tmpFile = join(ctx.workspacePath, 'intermediate.bin');

CONSTRAINTS
  - Timeout: 5 min default, 10 min max (worker.terminate() kills the process)
  - Max payload: 100 MB per item, 10 items
  - Max return: 10KB inline (larger results saved to workspace, pointer returned)
  - Max concurrent calls: 8 (configurable)
  - Packages: must be in allowlist (config.json agents.forge.allowedPackages)
  - No child_process, no worker_threads, no process.exit() from tools
  - Node built-ins (fs, path, crypto, etc.) are available

BEST PRACTICES
  - Always call ctx.progress() for long operations — the client sees it in real time
  - Use ctx.toolStatePath for caches, indexes, learned data
  - Use ctx.workspacePath for intermediate files that should not persist
  - Return structured objects, not formatted strings — the caller can format
  - Throw on errors — the forge catches and reports them clearly
  - Test with small payloads first, then scale up`;

export async function forge_help(args, context) {
    return mcpOk({ guide: HELP_TEXT });
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function init(context) {
    const agentConfig = context.config?.agents?.forge;
    if (!agentConfig) throw new Error('forge.init: context.config.agents.forge is required — missing from config.json');

    CONFIG = {
        defaultTimeout: agentConfig.defaultTimeout ?? DEFAULTS.defaultTimeout,
        maxTimeout: agentConfig.maxTimeout ?? DEFAULTS.maxTimeout,
        maxPayloadSize: agentConfig.maxPayloadSize ?? DEFAULTS.maxPayloadSize,
        maxPayloadItems: agentConfig.maxPayloadItems ?? DEFAULTS.maxPayloadItems,
        maxConcurrentCalls: agentConfig.maxConcurrentCalls ?? DEFAULTS.maxConcurrentCalls,
        queueTimeout: agentConfig.queueTimeout ?? DEFAULTS.queueTimeout,
        maxReturnSize: agentConfig.maxReturnSize ?? DEFAULTS.maxReturnSize,
        maxRollbackSnapshots: agentConfig.maxRollbackSnapshots ?? DEFAULTS.maxRollbackSnapshots,
        allowedPackages: agentConfig.allowedPackages ?? DEFAULTS.allowedPackages,
        requireApprovalForNewPackages: agentConfig.requireApprovalForNewPackages ?? DEFAULTS.requireApprovalForNewPackages
    };

    FORGE_ROOT = path.resolve(PROJECT_ROOT, 'data', 'forge');
    TOOLS_DIR = path.join(FORGE_ROOT, 'tools');
    WORKSPACE_DIR = path.join(FORGE_ROOT, 'workspace');

    // Storage root: use the storage agent's root + /forge subdirectory
    const storageAgentConfig = context.config?.agents?.storage;
    const storageRoot = storageAgentConfig?.root;
    if (storageRoot) {
        STORAGE_ROOT = path.resolve(storageRoot, 'forge');
    } else {
        STORAGE_ROOT = path.join(FORGE_ROOT, 'storage');
    }
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });

    // UNC ↔ local translator (null when uncShare not configured).
    STORAGE_TRANSLATOR = createTranslatorFromConfig(storageAgentConfig);
    if (STORAGE_TRANSLATOR) {
        logger.info(`[Forge] UNC translator active: ${STORAGE_TRANSLATOR.uncShare} ↔ ${STORAGE_TRANSLATOR.localRoot}`, null, 'Forge');
    }

    // Public URL for constructing retrieval links to forge outputs.
    // Read from config.json agents.forge.publicUrl — must be reachable by clients.
    // Falls back to http://localhost:{PORT} where PORT comes from env or default 3100.
    // IMPORTANT: this URL must use the server's LAN IP (e.g. http://192.168.0.100:3100),
    // not localhost/127.0.0.1, otherwise cross-machine clients cannot fetch outputs.
    PUBLIC_URL = agentConfig.publicUrl
        || context.config?.agents?.storage?.publicUrl
        || process.env.PUBLIC_URL
        || `http://localhost:${process.env.PORT || 3100}`;

    if (isLocalhostUrl(PUBLIC_URL)) {
        logger.warn(`[Forge] PUBLIC_URL is set to localhost (${PUBLIC_URL}). Forge output URLs will be unreachable from other LAN machines. Set agents.forge.publicUrl to the server's LAN IP, e.g. http://192.168.0.100:3100`, null, 'Forge');
    } else {
        logger.info(`[Forge] Public URL for outputs: ${PUBLIC_URL}`, null, 'Forge');
    }

    GATEWAY_CLIENT = context.gateway;

    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    GIT_WRITE_QUEUE = createGitWriteQueue();
    SEMAPHORE = createSemaphore(CONFIG.maxConcurrentCalls, CONFIG.queueTimeout);

    // Initialize git repo (idempotent)
    await gitInit();

    // Startup health checks
    await startupHealthChecks();

    logger.info(`[Forge] Initialized — root: ${FORGE_ROOT}, maxConcurrent: ${CONFIG.maxConcurrentCalls}`, null, 'Forge');
}

// ── Startup Health Checks ────────────────────────────────────────────────────
async function startupHealthChecks() {
    // 1. git fsck — verify repo integrity
    try {
        await git(['fsck', '--quiet']);
    } catch (e) {
        logger.warn(`[Forge] git fsck failed: ${e.message}`, null, 'Forge');
    }

    // 2. Sweep orphan workspace directories (scenario 9.5)
    if (fs.existsSync(WORKSPACE_DIR)) {
        const entries = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true });
        let swept = 0;
        for (const entry of entries) {
            if (entry.isDirectory()) {
                fs.rmSync(path.join(WORKSPACE_DIR, entry.name), { recursive: true, force: true });
                swept++;
            }
        }
        if (swept > 0) {
            logger.info(`[Forge] Swept ${swept} orphan workspace directories`, null, 'Forge');
        }
    }
}
