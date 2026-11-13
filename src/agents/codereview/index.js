// codereview agent — Prime-Directive code review (spec: docs/codereview-spec.md).
// Tools: review (run pipeline), findings (list persisted), accept (diff + test
// generation, then the fail-before/pass-after acceptance gate).

import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { fileURLToPath } from 'url';
import { createProgressReporter } from '../../utils/progress-reporter.js';
import { getLogger } from '../../utils/logger.js';
import { runReview } from './pipeline.js';
import * as store from './store.js';
import { runAcceptanceGate, validateArtifacts, logGateVerdict } from './sandbox.js';

const logger = getLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let DATA_DIR = null;
let STORAGE_ROOT = null;
let DEFAULT_MODELS = null;

const ACCEPT_BRIEF = `
You generate the acceptance artifacts for ONE code-review finding: a unified diff and a Node.js test that proves the bug.
Rules:
- The diff targets exactly the finding's file and is anchored to the snapshot content given to you. Unified diff format with @@ hunks.
- The test is a plain Node script (node:assert + node:node:test are available; NO test framework deps, NO mocks of the system under test — fault injection at real boundaries only). It must FAIL when the bug is present and PASS after the diff.
- Real data shapes, never placeholder data. If the bug needs live runtime conditions a static run cannot reproduce, set runtime_provable: false.
- Do NOT add defensive handling to the diff. Fix the failure mode itself (eliminate it, shrink it, or per the finding's documented ladder).
Reply with ONLY this JSON:
{ "diff": "--- a/<file>\\n+++ b/<file>\\n@@ ...", "test_rel": "test/<name>.test.mjs", "test_code": "...", "runtime_provable": true|false, "needs_install": true|false, "notes": "..." }
`;

export async function init(context) {
    STORAGE_ROOT = context.config.agents?.storage?.root;
    if (!STORAGE_ROOT) throw new Error('[codereview] config agents.storage.root is required — missing from config.json');
    const conf = context.config.agents?.codereview;
    if (!conf?.models?.grunt || !conf?.models?.orchestrator) {
        throw new Error('[codereview] config agents.codereview.models.{grunt,orchestrator} is required — missing from config.json');
    }
    DEFAULT_MODELS = conf.models;
    DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'codereview');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    initStoreChecked(context);
    logger.info(`[codereview] initialized — data ${DATA_DIR}, models ${DEFAULT_MODELS.grunt} + ${DEFAULT_MODELS.orchestrator}`, null, 'CodeReview');
}

function initStoreChecked(context) {
    // The store opens its own nDB; a missing native binary is a loud startup
    // failure (the loader throws), never a silent no-findings mode.
    store.initStore(DATA_DIR);
    context.codereviewStore = store;
}

function resolveModels(override) {
    const models = {
        grunt: override?.grunt ?? DEFAULT_MODELS.grunt,
        orchestrator: override?.orchestrator ?? DEFAULT_MODELS.orchestrator
    };
    if (typeof models.grunt !== 'string' || typeof models.orchestrator !== 'string') {
        throw new Error('codereview: models.grunt and models.orchestrator must be strings');
    }
    return models;
}

export async function codereview_review(args, context) {
    const { source, models: modelOverride, budget, scope } = args;
    if (!source) throw new Error('codereview.review: source is required');
    const models = resolveModels(modelOverride);

    const pr = createProgressReporter(context.progress);
    pr.set('Starting review...', 2, true);

    const { reviewId, report } = await runReview({
        source,
        models,
        budget,
        scope,
        gateway: context.gateway,
        storageRoot: STORAGE_ROOT,
        dataDir: DATA_DIR,
        emitProgress: (message, pct) => pr.set(message, pct, true)
    });

    pr.done('Review complete');
    return { content: [{ type: 'text', text: report }], reviewId };
}

export async function codereview_findings(args) {
    const { reviewId, status, snapshotHash } = args;
    const findings = await store.listFindings({ reviewId, status, snapshotHash });
    if (findings.length === 0) {
        return { content: [{ type: 'text', text: 'No findings match the filter.' }] };
    }
    const lines = findings.map((f) =>
        `${f._id} · ${f.status} · ${f.class} · ${f.file}:${f.lines?.[0] ?? '?'} · ${f.failure_mode?.slice(0, 120)}`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
}

export async function codereview_accept(args, context) {
    const { findingId } = args;
    if (!findingId) throw new Error('codereview.accept: findingId is required');

    const finding = await store.getFinding(findingId);
    if (!finding || finding.type !== 'finding') throw new Error(`codereview.accept: no finding with id ${findingId}`);
    if (finding.status === 'accepted') throw new Error(`codereview.accept: finding ${findingId} is already accepted`);
    if (finding.status === 'rejected') throw new Error(`codereview.accept: finding ${findingId} was rejected by the validator — it cannot be accepted`);

    const pr = createProgressReporter(context.progress);
    pr.set('Generating diff + test (orchestrator model)...', 10, true);

    const snapshotDir = path.join(DATA_DIR, 'snapshots', finding.snapshotHash.slice(0, 16));
    if (!fs.existsSync(snapshotDir)) {
        throw new Error(`codereview.accept: snapshot ${finding.snapshotHash.slice(0, 16)} no longer exists on disk (GC?) — the diff cannot be anchored. Re-run the review.`);
    }
    // Boundary validation: the finding comes from the store — data written by a
    // possibly older validator version. Confinement is asserted here, not assumed.
    const snapshotRoot = path.resolve(snapshotDir);
    const fileAbs = path.resolve(snapshotRoot, ...finding.file.split('/'));
    if (!fileAbs.startsWith(snapshotRoot + path.sep)) {
        throw new Error(`codereview.accept: finding.file escapes the snapshot root: ${finding.file}`);
    }
    if (!/\.(?:js|mjs|cjs)$/i.test(finding.file)) {
        throw new Error(`codereview.accept: the automated acceptance gate currently supports JavaScript only; ${finding.file} requires the project's native test runner. The review finding is valid, but no language-mismatched Node test will be generated.`);
    }
    const source = fs.readFileSync(fileAbs, 'utf8');

    const gateway = context.gateway;
    const response = await gateway.chat({
        model: DEFAULT_MODELS.orchestrator,
        stream: false,
        maxTokens: 8000,
        systemPrompt: ACCEPT_BRIEF,
        messages: [{
            role: 'user',
            content: `FINDING (${finding.class})\nfile: ${finding.file}\nlines: ${finding.lines.join('-')}\nfailure mode: ${finding.failure_mode}\nsuggestion: ${finding.suggestion}\nladder: ${finding.rung ? JSON.stringify(finding.rung) : 'none'}\ntest spec: ${JSON.stringify(finding.test_spec)}\n\nCURRENT FILE CONTENT:\n${source}`
        }]
    });
    let artifacts;
    try {
        const text = String(response.content ?? '');
        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        artifacts = JSON.parse(text.slice(first, last + 1));
    } catch (err) {
        throw new Error(`codereview.accept: orchestrator did not return valid JSON: ${err.message}`);
    }

    const validation = validateArtifacts({ finding, diffText: artifacts.diff, testCode: artifacts.test_code, testRel: artifacts.test_rel });
    if (!validation.ok) {
        await store.updateFinding(findingId, { status: 'new', acceptBlocked: validation.reason });
        throw new Error(`codereview.accept: ${validation.reason}`);
    }

    if (artifacts.runtime_provable === false) {
        logGateVerdict(finding.reviewId, findingId, 'unprovable');
        await store.updateFinding(findingId, {
            status: 'unprovable',
            diff: artifacts.diff,
            test_rel: artifacts.test_rel,
            test_code: artifacts.test_code,
            unprovableReason: 'test spec requires live runtime conditions a static sandbox cannot reproduce'
        });
        return {
            content: [{
                type: 'text',
                text: `Marked UNPROVABLE — the bug needs runtime conditions the sandbox cannot reproduce. Diff and test are stored for manual application.\n\n${artifacts.diff}`
            }]
        };
    }

    pr.set('Running acceptance gate (fail before, pass after)...', 50, true);
    const sandboxRoot = path.join(DATA_DIR, 'sandbox', `${finding.reviewId}-${findingId}`);
    const gate = await runAcceptanceGate({
        sandboxRoot,
        snapshotDir,
        targetRel: finding.file,
        diffText: artifacts.diff,
        testRel: artifacts.test_rel,
        testCode: artifacts.test_code,
        needsInstall: artifacts.needs_install === true
    });
    logGateVerdict(finding.reviewId, findingId, gate.verdict);

    if (gate.verdict === 'verified') {
        await store.updateFinding(findingId, {
            status: 'accepted',
            diff: artifacts.diff,
            test_rel: artifacts.test_rel,
            test_code: artifacts.test_code,
            gateOutput: { beforeTail: gate.output.before.stderr.slice(-500), afterTail: gate.output.after.stdout.slice(-500) }
        });
        pr.done('Verified — fail before, pass after');
        return {
            content: [{
                type: 'text',
                text: `VERIFIED — the test fails on the unpatched snapshot and passes with the diff.\n\nDiff (anchored to snapshot ${finding.snapshotHash.slice(0, 16)}):\n${artifacts.diff}\n\nTest (${artifacts.test_rel}):\n${artifacts.test_code}`
            }]
        };
    }

    await store.updateFinding(findingId, {
        status: 'new',
        acceptBlocked: `gate verdict: ${gate.verdict}`,
        lastGateOutput: JSON.stringify(gate.output).slice(0, 4000)
    });
    const detail = gate.verdict === 'failed-before'
        ? 'The test PASSED on the unpatched snapshot — the bug is not proven real. Nothing ships.'
        : gate.verdict === 'failed-after'
            ? 'The test still FAILS after applying the diff — the diff does not fix the finding. Nothing ships.'
            : `The test could not run (${gate.verdict}). See output.`;
    const output = formatGateOutput(gate.output);
    throw new Error(`codereview.accept: ${detail}\n\n${output}`);
}

function formatGateOutput(output) {
    const parts = [];
    for (const [key, runResult] of Object.entries(output)) {
        if (!runResult?.stdout && !runResult?.stderr) continue;
        parts.push(`--- ${key} (exit ${runResult.code ?? '?'}) ---\n${String(runResult.stderr || runResult.stdout).slice(-1500)}`);
    }
    return parts.join('\n') || '(no output captured)';
}

export async function shutdown() {
    logger.info('[codereview] shut down', null, 'CodeReview');
}
