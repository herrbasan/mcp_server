// Labeled retrieval baseline: real queries, known targets, four configurations.
//
// Purpose: decide with evidence whether vector retrieval helps, whether it
// should be scoped, or whether it should be reduced. This script CHANGES NO
// RANKING CODE — it only measures the stack as it is on this commit.
//
// Two sets, deliberately separate:
//   baseline — cases developed while fixing R1/R2/R3; may inform future work.
//   holdout  — written down here once and never used to tune. Read its numbers
//              as generalization, not as a target.
//
// Four configurations per query (the per-request `search` switches):
//   keyword-only : { dense:false, lexical:true,  rerank:false }
//   vector-only  : { dense:true,  lexical:false, rerank:false }
//   combined     : { dense:true,  lexical:true,  rerank:false }
//   full         : {} (config default: dense+lexical+diversity+rerank)
//
// Artifacts (target rank, raw results, latency, embedding/reranker work) land in
// data/eval/retrieval-baseline/<runId>/.
//
// Usage: node scripts/retrieval-baseline.mjs [--refresh-index]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const load = spec => import(pathToFileURL(path.join(repo, spec)).href);

const TOP_K = 10;
const CONFIGS = {
    'keyword-only': { dense: false, lexical: true, rerank: false },
    'vector-only': { dense: true, lexical: false, rerank: false },
    combined: { dense: true, lexical: true, rerank: false },
    full: {}
};

// action: 'match' → targets must be found; 'reject' → the honest answer is none.
const BASELINE = [
    { id: 'b01', set: 'baseline', lane: 'storage', class: 'exact-title', action: 'match', query: 'Consciousness Is the Record', targets: ['blog/attic/consciousness-is-the-record-v2.md', 'blog/attic/consciousness-is-the-record.md'] },
    { id: 'b02', set: 'baseline', lane: 'storage', class: 'keyword', action: 'match', query: 'nConvert', targets: ['ingest/20261113_0612_nconvert/'] },
    { id: 'b03', set: 'baseline', lane: 'storage', class: 'paraphrase', action: 'match', query: 'is artificial intelligence conscious', targets: ['research/consciousness/the-mythology-of-conscious-ai.md'] },
    { id: 'b04', set: 'baseline', lane: 'storage', class: 'misspelling', action: 'match', query: 'AI Conciousness', targets: ['research/consciousness/'] },
    { id: 'b05', set: 'baseline', lane: 'storage', class: 'german', action: 'match', query: 'Förderprogramme für KI in Deutschland', targets: ['research/policy/germany-ai-policy/'] },
    { id: 'b06', set: 'baseline', lane: 'storage', class: 'nonsense', action: 'reject', query: 'zqxv bloraptastic nickel sorbet', targets: [] },
    { id: 'b07', set: 'baseline', lane: 'memory', class: 'exact-title', action: 'match', query: 'A Little Religion v6 final', targets: [2103] },
    { id: 'b08', set: 'baseline', lane: 'memory', class: 'keyword', action: 'match', query: 'nui_wc2', targets: [3437] },
    { id: 'b09', set: 'baseline', lane: 'memory', class: 'keyword', action: 'match', query: 'Prototype', targets: [6830] },
    { id: 'b10', set: 'baseline', lane: 'memory', class: 'paraphrase', action: 'match', query: 'German public funding Prototype Fund open source application window', targets: [6830] },
    { id: 'b11', set: 'baseline', lane: 'memory', class: 'current', action: 'match', query: 'Which model currently generates nConvert summaries?', targets: [6716] },
    { id: 'b12', set: 'baseline', lane: 'memory', class: 'historical', action: 'match', query: 'What was nConvert summary routing before the local switch?', targets: [6593] },
    { id: 'b13', set: 'baseline', lane: 'memory', class: 'german', action: 'match', query: 'Fördermittel für Open-Source-Prototypen in Deutschland', targets: [6830] },
    { id: 'b14', set: 'baseline', lane: 'memory', class: 'nonsense', action: 'reject', query: 'xyzzy quantum banana radiator', targets: [] }
];

// Written once, before any measurement of this set. Not for tuning.
const HOLDOUT = [
    { id: 'h01', set: 'holdout', lane: 'storage', class: 'exact-title', action: 'match', query: 'origin memorial', targets: ['Archive/origin-memorial.md'] },
    { id: 'h02', set: 'holdout', lane: 'storage', class: 'keyword', action: 'match', query: 'md-blocks spec', targets: ['documentation/md-blocks/md-blocks-spec.md'] },
    { id: 'h03', set: 'holdout', lane: 'storage', class: 'keyword', action: 'match', query: 'md-blocks BRIEF', targets: ['documentation/md-blocks/BRIEF.md'] },
    { id: 'h04', set: 'holdout', lane: 'storage', class: 'german', action: 'match', query: 'Regulierung von KI in Deutschland', targets: ['research/policy/germany-ai-policy/'] },
    { id: 'h05', set: 'holdout', lane: 'storage', class: 'misspelling', action: 'match', query: 'conciousness record', targets: ['blog/attic/consciousness-is-the-record', 'blog/attic/consciousness-is-the-record-v2.md'] },
    { id: 'h06', set: 'holdout', lane: 'memory', class: 'paraphrase', action: 'match', query: "what does the origin memorial say about the machine's birth", targets: [2596] },
    { id: 'h07', set: 'holdout', lane: 'memory', class: 'paraphrase', action: 'match', query: 'how was the memory system migrated off a single JSON file', targets: [783] },
    { id: 'h08', set: 'holdout', lane: 'memory', class: 'nonsense', action: 'reject', query: 'gribble flurbex zebra', targets: [] }
];

const CASES = [...BASELINE, ...HOLDOUT];

// ── setup ─────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const indexSource = path.resolve(repo, config.agents.vdb.dbPath);
const indexPath = path.join(repo, 'data', 'eval', '_index', 'nvdb');
if (process.argv.includes('--refresh-index') || !fs.existsSync(indexPath)) {
    fs.rmSync(path.dirname(indexPath), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.cpSync(indexSource, indexPath, { recursive: true });
}
config.agents.vdb.dbPath = path.relative(repo, indexPath).replace(/\\/g, '/');

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(repo, 'data', 'eval', 'retrieval-baseline', runId);
fs.mkdirSync(outDir, { recursive: true });

const { createEmbedClient } = await load('src/embed-client.js');
const { createGatewayClient } = await load('src/gateway-client.js');
const vdb = await load('src/agents/vdb/index.js');
const { assessRelevance } = await load('src/agents/vdb/relevance.js');
const memory = await load('src/agents/memory/index.js');

const counters = { embedCalls: 0, embedTexts: 0 };
const baseGateway = createGatewayClient(
    config.gateway.wsUrl,
    config.gateway.httpUrl,
    config.gateway.accessKey,
    createEmbedClient(config.gateway.httpUrl, config.gateway.accessKey)
);
const gateway = {
    ...baseGateway,
    async embed(text, opts) {
        counters.embedCalls++;
        counters.embedTexts++;
        return baseGateway.embed(text, opts);
    },
    async embedBatch(texts, opts) {
        counters.embedCalls++;
        counters.embedTexts += texts.length;
        return baseGateway.embedBatch(texts, opts);
    }
};

const agents = new Map();
const context = { config, gateway, agents, prompts: new Map(), app: null };
const startedAt = new Date().toISOString();
const initStarted = performance.now();
const vdbInstance = await vdb.init(context);
agents.set('vdb', vdbInstance);
await memory.init(context);
const initMs = Math.round(performance.now() - initStarted);

const RERANK_SHORTLIST = config.agents.vdb.rerank.shortlist;
const RERANK_MODEL = config.agents.vdb.rerank.modelPath;

// ── measurement ───────────────────────────────────────────────────────
function matchRank(values, targets) {
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (targets.some(target => typeof target === 'number'
            ? value === String(target)
            : String(value).startsWith(String(target)))) return i + 1;
    }
    return null;
}

async function runStorage(c, search) {
    counters.embedCalls = 0;
    counters.embedTexts = 0;
    const started = performance.now();
    let corrections = [];
    const rows = await vdb.searchDocuments({
        query: c.query,
        top_k: TOP_K,
        search,
        collections: ['storage'],
        onNormalize: found => { corrections = found; }
    });
    const ms = performance.now() - started;
    const info = vdb.searchRequestInfo(search);
    const assessment = assessRelevance(rows, { rerankActive: info.rerankActive, floor: info.floor });
    return {
        ms,
        rejected: assessment.rejected,
        rerankedDocs: info.rerankActive ? Math.min(RERANK_SHORTLIST, Math.max(rows.length, 1)) : 0,
        embedCalls: counters.embedCalls,
        embedTexts: counters.embedTexts,
        corrections,
        values: rows.map(r => r.path ?? r.id),
        raw: rows.map(r => ({
            path: r.path,
            id: r.id,
            rerankScore: r.rerankScore ?? null,
            vectorRank: r.vectorRank ?? null,
            lexicalRank: r.lexicalRank ?? null,
            rrfScore: r.rrfScore ?? null
        }))
    };
}

async function runMemory(c, search) {
    counters.embedCalls = 0;
    counters.embedTexts = 0;
    const started = performance.now();
    const reply = await memory.memory_recall({ query: c.query, limit: TOP_K, search }, context);
    const ms = performance.now() - started;
    const text = reply.content[0].text;
    const rejected = /No relevant memories/.test(text);
    const values = [...text.matchAll(/\[#(\d+)\]/g)].map(m => m[1]);
    const rerankActive = search.rerank !== false;
    return {
        ms,
        rejected,
        rerankedDocs: rerankActive && !rejected ? Math.min(RERANK_SHORTLIST, Math.max(values.length, 1)) : 0,
        embedCalls: counters.embedCalls,
        embedTexts: counters.embedTexts,
        corrections: [],
        values,
        raw: text
    };
}

const results = [];
for (const c of CASES) {
    for (const [configName, search] of Object.entries(CONFIGS)) {
        const outcome = c.lane === 'storage' ? await runStorage(c, search) : await runMemory(c, search);
        const rank = matchRank(outcome.values, c.targets);
        results.push({
            caseId: c.id,
            set: c.set,
            lane: c.lane,
            class: c.class,
            action: c.action,
            query: c.query,
            targets: c.targets,
            config: configName,
            rank,
            rejected: outcome.rejected,
            ms: Math.round(outcome.ms),
            embedCalls: outcome.embedCalls,
            embedTexts: outcome.embedTexts,
            rerankedDocs: outcome.rerankedDocs,
            corrections: outcome.corrections,
            top: outcome.values.slice(0, TOP_K),
            raw: outcome.raw
        });
    }
}

// ── aggregates ────────────────────────────────────────────────────────
function pct(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index];
}

function summarize(rows) {
    const matchCases = rows.filter(r => r.action === 'match');
    const rejectCases = rows.filter(r => r.action === 'reject');
    const found = matchCases.filter(r => r.rank !== null);
    const latency = rows.map(r => r.ms);
    return {
        cases: rows.length,
        hit1: matchCases.filter(r => r.rank === 1).length,
        hit3: matchCases.filter(r => r.rank !== null && r.rank <= 3).length,
        hit10: found.length,
        matchCases: matchCases.length,
        mrr: matchCases.length ? Number((matchCases.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / matchCases.length).toFixed(4)) : null,
        rejectCases: rejectCases.length,
        rejected: rejectCases.filter(r => r.rejected).length,
        p50: pct(latency, 50),
        p95: pct(latency, 95),
        embedCalls: rows.reduce((sum, r) => sum + r.embedCalls, 0),
        rerankedDocs: rows.reduce((sum, r) => sum + r.rerankedDocs, 0)
    };
}

const summary = {};
for (const setName of ['baseline', 'holdout']) {
    summary[setName] = {};
    for (const configName of Object.keys(CONFIGS)) {
        summary[setName][configName] = summarize(results.filter(r => r.set === setName && r.config === configName));
    }
}

function table(setName) {
    const header = '| config | hit@1 | hit@3 | hit@10 | MRR | nonsense rejected | p50 ms | p95 ms | embeddings | rerank docs |';
    const lines = [header, '|---|---|---|---|---|---|---|---|---|---|'];
    for (const configName of Object.keys(CONFIGS)) {
        const s = summary[setName][configName];
        lines.push(`| ${configName} | ${s.hit1}/${s.matchCases} | ${s.hit3}/${s.matchCases} | ${s.hit10}/${s.matchCases} | ${s.mrr} | ${s.rejected}/${s.rejectCases} | ${s.p50} | ${s.p95} | ${s.embedCalls} | ${s.rerankedDocs} |`);
    }
    return lines.join('\n');
}

function classTable(setName) {
    const classes = [...new Set(CASES.filter(c => c.set === setName).map(c => c.class))];
    const lines = ['| class | config | hit@1 | hit@3 | MRR |', '|---|---|---|---|---|'];
    for (const cls of classes) {
        for (const configName of Object.keys(CONFIGS)) {
            const s = summarize(results.filter(r => r.set === setName && r.config === configName && r.class === cls));
            lines.push(`| ${cls} | ${configName} | ${s.hit1}/${s.matchCases} | ${s.hit3}/${s.matchCases} | ${s.mrr} |`);
        }
    }
    return lines.join('\n');
}

function detailRows(setName, configName) {
    return results
        .filter(r => r.set === setName && r.config === configName)
        .map(r => `| ${r.caseId} | ${r.class} | ${r.rank ?? (r.rejected ? 'rejected' : '—')} | ${r.ms} | ${r.top[0] ?? '—'} |`)
        .join('\n');
}

const report = [
    '# Retrieval baseline — labeled set, four configurations',
    '',
    `Run: ${startedAt}  ·  index: ${config.agents.vdb.dbPath}  ·  init ${initMs} ms`,
    `Reranker: ${RERANK_MODEL} (shortlist ${RERANK_SHORTLIST}, weight ${config.agents.vdb.rerank.weight})`,
    `Queries: ${CASES.length} (${BASELINE.length} baseline, ${HOLDOUT.length} holdout) × ${Object.keys(CONFIGS).length} configs`,
    '',
    'No ranking code was changed for this run. `full` is the current config default',
    '(dense + lexical + diversity + rerank); the other three switch layers off per request.',
    '',
    '## Baseline set',
    '',
    table('baseline'),
    '',
    '## Holdout set (never used for tuning)',
    '',
    table('holdout'),
    '',
    '## Per class',
    '',
    '### Baseline',
    '',
    classTable('baseline'),
    '',
    '### Holdout',
    '',
    classTable('holdout'),
    '',
    '## Per-query rank (baseline, full stack)',
    '',
    '| case | class | rank | ms | top-1 |',
    '|---|---|---|---|---|',
    detailRows('baseline', 'full'),
    '',
    '## Per-query rank (holdout, full stack)',
    '',
    '| case | class | rank | ms | top-1 |',
    '|---|---|---|---|---|',
    detailRows('holdout', 'full'),
    '',
    '`rank` = 1-based position of the first labeled target in the top 10, `rejected` = the stack said no relevant match, `—` = target absent.'
].join('\n');

fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
    runId,
    startedAt,
    index: config.agents.vdb.dbPath,
    reranker: { model: RERANK_MODEL, shortlist: RERANK_SHORTLIST, weight: config.agents.vdb.rerank.weight },
    configs: CONFIGS,
    cases: CASES,
    results,
    summary
}, null, 2));
fs.writeFileSync(path.join(outDir, 'report.md'), report, 'utf8');

console.log(report);
console.log(`\nartifacts: ${outDir}`);

await vdb.shutdown();
await memory.shutdown();
