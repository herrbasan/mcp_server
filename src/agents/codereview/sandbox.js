// Acceptance gate (spec §6.1) — the real anti-speculation gate.
// Everything upstream filters claims; this one RUNS them: the generated test
// must FAIL on the unpatched snapshot and PASS on the patched one. A test that
// passes before (bug not real) or fails after (diff doesn't fix it) blocks
// acceptance, loudly, with the run output.

import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { scanAddedLinesForGuards, validateTestSpec } from './validator.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: opts.timeoutMs ?? 60_000, cwd: opts.cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
            // A process that RAN and exited non-zero has a numeric err.code —
            // that is a failing test, a real verdict. Spawn failures (ENOENT),
            // timeouts (killed) and buffer terminations have no numeric exit
            // code — those are execution errors, not test verdicts, and must
            // never masquerade as failed-before/failed-after.
            if (err && typeof err.code !== 'number') {
                resolve({ code: null, executionError: `${err.code ?? 'unknown'}${err.killed ? ' (killed/timeout)' : ''}: ${err.message}`, stdout: String(stdout), stderr: String(stderr) });
                return;
            }
            resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

/**
 * Apply a single-file unified diff to a tree. Parses @@ hunks; the diff target
 * is the finding's file (snapshot-relative). Throws loudly on a hunk that does
 * not match — a diff that cannot apply is a generation failure, not something
 * to partially tolerate.
 */
export function applyUnifiedDiff(treeRoot, targetRel, diffText) {
    const abs = path.join(treeRoot, ...targetRel.split('/'));
    const original = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    const originalLines = original.split('\n');

    const hunks = [];
    let current = null;
    // The diff text gets the same CRLF normalization as the target file — a
    // Windows-generated diff with \r\n otherwise fails every context check.
    for (const raw of String(diffText ?? '').replace(/\r\n/g, '\n').split('\n')) {
        const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
        if (hunkMatch) {
            current = { oldStart: parseInt(hunkMatch[1], 10), lines: [] };
            hunks.push(current);
            continue;
        }
        if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
        if (current && (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' '))) {
            current.lines.push(raw);
        }
    }
    if (hunks.length === 0) throw new Error('acceptance gate: no @@ hunks found in generated diff');

    // Apply bottom-up so earlier line numbers stay valid.
    hunks.sort((a, b) => b.oldStart - a.oldStart);
    for (const hunk of hunks) {
        const index = hunk.oldStart - 1;
        if (index < 0 || index > originalLines.length) {
            throw new Error(`acceptance gate: hunk @@ -${hunk.oldStart} outside file (${originalLines.length} lines)`);
        }
        const contextBefore = hunk.lines.filter((l) => l.startsWith(' ') || l.startsWith('-'));
        // Verify context match — a diff against a moving target fails here, loudly.
        for (let i = 0; i < contextBefore.length; i++) {
            const expected = contextBefore[i].slice(1);
            if (originalLines[index + i] !== expected) {
                throw new Error(`acceptance gate: hunk context mismatch at line ${index + i + 1}: expected '${expected}' found '${originalLines[index + i]}' — diff is not anchored to this snapshot`);
            }
        }
        const replacement = hunk.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1));
        originalLines.splice(index, contextBefore.length, ...replacement);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, originalLines.join('\n'));
}

/**
 * The gate. Copies the snapshot twice (before/after), patches `after`, writes
 * the test into both, optionally installs dependencies, runs the test in each.
 * Verdicts: verified | failed-before (bug not proven) | failed-after (diff
 * doesn't fix) | error-before | error-after (test didn't run).
 */
export async function runAcceptanceGate({ sandboxRoot, snapshotDir, targetRel, diffText, testRel, testCode, needsInstall }) {
    const before = path.join(sandboxRoot, 'before');
    const after = path.join(sandboxRoot, 'after');
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    await fsp.mkdir(before, { recursive: true });
    await fsp.mkdir(after, { recursive: true });

    // Copy snapshot into both halves.
    await copyDir(snapshotDir, before);
    await copyDir(snapshotDir, after);

    applyUnifiedDiff(after, targetRel, diffText);

    for (const dir of [before, after]) {
        const testAbs = path.join(dir, ...testRel.split('/'));
        fs.mkdirSync(path.dirname(testAbs), { recursive: true });
        fs.writeFileSync(testAbs, testCode);
    }

    if (needsInstall) {
        for (const dir of [before, after]) {
            const pkg = path.join(dir, 'package.json');
            if (!fs.existsSync(pkg)) continue;
            const pkgJson = JSON.parse(fs.readFileSync(pkg, 'utf8'));
            if (!pkgJson.dependencies || Object.keys(pkgJson.dependencies).length === 0) continue;
            const tree = dir === before ? 'before' : 'after';
            const install = await run('npm', ['install', '--omit', 'dev', '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: dir, timeoutMs: 180_000 });
            if (install.executionError) {
                return { verdict: `error-${tree}`, output: { stage: 'install', tree, stderr: install.executionError } };
            }
            if (install.code !== 0) {
                // The verdict names the tree whose install actually failed —
                // diagnosing the wrong half sends the user at a healthy tree.
                return { verdict: `error-${tree}`, output: { stage: 'install', tree, stderr: install.stderr.slice(0, 4000) } };
            }
        }
    }

    const beforeRun = await run('node', [testRel], { cwd: before, timeoutMs: 60_000 });
    if (beforeRun.executionError) {
        return { verdict: 'error-before', output: { before: beforeRun } };
    }
    if (beforeRun.code === 0) {
        return { verdict: 'failed-before', output: { before: beforeRun } };
    }
    const afterRun = await run('node', [testRel], { cwd: after, timeoutMs: 60_000 });
    if (afterRun.executionError) {
        return { verdict: 'error-after', output: { before: beforeRun, after: afterRun } };
    }
    if (afterRun.code !== 0) {
        return { verdict: 'failed-after', output: { before: beforeRun, after: afterRun } };
    }
    return { verdict: 'verified', output: { before: beforeRun, after: afterRun } };
}

async function copyDir(src, dst) {
    await fsp.mkdir(dst, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === '_snapshot.json') continue;
        if (entry.isDirectory()) await copyDir(path.join(src, entry.name), path.join(dst, entry.name));
        else if (entry.isFile()) await fsp.copyFile(path.join(src, entry.name), path.join(dst, entry.name));
    }
}

/**
 * Post-generation validation of the accept artifacts BEFORE the sandbox runs:
 * the test spec must still validate, and a diff that adds a degrading guard
 * without a rung on the finding blocks acceptance here.
 */
export function validateArtifacts({ finding, diffText, testCode, testRel }) {
    if (!diffText || typeof diffText !== 'string' || !diffText.includes('@@')) {
        return { ok: false, reason: 'generated diff is missing or has no hunks' };
    }
    if (!testCode || typeof testCode !== 'string' || testCode.length < 20) {
        return { ok: false, reason: 'generated test code is missing or trivially short' };
    }
    if (!testRel || typeof testRel !== 'string' || testRel.includes('..')) {
        return { ok: false, reason: 'test path must be snapshot-relative without ..' };
    }
    const specCheck = validateTestSpec(finding.test_spec);
    if (!specCheck.ok) return { ok: false, reason: `test_spec: ${specCheck.reason}` };
    const { degrading } = scanAddedLinesForGuards(diffText);
    if (degrading.length > 0 && !finding.rung) {
        return { ok: false, reason: `generated diff adds a degrading guard (${degrading[0].slice(0, 60)}) but the finding has no ladder documentation — no ladder, no handler` };
    }
    return { ok: true };
}

export function logGateVerdict(reviewId, findingId, verdict) {
    logger.info(`[codereview] acceptance gate ${reviewId}/${findingId}: ${verdict}`, null, 'CodeReview');
}
