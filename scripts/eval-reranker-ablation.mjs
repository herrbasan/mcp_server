/**
 * Reranker ablation benchmark against live `nvdb serve` (v2).
 *
 * Measures:
 *  1. Ranking impact: Level-1 only vs rerank(0.2) vs rerank(0.5) vs rerank(1.0) vs pure-rerank
 *     (Hit@1, Hit@3, MRR, and exact list of queries helped vs hurt).
 *  2. Nonsense & out-of-domain (OOD) separation:
 *     Compare raw Qwen3-4B dense cosine vs ONNX cross-encoder rerank score.
 *  3. Latency breakdown: embed ms vs Level-1 hybrid ms vs Level-2 ONNX rerank ms.
 *
 * Read-only against http://127.0.0.1:3510.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmbedClient } from '../src/embed-client.js';
import { createV2Client } from '../src/agents/vdb/v2-client.js';
import { classifyQueryProfile } from '../src/agents/vdb/search-options.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const REAL_CASES = [
    // --- MEMORY ---
    { coll: 'memory', id: 'mem-nvdb-host', query: 'Which machine hosts the new standalone vector database?', match: p => p === 'memory/7192' || p === 'memory/7193' },
    { coll: 'memory', id: 'mem-coolkid-gpu-de', query: 'Welche GPU steckt in Coolkid?', match: p => p === 'memory/1547' || p === 'memory/5804' },
    { coll: 'memory', id: 'mem-cloud-embed-en', query: 'why did we switch away from cloud embeddings', match: p => ['memory/778', 'memory/368', 'memory/780'].includes(p) },
    { coll: 'memory', id: 'mem-cloud-embed-de', query: 'Warum haben wir Cloud-Embeddings aufgegeben?', match: p => ['memory/368', 'memory/778', 'memory/780'].includes(p) },
    { coll: 'memory', id: 'mem-prototype-fund', query: 'Prototype Fund 47.5k application November 30 funding', match: p => p === 'memory/6830' },
    { coll: 'memory', id: 'mem-prototype-typo', query: 'Prototyp Funt funding', match: p => p === 'memory/6830' },
    { coll: 'memory', id: 'mem-harness-exhaust', query: 'importance recency maps harness durable meaning operational exhaust', match: p => p === 'memory/6955' },
    { coll: 'memory', id: 'mem-commit-hash', query: 'a2e3c27', match: p => ['memory/7184', 'memory/7180', 'memory/7179'].includes(p) },
    { coll: 'memory', id: 'mem-prose-with-hash', query: 'what changed in commit a2e3c27?', match: p => ['memory/7184', 'memory/7180', 'memory/7179'].includes(p) },
    { coll: 'memory', id: 'mem-nteligence', query: 'nTeligence', match: p => ['memory/6911', 'memory/6931', 'memory/6795', 'memory/6799', 'memory/6951'].includes(p) },
    { coll: 'memory', id: 'mem-religion-v6', query: 'A Little Religion v6 final', match: p => p === 'memory/2103' },
    { coll: 'memory', id: 'mem-fatten-gpu', query: 'What GPU does Fatten have?', match: p => ['memory/4906', 'memory/1547', 'memory/778', 'memory/780'].includes(p) },
    { coll: 'memory', id: 'mem-open-source-ntel', query: 'Is nTeligence open source or closed platform?', match: p => p === 'memory/6799' },
    { coll: 'memory', id: 'mem-gsb-robots-mem', query: 'GSB robots.txt default disallow convention', match: p => p === 'memory/3968' },

    // --- STORAGE ---
    { coll: 'storage', id: 'sto-ai-conciousness', query: 'AI Conciousness', match: p => /consciousness|what-are-we-even-talking-about/i.test(p) },
    { coll: 'storage', id: 'sto-consciousness-rec', query: 'Consciousness Is the Record', match: p => p === 'blog/attic/consciousness-is-the-record.md' || p === 'blog/attic/consciousness-is-the-record-v2.md' },
    { coll: 'storage', id: 'sto-consciousness-q', query: 'What did we say about AI consciousness?', match: p => /consciousness|what-are-we-even-talking-about/i.test(p) },
    { coll: 'storage', id: 'sto-consciousness-de', query: 'Worüber reden wir bei KI Bewusstsein?', match: p => /what-are-we-even-talking-about|consciousness/i.test(p) },
    { coll: 'storage', id: 'sto-fail-fast-prose', query: 'how do we handle defensive programming and silent fallbacks?', match: p => /Agents_Prime|coding-philosophy/i.test(p) },
    { coll: 'storage', id: 'sto-md-blocks-spec', query: 'md-blocks-spec', match: p => p === 'documentation/md-blocks/md-blocks-spec.md' },
    { coll: 'storage', id: 'sto-prose-with-code', query: 'how does mb:columns weights work in md-blocks?', match: p => /md-blocks/i.test(p) },
    { coll: 'storage', id: 'sto-dkv-compound-de', query: 'Krankenversicherung Bescheinigung Finanzamt', match: p => /dkv|bescheinigung|versicherung/i.test(p) },
    { coll: 'storage', id: 'sto-gsb-robots-de', query: 'Wo steht im GSB Handbuch etwas über robots.txt?', match: p => /gsb11anwendungshandbuch|local-vision-run/i.test(p) },
    { coll: 'storage', id: 'sto-preset-narration', query: 'preset=narration:david-a-renelt', match: p => p === 'scratch/nspeech-dialogue-mode-handover.md' || p === 'blog/drafts/the-drill.md' },
    { coll: 'storage', id: 'sto-narration-de', query: 'Wie markiere ich verschiedene Sprecher in MD-Blocks?', match: p => /nspeech-dialogue-mode-handover|md-blocks-spec|BRIEF|Agents_Prime/i.test(p) },
    { coll: 'storage', id: 'sto-david-bio', query: 'David A. Renelt author bio Munich', match: p => p === 'blog/authors/david-a-renelt.md' },
];

const OOD_NONSENSE_CASES = [
    { coll: 'memory', id: 'ood-mem-gibberish', query: 'xyzzy quantum banana radiator' },
    { coll: 'memory', id: 'ood-mem-nonsense2', query: 'florb snazzle quux blargle' },
    { coll: 'memory', id: 'ood-mem-baking-en', query: 'sourdough croissant laminated butter recipe 180C' },
    { coll: 'memory', id: 'ood-mem-penguins-de', query: 'Pinguine in der Antarktis Paarungsverhalten Eisberg' },
    { coll: 'memory', id: 'ood-mem-fake-hash', query: 'deadbeef987654' },
    { coll: 'storage', id: 'ood-sto-gibberish', query: 'zxqjvplkmn wqertyuiop' },
    { coll: 'storage', id: 'ood-sto-nonsense2', query: 'xyzzy quantum banana radiator' },
    { coll: 'storage', id: 'ood-sto-baking-en', query: 'sourdough croissant laminated butter recipe 180C' },
    { coll: 'storage', id: 'ood-sto-penguins-de', query: 'Pinguine in der Antarktis Paarungsverhalten Eisberg' },
    { coll: 'storage', id: 'ood-sto-fake-hash', query: 'deadbeef987654' },
];

function formatQuery(query, instruct) {
    return instruct ? `Instruct: ${instruct}\nQuery: ${query}` : query;
}

function hitPath(h) {
    return h.hit.path || h.hit.parent_id || h.hit.id;
}

function findRank(hits, matchFn) {
    const i = hits.findIndex(h => matchFn(hitPath(h)));
    return i === -1 ? null : i + 1;
}

async function evalCase(client, embed, cfg, c) {
    const vdbCfg = cfg.agents.vdb;
    const cls = classifyQueryProfile(c.query);
    const principals = vdbCfg.principals || ['default'];

    const t0 = performance.now();
    const qv = await embed.embed(formatQuery(c.query, vdbCfg.queryInstruct), { path: vdbCfg.embeddingPath });
    const embedMs = performance.now() - t0;

    const t1 = performance.now();
    const l1Res = await client.hybridSearch(c.coll, {
        lexical: {
            text: c.query,
            top_k: 20,
            principals,
            fuzzy_edits: vdbCfg.fuzzyEdits ?? 1,
            explain: false,
            group_by_parent: { max_per_parent: 2 },
            filters: {},
        },
        query_vector: qv,
        dense: true,
        lexical_enabled: true,
        candidate_k: 200,
        rrf_k: cls.rrfK,
        lexical_weight: cls.lexicalWeight,
        vector_weight: cls.vectorWeight,
    });
    const l1Ms = performance.now() - t1;
    const l1Hits = l1Res.hits || [];

    // Pure dense top1 cosine (for OOD comparison)
    const vecOnly = await client.hybridSearch(c.coll, {
        lexical: { text: c.query, top_k: 5, principals, fuzzy_edits: 0, explain: false, group_by_parent: { max_per_parent: 2 }, filters: {} },
        query_vector: qv, dense: true, lexical_enabled: false, candidate_k: 50, rrf_k: 20, lexical_weight: 0, vector_weight: 1,
    });
    const maxCos = vecOnly.hits?.[0]?.vector_score ?? 0;

    const t2 = performance.now();
    const l2_02 = l1Hits.length > 0 ? await client.level2(c.coll, {
        query_text: c.query, principals, hits: l1Hits, shortlist: 20, rerank_weight: 0.2, relevance_floor: 0.0,
    }) : { best_rerank_score: 0, hits: [] };
    const l2Ms = performance.now() - t2;

    const l2_05 = l1Hits.length > 0 ? await client.level2(c.coll, {
        query_text: c.query, principals, hits: l1Hits, shortlist: 20, rerank_weight: 0.5, relevance_floor: 0.0,
    }) : { best_rerank_score: 0, hits: [] };

    const l2_10 = l1Hits.length > 0 ? await client.level2(c.coll, {
        query_text: c.query, principals, hits: l1Hits, shortlist: 20, rerank_weight: 1.0, relevance_floor: 0.0,
    }) : { best_rerank_score: 0, hits: [] };

    const pureRerank = [...(l2_02.hits || [])]
        .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0))
        .map(x => x.hybrid);

    return {
        c,
        profile: cls.profile,
        embedMs,
        l1Ms,
        l2Ms,
        maxCos,
        bestRerank: l2_02.best_rerank_score ?? 0,
        lexHitsCount: l1Hits.filter(h => h.lexical_rank != null).length,
        orders: {
            l1: l1Hits,
            rr02: (l2_02.hits || []).map(x => x.hybrid),
            rr05: (l2_05.hits || []).map(x => x.hybrid),
            rr10: (l2_10.hits || []).map(x => x.hybrid),
            pureRR: pureRerank,
        },
    };
}

function summarizeMetrics(results, key) {
    let hit1 = 0, hit3 = 0, hit5 = 0, mrr = 0;
    for (const r of results) {
        const rank = findRank(r.orders[key], r.c.match);
        if (rank === 1) hit1++;
        if (rank !== null && rank <= 3) hit3++;
        if (rank !== null && rank <= 5) hit5++;
        if (rank !== null) mrr += 1 / rank;
    }
    const n = results.length;
    return {
        hit1: `${hit1}/${n}`,
        hit3: `${hit3}/${n}`,
        hit5: `${hit5}/${n}`,
        mrr: (mrr / n).toFixed(4),
    };
}

async function main() {
    const cfg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
    const client = createV2Client(cfg.agents.vdb.serviceUrl);
    const embed = createEmbedClient(cfg.gateway.httpUrl, cfg.gateway.accessKey);

    const realResults = [];
    for (const c of REAL_CASES) {
        realResults.push(await evalCase(client, embed, cfg, c));
    }
    const oodResults = [];
    for (const c of OOD_NONSENSE_CASES) {
        oodResults.push(await evalCase(client, embed, cfg, c));
    }

    console.log('=== 1. RANKING QUALITY (26 REAL QUERIES: 14 MEMORY + 12 STORAGE) ===');
    for (const [label, key] of [
        ['Level-1 only (NO rerank)', 'l1'],
        ['Level-1 + rerank(w=0.2) [LIVE]', 'rr02'],
        ['Level-1 + rerank(w=0.5)', 'rr05'],
        ['Level-1 + rerank(w=1.0)', 'rr10'],
        ['Pure rerank order (100% ONNX)', 'pureRR'],
    ]) {
        const m = summarizeMetrics(realResults, key);
        console.log(`${label.padEnd(32)} Hit@1=${m.hit1.padEnd(6)} Hit@3=${m.hit3.padEnd(6)} Hit@5=${m.hit5.padEnd(6)} MRR=${m.mrr}`);
    }

    console.log('\n=== 2. EXACT DIFFS: WHERE RERANK CHANGED RANK VS LEVEL-1 ===');
    for (const r of realResults) {
        const rL1 = findRank(r.orders.l1, r.c.match);
        const r02 = findRank(r.orders.rr02, r.c.match);
        const rPure = findRank(r.orders.pureRR, r.c.match);
        if (rL1 !== r02 || rL1 !== rPure) {
            console.log(
                `${r.c.id.padEnd(24)} L1=${String(rL1 ?? 'miss').padEnd(4)} -> rr(0.2)=${String(r02 ?? 'miss').padEnd(4)} | pureRR=${String(rPure ?? 'miss').padEnd(4)} | bestRR=${r.bestRerank.toFixed(3)} cos=${r.maxCos.toFixed(3)}`
            );
        }
    }

    console.log('\n=== 3. LATENCY (AVERAGE & P95) ===');
    const all = [...realResults, ...oodResults];
    const avg = arr => (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
    const p95 = arr => [...arr].sort((a, b) => a - b)[Math.floor(arr.length * 0.95)].toFixed(1);
    console.log(`Embed (nBed/Fatten): avg=${avg(all.map(r => r.embedMs))}ms  p95=${p95(all.map(r => r.embedMs))}ms`);
    console.log(`Level-1 (nvdb RRF):  avg=${avg(all.map(r => r.l1Ms))}ms  p95=${p95(all.map(r => r.l1Ms))}ms`);
    console.log(`Level-2 (ONNX 20x):  avg=${avg(all.map(r => r.l2Ms))}ms  p95=${p95(all.map(r => r.l2Ms))}ms`);

    console.log('\n=== 4. REAL vs NONSENSE/OOD SEPARATION (COSINE vs ONNX RERANK) ===');
    const minRealCos = Math.min(...realResults.map(r => r.maxCos));
    const maxOodCos = Math.max(...oodResults.map(r => r.maxCos));
    const minRealRR = Math.min(...realResults.map(r => r.bestRerank));
    const maxOodRR = Math.max(...oodResults.map(r => r.bestRerank));

    console.log(`Qwen3-4B maxCos:   min(REAL)=${minRealCos.toFixed(4)}  vs  max(OOD)=${maxOodCos.toFixed(4)}  ${minRealCos > maxOodCos ? 'CLEAN SEPARATION' : 'OVERLAP!'}`);
    console.log(`ONNX bestRerank:   min(REAL)=${minRealRR.toFixed(4)}  vs  max(OOD)=${maxOodRR.toFixed(4)}  ${minRealRR > maxOodRR ? 'CLEAN SEPARATION' : 'OVERLAP!'}`);

    console.log('\nLowest 5 REAL queries:');
    for (const r of [...realResults].sort((a, b) => a.bestRerank - b.bestRerank).slice(0, 5)) {
        console.log(`  REAL ${r.c.id.padEnd(24)} cos=${r.maxCos.toFixed(4)}  rerank=${r.bestRerank.toFixed(4)}  lexHits=${r.lexHitsCount}`);
    }
    console.log('All 10 OOD/NONSENSE queries:');
    for (const r of oodResults) {
        console.log(`  OOD  ${r.c.id.padEnd(24)} cos=${r.maxCos.toFixed(4)}  rerank=${r.bestRerank.toFixed(4)}  lexHits=${r.lexHitsCount}  top1=${hitPath(r.orders.l1[0] || { hit: { id: 'none' } })}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
