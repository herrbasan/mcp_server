// Review pipeline — direct parallel target review (spec §0 / §4).
// Tier-0 ranks targets deterministically; selected targets are reviewed once
// in parallel, isolated calls with 1-hop dependency context and Tier-0 hunts.
// Zero upfront digest pass, zero sequential multi-round context replay, hard
// file/time/token budgets, and a per-call telemetry ledger.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getLogger } from '../../utils/logger.js';
import { computeBlastRadiusWithDeletions } from './analyzer.js';
import {
    VALIDATOR_VERSION, validateFinding, countBlocklist, findingFingerprint
} from './validator.js';
import * as store from './store.js';

const logger = getLogger();

const DEFAULT_MAX_FILES = 12;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_DURATION_MS = 240_000;
const DEFAULT_MAX_TOKENS = 400_000;
const DEFAULT_PER_FILE_TIMEOUT_MS = 120_000;
const MAX_SOURCE_CHARS = 100_000;

// ── Model call helpers ─────────────────────────────────────────────────────

export function extractJson(text) {
    if (typeof text === 'object' && text !== null) return text;
    const raw = String(text ?? '');
    let start = raw.indexOf('{');
    if (start === -1) throw new Error('no JSON object in model output');
    let lastErr = null;
    while (start !== -1) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        let close = -1;
        for (let i = start; i < raw.length; i++) {
            const ch = raw[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) { close = i; break; }
            }
        }
        if (close === -1) {
            try {
                return JSON.parse(raw.slice(start));
            } catch (err) {
                throw lastErr ?? err;
            }
        }
        try {
            return JSON.parse(raw.slice(start, close + 1));
        } catch (err) {
            lastErr = err;
            start = raw.indexOf('{', start + 1);
        }
    }
    throw lastErr ?? new Error('no JSON object in model output');
}

function addUsage(acc, usage) {
    if (!usage || typeof usage !== 'object') return;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    const total = Number(usage.total_tokens ?? (prompt + completion));
    if (Number.isFinite(prompt)) acc.promptTokens += prompt;
    if (Number.isFinite(completion)) acc.completionTokens += completion;
    if (Number.isFinite(total)) acc.totalTokens += total;
    if (typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
        acc.cost = (acc.cost ?? 0) + usage.cost;
    }
}

async function callJson(gateway, model, systemPrompt, userPrompt, { maxTokens = 16000, timeoutMs = DEFAULT_PER_FILE_TIMEOUT_MS, schema = null } = {}) {
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
    if (response.finish_reason === 'length' && !response.content) {
        const err = new Error(`model hit maxTokens (${maxTokens}) before emitting JSON (finish_reason=length)`);
        err.usage = response.usage ?? null;
        throw err;
    }
    try {
        return { parsed: extractJson(response.content), usage: response.usage ?? null };
    } catch (err) {
        err.usage = response.usage ?? null;
        throw err;
    }
}

function isConnectionError(err) {
    const message = String(err?.message ?? '');
    if (/^Gateway connection failed/.test(message)) return true;
    if (/timed out after \d+ms|Gateway chat aborted/.test(message)) return true;
    if (err instanceof TypeError && err.message === 'fetch failed') return true;
    return false;
}

async function callJsonWithRetry(gateway, model, systemPrompt, userPrompt, opts) {
    const usageTotal = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: null };
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await callJson(gateway, model, systemPrompt, userPrompt, opts);
            addUsage(usageTotal, res.usage);
            return { parsed: res.parsed, usage: usageTotal };
        } catch (err) {
            addUsage(usageTotal, err.usage);
            if (isConnectionError(err) && attempt < 2) {
                logger.warn(`[codereview] gateway connection died (attempt ${attempt + 1}/3, ${err.cause?.message ?? 'no cause'}); retrying same prompt`, null, 'CodeReview');
                await new Promise((r) => setTimeout(r, 1500));
                continue;
            }
            if (!isConnectionError(err)) {
                const retryPrompt = `${userPrompt}\n\n--- Your previous reply was not valid JSON for the schema: ${err.message}\nReply again with ONLY the JSON object. ---`;
                logger.warn(`[codereview] model ${model} returned malformed JSON (${err.message}); retrying once with error attached`, null, 'CodeReview');
                try {
                    const retryRes = await callJson(gateway, model, systemPrompt, retryPrompt, opts);
                    addUsage(usageTotal, retryRes.usage);
                    return { parsed: retryRes.parsed, usage: usageTotal };
                } catch (retryErr) {
                    addUsage(usageTotal, retryErr.usage);
                    retryErr.usageTotal = usageTotal;
                    throw retryErr;
                }
            }
            err.usageTotal = usageTotal;
            throw err;
        }
    }
    const exhausted = new Error(`codereview: gateway connection failed 3× for model ${model} — gateway unreachable from this process`);
    exhausted.usageTotal = usageTotal;
    throw exhausted;
}

// ── System prompt & schema ─────────────────────────────────────────────────

function loadPrinciples(storageRoot) {
    const primePath = path.resolve(storageRoot, 'documentation', 'Workshop', 'Agents_Prime.md');
    const content = fs.readFileSync(primePath, 'utf8');
    const start = content.indexOf('## Principles');
    if (start === -1) throw new Error('codereview: no ## Principles section in Agents_Prime.md');
    const end = content.indexOf('\n## ', start + 1);
    return (end === -1 ? content.slice(start) : content.slice(start, end)).trim();
}

const FILE_REVIEW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        findings: { type: 'array', maxItems: 5, items: { type: 'object' } },
        note: { type: 'string' }
    },
    required: ['findings', 'note']
};

const FILE_REVIEW_BRIEF = `
You are reviewing ONE source file under the Prime Directive maxims.

Goal: the most reliability at the lowest performance cost. Anti-goals: defensive-programming bloat, error-reporting ritual, clean-code conventions. The aim is architectures that cannot fail; if code CAN fail, change it so it cannot — do not add defensive handling.

BOUNDARY LADDER — every external dependency is judged on three rungs, in order:
1. ELIMINATE: why does this dependency exist at all? Local copy, precomputed data, in-process call.
2. SHRINK BLAST RADIUS: failure as data (Result-style return), not control-flow hijack. Consequence classes: corrupts-state/wrong-answer > feature-degrades > cosmetic.
3. TOLERATE VISIBLY: only what survives 1-2 earns a handler, and it must leave a trace.
Throwing guards (fail-fast assertions) are ALWAYS legal. Degrading guards (fallback defaults, swallowed catches) require documented ladder analysis ("rung").

FINDING SCHEMA (exact, max 5 high-signal findings; empty array when nothing real):
{
  "file": "<the exact relative file path given>",
  "lines": [startLine, endLine],
  "evidence": "verbatim quote from the file — MUST match cited lines character-for-character; NEVER include the '<num> | ' line-number prefix",
  "failure_mode": "concrete bug or failure mode — what breaks, when, in production shape",
  "class": "free-win" | "trade-off",
  "suggestion": "the concrete fix (include a diff-style code block when helpful). free-win = reliability AND performance. trade-off = genuine either/or.",
  "rung": null | { "dependency": "...", "rejected_elimination": "why rung 1 fails", "consequence_before": "...", "consequence_after": "..." },
  "test_spec": { "bug": "concrete bug proved", "data_source": "production-replay" | "recorded-fixture" | "calibrated-generated", "shape": "load shape (concurrency, volume, skew — never placeholder foo/bar)", "runtime": true|false }
}

RULES:
- Judge every Tier-0 hunt candidate listed for this file; emit only real findings.
- Never suggest adding try/catch, null guards, or fallback defaults unless boundary validation cannot eliminate the input AND you document "rung".
- Prefer deleting defensive code over adding handling.
- "lines" are 1-based integers matching the numbered source. "evidence" MUST NOT contain the "<num> | " prefix.
- Reply with ONLY the JSON object. No markdown fences, no commentary before or after.
`;

// ── Per-target prompt builder ──────────────────────────────────────────────

function formatNumberedSource(source) {
    let body = source;
    let truncatedNote = '';
    const totalLines = source.split('\n').length;
    if (body.length > MAX_SOURCE_CHARS) {
        const cut = body.lastIndexOf('\n', MAX_SOURCE_CHARS);
        const end = cut > 0 ? cut : MAX_SOURCE_CHARS;
        const shownLines = body.slice(0, end).split('\n').length;
        body = body.slice(0, end);
        truncatedNote = `\n// [truncated at line ${shownLines} of ${totalLines} for context budget]`;
    }
    const numbered = body.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
    return `${numbered}${truncatedNote}`;
}

function buildFilePrompt(target, analysis, snapshotDir) {
    const abs = path.join(snapshotDir, ...target.rel.split('/'));
    const source = fs.readFileSync(abs, 'utf8');
    const importers = (analysis.graph.reverse[target.rel] ?? []).slice(0, 15);
    const imports = (analysis.graph.edges[target.rel] ?? []).slice(0, 15);
    const unresolved = analysis.graph.unresolved.filter((e) => e.from === target.rel).slice(0, 10);
    const hunts = analysis.hunts.filter((h) => h.file === target.rel);

    const parts = [];
    parts.push(`FILE: ${target.rel}`);
    parts.push(`TYPE: ${target.language}/${target.analysisMode} · ${target.lines} lines · score ${target.score.toFixed(1)} · boundaries: ${target.boundaries.join(', ') || 'none'}`);
    parts.push(`1-HOP CONTEXT:`);
    parts.push(`- Imported by (${importers.length}): ${importers.join(', ') || 'none'}`);
    parts.push(`- Imports (${imports.length}): ${imports.join(', ') || 'none'}`);
    if (unresolved.length > 0) {
        parts.push(`- Unresolved edges: ${unresolved.map((u) => `${u.specifier} (${u.kind})`).join(', ')}`);
    }
    if (hunts.length > 0) {
        parts.push(`\nTIER-0 HUNT CANDIDATES (${hunts.length} — verify each against the rubric):`);
        for (const h of hunts) parts.push(`- line ${h.line} [${h.kind}] ${h.snippet}`);
    } else {
        parts.push(`\nTIER-0 HUNT CANDIDATES: none`);
    }
    parts.push(`\nRAW SOURCE (do NOT copy the "<line> | " prefix into "evidence"):\n\`\`\`\n${formatNumberedSource(source)}\n\`\`\``);
    return parts.join('\n');
}

// ── Parallel isolated target review ────────────────────────────────────────

async function runParallelTargets({ gateway, model, storageRoot, snapshotDir, analysis, targets, budget }) {
    const startedAt = Date.now();
    const principles = loadPrinciples(storageRoot);
    const systemPrompt = `${principles}\n${FILE_REVIEW_BRIEF}`;
    const analysisSet = new Set(analysis.ranked.map((r) => r.rel));
    const scoreByFile = new Map(analysis.ranked.map((r) => [r.rel, r.score]));

    const state = {
        targetsSelected: targets.length,
        reviewedFiles: [],
        failedTargets: [],
        skippedTargets: [],
        findings: [],
        rejections: [],
        notes: [],
        ledger: [],
        totals: { elapsedMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: null },
        stopReason: null
    };

    const seenFingerprints = new Set();
    let nextIndex = 0;
    let budgetStopReason = null;

    const checkBudget = () => {
        if (budgetStopReason) return budgetStopReason;
        if (Date.now() - startedAt >= budget.maxDurationMs) {
            budgetStopReason = `wall-clock budget exhausted (${budget.maxDurationMs}ms)`;
        } else if (state.totals.totalTokens >= budget.maxTokens) {
            budgetStopReason = `token budget exhausted (${state.totals.totalTokens}/${budget.maxTokens})`;
        }
        return budgetStopReason;
    };

    return {
        state,
        async run(reviewDir, emitProgress) {
            let persistChain = Promise.resolve();
            const persist = () => {
                const payload = {
                    model,
                    budget,
                    targetsSelected: state.targetsSelected,
                    reviewedFiles: state.reviewedFiles,
                    failedTargets: state.failedTargets,
                    skippedTargets: state.skippedTargets,
                    findings: state.findings,
                    rejections: state.rejections,
                    ledger: state.ledger,
                    totals: { ...state.totals, elapsedMs: Date.now() - startedAt },
                    stopReason: state.stopReason
                };
                persistChain = persistChain.then(() =>
                    fsp.writeFile(path.join(reviewDir, 'state.json'), JSON.stringify(payload, null, 2))
                );
                return persistChain;
            };

            const worker = async () => {
                while (true) {
                    const reason = checkBudget();
                    const idx = nextIndex++;
                    if (idx >= targets.length) break;
                    const target = targets[idx];

                    if (reason) {
                        state.skippedTargets.push({ file: target.rel, reason });
                        state.ledger.push({
                            file: target.rel,
                            score: target.score,
                            status: 'skipped-budget',
                            elapsedMs: 0,
                            promptTokens: 0,
                            completionTokens: 0,
                            totalTokens: 0,
                            cost: null,
                            findingsAccepted: 0,
                            findingsRejected: 0,
                            error: reason
                        });
                        await persist();
                        continue;
                    }

                    const fileStart = Date.now();
                    emitProgress?.(`Reviewing ${target.rel} (${idx + 1}/${targets.length})...`, Math.min(18 + Math.round(((idx + 1) / Math.max(targets.length, 1)) * 70), 90));
                    try {
                        const userPrompt = buildFilePrompt(target, analysis, snapshotDir);
                        const { parsed, usage } = await callJsonWithRetry(gateway, model, systemPrompt, userPrompt, {
                            maxTokens: 16000,
                            timeoutMs: budget.perFileTimeoutMs,
                            schema: FILE_REVIEW_SCHEMA
                        });
                        const elapsedMs = Date.now() - fileStart;
                        state.totals.promptTokens += usage.promptTokens;
                        state.totals.completionTokens += usage.completionTokens;
                        state.totals.totalTokens += usage.totalTokens;
                        if (usage.cost != null) {
                            state.totals.cost = (state.totals.cost ?? 0) + usage.cost;
                        }

                        let accepted = 0;
                        let rejected = 0;
                        const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
                        for (const raw of rawFindings) {
                            // Anchor file to the exact target we sent if omitted, never letting a
                            // file-scoped review cite an unrelated path.
                            const finding = raw && typeof raw === 'object' ? { ...raw, file: raw.file || target.rel } : raw;
                            if (finding && typeof finding === 'object' && finding.file !== target.rel) {
                                state.rejections.push({ file: target.rel, reason: `finding cited '${finding.file}' instead of target '${target.rel}'` });
                                rejected++;
                                continue;
                            }
                            const check = await validateFinding(finding, snapshotDir, analysisSet);
                            if (check.ok) {
                                const fp = findingFingerprint(finding);
                                if (!seenFingerprints.has(fp)) {
                                    seenFingerprints.add(fp);
                                    state.findings.push(finding);
                                    accepted++;
                                }
                            } else {
                                state.rejections.push({ file: finding?.file ?? target.rel, reason: check.reason });
                                rejected++;
                            }
                        }
                        if (typeof parsed.note === 'string' && parsed.note.trim()) {
                            state.notes.push({ file: target.rel, note: parsed.note.trim() });
                        }
                        state.reviewedFiles.push(target.rel);
                        state.ledger.push({
                            file: target.rel,
                            score: target.score,
                            status: 'done',
                            elapsedMs,
                            promptTokens: usage.promptTokens,
                            completionTokens: usage.completionTokens,
                            totalTokens: usage.totalTokens,
                            cost: usage.cost,
                            findingsAccepted: accepted,
                            findingsRejected: rejected,
                            error: null
                        });
                    } catch (err) {
                        const elapsedMs = Date.now() - fileStart;
                        const usage = err.usageTotal ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: null };
                        state.totals.promptTokens += usage.promptTokens;
                        state.totals.completionTokens += usage.completionTokens;
                        state.totals.totalTokens += usage.totalTokens;
                        if (usage.cost != null) {
                            state.totals.cost = (state.totals.cost ?? 0) + usage.cost;
                        }
                        const message = String(err?.message ?? err).slice(0, 1000);
                        logger.warn(`[codereview] target ${target.rel} failed: ${message}`, null, 'CodeReview');
                        state.failedTargets.push({ file: target.rel, reason: message });
                        state.ledger.push({
                            file: target.rel,
                            score: target.score,
                            status: 'failed',
                            elapsedMs,
                            promptTokens: usage.promptTokens,
                            completionTokens: usage.completionTokens,
                            totalTokens: usage.totalTokens,
                            cost: usage.cost,
                            findingsAccepted: 0,
                            findingsRejected: 0,
                            error: message
                        });
                    }
                    await persist();
                }
            };

            const workers = Array.from({ length: Math.min(budget.concurrency, Math.max(targets.length, 1)) }, worker);
            await Promise.all(workers);

            state.totals.elapsedMs = Date.now() - startedAt;
            state.findings.sort((a, b) => {
                if (a.class !== b.class) return a.class === 'free-win' ? -1 : 1;
                const scoreDiff = (scoreByFile.get(b.file) ?? 0) - (scoreByFile.get(a.file) ?? 0);
                if (scoreDiff !== 0) return scoreDiff;
                return (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0);
            });
            state.stopReason = targets.length === 0
                ? 'no targets to review (unchanged tree or empty scope)'
                : budgetStopReason ?? (state.failedTargets.length > 0 ? `${state.failedTargets.length} target(s) failed` : 'all selected targets reviewed');
            await persist();
            return state;
        }
    };
}

// ── Incremental review ─────────────────────────────────────────────────────

async function sha256File(abs) {
    const buf = await fsp.readFile(abs);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

async function computeIncremental({ fileHashes, analysis, priorReview, reviewsRoot }) {
    if (!priorReview) return { changedFiles: null, blastRadius: null, priorFindings: [] };
    const priorDirId = priorReview.reviewId ?? priorReview._id;
    const priorAnalysisPath = path.join(reviewsRoot, priorDirId, 'analysis.json');
    if (!fs.existsSync(priorAnalysisPath)) {
        logger.warn(`[codereview] prior review ${priorDirId} has no analysis.json; falling back to cold target selection`, null, 'CodeReview');
        return { changedFiles: null, blastRadius: null, priorFindings: [] };
    }
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
        return { changedFiles: [], blastRadius: new Set(), priorFindings: await store.listFindings({ reviewId: priorDirId }) };
    }

    // Blast radius from the CURRENT graph covers modified files. Deleted files
    // are different: the new snapshot's graph cannot contain edges to a file
    // that no longer exists, so their importers are only recorded in the PRIOR
    // graph — traversing it is the only way deletion invalidates them.
    const blast = computeBlastRadiusWithDeletions(analysis, changed, deleted, priorAnalysis.graphEdges);
    const priorFindings = await store.listFindings({ reviewId: priorDirId });
    return { changedFiles: [...changed, ...deleted.map((d) => `${d} (deleted)`)], blastRadius: blast, priorFindings };
}

// ── Report rendering ───────────────────────────────────────────────────────

function formatCost(cost) {
    if (typeof cost !== 'number' || !Number.isFinite(cost)) return 'n/a';
    return `$${cost.toFixed(4)}`;
}

export function renderReport({ reviewId, snapshotMeta, model, state, analysis, coverage, exclusions, validatorStats, incremental }) {
    const partial = state.failedTargets.length > 0 || state.skippedTargets.length > 0;
    const elapsedSec = (state.totals.elapsedMs / 1000).toFixed(1);
    const lines = [];
    lines.push(`# Code review — ${snapshotMeta.sourceLabel}${partial ? ' — PARTIAL' : ''}`);
    lines.push(`review: ${reviewId} · tree: ${snapshotMeta.treeHash.slice(0, 16)} · model: ${model} · targets: ${state.reviewedFiles.length}/${state.targetsSelected} completed · elapsed: ${elapsedSec}s · tokens: ${state.totals.totalTokens} · cost: ${formatCost(state.totals.cost)} (${state.stopReason})`);

    if (partial) {
        const failedPart = state.failedTargets.length > 0 ? `${state.failedTargets.length} failed` : null;
        const skippedPart = state.skippedTargets.length > 0 ? `${state.skippedTargets.length} skipped (budget)` : null;
        const details = [...state.failedTargets, ...state.skippedTargets].slice(0, 10).map((t) => `${t.file} (${t.reason})`).join('; ');
        lines.push(`\n> **PARTIAL REVIEW — ${[failedPart, skippedPart].filter(Boolean).join(', ')}.** ${details}\n> Completed findings below were validated and persisted; incomplete targets mean this is not a finished baseline.`);
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
        lines.push('\n_No verified findings. Rejected candidates or telemetry below may explain why._');
    }

    if (state.ledger.length > 0) {
        lines.push(`\n## Telemetry & cost`);
        lines.push(`Total: ${elapsedSec}s wall clock · ${state.totals.promptTokens} input + ${state.totals.completionTokens} output = ${state.totals.totalTokens} tokens · cost: ${formatCost(state.totals.cost)}`);
        for (const row of state.ledger) {
            const ms = `${(row.elapsedMs / 1000).toFixed(1)}s`;
            lines.push(`- ${row.file} [${row.status}] ${ms} · ${row.totalTokens} tok (${formatCost(row.cost)}) · +${row.findingsAccepted}/-${row.findingsRejected}${row.error ? ` · ${row.error}` : ''}`);
        }
    }

    lines.push(`\n## Coverage — never silent`);
    lines.push(`Reviewed: ${coverage.reviewedCount} targets + ${coverage.carriedCount} carried from prior review · tree: ${coverage.totalFiles} text files (${coverage.totalJs} js, ${coverage.totalRust} rust, ${coverage.totalGeneric} generic)`);
    lines.push(`Language-specific tier-0: JavaScript (AST) + Rust (structural). Every other text file—including configuration and documentation—remains model-review eligible with generic boundary analysis; language never controls eligibility.`);
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

// ── Target selection & budget ──────────────────────────────────────────────

export function resolveBudget(budget = {}) {
    if (budget != null && typeof budget !== 'object') {
        throw new Error('codereview: budget must be an object');
    }
    const checkPosInt = (name, value, fallback) => {
        if (value == null) return fallback;
        if (!Number.isInteger(value) || value <= 0) {
            throw new Error(`codereview: budget.${name} must be a positive integer (got ${value})`);
        }
        return value;
    };
    return {
        maxFiles: checkPosInt('maxFiles', budget.maxFiles, DEFAULT_MAX_FILES),
        concurrency: Math.min(checkPosInt('concurrency', budget.concurrency, DEFAULT_CONCURRENCY), 8),
        maxDurationMs: checkPosInt('maxDurationMs', budget.maxDurationMs, DEFAULT_MAX_DURATION_MS),
        maxTokens: checkPosInt('maxTokens', budget.maxTokens, DEFAULT_MAX_TOKENS),
        perFileTimeoutMs: checkPosInt('perFileTimeoutMs', budget.perFileTimeoutMs, DEFAULT_PER_FILE_TIMEOUT_MS)
    };
}

export function selectReviewTargets(scopedAnalysis, incremental, maxFiles = DEFAULT_MAX_FILES) {
    if (incremental.blastRadius) {
        if (incremental.blastRadius.size === 0) return [];
        return scopedAnalysis.ranked.filter((r) => incremental.blastRadius.has(r.rel)).slice(0, maxFiles);
    }
    return scopedAnalysis.ranked.slice(0, maxFiles);
}

// ── Entry point ────────────────────────────────────────────────────────────

export async function runReview({ source, model, budget: rawBudget, scope, gateway, storageRoot, dataDir, emitProgress }) {
    if (!model || typeof model !== 'string') {
        throw new Error('codereview: model must be a non-empty string');
    }
    const budget = resolveBudget(rawBudget);
    const snapshotsRoot = path.join(dataDir, 'snapshots');
    const reviewsRoot = path.join(dataDir, 'reviews');
    await fsp.mkdir(snapshotsRoot, { recursive: true });
    await fsp.mkdir(reviewsRoot, { recursive: true });

    // Model validation — unknown ids fail loudly, never a silent default (§4.2).
    const available = await gateway.listModels('chat');
    const availableIds = new Set(available.map((m) => m.id));
    if (!availableIds.has(model)) {
        throw new Error(`codereview: model '${model}' is not a gateway chat model. Known: ${[...availableIds].join(', ')}`);
    }

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

    const reviewId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const reviewDir = path.join(reviewsRoot, reviewId);
    await fsp.mkdir(reviewDir, { recursive: true });

    emitProgress?.('Hashing snapshot files...', 12);
    const fileHashes = {};
    for (const f of scopedAnalysis.files) {
        fileHashes[f.rel] = await sha256File(path.join(snapshotMeta.snapshotDir, ...f.rel.split('/')));
    }

    emitProgress?.('Checking for prior review (incremental)...', 14);
    const priorReview = await store.findLatestReviewForSource(snapshotMeta.sourceLabel, model, VALIDATOR_VERSION);
    const incremental = await computeIncremental({ fileHashes, analysis: scopedAnalysis, priorReview, reviewsRoot });
    const carried = incremental.blastRadius
        ? incremental.priorFindings.filter((f) => f.status === 'new' && !incremental.blastRadius.has(f.file))
        : [];

    const targets = selectReviewTargets(scopedAnalysis, incremental, budget.maxFiles);
    emitProgress?.(`Reviewing ${targets.length} target(s) in parallel (concurrency ${budget.concurrency})...`, 16);

    const runner = await runParallelTargets({
        gateway,
        model,
        storageRoot,
        snapshotDir: snapshotMeta.snapshotDir,
        analysis: scopedAnalysis,
        targets,
        budget
    });
    const state = await runner.run(reviewDir, emitProgress);
    const partial = state.failedTargets.length > 0 || state.skippedTargets.length > 0;

    // Persist analysis for the next incremental run (per-file hashes + graph).
    await fsp.writeFile(path.join(reviewDir, 'analysis.json'), JSON.stringify({
        treeHash: snapshotMeta.treeHash,
        fileHashes,
        graphEdges: scopedAnalysis.graph.edges
    }, null, 2));

    // Persist findings.
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
            modelPair: model
        });
        savedIds.push(id);
    }

    const blocklistCounts = countBlocklist([
        ...state.findings.flatMap((f) => [f.suggestion, f.failure_mode]),
        ...state.notes.map((n) => n.note)
    ]);

    const totalJs = scopedAnalysis.ranked.filter((r) => r.analysisMode === 'ast').length;
    const totalRust = scopedAnalysis.ranked.filter((r) => r.analysisMode === 'structural').length;
    const totalGeneric = scopedAnalysis.ranked.filter((r) => r.analysisMode === 'generic').length;
    const reviewedSet = new Set(state.reviewedFiles);
    const unreviewed = scopedAnalysis.ranked.filter((r) => !reviewedSet.has(r.rel)).map((r) => r.rel);
    const coverage = {
        reviewedCount: state.reviewedFiles.length,
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
        model,
        state,
        analysis: scopedAnalysis,
        coverage,
        exclusions: snapshotMeta.exclusions,
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
        modelPair: model,
        validatorVersion: VALIDATOR_VERSION,
        status: partial ? 'partial' : 'done',
        targetsSelected: state.targetsSelected,
        targetsCompleted: state.reviewedFiles.length,
        targetsFailed: state.failedTargets.length,
        targetsSkipped: state.skippedTargets.length,
        elapsedMs: state.totals.elapsedMs,
        totalTokens: state.totals.totalTokens,
        cost: state.totals.cost,
        stopReason: state.stopReason,
        findingCount: state.findings.length,
        rejectionCount: state.rejections.length,
        carriedCount: carried.length
    });

    logger.info(`[codereview] review ${reviewId} done in ${(state.totals.elapsedMs / 1000).toFixed(1)}s: ${state.reviewedFiles.length}/${state.targetsSelected} targets, ${state.findings.length} findings, ${state.rejections.length} rejected, ${state.totals.totalTokens} tokens`, null, 'CodeReview');
    return { reviewId, report, state, coverage, partial };
}
