import fs from 'fs';
import path from 'path';
import { execFile, fork } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { createTranslatorFromConfig } from '../storage/path-translator.js';
import * as browserAgent from '../browser/index.js';

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
let CONFIG;
let GATEWAY_CLIENT;
let BROWSER_AGENT;
let TOOL_ROUTER;      // globalContext.toolRouter — workshop dispatcher (late-bound in server.js)
let MAIN_CONTEXT;     // forge's init context — relayed to MCP handlers so context.agents etc. exist
let GIT_WRITE_QUEUE;
let SEMAPHORE;

// ── Running-call registry (issue #43) ────────────────────────────────────────
// callId → { name, startedAt, worker, spawned:Set<pid>, stopping }
// Tracks every live forge worker plus the OS processes it spawned via ctx.spawn,
// so timeouts and forge.stop can tear down the whole tree, not just the thread.
const RUNNING = new Map();

// Kill one PID and (on Windows) its entire process tree. Fire-and-forget;
// a PID that already exited is normal — taskkill reports "not found", logged
// at info, not an error.
async function killProcessTree(pid, name) {
    if (process.platform === 'win32') {
        try {
            await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']);
            logger.info(`[Forge] Killed process tree pid=${pid} (tool "${name}")`, null, 'Forge');
        } catch (e) {
            const gone = /not found|no such|cannot find|terminated/i.test(String(e.message || e.stderr || ''));
            if (!gone) logger.warn(`[Forge] taskkill pid=${pid} (tool "${name}") failed: ${e.message || e}`, null, 'Forge');
        }
    } else {
        try {
            process.kill(pid, 'SIGKILL');
            logger.info(`[Forge] Killed process pid=${pid} (tool "${name}")`, null, 'Forge');
        } catch {
            // already dead — ESRCH is the normal case
        }
    }
}

// Tear down a RUNNING entry's process tree and unregister it.
// Called from every settle path (result, error, exit, idle/hard/boot timeout,
// forge.stop).
//
// Since #37 the tool IS a process, so killing its tree covers every ctx.spawn
// child too — taskkill /T walks descendants, and unlike worker.terminate() it
// never asks V8 whether it is at a safe point to die. The explicit PID list is
// still killed as a fallback for the window before the child's PID was known and
// for children a crashed tool orphaned. `exited` guards against killing a
// recycled PID after the process already left.
function teardownEntry(entry) {
    if (!entry || entry.tornDown) return;
    entry.tornDown = true;
    if (entry.pid && !entry.exited) killProcessTree(entry.pid, entry.name);
    for (const pid of entry.spawned) {
        killProcessTree(pid, entry.name);
    }
    entry.spawned.clear();
    RUNNING.delete(entry.callId);
}

// Live calls of one tool. forge_delete/forge_rollback mutate exactly the
// directories a running worker is using, so they must not run concurrently
// with a call of the same tool (#48).
function runningCallsFor(name) {
    return [...RUNNING.values()].filter(e => e.name === name);
}

function describeRunning(calls) {
    return calls.map(e => `${e.callId} (${Math.round((Date.now() - e.startedAt) / 1000)}s)`).join(', ');
}

// ── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
    defaultTimeout: 300000,      // idle: kill after 5 min of silence
    maxTimeout: 900000,          // idle ceiling: 15 min of silence
    hardTimeout: 1800000,        // absolute backstop: 30 min total runtime
    bootTimeout: 60000,          // worker must report ready within 60s
    maxPayloadSize: 104857600,   // 100 MB per item
    maxPayloadItems: 10,
    maxConcurrentCalls: 8,
    queueTimeout: 30000,
    maxReturnSize: 10240,        // 10 KB inline
    maxRollbackSnapshots: 10,
    maxSnapshotDepth: 4,         // depth cap for the _outputs walk (issue #51)
    // Global held-bytes ceiling for payloads across all in-flight calls (#53).
    // Per-item limits alone admit ~8 GB, which is a legal way to kill the daemon.
    maxTotalPayloadBytes: 536870912,
    // Log capture bounds (issue #49). A tool that logs in a loop used to grow the
    // main thread's log array without limit for up to 30 minutes — memory the
    // main thread has no cap on, and one that #37's isolation work does not fix.
    // entries × lineChars bounds a single call at ~4 MB.
    maxLogEntries: 1000,
    maxLogLineChars: 4000,
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
                        // BUGFIX (issue #40): splice out WRAPPED, not tryAcquire —
                        // the queue holds wrapped; indexOf(tryAcquire) was always
                        // -1, so the timed-out entry stayed queued, later grabbed a
                        // slot, incremented `active` resolving an already-rejected
                        // promise, and leaked that slot forever.
                        const idx = queue.indexOf(wrapped);
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
// Every git invocation is bounded. GIT_WRITE_QUEUE is a serial promise chain,
// so one git that never returns would park the queue forever and every later
// forge_write/update/delete/rollback would silently queue behind it (#50).
const GIT_TIMEOUT_MS = 30000;
// A leftover .git/index.lock can only be stale if our own git has already been
// killed by the timeout above — so this is derived, not hardcoded. Raising the
// timeout without moving this would make a live lock look deletable.
const STALE_LOCK_MS = GIT_TIMEOUT_MS * 2;

async function git(args, opts = {}) {
    const { stdout } = await execFileAsync('git', args, {
        cwd: FORGE_ROOT,
        maxBuffer: 10 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        ...opts
    });
    return stdout.trim();
}

async function gitInit() {
    if (!fs.existsSync(path.join(FORGE_ROOT, '.git'))) {
        await execFileAsync('git', ['init'], { cwd: FORGE_ROOT, timeout: GIT_TIMEOUT_MS });
        await execFileAsync('git', ['config', 'user.name', 'Forge Agent'], { cwd: FORGE_ROOT, timeout: GIT_TIMEOUT_MS });
        await execFileAsync('git', ['config', 'user.email', 'forge@mcp.local'], { cwd: FORGE_ROOT, timeout: GIT_TIMEOUT_MS });

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
        await execFileAsync('git', ['add', '.gitignore'], { cwd: FORGE_ROOT, timeout: GIT_TIMEOUT_MS });
        await execFileAsync('git', ['commit', '-m', 'Forge: initialize repository'], { cwd: FORGE_ROOT, timeout: GIT_TIMEOUT_MS });
    }
}

// Remove .git/index.lock only when it is provably older than any git we could
// still have running. Returns true when a lock was cleared. A crashed git —
// including the process-fatal OOM in #37 — otherwise fails every later commit
// with "Unable to create index.lock", bricking the forge until someone
// intervenes by hand.
async function clearStaleIndexLock() {
    const lockPath = path.join(FORGE_ROOT, '.git', 'index.lock');
    let stat;
    try {
        stat = await fs.promises.stat(lockPath);
    } catch {
        // No lock file — the error we are recovering from was about something else.
        return false;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < STALE_LOCK_MS) {
        logger.warn(`[Forge] .git/index.lock is ${Math.round(ageMs / 1000)}s old (< ${STALE_LOCK_MS / 1000}s) — leaving it alone, it may belong to a live git`, null, 'Forge');
        return false;
    }
    logger.warn(`[Forge] removing stale .git/index.lock (${Math.round(ageMs / 1000)}s old) — a previous git died without releasing it`, null, 'Forge');
    await fs.promises.rm(lockPath, { force: true });
    return true;
}

async function gitCommit(message) {
    await execFileAsync('git', ['add', '-A'], { cwd: FORGE_ROOT, timeout: GIT_TIMEOUT_MS });
    try {
        await execFileAsync('git', ['commit', '-m', message], { cwd: FORGE_ROOT, timeout: GIT_TIMEOUT_MS });
    } catch (e) {
        const output = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
        // "nothing to commit" — not an error
        if (output.includes('nothing to commit')) return;

        if (output.includes('index.lock') && await clearStaleIndexLock()) {
            try {
                await execFileAsync('git', ['commit', '-m', message], { cwd: FORGE_ROOT, timeout: GIT_TIMEOUT_MS });
                return;
            } catch (retryErr) {
                // Logged distinctly: if this ever fires, a killed git was still
                // holding the lock and the single retry is not enough.
                logger.warn(`[Forge] commit retry after clearing index.lock FAILED: ${retryErr.message}`, null, 'Forge');
                throw retryErr;
            }
        }
        throw e;
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
    // typeof guard first: NAME_RE.test(undefined) coerces to the string
    // "undefined", which MATCHES the snake_case regex — producing a tool
    // literally named "undefined" (observed 2026-09-12).
    if (typeof name !== 'string') {
        throw new Error(`Invalid tool name: expected string, got ${typeof name}. forge.write requires { name, description, code } at the top level of the call args.`);
    }
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

// Durable, tool-owned, NON-OUTPUT artifacts (issue #39) — a yt-dlp.exe, a model
// blob, a compiled helper. Three requirements, and this location is the one that
// satisfies all three:
//   - outside the source checkout, so a 17 MB binary is not sitting inside
//     D:\DEV\mcp_server where a re-clone or a directory move destroys it and where
//     no storage tool can see it (which is what toolStatePath would give);
//   - outside storagePath(name), so it never appears in _outputs as though the
//     tool had produced it — .vendor is a SIBLING of the per-tool dirs, so the
//     snapshot walk does not reach it and no exclusion logic is needed;
//   - under STORAGE_ROOT, whose `forge` subtree is already in agents.vdb.ignore,
//     so binaries are not indexed into the vector database.
// Note storage_list does not hide dot-prefixed entries: `.vendor` is visible as
// one directory to an explicit listing. That is deliberate — it is discoverable
// when you look for it, and never enumerated into context by accident.
function vendorPath(name) {
    return path.join(STORAGE_ROOT, '.vendor', name);
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
//
// Two phases, and async I/O throughout (issues #51, #53):
//   Phase 1 validates and SIZES every item without reading it. Phase 2 reads.
//   The point of the split is the global byte budget. Per-item limits alone admit
//   maxPayloadItems × maxPayloadSize × maxConcurrentCalls = 10 × 100 MB × 8 ≈ 8 GB
//   of live Buffers on the main thread — a config-legal way to kill the daemon,
//   and one that worker isolation does not address because the parent still
//   allocates. A call reserves its total before it reads anything, and the
//   reservation is a synchronous increment in the same microtask as the size sum,
//   so a concurrent call cannot sum before the reservation is visible.
//   URLs are the honest exception: their size is unknown until fetched, so each
//   reserves the per-item ceiling up front and the reservation is corrected to the
//   real byte count afterwards.

let payloadBytesHeld = 0;

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Release a reservation. A negative total would mean a double release, which is a
// forge bug rather than a tool's — report it without throwing, because this runs
// on cleanup paths where a throw would mask the call's real outcome.
function releasePayloadBytes(n) {
    if (!n) return;
    payloadBytesHeld -= n;
    if (payloadBytesHeld < 0) {
        logger.error(`[Forge] payload byte accounting went negative (${payloadBytesHeld}) — a reservation was released twice`, null, 'Forge');
        payloadBytesHeld = 0;
    }
}

async function planPayloadItem(item, index) {
    if (typeof item !== 'string') {
        throw new Error(`payload[${index}] must be a string (file path or URL), got ${typeof item}`);
    }

    if (/^https?:\/\//i.test(item)) {
        return { kind: 'url', index, item, reserveBytes: CONFIG.maxPayloadSize };
    }

    // File path (local or UNC) → size it now, read it in phase 2.
    // Translate UNC form of the storage share to the local form first —
    // works for both forge workers (which only see D:\MCP_Storage) and the
    // main-thread resolver (which avoids going through SMB unnecessarily).
    const translated = STORAGE_TRANSLATOR ? STORAGE_TRANSLATOR.toLocal(item) : item;
    // Resolve to absolute — relative paths are relative to PROJECT_ROOT (scenario 5.3)
    const resolved = path.isAbsolute(translated) ? translated : path.resolve(PROJECT_ROOT, translated);
    // Async stat/read: a 100 MB read on a slow share must not freeze the event
    // loop while every other session and tool waits (issue #51).
    const stat = await fs.promises.stat(resolved);  // ENOENT (scenario 3.1), EACCES if no access
    if (stat.isDirectory()) {
        throw new Error(`payload[${index}] is a directory, not a file: ${item} (scenario 3.2)`);
    }
    if (stat.size > CONFIG.maxPayloadSize) {
        throw new Error(`payload[${index}] exceeds maxPayloadSize (${stat.size} > ${CONFIG.maxPayloadSize}) — ${item}`);
    }
    return { kind: 'file', index, item, resolved, reserveBytes: stat.size };
}

async function readPayloadItem(plan) {
    if (plan.kind === 'file') {
        const buf = await fs.promises.readFile(plan.resolved);
        // Re-checked after the read: the file can grow between stat and read.
        if (buf.length > CONFIG.maxPayloadSize) {
            throw new Error(`payload[${plan.index}] exceeds maxPayloadSize (${buf.length} > ${CONFIG.maxPayloadSize}) — ${plan.item}`);
        }
        return buf;
    }

    const timeoutMs = 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
        resp = await fetch(plan.item, { signal: controller.signal });
    } catch (e) {
        if (e.name === 'AbortError') {
            throw new Error(`payload[${plan.index}] fetch timed out after ${timeoutMs}ms — ${plan.item}`);
        }
        throw new Error(`payload[${plan.index}] fetch failed: ${e.message} — ${plan.item}`);
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        throw new Error(`payload[${plan.index}] fetch failed: ${resp.status} ${resp.statusText} — ${plan.item}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > CONFIG.maxPayloadSize) {
        throw new Error(`payload[${plan.index}] exceeds maxPayloadSize (${buf.length} > ${CONFIG.maxPayloadSize}) — ${plan.item}`);
    }
    return buf;
}

// Returns { buffers, reservedBytes }. The caller MUST release reservedBytes when
// the buffers are no longer needed; on failure this releases its own reservation.
async function resolvePayload(payload) {
    if (payload === undefined || payload === null) return { buffers: [], reservedBytes: 0 };
    // Fail loud on a non-array. An object (e.g. {item:"..."}) has no `.length`,
    // so the old `!payload || payload.length === 0` guard fell through, the
    // `i < payload.length` loop never ran, and a malformed payload resolved to
    // exactly the same 0-buffer result as no payload at all — the caller got
    // `payloadCount: 0` and no way to tell the two apart. Observed 2026-09-28:
    // a model passed {item:"<path>"} on every attempt and its tool reported an
    // empty payload while the server reported nothing wrong.
    if (!Array.isArray(payload)) {
        const keys = payload && typeof payload === 'object' ? Object.keys(payload) : [];
        const preview = JSON.stringify(payload)?.slice(0, 160) ?? String(payload);
        // A single invented key wrapping the real list is the signature of a
        // caller that could not put an array where an object was expected, so it
        // made up a key for it. `payload` has no such key in any schema — name
        // the case rather than making the caller guess a second time.
        const hint = keys.length === 1
            ? ` It arrives wrapped under an invented key "${keys[0]}" — no such field exists. ` +
              `The array IS the payload field itself: pass payload: ["C:\\path\\to\\file"], ` +
              `not payload: {${keys[0]}: [...]}.`
            : ` Pass payload: ["C:\\path\\to\\file"] — an array of strings, not an object.`;
        throw new Error(
            `payload must be an array of file paths or URLs, got ${typeof payload} (${preview}).${hint}`
        );
    }
    if (payload.length === 0) return { buffers: [], reservedBytes: 0 };
    if (payload.length > CONFIG.maxPayloadItems) {
        throw new Error(`payload has ${payload.length} items, max is ${CONFIG.maxPayloadItems}`);
    }

    // Phase 1 — validate and size, no reads.
    const plans = [];
    for (let i = 0; i < payload.length; i++) {
        plans.push(await planPayloadItem(payload[i], i));
    }

    // Reserve. Deliberately no `await` between the sum and the increment below:
    // this is the whole point of the two-phase split.
    const requested = plans.reduce((sum, p) => sum + p.reserveBytes, 0);
    if (payloadBytesHeld + requested > CONFIG.maxTotalPayloadBytes) {
        throw new Error(
            `payload needs ${formatBytes(requested)} but the server already holds ${formatBytes(payloadBytesHeld)} ` +
            `of its ${formatBytes(CONFIG.maxTotalPayloadBytes)} budget (agents.forge.maxTotalPayloadBytes). ` +
            `Reduce the payload size, or raise that budget.`
        );
    }
    payloadBytesHeld += requested;

    // Phase 2 — read, then correct URL reservations down to the bytes actually held.
    try {
        const buffers = [];
        for (const plan of plans) {
            buffers.push(await readPayloadItem(plan));
        }
        const actual = buffers.reduce((sum, b) => sum + b.length, 0);
        payloadBytesHeld += actual - requested;
        return { buffers, reservedBytes: actual };
    } catch (e) {
        releasePayloadBytes(requested);
        throw e;
    }
}

function payloadBudgetStatus() {
    return { heldBytes: payloadBytesHeld, heldPretty: formatBytes(payloadBytesHeld), capBytes: CONFIG.maxTotalPayloadBytes };
}

// ── Result Size Policy ───────────────────────────────────────────────────────
// Oversized results are saved to the tool's persistent storagePath (NOT the
// ephemeral workspace — that gets deleted immediately after the call returns).
// The file then appears in _outputs like any other file the tool produced.
async function enforceResultSize(result, storagePathDir, callId) {
    const serialized = typeof result === 'string' ? result : JSON.stringify(result);
    const buf = Buffer.from(serialized, 'utf8');
    if (buf.length <= CONFIG.maxReturnSize) {
        return { result, oversized: false };
    }
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    // callId is included because the ISO timestamp is only millisecond-resolved:
    // two oversized results from the same tool in the same millisecond (nested
    // forge.call, parallel calls, a fast retry) would silently overwrite each
    // other while _outputs kept pointing at the surviving file (#52).
    const resultFile = path.join(storagePathDir, `result-${dateStr}-${callId.slice(-8)}.json`);
    await fs.promises.writeFile(resultFile, serialized);
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
// Snapshots the file list of a directory (relative paths + sizes + mtimes), to
// detect what a tool produced. Snapshots are in-memory, single-call scope.
//
// Asynchronous (issue #51): the synchronous recursive walk froze the event loop
// for as long as it took, stalling every other session. Two further behaviours
// matter, because async removes the BLOCK but not the O(n) cost:
//   - Recursion stops at maxSnapshotDepth. Outputs are shallow in practice; the
//     cap is REPORTED to the caller (outputsTruncated) rather than silently
//     omitting files from _outputs, which would hide real results.
//   - The caller skips the "before" walk entirely when the directory was empty
//     at call start, so a first call costs one walk instead of two.
async function snapshotDir(dir) {
    const files = new Map();
    const state = { truncated: false };
    await walkSnapshot(dir, dir, files, 0, state);
    return { files, truncated: state.truncated };
}

async function walkSnapshot(rootDir, dir, files, depth, state) {
    if (depth >= CONFIG.maxSnapshotDepth) {
        state.truncated = true;
        return;
    }
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
        // A directory that vanished mid-walk is not a failure of the call: the
        // diff just cannot see into it. Anything else is real and surfaces.
        if (e.code === 'ENOENT') return;
        throw e;
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            await walkSnapshot(rootDir, full, files, depth + 1, state);
        } else if (e.isFile()) {
            const stat = await fs.promises.stat(full);
            const rel = path.relative(rootDir, full).replace(/\\/g, '/');
            files.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
}

// Cheap top-level check used to skip the "before" walk. An empty or missing
// directory has nothing to diff against, so the after-walk reports every file as
// added and the before-walk is pure overhead.
async function dirHasEntries(dir) {
    try {
        return (await fs.promises.readdir(dir)).length > 0;
    } catch (e) {
        if (e.code === 'ENOENT') return false;
        throw e;
    }
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

async function cleanupWorkspace(wsPath) {
    if (wsPath) await fs.promises.rm(wsPath, { recursive: true, force: true });
}

// ── State Snapshot (for rollback) ────────────────────────────────────────────
// Async, and the rollback path must await this to completion BEFORE its first
// git operation — a half-written snapshot must never be committed (#51).
async function snapshotState(name) {
    const sp = statePath(name);
    if (!fs.existsSync(sp)) return;

    const rollbackDir = path.join(sp, '.rollback');
    await fs.promises.mkdir(rollbackDir, { recursive: true });
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const snapDir = path.join(rollbackDir, dateStr);
    await fs.promises.mkdir(snapDir, { recursive: true });

    // Copy everything except .rollback itself
    const entries = await fs.promises.readdir(sp, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '.rollback') continue;
        const src = path.join(sp, entry.name);
        const dst = path.join(snapDir, entry.name);
        await fs.promises.cp(src, dst, { recursive: true });
    }

    // Enforce cap — oldest first
    const snapshots = [];
    for (const d of await fs.promises.readdir(rollbackDir)) {
        const full = path.join(rollbackDir, d);
        snapshots.push({ name: d, path: full, mtime: (await fs.promises.stat(full)).mtime });
    }
    snapshots.sort((a, b) => a.mtime - b.mtime);
    while (snapshots.length > CONFIG.maxRollbackSnapshots) {
        const oldest = snapshots.shift();
        await fs.promises.rm(oldest.path, { recursive: true, force: true });
    }
}

async function resetState(name) {
    const sp = statePath(name);
    if (!fs.existsSync(sp)) return;
    const entries = await fs.promises.readdir(sp, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '.rollback') continue;
        await fs.promises.rm(path.join(sp, entry.name), { recursive: true, force: true });
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

// Max forge.call nesting depth (worker → ctx.mcp forge.call → worker → ...).
// Depth 0 = top-level call. Hard guard against runaway recursion; nested
// calls that exceed it fail loud as tool-result errors.
const MAX_FORGE_DEPTH = 3;

async function executeInWorker({ name, args, payloadBuffers, workspacePath, toolStatePath, storagePath, vendorPath, timeout, captureLogs, progress, defaultModel, depth = 0, callId, signal }) {
    const sourcePath = toolPath(name);
    const source = fs.readFileSync(sourcePath, 'utf8');
    logger.info(`[Forge:worker] Source loaded for "${name}": ${source.length} chars, spawning worker`, null, 'Forge');

    // ── Relay transport ──
    // One IPC channel to the tool's own process, four logical channels tagged by
    // `channel` (the mirror of worker-bootstrap.js). Each relay below gets a
    // port-shaped adapter over that channel, so the relay bodies themselves are
    // unchanged — the smallest possible diff on the most dangerous code path.
    const RELAY = new Map();   // channel -> handler(msg)
    const childPort = (channel) => ({
        on(event, fn) { if (event === 'message') RELAY.set(channel, fn); },
        start() { /* no-op: the dispatcher is registered with the child below */ },
        close() { RELAY.delete(channel); },
        // A closed channel means the tool process is already gone; there is nobody
        // to answer and the call is being torn down anyway.
        postMessage(msg) { if (child?.connected) child.send({ channel, ...msg }); }
    });
    const gatewayPort1 = childPort('gateway');
    const browserPort1 = childPort('browser');
    const mcpPort1 = childPort('mcp');
    const progressPort1 = childPort('progress');

    // ── Watchdog: idle timeout + hard runtime cap (issue #27) ──
    // The timeout measures LACK OF PROGRESS, not elapsed time: any worker
    // activity — ctx.progress events, gateway/browser/mcp relay traffic,
    // any worker message — resets the idle deadline. A tool making steady
    // progress never times out regardless of total duration; a silent
    // (hung) worker is killed after `timeout` ms of silence. The hard cap
    // is the absolute backstop: total runtime, never reset by activity.
    // rejectP is assigned by the promise executor below (watchdog can only
    // fire after that — timers are macrotasks, executor runs sync).
    let settled = false;
    let receivedResult = false;
    let logs = [];
    let hardTimer;
    let bootTimer;
    let rejectP;
    let ready = false;
    let idleCheckScheduled = false;
    let lastActivityAt = 0;
    let onAbort = null;   // client-cancel listener (issue #45)
    let logsDropped = 0;  // lines the worker declined to forward (issue #49)

    // Registry entry (issue #43): the child is assigned after the fork below, its
    // own PID is known immediately, and ctx.spawn children announce themselves via
    // 'spawned' messages. teardownEntry kills the tool's process tree — which since
    // #37 is also how it reaches the worker itself, unconditionally.
    const entry = { callId, name, startedAt: Date.now(), child: null, pid: null, exited: false, spawned: new Set(), tornDown: false };
    RUNNING.set(callId, entry);

    // Per-call abort channel for work this worker starts on the MAIN thread
    // (issue #45 layer b). A nested forge.call invoked through the MCP relay gets
    // this signal on its context, so when this worker is torn down — client
    // cancel, idle timeout, hard cap, crash, forge_stop — the nested call
    // terminates its own worker rather than running on to its own hard cap. Without
    // it, cancel stops the loop but leaves the step in flight spending.
    // Aborting an already-settled controller is a no-op, so the benign race where
    // the nested call finished first costs nothing.
    const relayAbort = new AbortController();

    const cleanup = () => {
        teardownEntry(entry);
        clearTimeout(hardTimer);
        clearTimeout(bootTimer);
        // The idle check is a setImmediate loop — it stops itself via `settled`.
        // Close ports to prevent leaks — removeAllListeners isn't available
        // on MessagePort, so we just stop them from accepting new messages.
        try { gatewayPort1.close(); } catch {}
        try { browserPort1.close(); } catch {}
        try { mcpPort1.close(); } catch {}
        try { progressPort1.close(); } catch {}
        // Drop the client-cancel listener so a late abort cannot reach a settled call.
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        // Propagate teardown to main-thread work this worker started (#45b).
        if (!relayAbort.signal.aborted) relayAbort.abort(new Error(`parent worker for "${name}" was torn down`));
    };

    // Timeout teardown (issue #43). REJECT FIRST, then tear down. The earlier
    // shape — `worker.terminate().then(() => rejectP(...))` — kept the caller
    // blocked until terminate() resolved, and terminate() cannot interrupt a
    // worker parked in native code, so a wedged tool hung forge_call until the
    // client gave up: the exact failure the timeout exists to prevent. The
    // caller is unblocked synchronously; the kill happens behind it.
    const terminateAndReject = (err) => {
        rejectP(err);
        cleanup();
        // child.kill is a plain OS signal to a process, not a promise V8 might
        // never honour. The old shape awaited worker.terminate(), which a worker
        // blocked in a kernel wait never resolves — measured in
        // data/_test/forge-terminate-uninterruptible.cjs. There is now nothing to
        // await, so the caller can never be held up by the kill.
        child.kill('SIGKILL');
    };

    // IDLE CHECK — setImmediate loop, deliberately NOT a setTimeout.
    // Why: when the main thread is blocked longer than the idle window (e.g.
    // VDB sync hashing, issue #31), an armed setTimeout lands in the TIMERS
    // phase — which runs BEFORE queued MessagePort messages (poll phase) in
    // the same loop iteration. The expired timer then kills the worker
    // before its queued progress resets are ever delivered (observed
    // 2026-09-07: healthy progress-mode tool killed at exactly spawn+3s
    // during a boot VDB scan, twice). setImmediate runs in the CHECK phase
    // — AFTER poll — so every queued activity is accounted for before any
    // kill decision. Under a full block no checks run at all (safe, kills
    // just go late); at unblock, messages process first and the check sees
    // fresh lastActivityAt. Cost: one Date.now compare per loop iteration.
    const idleCheck = () => {
        if (settled || !ready) return;
        const silentFor = Date.now() - lastActivityAt;
        if (silentFor >= timeout) {
            settled = true;
            logger.warn(`[Forge:worker] IDLE TIMEOUT for "${name}" after ${silentFor}ms without activity — terminating`, null, 'Forge');
            terminateAndReject(new Error(`Tool "${name}" timed out after ${silentFor}ms without activity — worker terminated`));
            return;
        }
        setImmediate(idleCheck);
    };

    // Any sign of life marks activity — but only counts once the worker has
    // reported ready. Boot (module compile under main-thread load can far
    // exceed the idle window) is covered by bootTimer + hardTimeout.
    const activity = () => { if (ready) lastActivityAt = Date.now(); };

    const armOnReady = () => {
        if (ready) return;
        ready = true;
        lastActivityAt = Date.now();
        clearTimeout(bootTimer);
        if (!idleCheckScheduled) {
            idleCheckScheduled = true;
            setImmediate(idleCheck);
        }
    };

    // ── Progress relay: tool → orchestrator → MCP notification ──
    // Coalesced. Every message from the tool becomes a JSON-RPC notification on
    // the wire, and a tool emitting progress in a tight loop produced one per
    // event. The client throttles its own rendering but we still paid a message
    // each. One per window, plus a completion always forwarded so the caller's
    // bar actually lands at 100%.
    //
    // `activity()` runs BEFORE the throttle and for every message: it is the idle
    // watchdog's signal of life, and a throttled-but-active tool must not look
    // hung. Dropping the notification is a display decision, not a liveness one.
    const PROGRESS_MIN_INTERVAL_MS = 250;
    let lastProgressAt = 0;
    progressPort1.on('message', (msg) => {
        activity();
        if (msg.type !== 'progress') return;
        const isFinal = typeof msg.total === 'number' && typeof msg.progress === 'number'
            && msg.total > 0 && msg.progress >= msg.total;
        const now = Date.now();
        if (!isFinal && now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
        lastProgressAt = now;
        progress?.(msg.message, msg.progress, msg.total);
    });
    progressPort1.start();

    // ── Gateway relay: worker → main thread → WebSocket ──
    // The worker posts { id, task, params } and we forward to GATEWAY_CLIENT,
    // then post the response back.
    gatewayPort1.on('message', async (msg) => {
        activity();
        if (msg.type === 'gateway-call') {
            const { id, task, params } = msg;
            logger.info(`[Forge:worker] Gateway relay for "${name}": task=${task} model=${params?.model || '(default)'}`, { id }, 'Forge');
            const relayTimeout = 330000;
            try {
                const result = await Promise.race([
                    // An external signal so teardown (client cancel, idle timeout,
                    // hard cap, forge_stop) aborts the in-flight upstream call
                    // rather than merely abandoning it on the main thread — a
                    // cancelled call must stop SPENDING, not just stop waiting.
                    // Handlers/tools that pass no signal are unaffected.
                    GATEWAY_CLIENT.chat({ task, ...params, signal: relayAbort.signal }),
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

    // ── Browser relay: worker → main thread → browser agent ──
    // The worker posts { id, method, args } and we forward to the browser
    // agent's exported handler function (same process, direct call), then
    // post the response back. Only active when BROWSER_AGENT is linked.
    if (BROWSER_AGENT) {
        browserPort1.on('message', async (msg) => {
            activity();
            if (msg.type === 'browser-call') {
                const { id, method, args } = msg;
                const handler = BROWSER_AGENT[method];
                if (typeof handler !== 'function') {
                    browserPort1.postMessage({ type: 'browser-result', id, error: `Unknown browser method: ${method}` });
                    return;
                }
                const browserTimeout = 120000;
                try {
                    const callResult = await Promise.race([
                        handler(args || {}, { progress: (m, p, t) => progress?.(m, p, t) }),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`Browser relay timed out after ${browserTimeout}ms (${method})`)), browserTimeout)
                        )
                    ]);
                    // Browser handlers return { content: [{ type: 'text', text: ... }], isError }
                    // or { content: [{ type: 'image', data: 'base64...', mimeType: 'image/png' }] }
                    // Unwrap both so the worker gets clean data, not MCP envelopes.
                    const contentBlock = callResult?.content?.[0];
                    if (contentBlock?.text !== undefined) {
                        let parsed = contentBlock.text;
                        // Try to parse JSON responses (most browser ops return JSON)
                        try { parsed = JSON.parse(parsed); } catch {}
                        browserPort1.postMessage({ type: 'browser-result', id, result: { data: parsed, isError: callResult.isError || false } });
                    } else if (contentBlock?.data !== undefined) {
                        // Image/screenshot: pass base64 data + mimeType directly
                        browserPort1.postMessage({ type: 'browser-result', id, result: { data: contentBlock.data, mimeType: contentBlock.mimeType, isError: callResult.isError || false } });
                    } else {
                        browserPort1.postMessage({ type: 'browser-result', id, result: callResult });
                    }
                } catch (err) {
                    logger.warn(`[Forge:worker] Browser relay FAILED (${method}): ${err.message}`, null, 'Forge');
                    browserPort1.postMessage({ type: 'browser-result', id, error: err.message });
                }
            }
        });
        browserPort1.start();
    }

    // ── MCP relay: worker → main thread → workshop dispatcher ──
    // Forwards ctx.mcp.call(method, payload) to toolRouter.call — the same
    // in-process router the chat agent uses. Credentials (GIT_TOKEN) stay on
    // the main thread; workers never see them.
    // forge.call through the relay gets _depth+1 injected so recursion is
    // bounded by MAX_FORGE_DEPTH (checked in forge_call, loud failure).
    if (TOOL_ROUTER) {
        mcpPort1.on('message', async (msg) => {
            activity();
            if (msg.type !== 'mcp-call') return;
            const { id, method, payload } = msg;
            if (typeof TOOL_ROUTER.call !== 'function') {
                mcpPort1.postMessage({ type: 'mcp-result', id, error: 'MCP relay unavailable: toolRouter not ready' });
                return;
            }
            const relayTimeout = 300000;
            try {
                let routedPayload = payload || {};
                if (method === 'forge.call') {
                    routedPayload = { ...payload, _depth: depth + 1 };
                }
                logger.info(`[Forge:worker] MCP relay for "${name}": ${method} (depth ${depth}${method === 'forge.call' ? ` → ${depth + 1}` : ''})`, null, 'Forge');
                const result = await Promise.race([
                    // Full agent-init context (agents Map, gateway, config, ...) —
                    // handlers read context.agents.get(...) etc. A bare { progress }
                    // context crashes them. prompts must be the GLOBAL Map: our init
                    // context carries forge's own plain-object prompts, and
                    // routeToolCall re-scopes via prompts.get(agentName) — a plain
                    // object crashes with '.get is not a function'. progress overrides
                    // so notifications flow to THIS worker's caller.
                    TOOL_ROUTER.call(method, routedPayload, {
                        ...MAIN_CONTEXT,
                        prompts: MAIN_CONTEXT.global?.prompts || new Map(),
                        progress: (m, p, t) => progress?.(m, p, t),
                        // Lets a handler that can act on cancellation (nested
                        // forge.call) stop when this worker is torn down (#45b).
                        // Handlers that ignore it are unaffected.
                        signal: relayAbort.signal
                    }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`MCP relay timed out after ${relayTimeout}ms (${method})`)), relayTimeout)
                    )
                ]);
                // Handlers return { content: [{ type: 'text', text }], isError }.
                // Unwrap so workers get clean data, not MCP envelopes.
                const contentBlock = result?.content?.[0];
                let parsed = contentBlock?.text !== undefined ? contentBlock.text : result;
                if (typeof parsed === 'string') {
                    try { parsed = JSON.parse(parsed); } catch {}
                }
                if (result?.isError) {
                    throw new Error(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
                }
                mcpPort1.postMessage({ type: 'mcp-result', id, result: parsed });
            } catch (err) {
                logger.warn(`[Forge:worker] MCP relay FAILED (${method}): ${err.message}`, null, 'Forge');
                mcpPort1.postMessage({ type: 'mcp-result', id, error: err.message });
            }
        });
        mcpPort1.start();
    }

    // ── Spawn the tool process ──
    // A forked CHILD PROCESS, not a worker thread (issue #37). Measured, not
    // assumed: a V8 heap-limit failure inside a worker thread aborts the entire
    // server — data/_test/forge-oom-probe.cjs reproduces it, object churn under a
    // 512 MB resourceLimits cap exits 134 with "FATAL ERROR: Reached heap limit".
    // A child owns its address space, so a tool that blows its heap now dies
    // alone. `--max-old-space-size` replaces resourceLimits; it bounds the tool's
    // heap without being able to take anything else down with it.
    //
    // Both the fork and the init send can throw, and both run BEFORE the promise
    // executor that registers listeners and timers — so either would leave a
    // RUNNING entry with nothing armed to reap it (issue #43). One try covers both.
    // stdio: the tool's own console output is inherited, exactly as it was when the
    // worker wrote to this process's stdout. Piping it would need a reader or the
    // child would block on a full pipe.
    let child;
    try {
        child = fork(WORKER_BOOTSTRAP, [], {
            execArgv: ['--max-old-space-size=512'],
            // Structured clone over IPC, so payload Buffers and typed arrays survive
            // without the JSON-shaped workarounds.
            serialization: 'advanced',
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            env: process.env
        });
        entry.child = child;
        entry.pid = child.pid;
        child.send({
            channel: 'init',
            source,
            args: args || {},
            workspacePath,
            toolStatePath,
            storagePath,
            vendorPath,
            storageRoot: STORAGE_ROOT,
            uncShare: STORAGE_TRANSLATOR ? STORAGE_TRANSLATOR.uncShare : null,
            localRoot: STORAGE_TRANSLATOR ? STORAGE_TRANSLATOR.localRoot : null,
            captureLogs,
            payload: payloadBuffers,
            defaultModel,
            // Which proxies the tool should get. The child cannot ask whether the
            // orchestrator has a browser agent or a tool router, so it is told.
            hasBrowser: Boolean(BROWSER_AGENT),
            hasMcp: Boolean(TOOL_ROUTER),
            mcpDepth: depth,
            maxLogEntries: CONFIG.maxLogEntries,
            maxLogLineChars: CONFIG.maxLogLineChars
        });
    } catch (err) {
        cleanup();
        if (child) child.kill('SIGKILL');
        throw new Error(`Failed to start tool process for "${name}": ${err.message}`);
    }
    logger.info(`[Forge:worker] Tool process spawned for "${name}" (pid ${entry.pid}), waiting (idle timeout: ${timeout}ms, hard cap: ${CONFIG.hardTimeout}ms)`, null, 'Forge');

    return new Promise((resolve, reject) => {
        rejectP = reject;
        // forge_stop settles the caller directly through this. Without it, a
        // stopped call unblocks only when the worker's exit event lands or when
        // an uncleared timer happens to fire — safety inherited from code that
        // merely forgets to clear its timers, which is not a guarantee (#43).
        entry.settle = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectP(err);
        };
        // Hard cap arms immediately (covers boot + run). The IDLE timer does
        // NOT arm here — it arms when the worker reports 'ready'. Under load
        // (e.g. VDB sync hashing blocks the main thread, CPU starvation slows
        // worker boot) boot alone can exceed the idle window; punishing
        // startup would kill healthy tools before their first progress event.
        hardTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            logger.warn(`[Forge:worker] HARD RUNTIME CAP for "${name}" after ${CONFIG.hardTimeout}ms total — terminating`, null, 'Forge');
            terminateAndReject(new Error(`Tool "${name}" exceeded the ${CONFIG.hardTimeout}ms hard runtime cap — worker terminated`));
        }, CONFIG.hardTimeout);
        // Boot guard: worker must wire up within bootTimeout. Without this a
        // hung spawn would only die at the 30-min hard cap.
        bootTimer = setTimeout(() => {
            if (settled || ready) return;
            settled = true;
            logger.warn(`[Forge:worker] BOOT TIMEOUT for "${name}" after ${CONFIG.bootTimeout}ms without ready — terminating`, null, 'Forge');
            terminateAndReject(new Error(`Tool "${name}" failed to start within ${CONFIG.bootTimeout}ms — worker terminated`));
        }, CONFIG.bootTimeout);

        // ── Client cancellation (issue #45) ──
        // The MCP layer hands every tool handler an AbortSignal on context and
        // aborts it on `notifications/cancelled`. Without this a cancelled
        // forge.call kept running: raum_tts_batch rendered 10 of 14 audio posts
        // after the user cancelled, spending the shared MiniMax pool unwatched
        // (2026-09-24). A cloud-cost tool must stop, not finish and admit it.
        if (signal) {
            if (signal.aborted) {
                settled = true;
                logger.warn(`[Forge:worker] CANCELLED before start: "${name}"`, null, 'Forge');
                cleanup();
                child.kill('SIGKILL');
                reject(new Error(`Tool "${name}" was cancelled by the client before it started`));
                return;
            }
            onAbort = () => {
                if (settled) return;
                settled = true;
                logger.warn(`[Forge:worker] CANCELLED by client: "${name}" — terminating`, null, 'Forge');
                terminateAndReject(new Error(`Tool "${name}" was cancelled by the client — worker terminated`));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }

        const handleLifecycle = (msg) => {
            if (msg.type === 'ready') { armOnReady(); return; }
            activity();
            if (msg.type === 'spawned') {
                if (!entry.tornDown) entry.spawned.add(msg.pid);
                return;
            }
            if (msg.type === 'spawn-exited') {
                entry.spawned.delete(msg.pid);
                return;
            }
            if (msg.type === 'log-suppressed') {
                // Past its entry limit the worker counts lines instead of forwarding
                // them (issue #49). Note this message still counts as activity above —
                // deliberate: a tool that only logs must not look hung once its logs
                // stop being forwarded.
                logsDropped = msg.count;
                return;
            }
            if (msg.type === 'result') {
                if (settled) return;
                settled = true;
                receivedResult = true;
                logger.info(`[Forge:worker] Result from "${name}": ${typeof msg.result === 'string' ? msg.result.length + ' chars' : typeof msg.result}`, null, 'Forge');
                cleanup();
                // The tool process does not exit on its own: the open IPC channel
                // keeps its event loop alive, so it must be killed after reporting.
                child.kill('SIGKILL');
                resolve({ result: msg.result, logs: captureLogs ? logs : undefined, logsDropped });
            } else if (msg.type === 'error') {
                if (settled) return;
                settled = true;
                logger.warn(`[Forge:worker] Error from "${name}": ${msg.error.slice(0, 200)}`, null, 'Forge');
                cleanup();
                child.kill('SIGKILL');
                reject(new Error(msg.error + (msg.stack ? '\n' + msg.stack : '')));
            } else if (msg.type === 'log' && captureLogs) {
                logs.push(msg);
            }
        };

        // Inbound dispatch: tagged relay traffic to the relay that registered for
        // that channel, lifecycle messages to handleLifecycle. An unknown channel
        // is ignored rather than failing the call — both ends are this codebase, so
        // it can only mean a version skew, and killing a call over that is worse.
        child.on('message', (msg) => {
            if (!msg || typeof msg !== 'object') return;
            if (msg.channel === 'lifecycle') { handleLifecycle(msg); return; }
            const relay = RELAY.get(msg.channel);
            if (relay) relay(msg);
        });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            logger.warn(`[Forge:worker] Tool process error for "${name}": ${err.message}`, null, 'Forge');
            cleanup();
            reject(err);
        });

        child.on('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            entry.exited = true;
            const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
            logger.warn(`[Forge:worker] Tool process for "${name}" ${how} (receivedResult=${receivedResult}, logs=${logs.length})`, null, 'Forge');
            cleanup();
            // If it left without sending a result or an error, it crashed — DON'T
            // resolve with undefined, report it as a failure. The message says so
            // explicitly, because since #37 this can no longer take the server with
            // it and the reader needs to know the blast radius was one call.
            if (receivedResult) {
                resolve({ result: undefined, logs: captureLogs ? logs : undefined, logsDropped });
            } else {
                const hint = (code === 134 || code === 3221225477)
                    ? ' That exit code is a hard abort — most likely the tool exhausted its 512 MB heap. It ran in its own process, so nothing else was affected.'
                    : ' Check the tool source for syntax errors, infinite loops, or a heap blow-out. It ran in its own process, so nothing else was affected.';
                reject(new Error(`Tool "${name}" ${how} without sending a result.${hint}`));
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
        // Re-checked inside the queue: the pre-check above is only a fast error
        // path, and two concurrent writes for the same new name both pass it. The
        // second then silently overwrote the first and reported success. Same
        // shape as forge_delete/forge_rollback.
        if (toolExists(name)) {
            return mcpError(`Tool "${name}" already exists. Use forge_update to modify it.`);
        }

        // Create tool file
        fs.mkdirSync(TOOLS_DIR, { recursive: true });
        fs.writeFileSync(toolPath(name), code);

        // Create per-tool state directory
        const sp = statePath(name);
        fs.mkdirSync(sp, { recursive: true });

        // Create per-tool storage output directory
        fs.mkdirSync(storagePath(name), { recursive: true });

        // Create per-tool vendor directory for durable non-output artifacts (#39)
        fs.mkdirSync(vendorPath(name), { recursive: true });

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

    // Checked here for a fast, cheap refusal, and again inside the queue in case
    // a call started while this one was queued.
    const live = runningCallsFor(name);
    if (live.length > 0) {
        return mcpError(`Tool "${name}" is running: ${describeRunning(live)}. Deleting removes its state and storage directories out from under the live worker — call forge_stop first.`);
    }

    return GIT_WRITE_QUEUE(async () => {
        const startedMeanwhile = runningCallsFor(name);
        if (startedMeanwhile.length > 0) {
            return mcpError(`Tool "${name}" began running while this delete was queued: ${describeRunning(startedMeanwhile)}. Nothing was deleted.`);
        }

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

        // Remove the vendor directory too — it is the largest thing a tool owns,
        // and a deleted tool must not leave a 17 MB binary behind (#39).
        const vd = vendorPath(name);
        if (fs.existsSync(vd)) {
            fs.rmSync(vd, { recursive: true, force: true });
        }

        await gitCommit(`Forge: delete tool "${name}"`);

        return mcpOk({
            op: 'delete',
            name,
            message: 'Tool deleted. Recoverable from git history via forge_rollback.'
        });
    });
}

// Thin wrapper. The real work lives in forgeCallInner so that the payload
// reservation it makes is released on EVERY exit path — including the handful of
// early `return mcpError(...)` guards — without a try/finally wrapping and
// re-indenting the whole call body (issue #53). `held` is an out-param: the inner
// function records how many bytes it reserved.
export async function forge_call(args, context) {
    const held = { bytes: 0 };
    try {
        return await forgeCallInner(args, context, held);
    } finally {
        releasePayloadBytes(held.bytes);
    }
}

async function forgeCallInner(args, context, held) {
    const { name, args: toolArgs, payload, timeout: reqTimeout, model } = args;
    const startedAt = Date.now();

    // Client cancellation (issue #45). The MCP layer puts an AbortSignal on every
    // tool handler's context and aborts it on `notifications/cancelled`; in-process
    // callers (chat agent, nested forge.call) pass no signal, which is correct —
    // a nested call is cancelled by killing the worker that awaits it.
    const signal = context?.signal || null;

    // Recursion depth guard. _depth is set by the MCP relay when a worker calls
    // forge.call; an external caller must not be able to influence it at all.
    //
    // This accepted ANY integer before, including negatives — and a negative is
    // not a smaller budget, it is a much larger one: the relay increments toward
    // the cap from wherever the count starts, so `_depth: -1000` bought roughly
    // 1000 levels of nested process forks. Rejected loudly rather than clamped,
    // because a caller sending it is confused about a reserved field and silent
    // correction would hide that.
    const rawDepth = args._depth;
    if (rawDepth !== undefined && (!Number.isInteger(rawDepth) || rawDepth < 0 || rawDepth > MAX_FORGE_DEPTH)) {
        return mcpError(`forge.call: _depth must be an integer in 0..${MAX_FORGE_DEPTH} when present (got ${JSON.stringify(rawDepth)}). This field is reserved for the MCP relay — omit it.`);
    }
    const depth = rawDepth ?? 0;
    if (depth > 0) {
        logger.info(`[Forge] forge_call NESTED (depth ${depth}/${MAX_FORGE_DEPTH}): "${name}"`, null, 'Forge');
    }

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
    const callId = `call-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

    // Resolve payload on main thread (scenario 3.x: fail before worker spawn)
    let payloadBuffers;
    try {
        const resolved = await resolvePayload(payload);
        payloadBuffers = resolved.buffers;
        held.bytes = resolved.reservedBytes;
        logger.info(`[Forge] Payload resolved for "${name}": ${payloadBuffers.length} buffers`, { sizes: payloadBuffers.map(b => b.length) }, 'Forge');
    } catch (e) {
        // resolvePayload released its own reservation before throwing. Zeroing the
        // out-param is what keeps the wrapper's finally from releasing it a second
        // time — with this line the release has exactly one owner on every path,
        // by construction rather than by careful reading.
        held.bytes = 0;
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

    // Cancelled while queued for a slot — do not start the work at all. The slot
    // is released immediately, so this path cannot leak one (cf. #40).
    if (signal?.aborted) {
        release();
        logger.warn(`[Forge] forge_call CANCELLED while queued: "${name}"`, null, 'Forge');
        return mcpError(`Tool "${name}" was cancelled by the client while waiting for a slot.`);
    }

    const workspacePath = createWorkspace();
    const toolStatePath = statePath(name);
    const toolStoragePath = storagePath(name);
    const progress = context.progress;

    // Snapshot storagePath BEFORE execution so we can diff after.
    // The tool may not exist yet on first call — snapshotDir tolerates a missing
    // directory, and dirHasEntries makes an empty one cheap to detect (issue #51).
    const storageBefore = (await dirHasEntries(toolStoragePath))
        ? (await snapshotDir(toolStoragePath)).files
        : new Map();

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
            vendorPath: vendorPath(name),
            timeout,
            captureLogs: true,
            progress,
            defaultModel: model || null,
            depth,
            callId,
            signal
        });
        logger.info(`[Forge] Worker DONE for "${name}": result type ${typeof workerData.result}, ${workerData.logs?.length || 0} log lines`, null, 'Forge');
    } catch (e) {
        logger.info(`[Forge] Worker FAILED for "${name}": ${e.message}`, null, 'Forge');
        return mcpError(`Tool execution failed: ${e.message}`);
    } finally {
        release();
        // Cleanup must not mask the call's real outcome. terminateAndReject now
        // rejects the caller while the worker is still dying, so on Windows an
        // EBUSY here can race the worker's last write — that must not replace
        // "timed out" with "resource busy" in the caller's error.
        try {
            await cleanupWorkspace(workspacePath);
        } catch (e) {
            logger.warn(`[Forge] workspace cleanup failed for "${name}": ${e.message}`, null, 'Forge');
        }
    }

    const durationMs = Date.now() - startedAt;
    const { result, logs, logsDropped } = workerData;
    // Oversized results go to toolStoragePath (persistent) so they survive
    // workspace cleanup and appear in _outputs.
    const sizeChecked = await enforceResultSize(result, toolStoragePath, callId);

    // Diff storagePath to find files the tool created or modified.
    const storageAfter = await snapshotDir(toolStoragePath);
    const newFiles = diffSnapshots(storageBefore, storageAfter.files);
    const outputs = newFiles.map(f => {
        const storageReadPath = path.posix.join('forge', name, f.rel);
        // Give callers a UNC path they can use from another LAN machine
        // (e.g. \\BADKID\Stuff\MCP_Storage\forge\<tool>\<file>) in addition
        // to the storage.read path. Skip when no translator is configured.
        const absoluteLocal = path.join(toolStoragePath, f.rel);
        const uncPath = STORAGE_TRANSLATOR ? STORAGE_TRANSLATOR.toUnc(absoluteLocal) : null;
        // Relative URL — the client prepends its own MCP origin (same as storage_read).
        const url = `/storage/${storageReadPath.split('/').map(encodeURIComponent).join('/')}`;
        const out = {
            name: f.rel,
            path: storageReadPath,
            url,
            ...(uncPath ? { uncPath } : {}),
            size: f.size
        };
        return out;
    });
    if (outputs.length > 0) {
        logger.info(`[Forge] "${name}" produced ${outputs.length} output file(s)`, { outputs: outputs.map(o => o.path) }, 'Forge');
    }

    // Detect silently empty results
    const resultIsEmpty = result === undefined || result === null ||
        (typeof result === 'object' && Object.keys(result).length === 0);

    const diagnostics = {
        callId,
        durationMs,
        resultIsEmpty,
        logCount: logs?.length || 0,
        droppedLogLines: logsDropped || 0,
        payloadCount: payloadBuffers?.length || 0,
        // True means the walk stopped at agents.forge.maxSnapshotDepth, so _outputs
        // may be missing files a tool buried deeper (issue #51). Reported rather
        // than silently truncated.
        outputsTruncated: storageAfter.truncated,
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
        ...(logsDropped ? { _logsNote: `${logsDropped} further log line(s) were suppressed (limits: ${CONFIG.maxLogEntries} entries, ${CONFIG.maxLogLineChars} chars/line — agents.forge.maxLogEntries in config.json raises them).` } : {}),
        ...(storageAfter.truncated ? { _outputsNote: `The output walk stopped at depth ${CONFIG.maxSnapshotDepth} — files nested deeper are missing from _outputs. Raise agents.forge.maxSnapshotDepth if that is real.` } : {}),
        ...(resultIsEmpty ? { _warning: 'Tool returned an empty result (undefined, null, or empty object). This is often a bug — check your console output (_logs) for errors.' } : {}),
        ...(sizeChecked.oversized ? { _note: 'Result was oversized, saved to storagePath and listed in _outputs' } : {})
    });
}

export async function forge_stop(args, context) {
    const { callId, name, all } = args;

    // No selector → read-only listing of running calls (safety: an accidental
    // bare invocation must not kill everything).
    if (!callId && !name && !all) {
        const running = [...RUNNING.values()].map(e => ({
            callId: e.callId,
            name: e.name,
            startedAt: new Date(e.startedAt).toISOString(),
            runtimeMs: Date.now() - e.startedAt,
            spawnedProcesses: e.spawned.size
        }));
        return mcpOk({ op: 'stop', running, count: running.length, note: 'Pass { callId }, { name }, or { all: true } to stop calls.' });
    }

    const targets = all
        ? [...RUNNING.values()]
        : [...RUNNING.values()].filter(e => (callId && e.callId === callId) || (name && e.name === name));
    if (targets.length === 0) {
        return mcpError(`No running forge call matches ${callId ? `callId "${callId}"` : `name "${name}"`}. Call forge_stop with no args to list running calls.`);
    }

    const stopped = [];
    for (const entry of targets) {
        const childCount = entry.spawned.size;
        logger.warn(`[Forge] forge_stop: terminating "${entry.name}" (callId ${entry.callId}, ${childCount} live child process(es))`, null, 'Forge');
        // Tear down the process tree FIRST, then make sure the tool process itself
        // is gone. teardownEntry deregisters synchronously — forge_stop must not
        // depend on the exit event to unregister the RUNNING entry, or a process
        // wedged in a kernel wait would leave a stale call listed forever (#43).
        teardownEntry(entry);
        // Settle the caller now rather than waiting for the exit event (#43).
        entry.settle?.(new Error(`Forge call "${entry.name}" was stopped by forge_stop`));
        if (entry.child && !entry.exited) entry.child.kill('SIGKILL');
        stopped.push({ callId: entry.callId, name: entry.name, spawnedProcessesKilled: childCount });
    }
    return mcpOk({ op: 'stop', stopped, count: stopped.length });
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

    // Rollback resets the tool's state directory, so it is as destructive to a
    // live call as delete is: resetState removes everything except .rollback,
    // wiping a worker's ctx.toolStatePath mid-write (#48).
    const live = runningCallsFor(name);
    if (live.length > 0) {
        return mcpError(`Tool "${name}" is running: ${describeRunning(live)}. Rollback resets its state directory — call forge_stop first.`);
    }

    return GIT_WRITE_QUEUE(async () => {
        // Snapshot current state (scenario 2.5: protect against rollback during state mismatch).
        // Awaited to completion BEFORE any git operation: the snapshot used to
        // complete synchronously by construction, and a half-written snapshot must
        // never end up in the commit (issue #51).
        await snapshotState(name);

        // Get the historical source
        let oldSource;
        try {
            oldSource = await gitShowFile(name, commit);
        } catch (e) {
            return mcpError(`Commit ${commit} not found for tool "${name}": ${e.message}`);
        }

        // Re-checked with no await between it and the two mutations below: a
        // call can spawn during the gitShowFile await above.
        const startedMeanwhile = runningCallsFor(name);
        if (startedMeanwhile.length > 0) {
            return mcpError(`Tool "${name}" began running while this rollback was queued: ${describeRunning(startedMeanwhile)}. Nothing was changed.`);
        }

        // Restore the source
        fs.writeFileSync(toolPath(name), oldSource);

        // Reset state to empty (new code may expect clean state)
        await resetState(name);

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
  ctx.browser    — Persistent browser proxy (shared Chrome instance with login state)
  ctx.mcp        — Workshop dispatcher proxy: call ANY MCP tool method from inside the tool
  ctx.progress   — Progress reporter (relayed to MCP client as notifications)
  ctx.payload    — Array of Buffers (resolved from payload[] file paths/URLs)
  ctx.workspacePath    — Absolute path to ephemeral per-call directory (deleted after call)
  ctx.toolStatePath    — Absolute path to persistent per-tool state directory (survives across calls)
  ctx.storagePath      — Absolute path to persistent per-tool output directory (survives across calls, user-visible)
  ctx.fileops          — Confined file ops rooted at ctx.storagePath (PREFER THIS over raw fs)
  ctx.spawn      — Child process spawner with bookkeeping (see ctx.spawn API below)
  ctx.args       — The args object passed to forge_call (same as first parameter)

GETTING DATA IN AND OUT — MCP STORAGE IS THE EXCHANGE CHANNEL
  Payload paths are opened on the SERVER (BADKID), never on the machine you are
  running on. A path that exists only on your own machine fails with ENOENT no
  matter how correct it looks. Both sides of a call therefore meet in MCP
  storage: stage the input there, pass its storage path as payload, and read the
  result back from the path reported in _outputs. A tool never needs to know
  where the caller is, and the caller never needs access to the tool's disk.

  Accepted forms for a file that lives in storage:
    \\\\BADKID\\Stuff\\MCP_Storage\\<path>   UNC — the server translates this to D:\\MCP_Storage\\<path>
    ../../MCP_Storage/<path>            relative to the SERVER's project root (D:\\DEV\\mcp_server), NOT the storage root
    D:\\MCP_Storage\\<path>               absolute, as seen on the server
    https://...                         fetched by the server

  Payload must be a JSON ARRAY of these strings — one string per item:
    { "name": "my_tool", "payload": ["../../MCP_Storage/in.pdf"] }
  Not an object, not a bare string, not a path tucked under args. A wrapper key
  such as {"item": [...]} or {"items": [...]} is rejected, and the key is named
  back to you.

  Output: a tool writes into ctx.storagePath, which is D:\\MCP_Storage\\forge\\<tool>\\
  on the server. forge_call reports every new file in _outputs as
  { name, path, url, uncPath, size } — use path with storage.read, or uncPath
  (\\\\BADKID\\Stuff\\MCP_Storage\\forge\\<tool>\\<file>) to copy it back over SMB from
  another machine. Prefer ctx.fileops.write for anything the caller should see;
  it is confined to storagePath and atomic.

ctx.mcp API (workshop dispatcher — same router the chat agent uses)
  Every call relays to the main thread, where credentials (GIT_TOKEN etc.)
  live. Workers never see secrets. Method names are 'agent.action' form.

  await ctx.mcp.call('git.issue_list', { owner, repo, state: 'open' })
  await ctx.mcp.call('storage.read', { path: 'docs/foo.md' })
  await ctx.mcp.call('memory.recall', { query: '...' })
  await ctx.mcp.call('forge.call', { name: 'other_tool', args: {...} })  ← nested call

  Returns the parsed result (JSON when parseable, string otherwise).
  Errors REJECT (including tool isError results) — use try/catch only around
  calls whose failure is an expected, handled outcome.

  Nesting: forge.call from a worker is allowed up to depth 3. A tool calling
  forge.call re-enters the forge — the depth guard fails loud beyond 3 levels.
  Prefer calling OTHER tools (git.*, storage.*) over nesting forge.call; keep
  orchestration flat when you can.

ctx.fileops API (the fileops engine — same as the storage agent uses)
  Every mutation is atomic (temp+rename). Paths are confined to the tool's
  storage dir; escapes throw. Prefer this over raw fs for anything user-visible.

  await ctx.fileops.read(path, { encoding? })              → { content, size }
  await ctx.fileops.write(path, content, { overwrite? })   → { size }  (throws if exists without overwrite:true)
  await ctx.fileops.append(path, content)                  → { size }
  await ctx.fileops.replace(path, marker, replacement, { occurrence? })  → { size, replacements }
      Server-side marker swap. occurrence: 'first' (default) | 'last' | 'all'.
      Throws if marker not found. The large-file edit path — no read-modify-write round trip.
  await ctx.fileops.readWindow(path, { offset,length } | { head } | { tail })  → { content, size, window }
  await ctx.fileops.copy(from, to, { overwrite? })         → { from, to, size }
  await ctx.fileops.move(from, to)                         → { from, to, type }
  await ctx.fileops.remove(path, { recursive? })           → { deleted: true }
  await ctx.fileops.list(path?, { recursive?, pattern? })  → { entries }
  await ctx.fileops.stat(path)                             → { exists, type, size, modified }
  await ctx.fileops.grep(path, pattern, { context?, ignoreCase? })  → { matches, truncated }
  await ctx.fileops.hash(path, { algo? })                  → { hash, size }
  await ctx.fileops.batch(ops, { onError? })               → { results }

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

ctx.browser API (persistent browser — shared with the MCP browser agent)
  Gives forge tools access to the main-thread browser: a persistent Chrome
  instance with real cookies, login state, and browsing history. This means
  authenticated sites (Google, GitHub, etc.) work without re-login, and the
  browser profile avoids bot detection that hits clean instances.

  All calls are relayed via MessagePort to the main thread (same process).
  Returns parsed data (text or JSON object), not MCP envelopes.

  const session = await ctx.browser.session_create({ viewport?: {width,height}, visible?: bool })
    → { sessionId }  (pass to all subsequent calls)

  await ctx.browser.goto({ sessionId, url, waitFor?, timeout? })
    → navigates to a URL. waitFor: CSS selector to wait for.

  await ctx.browser.content({ sessionId, mode? })
    → mode: "text" (default) | "html" | "markdown" | "screenshot"
    → screenshot returns base64 PNG string

  await ctx.browser.evaluate({ sessionId, script, waitFor? })
    → runs JS in the page. script is a string expression (e.g. "document.title").
    → returns the expression's value. Statement-style scripts need explicit 'return'.

  await ctx.browser.click({ sessionId, selector?, waitAfter? })
  await ctx.browser.fill({ sessionId, fields: [{selector,value}], submit?, waitAfter? })
  await ctx.browser.type({ sessionId, selector?, text?, keystrokes? })
  await ctx.browser.scroll({ sessionId, direction?, amount? })
  await ctx.browser.inspect({ sessionId, selector, screenshot? })
  await ctx.browser.console({ sessionId })  → captured console messages
  await ctx.browser.wait({ sessionId, selectors?, text?, urlPattern?, timeout? })
  await ctx.browser.metadata({ sessionId })  → viewport, userAgent, age
  await ctx.browser.session_list()  → active sessions
  await ctx.browser.session_close({ sessionId })  → close when done (or let idle timer handle it)

  Example: scrape a JS-rendered page
    const { sessionId } = await ctx.browser.session_create();
    await ctx.browser.goto({ sessionId, url: 'https://example.com', waitFor: '.results' });
    const html = await ctx.browser.content({ sessionId, mode: 'html' });
    const data = await ctx.browser.evaluate({ sessionId, script: '[...document.querySelectorAll(".item")].map(e => e.textContent)' });
    await ctx.browser.session_close({ sessionId });

ctx.browser is null when the browser agent is not loaded (e.g. disabled in config).

ctx.progress API
  ctx.progress({ message: string, progress: number, total: number })
  ctx.progress("Working...", 50, 100)  — also accepts positional args

  Best practice for long operations (loops, multi-phase work):
    - Report phase boundaries: ctx.progress("Phase 1: distilling...", 10, 100)
    - Report loop iterations: ctx.progress("Item " + i + "/" + total, 10 + 80 * i / total, 100)
    - Always finish at 100: ctx.progress("Done", 100, 100) before returning
    - The MCP client throttles + deduplicates; emit freely, percentages are
      monotonic and the final 100% always arrives.
    - Server-side tools use the shared createProgressReporter() helper
      (src/utils/progress-reporter.js) for throttle + monotonic clamping —
      forged tools can call ctx.progress directly since they own their pacing.

ctx.spawn API (child processes with kill-on-teardown bookkeeping — issue #43)
  const child = ctx.spawn(cmd, args, opts?)  — same signature as child_process.spawn

  EVERY child process a tool starts MUST go through ctx.spawn, never a direct
  child_process.spawn/import. The PID is registered with the orchestrator so
  that on timeout, cancel (forge.stop), or crash the ENTIRE process tree is
  killed (taskkill /T /F on Windows). Processes that exit cleanly deregister
  themselves. A tool that leaves a still-running process behind at return will
  have it killed at teardown — finish, await, or explicitly kill background
  work before returning.

  The returned object is the standard ChildProcess: use child.stdout/stderr
  streams, await the 'exit'/'close' events, etc.

  Example:
    const yt = ctx.spawn('yt-dlp', ['-x', '--audio-format', 'wav', url]);
    yt.stderr.on('data', d => ctx.progress('yt-dlp: ' + d.toString().slice(0, 120)));
    await new Promise((res, rej) => { yt.on('close', res); yt.on('error', rej); });

ctx.payload
  Array of Node.js Buffers. Each item corresponds to a payload[] entry passed to forge_call.
  payload: ["C:\\\\path\\\\to\\\\file.pdf", "https://example.com/data.csv"]
  → ctx.payload[0] is the PDF Buffer, ctx.payload[1] is the CSV Buffer.
  Empty array if no payload was passed.

  WHERE THOSE PATHS RESOLVE: on the SERVER (BADKID), not on the caller's machine.
  A caller-local path that is not also present on the server fails with ENOENT.
  Relative paths resolve against the server's project root. See "GETTING DATA IN
  AND OUT — MCP STORAGE IS THE EXCHANGE CHANNEL" above: stage inputs in MCP
  storage and pass the storage path.

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

  Durable non-output artifacts (a vendored binary, a downloaded model):
    // ctx.toolVendorPath — for things too big or too binary for toolStatePath.
    // Lives outside the source checkout (so a re-clone or a directory move cannot
    // destroy it) and outside storagePath (so it never appears in _outputs as if
    // the tool had produced it). It IS visible as a single .vendor directory to
    // storage tools, and it is NOT vector-indexed. Spawn from here, e.g.
    // ctx.spawn(join(ctx.toolVendorPath, 'yt-dlp.exe'), [...]) — and note that a
    // binary started any other way is not reaped on timeout or forge_stop.

  Persistent output (survives across calls, user-visible via storage):
    // PREFERRED: use ctx.fileops — atomic, confined
    await ctx.fileops.write('report.md', markdown);
    // (raw fs still works, but bypasses confinement)

  Ephemeral temp files (deleted after call):
    const tmpFile = join(ctx.workspacePath, 'intermediate.bin');

CONSTRAINTS
  - ISOLATION: your tool runs in its own PROCESS with a 512 MB heap cap, not in
    the server. If it exhausts its heap, crashes, or aborts, that ONE call fails
    — the server and every other client are unaffected. It was not always so
    (a worker-thread heap blow-out used to kill the whole server), which is why
    this is worth knowing: you can let a tool die loudly instead of guarding
    against it.
  - Timeout: IDLE timeout — 5 min default, 15 min max. Arms when the tool
    reports ready (boot excluded); resets on any activity (ctx.progress,
    ctx.mcp/gateway/browser relay calls, logs). A tool making steady progress
    NEVER times out regardless of total duration. A silent (hung) tool is killed
    after the idle window. Absolute backstops: 60s boot guard + 30 min total
    runtime, not reset by activity (#27). Still emit progress per work phase —
    that's what keeps long tools alive.
  - Max payload: 100 MB per item, 10 items, and a SHARED budget across all
    concurrent calls (agents.forge.maxTotalPayloadBytes, 512 MB). Exceeding it
    refuses the call with the current total in the message.
  - Max return: 10KB inline (larger results saved to storage, pointer returned)
  - Max concurrent calls: 8 (configurable)
  - Log capture: the first 1000 lines (4000 chars each, longer lines truncated
    with a marker) are returned in _logs; the rest are counted and reported.
    Raise agents.forge.maxLogEntries / maxLogLineChars if you need more.
  - _outputs is walked to depth 4; anything deeper is omitted and reported in
    _diagnostics.outputsTruncated. Write outputs near the root of storagePath.
  - Packages: must be in allowlist (config.json agents.forge.allowedPackages)
  - Child processes ONLY via ctx.spawn (auto-kill on timeout/cancel — see above).
    A direct child_process import bypasses tree-kill bookkeeping, so it is now
    ENFORCED: importing child_process or worker_threads from tool code throws at
    load time, naming the specifier. The check is a module-resolution hook, so it
    catches static imports, dynamic import(), and string-built specifiers — but
    NOT createRequire(...)('child_process'), which uses the CJS loader. Take that
    route and you own the orphaned process nobody can reap.
  - No worker_threads from tools (enforced as above).
  - A tool calling process.exit() ends only its own process; the call then fails
    with "exited without sending a result". Don't.
  - Node built-ins (fs, path, crypto, etc.) are available

BEST PRACTICES
  - Always call ctx.progress() for long operations — the client sees it in real time
  - Use ctx.toolStatePath for caches, indexes, learned data
  - Use ctx.workspacePath for intermediate files that should not persist
  - Return structured objects, not formatted strings — the caller can format
  - Throw on errors — the forge catches and reports them clearly
  - Test with small payloads first, then scale up

LOCAL SERVICES (BADKID execution context)
  IMPORTANT: Forge tools execute on the workshop host (BADKID, 192.168.0.100).
  Inside a forge tool, "localhost" means BADKID — NOT the machine you (the LLM)
  are running on. If you are working from Coolkid or any other LAN client, the
  services below are on BADKID. From outside a forge tool, reach them at
  http://192.168.0.100:<port>.

  Services may not always be running — handle connection errors gracefully.
  Check /health first if unsure.

  ┌───────────────┬──────┬────────────────────────────────────────────────────┐
  │ Service       │ Port │ What it does                                        │
  ├───────────────┼──────┼────────────────────────────────────────────────────┤
  │ MCP Server    │ 3100 │ This server. Storage, memory, browser, git, vision. │
  │               │      │ Use ctx.browser / ctx.fileops instead of HTTP.      │
  │ LLM Gateway   │ 3400 │ LLM routing. Use ctx.gateway instead of HTTP.       │
  │               │      │ Models: call ctx.gateway.listModels() with cost     │
  │               │      │ metadata (tier, cost, speed, notes) to pick wisely. │
  │ nMedia        │ 3500 │ ffmpeg-based media conversion (audio/image/video).  │
  │ nVoice        │ 2244 │ Speech-to-text, alignment, archival transcription.  │
  │ nSpeech       │ 8000 │ Text-to-speech synthesis (Kokoro, Chatterbox, etc). │
  └───────────────┴──────┴────────────────────────────────────────────────────┘

  nMedia (localhost:3500) — media conversion via ffmpeg
    POST /audio           — convert/transcode audio (multipart: file field)
    POST /image           — convert/optimize image (multipart: file field)
    POST /image/crop      — crop image (multipart: file field + crop params)
    POST /video           — convert/transcode video (multipart: file field)
    GET  /health          — liveness check
    GET  /v1/optimize/progress/:jobId — progress for async jobs
    Cost: free (local ffmpeg). Fast for small files.

  nVoice (localhost:2244) — speech-to-text (Python, may not always be running)
    POST /v1/audio/transcriptions    — batch STT (audio file → text)
    POST /v1/audio/align             — word-level timestamps for known text
    POST /v1/audio/transcribe-archive — archival STT + diarization (SSE stream)
    GET  /v1/models                  — models supported by current engine
    GET  /health                     — warming/ready status
    Cost: free (local GPU). Latency depends on audio length + model.

  nSpeech (localhost:8000) — text-to-speech (Python, may not always be running)
    POST /v1/audio/speech     — synthesize speech (streams audio back)
    GET  /v1/voices           — list available voices for current engine
    POST /v1/voices/clone     — persist a cloned voice from sample
    POST /v1/voices/preview   — temporary clone + preview audio
    POST /v1/voices/mix       — blend two voices
    GET  /health              — warming/ready status
    Cost: free (local GPU). Engines: Kokoro, Chatterbox, dots.tts, F5-TTS, VibeVoice.

  Example: convert audio with nMedia from a forge tool
    const formData = new FormData();
    formData.append('file', new Blob([ctx.payload[0]]), 'input.wav');
    const res = await fetch('http://localhost:3500/audio', { method: 'POST', body: formData });
    const converted = await res.arrayBuffer();`;

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
        hardTimeout: agentConfig.hardTimeout ?? DEFAULTS.hardTimeout,
        bootTimeout: agentConfig.bootTimeout ?? DEFAULTS.bootTimeout,
        maxPayloadSize: agentConfig.maxPayloadSize ?? DEFAULTS.maxPayloadSize,
        maxPayloadItems: agentConfig.maxPayloadItems ?? DEFAULTS.maxPayloadItems,
        maxConcurrentCalls: agentConfig.maxConcurrentCalls ?? DEFAULTS.maxConcurrentCalls,
        queueTimeout: agentConfig.queueTimeout ?? DEFAULTS.queueTimeout,
        maxReturnSize: agentConfig.maxReturnSize ?? DEFAULTS.maxReturnSize,
        maxRollbackSnapshots: agentConfig.maxRollbackSnapshots ?? DEFAULTS.maxRollbackSnapshots,
        maxSnapshotDepth: agentConfig.maxSnapshotDepth ?? DEFAULTS.maxSnapshotDepth,
        maxTotalPayloadBytes: agentConfig.maxTotalPayloadBytes ?? DEFAULTS.maxTotalPayloadBytes,
        maxLogEntries: agentConfig.maxLogEntries ?? DEFAULTS.maxLogEntries,
        maxLogLineChars: agentConfig.maxLogLineChars ?? DEFAULTS.maxLogLineChars,
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

    // NOTE: forge deliberately does NOT stamp a host into output URLs (same
    // design as the storage agent). Output `url` fields are RELATIVE paths
    // (/storage/...); the client prepends its own MCP origin.

    GATEWAY_CLIENT = context.gateway;

    // Browser agent handlers — module-level exports (browser_session_*),
    // NOT the init() instance (which only returns { getPage, fetch }).
    // The init instance is for internal cross-agent use (research); the
    // tool handlers are what forge workers need.
    BROWSER_AGENT = browserAgent;
    if (BROWSER_AGENT?.browser_session_create) {
        logger.info('[Forge] Browser agent linked — ctx.browser available for forge tools', null, 'Forge');
    } else {
        logger.warn('[Forge] Browser agent not found — ctx.browser will not be available for forge tools', null, 'Forge');
    }

    // Workshop dispatcher (toolRouter) — shared object created in server.js
    // before loadAgents, populated after. Lets forge workers call any MCP
    // method (git.*, storage.*, memory.*, ..., forge.*) via ctx.mcp.
    MAIN_CONTEXT = context;
    TOOL_ROUTER = context.toolRouter || null;
    if (TOOL_ROUTER) {
        logger.info('[Forge] Tool router linked — ctx.mcp available for forge tools', null, 'Forge');
    } else {
        logger.warn('[Forge] toolRouter not found in init context — ctx.mcp will not be available for forge tools', null, 'Forge');
    }

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
    // 1. git fsck — verify repo integrity (--no-dangling: the dangling-object
    //    report is not a defect; fsck has no --quiet to suppress it with)
    try {
        await git(['fsck', '--no-dangling']);
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

// ── Test seam ────────────────────────────────────────────────────────────────
// The payload-budget, snapshot and result-size helpers read CONFIG, which init()
// fills. Tests must NOT call init(): it runs git in the live repo and sweeps
// data/forge/workspace, which would delete a running call's scratch directory if
// the server happened to be up. So setConfig lets them exercise the helpers with
// an explicit configuration instead (see data/_test/forge-payload-budget.cjs).
// Nothing here is part of the agent's tool contract; the loader only registers the
// handlers named in this agent's config.json.
export const __test = {
    setConfig(partial) {
        CONFIG = { ...DEFAULTS, ...partial };
        return CONFIG;
    },
    resolvePayload,
    releasePayloadBytes,
    payloadBudgetStatus,
    snapshotDir,
    dirHasEntries,
    enforceResultSize,
    diffSnapshots
};
