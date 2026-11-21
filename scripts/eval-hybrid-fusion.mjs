/**
 * Golden retrieval benchmark & fusion ablation against live `nvdb serve` (v2).
 *
 * Read-only: calls `http://127.0.0.1:3510` + `http://localhost:3400/v1/embeddings`
 * to compare retrieval strategies on memory and storage queries (mcp_server #87).
 *
 * Usage:
 *   node scripts/eval-hybrid-fusion.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEmbedClient } from '../src/embed-client.js';
import { createV2Client } from '../src/agents/vdb/v2-client.js';
import { classifyQueryProfile } from '../src/agents/vdb/search-options.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const GOLDEN_MEMORY = [
    {
        id: 'mem-nvdb-host',
        kind: 'semantic-en',
        query: 'Which machine hosts the new standalone vector database?',
        targets: ['memory/7192', 'memory/7193'],
        topN: 3,
    },
    {
        id: 'mem-coolkid-gpu-de',
        kind: 'semantic-de',
        query: 'Welche GPU steckt in Coolkid?',
        targets: ['memory/1547', 'memory/5804'],
        topN: 3,
    },
    {
        id: 'mem-cloud-embed-en',
        kind: 'semantic-en',
        query: 'why did we switch away from cloud embeddings',
        targets: ['memory/778', 'memory/368', 'memory/780'],
        topN: 3,
    },
    {
        id: 'mem-cloud-embed-de',
        kind: 'semantic-de',
        query: 'Warum haben wir Cloud-Embeddings aufgegeben?',
        targets: ['memory/368', 'memory/778', 'memory/780'],
        topN: 3,
    },
    {
        id: 'mem-prototype-fund',
        kind: 'keyword-rich',
        query: 'Prototype Fund 47.5k application November 30 funding',
        targets: ['memory/6830'],
        topN: 1,
    },
    {
        id: 'mem-prototype-typo',
        kind: 'typo-topic',
        query: 'Prototyp Funt funding',
        targets: ['memory/6830'],
        topN: 3,
    },
    {
        id: 'mem-harness-exhaust',
        kind: 'keyword-rich',
        query: 'importance recency maps harness durable meaning operational exhaust',
        targets: ['memory/6955'],
        topN: 1,
    },
    {
        id: 'mem-commit-hash',
        kind: 'exact-id',
        query: 'a2e3c27',
        targets: ['memory/7184', 'memory/7180', 'memory/7179'],
        topN: 3,
        requireAll: true,
    },
    {
        id: 'mem-prose-with-hash',
        kind: 'prose-exact-id',
        query: 'what changed in commit a2e3c27?',
        targets: ['memory/7184', 'memory/7180', 'memory/7179'],
        topN: 3,
    },
    {
        id: 'mem-nteligence',
        kind: 'exact-name',
        query: 'nTeligence',
        targets: ['memory/6911', 'memory/6931', 'memory/6795', 'memory/6799', 'memory/6951'],
        topN: 5,
    },
    {
        id: 'mem-religion-v6',
        kind: 'exact-title',
        query: 'A Little Religion v6 final',
        targets: ['memory/2103'],
        topN: 1,
    },
    {
        id: 'mem-nonsense-1',
        kind: 'nonsense',
        query: 'xyzzy quantum banana radiator',
        targets: [],
        expectReject: true,
    },
    {
        id: 'mem-nonsense-2',
        kind: 'nonsense',
        query: 'florb snazzle quux blargle',
        targets: [],
        expectReject: true,
    },
];

const GOLDEN_STORAGE = [
    {
        id: 'sto-ai-conciousness-typo',
        kind: 'typo-topic',
        query: 'AI Conciousness',
        matchPath: p => /consciousness|what-are-we-even-talking-about/i.test(p),
        topN: 3,
    },
    {
        id: 'sto-consciousness-record',
        kind: 'exact-title',
        query: 'Consciousness Is the Record',
        matchPath: p => p === 'blog/attic/consciousness-is-the-record.md' || p === 'blog/attic/consciousness-is-the-record-v2.md',
        topN: 1,
    },
    {
        id: 'sto-consciousness-question',
        kind: 'semantic-en',
        query: 'What did we say about AI consciousness?',
        matchPath: p => /consciousness|what-are-we-even-talking-about/i.test(p),
        topN: 3,
    },
    {
        id: 'sto-consciousness-de',
        kind: 'semantic-de',
        query: 'Worüber reden wir bei KI Bewusstsein?',
        matchPath: p => /what-are-we-even-talking-about|consciousness/i.test(p),
        topN: 3,
    },
    {
        id: 'sto-fail-fast-prose',
        kind: 'semantic-en',
        query: 'how do we handle defensive programming and silent fallbacks?',
        matchPath: p => /Agents_Prime|coding-philosophy/i.test(p),
        topN: 3,
    },
    {
        id: 'sto-md-blocks-spec',
        kind: 'exact-id',
        query: 'md-blocks-spec',
        matchPath: p => p === 'documentation/md-blocks/md-blocks-spec.md',
        topN: 1,
    },
    {
        id: 'sto-prose-with-code',
        kind: 'prose-exact-id',
        query: 'how does mb:columns weights work in md-blocks?',
        matchPath: p => /md-blocks/i.test(p),
        topN: 1,
    },
    {
        id: 'sto-dkv-compound-de',
        kind: 'compound-de',
        query: 'Krankenversicherung Bescheinigung Finanzamt',
        matchPath: p => /dkv|bescheinigung|versicherung/i.test(p),
        topN: 3,
    },
    {
        id: 'sto-gsb-robots-de',
        kind: 'prose-exact-id',
        query: 'Wo steht im GSB Handbuch etwas über robots.txt?',
        matchPath: p => /gsb11anwendungshandbuch|local-vision-run/i.test(p),
        topN: 3,
    },
    {
        id: 'sto-preset-narration',
        kind: 'exact-id',
        query: 'preset=narration:david-a-renelt',
        matchPath: p => p === 'scratch/nspeech-dialogue-mode-handover.md',
        topN: 3,
    },
    {
        id: 'sto-nonsense-1',
        kind: 'nonsense',
        query: 'zxqjvplkmn wqertyuiop',
        matchPath: () => false,
        expectReject: true,
    },
    {
        id: 'sto-nonsense-2',
        kind: 'nonsense',
        query: 'xyzzy quantum banana radiator',
        matchPath: () => false,
        expectReject: true,
    },
];

function isHitMatch(c, hit) {
    const id = hit.hit.id;
    const p = hit.hit.path || hit.hit.parent_id || id;
    if (c.targets) return c.targets.includes(p) || c.targets.includes(id);
    if (c.matchPath) return c.matchPath(p);
    return false;
}

function formatQuery(query, instruct) {
    return instruct ? `Instruct: ${instruct}\nQuery: ${query}` : query;
}

async function runStrategy(client, collName, c, queryVec, strategy, principals, fuzzyEdits, defaultFloor) {
    let lw = strategy.lexicalWeight;
    let vw = strategy.vectorWeight;
    let rrfK = strategy.rrfK ?? 60;
    const dense = strategy.dense ?? true;
    const lexical = strategy.lexical ?? true;
    const floor = strategy.floor ?? defaultFloor;

    if (strategy.adaptive) {
        const cls = classifyQueryProfile(c.query);
        lw = cls.lexicalWeight;
        vw = cls.vectorWeight;
        rrfK = cls.rrfK;
    }

    const res = await client.hybridSearch(collName, {
        lexical: {
            text: c.query,
            top_k: 20,
            principals,
            fuzzy_edits: fuzzyEdits,
            explain: false,
            group_by_parent: { max_per_parent: 2 },
            filters: {},
        },
        query_vector: dense ? queryVec : null,
        dense,
        lexical_enabled: lexical,
        candidate_k: 200,
        rrf_k: rrfK,
        lexical_weight: lw,
        vector_weight: vw,
    });

    let hits = res.hits || [];
    let rejected = false;
    let bestRerank = null;

    if (strategy.rerank && hits.length > 0) {
        const l2 = await client.level2(collName, {
            query_text: c.query,
            principals,
            hits,
            shortlist: 20,
            rerank_weight: strategy.rerankWeight ?? 0.2,
            relevance_floor: floor,
        });
        rejected = Boolean(l2.rejected);
        bestRerank = l2.best_rerank_score;
        if (strategy.floorOnly) {
            hits = l2.rejected ? [] : hits;
        } else {
            hits = l2.rejected ? [] : (l2.hits || []).map(x => ({ ...x.hybrid, _rerank: x.rerank_score }));
        }
    }

    if (c.expectReject) {
        const pass = strategy.rerank ? rejected : (hits.length === 0);
        return { pass, rank: null, rejected, bestRerank, top1: hits[0]?.hit?.path || hits[0]?.hit?.id || null };
    }

    if (c.requireAll && c.targets) {
        const topPaths = hits.slice(0, c.topN).map(h => h.hit.path || h.hit.id);
        const matched = c.targets.filter(t => topPaths.includes(t)).length;
        return {
            pass: matched === c.targets.length,
            rank: `${matched}/${c.targets.length}`,
            rejected,
            bestRerank,
            top1: topPaths[0] || null,
        };
    }

    const rankIdx = hits.findIndex(h => isHitMatch(c, h));
    const rank = rankIdx === -1 ? null : rankIdx + 1;
    const pass = rank !== null && rank <= c.topN;
    return {
        pass,
        rank,
        rejected,
        bestRerank,
        top1: hits[0]?.hit?.path || hits[0]?.hit?.id || null,
    };
}

async function main() {
    const cfg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
    const vdbCfg = cfg.agents.vdb;
    const client = createV2Client(vdbCfg.serviceUrl);
    const embed = createEmbedClient(cfg.gateway.httpUrl, cfg.gateway.accessKey);
    const principals = vdbCfg.principals || ['default'];
    const fuzzyEdits = vdbCfg.fuzzyEdits ?? 1;
    const floor = vdbCfg.relevanceFloor ?? 0.02;

    const allCases = [
        ...GOLDEN_MEMORY.map(c => ({ ...c, coll: 'memory' })),
        ...GOLDEN_STORAGE.map(c => ({ ...c, coll: 'storage' })),
    ];

    const vecs = new Map();
    for (const c of allCases) {
        if (!vecs.has(c.query)) {
            vecs.set(c.query, await embed.embed(formatQuery(c.query, vdbCfg.queryInstruct), { path: vdbCfg.embeddingPath }));
        }
    }

    console.log('=== QUERY CLASSIFICATION & RERANK MARGIN ===');
    for (const c of allCases) {
        const cls = classifyQueryProfile(c.query);
        const r = await runStrategy(client, c.coll, c, vecs.get(c.query), {
            adaptive: true, rerank: true, rerankWeight: 0.2, floor: 0.05,
        }, principals, fuzzyEdits, floor);
        const status = r.pass ? 'PASS' : 'FAIL';
        const rr = r.bestRerank != null ? r.bestRerank.toFixed(4) : '-';
        console.log(
            `${status} ${c.id.padEnd(28)} cls=${cls.profile.padEnd(11)} (l=${cls.lexicalWeight} v=${cls.vectorWeight}) rank=${String(r.rank ?? (r.rejected ? 'REJ' : 'miss')).padEnd(4)} rr=${rr} top1=${r.top1}`
        );
    }

    const strategies = [
        { name: 'current (l=1 v=0.3 k=60 f=0.02)', lexicalWeight: 1.0, vectorWeight: 0.3, rrfK: 60, rerank: true, rerankWeight: 0.2, floor: 0.02 },
        { name: 'dense-only (no rerank)', dense: true, lexical: false, lexicalWeight: 0, vectorWeight: 1, rrfK: 60, rerank: false },
        { name: 'dense-only + floor(0.05)', dense: true, lexical: false, lexicalWeight: 0, vectorWeight: 1, rrfK: 60, rerank: true, floorOnly: true, floor: 0.05 },
        { name: 'equal (l=1 v=1 k=20 f=0.05)', lexicalWeight: 1.0, vectorWeight: 1.0, rrfK: 20, rerank: true, rerankWeight: 0.2, floor: 0.05 },
        { name: 'vec-heavy (l=0.3 v=1 k=20 f=0.05)', lexicalWeight: 0.3, vectorWeight: 1.0, rrfK: 20, rerank: true, rerankWeight: 0.2, floor: 0.05 },
        { name: 'adaptive + rr(0.2) f=0.02', adaptive: true, rerank: true, rerankWeight: 0.2, floor: 0.02 },
        { name: 'adaptive + rr(0.2) f=0.05', adaptive: true, rerank: true, rerankWeight: 0.2, floor: 0.05 },
        { name: 'adaptive + rr(0.5) f=0.05', adaptive: true, rerank: true, rerankWeight: 0.5, floor: 0.05 },
        { name: 'adaptive + floorOnly f=0.05', adaptive: true, rerank: true, floorOnly: true, floor: 0.05 },
    ];

    console.log('\n=== STRATEGY SCORECARD ===');
    for (const s of strategies) {
        let passed = 0;
        const fails = [];
        for (const c of allCases) {
            const r = await runStrategy(client, c.coll, c, vecs.get(c.query), s, principals, fuzzyEdits, floor);
            if (r.pass) passed++;
            else fails.push(`${c.id}(rank=${r.rank ?? 'miss'}${r.rejected ? ',REJ' : ''}${r.bestRerank != null ? ',rr=' + r.bestRerank.toFixed(3) : ''},top1=${r.top1})`);
        }
        console.log(`${s.name.padEnd(36)} ${String(passed).padStart(2)}/${allCases.length}  ${fails.length ? 'FAIL: ' + fails.join('; ') : 'ALL PASS!'}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
