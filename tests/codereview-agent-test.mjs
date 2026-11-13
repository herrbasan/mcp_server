// codereview agent tests — offline tier (resolver, analyzer, validator,
// blast radius, acceptance gate, store) plus an env-gated gateway smoke run
// (CODEVIEW_SMOKE=1) that measures seeded-corpus recall end to end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(__dirname, '..', 'src', 'agents', 'codereview');
const FIXTURE = path.join(__dirname, 'fixtures', 'codereview-corpus');
const MIXED_FIXTURE = path.join(__dirname, 'fixtures', 'codereview-mixed');

const { materializeSource, hashTree } = await import(`file://${path.join(AGENT, 'resolver.js').replaceAll('\\', '/')}`);
const { analyzeSnapshot, computeBlastRadius, computeBlastRadiusWithDeletions } = await import(`file://${path.join(AGENT, 'analyzer.js').replaceAll('\\', '/')}`);
const validator = await import(`file://${path.join(AGENT, 'validator.js').replaceAll('\\', '/')}`);
const { runAcceptanceGate, applyUnifiedDiff, validateArtifacts } = await import(`file://${path.join(AGENT, 'sandbox.js').replaceAll('\\', '/')}`);

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
    if (cond) { passed++; console.log(`  ok  ${label}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── Resolver ───────────────────────────────────────────────────────────────
console.log('\n[resolver]');
const tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'codereview-test-'));
const snapshotsRoot = path.join(tmpData, 'snapshots');
const snap = await materializeSource(FIXTURE, snapshotsRoot);

ok(snap.files.includes('src/api.js') && snap.files.includes('src/util.js'), 'fixture files copied');
ok(!snap.files.includes('package-lock.json'), 'lock file excluded');
ok(!snap.files.some((f) => f.startsWith('node_modules/')), 'node_modules excluded');
ok(snap.exclusions.some((e) => e.rel === '.env' && e.reason.includes('secret')), '.env excluded as secret');
ok(snap.exclusions.some((e) => e.rel === 'assets/logo.png' && e.reason === 'binary'), 'binary excluded');
ok(snap.treeHash.length === 64, `tree hash computed (${snap.treeHash.slice(0, 12)}...)`);
const snap2 = await materializeSource(FIXTURE, snapshotsRoot);
ok(snap2.treeHash === snap.treeHash, 'same tree → same hash (idempotent)');
// Determinism of the exclusion listing — the review never saw these silently.
ok(snap.exclusions.length >= 4, `all exclusions recorded (${snap.exclusions.length})`);

// ── Analyzer (tier 0) ──────────────────────────────────────────────────────
console.log('\n[analyzer tier-0]');
const analysis = await analyzeSnapshot(snap.snapshotDir);

const apiHunts = analysis.hunts.filter((h) => h.file === 'src/api.js');
ok(apiHunts.some((h) => h.kind === 'swallowed-catch'), 'swallowed catch found in api.js (catch → return null)');
ok(apiHunts.some((h) => h.kind === 'or-default-config'), '|| config default found in api.js');
ok(analysis.hunts.some((h) => h.file === 'src/worker.js' && (h.kind === 'swallowed-catch' || h.kind === 'empty-error-branch')), 'empty error branch found in worker.js');
ok(analysis.hunts.some((h) => h.file === 'src/store.js' && h.kind === 'nullish-default-config'), '?? config default found in store.js');
ok(analysis.hunts.some((h) => h.kind === 'narration-comment' && h.file === 'src/util.js'), 'narration comment candidate found in util.js');
const narration = analysis.hunts.find((h) => h.kind === 'narration-comment');
ok(Number.isInteger(narration.line), `narration hunt line is a number, not a Position object (got ${JSON.stringify(narration?.line)})`);

const apiInfo = analysis.files.find((f) => f.rel === 'src/api.js');
ok(apiInfo.boundaries.includes('network'), 'api.js classified network boundary');
ok(analysis.files.find((f) => f.rel === 'src/store.js').boundaries.includes('fs'), 'store.js classified fs boundary');
ok(analysis.files.find((f) => f.rel === 'src/worker.js').boundaries.includes('process'), 'worker.js classified process boundary');

ok(analysis.graph.edges['src/api.js']?.includes('src/util.js'), 'graph edge api → util');
ok((analysis.graph.reverse['src/util.js'] ?? []).length === 2, 'fan-in of util.js = 2 (api + store)');

const rankApi = analysis.ranked.find((r) => r.rel === 'src/api.js');
const rankUtil = analysis.ranked.find((r) => r.rel === 'src/util.js');
ok(rankApi.score > rankUtil.score, `ranking: api.js (${rankApi.score.toFixed(1)}) above util.js (${rankUtil.score.toFixed(1)})`);

// ── Mixed-language analysis and coverage (issue #76) ───────────────────────
console.log('\n[mixed JS/Rust/generic source]');
const mixedSnap = await materializeSource(MIXED_FIXTURE, snapshotsRoot);
ok(mixedSnap.exclusions.some((e) => e.rel === 'napi/pdfium' && e.reason.includes('directory')), 'vendored PDFium tree excluded and disclosed');
const mixedAnalysis = await analyzeSnapshot(mixedSnap.snapshotDir);
const mixedRanked = new Set(mixedAnalysis.ranked.map((r) => r.rel));
ok(mixedAnalysis.rustFileCount === 2, 'Rust source files counted');
ok(['src/api.js', 'src/lib.rs', 'src/engine.rs', 'src/worker.py'].every((rel) => mixedRanked.has(rel)), 'JS, Rust, and generic source all ranked for review');
ok(!mixedRanked.has('README.md') && !mixedRanked.has('LICENSE'), 'documentation and extensionless metadata are not ranked as source');
ok(mixedAnalysis.files.find((f) => f.rel === 'src/engine.rs').lines > 0, 'Rust implementation has real size/line facts');
ok(mixedAnalysis.graph.edges['src/lib.rs']?.includes('src/engine.rs'), 'Rust mod/use creates lib → engine graph edge');
ok(mixedAnalysis.graph.reverse['src/engine.rs']?.includes('src/lib.rs'), 'Rust importer enters reverse graph for incremental blast radius');
ok(mixedAnalysis.hunts.some((h) => h.file === 'src/engine.rs' && h.kind === 'discarded-result'), 'Rust discarded Result candidate found');
ok(mixedAnalysis.hunts.some((h) => h.file === 'src/engine.rs' && h.kind === 'default-mask'), 'Rust environment default-mask candidate found');
ok(mixedAnalysis.files.find((f) => f.rel === 'src/engine.rs').boundaries.includes('process'), 'Rust process boundary classified');
ok(mixedAnalysis.files.find((f) => f.rel === 'src/worker.py').analysisMode === 'generic', 'Python remains model-review eligible with generic tier-0');
ok(mixedAnalysis.files.find((f) => f.rel === 'src/worker.py').boundaries.includes('network'), 'generic Python network boundary classified');

const { selectDigestTargets, renderReport } = await import(`file://${path.join(AGENT, 'pipeline.js').replaceAll('\\', '/')}`);
const coldDigests = selectDigestTargets(mixedAnalysis, { blastRadius: null });
ok(['src/api.js', 'src/lib.rs', 'src/engine.rs', 'src/worker.py'].every((rel) => coldDigests.includes(rel)), 'cold review digests every source language, not just JS');
const incrementalDigests = selectDigestTargets(mixedAnalysis, { blastRadius: new Set(['src/engine.rs', 'src/worker.py', 'README.md']) });
ok(incrementalDigests.includes('src/engine.rs') && incrementalDigests.includes('src/worker.py') && !incrementalDigests.includes('README.md'), 'incremental digests retain Rust/generic source and exclude non-source');

const mixedCoverage = {
    divedCount: 1,
    carriedCount: 0,
    totalFiles: mixedAnalysis.files.length,
    totalReviewable: mixedAnalysis.ranked.length,
    totalJs: 1,
    totalRust: 2,
    totalGeneric: 1,
    genericFiles: mixedAnalysis.genericFiles,
    unreviewed: mixedAnalysis.ranked.filter((r) => r.rel !== 'src/engine.rs').map((r) => r.rel)
};
const mixedReport = renderReport({
    reviewId: 'r_mixed_test',
    snapshotMeta: { sourceLabel: 'mixed-fixture', treeHash: 'a'.repeat(64) },
    modelPair: { grunt: 'grunt-test', orchestrator: 'orchestrator-test' },
    state: { round: 0, stopReason: 'fixture', summary: '', findings: [], rejections: [] },
    analysis: mixedAnalysis,
    coverage: mixedCoverage,
    exclusions: [],
    digestGaps: [],
    validatorStats: { blocklistCounts: {} },
    incremental: null
});
ok(mixedReport.includes('2 rust') && mixedReport.includes('src/worker.py (python)'), 'coverage names Rust totals and generic-language files explicitly');
ok(mixedReport.includes('no source is skipped because of its language'), 'coverage states that language is not a model-review exclusion');
ok(!mixedReport.includes('- src/engine.rs (rust)'), 'Rust core source is not misreported as lacking a tier-0 adapter');

// ── Validator ──────────────────────────────────────────────────────────────
console.log('\n[validator]');
const fileSet = new Set(analysis.files.map((f) => f.rel));
const apiSource = await fsp.readFile(path.join(snap.snapshotDir, 'src', 'api.js'), 'utf8');

const goodFinding = {
    file: 'src/api.js',
    lines: [13, 15],
    evidence: '} catch (err) {\n        return null;\n    }',
    failure_mode: 'Network failure is silently converted to null — callers cannot distinguish "no such user" from "API down"; rung 1 (why a network call per lookup) was never asked.',
    class: 'free-win',
    suggestion: 'Delete the catch; let the fetch failure propagate. Add a Result-style return { ok, value, error } if callers must not throw.',
    test_spec: { bug: 'fetchUser returns null on network failure, indistinguishable from missing user', data_source: 'recorded-fixture', shape: 'one 500-response replay among 10 valid responses; assert caller sees the failure, not null' }
};
const good = await validator.validateFinding(goodFinding, snap.snapshotDir, fileSet);
ok(good.ok, `good finding passes${good.ok ? '' : ` — ${good.reason}`}`);

const outOfRange = { ...goodFinding, lines: [1, 2] };
const oor = await validator.validateFinding(outOfRange, snap.snapshotDir, fileSet);
ok(!oor.ok && oor.reason.includes('outside cited lines'), 'evidence outside cited lines rejected');

const hallucinated = { ...goodFinding, evidence: 'this line does not exist in the file at all' };
const hal = await validator.validateFinding(hallucinated, snap.snapshotDir, fileSet);
ok(!hal.ok && hal.reason.includes('verbatim'), 'hallucinated evidence rejected');

const degradingNoRung = {
    ...goodFinding,
    suggestion: 'Fix:\n```diff\n--- a/src/api.js\n+++ b/src/api.js\n@@\n+    } catch (err) {\n+        return config.fallbackUser ?? null;\n+    }\n```'
};
const dnr = await validator.validateFinding(degradingNoRung, snap.snapshotDir, fileSet);
ok(!dnr.ok && dnr.reason.includes('no ladder, no handler'), 'degrading guard without ladder rejected');

const degradingWithRung = {
    ...degradingNoRung,
    rung: { dependency: 'user API HTTP call', rejected_elimination: 'user data is only available remotely', consequence_before: 'process crash on API hiccup', consequence_after: 'feature degrades with logged cause' }
};
const dwr = await validator.validateFinding(degradingWithRung, snap.snapshotDir, fileSet);
ok(dwr.ok, 'degrading guard WITH structured ladder passes');

const throwingGuard = {
    ...goodFinding,
    suggestion: 'Fix:\n```diff\n--- a/src/api.js\n+++ b/src/api.js\n@@\n+    if (first === -1 || last <= first) throw new Error("no JSON object in output");\n+    const rawMsg = String(err.message || err);\n```'
};
const tg = await validator.validateFinding(throwingGuard, snap.snapshotDir, fileSet);
ok(tg.ok, 'throwing guard with || inside the if-condition is legal without ladder (boolean logic ≠ value default)');

const placeholder = { ...goodFinding, test_spec: { bug: 'returns null on failure', data_source: 'calibrated-generated', shape: 'call with foo and bar values' } };
const ph = validator.validateTestSpec(placeholder.test_spec);
ok(!ph.ok && ph.reason.includes('placeholder'), 'placeholder test data rejected');

const counts = validator.countBlocklist(['this is best practice', 'add defensive programming', 'removes defensive fallback']);
ok(counts['best practice'] === 1 && counts['defensive programming'] === 1, 'blocklist counts, never rejects (defensive fallback not counted)');

// ── Blast radius ───────────────────────────────────────────────────────────
console.log('\n[blast radius]');
const blastFromUtil = computeBlastRadius(analysis, ['src/util.js']);
ok(blastFromUtil.has('src/api.js') && blastFromUtil.has('src/store.js'), 'util.js change → api.js + store.js re-reviewed');
ok(!blastFromUtil.has('src/worker.js'), 'worker.js untouched (does not import util)');
const blastFromApi = computeBlastRadius(analysis, ['src/api.js']);
ok(blastFromApi.has('src/api.js') && !blastFromApi.has('src/store.js'), 'api.js change does not leak to non-importers');

// Regression (dogfood round 1, F1): dynamic imports must create graph edges —
// acorn parses `import(x)` as ImportExpression, not CallExpression.
const dynTmp = path.join(tmpData, 'dyn');
await fsp.mkdir(dynTmp, { recursive: true });
await fsp.writeFile(path.join(dynTmp, 'loader.js'), `const mod = await import('./feature.js');\nexport default mod;\n`);
await fsp.writeFile(path.join(dynTmp, 'feature.js'), `export const x = 1;\n`);
const dynAnalysis = await analyzeSnapshot(dynTmp);
ok(dynAnalysis.graph.edges['loader.js']?.includes('feature.js'), 'dynamic import() creates a graph edge (ImportExpression)');
const dynBlast = computeBlastRadius(dynAnalysis, ['feature.js']);
ok(dynBlast.has('loader.js'), 'dynamic importer enters the blast radius');

// Regression (dogfood finding F2): deleted files' importers are only in the
// PRIOR graph — deletion must traverse it.
const priorEdges = { 'app.js': ['shared.js'], 'other.js': ['shared.js'] };
const currentLike = { graph: { reverse: {} } }; // app/other no longer statically resolve shared (it is gone)
const delBlast = computeBlastRadiusWithDeletions(currentLike, ['unrelated.js'], ['shared.js'], priorEdges);
ok(delBlast.has('app.js') && delBlast.has('other.js') && delBlast.has('unrelated.js'), 'deletion of shared.js invalidates its prior-graph importers');

// ── Acceptance gate ────────────────────────────────────────────────────────
console.log('\n[acceptance gate]');
const gateTmp = path.join(tmpData, 'gate');
const gateSnapshot = path.join(gateTmp, 'snapshot');
await fsp.mkdir(path.join(gateSnapshot, 'src'), { recursive: true });
// Planted bug: silent null on failure (the corpus finding, minimal form).
await fsp.writeFile(path.join(gateSnapshot, 'src', 'user.js'), `export function lookup(id, table) {\n    const entry = table[id];\n    if (!entry) return null;\n    return entry;\n}\n`);
const gateDiff = `--- a/src/user.js\n+++ b/src/user.js\n@@ -1,4 +1,4 @@\n export function lookup(id, table) {\n     const entry = table[id];\n-    if (!entry) return null;\n+    if (!entry) throw new Error(\`lookup: unknown id \${id}\`);\n     return entry;\n }\n`;
const gateTest = `import { lookup } from '../src/user.js';\nimport assert from 'node:assert/strict';\n// Proves: unknown id must surface loudly, not as null.\nassert.throws(() => lookup('nope', { a: { name: 'A' } }), /unknown id/);\nconsole.log('PASS');\n`;
const gate = await runAcceptanceGate({
    sandboxRoot: path.join(gateTmp, 'sandbox'),
    snapshotDir: gateSnapshot,
    targetRel: 'src/user.js',
    diffText: gateDiff,
    testRel: 'test/gate.test.mjs',
    testCode: gateTest,
    needsInstall: false
});
ok(gate.verdict === 'verified', `gate verifies real fix (fail before, pass after) — got '${gate.verdict}'`);

const noopDiff = `--- a/src/user.js\n+++ b/src/user.js\n@@ -1,4 +1,4 @@\n export function lookup(id, table) {\n     const entry = table[id];\n-    if (!entry) return null;\n+    if (!entry) return null; // noop\n     return entry;\n }\n`;
const gateNoop = await runAcceptanceGate({
    sandboxRoot: path.join(gateTmp, 'sandbox-noop'),
    snapshotDir: gateSnapshot,
    targetRel: 'src/user.js',
    diffText: noopDiff,
    testRel: 'test/gate.test.mjs',
    testCode: gateTest,
    needsInstall: false
});
ok(gateNoop.verdict === 'failed-after', `non-fix blocked (diff does not fix the bug) — got '${gateNoop.verdict}'`);

const notRealBugTest = `import { lookup } from '../src/user.js';\n// Asserts the CURRENT behavior — passes on the unpatched file, so the "bug" is not proven.\nconst v = lookup('nope', { a: { name: 'A' } });\nif (v !== null) throw new Error('expected null');\nconsole.log('PASS');\n`;
const gateNotReal = await runAcceptanceGate({
    sandboxRoot: path.join(gateTmp, 'sandbox-notreal'),
    snapshotDir: gateSnapshot,
    targetRel: 'src/user.js',
    diffText: gateDiff,
    testRel: 'test/gate.test.mjs',
    testCode: notRealBugTest,
    needsInstall: false
});
ok(gateNotReal.verdict === 'failed-before', `unproven bug blocked (test passes on unpatched) — got '${gateNotReal.verdict}'`);

let threw = false;
try {
    applyUnifiedDiff(path.join(gateTmp, 'mismatch'), 'src/user.js', gateDiff.replace('lookup(id, table)', 'lookup(id, tabl)'));
} catch {
    threw = true;
}
ok(threw, 'diff with wrong context fails loudly (anchored to snapshot)');

// Regression (dogfood round 3, F5): CRLF diff text must apply like LF.
const crlfDiff = gateDiff.replace(/\n/g, '\r\n');
const gateCrlf = await runAcceptanceGate({
    sandboxRoot: path.join(gateTmp, 'sandbox-crlf'),
    snapshotDir: gateSnapshot,
    targetRel: 'src/user.js',
    diffText: crlfDiff,
    testRel: 'test/gate.test.mjs',
    testCode: gateTest,
    needsInstall: false
});
ok(gateCrlf.verdict === 'verified', `CRLF diff applies like LF — got '${gateCrlf.verdict}'`);

// Regression (dogfood round 3, F1): CJS fallback parse must not duplicate comments.
// `with` is module-forbidden but sloppy-script-legal — it forces the fallback path.
const cjsTmp = path.join(tmpData, 'cjs');
await fsp.mkdir(cjsTmp, { recursive: true });
await fsp.writeFile(path.join(cjsTmp, 'legacy.cjs'), `// check p now\nfunction check(cfg) { with (cfg) { return p; } }\nmodule.exports = check;\n`);
const cjsAnalysis = await analyzeSnapshot(cjsTmp);
const cjsNarrations = cjsAnalysis.hunts.filter((h) => h.kind === 'narration-comment');
ok(cjsNarrations.length === 1, `CJS fallback parse does not duplicate comments (got ${cjsNarrations.length} narration hunts)`);

// ── Store (nDB) ────────────────────────────────────────────────────────────
console.log('\n[store]');
const store = await import(`file://${path.join(AGENT, 'store.js').replaceAll('\\', '/')}`);
store.initStore(path.join(tmpData, 'db'));
const reviewId = await store.saveReview({ sourceLabel: 'fixture', snapshotHash: snap.treeHash, modelPair: 'a+b', validatorVersion: validator.VALIDATOR_VERSION, status: 'done' });
const prior = await store.findLatestReviewForSource('fixture', 'a+b', validator.VALIDATOR_VERSION);
ok(prior && prior._id === reviewId, 'review saved and found by source+models+validator');
const fp = validator.findingFingerprint(goodFinding);
const saved1 = await store.saveFinding({ reviewId, sourceLabel: 'fixture', snapshotHash: snap.treeHash, fingerprint: fp, file: 'src/api.js', failure_mode: goodFinding.failure_mode, status: 'new' });
await store.updateFinding(saved1.id, { status: 'rejected' });
const sameReview = await store.saveFinding({ reviewId, sourceLabel: 'fixture', snapshotHash: snap.treeHash, fingerprint: fp, file: 'src/api.js', failure_mode: goodFinding.failure_mode });
ok(sameReview.status === 'new', 'rejection in the CURRENT review does not suppress its own later findings');
const otherSource = await store.saveFinding({ reviewId: 'r_other_source', sourceLabel: 'other-project', snapshotHash: snap.treeHash, fingerprint: fp, file: 'src/api.js', failure_mode: goodFinding.failure_mode });
ok(otherSource.status === 'new', 'identical fingerprint in ANOTHER source stays new (no cross-source suppression)');
const sameSourceLater = await store.saveFinding({ reviewId: 'r_other_same_source', sourceLabel: 'fixture', snapshotHash: snap.treeHash, fingerprint: fp, file: 'src/api.js', failure_mode: goodFinding.failure_mode });
ok(sameSourceLater.status === 'rejected', 'rejection from a prior review of the SAME source persists');
const listed = await store.listFindings({ reviewId });
ok(listed.length === 2, 'findings listed by review (cross-review findings excluded)');

// ── Gateway smoke (env-gated) ──────────────────────────────────────────────
if (process.env.CODEVIEW_SMOKE === '1') {
    console.log('\n[gateway smoke — full pipeline against the seeded corpus]');
    const { createGatewayClient } = await import(`file://${path.join(__dirname, '..', 'src', 'gateway-client.js').replaceAll('\\', '/')}`);
    const gateway = createGatewayClient(null, 'http://localhost:3400', 'someKey33!!', { embed: async () => { throw new Error('no embeds in smoke test'); } });
    const { runReview } = await import(`file://${path.join(AGENT, 'pipeline.js').replaceAll('\\', '/')}`);
    const storageRoot = 'D:\\MCP_Storage';
    const result = await runReview({
        source: FIXTURE,
        models: { grunt: 'deepseek-flash-chat', orchestrator: 'kimi-k31-chat' },
        budget: { maxRounds: 4 },
        gateway,
        storageRoot,
        dataDir: path.join(tmpData, 'smoke-data'),
        emitProgress: (msg) => console.log(`    ${msg}`)
    });
    const seeded = [
        ['swallowed catch → null', (f) => /null|swallow|silent/i.test(f.failure_mode) && f.file === 'src/api.js'],
        ['|| config default', (f) => f.file === 'src/api.js' && /\|\||endpoint|default/i.test(f.failure_mode + f.suggestion)],
        ['?? config default', (f) => f.file === 'src/store.js' && /(\?\?|dataDir|default)/i.test(f.failure_mode + f.suggestion)],
        ['empty catch', (f) => f.file === 'src/worker.js'],
        ['narration comment', (f) => f.file === 'src/util.js']
    ];
    let hits = 0;
    for (const [label, matcher] of seeded) {
        const found = result.state.findings.some(matcher);
        if (found) hits++;
        console.log(`    recall: ${found ? 'HIT ' : 'miss'} — ${label}`);
    }
    console.log(`    recall ${hits}/${seeded.length}, findings ${result.state.findings.length}, rejected ${result.state.rejections.length}`);
    console.log(`    report: ${path.join(tmpData, 'smoke-data', 'reviews', result.reviewId, 'report.md')}`);
    ok(result.report.includes('## Coverage'), 'report has coverage section');
    ok(result.state.findings.length > 0, 'smoke run produced findings');
} else {
    console.log('\n[gateway smoke skipped — set CODEVIEW_SMOKE=1 to run the full pipeline]');
}

await fsp.rm(tmpData, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
