/**
 * Reranker shortlist x weight grid sweep against live `nvdb serve` (v2).
 *
 * Measures REAL wall-clock Level-2 latency at each shortlist size (8, 10, 12, 15, 20)
 * and evaluates ranking quality (Hit@1, Hit@3, Hit@5, MRR, OOD separation) across
 * rerank_weight = [0.0, 0.2, 0.3, 0.4, 0.45, 0.5, 0.6, 0.75, 1.0].
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

const OOD_CASES = [
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

const SHORTLISTS = [8, 10, 12, 15, 20];
const WEIGHTS = [0.2, 0.3, 0.4, 0.45, 0.5, 0.6, 0.75, 1.0];
const LEVEL2_RRF_K = 60.0;

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

// Mirror of nVDB src/v2/level2.rs fusion so we only need 1 ONNX call per shortlist size.
function fuseLevel2(survivors, rerankWeight) {
    const n = survivors.length;
    const order = survivors.map((s, idx) => ({ idx, score: 1.0 / (LEVEL2_RRF_K + idx + 1) }));
    const rerankOrder = survivors
        .map((s, idx) => ({ idx, rr: s.rerank_score ?? 0 }))
        .sort((a, b) => (b.rr - a.rr) || (a.idx - b.idx));
    rerankOrder.forEach((item, rank) => {
        order[item.idx].score += rerankWeight / (LEVEL2_RRF_K + rank + 1);
    });
    order.sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
    return order.map(o => survivors[o.idx].hybrid);
}

async function main() {
    const cfg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
    const vdbCfg = cfg.agents.vdb;
    const principals = vdbCfg.principals || ['default'];
    const client = createV2Client(vdbCfg.serviceUrl);
    const embed = createEmbedClient(cfg.gateway.httpUrl, cfg.gateway.accessKey);

    // 1. Collect Level-1 hits once for all 26 real + 10 OOD cases
    const realL1 = [];
    for (const c of REAL_CASES) {
        const cls = classifyQueryProfile(c.query);
        const qv = await embed.embed(formatQuery(c.query, vdbCfg.queryInstruct), { path: vdbCfg.embeddingPath });
        const res = await client.hybridSearch(c.coll, {
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
        realL1.push({ c, hits: res.hits || [] });
    }

    const oodL1 = [];
    for (const c of OOD_CASES) {
        const cls = classifyQueryProfile(c.query);
        const qv = await embed.embed(formatQuery(c.query, vdbCfg.queryInstruct), { path: vdbCfg.embeddingPath });
        const res = await client.hybridSearch(c.coll, {
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
        oodL1.push({ c, hits: res.hits || [] });
    }

    // Show where real targets land in Level-1 (identifies shortlist cutoff risk)
    console.log('=== LEVEL-1 TARGET RANKS > 5 ===');
    for (const item of realL1) {
        const r = findRank(item.hits, item.c.match);
        if (r === null || r > 5) {
            console.log(`  ${item.c.id.padEnd(24)} L1_rank=${r ?? 'miss(>20)'}`);
        }
    }

    // 2. Measure REAL wall-clock Level-2 latency + scores for each shortlist size
    console.log('\n=== SHORTLIST x WEIGHT SWEEP (26 REAL + 10 OOD) ===');
    const summaryRows = [];
    const bySl = new Map();

    for (const sl of SHORTLISTS) {
        const realL2 = [];
        const l2Times = [];
        for (const item of realL1) {
            const t0 = performance.now();
            const l2 = await client.level2(item.c.coll, {
                query_text: item.c.query,
                principals,
                hits: item.hits,
                shortlist: sl,
                rerank_weight: 0.0, // weight=0 preserves exact L1 survivor order while returning ONNX rerank_score
                relevance_floor: 0.0,
            });
            l2Times.push(performance.now() - t0);
            realL2.push({ c: item.c, survivors: l2.hits || [], bestRR: l2.best_rerank_score ?? 0 });
        }
        bySl.set(sl, realL2);

        const oodBest = [];
        for (const item of oodL1) {
            const t0 = performance.now();
            const l2 = await client.level2(item.c.coll, {
                query_text: item.c.query,
                principals,
                hits: item.hits,
                shortlist: sl,
                rerank_weight: 0.0,
                relevance_floor: 0.0,
            });
            l2Times.push(performance.now() - t0);
            oodBest.push(l2.best_rerank_score ?? 0);
        }

        const avgMs = l2Times.reduce((a, b) => a + b, 0) / l2Times.length;
        const p95Ms = [...l2Times].sort((a, b) => a - b)[Math.floor(l2Times.length * 0.95)];
        const minRealRR = Math.min(...realL2.map(r => r.bestRR));
        const maxOodRR = Math.max(...oodBest);

        console.log(`\n--- shortlist=${sl} | L2 avg=${avgMs.toFixed(1)}ms p95=${p95Ms.toFixed(1)}ms | OOD gap: minReal=${minRealRR.toFixed(3)} vs maxOod=${maxOodRR.toFixed(3)} (${(minRealRR / Math.max(maxOodRR, 1e-6)).toFixed(1)}x) ---`);

        for (const w of WEIGHTS) {
            let hit1 = 0, hit3 = 0, hit5 = 0, mrr = 0;
            for (const r of realL2) {
                const ordered = fuseLevel2(r.survivors, w);
                const rank = findRank(ordered, r.c.match);
                if (rank === 1) hit1++;
                if (rank !== null && rank <= 3) hit3++;
                if (rank !== null && rank <= 5) hit5++;
                if (rank !== null) mrr += 1 / rank;
            }
            const n = realL2.length;
            const mrrVal = mrr / n;
            summaryRows.push({ sl, w, hit1, hit3, hit5, mrr: mrrVal, avgMs, p95Ms, minRealRR, maxOodRR });
            console.log(`  w=${w.toFixed(2)}  Hit@1=${String(hit1).padStart(2)}/${n}  Hit@3=${String(hit3).padStart(2)}/${n}  Hit@5=${String(hit5).padStart(2)}/${n}  MRR=${mrrVal.toFixed(4)}`);
        }

        // Verify live nvdb serve matches our local fuseLevel2 at w=0.5 on first 3 queries
        if (sl === 12) {
            for (const item of realL1.slice(0, 3)) {
                const live = await client.level2(item.c.coll, {
                    query_text: item.c.query,
                    principals,
                    hits: item.hits,
                    shortlist: sl,
                    rerank_weight: 0.5,
                    relevance_floor: 0.0,
                });
                const liveIds = (live.hits || []).map(x => x.hybrid.hit.id);
                const localIds = fuseLevel2(realL2.find(r => r.c.id === item.c.id).survivors, 0.5).map(x => x.hit.id);
                if (JSON.stringify(liveIds) !== JSON.stringify(localIds)) {
                    throw new Error(`fuseLevel2 mismatch vs live server on ${item.c.id}`);
                }
            }
        }
    }

    // Print detailed per-query comparison for key candidates
    console.log('\n=== TOP CONFIGS BY MRR (WITH LATENCY) ===');
    const sorted = [...summaryRows].sort((a, b) => (b.mrr - a.mrr) || (a.avgMs - b.avgMs));
    for (const r of sorted.slice(0, 10)) {
        console.log(`  sl=${String(r.sl).padStart(2)} w=${r.w.toFixed(2)}  MRR=${r.mrr.toFixed(4)}  Hit@1=${r.hit1}/26  Hit@3=${r.hit3}/26  Hit@5=${r.hit5}/26  L2=${r.avgMs.toFixed(0)}ms (p95 ${r.p95Ms.toFixed(0)}ms)`);
    }

    console.log('\n=== PER-QUERY DIFFS (live sl=20/w=0.20 vs sl=10/w=0.60 vs sl=10/w=0.75 vs sl=12/w=0.60 vs sl=20/w=0.60) ===');
    for (let i = 0; i < realL1.length; i++) {
        const c = realL1[i].c;
        const rL1 = findRank(realL1[i].hits, c.match);
        const rLive = findRank(fuseLevel2(bySl.get(20)[i].survivors, 0.20), c.match);
        const r10_60 = findRank(fuseLevel2(bySl.get(10)[i].survivors, 0.60), c.match);
        const r10_75 = findRank(fuseLevel2(bySl.get(10)[i].survivors, 0.75), c.match);
        const r12_60 = findRank(fuseLevel2(bySl.get(12)[i].survivors, 0.60), c.match);
        const r20_60 = findRank(fuseLevel2(bySl.get(20)[i].survivors, 0.60), c.match);
        const vals = [rL1, rLive, r10_60, r10_75, r12_60, r20_60];
        if (new Set(vals).size > 1) {
            const f = v => String(v ?? 'miss').padStart(4);
            console.log(`  ${c.id.padEnd(24)} L1=${f(rL1)} live(20/.2)=${f(rLive)} 10/.6=${f(r10_60)} 10/.75=${f(r10_75)} 12/.6=${f(r12_60)} 20/.6=${f(r20_60)}`);
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
