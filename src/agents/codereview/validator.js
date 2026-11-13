// Bias containment — the deterministic validator (spec §3.2).
//
// Every model output crosses this gate before it can become a finding. The
// gate checks FORM mechanically: evidence exists, sits inside the cited lines,
// degrading guards carry ladder documentation, test specs name real data.
// It cannot check TRUTH — past this gate, a biased model is back in the loop,
// and the spec says so plainly. The validator is a floor, not a judge.

import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export const VALIDATOR_VERSION = 'codereview-validator-1';

const DATA_SOURCES = new Set(['production-replay', 'recorded-fixture', 'calibrated-generated']);
const PLACEHOLDER_RE = /\b(foo|bar|baz|asdf|hello world|test123|lorem ipsum|example data|dummy)\b/i;
const BLOCKLIST = ['best practice', 'defensive programming', 'for safety', 'consider adding', 'clean code', 'defensively'];

/** CRLF→LF, strip trailing whitespace per line, trim ends. */
export function normalizeEvidence(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/g, ''))
        .join('\n')
        .trim();
}

/**
 * Vocabulary counter — diagnostic signal ONLY, never a rejection reason
 * ("removes defensive fallback" is a legitimate finding phrase).
 */
export function countBlocklist(texts) {
    const counts = {};
    for (const text of texts) {
        const lower = String(text ?? '').toLowerCase();
        for (const word of BLOCKLIST) {
            const matches = lower.split(word).length - 1;
            if (matches > 0) counts[word] = (counts[word] ?? 0) + matches;
        }
    }
    return counts;
}

/**
 * Scan ADDED lines of a diff for guard constructs. Classifies branch action:
 * throwing (fail-fast assertion — prescribed, always legal) vs degrading
 * (returns/assigns a default and continues — needs the ladder). A "delete
 * this catch" diff must not trip the scan: only '+' lines are examined.
 *
 * `||`/`??` only count as degradation in VALUE position — an assignment,
 * return, or argument default. The same operators inside an `if`/`while`
 * condition or a comparison chain are boolean logic, not fallback defaults;
 * flagging them rejected fail-fast guards like `if (x === -1 || y <= z) throw`.
 */
export function scanAddedLinesForGuards(diffText) {
    const lines = String(diffText ?? '').split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    const throwing = [];
    const degrading = [];
    let inCatchBlock = false;
    for (const raw of added) {
        const line = raw.slice(1);
        if (/\bcatch\b\s*\(/.test(line) || /\bcatch\b\s*\{/.test(line)) inCatchBlock = true;
        if (/\bthrow\b|\bprocess\.exit\b|\.abort\(/.test(line)) {
            throwing.push(line.trim());
            inCatchBlock = false;
        }
        const isCondition = /\b(if|while|assert)\s*\(/.test(line) || /===|!==/.test(line);
        const valueDefault = !isCondition && (
            /[=,(\[]\s*[^;]*\?\?/.test(line) ||
            /\breturn\s+[^;]*\?\?/.test(line) ||
            // `||` only counts when it plants a literal default (`x || 'fallback'`).
            // `err.message || err` is normalization between identifiers, and `||`
            // inside an if/comparison is boolean logic — neither masks config.
            /\|\|\s*(['"][^'"]*['"]|\d+(?:\.\d+)?|true|false|null)\s*[;,)]?\s*$/.test(line.trim())
        );
        if (valueDefault) degrading.push(line.trim());
        if (inCatchBlock && /\breturn\b|^\s*\w+\s*=/.test(line)) {
            degrading.push(line.trim());
            inCatchBlock = false;
        }
        if (/\}/.test(line)) inCatchBlock = false;
    }
    return { throwing, degrading };
}

/**
 * Validate a test spec: must name the bug, a real data source from the
 * hierarchy, and a load shape. Placeholder data fails — synthetic uniform
 * data hides exactly the skew being hunted.
 */
export function validateTestSpec(testSpec) {
    if (!testSpec || typeof testSpec !== 'object') return { ok: false, reason: 'test_spec missing' };
    if (!testSpec.bug || typeof testSpec.bug !== 'string' || testSpec.bug.trim().length < 8) {
        return { ok: false, reason: 'test_spec.bug must name the concrete bug it proves (speculation otherwise)' };
    }
    if (!DATA_SOURCES.has(testSpec.data_source)) {
        return { ok: false, reason: `test_spec.data_source must be one of [${[...DATA_SOURCES].join(', ')}]` };
    }
    if (!testSpec.shape || typeof testSpec.shape !== 'string' || testSpec.shape.trim().length < 8) {
        return { ok: false, reason: 'test_spec.shape must describe the load shape (a number tests nothing)' };
    }
    const scanned = `${testSpec.shape} ${testSpec.notes ?? ''}`;
    if (PLACEHOLDER_RE.test(scanned)) {
        return { ok: false, reason: `test spec names placeholder data (${PLACEHOLDER_RE.exec(scanned)?.[0]}) — real shape or nothing` };
    }
    return { ok: true };
}

function validateRung(rung) {
    if (rung == null) return { ok: true, present: false };
    if (typeof rung !== 'object') return { ok: false, reason: 'rung must be an object' };
    const fields = ['dependency', 'rejected_elimination', 'consequence_before', 'consequence_after'];
    for (const field of fields) {
        if (!rung[field] || typeof rung[field] !== 'string' || rung[field].trim().length < 4) {
            return { ok: false, reason: `rung.${field} missing or empty — ladder documentation is the license for a handler (boilerplate fields are the ritual this rule exists to prevent)` };
        }
    }
    return { ok: true, present: true };
}

function extractCodeBlocks(suggestion) {
    const blocks = [];
    const fences = /```[a-zA-Z]*\n([\s\S]*?)```/g;
    let match;
    while ((match = fences.exec(String(suggestion ?? ''))) !== null) {
        blocks.push(match[1]);
    }
    return blocks;
}

/**
 * Validate one finding against the snapshot on disk.
 * Returns { ok: true } or { ok: false, reason } — rejections are counted and
 * reported; they are the per-model-pair smuggling signal.
 */
export async function validateFinding(finding, snapshotDir, analysisFileSet) {
    if (!finding || typeof finding !== 'object') return { ok: false, reason: 'finding is not an object' };
    const { file, lines, evidence, failure_mode, class: findingClass, suggestion, test_spec, rung } = finding;

    if (!file || typeof file !== 'string') return { ok: false, reason: 'file missing' };
    if (!Array.isArray(lines) || lines.length !== 2 || !Number.isInteger(lines[0]) || !Number.isInteger(lines[1]) || lines[0] < 1 || lines[1] < lines[0]) {
        return { ok: false, reason: 'lines must be [start, end] with 1 ≤ start ≤ end' };
    }
    if (path.win32.isAbsolute(file) || file.includes('..')) return { ok: false, reason: `file must be snapshot-relative, got '${file}'` };
    if (!analysisFileSet.has(file)) return { ok: false, reason: `file '${file}' is not in the analyzed snapshot` };
    if (!evidence || typeof evidence !== 'string' || evidence.length > 2000) return { ok: false, reason: 'evidence missing or over 2000 chars' };
    if (!failure_mode || typeof failure_mode !== 'string') return { ok: false, reason: 'failure_mode missing — a finding without a named failure mode is generic advice' };
    if (findingClass !== 'free-win' && findingClass !== 'trade-off') return { ok: false, reason: `class must be 'free-win' or 'trade-off', got '${findingClass}'` };
    if (!suggestion || typeof suggestion !== 'string') return { ok: false, reason: 'suggestion missing' };

    const testSpecCheck = validateTestSpec(test_spec);
    if (!testSpecCheck.ok) return { ok: false, reason: testSpecCheck.reason };

    const rungCheck = validateRung(rung);
    if (!rungCheck.ok) return { ok: false, reason: rungCheck.reason };

    // Guard scan on added lines of any code block in the suggestion.
    for (const block of extractCodeBlocks(suggestion)) {
        const looksLikeDiff = /^[+-]/m.test(block);
        if (!looksLikeDiff) continue;
        const { degrading } = scanAddedLinesForGuards(block);
        if (degrading.length > 0 && !rungCheck.present) {
            return { ok: false, reason: `suggestion adds a degrading guard (${degrading[0].slice(0, 60)}) without ladder documentation — no ladder, no handler` };
        }
    }

    // Evidence: must appear verbatim (normalized) inside the cited line range.
    const abs = path.join(snapshotDir, ...file.split('/'));
    let content;
    try {
        content = await fsp.readFile(abs, 'utf8');
    } catch {
        return { ok: false, reason: `cannot read snapshot file '${file}'` };
    }
    const normalizedFile = normalizeEvidence(content);
    const normalizedEvidence = normalizeEvidence(evidence);
    let index = normalizedFile.indexOf(normalizedEvidence);
    if (index === -1) return { ok: false, reason: 'evidence does not appear verbatim in the snapshot file (normalized comparison) — hallucinated or edited quote' };

    // Line-range check: at least one occurrence must overlap the cited lines.
    const fileLines = normalizedFile.split('\n');
    let overlap = false;
    while (index !== -1 && !overlap) {
        let line = 1;
        for (let i = 0; i < index; i++) {
            if (normalizedFile.charCodeAt(i) === 10) line++;
        }
        const evidenceLineCount = normalizedEvidence.split('\n').length;
        const occStart = line;
        const occEnd = line + evidenceLineCount - 1;
        if (occStart <= lines[1] && occEnd >= lines[0]) overlap = true;
        index = normalizedFile.indexOf(normalizedEvidence, index + 1);
    }
    if (!overlap) return { ok: false, reason: `evidence found in file but outside cited lines [${lines[0]}-${lines[1]}] — cite where it actually is` };

    return { ok: true };
}

/** Finding identity across snapshots: content fingerprint, not line numbers. */
export function findingFingerprint(finding) {
    const basis = `${normalizeEvidence(finding.evidence)}\n${finding.failure_mode.trim().toLowerCase()}`;
    return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24);
}

/** Tier-1 digest shape — free prose is not allowed into the map (spec §3.2). */
export function validateDigest(digest, analyzedFiles) {
    if (!digest || typeof digest !== 'object') return { ok: false, reason: 'digest is not an object' };
    if (!digest.role || typeof digest.role !== 'string' || digest.role.length > 400) return { ok: false, reason: 'digest.role missing or over 400 chars' };
    if (!Array.isArray(digest.risks) || digest.risks.some((r) => typeof r !== 'string' || r.length > 300)) {
        return { ok: false, reason: 'digest.risks must be string[] with each ≤ 300 chars' };
    }
    if (digest.file && !analyzedFiles.has(digest.file)) return { ok: false, reason: `digest.file '${digest.file}' not in analyzed set` };
    return { ok: true };
}
