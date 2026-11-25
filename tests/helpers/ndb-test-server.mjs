/**
 * Spawns a real `ndb serve` process for tests.
 *
 * Binary resolution: $NDB_ROOT (default D:\DEV\nDB) → target/release/ndb[.exe],
 * falling back to target/debug/ndb[.exe]. A missing binary is a hard error —
 * there is no in-process substitute for the HTTP service.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const EXE_NAME = process.platform === 'win32' ? 'ndb.exe' : 'ndb';
const NDB_ROOT = process.env.NDB_ROOT || 'D:\\DEV\\nDB';
// `--db`/`--dir` creation defaults to v1 (StorageFormat::Auto). With
// NDB_TEST_RAM=1 every database the test mounts is a v3 (RAM-first) folder, so
// the whole suite runs on the RAM engine instead of the v1 compatibility path.
const RAM_FIRST = process.env.NDB_TEST_RAM === '1';

function resolveBinary() {
    if (process.env.NDB_BIN) {
        if (!fs.existsSync(process.env.NDB_BIN)) {
            throw new Error(`ndb serve binary not found at NDB_BIN=${process.env.NDB_BIN}`);
        }
        return process.env.NDB_BIN;
    }
    const candidates = [
        path.join(NDB_ROOT, 'target', 'release', EXE_NAME),
        path.join(NDB_ROOT, 'target', 'debug', EXE_NAME),
    ];
    const found = candidates.find(p => fs.existsSync(p));
    if (!found) {
        throw new Error(
            `ndb serve binary not found (looked for ${candidates.join(', ')}). ` +
            'Build it: cd D:\\DEV\\nDB && cargo build --release'
        );
    }
    return found;
}

/** Run a `ndb` CLI subcommand; any non-zero exit is a hard error. */
function runCli(binary, args, label) {
    const res = spawnSync(binary, args, { encoding: 'utf8', windowsHide: true });
    if (res.status !== 0) {
        throw new Error(`${label} failed (${args.join(' ')}): ${res.stderr || res.stdout}`);
    }
    return res.stdout;
}

/** Convert one database folder to v3 RAM-first (init when it does not exist). */
function toRamFirst(binary, dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (!fs.existsSync(dbPath)) {
        runCli(binary, ['init', dbPath, '--ram'], 'ndb init --ram');
        return;
    }
    if (fs.existsSync(path.join(dbPath, 'manifest.json'))) {
        const manifest = JSON.parse(fs.readFileSync(path.join(dbPath, 'manifest.json'), 'utf8'));
        if (manifest.version === 3) return;
    }
    runCli(binary, ['migrate', dbPath, '--ram'], 'ndb migrate --ram');
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(err => (err ? reject(err) : resolve(port)));
        });
        srv.on('error', reject);
    });
}

async function waitForHealth(url, timeoutMs, isAlive) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        if (!isAlive()) throw new Error(`ndb serve exited before becoming healthy (${url})`);
        try {
            const res = await fetch(`${url}/health`);
            if (res.ok) {
                const body = await res.json();
                if (body?.ok === true) return body;
            }
            lastErr = new Error(`/health -> ${res.status}`);
        } catch (err) {
            lastErr = err;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`ndb serve did not become healthy within ${timeoutMs}ms at ${url}: ${lastErr?.message}`);
}

/**
 * Start `ndb serve`.
 *
 * @param {object} opts
 * @param {string} [opts.rootDir]  mount every child folder holding data.jsonl (--dir)
 * @param {Array<[string,string]>} [opts.dbs]  explicit name=path mounts (--db)
 * @param {string} [opts.token]    bearer token (default: none)
 * @param {number} [opts.port]     fixed port (default: free ephemeral port)
 * @param {number} [opts.timeoutMs] health wait budget (default 20000)
 * @returns {Promise<{url:string, port:number, token:string|null, stop:()=>Promise<void>}>}
 */
export async function startNdbTestServer({ rootDir, dbs, token, port, timeoutMs = 20_000 } = {}) {
    if (!rootDir && !(dbs && dbs.length > 0)) {
        throw new Error('startNdbTestServer: rootDir (--dir) or dbs ([name, path] pairs) is required');
    }
    const binary = resolveBinary();
    if (RAM_FIRST) {
        for (const [, dbPath] of dbs || []) toRamFirst(binary, dbPath);
        if (rootDir) {
            for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const child = path.join(rootDir, entry.name);
                if (fs.existsSync(path.join(child, 'data.jsonl')) || fs.existsSync(path.join(child, 'manifest.json'))) {
                    toRamFirst(binary, child);
                }
            }
        }
    }
    const chosenPort = port ?? await getFreePort();
    const args = ['serve', '--bind', '127.0.0.1', '--port', String(chosenPort)];
    if (rootDir) args.push('--dir', rootDir);
    for (const [name, dbPath] of dbs || []) args.push('--db', `${name}=${dbPath}`);
    if (token) args.push('--token', token);

    const url = `http://127.0.0.1:${chosenPort}`;
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    let exited = false;
    let exitInfo = null;
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('exit', (code, signal) => {
        exited = true;
        exitInfo = { code, signal };
    });

    const stop = async () => {
        if (exited) return;
        child.kill();
        await new Promise(resolve => {
            const timer = setTimeout(() => {
                if (!exited) child.kill('SIGKILL');
                resolve();
            }, 5_000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    };

    try {
        await waitForHealth(url, timeoutMs, () => !exited);
    } catch (err) {
        await stop();
        throw new Error(
            `${err.message}\nndb serve stdout:\n${stdout}\nstderr:\n${stderr}` +
            (exitInfo ? `\nexit: ${JSON.stringify(exitInfo)}` : '')
        );
    }

    return { url, port: chosenPort, token: token ?? null, stop };
}
