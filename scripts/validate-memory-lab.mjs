// Validates a memory-refactor lab snapshot produced by scripts/snapshot-memory-lab.ps1.
//
//   node scripts/validate-memory-lab.mjs --snapshot D:\MCP_Lab\memory-refactor\<name>
//
// Opens ONLY the lab work copy through the native loaders (never agent init()),
// asserts every opened path is inside <snapshot>\work and outside every live
// data root, compares reference/work hashes, and prints a compact JSON report.
// Exit code 1 when any check fails.
//
// Deliberately no Gateway calls, no timers, no writes into the lab copy:
// nDB opens with persistence 'lazy', nVDB only lists collections and reads
// collection stats (no createCollection / search / flush / compact).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function fail(message) {
    throw new Error(message);
}

function parseArgs(argv) {
    const args = { snapshot: null };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--snapshot' || token === '--snapshot-root' || token === '--snapshotRoot') {
            args.snapshot = argv[++i];
        } else if (token.startsWith('--snapshot=')) {
            args.snapshot = token.slice('--snapshot='.length);
        } else {
            fail(`unknown argument: ${token}`);
        }
    }
    if (!args.snapshot) fail('missing --snapshot <snapshot root>');
    return args;
}

function fullPath(p) {
    return path.resolve(p);
}

function isInside(child, parent) {
    const rel = path.relative(fullPath(parent), fullPath(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realPath(p) {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let read;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

// Live data roots resolved from config.json. These are the paths this script
// must never open: the lab copy is the only thing under test.
function resolveLiveRoots() {
    const configPath = path.join(REPO_ROOT, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const agents = config.agents || {};
    const resolve = (p, fallback) => {
        const value = p || fallback;
        return path.isAbsolute(value) ? fullPath(value) : fullPath(path.join(REPO_ROOT, value));
    };

    const roots = [];
    roots.push(path.dirname(resolve(agents.memory?.dbPath, 'data/memories/data.jsonl')));
    roots.push(resolve(agents.vdb?.dbPath, 'data/nvdb'));
    roots.push(resolve(agents.chat?.dir, 'data/chat/sessions'));
    roots.push(resolve(agents.storage?.root, 'D:/MCP_Storage'));
    roots.push('D:/SRV/LLM-Gateway-Chat/server/data');
    roots.push(path.join(REPO_ROOT, 'data'));
    return roots.map(fullPath);
}

function createGuard(workRoot, liveRoots) {
    const assertNotLive = (target, label) => {
        for (const live of liveRoots) {
            if (isInside(target, live)) {
                fail(`${label} points into a LIVE data root and must not be opened: ${target} (live root: ${live})`);
            }
        }
    };
    return {
        assertNotLive,
        // Every open/read of lab data goes through here.
        assertWork(target, label) {
            const resolved = fullPath(target);
            if (!isInside(resolved, workRoot)) {
                fail(`${label} is outside the lab work root: ${resolved} (work root: ${workRoot})`);
            }
            assertNotLive(resolved, label);
            if (fs.existsSync(resolved)) {
                const real = fullPath(realPath(resolved));
                if (!isInside(real, workRoot)) {
                    fail(`${label} resolves outside the lab work root (symlink escape): ${real}`);
                }
                assertNotLive(real, `${label} (resolved)`);
            }
            return resolved;
        }
    };
}

function listJsonl(dbDir) {
    return fs.readdirSync(dbDir).filter((name) => name.endsWith('.jsonl'));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const snapshotRoot = fullPath(args.snapshot);
    const referenceRoot = path.join(snapshotRoot, 'reference');
    const workRoot = path.join(snapshotRoot, 'work');
    const manifestPath = path.join(snapshotRoot, 'manifest.json');

    const liveRoots = resolveLiveRoots();
    const guard = createGuard(workRoot, liveRoots);

    const report = {
        tool: 'validate-memory-lab',
        version: 1,
        snapshotRoot,
        referenceRoot,
        workRoot,
        generatedAt: new Date().toISOString(),
        mode: null,
        liveRoots,
        checks: [],
        warnings: [],
        failures: []
    };

    const check = (name, fn) => {
        try {
            const detail = fn();
            report.checks.push({ name, ok: true, detail });
        } catch (e) {
            report.checks.push({ name, ok: false, error: e.message });
            report.failures.push({ check: name, error: e.message });
        }
    };

    if (!fs.existsSync(snapshotRoot)) {
        report.failures.push({ check: 'snapshot-root', error: `snapshot root missing: ${snapshotRoot}` });
    }
    if (report.failures.length > 0) {
        report.ok = false;
        finish(report, 1);
        return;
    }

    guard.assertNotLive(snapshotRoot, 'snapshot root');

    let manifest = null;
    check('structure', () => {
        for (const [label, dir] of [['reference', referenceRoot], ['work', workRoot]]) {
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
                fail(`${label} directory missing: ${dir}`);
            }
        }
        if (!fs.existsSync(manifestPath)) fail(`manifest missing: ${manifestPath}`);
        return { reference: referenceRoot, work: workRoot, manifest: manifestPath };
    });

    check('manifest', () => {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (!manifest.mode) fail('manifest has no mode');
        report.mode = manifest.mode;
        if (manifest.copyStatus !== 'ok') fail(`manifest copyStatus is ${manifest.copyStatus}`);
        if (manifest.mode === 'crash-consistent-copy') {
            if (manifest.pointInTime !== false) fail('crash-consistent-copy must not claim pointInTime');
            if (!manifest.warning) fail('crash-consistent-copy manifest has no warning');
            report.warnings.push('snapshot is crash-consistent (not point-in-time) by design');
        }
        if (manifest.mode === 'vss' && manifest.pointInTime !== true) {
            fail('vss snapshot manifest must record pointInTime: true');
        }
        if (fullPath(manifest.workRoot) !== workRoot) fail(`manifest workRoot mismatch: ${manifest.workRoot}`);
        if (fullPath(manifest.referenceRoot) !== referenceRoot) fail(`manifest referenceRoot mismatch: ${manifest.referenceRoot}`);
        for (const src of manifest.sources || []) {
            if (!isInside(src.workPath, workRoot)) fail(`manifest source ${src.name} workPath escapes work root`);
            if (!isInside(src.referencePath, referenceRoot)) fail(`manifest source ${src.name} referencePath escapes reference root`);
        }
        return {
            mode: manifest.mode,
            sources: (manifest.sources || []).length,
            totalFiles: manifest.totals?.copiedFiles ?? null,
            totalBytes: manifest.totals?.copiedBytes ?? null
        };
    });

    check('manifest-hash-sidecar', () => {
        const sidecar = path.join(snapshotRoot, 'MANIFEST.sha256');
        if (!fs.existsSync(sidecar)) fail(`sidecar missing: ${sidecar}`);
        const text = fs.readFileSync(sidecar, 'utf8').trim();
        const recorded = text.split(/\s+/)[0].toLowerCase();
        const actual = sha256File(manifestPath);
        if (recorded !== actual) fail(`manifest sha256 mismatch: recorded ${recorded}, actual ${actual}`);
        return { sha256: actual };
    });

    check('reference-work-hashes', () => {
        const critical = manifest?.criticalHashes || [];
        if (critical.length === 0) fail('manifest has no criticalHashes');
        const verified = [];
        for (const entry of critical) {
            const rel = entry.path.split('/').join(path.sep);
            const refFile = path.join(referenceRoot, rel);
            const workFile = path.join(workRoot, rel);
            guard.assertWork(workFile, `critical file ${entry.path}`);
            guard.assertNotLive(refFile, `critical reference file ${entry.path}`);
            if (!fs.existsSync(refFile)) fail(`reference copy missing: ${entry.path}`);
            if (!fs.existsSync(workFile)) fail(`work copy missing: ${entry.path}`);
            const refHash = sha256File(refFile);
            const workHash = sha256File(workFile);
            if (refHash !== workHash) fail(`reference/work hash mismatch: ${entry.path}`);
            if (entry.sha256 && entry.sha256.toLowerCase() !== workHash) {
                fail(`manifest hash mismatch for ${entry.path}: recorded ${entry.sha256}, actual ${workHash}`);
            }
            verified.push(entry.path);
        }
        return { verified: verified.length, files: verified };
    });

    // ── nDB: copied memory database ──────────────────────────────────────────
    check('memory-ndb', () => {
        const source = (manifest?.sources || []).find((s) => s.role === 'memory-ndb');
        if (!source) return { skipped: 'no memory-ndb source in manifest' };
        const dbDir = guard.assertWork(source.workPath, 'memory nDB directory');
        const jsonl = listJsonl(dbDir);
        if (jsonl.length !== 1) fail(`expected exactly one .jsonl in ${dbDir}, found ${jsonl.length}`);
        const dbFile = guard.assertWork(path.join(dbDir, jsonl[0]), 'memory nDB file');

        const { Database } = loadNdb();
        const db = Database.open(dbFile, { persistence: 'lazy' });
        let len;
        let iterated;
        try {
            len = db.len();
            iterated = db.iter().length;
        } finally {
            db.close();
        }
        if (len !== iterated) fail(`nDB len()=${len} disagrees with iter()=${iterated}`);
        return { file: dbFile, len, iterated };
    });

    // ── nVDB: copied vector database ─────────────────────────────────────────
    check('nvdb', () => {
        const source = (manifest?.sources || []).find((s) => s.role === 'nvdb');
        if (!source) return { skipped: 'no nvdb source in manifest' };
        const dbDir = guard.assertWork(source.workPath, 'nVDB directory');

        const { Database } = loadNvdb();
        const db = new Database(dbDir);
        let collections;
        const collectionStats = {};
        try {
            collections = db.listCollections();
            for (const name of ['memory', 'storage']) {
                if (!collections.includes(name)) {
                    report.warnings.push(`nVDB collection '${name}' not present in the lab copy`);
                    collectionStats[name] = { present: false };
                    continue;
                }
                const coll = db.getCollection(name);
                try {
                    // nVDB exposes `stats` as a native getter in some builds and as
                    // a method in others; accept both without calling anything else.
                    const stats = typeof coll.stats === 'function' ? coll.stats() : coll.stats;
                    collectionStats[name] = { present: true, stats };
                } finally {
                    if (typeof coll.close === 'function') coll.close();
                }
            }
        } finally {
            if (typeof db.close === 'function') db.close();
        }
        return { dir: dbDir, collections, collectionStats };
    });

    check('nvdb-scan-index', () => {
        const source = (manifest?.sources || []).find((s) => s.role === 'nvdb');
        if (!source) return { skipped: 'no nvdb source in manifest' };
        const file = guard.assertWork(path.join(source.workPath, 'scan-index.json'), 'nvdb scan-index.json');
        if (!fs.existsSync(file)) fail(`scan-index.json missing: ${file}`);
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { bytes: fs.statSync(file).size, topLevelKeys: Object.keys(parsed).slice(0, 12) };
    });

    // ── chat data (copied LLM-Gateway-Chat user databases) ───────────────────
    check('chat-data', () => {
        const source = (manifest?.sources || []).find((s) => s.role === 'chat-data');
        if (!source) return { skipped: 'chat data not included in this snapshot' };
        const root = guard.assertWork(source.workPath, 'chat data root');
        const opened = [];
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const dbFile = path.join(root, entry.name, 'data.jsonl');
            if (!fs.existsSync(dbFile)) continue;
            guard.assertWork(dbFile, `chat database ${entry.name}`);
            const { Database } = loadNdb();
            const db = Database.open(dbFile, { persistence: 'lazy' });
            let len;
            try {
                len = db.len();
            } finally {
                db.close();
            }
            opened.push({ user: entry.name, len });
        }
        if (opened.length === 0) fail(`no */data.jsonl databases found under ${root}`);
        return { databases: opened.length, opened };
    });

    // ── per-user chat nVDB (present for herrbasan/chat_user, optional per user) ──
    check('chat-nvdb', () => {
        const source = (manifest?.sources || []).find((s) => s.role === 'chat-data');
        if (!source) return { skipped: 'chat data not included in this snapshot' };
        const root = guard.assertWork(source.workPath, 'chat data root');
        const users = [];
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const nvdbDir = path.join(root, entry.name, 'nvdb');
            if (!fs.existsSync(nvdbDir)) {
                users.push({ user: entry.name, nvdb: false });
                continue;
            }
            guard.assertWork(nvdbDir, `chat nVDB ${entry.name}`);

            const { Database } = loadNvdb();
            const db = new Database(nvdbDir);
            const collectionStats = {};
            let collections;
            try {
                collections = db.listCollections();
                for (const name of collections) {
                    const coll = db.getCollection(name);
                    try {
                        const stats = typeof coll.stats === 'function' ? coll.stats() : coll.stats;
                        collectionStats[name] = stats;
                    } finally {
                        if (typeof coll.close === 'function') coll.close();
                    }
                }
            } finally {
                if (typeof db.close === 'function') db.close();
            }
            users.push({ user: entry.name, nvdb: true, collections, collectionStats });
        }
        if (users.length === 0) fail(`no chat user directories under ${root}`);
        return { users };
    });

    // ── dream artifacts ──────────────────────────────────────────────────────
    check('chat-sessions', () => {
        const source = (manifest?.sources || []).find((s) => s.role === 'chat-sessions');
        if (!source) return { skipped: 'no chat-sessions source in manifest' };
        const dir = guard.assertWork(source.workPath, 'chat sessions');
        const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
        if (files.length === 0) fail(`no session json files in ${dir}`);
        for (const name of files) {
            guard.assertWork(path.join(dir, name), `chat session ${name}`);
            JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        }
        return { files: files.length };
    });

    check('dream-json', () => {
        const sources = (manifest?.sources || []).filter((s) => s.role === 'dream-json');
        if (sources.length === 0) fail('no dream-json sources in manifest');
        const parsed = [];
        for (const source of sources) {
            const file = guard.assertWork(source.workPath, `dream file ${source.name}`);
            const rel = path.relative(workRoot, file);
            if (!fs.existsSync(file)) fail(`dream file missing: ${rel}`);
            const bytes = fs.statSync(file).size;
            // dream_raw_output*.json are raw model debug dumps: malformed output is a
            // recorded warning, never a snapshot failure. Canonical maps stay strict.
            const isRaw = source.name.startsWith('dream-raw:');
            try {
                const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
                parsed.push({
                    name: source.name,
                    role: isRaw ? 'raw' : 'canonical',
                    bytes,
                    topLevelKeys: Object.keys(doc).slice(0, 8)
                });
            } catch (e) {
                if (!isRaw) fail(`dream JSON parse failed for ${rel}: ${e.message}`);
                report.warnings.push(`raw dream artifact is not valid JSON (expected for debug dumps): ${rel} - ${e.message}`);
                parsed.push({ name: source.name, role: 'raw', bytes, parseError: e.message });
            }
        }
        return { files: parsed.length, parsed };
    });

    check('dream-history', () => {
        const source = (manifest?.sources || []).find((s) => s.role === 'dream-history');
        if (!source) return { skipped: 'no dream-history source in manifest' };
        const dir = guard.assertWork(source.workPath, 'dream maps history');
        return { files: fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length };
    });

    report.ok = report.failures.length === 0;
    finish(report, report.ok ? 0 : 1);
}

// Flush explicitly: process.exit() inside a pipe can truncate a pending write.
function finish(report, code) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => process.exit(code));
}

main().catch((e) => {
    finish({
        tool: 'validate-memory-lab',
        version: 1,
        ok: false,
        snapshotRoot: process.argv.slice(2).join(' '),
        failures: [{ check: 'fatal', error: e.message }],
        checks: []
    }, 1);
});
