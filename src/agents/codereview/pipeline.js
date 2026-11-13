// Review pipeline — tier-1 grunt digests, tier-2 orchestrator loop, state
// persistence, report rendering (spec §4). The orchestrator never sees the
// whole codebase: it sees the map and digests, plus raw source of the dive
// targets it selects. State is a structured object resent in full each turn
// and persisted to disk after every round — crash survival is only real if
// it's on disk (§7.4).

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getLogger } from '../../utils/logger.js';
import { computeBlastRadiusWithDeletions } from './analyzer.js';
import {
    VALIDATOR_VERSION, validateFinding, validateDigest, validateTestSpec,
    countBlocklist, findingFingerprint
} from './validator.js';
import * as store from './store.js';

const logger = getLogger();

// ── Model call helpers ─────────────────────────────────────────────────────

function extractJson(text) {
    if (typeof text === 'object' && text !== null) return text;
    const first = String(text ?? '').indexOf('{');
    const last = String(text ?? '').lastIndexOf('}');
    if (first === -1 || last <= first) throw new Error('no JSON object in model output');
    return JSON.parse(String(text).slice(first, last + 1));
}

async function callJson(gateway, model, systemPrompt, userPrompt, { maxTokens = 8000, timeoutMs = 300_000, schema = null } = {}) {
    const response = await gateway.chat({
        model,
        stream: false,
        maxTokens,
        timeoutMs,
        responseFormat: { type: 'json_object' },
        ...(schema ? { schema } : {}),
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
    });
    return extractJson(response.content);
}

// The gateway client wraps transport failures as plain Errors ("Gateway
// connection failed: fetch failed", timeouts) — classify by message, not by
// error class, or wrapped connection deaths take the malformed-JSON path.
function isConnectionError(err) {
    const message = String(err?.message ?? '');
    if (/^Gateway connection failed/.test(message)) return true;
    if (/timed out after \d+ms|Gateway chat aborted/.test(message)) return true;
    if (err instanceof TypeError && err.message === 'fetch failed') return true;
    return false;
}

// A gateway call is a boundary we don't control. Two distinct failure shapes,
// two distinct ladders (spec §4.1 — the pipeline climbs its own):
// - Connection-level failures (undici keep-alive socket death: the gateway
//   closes idle pooled sockets and a reused POST can die mid-flight) → retry
//   the SAME prompt, up to twice, 1.5 s apart. Visible in the log each time.
// - Malformed model output → ONE retry with the parse error attached, then loud.
// Neither path ever degrades silently: exhaustion throws.
async function callJsonWithRetry(gateway, model, systemPrompt, userPrompt, opts) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await callJson(gateway, model, systemPrompt, userPrompt, opts);
        } catch (err) {
            if (isConnectionError(err) && attempt < 2) {
                logger.warn(`[codereview] gateway connection died (attempt ${attempt + 1}/3, ${err.cause?.message ?? 'no cause'}); retrying same prompt`, null, 'CodeReview');
                await new Promise((r) => setTimeout(r, 1500));
                continue;
            }
            if (!isConnectionError(err)) {
                const retryPrompt = `${userPrompt}\n\n--- Your previous reply was not valid JSON for the schema: ${err.message}\nReply again with ONLY the JSON object. ---`;
                logger.warn(`[codereview] model ${model} returned malformed JSON (${err.message}); retrying once with error attached`, null, 'CodeReview');
                return callJson(gateway, model, systemPrompt, retryPrompt, opts);
            }
            throw err;
        }
    }
    throw new Error(`codereview: gateway connection failed 3× for model ${model} — gateway unreachable from this process`);
}

// ── System prompts ─────────────────────────────────────────────────────────

function loadPrinciples(storageRoot) {
    const primePath = path.resolve(storageRoot, 'documentation', 'Workshop', 'Agents_Prime.md');
    const content = fs.readFileSync(primePath, 'utf8');
    const start = content.indexOf('## Principles');
    if (start === -1) throw new Error('codereview: no ## Principles section in Agents_Prime.md');
    const end = content.indexOf('\n## ', start + 1);
    return (end === -1 ? content.slice(start) : content.slice(start, end)).trim();
}

const ORCHESTRATOR_ROUND_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        new_findings: { type: 'array', maxItems: 5, items: { type: 'object' } },
        next_files: { type: 'array', maxItems: 5, items: { type: 'string' } },
        done: { type: 'boolean' },
        summary: { type: 'string' }
    },
    required: ['new_findings', 'next_files', 'done', 'summary']
};
const ORCHESTRATOR_CALL_OPTIONS = { maxTokens: 16000, timeoutMs: 600_000, schema: ORCHESTRATOR_ROUND_SCHEMA };

const ORCHESTRATOR_BRIEF = `
You are the orchestrator of a code review. The maxims below are the rubric — they are not advice, they are the review criteria.

Goal: the most reliability at the lowest performance cost. Anti-goals: defensive-programming bloat, error-reporting ritual, clean-code conventions. The aim is architectures that cannot fail; if code CAN fail, the suggestion is to change it so it cannot — not to handle the failure.

BOUNDARY LADDER — every external dependency is judged on three rungs, in order:
1. ELIMINATE: why does this dependency exist at all? Local copy, precomputed data, in-process call. The best failure handling is the request not existing.
2. SHRINK BLAST RADIUS: what happens to the process when it fails? Consequence classes: corrupts-state/wrong-answer > feature-degrades > cosmetic. Redesign until it drops a class. Strong pattern: design the failure into the contract — failure as data (Result-style return), not a control-flow hijack.
3. TOLERATE VISIBLY: only what survives 1-2 earns a handler, and it must leave a trace.
A handler that exists without having climbed the ladder is the smell. Throwing guards (fail-fast assertions) are ALWAYS legal and prescribed. Degrading guards (fallback defaults, swallowed catches) are only legal with documented ladder analysis.

YOUR JOB each round:
- You receive a MAP of the codebase (modules, ranked files with facts and digests, hunt candidates from deterministic analysis) and, from round 2 on, the RAW SOURCE (with line numbers) of files you selected.
- Judge hunt candidates against the rubric. Read dive sources for verification and for finding issues grep cannot see (cross-file contract breaks, race shapes, wrong failure-consequence class).
- Emit findings ONLY where you can quote the file VERBATIM. No generic advice — a finding without a reproducible failure mode is noise.

FINDING SCHEMA (exact, one object per finding):
{
  "file": "snapshot-relative/source-path",
  "lines": [startLine, endLine],
  "evidence": "verbatim quote from the file — must match the cited lines exactly",
  "failure_mode": "what breaks, when, in production shape",
  "class": "free-win" | "trade-off",
  "suggestion": "the change to make; include a diff-style code block when concrete. free-win = improves reliability AND performance. trade-off = reliability vs performance genuinely opposed (surface the either/or, do not pick silently).",
  "rung": null | { "dependency": "...", "rejected_elimination": "why rung 1 fails", "consequence_before": "...", "consequence_after": "..." }  // REQUIRED non-null if the suggestion adds a degrading guard
  "test_spec": { "bug": "the concrete bug this test proves", "data_source": "production-replay" | "recorded-fixture" | "calibrated-generated", "shape": "the load shape (concurrency, volume, skew) — a number tests nothing", "runtime": true|false }  // runtime:true when the bug needs live runtime conditions a static sandbox cannot reproduce
}

RULES:
- Max 5 findings per round. Depth beats volume.
- Evidence must be copied character-for-character from the file, inside the lines you cite.
- Never suggest adding try/catch, null guards, fallbacks, or validation layers unless you document the ladder AND boundary validation genuinely cannot eliminate the input.
- Prefer deleting defensive code over adding handling.
- test_spec is mandatory. If you cannot name the bug a test would catch, you have no finding.
`;

const GRUNT_BRIEF = `
You are the digest writer in a code-review pipeline. Factual, terse, no advice.
Given one source file, reply with ONLY this JSON object:
{ "file": "<the relative path you were given>", "role": "what this module actually does — 1-2 sentences, factual", "boundaries": ["network"|"process"|"fs" — external systems this file touches"], "risks": ["judgment-level observations grep cannot make: inconsistent error philosophy, surprising coupling, misleading names. NO style nits, NO clean-code advice, NO 'consider adding' phrasing. Empty array when nothing real."] }
State facts. Do not recommend. Do not mention error handling unless the file's error philosophy is internally inconsistent.
`;

// ── Tier 1: digests ────────────────────────────────────────────────────────

async function runDigests(gateway, gruntModel, snapshotDir, filesToDigest, analysis) {
    const digests = new Map();
    const gaps = [];
    const concurrency = 4;
    const queue = [...filesToDigest];
    const analyzedSet = new Set(analysis.files.map((f) => f.rel));

    async function worker() {
        while (queue.length > 0) {
            const rel = queue.shift();
            if (!analyzedSet.has(rel)) continue;
            const abs = path.join(snapshotDir, ...rel.split('/'));
            let source;
            try {
                source = await fsp.readFile(abs, 'utf8');
            } catch (err) {
                gaps.push({ file: rel, reason: `unreadable: ${err.message}` });
                continue;
            }
            if (source.length > 120_000) source = source.slice(0, 120_000) + '\n// [truncated for digest]';
            try {
                const digest = await callJsonWithRetry(gateway, gruntModel, GRUNT_BRIEF, `File: ${rel}\n\n\`\`\`\n${source}\n\`\`\``, { maxTokens: 2000 });
                // The caller asked for THIS file — a model-echoed path with a
                // different prefix is variance, not identity. Normalize the
                // trivial shape variants (risks as string, objects with text);
                // anything past that still fails and becomes a visible gap.
                digest.file = rel;
                if (typeof digest.risks === 'string') digest.risks = [digest.risks];
                if (Array.isArray(digest.risks)) {
                    digest.risks = digest.risks.map((r) => (typeof r === 'object' && r !== null && typeof (r.text ?? r.risk ?? r.message) === 'string' ? (r.text ?? r.risk ?? r.message) : r));
                }
                const check = validateDigest(digest, analyzedSet);
                if (!check.ok) throw new Error(check.reason);
                digests.set(rel, digest);
            } catch (err) {
                gaps.push({ file: rel, reason: `digest failed validation twice: ${err.message}` });
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { digests, gaps };
}

// ── Map rendering (what the orchestrator sees) ─────────────────────────────

function renderMap(analysis, digests, digestGaps, scope) {
    const lines = [];
    lines.push('## Modules');
    for (const mod of analysis.modules.slice(0, 40)) {
        const languages = [
            mod.jsCount ? `${mod.jsCount} js` : null,
            mod.rustCount ? `${mod.rustCount} rust` : null,
            mod.genericCount ? `${mod.genericCount} generic` : null
        ].filter(Boolean).join(', ') || 'no files';
        lines.push(`- ${mod.dir} — ${mod.fileCount} files (${languages}, ${mod.totalLines} loc)${mod.boundaries.length ? `, boundaries: ${mod.boundaries.join('+')}` : ''}`);
    }

    lines.push('\n## Ranked files (top 60) — score | language/analysis | facts | digest');
    for (const r of analysis.ranked.slice(0, 60)) {
        const digest = digests.get(r.rel);
        const digestText = digest ? digest.role : (digestGaps.some((g) => g.file === r.rel) ? 'DIGEST GAP (unavailable)' : 'not digested');
        lines.push(`- ${r.rel} [${r.score.toFixed(1)}] ${r.language}/${r.analysisMode} ${r.lines}loc ${r.reasons.join(',') || 'plain'} — ${digestText}`);
        if (digest?.risks?.length) {
            for (const risk of digest.risks.slice(0, 3)) lines.push(`    risk: ${risk}`);
        }
    }

    lines.push('\n## Hunt candidates (deterministic tier-0 output — judge each against the rubric)');
    const huntByFile = new Map();
    for (const hunt of analysis.hunts) {
        if (!huntByFile.has(hunt.file)) huntByFile.set(hunt.file, []);
        huntByFile.get(hunt.file).push(hunt);
    }
    for (const [file, hunts] of huntByFile) {
        for (const hunt of hunts) {
            lines.push(`- ${file}:${hunt.line} [${hunt.kind}] ${hunt.snippet}`);
        }
    }

    if (analysis.graph.unresolved.length > 0) {
        lines.push(`\n## Unresolved dependency edges (${analysis.graph.unresolved.length}) — reachable-via-these files are NOT claimed as covered`);
        for (const edge of analysis.graph.unresolved.slice(0, 30)) {
            lines.push(`- ${edge.from} → ${edge.specifier} (${edge.kind})`);
        }
    }
    return lines.join('\n');
}

function renderSources(snapshotDir, files) {
    const parts = [];
    for (const rel of files) {
        const abs = path.join(snapshotDir, ...rel.split('/'));
        const source = fs.readFileSync(abs, 'utf8');
        const numbered = source.split('\n').map((line, i) => `${i + 1} ${line}`).join('\n');
        parts.push(`### ${rel}\n\`\`\`\n${numbered}\n\`\`\``);
    }
    return parts.join('\n\n');
}

// ── Tier 2: orchestrator loop ──────────────────────────────────────────────

async function runOrchestratorLoop({ gateway, orchestratorModel, storageRoot, snapshotDir, analysis, digests, digestGaps, maxRounds, priorCarriedFindings }) {
    const state = {
        round: 0,
        completedRounds: 0,
        dived: [],
        findings: [],
        rejections: [],
        stopReason: null,
        interruption: null,
        summary: null
    };
    const principles = loadPrinciples(storageRoot);
    const systemPrompt = `${principles}\n${ORCHESTRATOR_BRIEF}`;
    let consecutiveEmpty = 0;
    let nextFiles = [];

    const persist = async (reviewDir) => {
        const persistable = {
            round: state.round,
            completedRounds: state.completedRounds,
            dived: state.dived,
            findings: state.findings,
            rejections: state.rejections,
            stopReason: state.stopReason,
            interruption: state.interruption,
            summary: state.summary,
            remainingRounds: maxRounds - state.round,
            orchestratorModel
        };
        await fsp.writeFile(path.join(reviewDir, 'state.json'), JSON.stringify(persistable, null, 2));
    };

    return {
        state,
        async run(reviewDir, emitProgress) {
            const mapText = renderMap(analysis, digests, digestGaps);
            const carriedNote = priorCarriedFindings.length > 0
                ? `\n${priorCarriedFindings.length} findings from the previous review of unchanged files are carried forward (outside the blast radius of this diff) — do NOT re-emit them.\n`
                : '';

            while (state.round < maxRounds) {
                state.round++;
                const remaining = maxRounds - state.round;
                let userPrompt = `REVIEW STATE (round ${state.round} of ${maxRounds}, ${remaining} after this one)\n\n## Verified findings so far: ${state.findings.length}\n`;
                for (const f of state.findings) {
                    userPrompt += `- ${f.file}:${f.lines[0]} (${f.class}) ${f.failure_mode}\n`;
                }
                userPrompt += `${carriedNote}\n## MAP\n${mapText}\n`;
                if (nextFiles.length > 0) {
                    userPrompt += `\n## DIVE SOURCES (your selections from last round)\n${renderSources(snapshotDir, nextFiles)}\n`;
                }
                userPrompt += `
Respond with ONLY this JSON object:
{
  "new_findings": [ <finding objects per the schema; empty array if none> ],
  "next_files": [ "up to 5 snapshot-relative files to read next round — empty if nothing is worth reading" ],
  "done": true|false,
  "summary": "one paragraph: the codebase's overall reliability/performance posture"
}
Rules: first round has no dive sources — choose next_files from the ranked list. done:true when another dive would not change the report. You have selected so far: ${state.dived.join(', ') || 'none'}.`;

                emitProgress?.(`Orchestrator round ${state.round}/${maxRounds}...`, Math.min(10 + state.round * 7, 85));
                const response = await callJsonWithRetry(gateway, orchestratorModel, systemPrompt, userPrompt, ORCHESTRATOR_CALL_OPTIONS);

                const analysisSet = new Set(analysis.ranked.map((f) => f.rel));
                let acceptedThisRound = 0;
                for (const finding of Array.isArray(response.new_findings) ? response.new_findings : []) {
                    const check = await validateFinding(finding, snapshotDir, analysisSet);
                    if (check.ok) {
                        state.findings.push(finding);
                        acceptedThisRound++;
                    } else {
                        state.rejections.push({ file: finding?.file ?? '?', reason: check.reason });
                    }
                }

                nextFiles = (Array.isArray(response.next_files) ? response.next_files : [])
                    .filter((f) => analysisSet.has(f) && !state.dived.includes(f))
                    .slice(0, 5);
                state.dived.push(...nextFiles);
                state.completedRounds = state.round;
                await persist(reviewDir);

                if (response.done === true || nextFiles.length === 0) {
                    state.stopReason = response.done === true ? 'orchestrator done' : 'no further dive targets';
                    state.summary = response.summary ?? '';
                    break;
                }
                consecutiveEmpty = acceptedThisRound === 0 ? consecutiveEmpty + 1 : 0;
                if (consecutiveEmpty >= 2) {
                    state.stopReason = 'two consecutive rounds with no new verified findings';
                    state.summary = response.summary ?? '';
                    break;
                }
            }
            if (state.round >= maxRounds && !state.stopReason) {
                state.stopReason = `round budget exhausted (${maxRounds})`;
            }
            state.summary = state.summary ?? '';
            await persist(reviewDir);
            return state;
        },
        persist
    };
}

// ── Incremental review ─────────────────────────────────────────────────────

async function sha256File(abs) {
    const buf = await fsp.readFile(abs);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

async function computeIncremental({ fileHashes, analysis, priorReview, reviewsRoot }) {
    if (!priorReview) return { changedFiles: null, blastRadius: null, priorFindings: [] };
    const priorAnalysisPath = path.join(reviewsRoot, priorReview._id, 'analysis.json');
    if (!fs.existsSync(priorAnalysisPath)) return { changedFiles: null, blastRadius: null, priorFindings: [] };
    const priorAnalysis = JSON.parse(fs.readFileSync(priorAnalysisPath, 'utf8'));

    const changed = [];
    const deleted = [];
    const priorSet = new Set(Object.keys(priorAnalysis.fileHashes));
    const currentRels = new Set(analysis.files.map((f) => f.rel));
    for (const rel of currentRels) {
        if (priorAnalysis.fileHashes[rel] !== fileHashes[rel]) changed.push(rel);
    }
    for (const rel of priorSet) {
        if (!currentRels.has(rel)) deleted.push(rel); // deletion changes the behavior of every importer
    }
    if (changed.length === 0 && deleted.length === 0) {
        return { changedFiles: [], blastRadius: new Set(), priorFindings: await store.listFindings({ reviewId: priorReview._id }) };
    }

    // Blast radius from the CURRENT graph covers modified files. Deleted files
    // are different: the new snapshot's graph cannot contain edges to a file
    // that no longer exists, so their importers are only recorded in the PRIOR
    // graph — traversing it is the only way deletion invalidates them.
    const blast = computeBlastRadiusWithDeletions(analysis, changed, deleted, priorAnalysis.graphEdges);
    const priorFindings = await store.listFindings({ reviewId: priorReview._id });
    return { changedFiles: [...changed, ...deleted.map((d) => `${d} (deleted)`)], blastRadius: blast, priorFindings };
}

// ── Report rendering ───────────────────────────────────────────────────────

export function renderReport({ reviewId, snapshotMeta, modelPair, state, analysis, coverage, exclusions, digestGaps, validatorStats, incremental }) {
    const lines = [];
    lines.push(`# Code review — ${snapshotMeta.sourceLabel}${state.interruption ? ' — PARTIAL' : ''}`);
    lines.push(`review: ${reviewId} · tree: ${snapshotMeta.treeHash.slice(0, 16)} · models: ${modelPair.grunt} + ${modelPair.orchestrator} · rounds: ${state.completedRounds ?? state.round} completed (${state.stopReason})`);
    if (state.interruption) {
        lines.push(`\n> **PARTIAL REVIEW — orchestrator interrupted during round ${state.interruption.round}.** ${state.interruption.message}\n> The findings below were validated and persisted from completed rounds. Coverage is incomplete; this is not a finished review.`);
    }
    if (state.summary) {
        lines.push(`\n**Posture:** ${state.summary}`);
    }

    const freeWins = state.findings.filter((f) => f.class === 'free-win');
    const tradeOffs = state.findings.filter((f) => f.class === 'trade-off');
    lines.push(`\n**${freeWins.length} free wins** (reliability AND performance) · **${tradeOffs.length} trade-off decisions** (yours to make) · ${state.rejections.length} rejected by validator`);

    let index = 0;
    for (const finding of freeWins) {
        index++;
        lines.push(`\n### F${index} · free-win · ${finding.file}:${finding.lines[0]}-${finding.lines[1]}`);
        lines.push(`**What:** ${finding.failure_mode}`);
        lines.push(`**Next action:** ${finding.suggestion}`);
        lines.push(`**Test:** ${finding.test_spec.shape} (data: ${finding.test_spec.data_source}) — proves: ${finding.test_spec.bug}`);
        if (finding.test_spec.runtime) lines.push(`_Runtime-dependent bug: acceptance gate will mark it unprovable, not verified._`);
    }
    for (const finding of tradeOffs) {
        index++;
        lines.push(`\n### F${index} · trade-off · ${finding.file}:${finding.lines[0]}-${finding.lines[1]}`);
        lines.push(`**Decision:** ${finding.failure_mode}`);
        lines.push(`**Either/or:** ${finding.suggestion}`);
        lines.push(`**Test:** ${finding.test_spec.shape} (data: ${finding.test_spec.data_source}) — proves: ${finding.test_spec.bug}`);
    }
    if (state.findings.length === 0) {
        lines.push('\n_No verified findings. Rejected candidates below may explain why._');
    }

    lines.push(`\n## Coverage — never silent`);
    lines.push(`Reviewed: ${coverage.divedCount} files dived + ${coverage.carriedCount} carried from prior review · tree: ${coverage.totalFiles} text files (${coverage.totalJs} js, ${coverage.totalRust} rust, ${coverage.totalGeneric} generic)`);
    lines.push(`Language-specific tier-0: JavaScript (AST) + Rust (structural). Every other text file—including configuration and documentation—remains digest/dive eligible with generic boundary analysis; language never controls eligibility.`);
    if (coverage.genericFiles.length > 0) {
        const shown = coverage.genericFiles.slice(0, 40);
        lines.push(`\nNo language-specific tier-0 adapter (${coverage.genericFiles.length}) — these files ARE model-review eligible, but have generic deterministic analysis only:\n${shown.map((f) => `- ${f.rel} (${f.language})`).join('\n')}${coverage.genericFiles.length > shown.length ? `\n- ... and ${coverage.genericFiles.length - shown.length} more` : ''}`);
    }
    if (coverage.unreviewed.length > 0) {
        const shown = coverage.unreviewed.slice(0, 40);
        lines.push(`Un-reviewed (${coverage.unreviewed.length}):\n${shown.map((f) => `- ${f}`).join('\n')}${coverage.unreviewed.length > shown.length ? `\n- ... and ${coverage.unreviewed.length - shown.length} more` : ''}`);
    }
    if (analysis.graph.unresolved.length > 0) {
        lines.push(`\nUnresolved dependency edges (${analysis.graph.unresolved.length}) — files reachable only through these are not claimed as covered:`);
        for (const edge of analysis.graph.unresolved.slice(0, 15)) lines.push(`- ${edge.from} → ${edge.specifier} (${edge.kind})`);
    }

    if (exclusions.length > 0) {
        lines.push(`\n## Snapshot exclusions (${exclusions.length}) — the review never saw these`);
        for (const ex of exclusions.slice(0, 30)) lines.push(`- ${ex.rel} — ${ex.reason}`);
        if (exclusions.length > 30) lines.push(`- ... and ${exclusions.length - 30} more`);
    }
    if (digestGaps.length > 0) {
        lines.push(`\n## Digest gaps (${digestGaps.length}) — tier-1 output failed validation twice`);
        for (const gap of digestGaps) lines.push(`- ${gap.file} — ${gap.reason}`);
    }
    if (state.rejections.length > 0 || Object.keys(validatorStats.blocklistCounts).length > 0) {
        lines.push(`\n## Validator — ${state.rejections.length} findings rejected`);
        for (const rejection of state.rejections) lines.push(`- ${rejection.file}: ${rejection.reason}`);
        const blocklistEntries = Object.entries(validatorStats.blocklistCounts);
        if (blocklistEntries.length > 0) {
            lines.push(`Blocklist counter (diagnostic, never enforcement): ${blocklistEntries.map(([w, c]) => `${w}×${c}`).join(', ')}`);
        }
    }
    if (incremental?.changedFiles?.length > 0) {
        lines.push(`\n## Incremental — diff vs prior review`);
        lines.push(`Changed: ${incremental.changedFiles.length} files · blast radius (changed + importers): ${incremental.blastRadius.size} files · carried findings: ${incremental.carriedCount}`);
    }
    lines.push(`\n_Accept findings with codereview.accept { findingId } — the acceptance gate runs the paired test: fail on unpatched, pass on patched, or it does not ship._`);
    return lines.join('\n');
}

// ── Entry point ────────────────────────────────────────────────────────────

export function selectDigestTargets(scopedAnalysis, incremental) {
    const targets = new Set();
    if (incremental.blastRadius) {
        for (const rel of incremental.blastRadius) targets.add(rel);
    } else {
        for (const r of scopedAnalysis.ranked.slice(0, 60)) targets.add(r.rel);
    }
    const eligible = new Set(scopedAnalysis.ranked.map((r) => r.rel));
    return [...targets].filter((rel) => eligible.has(rel));
}

export async function runReview({ source, models, budget, scope, gateway, storageRoot, dataDir, emitProgress }) {
    const snapshotsRoot = path.join(dataDir, 'snapshots');
    const reviewsRoot = path.join(dataDir, 'reviews');
    await fsp.mkdir(snapshotsRoot, { recursive: true });
    await fsp.mkdir(reviewsRoot, { recursive: true });

    // Model validation — unknown ids fail loudly, never a silent default (§4.2).
    const available = await gateway.listModels('chat');
    const availableIds = new Set(available.map((m) => m.id));
    for (const [role, model] of Object.entries(models)) {
        if (!availableIds.has(model)) {
            throw new Error(`codereview: ${role} model '${model}' is not a gateway chat model. Known: ${[...availableIds].join(', ')}`);
        }
    }
    const modelPairKey = `${models.grunt}+${models.orchestrator}`;

    emitProgress?.('Materializing snapshot...', 3);
    const snapshotMeta = await (await import('./resolver.js')).materializeSource(source, snapshotsRoot);

    emitProgress?.('Tier-0 deterministic analysis...', 8);
    const analysis = await (await import('./analyzer.js')).analyzeSnapshot(snapshotMeta.snapshotDir);

    // Scope narrowing after analysis (prefixes over snapshot-relative paths).
    let scopedAnalysis = analysis;
    if (scope?.include?.length || scope?.exclude?.length) {
        const inScope = (rel) => {
            const inc = !scope.include?.length || scope.include.some((p) => rel.startsWith(p));
            const exc = scope.exclude?.some((p) => rel.startsWith(p)) ?? false;
            return inc && !exc;
        };
        const scopedFiles = analysis.files.filter((f) => inScope(f.rel));
        const languageCounts = {};
        const analysisModeCounts = { ast: 0, structural: 0, generic: 0 };
        for (const file of scopedFiles) {
            languageCounts[file.language] = (languageCounts[file.language] ?? 0) + 1;
            analysisModeCounts[file.analysisMode]++;
        }
        scopedAnalysis = {
            ...analysis,
            files: scopedFiles,
            ranked: analysis.ranked.filter((r) => inScope(r.rel)),
            hunts: analysis.hunts.filter((h) => inScope(h.file)),
            genericFiles: analysis.genericFiles.filter((f) => inScope(f.rel)),
            languageCounts,
            analysisModeCounts
        };
    }

    const maxRounds = budget?.maxRounds ?? 10;
    const reviewId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const reviewDir = path.join(reviewsRoot, reviewId);
    await fsp.mkdir(reviewDir, { recursive: true });

    emitProgress?.('Hashing snapshot files...', 12);
    // Hashed ONCE here and reused by both the incremental diff and analysis.json —
    // hashing per consumer doubled disk reads and SHA-256 work per review.
    const fileHashes = {};
    for (const f of scopedAnalysis.files) {
        fileHashes[f.rel] = await sha256File(path.join(snapshotMeta.snapshotDir, ...f.rel.split('/')));
    }

    emitProgress?.('Checking for prior review (incremental)...', 14);
    const priorReview = await store.findLatestReviewForSource(snapshotMeta.sourceLabel, modelPairKey, VALIDATOR_VERSION);
    const incremental = await computeIncremental({ fileHashes, analysis: scopedAnalysis, priorReview, reviewsRoot });
    const carried = incremental.blastRadius
        ? incremental.priorFindings.filter((f) => f.status === 'new' && !incremental.blastRadius.has(f.file))
        : [];

    // Every snapshotted text file is digest/dive eligible. Language-specific
    // tier-0 depth is reported separately; file type never controls model access.
    const digestList = selectDigestTargets(scopedAnalysis, incremental);

    emitProgress?.(`Tier-1 digests (${digestList.length} files)...`, 15);
    const { digests, gaps } = await runDigests(gateway, models.grunt, snapshotMeta.snapshotDir, digestList, scopedAnalysis);

    emitProgress?.('Tier-2 orchestrator loop...', 30);
    const loop = await runOrchestratorLoop({
        gateway,
        orchestratorModel: models.orchestrator,
        storageRoot,
        snapshotDir: snapshotMeta.snapshotDir,
        analysis: scopedAnalysis,
        digests,
        digestGaps: gaps,
        maxRounds,
        priorCarriedFindings: carried
    });
    const state = loop.state;
    let partial = false;
    try {
        await loop.run(reviewDir, emitProgress);
    } catch (err) {
        // The orchestrator is an external boundary. Completed rounds already
        // contain validated findings; failure must become a visible partial
        // result, not destroy the report (issue #77).
        partial = true;
        const message = String(err.message ?? err).slice(0, 2000);
        state.interruption = { stage: 'orchestrator', round: state.round, message };
        state.stopReason = `orchestrator interrupted: ${message}`;
        state.summary ??= '';
        await loop.persist(reviewDir);
        logger.error(`[codereview] review ${reviewId} interrupted after ${state.completedRounds} completed round(s): ${message}; returning ${state.findings.length} persisted finding(s) as PARTIAL`, null, 'CodeReview');
    }

    // Persist analysis for the next incremental run (per-file hashes + graph).
    await fsp.writeFile(path.join(reviewDir, 'analysis.json'), JSON.stringify({
        treeHash: snapshotMeta.treeHash,
        fileHashes,
        graphEdges: scopedAnalysis.graph.edges
    }, null, 2));

    // Persist findings.
    const analysisSet = new Set(scopedAnalysis.files.map((f) => f.rel));
    const savedIds = [];
    for (const finding of state.findings) {
        const fingerprint = findingFingerprint(finding);
        const { id } = await store.saveFinding({
            reviewId,
            sourceLabel: snapshotMeta.sourceLabel,
            snapshotHash: snapshotMeta.treeHash,
            fingerprint,
            file: finding.file,
            lines: finding.lines,
            evidence: finding.evidence,
            failure_mode: finding.failure_mode,
            class: finding.class,
            suggestion: finding.suggestion,
            rung: finding.rung ?? null,
            test_spec: finding.test_spec,
            modelPair: modelPairKey
        });
        savedIds.push(id);
    }

    // Validator stats for the report.
    const blocklistCounts = countBlocklist([
        ...state.findings.flatMap((f) => [f.suggestion, f.failure_mode]),
        ...[...digests.values()].flatMap((d) => [d.role, ...(d.risks ?? [])])
    ]);

    const totalJs = scopedAnalysis.ranked.filter((r) => r.analysisMode === 'ast').length;
    const totalRust = scopedAnalysis.ranked.filter((r) => r.analysisMode === 'structural').length;
    const totalGeneric = scopedAnalysis.ranked.filter((r) => r.analysisMode === 'generic').length;
    const divedSet = new Set(state.dived);
    const unreviewed = scopedAnalysis.ranked.filter((r) => !divedSet.has(r.rel)).map((r) => r.rel);
    const coverage = {
        divedCount: state.dived.length,
        carriedCount: carried.length,
        totalFiles: scopedAnalysis.files.length,
        totalJs,
        totalRust,
        totalGeneric,
        genericFiles: scopedAnalysis.genericFiles,
        unreviewed
    };

    const report = renderReport({
        reviewId,
        snapshotMeta,
        modelPair: models,
        state,
        analysis: scopedAnalysis,
        coverage,
        exclusions: snapshotMeta.exclusions,
        digestGaps: gaps,
        validatorStats: { blocklistCounts },
        incremental: incremental.changedFiles ? { changedFiles: incremental.changedFiles, blastRadius: incremental.blastRadius, carriedCount: carried.length } : null
    });
    await fsp.writeFile(path.join(reviewDir, 'report.md'), report);
    await fsp.writeFile(path.join(reviewDir, 'finding-ids.json'), JSON.stringify({ reviewId, findingIds: savedIds }, null, 2));

    await store.saveReview({
        reviewId,
        sourceLabel: snapshotMeta.sourceLabel,
        sourceKind: snapshotMeta.sourceKind,
        snapshotHash: snapshotMeta.treeHash,
        modelPair: modelPairKey,
        validatorVersion: VALIDATOR_VERSION,
        status: partial ? 'partial' : 'done',
        rounds: state.completedRounds,
        interruption: state.interruption,
        stopReason: state.stopReason,
        findingCount: state.findings.length,
        rejectionCount: state.rejections.length,
        carriedCount: carried.length
    });

    logger.info(`[codereview] review ${reviewId} done: ${state.findings.length} findings, ${state.rejections.length} rejected, ${carried.length} carried`, null, 'CodeReview');
    return { reviewId, report, state, coverage, partial };
}
