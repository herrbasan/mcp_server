// Phase 0 lab diagnostics — offline fixture tests.
//
//   node tests/memory-lab-phase0.test.mjs
//
// Every fixture is a tiny native nDB / nVDB database with 8-dim vectors, built
// under tests/fixtures/.tmp-phase0-<pid> and removed afterwards.  Nothing here
// touches the real lab snapshot, live storage, the Gateway or any service.

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import {
    runPhase0,
    writeReport,
    summarize,
    loadGoldenSuite,
    resolveSnapshotLayout,
    resolveScratchArea,
    assertScratchLocation,
    removeScratch,
    wrapEmbedder,
    isTransientFetchError,
    lexicalTokens,
    memoryLexicalRecall,
    memoryHybridRank,
    memorySemanticTopK,
    minMaxNormalize,
    rankStorageMatches,
    readChunkEvidence,
    sourceIntentSummary,
    buildChatIndex,
    chatIndexBaseline,
    chatSemanticLane,
    chatKeywordLane,
    detectChatContamination,
    looksLikeArchiveSearchOutput,
    probeTopK,
    vectorHash,
    analyzeVector,
    memoryCoverage,
    storageCoverage,
    explicitVectorProbe,
    chunkIdsFromScanIndex,
    percentile,
    LEXICAL_BASE,
    LEXICAL_BOOST,
    MAX_CHUNKS_PER_FILE
} from '../scripts/memory-lab-phase0.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP = path.join(REPO_ROOT, 'tests', 'fixtures', `.tmp-phase0-${process.pid}`);

// ── harness ──────────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];
const results = [];

async function test(name, fn) {
    try {
        await fn();
        passed++;
        results.push({ name, ok: true });
        process.stdout.write(`ok    ${name}\n`);
    } catch (e) {
        failures.push({ name, error: e.message });
        results.push({ name, ok: false, error: e.message });
        process.stdout.write(`FAIL  ${name}\n      ${e.message}\n`);
    }
}

function approx(actual, expected, eps = 1e-9, label = '') {
    assert.ok(Math.abs(actual - expected) <= eps, `${label}: expected ${expected} ±${eps}, got ${actual}`);
}

function freshDir(name) {
    const dir = path.join(TMP, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function basis(index, dim = 8) {
    const v = new Array(dim).fill(0);
    v[index] = 1;
    return v;
}

function buildNdb(file, entries) {
    const { Database } = loadNdb();
    const db = Database.open(file, { persistence: 'immediate' });
    const ids = [];
    for (const entry of entries) {
        ids.push(entry.prefix ? db.insertWithPrefix(entry.prefix, entry.doc) : db.insert(entry.doc));
    }
    db.flush();
    return { db, ids };
}

function buildNvdb(dir, spec) {
    const { Database } = loadNvdb();
    const db = new Database(dir);
    const colls = {};
    for (const [name, collSpec] of Object.entries(spec)) {
        const coll = db.createCollection(name, collSpec.dim);
        for (const doc of collSpec.docs) {
            coll.insert(doc.id, doc.vector, doc.payload === undefined ? null : JSON.stringify(doc.payload));
        }
        if (typeof coll.flush === 'function') coll.flush();
        colls[name] = coll;
    }
    return { db, colls };
}

function closeNvdb({ db, colls }) {
    for (const coll of Object.values(colls ?? {})) if (typeof coll.close === 'function') coll.close();
    if (typeof db.close === 'function') db.close();
}

function mapEmbedder(map, dim = 8) {
    return {
        async embed(text) {
            if (Object.prototype.hasOwnProperty.call(map, text)) return map[text];
            // Deterministic fallback so an unmapped query still yields a vector.
            const v = new Array(dim).fill(0);
            for (let i = 0; i < String(text).length; i++) v[i % dim] += (String(text).charCodeAt(i) % 17) / 17;
            return v;
        }
    };
}

// ── golden suite ─────────────────────────────────────────────────────────────

await test('golden suite loads and carries the versioned case counts', () => {
    const suite = loadGoldenSuite();
    assert.equal(suite.suiteVersion, 'phase0-2026-11-17');
    assert.equal(suite.version, 1);
    assert.equal(suite.memory.length, 4);
    assert.equal(suite.storage.length, 5);
    assert.equal(suite.chat.length, 3);
    assert.equal(suite.explicitVectorIds.length, 5);
    const nonsense = suite.memory.find((c) => c.control === 'nonsense');
    assert.ok(nonsense, 'nonsense control case missing');
    assert.deepEqual(nonsense.relevantIds, [], 'nonsense control must not claim a relevant id');
    assert.deepEqual(suite.memory[0].relevantIds, [6911, 6931, 6795]);

    // the scout's chat label was corrected after parsing the capture the issue cites
    const userCase = suite.chat.find((c) => c.id === 'chat-ai-consciousness-semantic-user');
    assert.deepEqual(userCase.relevant[0].idx, [30, 41], 'capture confirms idx41 (emotion) + idx30 (definition), not 310');
    assert.equal(userCase.correction.from, 310);
    assert.equal(userCase.correction.to, 41);
    assert.match(userCase.correction.verifiedBy, /idx307/);
    assert.equal(userCase.correction.captured.length, 2);
    assert.equal(userCase.correction.captured[0].resolvedIdx, 41);
    assert.equal(userCase.correction.captured[0].score, 0.759452223777771);
    assert.equal(userCase.correction.captured[1].resolvedIdx, 30);
    assert.equal(userCase.correction.captured[1].score, 0.7406330108642578);
    assert.match(userCase.correction.reason, /messageCount 502/);
    assert.match(userCase.correction.reason, /not preserved/);
    assert.equal(suite.corrections.length, 1);
    assert.equal(suite.corrections[0].to, 41);
    assert.match(suite.corrections[0].reason, /no idx field/i);
});

await test('golden suite loader rejects a case without a lane', () => {
    const bad = path.join(freshDir('bad-golden'), 'golden.json');
    fs.writeFileSync(bad, JSON.stringify({ suiteVersion: 'x', memory: [], storage: [], chat: [{ id: 'a', query: 'b', lane: 'nope' }] }));
    assert.throws(() => loadGoldenSuite(bad), /lane must be/);
});

// ── memory lexical lane ──────────────────────────────────────────────────────

await test('lexicalTokens matches the production rule (lowercase, 3+ chars, dedup, max 8)', () => {
    assert.deepEqual(lexicalTokens('nTeligence'), ['nteligence']);
    assert.deepEqual(lexicalTokens('Prototype Fund 47.5k application November 30 funding'), ['prototype', 'fund', 'application', 'november', 'funding']);
    assert.deepEqual(lexicalTokens('a bb ccc ccc'), ['ccc']);
    const many = lexicalTokens('aaa bbb ccc ddd eee fff ggg hhh iii jjj');
    assert.equal(many.length, 8);
});

await test('memory lexical recall: strict AND, leading-6 retry, mem_ only, cap 50', () => {
    const dir = freshDir('lexical');
    const file = path.join(dir, 'data.jsonl');
    const { db, ids } = buildNdb(file, [
        { prefix: 'mem', doc: { id: 1, category: 'a', confidence: 1, description: 'alpha beta gamma delta epsilon zeta' } },
        { prefix: 'mem', doc: { id: 2, category: 'a', confidence: 1, description: 'alpha beta gamma delta epsilon' } },
        { prefix: 'note', doc: { id: 3, category: 'a', confidence: 1, description: 'alpha beta gamma delta epsilon zeta' } }
    ]);
    try {
        db.createTextIndex('description');
        db.createTextIndex('data');

        // 8 tokens: only the leading 6 exist -> strict AND is empty, retry at 6 hits.
        const result = memoryLexicalRecall({ db, query: 'alpha beta gamma delta epsilon zeta eta theta' });
        assert.equal(result.attempts[0].n, 8);
        assert.equal(result.attempts[0].ids, 0, 'strict 8-token AND must be empty');
        assert.ok(result.attempts.some((a) => a.n === 6 && a.ids > 0), `expected a 6-token retry hit, attempts=${JSON.stringify(result.attempts)}`);
        assert.equal(result.idsAttempt, 6);
        assert.deepEqual(result.docs.map((d) => d.id), [1], 'the non-mem_ document must be dropped');

        // 5 tokens (below the retry window): strict AND only.
        const five = memoryLexicalRecall({ db, query: 'alpha beta gamma delta epsilon' });
        assert.equal(five.attempts.length, 1);
        assert.deepEqual(five.docs.map((d) => d.id).sort(), [1, 2]);
        assert.equal(ids.length, 3);
    } finally {
        db.close();
    }
});

await test('memory lexical recall: category filter and data-field matches', () => {
    const dir = freshDir('lexical-category');
    const { db } = buildNdb(path.join(dir, 'data.jsonl'), [
        { prefix: 'mem', doc: { id: 10, category: 'funding', confidence: 1, description: 'prototype fund note' } },
        { prefix: 'mem', doc: { id: 11, category: 'other', confidence: 1, description: 'prototype fund note' } },
        { prefix: 'mem', doc: { id: 12, category: 'funding', confidence: 1, description: 'something else', data: 'prototype fund in the data field' } }
    ]);
    try {
        db.createTextIndex('description');
        db.createTextIndex('data');
        const all = memoryLexicalRecall({ db, query: 'prototype fund' });
        assert.deepEqual(all.docs.map((d) => d.id).sort(), [10, 11, 12], 'both description and data fields must match');
        const funding = memoryLexicalRecall({ db, query: 'prototype fund', category: 'funding' });
        assert.deepEqual(funding.docs.map((d) => d.id).sort(), [10, 12]);
        assert.equal(funding.skipped.category, 1);
    } finally {
        db.close();
    }
});

// ── memory hybrid lane ───────────────────────────────────────────────────────

await test('memory hybrid: boost, lexical base, confidence weighting and sort order', () => {
    const lexicalDocs = [
        { _id: 'mem_s1', id: 200, category: 'a', confidence: 0.8, description: 'semantic and lexical' },
        { _id: 'mem_s3', id: 202, category: 'a', confidence: 1, description: 'near perfect semantic and lexical' },
        { _id: 'mem_l1', id: 100, category: 'a', confidence: 1, description: 'lexical only high conf' },
        { _id: 'mem_l2', id: 101, category: 'a', confidence: 0.5, description: 'lexical only low conf' }
    ];
    const docsById = new Map([
        ['mem_s1', { _id: 'mem_s1', id: 200, category: 'a', confidence: 0.8, description: 'semantic and lexical' }],
        ['mem_s2', { _id: 'mem_s2', id: 201, category: 'a', confidence: 0.5, description: 'semantic only' }],
        ['mem_s3', { _id: 'mem_s3', id: 202, category: 'a', confidence: 1, description: 'near perfect semantic' }]
    ]);
    const safeGet = (id) => ({ doc: docsById.get(id) ?? null, missing: !docsById.has(id), tombstoned: false });

    const { ranked, stats } = memoryHybridRank({
        semanticHits: [
            { id: 'mem_s1', score: 0.5 },
            { id: 'mem_s3', score: 0.98 },
            { id: 'mem_s2', score: 0.4 }
        ],
        lexicalDocs,
        safeGet,
        category: null,
        limit: 10
    });

    const byId = new Map(ranked.map((r) => [r.id, r]));
    // in both legs: min(1, 0.5 + 0.10) = 0.6, weighted 0.6 * (0.7 + 0.8*0.3) = 0.564
    approx(byId.get(200).score, 0.6, 1e-12, 'boosted score');
    approx(byId.get(200).weightedScore, 0.6 * (0.7 + 0.8 * 0.3), 1e-12, 'boosted weighted score');
    assert.equal(byId.get(200).lexical, true);
    // boost is capped at 1
    approx(byId.get(202).score, 1, 1e-12, 'capped boost');
    // lexical only: 0.45 * (0.7 + conf*0.3)
    approx(byId.get(100).score, LEXICAL_BASE, 1e-12, 'lexical base score');
    approx(byId.get(100).weightedScore, LEXICAL_BASE * (0.7 + 1 * 0.3), 1e-12, 'lexical weighted score');
    approx(byId.get(101).weightedScore, LEXICAL_BASE * (0.7 + 0.5 * 0.3), 1e-12, 'low-confidence lexical weighted score');
    // weighted desc
    const weights = ranked.map((r) => r.weightedScore);
    assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
    assert.equal(ranked[0].id, 202);
    assert.equal(stats.semanticHits, 3);
    assert.equal(LEXICAL_BOOST, 0.10);
});

await test('memory hybrid: tombstoned, missing and non-memory hits are skipped, not thrown', () => {
    const safeGet = (id) => {
        if (id === 'mem_gone') return { doc: null, tombstoned: true, missing: false };
        if (id === 'mem_missing') return { doc: null, tombstoned: false, missing: true };
        if (id === 'other_1') return { doc: { _id: 'other_1', id: 9, confidence: 1 }, tombstoned: false, missing: false };
        return { doc: { _id: id, id: 500, confidence: 1, category: 'a' }, tombstoned: false, missing: false };
    };
    const { ranked, stats } = memoryHybridRank({
        semanticHits: [{ id: 'mem_gone', score: 0.9 }, { id: 'mem_missing', score: 0.9 }, { id: 'other_1', score: 0.9 }, { id: 'mem_ok', score: 0.9 }],
        lexicalDocs: [],
        safeGet,
        category: null,
        limit: 10
    });
    assert.deepEqual(ranked.map((r) => r.id), [500]);
    assert.equal(stats.tombstoned, 1);
    assert.equal(stats.missing, 1);
    assert.equal(stats.nonMemory, 1);
});

await test('memory semantic topK follows production max(limit*5, 25)', () => {
    assert.equal(memorySemanticTopK(1), 25);
    assert.equal(memorySemanticTopK(5), 25);
    assert.equal(memorySemanticTopK(10), 50);
});

// ── storage lane ─────────────────────────────────────────────────────────────

await test('storage: min-max normalization and the all-equal guard', () => {
    const normalized = minMaxNormalize([0.9, 0.8, 0.7]);
    approx(normalized[0], 1, 1e-12, 'max normalizes to 1');
    approx(normalized[1], 0.5, 1e-12, 'midpoint normalizes to 0.5');
    approx(normalized[2], 0, 1e-12, 'min normalizes to 0');
    assert.deepEqual(minMaxNormalize([0.5, 0.5]), [0, 0], 'a zero range must not divide by zero');
});

function storageMatch(id, payload, score) {
    return { collection: 'storage', id, score, payload: JSON.stringify(payload) };
}

await test('storage ranking: sort by normalized, dedup id + contentHash#splitIdx, max 3 per path, slice topK', () => {
    const matches = [
        storageMatch('a#0', { path: 'blog/a.md', contentHash: 'hA', splitIdx: 0 }, 0.9),
        storageMatch('a#0', { path: 'blog/a.md', contentHash: 'hA', splitIdx: 0 }, 0.9), // duplicate id
        storageMatch('b#0', { path: 'blog/b.md', contentHash: 'hA', splitIdx: 0 }, 0.8), // duplicate content key
        storageMatch('a#1', { path: 'blog/a.md', contentHash: 'hA', splitIdx: 1 }, 0.7),
        storageMatch('a#2', { path: 'blog/a.md', contentHash: 'hA', splitIdx: 2 }, 0.6),
        storageMatch('a#3', { path: 'blog/a.md', contentHash: 'hA', splitIdx: 3 }, 0.5) // 4th chunk of the same path -> dropped
    ];
    const { records, deduped } = rankStorageMatches(matches, 10);
    assert.equal(records.length, 6);
    assert.equal(deduped.length, 3, `expected 3 survivors, got ${deduped.map((d) => d.id)}`);
    assert.deepEqual(deduped.map((d) => d.id), ['a#0', 'a#1', 'a#2']);
    approx(deduped[0].normalizedScore, 1, 1e-12, 'top normalized');
    const slice = rankStorageMatches(matches, 2);
    assert.equal(slice.deduped.length, 2);
    assert.equal(MAX_CHUNKS_PER_FILE, 3);
});

await test('storage evidence maps payload.path onto the work copy and never reads absolutePath', () => {
    const workStorage = freshDir('storage-work');
    const relDir = path.join(workStorage, 'blog', 'attic');
    fs.mkdirSync(relDir, { recursive: true });
    const content = 'WORK-COPY-EVIDENCE-CONTENT-THAT-IS-LONG-ENOUGH';
    fs.writeFileSync(path.join(relDir, 'consciousness-is-the-record.md'), content);

    // The live-looking absolutePath points at a file that does not exist: if the
    // lane used it, evidence would be unavailable.
    const payload = {
        path: 'blog/attic/consciousness-is-the-record.md',
        absolutePath: 'D:\\MCP_Storage\\blog\\attic\\consciousness-is-the-record.md',
        contentHash: 'h1',
        splitIdx: 0,
        charOffset: 0,
        charLen: 20
    };
    const evidence = readChunkEvidence(payload, workStorage);
    assert.equal(evidence.available, true);
    assert.equal(evidence.source, 'work-copy');
    assert.equal(evidence.preview, content.slice(0, 20));
    assert.ok(!evidence.preview.includes('MCP_Storage'));

    // A poison absolutePath that DOES exist must still be ignored.
    const poisonDir = freshDir('poison');
    const poisonFile = path.join(poisonDir, 'live.md');
    fs.writeFileSync(poisonFile, 'POISON-LIVE-CONTENT-SHOULD-NEVER-BE-READ');
    const poisoned = readChunkEvidence({ ...payload, absolutePath: poisonFile }, workStorage);
    assert.equal(poisoned.preview, content.slice(0, 20));
    assert.ok(!poisoned.preview.includes('POISON'));

    // Missing charOffset/charLen -> no content evidence at all.
    const bare = readChunkEvidence({ path: payload.path, absolutePath: poisonFile }, workStorage);
    assert.equal(bare.available, false);
    assert.match(bare.reason, /charOffset/);
});

await test('storage source-intent buckets own prefixes vs fetch/', () => {
    const intent = { ownPrefixes: ['blog/', 'arena/', 'research/', 'sessions/'], thirdPartyPrefixes: ['fetch/'] };
    const summary = sourceIntentSummary(['blog/a.md', 'fetch/b.md', 'research/c.md', 'misc/d.md'], intent);
    assert.deepEqual({ own: summary.own, thirdParty: summary.thirdParty, other: summary.other }, { own: 2, thirdParty: 1, other: 1 });
    approx(summary.thirdPartyShare, 0.25, 1e-12, 'third-party share');
});

// ── chat lane ────────────────────────────────────────────────────────────────

function chatFixture() {
    const conversations = [
        {
            id: 'chat_orig',
            title: 'The project!',
            mode: 'direct',
            messages: [
                { id: 'm0', idx: 0, role: 'user', content: 'hello there', embedStatus: 'embedded' },
                { id: 'm1', idx: 1, role: 'assistant', content: '', embedStatus: 'embedded' },
                { id: 'm2', idx: 2, role: 'tool', toolName: 'chat_archive_search', content: '{"query":"x","method":"semantic","results":[]}', embedStatus: 'embedded' },
                { id: 'm3', idx: 3, role: 'user', content: 'I think you are aware of your own thinking and relation to other thinking things', embedStatus: 'embedded' }
            ]
        },
        {
            id: 'chat_copy',
            title: 'Contaminated',
            mode: 'direct',
            messages: [
                { id: 'c0', idx: 0, role: 'tool', toolName: 'chat_archive_search', content: '{"query":"AI consciousness","method":"semantic","results":[{"score":0.9}]}', embedStatus: 'embedded' },
                { id: 'c1', idx: 1, role: 'assistant', content: 'I think you are aware of your own thinking and relation to other thinking things (copy)', embedStatus: 'embedded' }
            ]
        }
    ];
    const sessions = [
        { id: 'chat_orig', title: 'The project!', mode: 'direct' },
        { id: 'chat_copy', title: 'Contaminated', mode: 'direct' }
    ];
    return { conversations, sessions };
}

await test('chat baseline counts empty content and tool/system messages', () => {
    const { conversations } = chatFixture();
    const all = chatIndexBaseline(conversations, 'all');
    assert.equal(all.messages, 6);
    assert.equal(all.emptyContent, 1);
    assert.equal(all.emptyEmbedded, 1);
    assert.equal(all.roleCounts.tool, 2);
    const index = buildChatIndex({ conversations, sessions: [], role: 'user' });
    assert.equal(index.messageIndex.length, 2, 'role filter must drop assistant and tool messages');
    const scoped = chatIndexBaseline(conversations, 'user');
    assert.equal(scoped.messages, 2);
    assert.deepEqual(Object.keys(scoped.roleCounts), ['user']);
});

await test('chat semantic lane hits the expected session#idx and skips unknown payloads', async () => {
    const dir = freshDir('chat-semantic');
    const { conversations, sessions } = chatFixture();
    const { db, colls } = buildNvdb(dir, {
        embeddings: {
            dim: 8,
            docs: [
                { id: 'vec_target', vector: basis(6), payload: { chatId: 'chat_orig', msgIdx: 3, messageId: 'm3' } },
                { id: 'vec_copy', vector: basis(5), payload: { chatId: 'chat_copy', msgIdx: 1, messageId: 'c1' } },
                { id: 'vec_unknown', vector: basis(7), payload: { chatId: 'chat_missing', msgIdx: 9, messageId: 'zzz' } }
            ]
        }
    });
    try {
        const allRoles = buildChatIndex({ conversations, sessions, role: null });
        const lane = await chatSemanticLane({ embeddingsColl: colls.embeddings, queryVector: basis(6), index: allRoles, limit: 10 });
        assert.equal(lane.requestedTopK, 30, 'production passes top_k: limit*3');
        assert.equal(lane.returnedK, 3);
        assert.equal(lane.results.length, 2, 'the unknown payload must be skipped');
        assert.equal(lane.results[0].chatId, 'chat_orig');
        assert.equal(lane.results[0].idx, 3);
        assert.equal(lane.results[0].sessionTitle, 'The project!');
        assert.equal(lane.results[0].score, 1);

        // role:user drops the assistant copy, so only the target survives
        const userOnly = await chatSemanticLane({
            embeddingsColl: colls.embeddings,
            queryVector: basis(6),
            index: buildChatIndex({ conversations, sessions, role: 'user' }),
            limit: 10
        });
        assert.deepEqual(userOnly.results.map((r) => `${r.chatId}#${r.idx}`), ['chat_orig#3']);
    } finally {
        closeNvdb({ db, colls });
    }
});

await test('chat keyword lane is a literal whole-query substring, conversation order, score 0', () => {
    const { conversations, sessions } = chatFixture();
    const index = buildChatIndex({ conversations, sessions, role: null });
    const lane = chatKeywordLane({ index, query: 'aware of your own thinking', limit: 10 });
    assert.equal(lane.totalHits, 2);
    assert.deepEqual(lane.results.map((r) => `${r.chatId}#${r.idx}`), ['chat_orig#3', 'chat_copy#1']);
    assert.ok(lane.results.every((r) => r.score === 0));

    // Whole query only — a multi-word phrase never matches word by word.
    const partial = chatKeywordLane({ index, query: 'aware thinking', limit: 10 });
    assert.equal(partial.totalHits, 0);
    // Case-insensitive.
    const upper = chatKeywordLane({ index, query: 'AWARE OF YOUR OWN THINKING', limit: 10 });
    assert.equal(upper.totalHits, 2);
    const limited = chatKeywordLane({ index, query: 'aware of your own thinking', limit: 1 });
    assert.equal(limited.results.length, 1);
});

await test('chat contamination detection finds archive-search echoes and tool copies', () => {
    const { conversations } = chatFixture();
    const detected = detectChatContamination({ conversations, contaminationSessionId: 'chat_copy' });
    assert.equal(detected.totals.archiveShaped, 2);
    assert.equal(detected.totals.archiveShapedEmbedded, 2);
    assert.equal(detected.totals.archiveShapedTool, 2, 'both archive-search echoes are tool outputs');
    assert.equal(detected.totals.archiveShapedToolEmbedded, 2);
    assert.equal(detected.totals.toolMessages, 2);
    assert.equal(detected.contaminationSession.found, true);
    assert.equal(detected.contaminationSession.archiveShaped, 1);
    assert.equal(detected.contaminationSession.samples[0].idx, 0);

    // A copied tool output inside the same conversation is a tool copy.
    const dupe = detectChatContamination({
        conversations: [{
            id: 'c',
            messages: [
                { idx: 0, role: 'tool', content: 'same output' },
                { idx: 1, role: 'tool', content: 'same output' }
            ]
        }],
        contaminationSessionId: 'nope'
    });
    assert.equal(dupe.totals.toolCopies, 1);
    assert.equal(dupe.contaminationSession.found, false);
    assert.equal(looksLikeArchiveSearchOutput('nothing to see'), false);
});

// ── vector integrity ─────────────────────────────────────────────────────────

await test('vectorHash is deterministic and dimension-sensitive', () => {
    assert.equal(vectorHash([1, 2, 3]), vectorHash([1, 2, 3]));
    assert.notEqual(vectorHash([1, 2, 3]), vectorHash([1, 2, 4]));
    assert.notEqual(vectorHash([1, 2, 3]), vectorHash([1, 2, 3, 0]));
    const analyzed = analyzeVector([0, 0], 2);
    assert.equal(analyzed.nonzero, false);
    assert.equal(analyzed.nonzero, false);
    assert.equal(analyzeVector([NaN], 1).finite, false);
    assert.equal(analyzeVector([1, 2], 3).dimOk, false);
    assert.equal(analyzeVector(null, 3).present, false);
});

await test('memory coverage reports missing and duplicate vectors with bounded samples', () => {
    const dir = freshDir('coverage-memory');
    const { db, ids } = buildNdb(path.join(dir, 'data.jsonl'), [
        { prefix: 'mem', doc: { id: 1, embedStatus: 'embedded' } },
        { prefix: 'mem', doc: { id: 2, embedStatus: 'embedded' } },
        { prefix: 'mem', doc: { id: 3, embedStatus: 'embedded' } },
        { prefix: 'mem', doc: { id: 4, embedStatus: 'pending' } },
        { prefix: 'mem', doc: { id: 5, embedStatus: 'embedded' } },
        { prefix: 'meta', doc: { nextId: 6, embedStatus: 'not-applicable' } }
    ]);
    const { db: nvdb, colls } = buildNvdb(path.join(dir, 'nvdb'), {
        memory: {
            dim: 8,
            docs: [
                { id: ids[0], vector: basis(0), payload: { id: 1 } },
                { id: ids[1], vector: basis(0), payload: { id: 2 } }, // duplicate vector
                { id: ids[2], vector: basis(1), payload: { id: 3 } },
                // ids[3] has no vector at all
                { id: ids[4], vector: [0, 0, 0, 0, 0, 0, 0, 0], payload: { id: 5 } } // zero-norm vector
            ]
        }
    });
    try {
        const docs = db.iter();
        const coverage = memoryCoverage({ docs, coll: colls.memory, expectedDim: 8 });
        assert.equal(coverage.nDBDocuments, 6);
        assert.equal(coverage.activeMemDocuments, 5);
        assert.equal(coverage.vectorsPresent, 4);
        assert.equal(coverage.vectorsMissing, 1);
        assert.deepEqual(coverage.missingSamples, [ids[3]]);
        assert.equal(coverage.duplicateGroups, 1);
        assert.equal(coverage.duplicateVectors, 2);
        assert.equal(coverage.samples[0].count, 2);
        assert.deepEqual(coverage.zeroNormSamples, [ids[4]], 'a stored zero vector must be reported, not silently accepted');
        assert.deepEqual(coverage.embedStatus, { embedded: 4, pending: 1 }, 'embedStatus counts cover active mem_ documents only — the _meta document is excluded');
        assert.equal(coverage.distinctVectorHashes, 3, 'basis(0) dup, basis(1) and the zero vector');
    } finally {
        closeNvdb({ db: nvdb, colls });
        db.close();
    }
});

await test('storage coverage walks constructed chunk ids and counts what is missing', () => {
    const dir = freshDir('coverage-storage');
    const { db, colls } = buildNvdb(dir, {
        storage: {
            dim: 8,
            docs: [
                { id: 'storage:a.md#0', vector: basis(0), payload: { path: 'a.md', contentHash: 'ha', splitIdx: 0 } },
                { id: 'storage:a.md#1', vector: basis(0), payload: { path: 'a.md', contentHash: 'ha', splitIdx: 1 } }
            ]
        }
    });
    try {
        const ids = ['storage:a.md#0', 'storage:a.md#1', 'storage:b.md#0'];
        const coverage = storageCoverage({ ids, coll: colls.storage, expectedDim: 8 });
        assert.equal(coverage.requestedIds, 3);
        assert.equal(coverage.vectorsPresent, 2);
        assert.equal(coverage.vectorsMissing, 1);
        assert.deepEqual(coverage.missingSamples, ['storage:b.md#0']);
        assert.equal(coverage.duplicateVectors, 2);
        assert.equal(coverage.badDimSamples.length, 0);
    } finally {
        closeNvdb({ db, colls });
    }
});

await test('chunkIdsFromScanIndex rebuilds single and multi-chunk ids', () => {
    const ids = chunkIdsFromScanIndex({
        files: {
            'storage:one.md': { chunks: 1 },
            'storage:two.md': { chunks: 3 }
        }
    });
    assert.deepEqual(ids, ['storage:one.md', 'storage:two.md#0', 'storage:two.md#1', 'storage:two.md#2']);
    assert.throws(() => chunkIdsFromScanIndex({ files: { 'x': { chunks: 0 } } }), /invalid chunk count/);
    assert.throws(() => chunkIdsFromScanIndex({}), /no files map/);
});

await test('explicit vector probe reports pairwise uniqueness and payload provenance', () => {
    const dir = freshDir('explicit');
    const { db, colls } = buildNvdb(dir, {
        storage: {
            dim: 8,
            docs: [
                { id: 'storage:x.md#0', vector: basis(0), payload: { path: 'x.md', contentHash: 'hx', splitIdx: 0, absolutePath: 'D:\\MCP_Storage\\x.md' } },
                { id: 'storage:y.md#0', vector: basis(0), payload: { path: 'y.md', contentHash: 'hy', splitIdx: 0 } },
                { id: 'storage:z.md#0', vector: basis(1), payload: { path: 'z.md', contentHash: 'hz', splitIdx: 0 } }
            ]
        }
    });
    try {
        const probe = explicitVectorProbe({ ids: ['storage:x.md#0', 'storage:y.md#0', 'storage:z.md#0', 'storage:absent#0'], coll: colls.storage, expectedDim: 8 });
        assert.equal(probe.present, 3);
        assert.equal(probe.distinctHashes, 2);
        assert.equal(probe.identicalPairs.length, 1);
        assert.equal(probe.identicalPairs[0].a, 'storage:x.md#0');
        assert.equal(probe.allDistinct, false);
        assert.equal(probe.entries[3].present, false);
        assert.equal(probe.entries[0].payloadHasAbsolutePath, true);
        assert.ok(!JSON.stringify(probe).includes('D:\\\\MCP_Storage'), 'the probe must not echo the live absolutePath');
    } finally {
        closeNvdb({ db, colls });
    }
});

// ── topK vs top_k ────────────────────────────────────────────────────────────

await test('topK is honoured while the declared top_k spelling falls back to the native default (needs >10 docs)', async () => {
    const dir = freshDir('topk');
    const docs = [];
    for (let i = 0; i < 12; i++) docs.push({ id: `d${i}`, vector: basis(0), payload: { i } });
    const { db, colls } = buildNvdb(dir, { probe: { dim: 8, docs } });
    try {
        const camel = await colls.probe.search({ vector: basis(0), topK: 30 });
        const snake = await colls.probe.search({ vector: basis(0), top_k: 30 });
        assert.equal(camel.length, 12, 'topK:30 must return all 12 docs');
        assert.equal(snake.length, 10, 'top_k:30 must fall back to the native default of 10');

        const probe = await probeTopK({ coll: colls.probe, vector: basis(0), k: 30 });
        assert.equal(probe.topK.returned, 12);
        assert.equal(probe.top_k.returned, 10);
        assert.equal(probe.countsDiffer, true);
        assert.equal(probe.requestedK, 30);
    } finally {
        closeNvdb({ db, colls });
    }
});

await test('percentile uses nearest-rank and handles empty input', () => {
    assert.equal(percentile([], 95), null);
    assert.equal(percentile([10], 95), 10);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

// ── end-to-end fixture snapshot ──────────────────────────────────────────────

function buildFixtureSnapshot(root) {
    const work = path.join(root, 'work');
    const memoryDir = path.join(work, 'mcp-server', 'data', 'memories');
    const nvdbDir = path.join(work, 'mcp-server', 'data', 'nvdb');
    const storageDir = path.join(work, 'storage');
    const chatUserDir = path.join(work, 'chat-data', 'herrbasan');
    for (const d of [memoryDir, nvdbDir, storageDir, chatUserDir]) fs.mkdirSync(d, { recursive: true });

    // memory nDB
    const mem = buildNdb(path.join(memoryDir, 'data.jsonl'), [
        { prefix: 'mem', doc: { id: 6911, category: 'preference', confidence: 1, description: 'nTeligence delegation preference approved', embedStatus: 'embedded' } },
        { prefix: 'mem', doc: { id: 6830, category: 'funding', confidence: 0.96, description: 'Funding conclusion Prototype Fund insufficient grants supplement', embedStatus: 'embedded' } },
        { prefix: 'mem', doc: { id: 6955, category: 'nteligence', confidence: 0.9, description: 'harness memory durable artifacts decisions outcomes not process exhaust', embedStatus: 'embedded' } },
        { prefix: 'mem', doc: { id: 7000, category: 'misc', confidence: 0.5, description: 'cooking note', embedStatus: 'embedded' } }
    ]);
    mem.db.close();

    // storage work files (content evidence source)
    const attic = path.join(storageDir, 'blog', 'attic');
    fs.mkdirSync(attic, { recursive: true });
    const record = 'CONSCIOUSNESS-IS-THE-RECORD work copy evidence text, long enough to slice.';
    fs.writeFileSync(path.join(attic, 'consciousness-is-the-record.md'), record);

    // nVDB: memory + storage
    const memoryDocs = [
        { id: mem.ids[0], vector: basis(0), payload: { id: 6911 } },
        { id: mem.ids[1], vector: basis(1), payload: { id: 6830 } },
        { id: mem.ids[2], vector: basis(2), payload: { id: 6955 } },
        { id: mem.ids[3], vector: basis(3), payload: { id: 7000 } }
    ];
    const storageDocs = [
        { id: 'storage:blog/attic/consciousness-is-the-record.md#0', vector: basis(4), payload: { path: 'blog/attic/consciousness-is-the-record.md', absolutePath: 'D:\\MCP_Storage\\blog\\attic\\consciousness-is-the-record.md', contentHash: 'h-record', splitIdx: 0, folder: 'blog', charOffset: 0, charLen: 30 } },
        { id: 'storage:blog/attic/consciousness-is-the-record.md#1', vector: [0.9, 0, 0, 0, 0.1, 0, 0, 0], payload: { path: 'blog/attic/consciousness-is-the-record.md', absolutePath: 'D:\\MCP_Storage\\blog\\attic\\consciousness-is-the-record.md', contentHash: 'h-record', splitIdx: 1, folder: 'blog', charOffset: 30, charLen: 30 } },
        // single-chunk files carry the BARE docBaseId — no "#0" suffix (production rule)
        { id: 'storage:blog/attic/consciousness-is-the-record-v2.md', vector: [0.7, 0, 0, 0, 0.3, 0, 0, 0], payload: { path: 'blog/attic/consciousness-is-the-record-v2.md', contentHash: 'h-record-v2', splitIdx: 0, folder: 'blog', charOffset: 0, charLen: 20 } },
        { id: 'storage:fetch/consciousness-social/plato.md', vector: basis(5), payload: { path: 'fetch/consciousness-social/plato.md', contentHash: 'h-plato', splitIdx: 0, folder: 'fetch' } },
        { id: 'storage:research/consciousness/bach.md', vector: [0, 0, 0, 0, 0.2, 0.8, 0, 0], payload: { path: 'research/consciousness/bach.md', contentHash: 'h-bach', splitIdx: 0, folder: 'research' } }
    ];
    const nv = buildNvdb(nvdbDir, { memory: { dim: 8, docs: memoryDocs }, storage: { dim: 8, docs: storageDocs } });
    closeNvdb(nv);
    fs.writeFileSync(path.join(nvdbDir, 'meta.json'), JSON.stringify({ version: 1, collections: ['memory', 'storage'] }));
    fs.writeFileSync(path.join(nvdbDir, 'scan-index.json'), JSON.stringify({
        files: {
            'storage:blog/attic/consciousness-is-the-record.md': { collection: 'storage', path: 'blog/attic/consciousness-is-the-record.md', chunks: 2 },
            'storage:blog/attic/consciousness-is-the-record-v2.md': { collection: 'storage', path: 'blog/attic/consciousness-is-the-record-v2.md', chunks: 1 },
            'storage:fetch/consciousness-social/plato.md': { collection: 'storage', path: 'fetch/consciousness-social/plato.md', chunks: 1 },
            'storage:research/consciousness/bach.md': { collection: 'storage', path: 'research/consciousness/bach.md', chunks: 1 }
        },
        hashToDoc: {}
    }));

    // chat nDB
    const { conversations, sessions } = chatFixture();
    const chat = buildNdb(path.join(chatUserDir, 'data.jsonl'), [
        ...sessions.map((s) => ({ doc: { _type: 'session', ...s } })),
        ...conversations.map((c) => ({ doc: { _type: 'conversation', ...c } }))
    ]);
    chat.db.close();

    const chatNv = buildNvdb(path.join(chatUserDir, 'nvdb'), {
        embeddings: {
            dim: 8,
            docs: [
                { id: 'e1', vector: basis(6), payload: { chatId: 'chat_orig', msgIdx: 3, messageId: 'm3' } },
                { id: 'e2', vector: basis(5), payload: { chatId: 'chat_copy', msgIdx: 1, messageId: 'c1' } },
                { id: 'e3', vector: basis(3), payload: { chatId: 'chat_orig', msgIdx: 0, messageId: 'm0' } }
            ]
        }
    });
    closeNvdb(chatNv);

    // manifest + sidecar
    const manifest = {
        tool: 'snapshot-memory-lab',
        version: 1,
        name: 'phase0-fixture',
        createdAt: '2026-11-17T00:00:00.000Z',
        mode: 'crash-consistent-copy',
        pointInTime: false,
        warning: 'fixture',
        workRoot: work,
        sources: [
            { name: 'memory-ndb', role: 'memory-ndb', workPath: memoryDir },
            { name: 'nvdb', role: 'nvdb', workPath: nvdbDir },
            { name: 'storage', role: 'storage', workPath: storageDir },
            { name: 'chat-data', role: 'chat-data', workPath: path.join(work, 'chat-data') },
            { name: 'chat-sessions', role: 'chat-sessions', workPath: path.join(work, 'chat-sessions') }
        ]
    };
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(root, 'MANIFEST.sha256'), `${crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex')}  manifest.json\n`);

    // fixture golden suite
    const goldenPath = path.join(root, 'golden.json');
    fs.writeFileSync(goldenPath, JSON.stringify({
        tool: 'memory-lab-phase0-golden',
        suiteVersion: 'fixture-1',
        version: 1,
        dataset: {
            chatUser: 'herrbasan',
            expectedEmbeddingDim: 8,
            contaminationSessionId: 'chat_copy',
            memoryLimit: 10,
            storageTopK: 10,
            chatLimit: 10
        },
        memory: [
            { id: 'mem-nteligence', query: 'nTeligence', relevantIds: [6911, 6955] },
            { id: 'mem-prototype', query: 'Prototype Fund 47.5k application November 30 funding', relevantIds: [6830] },
            { id: 'mem-nonsense-control', query: 'xyzzy quantum banana radiator', relevantIds: [], control: 'nonsense' }
        ],
        storage: [
            { id: 'sto-title', query: 'Consciousness Is the Record', relevantPaths: ['blog/attic/consciousness-is-the-record.md'], adjacentPaths: ['blog/attic/consciousness-is-the-record-v2.md'] },
            { id: 'sto-topic', query: 'AI consciousness' },
            { id: 'sto-fetch', query: 'plato self consciousness' }
        ],
        chat: [
            { id: 'chat-semantic-all', query: 'AI consciousness semantic', lane: 'semantic', roleFilter: 'all' },
            { id: 'chat-semantic-user', query: 'AI consciousness semantic', lane: 'semantic', roleFilter: 'user', relevant: [{ sessionId: 'chat_orig', idx: [3] }] },
            { id: 'chat-keyword', query: 'aware of your own thinking', lane: 'keyword', roleFilter: 'all', relevant: [{ sessionId: 'chat_orig', idx: [3], messageId: 'm3' }] }
        ],
        sourceIntent: { ownPrefixes: ['blog/', 'arena/', 'research/', 'sessions/'], thirdPartyPrefixes: ['fetch/'] },
        explicitVectorIds: [
            'storage:blog/attic/consciousness-is-the-record.md#0',
            'storage:blog/attic/consciousness-is-the-record.md#1',
            'storage:blog/attic/consciousness-is-the-record-v2.md',
            'storage:fetch/consciousness-social/plato.md',
            'storage:research/consciousness/bach.md'
        ]
    }, null, 2));

    return { work, memoryDir, nvdbDir, storageDir, goldenPath, record };
}

await test('runPhase0 produces a complete report on a fixture snapshot and writes it to reports/', async () => {
    const root = freshDir('snapshot');
    const fixture = buildFixtureSnapshot(root);

    const embedder = mapEmbedder({
        nTeligence: basis(0),
        'Prototype Fund 47.5k application November 30 funding': basis(1),
        'xyzzy quantum banana radiator': basis(7),
        'importance recency maps harness durable meaning operational exhaust': basis(2),
        'Consciousness Is the Record': basis(4),
        'AI consciousness': basis(4),
        'plato self consciousness': basis(5),
        'AI consciousness semantic': basis(6),
        'aware of your own thinking': basis(6)
    });

    const report = await runPhase0({
        snapshot: root,
        embedder,
        goldenPath: fixture.goldenPath,
        openNdb: loadNdb,
        openNvdb: loadNvdb,
        now: () => new Date('2026-11-17T08:00:00.000Z')
    });

    const serialized = JSON.stringify(report);
    assert.equal(report.ok, true, `report not ok: ${JSON.stringify(report.errors)}`);
    assert.equal(report.golden.suiteVersion, 'fixture-1');
    assert.equal(report.golden.memoryCases, 3);
    assert.equal(report.code.packageVersion, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version);
    assert.ok(report.snapshot.manifestSha256);
    assert.equal(report.lanes.memory.length, 3);
    assert.equal(report.lanes.storage.length, 3);
    assert.equal(report.lanes.chat.length, 3);

    // memory lane
    const nteligence = report.lanes.memory.find((c) => c.id === 'mem-nteligence');
    assert.equal(nteligence.hybrid.ranked[0].id, 6911);
    assert.equal(nteligence.targetRanks.hybrid['6911'], 1);
    assert.equal(nteligence.targetRanks.lexical['6911'], 1, 'the only lexically matching doc is first');
    assert.equal(nteligence.targetRanks.semantic['6911'], 1);
    assert.equal(nteligence.semantic.requestedTopK, 50);
    assert.equal(nteligence.semantic.hits.length, nteligence.semantic.returnedK, 'ALL raw semantic hits are retained, not just the window');
    assert.equal(nteligence.hybrid.docIdRanked.length, nteligence.hybrid.totalRanked, 'the hybrid id list is not truncated');
    assert.ok(nteligence.lexical.tokens.includes('nteligence'));
    assert.equal(nteligence.hit5, true);

    // the prototype case shows WHERE a target sits per leg: the lexical AND misses
    // it (no 'application'/'november' token) while the semantic leg finds it first
    const prototype = report.lanes.memory.find((c) => c.id === 'mem-prototype');
    assert.equal(prototype.targetRanks.lexical['6830'], null);
    assert.equal(prototype.targetRanks.semantic['6830'], 1);
    assert.equal(prototype.targetRanks.hybrid['6830'], 1);
    assert.equal(prototype.hit5, true);

    // nonsense control records a score and asserts nothing
    const nonsense = report.lanes.memory.find((c) => c.id === 'mem-nonsense-control');
    assert.ok(nonsense.semantic.maxScore !== null);
    assert.equal(report.metrics.nonsenseControl.caseId, 'mem-nonsense-control');

    // storage lane: path remap evidence from the work copy, source-intent split
    const title = report.lanes.storage.find((c) => c.id === 'sto-title');
    assert.equal(title.targetRanks.final['blog/attic/consciousness-is-the-record.md'], 1);
    assert.equal(title.targetRanks.raw['blog/attic/consciousness-is-the-record.md'], 1, 'the raw semantic rank is recorded too');
    assert.equal(title.adjacentRanks.raw['blog/attic/consciousness-is-the-record-v2.md'], 2, 'the adjacent path keeps its own raw/final maps');
    assert.equal(title.adjacentRanks.final['blog/attic/consciousness-is-the-record-v2.md'], 2);
    assert.equal(title.fetchK, 30);
    assert.ok(title.final[0].evidence.available);
    assert.ok(title.final[0].evidence.preview.startsWith('CONSCIOUSNESS-IS-THE-RECORD'));
    assert.equal(title.final[0].evidence.source, 'work-copy');
    const fetchLane = report.lanes.storage.find((c) => c.id === 'sto-fetch');
    assert.ok(fetchLane.sourceIntent.raw.thirdParty + fetchLane.sourceIntent.raw.own > 0);
    assert.equal(fetchLane.sourceIntent.raw.total, 5, 'raw lane keeps every returned chunk, including third-party fetch/');
    assert.ok(serialized.indexOf('blog\\attic\\consciousness-is-the-record.md') === -1 || !serialized.includes('D:\\\\MCP_Storage'));

    // chat lanes
    const chatSemantic = report.lanes.chat.find((c) => c.id === 'chat-semantic-user');
    assert.equal(chatSemantic.semantic.requestedTopK, 30);
    assert.equal(chatSemantic.targets['chat_orig#3'], 1);
    assert.equal(chatSemantic.baseline.roleCounts.tool, undefined, 'role:user index holds no tool messages');
    const chatKeyword = report.lanes.chat.find((c) => c.id === 'chat-keyword');
    // nDB conversation order is a per-process HashMap order, so the rank of the
    // target is not stable — only its presence is.
    assert.notEqual(chatKeyword.targets['chat_orig#3'], null, 'keyword lane must find the original message');
    assert.equal(chatKeyword.keyword.totalHits, 2);
    assert.ok(chatKeyword.keyword.results.every((r) => r.score === 0));
    assert.match(chatKeyword.orderNote, /HashMap/);

    // coverage, probe and contamination
    const memoryCoverageReport = report.coverage.memory;
    assert.equal(memoryCoverageReport.activeMemDocuments, 4);
    assert.equal(memoryCoverageReport.vectorsPresent, 4);
    assert.equal(memoryCoverageReport.vectorsMissing, 0);
    assert.ok(Array.isArray(memoryCoverageReport.namedTargets));
    const storageCoverageReport = report.coverage.storage;
    assert.equal(storageCoverageReport.requestedIds, 5);
    assert.equal(storageCoverageReport.vectorsPresent, 5);

    // nVDB collection reality is recorded and reconciled
    assert.equal(memoryCoverageReport.nvdb.collection, 'memory');
    assert.equal(memoryCoverageReport.nvdb.config.dim, 8);
    assert.equal(memoryCoverageReport.nvdb.stats.totalSegmentDocs, 4);
    assert.equal(memoryCoverageReport.reconcile.segmentMinusPresent, 0);
    assert.equal(storageCoverageReport.nvdb.collection, 'storage');
    assert.equal(storageCoverageReport.nvdb.stats.totalSegmentDocs, 5);
    assert.equal(storageCoverageReport.reconcile.segmentMinusPresent, 0);
    assert.equal(typeof storageCoverageReport.nvdb.stats.segmentCount, 'number');
    assert.equal(report.coverage.explicitVectors.present, 5);
    assert.equal(report.coverage.explicitVectors.allDistinct, true, 'fixture vectors are all distinct');
    assert.equal(report.probe.topK.returned, 5);
    assert.equal(report.probe.top_k.returned, 5);
    assert.equal(report.probe.countsDiffer, false, 'only 5 docs exist, so both spellings are capped by the collection size');
    assert.equal(report.coverage.chat.contamination.totals.archiveShaped, 2);
    assert.equal(report.coverage.chat.contamination.contaminationSession.found, true);
    assert.equal(report.coverage.chat.inventory.roles.tool, 2);
    assert.equal(report.coverage.chat.inventory.archiveSearchShapedToolOutputs, 2);
    assert.equal(report.coverage.chat.inventory.archiveSearchShapedToolOutputsEmbedded, 2);
    assert.equal(report.coverage.chat.inventory.toolCopies, 0);
    assert.equal(report.coverage.chat.conversationOrder.deterministicAcrossProcesses, false);
    assert.equal(report.metrics.contamination.archiveShapedToolOutputs, 2);

    // metrics
    assert.ok(report.metrics.memory.recallAt10 !== null);
    assert.ok(report.metrics.durations.all.count === 9);
    assert.ok(report.metrics.probe.requestedK === 30);

    // report writing
    assert.match(report.definitions.memorySkipReasons, /tombstoned/, 'the safeGetDoc limitation is documented');
    assert.match(report.definitions.targetRanks, /hybrid/);
    const file = writeReport(report, path.join(root, 'reports'), new Date(report.finishedAt));
    assert.ok(fs.existsSync(file));
    assert.match(path.basename(file), /^phase0-\d{4}-\d{2}-\d{2}T.*\.json$/);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.tool, 'memory-lab-phase0');
    assert.equal(parsed.ok, true);

    // compact CLI summary
    const summary = summarize(report);
    assert.match(summary, /memory-lab-phase0\s+ok=true/);
    assert.match(summary, /probe\s+topK:30->5/);
    assert.match(summary, /explicit5\s+present=5/);
    assert.match(summary, /memory\s+cases=3/);
    assert.ok(summary.split('\n').length <= 20, `summary must stay compact, got ${summary.split('\n').length} lines`);

    // the report must never carry a live absolutePath value
    assert.ok(!serialized.includes('D:\\\\MCP_Storage'), 'report leaked a live storage absolutePath');
    assert.ok(serialized.includes('payloadHasAbsolutePath'));

    // the lab copy was never mutated: memory journal still has no .fti cache
    assert.deepEqual(fs.readdirSync(fixture.memoryDir).sort(), ['data.jsonl'], 'createTextIndex must run on the scratch copy only');
    assert.equal(fs.readFileSync(path.join(fixture.memoryDir, 'data.jsonl'), 'utf8').length > 0, true);

    // scratch is snapshot-scoped, cleaned up, and never lands in the project data root
    assert.equal(report.options.scratchDir, path.join(root, 'scratch', `phase0-${process.pid}`));
    assert.equal(fs.existsSync(report.options.scratchDir), false, 'the per-run scratch directory must be removed');
    const repoDataNames = fs.existsSync(path.join(REPO_ROOT, 'data')) ? fs.readdirSync(path.join(REPO_ROOT, 'data')) : [];
    assert.deepEqual(repoDataNames.filter((n) => n.startsWith('phase0') || n.startsWith('memory-lab-phase0')), [], 'nothing may be written under the live project data root');
    assert.equal(fs.existsSync(path.join(root, 'work')), true, 'the work copy must survive teardown');
    assert.equal(fs.existsSync(path.join(fixture.memoryDir, 'data.jsonl')), true);
});

await test('runPhase0 fails loud on missing snapshot and bad golden', async () => {
    await assert.rejects(
        () => runPhase0({ snapshot: path.join(TMP, 'nope'), embedder: mapEmbedder({}), openNdb: loadNdb, openNvdb: loadNvdb }),
        /snapshot root missing/
    );
    const root = freshDir('bad-golden-run');
    const fixture = buildFixtureSnapshot(root);
    await assert.rejects(
        () => runPhase0({ snapshot: root, embedder: mapEmbedder({}), goldenPath: path.join(root, 'absent.json'), openNdb: loadNdb, openNvdb: loadNvdb }),
        /ENOENT|no such file/
    );
    assert.ok(fs.existsSync(fixture.goldenPath));
});

await test('runPhase0 captures a per-case failure and marks the report not ok', async () => {
    const root = freshDir('case-failure');
    buildFixtureSnapshot(root);
    const goldenPath = path.join(root, 'golden-partial.json');
    const suite = JSON.parse(fs.readFileSync(path.join(root, 'golden.json'), 'utf8'));
    suite.chat = [{ id: 'chat-missing-collection', query: 'x', lane: 'semantic', roleFilter: 'all' }];
    fs.writeFileSync(goldenPath, JSON.stringify(suite));

    const report = await runPhase0({
        snapshot: root,
        embedder: {
            async embed(text) {
                if (text === 'x') throw new Error('synthetic embed failure');
                return basis(0);
            }
        },
        goldenPath,
        openNdb: loadNdb,
        openNvdb: loadNvdb,
        now: () => new Date('2026-11-17T08:00:00.000Z')
    });

    assert.equal(report.ok, false);
    const failed = report.lanes.chat.find((c) => c.id === 'chat-missing-collection');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /synthetic embed failure/);
    assert.ok(report.errors.some((e) => e.id === 'chat-missing-collection'));
    assert.equal(report.embed.failures.length, 1);
    assert.equal(report.embed.retries, 0, 'a non-network embed error must not be retried');
    assert.equal(report.embed.attempts, report.embed.calls);
});

await test('scratch location is snapshot-scoped: setup assertions and teardown refusal agree', () => {
    const root = freshDir('scratch-area');
    const area = resolveScratchArea(root);
    assert.equal(area.scratchArea, path.join(root, 'scratch'));
    assert.equal(area.referenceRoot, path.join(root, 'reference'));
    assert.equal(area.workRoot, path.join(root, 'work'));

    // allowed: a subdirectory of <snapshot>\scratch
    const ok = path.join(area.scratchArea, 'phase0-1234');
    assert.equal(assertScratchLocation(ok, area), path.resolve(ok));

    // refused by setup
    assert.throws(() => assertScratchLocation(path.join(REPO_ROOT, 'data', 'tmp', 'phase0'), area), /inside the snapshot root/);
    assert.throws(() => assertScratchLocation(path.join(area.workRoot, 'phase0'), area), /inside work\//);
    assert.throws(() => assertScratchLocation(path.join(area.referenceRoot, 'phase0'), area), /inside reference\//);
    assert.throws(() => assertScratchLocation(root, area), /must not be the snapshot root/);
    assert.throws(() => assertScratchLocation(area.scratchArea, area), /subdirectory of the snapshot scratch area/);
    assert.throws(() => assertScratchLocation(path.join(root, 'tmp', 'phase0'), area), /subdirectory of the snapshot scratch area/);

    // teardown refuses the same paths, and removes only what setup would allow
    fs.mkdirSync(ok, { recursive: true });
    fs.writeFileSync(path.join(ok, 'marker.txt'), 'x');
    assert.throws(() => removeScratch(path.join(REPO_ROOT, 'data'), area), /refusing to remove/);
    assert.throws(() => removeScratch(path.join(area.workRoot), area), /refusing to remove/);
    assert.throws(() => removeScratch(area.scratchArea, area), /refusing to remove/);
    assert.equal(fs.existsSync(path.join(area.workRoot)), false, 'a refused delete must not touch work/');
    const removed = removeScratch(ok, area);
    assert.deepEqual(removed, { removed: true });
    assert.equal(fs.existsSync(ok), false);
});

await test('runPhase0 refuses a scratch directory outside the snapshot or inside the lab tree', async () => {
    const root = freshDir('scratch-refused');
    const fixture = buildFixtureSnapshot(root);
    const embedder = mapEmbedder({ nTeligence: basis(0) });
    const base = { snapshot: root, embedder, goldenPath: fixture.goldenPath, openNdb: loadNdb, openNvdb: loadNvdb };

    await assert.rejects(() => runPhase0({ ...base, scratchDir: path.join(REPO_ROOT, 'data', 'tmp', 'phase0-x') }), /inside the snapshot root/);
    await assert.rejects(() => runPhase0({ ...base, scratchDir: path.join(root, 'work', 'phase0-x') }), /inside work\//);
    await assert.rejects(() => runPhase0({ ...base, scratchDir: path.join(root, 'reference', 'phase0-x') }), /inside reference\//);
    // nothing was created by the refused runs
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'data', 'tmp', 'phase0-x')), false);
    assert.equal(fs.existsSync(path.join(root, 'work', 'phase0-x')), false);
});

await test('scratch can be placed explicitly inside the snapshot and is still cleaned up', async () => {
    const root = freshDir('scratch-explicit');
    const fixture = buildFixtureSnapshot(root);
    const target = path.join(root, 'scratch', 'custom-run');
    const report = await runPhase0({
        snapshot: root,
        embedder: mapEmbedder({ nTeligence: basis(0) }),
        goldenPath: fixture.goldenPath,
        openNdb: loadNdb,
        openNvdb: loadNvdb,
        scratchDir: target,
        now: () => new Date('2026-11-17T08:00:00.000Z')
    });
    assert.equal(report.options.scratchDir, target);
    assert.equal(fs.existsSync(target), false);
});

// ── embedder accounting / transient retry ────────────────────────────────────

await test('wrapEmbedder recovers one transient fetch failure and records it', async () => {
    let calls = 0;
    const vectors = [[1, 0, 0], [0, 1, 0]];
    const flaky = {
        async embed() {
            calls++;
            if (calls === 1) throw new TypeError('fetch failed');
            return vectors[1];
        }
    };
    const delays = [];
    const wrapped = wrapEmbedder(flaky, { retryDelayMs: 7, sleep: async (ms) => { delays.push(ms); } });

    assert.equal(isTransientFetchError(new TypeError('fetch failed')), true);
    assert.equal(isTransientFetchError(Object.assign(new Error('boom'), { name: 'TypeError' })), false, 'only a real TypeError counts');
    assert.equal(isTransientFetchError(new Error('fetch failed')), true, 'a "fetch failed" message is transient too');
    assert.equal(isTransientFetchError(new Error('HTTP 500')), false);

    const vector = await wrapped.embed('AI consciousness semantic');
    assert.deepEqual(vector, vectors[1]);
    assert.deepEqual(delays, [7], 'exactly one bounded delay');
    assert.equal(wrapped.stats.calls, 1);
    assert.equal(wrapped.stats.chars, 'AI consciousness semantic'.length);
    assert.equal(wrapped.stats.attempts, 2);
    assert.equal(wrapped.stats.retries, 1);
    assert.equal(wrapped.stats.recovered, 1);
    assert.equal(wrapped.stats.failures.length, 0);
    assert.equal(wrapped.stats.transientFailures.length, 1);
    assert.match(wrapped.stats.transientFailures[0].error, /fetch failed/);
    assert.equal(wrapped.stats.transientFailures[0].retryDelayMs, 7);
});

await test('wrapEmbedder gives a permanent failure exactly two attempts and rethrows loudly', async () => {
    let calls = 0;
    const alwaysDown = {
        async embed() {
            calls++;
            throw new TypeError('fetch failed');
        }
    };
    const wrapped = wrapEmbedder(alwaysDown, { retryDelayMs: 1, sleep: async () => {} });

    await assert.rejects(() => wrapped.embed('nTeligence'), /fetch failed/);
    assert.equal(calls, 2, 'one retry only — never a third attempt');
    assert.equal(wrapped.stats.attempts, 2);
    assert.equal(wrapped.stats.retries, 1);
    assert.equal(wrapped.stats.recovered, 0);
    assert.equal(wrapped.stats.failures.length, 1);
    assert.equal(wrapped.stats.failures[0].attempts, 2);
    assert.equal(wrapped.stats.failures[0].transient, true);
    assert.equal(wrapped.stats.transientFailures.length, 1);
});

await test('wrapEmbedder never retries a non-network error', async () => {
    let calls = 0;
    const broken = {
        async embed() {
            calls++;
            throw new Error('embed provider returned 400');
        }
    };
    const wrapped = wrapEmbedder(broken, { retryDelayMs: 1, sleep: async () => { throw new Error('delay must not run'); } });
    await assert.rejects(() => wrapped.embed('query'), /returned 400/);
    assert.equal(calls, 1);
    assert.equal(wrapped.stats.attempts, 1);
    assert.equal(wrapped.stats.retries, 0);
    assert.equal(wrapped.stats.failures.length, 1);
    assert.equal(wrapped.stats.failures[0].transient, false);
});

await test('runPhase0 runs to completion when one embed recovers from a transient failure', async () => {
    const root = freshDir('flaky-embed');
    const fixture = buildFixtureSnapshot(root);
    const map = {
        nTeligence: basis(0),
        'Prototype Fund 47.5k application November 30 funding': basis(1),
        'xyzzy quantum banana radiator': basis(7),
        'Consciousness Is the Record': basis(4),
        'AI consciousness': basis(4),
        'plato self consciousness': basis(5),
        'AI consciousness semantic': basis(6),
        'aware of your own thinking': basis(6)
    };
    const inner = mapEmbedder(map);
    let calls = 0;
    const flaky = {
        async embed(text) {
            calls++;
            if (calls === 1) throw new TypeError('fetch failed');
            return inner.embed(text);
        }
    };

    const report = await runPhase0({
        snapshot: root,
        embedder: flaky,
        goldenPath: fixture.goldenPath,
        openNdb: loadNdb,
        openNvdb: loadNvdb,
        retryDelayMs: 1,
        now: () => new Date('2026-11-17T08:00:00.000Z')
    });

    assert.equal(report.ok, true, `report not ok: ${JSON.stringify(report.errors)}`);
    assert.equal(report.embed.retries, 1);
    assert.equal(report.embed.recovered, 1);
    assert.equal(report.embed.attempts, report.embed.calls + 1);
    assert.equal(report.embed.failures.length, 0);
    assert.equal(report.embed.transientFailures.length, 1);
    assert.match(report.embed.transientFailures[0].error, /fetch failed/);
    assert.equal(report.options.embedRetryDelayMs, 1);
    assert.match(summarize(report), /1 retry\(ies\)/);
    assert.equal(fs.existsSync(report.options.scratchDir), false);
});

// ── summary ──────────────────────────────────────────────────────────────────

fs.rmSync(TMP, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
    process.stdout.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
} else {
    process.stdout.write(`${JSON.stringify(results, null, 0)}\n`);
}
