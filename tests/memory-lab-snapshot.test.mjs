// Focused test for the memory-refactor lab snapshot tooling.
//   node tests/memory-lab-snapshot.test.mjs
//
// Builds tiny fixtures in a throwaway directory inside the repo, runs
// scripts/snapshot-memory-lab.ps1 in crash-consistent (non-VSS) mode with
// parameterized source roots, asserts the reference/work copies, the manifest
// and the destination guards, then runs scripts/validate-memory-lab.mjs against
// the produced snapshot. VSS itself is not exercised (it needs elevation); the
// script is parse-checked instead.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'snapshot-memory-lab.ps1');
const VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-memory-lab.mjs');

const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (e) {
        failed++;
        console.error(`FAIL  ${name}\n      ${e.message}`);
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createMemoryDb(file, docs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { Database } = loadNdb();
    const db = Database.open(file, { persistence: 'immediate' });
    try {
        for (const doc of docs) db.insert(doc);
    } finally {
        db.close();
    }
}

function createNvdb(dir, collections) {
    fs.mkdirSync(dir, { recursive: true });
    const { Database } = loadNvdb();
    const db = new Database(dir);
    try {
        for (const name of collections) db.createCollection(name, 8);
    } finally {
        db.close();
    }
}

function runPowerShell(args, timeout = 180000) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
        encoding: 'utf8',
        timeout
    });
}

const root = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp-memory-lab-'));
const project = path.join(root, 'project');
const storageRoot = path.join(root, 'storage');
const chatDataRoot = path.join(root, 'chatdata');
const destinationRoot = path.join(root, 'dest');

try {
    // ── fixtures ─────────────────────────────────────────────────────────────
    fs.mkdirSync(project, { recursive: true });

    const memoryDb = path.join(project, 'data', 'memories', 'data.jsonl');
    createMemoryDb(memoryDb, [
        { description: 'alpha memory', category: 'test' },
        { description: 'beta memory', category: 'test' },
        { description: 'gamma memory', category: 'test' }
    ]);
    // Trash inside the memory folder must be excluded from the snapshot.
    createMemoryDb(path.join(project, 'data', 'memories', '_trash', 'data.jsonl'), [{ description: 'trashed' }]);

    const nvdbDir = path.join(project, 'data', 'nvdb');
    createNvdb(nvdbDir, ['memory', 'storage']);
    writeJson(path.join(nvdbDir, 'scan-index.json'), { version: 1, files: {} });
    writeJson(path.join(nvdbDir, 'meta.json'), { version: 1, collections: ['memory', 'storage'] });

    writeJson(path.join(project, 'data', 'dream_map.json'), { version: 1, clusters: [] });
    writeJson(path.join(project, 'data', 'dream_distillate.json'), { version: 1, nodes: [] });
    // Raw model debug dump: deliberately malformed, as the live artifact is.
    fs.writeFileSync(path.join(project, 'data', 'dream_raw_output.json'), '{"raw": tru\n', 'utf8');
    writeJson(path.join(project, 'data', 'dream_maps', 'dream_map_2026-01-01T00-00-00Z.json'), { clusters: [] });

    writeJson(path.join(project, 'data', 'chat', 'sessions', 'session-a.json'), {
        name: 'session-a',
        model: 'deepseek-flash-chat',
        messages: []
    });

    writeJson(path.join(project, 'config.json'), {
        agents: {
            memory: { dbPath: 'data/memories/data.jsonl' },
            vdb: { dbPath: 'data/nvdb' },
            chat: { dir: 'data/chat/sessions' },
            storage: { root: storageRoot }
        }
    });

    fs.mkdirSync(path.join(storageRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(storageRoot, 'docs', 'a.md'), '# storage fixture\n', 'utf8');
    fs.writeFileSync(path.join(storageRoot, 'b.txt'), 'flat fixture\n', 'utf8');
    fs.utimesSync(path.join(storageRoot, 'docs', 'a.md'), FIXED_TIME, FIXED_TIME);

    createMemoryDb(path.join(chatDataRoot, 'user1', 'data.jsonl'), [{ role: 'user', content: 'hello' }]);
    createNvdb(path.join(chatDataRoot, 'user1', 'nvdb'), ['memory']);
    fs.writeFileSync(path.join(chatDataRoot, 'user1', 'notes.log'), 'log line\n', 'utf8');
    fs.writeFileSync(path.join(chatDataRoot, 'user1_backup.zip'), 'PK-not-really-a-zip', 'utf8');
    // A second user without an nvdb/ folder: absence must be reported, not failed.
    fs.mkdirSync(path.join(chatDataRoot, 'user2'), { recursive: true });
    fs.writeFileSync(path.join(chatDataRoot, 'user2', 'profile.json'), '{}\n', 'utf8');

    // ── tests ────────────────────────────────────────────────────────────────

    await test('PowerShell script parses', () => {
        const cmd = [
            '$errors=$null;$tokens=$null;',
            `[void][System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}',[ref]$tokens,[ref]$errors);`,
            'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }'
        ].join(' ');
        const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
            encoding: 'utf8',
            timeout: 60000
        });
        assert.equal(res.status, 0, `parse failed: ${res.stdout}${res.stderr}`);
    });

    let snapshotRoot = null;

    await test('direct-mode snapshot copies live -> reference -> work', () => {
        const res = runPowerShell([
            '-File', SCRIPT,
            '-ProjectRoot', project,
            '-ChatDataRoot', chatDataRoot,
            '-DestinationRoot', destinationRoot,
            '-Name', 'run1',
            '-AllowCrashConsistentCopy'
        ]);
        assert.equal(res.status, 0, `script failed: ${res.stdout}\n${res.stderr}`);

        snapshotRoot = path.join(destinationRoot, 'run1');
        const referenceRoot = path.join(snapshotRoot, 'reference');
        const workRoot = path.join(snapshotRoot, 'work');
        assert.ok(fs.existsSync(referenceRoot), 'reference directory missing');
        assert.ok(fs.existsSync(workRoot), 'work directory missing');
        assert.ok(fs.existsSync(path.join(snapshotRoot, 'manifest.json')), 'manifest missing');
        assert.ok(fs.existsSync(path.join(snapshotRoot, 'MANIFEST.sha256')), 'manifest sidecar missing');

        for (const base of [referenceRoot, workRoot]) {
            assert.ok(fs.existsSync(path.join(base, 'storage', 'docs', 'a.md')), `${base}: storage file missing`);
            assert.ok(fs.existsSync(path.join(base, 'mcp-server', 'data', 'memories', 'data.jsonl')), `${base}: memory db missing`);
            assert.ok(fs.existsSync(path.join(base, 'mcp-server', 'data', 'nvdb', 'scan-index.json')), `${base}: scan index missing`);
            assert.ok(fs.existsSync(path.join(base, 'mcp-server', 'data', 'dream_map.json')), `${base}: dream map missing`);
            assert.ok(fs.existsSync(path.join(base, 'mcp-server', 'data', 'chat', 'sessions', 'session-a.json')), `${base}: session missing`);
            assert.ok(fs.existsSync(path.join(base, 'chat-data', 'user1', 'data.jsonl')), `${base}: chat db missing`);
            assert.ok(!fs.existsSync(path.join(base, 'chat-data', 'user1_backup.zip')), `${base}: zip backup was copied`);
            // WAL and log files are required for database consistency and must survive.
            assert.ok(fs.existsSync(path.join(base, 'chat-data', 'user1', 'notes.log')), `${base}: log file was dropped`);
            assert.ok(!fs.existsSync(path.join(base, 'mcp-server', 'data', 'memories', '_trash')), `${base}: _trash was copied`);
        }

        const refContent = fs.readFileSync(path.join(referenceRoot, 'storage', 'docs', 'a.md'), 'utf8');
        const workContent = fs.readFileSync(path.join(workRoot, 'storage', 'docs', 'a.md'), 'utf8');
        assert.equal(workContent, refContent, 'work copy differs from reference copy');
        assert.equal(workContent, '# storage fixture\n', 'work copy content differs from source');

        const srcStat = fs.statSync(path.join(storageRoot, 'docs', 'a.md'));
        const workStat = fs.statSync(path.join(workRoot, 'storage', 'docs', 'a.md'));
        assert.equal(workStat.mtime.getTime(), srcStat.mtime.getTime(), 'timestamp was not preserved');
    });

    await test('manifest records mode, counts and critical hashes', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, 'manifest.json'), 'utf8'));
        assert.equal(manifest.mode, 'crash-consistent-copy');
        assert.equal(manifest.pointInTime, false);
        assert.ok(typeof manifest.warning === 'string' && manifest.warning.length > 20, 'warning missing');
        assert.equal(manifest.copyStatus, 'ok');

        assert.equal(path.resolve(manifest.workRoot), path.join(snapshotRoot, 'work'));
        assert.equal(path.resolve(manifest.referenceRoot), path.join(snapshotRoot, 'reference'));

        const roles = manifest.sources.map((s) => s.role);
        for (const role of ['memory-ndb', 'nvdb', 'chat-sessions', 'dream-json', 'dream-history', 'storage', 'chat-data']) {
            assert.ok(roles.includes(role), `manifest is missing source role ${role}`);
        }
        for (const source of manifest.sources) {
            assert.equal(source.copyStatus, 'ok', `${source.name}: copyStatus not ok`);
            assert.ok(source.files > 0, `${source.name}: no files recorded`);
            assert.ok(source.bytes > 0, `${source.name}: no bytes recorded`);
        }

        assert.ok(manifest.criticalHashes.length >= 3, 'expected critical hashes for db/map files');
        const paths = manifest.criticalHashes.map((h) => h.path);
        assert.ok(paths.includes('mcp-server/data/memories/data.jsonl'), 'memory db hash missing');
        assert.ok(paths.includes('mcp-server/data/nvdb/scan-index.json'), 'scan-index hash missing');
        assert.ok(paths.includes('mcp-server/data/dream_map.json'), 'dream map hash missing');
        for (const entry of manifest.criticalHashes) {
            assert.match(entry.sha256, /^[0-9a-f]{64}$/, `bad sha256 for ${entry.path}`);
            assert.equal(entry.verifiedIdentical, true);
        }

        assert.deepEqual(manifest.exclusions.chatData, ['*.zip'], 'chat data must only exclude zip backups');
    });

    await test('VSS wiring is locale-independent and sets pointInTime', () => {
        const source = fs.readFileSync(SCRIPT, 'utf8');
        assert.doesNotMatch(source, /vssadmin\.exe|create shadow/i, 'VSS must not shell out to a locale-dependent CLI');
        assert.match(source, /Win32_ShadowCopy/, 'VSS must be created through Win32_ShadowCopy');
        assert.match(source, /ClientAccessible/, 'shadows must be created with ClientAccessible context');
        assert.match(source, /pointInTime\s*=\s*\(\s*\$mode\s+-eq\s+'vss'\s*\)/, 'pointInTime must follow the mode');
        assert.match(source, /Get-WmiObject[^\n]*Win32_ShadowCopy/, 'shadow instances must be enumerated through WMI');
    });

    await test('negative FreeSpaceMarginGb is refused', () => {
        const res = runPowerShell([
            '-File', SCRIPT,
            '-ProjectRoot', project,
            '-ChatDataRoot', chatDataRoot,
            '-DestinationRoot', destinationRoot,
            '-Name', 'margin-bad',
            '-FreeSpaceMarginGb:-1',
            '-AllowCrashConsistentCopy'
        ]);
        assert.notEqual(res.status, 0, 'script accepted a negative free-space margin');
        assert.match(`${res.stdout}${res.stderr}`, /FreeSpaceMarginGb/i);
        assert.ok(!fs.existsSync(path.join(destinationRoot, 'margin-bad')), 'refused run created a snapshot');
    });

    await test('validator opens only the lab work copy and succeeds', () => {
        const refDb = path.join(snapshotRoot, 'reference', 'mcp-server', 'data', 'memories', 'data.jsonl');
        const refHashBefore = fs.readFileSync(refDb);

        const res = spawnSync(process.execPath, [VALIDATOR, '--snapshot', snapshotRoot], {
            encoding: 'utf8',
            timeout: 120000
        });
        assert.equal(res.status, 0, `validator failed: ${res.stdout}\n${res.stderr}`);
        const report = JSON.parse(res.stdout);
        assert.equal(report.ok, true, `validator reported failures: ${JSON.stringify(report.failures)}`);
        assert.equal(report.mode, 'crash-consistent-copy');

        const checks = Object.fromEntries(report.checks.map((c) => [c.name, c]));
        assert.ok(checks['memory-ndb']?.ok, 'memory nDB check failed');
        assert.equal(checks['memory-ndb'].detail.len, 3, 'memory nDB should hold 3 fixture docs');
        assert.ok(checks['nvdb']?.ok, 'nVDB check failed');
        assert.deepEqual(checks['nvdb'].detail.collections.sort(), ['memory', 'storage']);
        assert.ok(checks['chat-data']?.ok, 'chat data check failed');
        assert.equal(checks['chat-data'].detail.databases, 1, 'expected one chat database');
        assert.equal(checks['chat-data'].detail.opened[0].len, 1, 'chat database should hold 1 doc');
        assert.ok(checks['chat-nvdb']?.ok, 'chat nVDB check failed');
        const chatUsers = Object.fromEntries(checks['chat-nvdb'].detail.users.map((u) => [u.user, u]));
        assert.equal(chatUsers.user1.nvdb, true, 'user1 nvdb was not opened');
        assert.deepEqual(chatUsers.user1.collections, ['memory'], 'user1 nvdb collections mismatch');
        assert.ok(chatUsers.user1.collectionStats.memory, 'user1 memory collection has no stats');
        assert.equal(chatUsers.user2.nvdb, false, 'user2 nvdb absence should be reported, not failed');
        assert.ok(checks['dream-json']?.ok, 'dream json check failed');
        const rawEntry = checks['dream-json'].detail.parsed.find((p) => p.name === 'dream-raw:dream_raw_output.json');
        assert.ok(rawEntry?.parseError, 'malformed raw dream artifact should carry a parse error');
        const rawWarning = report.warnings.find((w) => /dream_raw_output\.json/.test(w) && /parse|not valid JSON/i.test(w));
        assert.ok(rawWarning, `validator did not warn about the malformed raw dream artifact: ${JSON.stringify(report.warnings)}`);
        for (const canonical of ['dream-map', 'dream-distillate']) {
            const entry = checks['dream-json'].detail.parsed.find((p) => p.name === canonical);
            assert.equal(entry?.role, 'canonical', `${canonical} should parse strictly`);
            assert.ok(Array.isArray(entry.topLevelKeys), `${canonical} was not parsed`);
        }
        assert.ok(checks['reference-work-hashes']?.ok, 'reference/work hash check failed');

        assert.ok(report.liveRoots.length > 0, 'validator did not resolve live roots');
        for (const opened of [checks['memory-ndb'].detail.file, path.join(snapshotRoot, 'work')]) {
            assert.ok(opened.startsWith(path.join(snapshotRoot, 'work')), `validator opened a non-work path: ${opened}`);
        }

        assert.ok(fs.readFileSync(refDb).equals(refHashBefore), 'reference copy was modified by the validator');
    });

    await test('destination inside a source root is refused', () => {
        const badDestination = path.join(project, 'data', 'lab-snapshot');
        const res = runPowerShell([
            '-File', SCRIPT,
            '-ProjectRoot', project,
            '-ChatDataRoot', chatDataRoot,
            '-DestinationRoot', badDestination,
            '-Name', 'bad1',
            '-AllowCrashConsistentCopy'
        ]);
        assert.notEqual(res.status, 0, 'script accepted a destination inside a source root');
        assert.match(`${res.stdout}${res.stderr}`, /Destination guard/i);
        assert.ok(!fs.existsSync(badDestination), 'refused destination was created anyway');
    });

    await test('destination inside the storage root is refused', () => {
        const badDestination = path.join(storageRoot, 'lab-snapshot');
        const res = runPowerShell([
            '-File', SCRIPT,
            '-ProjectRoot', project,
            '-ChatDataRoot', chatDataRoot,
            '-DestinationRoot', badDestination,
            '-Name', 'bad2',
            '-AllowCrashConsistentCopy'
        ]);
        assert.notEqual(res.status, 0, 'script accepted a destination inside the storage root');
        assert.match(`${res.stdout}${res.stderr}`, /Destination guard/i);
        assert.ok(!fs.existsSync(badDestination), 'refused destination was created anyway');
    });
} finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
