// Memory refactor — Phase 0: golden retrieval + raw-lane diagnostics.
//
//   node scripts/memory-lab-phase0.mjs --snapshot D:\MCP_Lab\memory-refactor\baseline-2026-11-17 [--skip-integrity]
//
// Measures the THREE production retrieval lanes against a lab snapshot, exactly
// as the running code shapes them, and writes a timestamped JSON report under
// <snapshot>\reports.  It is a DESCRIPTIVE baseline: no pass/fail threshold is
// invented anywhere.
//
// Lane fidelity (do not "fix" these — they are the object of measurement):
//   memory  src/agents/memory/index.js   lexical tokens, AND textSearch, 6/4 retries,
//                                        cap 50, mem_ only; semantic `topK: max(limit*5,25)`;
//                                        hybrid boost 0.10 / lexical base 0.45 / confidence weight.
//   storage src/agents/vdb/index.js      `topK: max(top_k*3,30)`, cosine, approximate:false,
//                                        min-max normalize, dedup id + contentHash#splitIdx,
//                                        max 3 chunks per path, slice top_k.
//   chat    D:\SRV\LLM-Gateway-Chat\server\internal-tools.js searchArchive
//                                        conversation flat index with role filter, semantic via
//                                        production's `top_k: limit*3` (a spelling the native
//                                        layer ignores -> default 10), keyword literal
//                                        case-insensitive whole-query substring in conversation order.
//
// Safety model (mirrors scripts/validate-memory-lab.mjs):
//   * only <snapshot>\work is opened; every path is asserted inside it and outside
//     every live data root;
//   * no agent init(), no timers, no scanners;
//   * nDB is opened on a SCRATCH COPY of the memory database (nDB materialises its
//     text index and rewrites the .fti cache when the journal moved — that must never
//     touch the lab), with persistence 'lazy'.  Scratch lives in <snapshot>\scratch\
//     phase0-<pid> — never in the lab tree, never in the live project data root —
//     and teardown refuses to delete anything outside that area;
//   * nVDB is only read: get() / search() / stats.  No createCollection, flush,
//     compact or rebuild_index anywhere;
//   * chat is read-only and never indexes anything.
//
// Query embeds go through the configured LLM Gateway (src/embed-client.js). The
// Gateway must already be running — this script never starts a service. The access
// key is passed to the client and never printed or written to the report.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GOLDEN_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'memory-lab-phase0-golden.json');

export const TOOL = 'memory-lab-phase0';
export const REPORT_VERSION = 1;

// Production constants — copied from the code being measured, not re-derived.
export const LEXICAL_BOOST = 0.10;
export const LEXICAL_BASE = 0.45;
export const LEXICAL_MAX_DOCS = 50;
export const MAX_CHUNKS_PER_FILE = 3;
export const MEMORY_TOPK_FLOOR = 25;
export const STORAGE_FETCH_FLOOR = 30;
export const CHAT_TOPK_MULTIPLIER = 3;

const DESCRIPTION_PREVIEW = 120;
const SNIPPET_PREVIEW = 120;
const MAX_SAMPLES = 10;

// ── primitives ───────────────────────────────────────────────────────────────

export function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.allocUnsafe(1024 * 1024);
        let read;
        while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

// Deterministic vector hash: SHA-256 over the Float64 bytes of the vector.
// Values are copied through Float64Array first so a plain JS array and a typed
// array hash identically.
export function vectorHash(vector) {
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
        throw new Error(`vectorHash: expected an array-like vector, got ${typeof vector}`);
    }
    const f = new Float64Array(vector.length);
    for (let i = 0; i < vector.length; i++) f[i] = vector[i];
    return crypto.createHash('sha256').update(Buffer.from(f.buffer, f.byteOffset, f.byteLength)).digest('hex');
}

// Structural check of one stored vector. `expectedDim` is asserted, not assumed:
// a wrong dimension is reported, never silently accepted.
export function analyzeVector(vector, expectedDim) {
    if (vector === undefined || vector === null) return { present: false };
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
        throw new Error(`analyzeVector: expected an array-like vector, got ${typeof vector}`);
    }
    let finite = true;
    let sumSquares = 0;
    for (let i = 0; i < vector.length; i++) {
        const v = vector[i];
        if (!Number.isFinite(v)) { finite = false; break; }
        sumSquares += v * v;
    }
    return {
        present: true,
        dim: vector.length,
        dimOk: vector.length === expectedDim,
        finite,
        norm: finite ? Math.sqrt(sumSquares) : null,
        nonzero: finite ? sumSquares > 0 : false,
        hash: finite ? vectorHash(vector) : null
    };
}

export function percentile(values, p) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[rank];
}

export function durationSummary(values) {
    if (!Array.isArray(values) || values.length === 0) return { count: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    return {
        count: sorted.length,
        minMs: sorted[0],
        medianMs: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted[sorted.length - 1],
        totalMs: sorted.reduce((a, b) => a + b, 0)
    };
}

function preview(text, n = DESCRIPTION_PREVIEW) {
    const s = String(text ?? '');
    return s.length > n ? `${s.slice(0, n)}…` : s;
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

// Live data roots read from config.json — the lab copy is the only thing this
// script may open.  Same set validate-memory-lab.mjs refuses to touch.
export function resolveLiveRoots(repoRoot = REPO_ROOT) {
    const configPath = path.join(repoRoot, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const agents = config.agents || {};
    const resolve = (p, fallback) => {
        const value = p || fallback;
        return path.isAbsolute(value) ? fullPath(value) : fullPath(path.join(repoRoot, value));
    };

    const roots = [
        path.dirname(resolve(agents.memory?.dbPath, 'data/memories/data.jsonl')),
        resolve(agents.vdb?.dbPath, 'data/nvdb'),
        resolve(agents.chat?.dir, 'data/chat/sessions'),
        resolve(agents.storage?.root, 'D:/MCP_Storage'),
        'D:/SRV/LLM-Gateway-Chat/server/data',
        path.join(repoRoot, 'data')
    ];
    return roots.map(fullPath);
}

export function createSnapshotGuard(workRoot, liveRoots) {
    const assertNotLive = (target, label) => {
        for (const live of liveRoots) {
            if (isInside(target, live)) {
                throw new Error(`${label} points into a LIVE data root and must not be opened: ${target} (live root: ${live})`);
            }
        }
    };
    return {
        assertNotLive,
        assertWork(target, label) {
            const resolved = fullPath(target);
            if (!isInside(resolved, workRoot)) {
                throw new Error(`${label} is outside the lab work root: ${resolved} (work root: ${workRoot})`);
            }
            assertNotLive(resolved, label);
            if (fs.existsSync(resolved)) {
                const real = fullPath(realPath(resolved));
                if (!isInside(real, workRoot)) {
                    throw new Error(`${label} resolves outside the lab work root (symlink escape): ${real}`);
                }
                assertNotLive(real, `${label} (resolved)`);
            }
            return resolved;
        }
    };
}

// ── golden suite ─────────────────────────────────────────────────────────────

export function loadGoldenSuite(goldenPath = GOLDEN_PATH) {
    const suite = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    if (!suite.suiteVersion) throw new Error(`golden suite has no suiteVersion: ${goldenPath}`);
    if (!Array.isArray(suite.memory) || !Array.isArray(suite.storage) || !Array.isArray(suite.chat)) {
        throw new Error(`golden suite must declare memory[], storage[] and chat[] arrays: ${goldenPath}`);
    }
    for (const item of suite.memory) {
        if (!item.id || !item.query) throw new Error(`golden memory case missing id/query: ${JSON.stringify(item)}`);
        if (item.relevantIds !== undefined && !Array.isArray(item.relevantIds)) {
            throw new Error(`golden memory case ${item.id}: relevantIds must be an array`);
        }
    }
    for (const item of suite.storage) {
        if (!item.id || !item.query) throw new Error(`golden storage case missing id/query: ${JSON.stringify(item)}`);
    }
    for (const item of suite.chat) {
        if (!item.id || !item.query) throw new Error(`golden chat case missing id/query: ${JSON.stringify(item)}`);
        if (item.lane !== 'semantic' && item.lane !== 'keyword') {
            throw new Error(`golden chat case ${item.id}: lane must be "semantic" or "keyword"`);
        }
    }
    return suite;
}

// ── snapshot layout ──────────────────────────────────────────────────────────

export function resolveSnapshotLayout(snapshotRoot) {
    const root = fullPath(snapshotRoot);
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(root)) throw new Error(`snapshot root missing: ${root}`);
    if (!fs.existsSync(manifestPath)) throw new Error(`snapshot manifest missing: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const workRoot = path.join(root, 'work');
    if (!fs.existsSync(workRoot)) throw new Error(`snapshot work root missing: ${workRoot}`);

    const sourceOf = (role) => {
        const found = (manifest.sources || []).find((s) => s.role === role);
        if (!found) throw new Error(`snapshot manifest has no source with role "${role}"`);
        return found;
    };

    const memorySource = sourceOf('memory-ndb');
    const nvdbSource = sourceOf('nvdb');
    const storageSource = sourceOf('storage');
    const chatSource = sourceOf('chat-data');

    const sidecar = path.join(root, 'MANIFEST.sha256');
    const manifestSha256 = fs.existsSync(sidecar)
        ? fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0].toLowerCase()
        : null;
    const manifestActualSha256 = sha256File(manifestPath);
    if (manifestSha256 && manifestSha256 !== manifestActualSha256) {
        throw new Error(`snapshot manifest hash mismatch: sidecar ${manifestSha256}, actual ${manifestActualSha256}`);
    }

    return {
        root,
        workRoot,
        reportsDir: path.join(root, 'reports'),
        manifestPath,
        manifest,
        manifestSha256: manifestActualSha256,
        memoryDir: fullPath(memorySource.workPath),
        nvdbDir: fullPath(nvdbSource.workPath),
        storageDir: fullPath(storageSource.workPath),
        chatDataDir: fullPath(chatSource.workPath),
        scanIndexPath: path.join(fullPath(nvdbSource.workPath), 'scan-index.json')
    };
}

// ── memory lanes (src/agents/memory/index.js parity) ─────────────────────────

// Exactly the production token rule: lowercase, [a-z0-9]{3,}, dedup, first 8.
export function lexicalTokens(query) {
    return [...new Set(String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || [])].slice(0, 8);
}

function textSearchIds(db, toks) {
    const q = { mode: 'and', queries: toks.map((t) => ({ type: 'term', value: t })) };
    const ids = new Set(db.textSearch('description', q));
    for (const id of db.textSearch('data', q)) ids.add(id);
    return [...ids];
}

// Production lexical leg, including the progressive narrowing on leading
// 6/4-token subsets.  Every attempt is recorded so the report can say WHICH
// retry produced the ids (production only records the final set).
export function memoryLexicalRecall({ db, query, category = null }) {
    const tokens = lexicalTokens(query);
    const attempts = [];
    if (tokens.length === 0) return { tokens, attempts, docs: [], ids: [] };

    const run = (toks) => {
        const descriptionIds = db.textSearch('description', { mode: 'and', queries: toks.map((t) => ({ type: 'term', value: t })) });
        const dataIds = db.textSearch('data', { mode: 'and', queries: toks.map((t) => ({ type: 'term', value: t })) });
        const ids = [...new Set([...descriptionIds, ...dataIds])];
        attempts.push({ n: toks.length, tokens: toks, descriptionHits: descriptionIds.length, dataHits: dataIds.length, ids: ids.length });
        return ids;
    };

    let ids = run(tokens);
    let idsAttempt = attempts[0];
    for (let n = 6; ids.length === 0 && n >= 3 && n < tokens.length; n -= 2) {
        const attemptIds = run(tokens.slice(0, n));
        if (attemptIds.length !== 0) { ids = attemptIds; idsAttempt = attempts[attempts.length - 1]; }
    }

    const docs = [];
    const skipped = { tombstoned: 0, nonMemory: 0, category: 0 };
    for (const id of ids.slice(0, LEXICAL_MAX_DOCS)) {
        let doc;
        try {
            doc = db.get(id);
        } catch {
            // A tombstoned doc inside a text index is an nDB index fault, but the
            // production lane never surfaces it — record it instead of throwing.
            skipped.tombstoned++;
            continue;
        }
        if (!doc?._id?.startsWith('mem_')) { skipped.nonMemory++; continue; }
        if (category && doc.category !== category) { skipped.category++; continue; }
        docs.push(doc);
    }
    return { tokens, attempts, ids, idsAttempt: idsAttempt?.n ?? null, docs, skipped };
}

function safeGetDoc(db, id) {
    try {
        return { doc: db.get(id) ?? null, missing: false, tombstoned: false };
    } catch {
        return { doc: null, missing: false, tombstoned: true };
    }
}

// Production hybrid composition, verbatim:
//   semantic hit, joined to nDB: sim = min(1, score + 0.10) when also lexical, else score
//   lexical-only doc:            score = 0.45
//   weightedScore = score * (0.7 + confidence * 0.3)
//   sort weightedScore desc
export function memoryHybridRank({ semanticHits, lexicalDocs, safeGet, category = null, limit = 10 }) {
    const lexicalIdSet = new Set(lexicalDocs.map((d) => d.id));
    const stats = { semanticHits: semanticHits.length, tombstoned: 0, missing: 0, nonMemory: 0, category: 0, duplicate: 0 };
    const scored = [];
    const seenIds = new Set();

    for (const hit of semanticHits) {
        const { doc, tombstoned, missing } = safeGet(hit.id);
        if (tombstoned) { stats.tombstoned++; continue; }
        if (missing || !doc) { stats.missing++; continue; }
        if (!doc._id?.startsWith('mem_')) { stats.nonMemory++; continue; }
        if (seenIds.has(doc.id)) { stats.duplicate++; continue; }
        if (category && doc.category !== category) { stats.category++; continue; }
        seenIds.add(doc.id);
        const conf = doc.confidence ?? 0.5;
        const lexical = lexicalIdSet.has(doc.id);
        const score = lexical ? Math.min(1, hit.score + LEXICAL_BOOST) : hit.score;
        scored.push({ doc, score, weightedScore: score * (0.7 + conf * 0.3), lexical });
    }

    for (const doc of lexicalDocs) {
        if (seenIds.has(doc.id)) continue;
        const conf = doc.confidence ?? 0.5;
        scored.push({ doc, score: LEXICAL_BASE, weightedScore: LEXICAL_BASE * (0.7 + conf * 0.3), lexical: true });
        seenIds.add(doc.id);
    }

    scored.sort((a, b) => b.weightedScore - a.weightedScore);

    const ranked = scored.map((entry, i) => ({
        rank: i + 1,
        id: entry.doc.id,
        _id: entry.doc._id,
        category: entry.doc.category,
        confidence: entry.doc.confidence ?? 0.5,
        lexical: entry.lexical,
        score: entry.score,
        weightedScore: entry.weightedScore,
        description: preview(entry.doc.description)
    }));

    return { ranked: ranked.slice(0, limit), allRanked: ranked, stats };
}

// Which memory nVDB search key production uses.  Production passes the camelCase
// `topK`, which napi-rs maps onto the native `top_k` field — see probeTopK().
export function memorySemanticTopK(limit) {
    return Math.max(limit * 5, MEMORY_TOPK_FLOOR);
}

// ── storage lane (src/agents/vdb/index.js parity) ────────────────────────────

export function minMaxNormalize(scores) {
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min || 1;
    return scores.map((s) => (s - min) / range);
}

// Raw lane records: min-max normalized per collection, ordered by normalized
// score, then deduped by id and by contentHash#splitIdx, capped at 3 chunks per
// path, sliced to top_k.  Mirrors searchDocuments() step for step.
export function rankStorageMatches(rawMatches, topK) {
    const scores = rawMatches.map((m) => m.score);
    const normalized = rawMatches.length > 0 ? minMaxNormalize(scores) : [];

    const records = rawMatches.map((match, i) => {
        const payload = match.payload ? JSON.parse(match.payload) : {};
        return {
            collection: match.collection ?? 'storage',
            id: match.id,
            score: match.score,
            normalizedScore: normalized[i],
            path: payload.path,
            // absolutePath is carried for the report ONLY — never read for content.
            absolutePathPresent: typeof payload.absolutePath === 'string',
            folder: payload.folder,
            contentHash: payload.contentHash,
            splitIdx: payload.splitIdx,
            charOffset: payload.charOffset,
            charLen: payload.charLen,
            rawPayload: payload
        };
    });

    records.sort((a, b) => b.normalizedScore - a.normalizedScore);

    const seenIds = new Set();
    const seenContent = new Set();
    const perFileCount = new Map();
    const deduped = [];
    for (const r of records) {
        if (seenIds.has(r.id)) continue;
        seenIds.add(r.id);

        const contentKey = r.contentHash && r.splitIdx !== undefined ? `${r.contentHash}#${r.splitIdx}` : null;
        if (contentKey) {
            if (seenContent.has(contentKey)) continue;
            seenContent.add(contentKey);
        }

        const count = perFileCount.get(r.path) || 0;
        if (count >= MAX_CHUNKS_PER_FILE) continue;
        perFileCount.set(r.path, count + 1);

        deduped.push(r);
        if (deduped.length >= topK) break;
    }
    return { records, deduped };
}

// Content evidence for a chunk — mapped through payload.path onto the lab
// work copy of storage.  payload.absolutePath is deliberately ignored: it points
// at the LIVE tree.
export function readChunkEvidence(payload, storageWorkRoot, guard = null) {
    if (!payload || typeof payload.path !== 'string' || payload.path.length === 0) {
        return { available: false, reason: 'payload has no path' };
    }
    if (typeof payload.charOffset !== 'number' || typeof payload.charLen !== 'number') {
        return { available: false, reason: 'payload has no charOffset/charLen' };
    }
    const target = path.join(storageWorkRoot, payload.path.split('/').join(path.sep));
    if (guard) guard.assertWork(target, `storage evidence ${payload.path}`);
    if (!fs.existsSync(target)) return { available: false, reason: 'work copy file missing', workPath: target };
    const text = fs.readFileSync(target, 'utf8');
    const slice = text.slice(payload.charOffset, payload.charOffset + payload.charLen);
    return {
        available: true,
        source: 'work-copy',
        workPath: target,
        chars: slice.length,
        preview: preview(slice, SNIPPET_PREVIEW)
    };
}

export function sourceIntentOf(storagePath, sourceIntent) {
    if (typeof storagePath !== 'string') return 'unknown';
    const p = storagePath.replace(/\\/g, '/');
    if ((sourceIntent.ownPrefixes || []).some((prefix) => p.startsWith(prefix))) return 'own';
    if ((sourceIntent.thirdPartyPrefixes || []).some((prefix) => p.startsWith(prefix))) return 'thirdParty';
    return 'other';
}

export function sourceIntentSummary(paths, sourceIntent) {
    const counts = { own: 0, thirdParty: 0, other: 0, unknown: 0 };
    for (const p of paths) counts[sourceIntentOf(p, sourceIntent)]++;
    const total = paths.length || 1;
    return {
        total: paths.length,
        own: counts.own,
        thirdParty: counts.thirdParty,
        other: counts.other,
        unknown: counts.unknown,
        ownShare: counts.own / total,
        thirdPartyShare: counts.thirdParty / total
    };
}

// ── chat lane (LLM-Gateway-Chat server/internal-tools.js searchArchive parity) ─

export function buildChatIndex({ conversations, sessions = [], role = null }) {
    const sessionById = new Map();
    for (const s of sessions) sessionById.set(s.id, s);

    const convById = new Map();
    const messageIndex = [];
    for (const c of conversations) {
        convById.set(c.id, c);
        const session = sessionById.get(c.id) ?? null;
        if (!c.messages) continue;
        for (const msg of c.messages) {
            if (role && role !== 'all' && msg.role !== role) continue;
            messageIndex.push({ chatId: c.id, idx: msg.idx, msg, session });
        }
    }
    return { convById, sessionById, messageIndex };
}

export function chatIndexBaseline(conversations, role = null) {
    const roleCounts = {};
    let messages = 0;
    let emptyContent = 0;
    let emptyEmbedded = 0;
    for (const c of conversations) {
        for (const msg of c.messages || []) {
            if (role && role !== 'all' && msg.role !== role) continue;
            messages++;
            roleCounts[msg.role] = (roleCounts[msg.role] || 0) + 1;
            if ((msg.content || '').length === 0) {
                emptyContent++;
                if (msg.embedStatus === 'embedded') emptyEmbedded++;
            }
        }
    }
    return { messages, roleCounts, emptyContent, emptyEmbedded };
}

// Production semantic leg.  `top_k` is passed literally because that is what the
// production code passes — the native layer ignores that spelling and answers with
// its default of 10 results (see probeTopK).
export async function chatSemanticLane({ embeddingsColl, queryVector, index, limit }) {
    const requested = limit * CHAT_TOPK_MULTIPLIER;
    const vectorResults = await embeddingsColl.search({ vector: queryVector, top_k: requested });

    const results = [];
    const seen = new Set();
    for (const hit of vectorResults) {
        if (results.length >= limit) break;
        const payload = hit.payload ? JSON.parse(hit.payload) : null;
        const chatId = payload?.chatId;
        const msgIdx = typeof payload?.msgIdx === 'number' ? payload.msgIdx : -1;
        const msgId = payload?.messageId || hit.id;
        const seenKey = chatId ? `${chatId}#${msgIdx}` : msgId;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);

        let entry;
        if (chatId && msgIdx >= 0) entry = index.messageIndex.find((e) => e.chatId === chatId && e.idx === msgIdx);
        else entry = index.messageIndex.find((e) => e.msg.id === msgId);
        if (!entry) continue;

        results.push({
            score: hit.score,
            chatId: entry.chatId,
            idx: entry.idx,
            messageId: entry.msg.id,
            role: entry.msg.role,
            sessionId: entry.session?.id ?? null,
            sessionTitle: entry.session?.title ?? null,
            contentLength: (entry.msg.content || '').length,
            snippet: preview(entry.msg.content, SNIPPET_PREVIEW)
        });
    }
    return { requestedTopK: requested, returnedK: vectorResults.length, results };
}

// Production keyword leg: literal, case-insensitive, WHOLE query as one
// substring, in conversation order, score 0.  Kept as its own raw lane so the
// report never conflates it with the semantic lane.
export function chatKeywordLane({ index, query, limit }) {
    const lowerQuery = String(query).toLowerCase();
    const hits = index.messageIndex.filter((e) => (e.msg.content || '').toLowerCase().includes(lowerQuery));
    const results = hits.slice(0, limit).map((entry) => ({
        score: 0,
        chatId: entry.chatId,
        idx: entry.idx,
        messageId: entry.msg.id,
        role: entry.msg.role,
        sessionId: entry.session?.id ?? null,
        sessionTitle: entry.session?.title ?? null,
        contentLength: (entry.msg.content || '').length,
        snippet: preview(entry.msg.content, SNIPPET_PREVIEW)
    }));
    return { totalHits: hits.length, results };
}

// A message body that IS an archive-search result/request echo.  Used only to
// measure existing contamination — never to filter search results.
export function looksLikeArchiveSearchOutput(content) {
    const text = String(content ?? '');
    if (text.length < 20) return false;
    if (/"(search_type|method)"\s*:/.test(text) && /"results"\s*:/.test(text)) return true;
    if (/"(search_type)"\s*:/.test(text) && /"(query|filter|date_from|date_to)"\s*:/.test(text)) return true;
    return false;
}

export function detectChatContamination({ conversations, contaminationSessionId }) {
    const totals = {
        messages: 0,
        archiveShaped: 0,
        archiveShapedEmbedded: 0,
        archiveShapedTool: 0,
        archiveShapedToolEmbedded: 0,
        toolMessages: 0,
        toolCopies: 0
    };
    const samples = [];
    const byRole = {};

    for (const c of conversations) {
        const localSeen = new Set();
        for (const msg of c.messages || []) {
            totals.messages++;
            const content = msg.content || '';
            if (looksLikeArchiveSearchOutput(content)) {
                totals.archiveShaped++;
                byRole[msg.role] = (byRole[msg.role] || 0) + 1;
                const embedded = msg.embedStatus === 'embedded';
                if (embedded) totals.archiveShapedEmbedded++;
                if (msg.role === 'tool') {
                    totals.archiveShapedTool++;
                    if (embedded) totals.archiveShapedToolEmbedded++;
                }
                if (samples.length < MAX_SAMPLES) {
                    samples.push({
                        chatId: c.id,
                        idx: msg.idx,
                        id: msg.id,
                        role: msg.role,
                        embedded: msg.embedStatus === 'embedded',
                        contentLength: content.length,
                        snippet: preview(content, 90)
                    });
                }
            }
            if (msg.role === 'tool') {
                totals.toolMessages++;
                if (localSeen.has(content) && content.length > 0) totals.toolCopies++;
            }
            if (content.length > 0) localSeen.add(content);
        }
    }

    const session = conversations.find((c) => c.id === contaminationSessionId) ?? null;
    let sessionReport = { sessionId: contaminationSessionId, found: false };
    if (session) {
        const roles = {};
        let archiveShaped = 0;
        let archiveShapedEmbedded = 0;
        const sessionSamples = [];
        for (const msg of session.messages || []) {
            roles[msg.role] = (roles[msg.role] || 0) + 1;
            if (!looksLikeArchiveSearchOutput(msg.content || '')) continue;
            archiveShaped++;
            if (msg.embedStatus === 'embedded') archiveShapedEmbedded++;
            if (sessionSamples.length < MAX_SAMPLES) {
                sessionSamples.push({
                    idx: msg.idx,
                    id: msg.id,
                    role: msg.role,
                    embedded: msg.embedStatus === 'embedded',
                    contentLength: (msg.content || '').length,
                    snippet: preview(msg.content, 90)
                });
            }
        }
        sessionReport = {
            sessionId: contaminationSessionId,
            found: true,
            title: session.title ?? null,
            createdAt: session.createdAt ?? null,
            messageCount: (session.messages || []).length,
            roles,
            archiveShaped,
            archiveShapedEmbedded,
            samples: sessionSamples
        };
    }

    return { totals, byRole, samples, contaminationSession: sessionReport };
}

// ── probe: topK vs top_k ─────────────────────────────────────────────────────

// The native binding declares `top_k`.  napi-rs maps the camelCase `topK` onto it
// and silently drops a literal `top_k` key, so that spelling falls back to the
// native default (10).  Measured, not assumed: probeTopK() searches the same stored
// vector with each spelling and records the counts.
export async function probeTopK({ coll, vector, k = 30 }) {
    const camel = await coll.search({ vector, topK: k });
    const snake = await coll.search({ vector, top_k: k });
    return {
        requestedK: k,
        topK: { requested: k, returned: camel.length, ids: camel.slice(0, 3).map((m) => m.id) },
        top_k: { requested: k, returned: snake.length, ids: snake.slice(0, 3).map((m) => m.id) },
        countsDiffer: camel.length !== snake.length,
        note: 'topK is honoured (napi-rs maps it to top_k). A literal top_k key is ignored and falls back to the native default of 10 — which is what the chat semantic lane passes.'
    };
}

// ── integrity / coverage ─────────────────────────────────────────────────────

function duplicateSummary(hashCounts, maxGroups = MAX_SAMPLES) {
    let groups = 0;
    let vectors = 0;
    const samples = [];
    for (const [hash, ids] of hashCounts) {
        if (ids.length < 2) continue;
        groups++;
        vectors += ids.length;
        if (samples.length < maxGroups) samples.push({ hash: hash.slice(0, 16), count: ids.length, ids: ids.slice(0, 3) });
    }
    return { duplicateGroups: groups, duplicateVectors: vectors, samples };
}

function pushHash(map, hash, id) {
    const list = map.get(hash);
    if (list) list.push(id);
    else map.set(hash, [id]);
}

export function memoryCoverage({ docs, coll, expectedDim }) {
    const active = docs.filter((d) => d._id?.startsWith('mem_'));
    // embedStatus is about the memory corpus: `_meta`/other bookkeeping documents
    // carry no embedding and would skew the counts.
    const embedStatus = {};
    for (const d of active) {
        const key = d.embedStatus ?? 'missing';
        embedStatus[key] = (embedStatus[key] || 0) + 1;
    }

    const hashCounts = new Map();
    const missing = [];
    const badDim = [];
    const nonFinite = [];
    const zeroNorm = [];
    let present = 0;
    for (const doc of active) {
        const record = coll.get(doc._id);
        if (!record) {
            if (missing.length < MAX_SAMPLES) missing.push(doc._id);
            continue;
        }
        present++;
        const v = analyzeVector(record.vector, expectedDim);
        if (!v.dimOk && badDim.length < MAX_SAMPLES) badDim.push({ _id: doc._id, dim: v.dim });
        if (!v.finite && nonFinite.length < MAX_SAMPLES) nonFinite.push(doc._id);
        if (v.finite && !v.nonzero && zeroNorm.length < MAX_SAMPLES) zeroNorm.push(doc._id);
        if (v.hash) pushHash(hashCounts, v.hash, doc._id);
    }

    const dupes = duplicateSummary(hashCounts);
    const namedTargets = [6830, 6955, 6911, 6931, 6795].map((id) => {
        const doc = active.find((d) => d.id === id);
        if (!doc) return { id, present: false };
        const record = coll.get(doc._id);
        if (!record) return { id, _id: doc._id, present: false };
        const v = analyzeVector(record.vector, expectedDim);
        return { id, _id: doc._id, present: true, dim: v.dim, dimOk: v.dimOk, finite: v.finite, nonzero: v.nonzero, hash: v.hash?.slice(0, 16) ?? null };
    });

    return {
        nDBDocuments: docs.length,
        activeMemDocuments: active.length,
        embedStatus,
        expectedDim,
        vectorsPresent: present,
        vectorsMissing: active.length - present,
        missingSamples: missing,
        badDimSamples: badDim,
        nonFiniteSamples: nonFinite,
        zeroNormSamples: zeroNorm,
        distinctVectorHashes: hashCounts.size,
        ...dupes,
        namedTargets
    };
}

export function storageCoverage({ ids, coll, expectedDim }) {
    const hashCounts = new Map();
    const missing = [];
    const badDim = [];
    const nonFinite = [];
    const zeroNorm = [];
    let present = 0;
    for (const id of ids) {
        const record = coll.get(id);
        if (!record) {
            if (missing.length < MAX_SAMPLES) missing.push(id);
            continue;
        }
        present++;
        const v = analyzeVector(record.vector, expectedDim);
        if (!v.dimOk && badDim.length < MAX_SAMPLES) badDim.push({ id, dim: v.dim });
        if (!v.finite && nonFinite.length < MAX_SAMPLES) nonFinite.push(id);
        if (v.finite && !v.nonzero && zeroNorm.length < MAX_SAMPLES) zeroNorm.push(id);
        if (v.hash) pushHash(hashCounts, v.hash, id);
    }
    const dupes = duplicateSummary(hashCounts);
    return {
        requestedIds: ids.length,
        vectorsPresent: present,
        vectorsMissing: ids.length - present,
        missingSamples: missing,
        badDimSamples: badDim,
        nonFiniteSamples: nonFinite,
        zeroNormSamples: zeroNorm,
        distinctVectorHashes: hashCounts.size,
        ...dupes
    };
}

// The five explicitly named chunk ids: retrieved, hashed, and reported with
// pairwise uniqueness plus their payload path/hash.  Live absolutePath is never
// echoed — only whether the payload carries one.
export function explicitVectorProbe({ ids, coll, expectedDim }) {
    const entries = ids.map((id) => {
        const record = coll.get(id);
        if (!record) return { id, present: false };
        const v = analyzeVector(record.vector, expectedDim);
        const payload = record.payload ? JSON.parse(record.payload) : {};
        return {
            id,
            present: true,
            dim: v.dim,
            dimOk: v.dimOk,
            finite: v.finite,
            nonzero: v.nonzero,
            hash: v.hash,
            path: payload.path ?? null,
            contentHash: payload.contentHash ?? null,
            splitIdx: payload.splitIdx ?? null,
            payloadHasAbsolutePath: typeof payload.absolutePath === 'string'
        };
    });

    const pairs = [];
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            if (!entries[i].present || !entries[j].present) continue;
            if (entries[i].hash === entries[j].hash) pairs.push({ a: entries[i].id, b: entries[j].id, identical: true });
        }
    }
    const presentEntries = entries.filter((e) => e.present);
    return {
        entries: entries.map((e) => ({ ...e, hash: e.hash ? e.hash.slice(0, 16) : null })),
        present: presentEntries.length,
        distinctHashes: new Set(presentEntries.map((e) => e.hash)).size,
        identicalPairs: pairs,
        allDistinct: presentEntries.length > 1 && new Set(presentEntries.map((e) => e.hash)).size === presentEntries.length
    };
}

export function chatInventory({ db, conversations, sessions, embeddingsStats, expectedDim, contamination = null }) {
    let messages = 0;
    const roles = {};
    let emptyContent = 0;
    let emptyContentEmbedded = 0;
    let toolMessages = 0;
    let toolMessagesEmbedded = 0;
    let systemMessages = 0;
    const toolNames = {};
    const messageCopyCounts = new Map();
    let duplicateContents = 0;

    for (const c of conversations) {
        for (const msg of c.messages || []) {
            messages++;
            roles[msg.role] = (roles[msg.role] || 0) + 1;
            const content = msg.content || '';
            if (content.length === 0) {
                emptyContent++;
                if (msg.embedStatus === 'embedded') emptyContentEmbedded++;
            }
            if (msg.role === 'system') systemMessages++;
            if (msg.role === 'tool') {
                toolMessages++;
                if (msg.embedStatus === 'embedded') toolMessagesEmbedded++;
                const name = msg.toolName || '(none)';
                toolNames[name] = (toolNames[name] || 0) + 1;
            }
            if (content.length > 0) messageCopyCounts.set(content, (messageCopyCounts.get(content) || 0) + 1);
        }
    }
    for (const count of messageCopyCounts.values()) if (count > 1) duplicateContents += count - 1;

    const topToolNames = Object.entries(toolNames).sort((a, b) => b[1] - a[1]).slice(0, 10);

    return {
        databaseOpened: !!db,
        conversations: conversations.length,
        sessions: sessions.length,
        messages,
        roles,
        systemMessages,
        emptyContent,
        emptyContentEmbedded,
        toolMessages,
        toolMessagesEmbedded,
        toolShare: messages > 0 ? toolMessages / messages : null,
        topToolNames,
        duplicateMessageContents: duplicateContents,
        toolCopies: contamination?.totals.toolCopies ?? null,
        archiveSearchShapedToolOutputs: contamination?.totals.archiveShapedTool ?? null,
        archiveSearchShapedToolOutputsEmbedded: contamination?.totals.archiveShapedToolEmbedded ?? null,
        nvdb: embeddingsStats ? { collections: embeddingsStats.collections, stats: embeddingsStats.stats } : null,
        expectedDim
    };
}

// ── metrics ──────────────────────────────────────────────────────────────────

export function targetRanks(rankedRecords, keyFn, targets) {
    const out = {};
    for (const target of targets) {
        const index = rankedRecords.findIndex((r) => keyFn(r) === target);
        out[String(target)] = index === -1 ? null : index + 1;
    }
    return out;
}

// Rank map over a plain id list (a lane's own order). A target that never
// reached the lane's window maps to null — that IS the diagnostic.
export function rankMapFromIds(ids, wanted) {
    const map = {};
    for (const target of wanted ?? []) {
        const index = ids.indexOf(target);
        map[String(target)] = index === -1 ? null : index + 1;
    }
    return map;
}

function aggregateRanks(cases, targetsOf) {
    const known = [];
    for (const c of cases) {
        for (const [target, rank] of Object.entries(targetsOf(c) || {})) known.push({ caseId: c.id, target, rank });
    }
    const scored = known.filter((k) => k.rank !== null);
    const within10 = scored.filter((k) => k.rank <= 10).length;
    const within5 = scored.filter((k) => k.rank <= 5).length;
    const casesWithTargets = cases.filter((c) => Object.keys(targetsOf(c) || {}).length > 0);
    return {
        knownTargets: known.length,
        foundTargets: scored.length,
        recallAt10: known.length === 0 ? null : within10 / known.length,
        exactHitAt5: known.length === 0 ? null : within5 / known.length,
        casesWithTargets: casesWithTargets.length,
        perTarget: known
    };
}

export function buildMetrics({ memoryLanes, storageLanes, chatLanes, probe, coverage }) {
    const memory = aggregateRanks(memoryLanes, (c) => c.targetRanks?.hybrid);
    const storage = aggregateRanks(storageLanes, (c) => c.targetRanks?.final);
    const chat = aggregateRanks(chatLanes, (c) => c.targets);

    const durations = {};
    for (const [lane, cases] of Object.entries({ memory: memoryLanes, storage: storageLanes, chat: chatLanes })) {
        durations[lane] = durationSummary(cases.filter((c) => typeof c.durationMs === 'number').map((c) => c.durationMs));
    }
    const allDurations = [...memoryLanes, ...storageLanes, ...chatLanes]
        .filter((c) => typeof c.durationMs === 'number')
        .map((c) => c.durationMs);
    durations.all = durationSummary(allDurations);

    const nonsense = memoryLanes.find((c) => c.control === 'nonsense') ?? null;

    return {
        memory,
        storage,
        chat,
        durations,
        nonsenseControl: nonsense
            ? {
                caseId: nonsense.id,
                query: nonsense.query,
                maxSemanticScore: nonsense.semantic?.maxScore ?? null,
                maxHybridScore: nonsense.hybrid?.maxScore ?? null,
                note: 'recorded only — no rejection threshold is inferred from it'
            }
            : null,
        contamination: coverage?.chat?.contamination
            ? {
                archiveShapedMessages: coverage.chat.contamination.totals.archiveShaped,
                archiveShapedEmbedded: coverage.chat.contamination.totals.archiveShapedEmbedded,
                archiveShapedToolOutputs: coverage.chat.contamination.totals.archiveShapedTool,
                archiveShapedToolOutputsEmbedded: coverage.chat.contamination.totals.archiveShapedToolEmbedded,
                emptyContent: coverage.chat.inventory.emptyContent,
                emptyContentEmbedded: coverage.chat.inventory.emptyContentEmbedded,
                toolMessages: coverage.chat.inventory.toolMessages,
                toolMessagesEmbedded: coverage.chat.inventory.toolMessagesEmbedded,
                toolCopies: coverage.chat.inventory.toolCopies
            }
            : null,
        probe
    };
}

// ── lane runners ─────────────────────────────────────────────────────────────

async function runMemoryLane({ suiteCase, db, coll, embedder, expectedDim, category = null, defaultLimit = 10 }) {
    const started = Date.now();
    const limit = suiteCase.limit ?? defaultLimit;
    const lexical = memoryLexicalRecall({ db, query: suiteCase.query, category });
    const lexicalEnded = Date.now();

    const queryVector = await embedder.embed(suiteCase.query);
    const semanticTopK = memorySemanticTopK(limit);
    const semanticEndedBeforeSearch = Date.now();
    const searchResults = await coll.search({ vector: queryVector, topK: semanticTopK });
    const semanticHits = searchResults.map((hit, i) => ({ rank: i + 1, id: hit.id, score: hit.score }));
    const semanticEnded = Date.now();

    const hybrid = memoryHybridRank({
        semanticHits,
        lexicalDocs: lexical.docs,
        safeGet: (id) => safeGetDoc(db, id),
        category,
        limit
    });
    const ended = Date.now();

    const docIdRanked = hybrid.allRanked.map((r) => r.id);
    // Every leg gets its own target rank map: a single hybrid map hides the leg
    // where a target was actually lost (6830 never entered either leg's window).
    const joinedSemantic = semanticHits.map((h) => {
        const got = safeGetDoc(db, h.id);
        return { rank: h.rank, id: h.id, _id: got.doc?._id ?? null, memId: got.doc?.id ?? null, score: h.score, description: got.doc ? preview(got.doc.description) : null };
    });
    const wanted = suiteCase.relevantIds ?? [];
    const targetRankMaps = {
        lexical: rankMapFromIds(lexical.docs.map((d) => d.id), wanted),
        semantic: rankMapFromIds(joinedSemantic.map((h) => h.memId), wanted),
        hybrid: rankMapFromIds(docIdRanked, wanted)
    };

    return {
        id: suiteCase.id,
        control: suiteCase.control ?? null,
        query: suiteCase.query,
        limit,
        lexical: {
            tokens: lexical.tokens,
            attempts: lexical.attempts,
            winningAttemptN: lexical.idsAttempt,
            candidateIds: lexical.ids.length,
            docCount: lexical.docs.length,
            docIds: lexical.docs.map((d) => d.id),
            skipped: lexical.skipped,
            targetRanks: targetRankMaps.lexical
        },
        semantic: {
            requestedTopK: semanticTopK,
            returnedK: semanticHits.length,
            // ALL raw hits are retained (not just `limit`) so a rank beyond the
            // presented window stays visible.
            hits: joinedSemantic.map((h) => ({ rank: h.rank, id: h.id, _id: h._id, memId: h.memId, score: h.score, description: h.description })),
            maxScore: semanticHits.length > 0 ? Math.max(...semanticHits.map((h) => h.score)) : null,
            targetRanks: targetRankMaps.semantic
        },
        hybrid: {
            ranked: hybrid.ranked,
            totalRanked: hybrid.allRanked.length,
            stats: hybrid.stats,
            maxScore: hybrid.ranked.length > 0 ? hybrid.ranked[0].weightedScore : null,
            docIdRanked,
            targetRanks: targetRankMaps.hybrid
        },
        targetRanks: targetRankMaps,
        hit5: Object.values(targetRankMaps.hybrid).some((r) => r !== null && r <= 5),
        hit10: Object.values(targetRankMaps.hybrid).some((r) => r !== null && r <= 10),
        timing: { lexicalMs: lexicalEnded - started, embedMs: semanticEndedBeforeSearch - lexicalEnded, semanticMs: semanticEnded - semanticEndedBeforeSearch, hybridMs: ended - semanticEnded },
        durationMs: ended - started,
        expectedDim
    };
}

async function runStorageLane({ suiteCase, coll, embedder, storageWorkRoot, guard, sourceIntent }) {
    const started = Date.now();
    const queryVector = await embedder.embed(suiteCase.query);
    const embedMs = Date.now() - started;
    const lane = await storageLaneFromVector({ suiteCase, queryVector, coll, storageWorkRoot, guard, sourceIntent, embedMs });
    lane.durationMs = Date.now() - started;
    return lane;
}

// Embed-free storage lane: the caller supplies the query vector, so one embedding
// can be replayed against several collections (candidate comparison).
export async function storageLaneFromVector({ suiteCase, queryVector, coll, storageWorkRoot, guard, sourceIntent, embedMs = 0 }) {
    const started = Date.now();
    const topK = suiteCase.top_k ?? 10;
    const embedEnded = started;
    const fetchK = Math.max(topK * 3, STORAGE_FETCH_FLOOR);
    const searchResults = await coll.search({ vector: queryVector, topK: fetchK, distance: 'cosine', approximate: false });
    const searchEnded = Date.now();

    const { records, deduped } = rankStorageMatches(searchResults, topK);
    const final = deduped.map((r, i) => ({
        rank: i + 1,
        id: r.id,
        path: r.path,
        folder: r.folder,
        score: r.score,
        normalized: r.normalizedScore,
        contentHash: r.contentHash,
        splitIdx: r.splitIdx,
        evidence: readChunkEvidence(r.rawPayload, storageWorkRoot, guard)
    }));

    const ended = Date.now();
    const rawPaths = records.map((r) => r.path);
    const finalPaths = final.map((r) => r.path);
    const relevantPaths = suiteCase.relevantPaths ?? [];
    const adjacentPaths = suiteCase.adjacentPaths ?? [];
    const targetRankMaps = {
        raw: rankMapFromIds(rawPaths, relevantPaths),
        final: rankMapFromIds(finalPaths, relevantPaths)
    };
    const adjacentRankMaps = {
        raw: rankMapFromIds(rawPaths, adjacentPaths),
        final: rankMapFromIds(finalPaths, adjacentPaths)
    };

    return {
        id: suiteCase.id,
        query: suiteCase.query,
        topK,
        fetchK,
        semantic: {
            returnedK: searchResults.length,
            raw: records.slice(0, STORAGE_FETCH_FLOOR).map((r, i) => ({
                rank: i + 1,
                id: r.id,
                path: r.path,
                folder: r.folder,
                score: r.score,
                normalized: r.normalizedScore,
                contentHash: r.contentHash,
                splitIdx: r.splitIdx,
                payloadHasAbsolutePath: r.absolutePathPresent
            })),
            maxScore: searchResults.length > 0 ? Math.max(...searchResults.map((r) => r.score)) : null
        },
        final,
        targetRanks: targetRankMaps,
        adjacentRanks: adjacentRankMaps,
        sourceIntent: {
            raw: sourceIntentSummary(rawPaths, sourceIntent),
            final: sourceIntentSummary(final.map((r) => r.path), sourceIntent)
        },
        timing: { embedMs, searchMs: searchEnded - embedEnded, rankMs: ended - searchEnded },
        durationMs: embedMs + (ended - started)
    };
}

async function runChatLane({ suiteCase, index, embeddingsColl, embedder, limit, contamination }) {
    const started = Date.now();
    const role = suiteCase.roleFilter ?? 'all';
    const lane = suiteCase.lane;
    let semantic = null;
    let keyword = null;

    if (lane === 'semantic') {
        const queryVector = await embedder.embed(suiteCase.query);
        const embedEnded = Date.now();
        semantic = await chatSemanticLane({ embeddingsColl, queryVector, index, limit });
        semantic.embedMs = embedEnded - started;
    }
    // Keyword always recorded as its own raw lane — production falls back to it,
    // but conflating the two would hide which leg found the target.
    keyword = chatKeywordLane({ index, query: suiteCase.query, limit });

    const ended = Date.now();
    const resultList = lane === 'semantic' ? (semantic?.results ?? []) : keyword.results;
    const keyOf = (r) => `${r.chatId}#${r.idx}`;
    const targets = {};
    for (const expect of suiteCase.relevant ?? []) {
        for (const idx of expect.idx ?? []) {
            const key = `${expect.sessionId}#${idx}`;
            const found = resultList.findIndex((r) => keyOf(r) === key);
            targets[key] = found === -1 ? null : found + 1;
        }
    }

    return {
        id: suiteCase.id,
        query: suiteCase.query,
        lane,
        roleFilter: role,
        limit,
        index: { messages: index.messageIndex.length, sessions: index.sessionById.size },
        baseline: chatIndexBaseline(index.convById ? [...index.convById.values()] : [], role),
        semantic,
        keyword,
        resultList,
        orderNote: lane === 'keyword'
            ? 'result order follows nDB conversation order (process-dependent HashMap iteration — not chronological, not stable across runs)'
            : 'result order follows vector score',
        targets,
        hit5: Object.values(targets).some((r) => r !== null && r <= 5),
        hit10: Object.values(targets).some((r) => r !== null && r <= 10),
        contamination: contamination.contaminationSession,
        durationMs: ended - started
    };
}

// ── orchestration ────────────────────────────────────────────────────────────

// A transient network failure is exactly two shapes: an undici TypeError
// ("fetch failed") and a message that says so.  Anything else — a bad request, a
// provider error, a programming mistake — is permanent and must never be retried.
export function isTransientFetchError(err) {
    if (!err) return false;
    if (err instanceof TypeError) return true;
    return /fetch failed/i.test(String(err.message ?? err));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wraps an embedder with accounting and ONE bounded retry for transient network
// failures.  The retry exists because a baseline run died on a single dropped
// connection while the very next identical embed succeeded — but a permanent
// failure must still surface, so a second failure is rethrown untouched.
export function wrapEmbedder(embedder, { retryDelayMs = 250, sleep = defaultSleep } = {}) {
    if (!embedder || typeof embedder.embed !== 'function') throw new Error('runPhase0: embedder with embed(text) is required');
    const stats = {
        calls: 0,
        chars: 0,
        attempts: 0,
        retries: 0,
        recovered: 0,
        transientFailures: [],
        failures: []
    };
    return {
        stats,
        async embed(text, opts) {
            stats.calls++;
            stats.chars += String(text ?? '').length;
            stats.attempts++;
            try {
                return await embedder.embed(text, opts);
            } catch (e) {
                if (!isTransientFetchError(e)) {
                    stats.failures.push({ text: preview(text, 80), error: e.message, transient: false, attempts: 1 });
                    throw e;
                }
                stats.transientFailures.push({ text: preview(text, 80), error: e.message, retryDelayMs });
                stats.retries++;
                await sleep(retryDelayMs);
                stats.attempts++;
                try {
                    const value = await embedder.embed(text, opts);
                    stats.recovered++;
                    return value;
                } catch (e2) {
                    stats.failures.push({ text: preview(text, 80), error: e2.message, transient: isTransientFetchError(e2), attempts: 2 });
                    throw e2;
                }
            }
        }
    };
}

// Scratch lives INSIDE the snapshot and outside reference/ and work/: the lab
// copy is the measured artefact, the snapshot root is the run's workspace, and
// the live project data root must never receive Phase 0 files.
export function resolveScratchArea(snapshotRoot) {
    const root = fullPath(snapshotRoot);
    return {
        root,
        scratchArea: path.join(root, 'scratch'),
        referenceRoot: path.join(root, 'reference'),
        workRoot: path.join(root, 'work')
    };
}

export function assertScratchLocation(scratchDir, area) {
    const resolved = fullPath(scratchDir);
    if (!isInside(resolved, area.root)) {
        throw new Error(`scratch directory must be inside the snapshot root: ${resolved} (snapshot root: ${area.root})`);
    }
    for (const [label, forbidden] of [['reference', area.referenceRoot], ['work', area.workRoot]]) {
        if (isInside(resolved, forbidden)) {
            throw new Error(`scratch directory must not be inside ${label}/: ${resolved}`);
        }
    }
    if (resolved === area.root) throw new Error(`scratch directory must not be the snapshot root itself: ${resolved}`);
    // Same area removeScratch will accept, so setup and teardown cannot disagree.
    if (!isInside(resolved, area.scratchArea) || resolved === area.scratchArea) {
        throw new Error(`scratch directory must be a subdirectory of the snapshot scratch area: ${resolved} (area: ${area.scratchArea})`);
    }
    return resolved;
}

// Deletes a scratch directory, but only one that sits in the snapshot's scratch
// area — a caller-supplied path must never turn into an arbitrary recursive delete.
export function removeScratch(dir, area) {
    if (!dir) return { removed: false, reason: 'no scratch directory' };
    const resolved = fullPath(dir);
    if (!isInside(resolved, area.scratchArea) || resolved === area.scratchArea) {
        throw new Error(`refusing to remove a scratch path outside the snapshot scratch area: ${resolved} (area: ${area.scratchArea})`);
    }
    if (!fs.existsSync(resolved)) return { removed: false, reason: 'absent' };
    fs.rmSync(resolved, { recursive: true, force: true });
    return { removed: true };
}

function stageMemoryDb({ guard, memoryDir, scratchDir }) {
    guard.assertWork(memoryDir, 'memory nDB directory');
    fs.mkdirSync(scratchDir, { recursive: true });
    const copied = [];
    for (const name of fs.readdirSync(memoryDir)) {
        const src = path.join(memoryDir, name);
        if (!fs.statSync(src).isFile()) continue;
        const dst = path.join(scratchDir, name);
        fs.copyFileSync(src, dst);
        copied.push({ name, bytes: fs.statSync(dst).size, sha256: sha256File(dst) });
    }
    const journal = copied.find((c) => c.name.endsWith('.jsonl'));
    if (!journal) throw new Error(`memory nDB directory has no .jsonl journal: ${memoryDir}`);
    return {
        dir: scratchDir,
        files: copied,
        journalName: journal.name,
        journalPath: path.join(scratchDir, journal.name),
        journalSha256: journal.sha256,
        textIndexCacheCopied: copied.filter((c) => c.name.startsWith('_index_') && c.name.endsWith('.fti')).length
    };
}

function openNvdbDatabase(loadNvdb, dir) {
    const { Database } = loadNvdb();
    return new Database(dir);
}

// Collection-level reality check: config (dim/durability) plus native stats
// (memtable/segments/total docs) so nDB and scan-index counts can be reconciled
// against what the vector store actually holds.
export function describeCollection(name, coll) {
    if (!coll) throw new Error(`describeCollection: collection "${name}" is not open`);
    const stats = typeof coll.stats === 'function' ? coll.stats() : coll.stats;
    return { collection: name, config: coll.config, stats };
}

export async function runPhase0(options) {
    const {
        snapshot,
        embedder: rawEmbedder,
        skipIntegrity = false,
        goldenPath = GOLDEN_PATH,
        openNdb,
        openNvdb,
        scratchDir = null,
        retryDelayMs = 250,
        now = () => new Date(),
        repoRoot = REPO_ROOT
    } = options || {};

    if (!snapshot) throw new Error('runPhase0: snapshot root is required');
    if (typeof openNdb !== 'function') throw new Error('runPhase0: openNdb loader is required');
    if (typeof openNvdb !== 'function') throw new Error('runPhase0: openNvdb loader is required');

    const startedAt = now();
    const embedder = wrapEmbedder(rawEmbedder, { retryDelayMs });
    const layout = resolveSnapshotLayout(snapshot);
    const liveRoots = resolveLiveRoots(repoRoot);
    const guard = createSnapshotGuard(layout.workRoot, liveRoots);
    guard.assertNotLive(layout.root, 'snapshot root');

    const scratchArea = resolveScratchArea(layout.root);
    const resolvedScratchDir = assertScratchLocation(scratchDir ?? path.join(scratchArea.scratchArea, `phase0-${process.pid}`), scratchArea);

    const suite = loadGoldenSuite(goldenPath);
    const expectedDim = suite.dataset?.expectedEmbeddingDim ?? 2560;
    const memoryLimit = suite.dataset?.memoryLimit ?? 10;
    const storageTopK = suite.dataset?.storageTopK ?? 10;
    const chatLimit = suite.dataset?.chatLimit ?? 10;

    const errors = [];
    const report = {
        tool: TOOL,
        version: REPORT_VERSION,
        ok: true,
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        totalDurationMs: null,
        snapshot: {
            root: layout.root,
            workRoot: layout.workRoot,
            manifestPath: layout.manifestPath,
            manifestSha256: layout.manifestSha256,
            manifestName: layout.manifest.name ?? null,
            mode: layout.manifest.mode ?? null,
            pointInTime: layout.manifest.pointInTime ?? null,
            warning: layout.manifest.warning ?? null,
            createdAt: layout.manifest.createdAt ?? null
        },
        golden: {
            path: fullPath(goldenPath),
            sha256: sha256File(goldenPath),
            suiteVersion: suite.suiteVersion,
            memoryCases: suite.memory.length,
            storageCases: suite.storage.length,
            chatCases: suite.chat.length
        },
        code: {
            packageVersion: readPackageVersion(repoRoot),
            nodeVersion: process.version,
            scriptPath: SCRIPT_PATH,
            scriptSha256: sha256File(SCRIPT_PATH)
        },
        options: { skipIntegrity, memoryLimit, storageTopK, chatLimit, expectedDim, scratchDir: resolvedScratchDir, embedRetryDelayMs: retryDelayMs },
        embed: embedder.stats,
        lanes: { memory: [], storage: [], chat: [] },
        coverage: {},
        probe: null,
        metrics: null,
        errors,
        definitions: {
            memoryLexical: 'lowercase [a-z0-9]{3,} tokens, dedup, max 8; nDB textSearch description+data, mode AND; leading 6/4 retries; cap 50; mem_ only',
            memorySemantic: 'query embed + memory collection search with production topK: max(limit*5,25)',
            memoryHybrid: 'lexical boost +0.10 capped at 1; lexical-only score 0.45; weightedScore = score*(0.7+confidence*0.3); sort weighted desc',
            storage: 'query embed + storage collection search topK: max(top_k*3,30), cosine, approximate false; min-max normalize; sort normalized; dedup id and contentHash#splitIdx; max 3 chunks/path; slice top_k',
            storageEvidence: 'content evidence maps payload.path onto the lab work copy and slices charOffset/charLen — payload.absolutePath is never read',
            chatSemantic: 'embeddings collection search with production\'s top_k: limit*3 — a spelling the native layer ignores, so the request falls back to the native default of 10 results; payload chatId/msgIdx maps to a message; dedup chatId#idx; limit',
            chatKeyword: 'literal case-insensitive whole-query substring in conversation order, score 0; kept separate from the semantic lane',
            recallAt10: 'fraction of expected targets whose rank is <= 10',
            exactHitAt5: 'fraction of expected targets whose rank is <= 5',
            nonsenseControl: 'max score recorded verbatim; no rejection threshold is inferred',
            sourceIntent: 'storage paths are bucketed own(blog/ arena/ research/ sessions/) vs thirdParty(fetch/) from the path prefix; fetch/ is measured, never excluded',
            targetRanks: 'every lane keeps its own target rank map — memory: lexical (textSearch doc order), semantic (nVDB hit order), hybrid (weighted order); storage: raw (semantic score order) and final (after min-max, dedup, per-path cap). null means the target never entered that lane window.',
            memorySkipReasons: 'a semantic hit is joined to nDB through DB.get(id); ANY thrown get is recorded as "tombstoned" because the production lane catches every error, so a corrupt vector or an id mismatch is indistinguishable from a soft-deleted document. Phase 0 reports the count per case and deliberately keeps the production-shaped skip.',
            nvdbStats: 'coverage.memory.nvdb / coverage.storage.nvdb carry the nVDB collection config and native stats; coverage.*.reconcile compares totalSegmentDocs with the vectors actually found',
            embedRetry: 'exactly one bounded retry (default 250 ms) for a transient TypeError / "fetch failed" only; attempts, retries, recoveries and the initial failure are recorded under embed; every other error is thrown immediately with no retry'
        }
    };

    const casesWithErrors = [];
    const caseRun = async (bucket, id, fn) => {
        try {
            const result = await fn();
            report.lanes[bucket].push(result);
            return result;
        } catch (e) {
            const failure = { id, bucket, error: e.message, stack: String(e.stack ?? '').split('\n').slice(0, 4).join(' | ') };
            errors.push(failure);
            casesWithErrors.push(failure);
            report.lanes[bucket].push({ id, ok: false, error: e.message });
            return null;
        }
    };

    const nvdb = openNvdbDatabase(openNvdb, layout.nvdbDir);
    let storageColl = null;
    let memoryColl = null;
    let memoryDb = null;
    let staged = null;
    try {
        const collections = nvdb.listCollections();
        if (!collections.includes('memory')) throw new Error(`nVDB at ${layout.nvdbDir} has no "memory" collection (has: ${collections.join(', ')})`);
        if (!collections.includes('storage')) throw new Error(`nVDB at ${layout.nvdbDir} has no "storage" collection (has: ${collections.join(', ')})`);
        memoryColl = nvdb.getCollection('memory');
        storageColl = nvdb.getCollection('storage');

        // ── memory lanes ────────────────────────────────────────────────
        staged = stageMemoryDb({ guard, memoryDir: layout.memoryDir, scratchDir: resolvedScratchDir });
        const { Database } = openNdb();
        memoryDb = Database.open(staged.journalPath, { persistence: 'lazy' });
        memoryDb.createTextIndex('description');
        memoryDb.createTextIndex('data');
        const memoryDocs = memoryDb.iter();

        for (const suiteCase of suite.memory) {
            await caseRun('memory', suiteCase.id, () => runMemoryLane({
                suiteCase, db: memoryDb, coll: memoryColl, embedder, expectedDim, category: suiteCase.category ?? null, defaultLimit: memoryLimit
            }));
        }

        // ── storage lanes ───────────────────────────────────────────────
        guard.assertWork(layout.storageDir, 'storage work copy');
        for (const suiteCase of suite.storage) {
            await caseRun('storage', suiteCase.id, () => runStorageLane({
                suiteCase: { ...suiteCase, top_k: suiteCase.top_k ?? storageTopK },
                coll: storageColl,
                embedder,
                storageWorkRoot: layout.storageDir,
                guard,
                sourceIntent: suite.sourceIntent ?? { ownPrefixes: [], thirdPartyPrefixes: [] }
            }));
        }

        // ── chat lanes ──────────────────────────────────────────────────
        const chatUser = suite.dataset?.chatUser;
        if (!chatUser) throw new Error('golden suite dataset.chatUser is required to locate the chat database');
        const chatUserDir = guard.assertWork(path.join(layout.chatDataDir, chatUser), `chat user directory ${chatUser}`);
        const chatDbPath = guard.assertWork(path.join(chatUserDir, 'data.jsonl'), `chat database ${chatUser}`);
        if (!fs.existsSync(chatDbPath)) throw new Error(`chat database missing: ${chatDbPath}`);
        const chatNvdbDir = guard.assertWork(path.join(chatUserDir, 'nvdb'), `chat nVDB ${chatUser}`);

        const { Database: ChatDatabase } = openNdb();
        const chatDb = ChatDatabase.open(chatDbPath, { persistence: 'lazy' });
        try {
            const conversations = chatDb.find('_type', 'conversation');
            const sessions = chatDb.find('_type', 'session');

            const chatNvdb = openNvdbDatabase(openNvdb, chatNvdbDir);
            let chatEmbeddings = null;
            let chatEmbeddingsStats = null;
            try {
                const chatCollections = chatNvdb.listCollections();
                if (!chatCollections.includes('embeddings')) {
                    throw new Error(`chat nVDB at ${chatNvdbDir} has no "embeddings" collection (has: ${chatCollections.join(', ')})`);
                }
                chatEmbeddings = chatNvdb.getCollection('embeddings');
                const stats = typeof chatEmbeddings.stats === 'function' ? chatEmbeddings.stats() : chatEmbeddings.stats;
                const statsByName = {};
                for (const name of chatCollections) {
                    if (name === 'embeddings') { statsByName[name] = stats; continue; }
                    const c = chatNvdb.getCollection(name);
                    try {
                        statsByName[name] = typeof c.stats === 'function' ? c.stats() : c.stats;
                    } finally {
                        if (typeof c.close === 'function') c.close();
                    }
                }
                chatEmbeddingsStats = { collections: chatCollections, stats: statsByName };

                const contamination = detectChatContamination({
                    conversations,
                    contaminationSessionId: suite.dataset?.contaminationSessionId
                });

                const indexes = new Map();
                const indexFor = (role) => {
                    const key = role ?? 'all';
                    if (!indexes.has(key)) indexes.set(key, buildChatIndex({ conversations, sessions, role: key === 'all' ? null : key }));
                    return indexes.get(key);
                };

                for (const suiteCase of suite.chat) {
                    await caseRun('chat', suiteCase.id, () => runChatLane({
                        suiteCase,
                        index: indexFor(suiteCase.roleFilter ?? 'all'),
                        embeddingsColl: chatEmbeddings,
                        embedder,
                        limit: suiteCase.limit ?? chatLimit,
                        contamination
                    }));
                }

                report.coverage.chat = {
                    user: chatUser,
                    databasePath: chatDbPath,
                    inventory: chatInventory({
                        db: chatDb,
                        conversations,
                        sessions,
                        embeddingsStats: chatEmbeddingsStats,
                        expectedDim,
                        contamination
                    }),
                    conversationOrder: {
                        source: 'nDB find("_type","conversation") iteration order',
                        sample: conversations.slice(0, 10).map((c) => c.id),
                        chronologicalSample: [...conversations]
                            .sort((a, b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0))
                            .slice(0, 10)
                            .map((c) => c.id),
                        deterministicAcrossProcesses: false,
                        note: 'nDB document order is a HashMap order whose seed is process-dependent, so the production keyword lane\'s "conversation order" is neither chronological nor stable across runs. The sample below is this run\'s order.'
                    },
                    contamination
                };
            } finally {
                if (chatEmbeddings && typeof chatEmbeddings.close === 'function') {
                    try { chatEmbeddings.close(); } catch (e) { errors.push({ id: 'close-chat-embeddings', bucket: 'teardown', error: e.message }); }
                }
                if (typeof chatNvdb.close === 'function') {
                    try { chatNvdb.close(); } catch (e) { errors.push({ id: 'close-chat-nvdb', bucket: 'teardown', error: e.message }); }
                }
            }
        } finally {
            chatDb.close();
        }

        // ── probe: topK vs top_k ────────────────────────────────────────
        const probeId = suite.explicitVectorIds?.[0];
        const probeRecord = probeId ? storageColl.get(probeId) : null;
        if (probeRecord) {
            report.probe = { vectorSource: probeId, ...(await probeTopK({ coll: storageColl, vector: probeRecord.vector, k: 30 })) };
        } else {
            const firstMemory = memoryDocs.find((d) => d._id?.startsWith('mem_'));
            const memoryRecord = firstMemory ? memoryColl.get(firstMemory._id) : null;
            if (!memoryRecord) throw new Error('probe: no stored vector available (neither probe chunk nor memory vector)');
            report.probe = { vectorSource: `memory:${firstMemory._id}`, ...(await probeTopK({ coll: memoryColl, vector: memoryRecord.vector, k: 30 })) };
        }

        // ── integrity / coverage ────────────────────────────────────────
        report.coverage.explicitVectors = explicitVectorProbe({
            ids: suite.explicitVectorIds ?? [],
            coll: storageColl,
            expectedDim
        });

        if (skipIntegrity) {
            report.coverage.memory = { skipped: true, reason: '--skip-integrity', nvdb: describeCollection('memory', memoryColl) };
            report.coverage.storage = { skipped: true, reason: '--skip-integrity', nvdb: describeCollection('storage', storageColl) };
        } else {
            const coverageStarted = Date.now();
            const memoryStats = describeCollection('memory', memoryColl);
            const memoryVectors = memoryCoverage({ docs: memoryDocs, coll: memoryColl, expectedDim });
            report.coverage.memory = {
                ...memoryVectors,
                nvdb: memoryStats,
                reconcile: {
                    activeMemDocuments: memoryVectors.activeMemDocuments,
                    vectorsPresent: memoryVectors.vectorsPresent,
                    segmentDocs: memoryStats.stats?.totalSegmentDocs ?? null,
                    segmentMinusPresent: memoryStats.stats?.totalSegmentDocs != null
                        ? memoryStats.stats.totalSegmentDocs - memoryVectors.vectorsPresent
                        : null
                },
                textIndexSource: {
                    stagedCopy: true,
                    journalSha256: staged.journalSha256,
                    textIndexCachesCopied: staged.textIndexCacheCopied,
                    note: 'the memory nDB journal is opened from a scratch copy because createTextIndex() rewrites a stale .fti cache — that write must never land in the lab'
                }
            };
            const memoryCoverageMs = Date.now() - coverageStarted;

            const scanOnly = suite.dataset?.storageCoverageLimit ?? null;
            const chunkIds = chunkIdsFromScanIndex(JSON.parse(fs.readFileSync(guard.assertWork(layout.scanIndexPath, 'nvdb scan-index.json'), 'utf8')));
            const idsToCheck = scanOnly ? chunkIds.slice(0, scanOnly) : chunkIds;
            const storageStarted = Date.now();
            const storageStats = describeCollection('storage', storageColl);
            const storageVectors = storageCoverage({ ids: idsToCheck, coll: storageColl, expectedDim });
            report.coverage.storage = {
                scanIndex: {
                    path: layout.scanIndexPath,
                    sha256: sha256File(layout.scanIndexPath),
                    chunkIds: chunkIds.length,
                    checkedIds: idsToCheck.length,
                    truncated: !!scanOnly
                },
                ...storageVectors,
                nvdb: storageStats,
                reconcile: {
                    requestedIds: storageVectors.requestedIds,
                    vectorsPresent: storageVectors.vectorsPresent,
                    segmentDocs: storageStats.stats?.totalSegmentDocs ?? null,
                    segmentMinusPresent: storageStats.stats?.totalSegmentDocs != null
                        ? storageStats.stats.totalSegmentDocs - storageVectors.vectorsPresent
                        : null
                }
            };
            report.coverage.timings = { memoryCoverageMs, storageCoverageMs: Date.now() - storageStarted };
        }
    } finally {
        if (memoryDb) {
            try { memoryDb.close(); } catch (e) { errors.push({ id: 'close-memory-db', bucket: 'teardown', error: e.message }); }
        }
        if (typeof memoryColl?.close === 'function') {
            try { memoryColl.close(); } catch (e) { errors.push({ id: 'close-memory-coll', bucket: 'teardown', error: e.message }); }
        }
        if (typeof storageColl?.close === 'function') {
            try { storageColl.close(); } catch (e) { errors.push({ id: 'close-storage-coll', bucket: 'teardown', error: e.message }); }
        }
        if (typeof nvdb.close === 'function') {
            try { nvdb.close(); } catch (e) { errors.push({ id: 'close-nvdb', bucket: 'teardown', error: e.message }); }
        }
        removeScratch(staged?.dir ?? resolvedScratchDir, scratchArea);
    }

    report.metrics = buildMetrics({
        memoryLanes: report.lanes.memory,
        storageLanes: report.lanes.storage,
        chatLanes: report.lanes.chat,
        probe: report.probe,
        coverage: report.coverage
    });
    report.ok = casesWithErrors.length === 0 && errors.length === 0;
    const finishedAt = now();
    report.finishedAt = finishedAt.toISOString();
    report.totalDurationMs = finishedAt.getTime() - startedAt.getTime();
    return report;
}

// Chunk ids exactly as the scanner builds them: `collection:relpath` for a
// single-chunk file, `${docBaseId}#${i}` otherwise.
export function chunkIdsFromScanIndex(scanIndex) {
    const files = scanIndex?.files;
    if (!files || typeof files !== 'object') throw new Error('chunkIdsFromScanIndex: scan-index has no files map');
    const ids = [];
    for (const [base, entry] of Object.entries(files)) {
        const chunks = entry.chunks;
        if (!Number.isInteger(chunks) || chunks < 1) throw new Error(`chunkIdsFromScanIndex: invalid chunk count for ${base}: ${chunks}`);
        if (chunks === 1) ids.push(base);
        else for (let i = 0; i < chunks; i++) ids.push(`${base}#${i}`);
    }
    return ids;
}

function readPackageVersion(repoRoot) {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return pkg.version ?? null;
}

export function writeReport(report, reportsDir, stamp = new Date()) {
    fs.mkdirSync(reportsDir, { recursive: true });
    const name = `phase0-${stamp.toISOString().replace(/[:.]/g, '-')}.json`;
    const file = path.join(reportsDir, name);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
}

export function summarize(report) {
    const lines = [];
    const m = report.metrics ?? {};
    const fmt = (v) => (v === null || v === undefined ? 'n/a' : typeof v === 'number' ? v.toFixed(3) : String(v));
    lines.push(`memory-lab-phase0  ok=${report.ok}`);
    lines.push(`snapshot   ${report.snapshot.root}`);
    lines.push(`manifest   ${String(report.snapshot.manifestSha256).slice(0, 16)}  mode=${report.snapshot.mode}`);
    lines.push(`golden     ${report.golden.suiteVersion} (${report.golden.memoryCases}/${report.golden.storageCases}/${report.golden.chatCases} cases)`);
    lines.push(`embeds     ${report.embed.calls} call(s), ${report.embed.chars} chars, ${report.embed.attempts} attempt(s), ${report.embed.retries} retry(ies)`);
    for (const lane of ['memory', 'storage', 'chat']) {
        const agg = m[lane] ?? {};
        const d = m.durations?.[lane] ?? {};
        lines.push(`${lane.padEnd(10)} cases=${report.lanes[lane].length} recall@10=${fmt(agg.recallAt10)} hit@5=${fmt(agg.exactHitAt5)} p95=${d.p95Ms ?? 'n/a'}ms`);
    }
    if (m.nonsenseControl) {
        lines.push(`nonsense   semanticMax=${fmt(m.nonsenseControl.maxSemanticScore)} hybridMax=${fmt(m.nonsenseControl.maxHybridScore)}`);
    }
    if (report.probe) {
        lines.push(`probe      topK:30->${report.probe.topK.returned}  top_k:30->${report.probe.top_k.returned}`);
    }
    const mem = report.coverage.memory;
    if (mem && !mem.skipped) lines.push(`memory     active=${mem.activeMemDocuments} present=${mem.vectorsPresent} missing=${mem.vectorsMissing} seg=${mem.nvdb?.stats?.totalSegmentDocs ?? 'n/a'} dupVectors=${mem.duplicateVectors}`);
    const sto = report.coverage.storage;
    if (sto && !sto.skipped) lines.push(`storage    ids=${sto.requestedIds} present=${sto.vectorsPresent} missing=${sto.vectorsMissing} seg=${sto.nvdb?.stats?.totalSegmentDocs ?? 'n/a'} dupVectors=${sto.duplicateVectors}`);
    const ex = report.coverage.explicitVectors;
    if (ex) lines.push(`explicit5  present=${ex.present} distinct=${ex.distinctHashes} identicalPairs=${ex.identicalPairs.length}`);
    const contam = report.coverage.chat?.contamination;
    if (contam) lines.push(`contam     archiveShaped=${contam.totals.archiveShaped} embedded=${contam.totals.archiveShapedEmbedded} sessionFound=${contam.contaminationSession.found}`);
    for (const err of report.errors ?? []) lines.push(`ERROR      ${err.bucket}/${err.id}: ${err.error}`);
    lines.push(`duration   ${report.totalDurationMs}ms`);
    return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
    const args = { snapshot: null, skipIntegrity: false };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--snapshot' || token === '--snapshot-root' || token === '--snapshotRoot') args.snapshot = argv[++i];
        else if (token.startsWith('--snapshot=')) args.snapshot = token.slice('--snapshot='.length);
        else if (token === '--skip-integrity') args.skipIntegrity = true;
        else throw new Error(`unknown argument: ${token}`);
    }
    if (!args.snapshot) throw new Error('missing --snapshot <snapshot root>');
    return args;
}

// Embedder backed by the existing embed client, configured from config.json.
// The access key is passed through but never printed or stored in the report.
async function createGatewayEmbedder(repoRoot) {
    const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8'));
    const httpUrl = config.gateway?.httpUrl;
    if (!httpUrl) throw new Error('config.json gateway.httpUrl is required to embed queries');
    const client = await import(pathToFileURL(path.join(repoRoot, 'src', 'embed-client.js')).href);
    const embedClient = client.createEmbedClient(httpUrl, config.gateway?.accessKey ?? null);
    return { embed: (text) => embedClient.embed(text) };
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const embedder = await createGatewayEmbedder(REPO_ROOT);

    const report = await runPhase0({
        snapshot: args.snapshot,
        embedder,
        skipIntegrity: args.skipIntegrity,
        openNdb: loadNdb,
        openNvdb: loadNvdb
    });

    const layout = resolveSnapshotLayout(args.snapshot);
    const file = writeReport(report, layout.reportsDir, new Date(report.finishedAt));
    process.stdout.write(`${summarize(report)}\n\nreport: ${file}\n`);
    if (!report.ok) process.exitCode = 1;
    return { report, file };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);
if (invokedDirectly) {
    main().catch((e) => {
        process.stderr.write(`memory-lab-phase0 failed: ${e.message}\n${e.stack ?? ''}\n`);
        process.exitCode = 1;
    });
}
