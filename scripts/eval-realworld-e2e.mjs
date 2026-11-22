/**
 * Real-world end-to-end retrieval benchmark against live `nvdb serve` (v2).
 *
 * Exercises the REAL production path — `src/agents/vdb/index.js` init(),
 * searchDocuments() and vdb_search() — with the production config clone:
 *   - nvdb serve             http://127.0.0.1:3510
 *   - embed + gateway        config.gateway.httpUrl (default :3400)
 *
 * READ-ONLY: autoSync=false and no sync/upsert/attach/commit/delete call is
 * made. init() only performs /health and idempotent createCollection (the
 * server returns the existing collection description; it never recreates).
 *
 * Measures the real use case: an LLM or human asking a genuine question and
 * finding the answer in David's storage docs + memories, balancing answer
 * quality against end-to-end latency.
 *
 * Usage: node scripts/eval-realworld-e2e.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as vdb from '../src/agents/vdb/index.js';
import { assessRelevance } from '../src/agents/vdb/relevance.js';
import { createEmbedClient } from '../src/embed-client.js';
import { createGatewayClient } from '../src/gateway-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOP_K = 5;
const PER_COLLECTION_K = 10;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(ROOT, 'data', 'eval', 'realworld-e2e', RUN_ID);

const MIXED = ['storage', 'memory'];

const CASES = [
    // ── Bucket 1: multi-collection default vdb.search ────────────────────
    {
        id: 'm1-print-events',
        bucket: 'multi',
        query: 'How does the print editor send saved/closed events back to chat?',
        collections: MIXED,
        expect: { collection: 'storage', paths: ['documentation/Workshop/workshop.md'] },
        note: 'coverage probe: #74 lifecycle detail (hostInstanceId/parentOrigin/saved/closed) exists only in the repo doc, not in storage — verified absent from all storage .md files',
    },
    {
        id: 'm2-docs-agent-removal',
        bucket: 'multi',
        query: 'Why did we remove the documentation agent and where do curated docs live now?',
        collections: MIXED,
        expect: { collection: 'storage', paths: ['documentation/Workshop/Agents_Prime.md'] },
    },
    {
        id: 'm3-narration-speakers',
        bucket: 'multi',
        query: 'How do speaker names and voice config work in MD-Blocks narration?',
        collections: MIXED,
        expect: { collection: 'storage', paths: ['documentation/md-blocks/md-blocks-spec.md', 'documentation/md-blocks/BRIEF.md'] },
    },
    {
        id: 'm4-defensive-policy',
        bucket: 'multi',
        query: 'What is our policy on defensive programming, try/catch, and silent fallbacks?',
        collections: MIXED,
        expect: { collection: 'storage', paths: ['documentation/Workshop/Agents_Prime.md'] },
    },
    {
        id: 'm5-embed-host',
        bucket: 'multi',
        query: 'Which machine hosts embeddings and which hosts nVDB?',
        collections: MIXED,
        expect: { collection: 'memory', paths: ['memory/7192', 'memory/7193'] },
        note: 'ground truth: memory/7192+7193 name Badkid as the nVDB host; memory/858 (ranked #2) names the local embed model on Fatten',
    },
    {
        id: 'm6-gsb-robots',
        bucket: 'multi',
        query: 'Was steht im GSB Handbuch über robots.txt?',
        collections: MIXED,
        expect: null,
    },
    {
        id: 'm7-krankenversicherung',
        bucket: 'multi',
        query: 'Krankenversicherung Bescheinigung Finanzamt',
        collections: MIXED,
        expect: null,
    },
    {
        id: 'm8-md-blocks-spec-exact',
        bucket: 'multi',
        query: 'md-blocks-spec',
        collections: MIXED,
        expect: { collection: 'storage', paths: ['documentation/md-blocks/md-blocks-spec.md'] },
    },

    // ── Bucket 2: storage-focused ────────────────────────────────────────
    {
        id: 's1-add-tool',
        bucket: 'storage',
        query: 'how to add a new tool to mcp_server',
        collections: ['storage'],
        folder: 'documentation',
        expect: { collection: 'storage', paths: ['documentation/Workshop/workshop.md', 'documentation/Workshop/Agents_Prime.md'] },
    },
    {
        id: 's2-ai-consciousness',
        bucket: 'storage',
        query: 'What did we write about AI consciousness?',
        collections: ['storage'],
        expect: { collection: 'storage', paths: ['blog/attic/consciousness-is-the-record', 'research/consciousness/the-mythology-of-conscious-ai'] },
    },
    {
        id: 's3-narration-preset',
        bucket: 'storage',
        query: 'preset=narration:david-a-renelt',
        collections: ['storage'],
        expect: { collection: 'storage', paths: ['documentation/md-blocks/'] },
        note: 'the preset is defined in md-blocks spec/BRIEF/DECISIONS and used by blog/drafts/the-drill.md',
    },
    {
        id: 's4-author-bio',
        bucket: 'storage',
        query: 'David A. Renelt author bio Munich',
        collections: ['storage'],
        expect: { collection: 'storage', paths: ['vita/'] },
    },

    // ── Bucket 3: memory-focused ─────────────────────────────────────────
    {
        id: 'y1-prototype-fund',
        bucket: 'memory',
        query: 'Prototype Fund funding application amount and deadline',
        collections: ['memory'],
        expect: { collection: 'memory', paths: ['memory/6830'] },
    },
    {
        id: 'y2-commit-hash',
        bucket: 'memory',
        query: 'what changed in commit a2e3c27?',
        collections: ['memory'],
        expect: { collection: 'memory', paths: ['memory/7184', 'memory/7180', 'memory/7179'] },
    },
    {
        id: 'y3-cloud-embeddings',
        bucket: 'memory',
        query: 'Warum haben wir Cloud-Embeddings aufgegeben?',
        collections: ['memory'],
        expect: { collection: 'memory', paths: ['memory/368', 'memory/778', 'memory/780'] },
    },
    {
        id: 'y4-nteligence-license',
        bucket: 'memory',
        query: 'Is nTeligence open source or closed platform?',
        collections: ['memory'],
        expect: { collection: 'memory', paths: ['memory/6911', 'memory/6931', 'memory/6795', 'memory/6799', 'memory/6951'] },
    },

    // ── Bucket 4: out-of-domain controls on multi-collection ─────────────
    {
        id: 'o1-kubernetes',
        bucket: 'ood',
        query: 'how to configure Kubernetes Ingress with cert-manager and Let\'s Encrypt',
        collections: MIXED,
        expect: 'reject',
    },
    {
        id: 'o2-croissant',
        bucket: 'ood',
        query: 'sourdough croissant laminated butter baking temperature',
        collections: MIXED,
        expect: 'reject',
    },
    {
        id: 'o3-penguins',
        bucket: 'ood',
        query: 'Pinguine in der Antarktis Paarungsverhalten Eisberg',
        collections: MIXED,
        expect: 'reject',
    },
    {
        id: 'o4-deadbeef',
        bucket: 'ood',
        query: 'deadbeef987654',
        collections: MIXED,
        expect: 'reject',
    },
];

const PROBE_IDS = ['m1-print-events', 'm4-defensive-policy', 'm8-md-blocks-spec-exact', 'y1-prototype-fund', 'o3-penguins'];

const ms = start => Math.round((performance.now() - start) * 10) / 10;
const score = value => (typeof value === 'number' ? value.toFixed(4) : '  null');

function slim(row) {
    return {
        collection: row.collection,
        path: row.path,
        id: row.id,
        title: row.title,
        rrfScore: row.rrfScore,
        rerankScore: row.rerankScore,
        lexicalRank: row.lexicalRank,
        vectorRank: row.vectorRank,
        rejected: row.rejected,
    };
}

function matchesExpected(row, expect) {
    if (!expect || typeof expect !== 'object') return false;
    if (row.collection !== expect.collection) return false;
    return (expect.paths || []).some(p => row.path.includes(p));
}

function mixLabel(rows) {
    const counts = new Map();
    for (const row of rows) counts.set(row.collection, (counts.get(row.collection) || 0) + 1);
    return [...counts.entries()].map(([c, n]) => `${n}${c === 'storage' ? 'S' : 'M'}`).join('/');
}

function stats(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mid = Math.floor(sorted.length / 2);
    return {
        n: sorted.length,
        min: sorted[0],
        median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
        mean: Math.round((sum / sorted.length) * 10) / 10,
        max: sorted[sorted.length - 1],
    };
}

function median(values) {
    return stats(values).median;
}

async function loadConfig() {
    const raw = await fs.readFile(path.join(ROOT, 'config.json'), 'utf8');
    const config = JSON.parse(raw);
    config.agents.vdb = { ...config.agents.vdb, autoSync: false, scanIntervalMinutes: 0 };
    return config;
}

async function runCase(def) {
    const start = performance.now();
    const rows = await vdb.searchDocuments({
        query: def.query,
        collections: def.collections,
        folder: def.folder ?? null,
        top_k: TOP_K,
    });
    const latencyMs = ms(start);

    const info = vdb.searchRequestInfo(null, def.query);
    const assessment = assessRelevance(rows, { rerankActive: info.rerankActive, floor: info.floor });

    const toolStart = performance.now();
    const tool = await vdb.vdb_search(
        { query: def.query, collections: def.collections, folder: def.folder ?? null, top_k: TOP_K },
        {}
    );
    const toolMs = ms(toolStart);
    const toolText = tool.content[0].text;

    const result = {
        id: def.id,
        bucket: def.bucket,
        query: def.query,
        collections: def.collections,
        folder: def.folder ?? null,
        mode: vdb.describeSearchRequest(null, def.query),
        profile: info.options.profile,
        latencyMs,
        toolLatencyMs: toolMs,
        assessment,
        toolRejected: /No relevant vdb matches/.test(toolText),
        toolHead: toolText.split('\n').slice(0, 2).join(' | '),
        mix: def.collections.length > 1 ? mixLabel(rows) : null,
        rows: rows.map(slim),
        expect: def.expect ?? null,
        note: def.note ?? null,
        error: null,
    };

    if (typeof def.expect === 'object' && def.expect !== null) {
        const hitIndex = rows.findIndex(row => matchesExpected(row, def.expect));
        result.expectedHit = hitIndex === -1 ? null : hitIndex + 1;
    }
    return result;
}

async function perCollection(def) {
    const out = {};
    for (const collection of def.collections) {
        const rows = await vdb.searchDocuments({
            query: def.query,
            collections: [collection],
            folder: collection === 'storage' ? (def.folder ?? null) : null,
            top_k: PER_COLLECTION_K,
        });
        const info = vdb.searchRequestInfo(null, def.query);
        out[collection] = {
            // Assess exactly the rows a top_k=TOP_K call would have returned, so
            // the rejected/leak semantics match the real tool surface. The wider
            // list exists only to locate the expected doc inside its own collection.
            assessment: assessRelevance(rows.slice(0, TOP_K), { rerankActive: info.rerankActive, floor: info.floor }),
            top: rows.map(slim),
        };
    }
    return out;
}

function multiFlags(result, per) {
    const flags = [];
    const rows = result.rows;
    const expect = result.expect;

    // (a) rejected collection rows leaked next to a matching collection
    const acceptedPresent = Object.entries(per).filter(([, v]) => !v.assessment.rejected && v.top.length);
    for (const [collection, detail] of Object.entries(per)) {
        const inTop = rows.some(r => r.collection === collection);
        if (!inTop || !detail.assessment.rejected) continue;
        const others = acceptedPresent.filter(([c]) => c !== collection).map(([c]) => c);
        if (others.length) {
            const leaked = rows.filter(r => r.collection === collection).length;
            flags.push({
                type: 'leak',
                detail: `${leaked} row(s) from rejected collection "${collection}" (best ${score(detail.assessment.best)} < floor ${score(detail.assessment.floor)}) in top-${TOP_K} next to accepted ${others.join(',')}`,
            });
        }
    }

    if (typeof expect === 'object' && expect !== null) {
        const positions = rows.map((row, i) => ({ row, i })).filter(({ row }) => matchesExpected(row, expect));
        if (!positions.length) {
            const own = per[expect.collection];
            const ownTop = own?.top?.[0];
            const ownRank = own?.top?.findIndex(row => matchesExpected(row, expect));
            flags.push({
                type: 'missing-expected',
                detail: `expected ${expect.collection} doc (${(expect.paths || []).join(' | ')}) absent from merged top-${TOP_K}`
                    + (ownTop ? `; own-collection top-1 = [${ownTop.collection}:${ownTop.path}] rerank=${score(ownTop.rerankScore)}` : '; own-collection returned nothing')
                    + (ownRank !== undefined && ownRank >= 0 ? `; expected doc ranks #${ownRank + 1} within its own collection (top-${PER_COLLECTION_K})` : `; expected doc not in its own collection's top-${PER_COLLECTION_K}`),
            });
            // A rejected collection is dropped by design, so its #1 is absent on
            // purpose; only an ACCEPTED collection's #1 going missing is a merge bug.
            if (ownTop && !own.assessment.rejected && !rows.some(row => row.id === ownTop.id && row.collection === ownTop.collection)) {
                flags.push({
                    type: 'merge-demotion',
                    detail: `the accepted ${expect.collection} collection's own #1 [${ownTop.path}] (rerank=${score(ownTop.rerankScore)}, rrf=${score(ownTop.rrfScore)}) was dropped from merged top-${TOP_K}; `
                        + `the rank-preserving merge must keep a collection's own order`,
                });
            }
        } else {
            const first = positions[0];
            const above = rows.slice(0, first.i).filter(row => row.collection !== expect.collection);
            if (above.length) {
                flags.push({
                    type: 'burial',
                    detail: `[${first.row.collection}:${first.row.path}] sits at #${first.i + 1} under ${above.length} ${above[0].collection} row(s): `
                        + above.map(row => `[${row.collection}:${row.path}] rerank=${score(row.rerankScore)}`).join(', ')
                        + ` (expected rerank=${score(first.row.rerankScore)})`,
                });
            }
        }

        // (c) cross-collection merge inverted a clear single-collection winner
        const own = per[expect.collection];
        const t1 = own?.top?.[0];
        const t2 = own?.top?.[1];
        if (t1) {
            const margin = typeof t1.rerankScore === 'number' && typeof t2?.rerankScore === 'number'
                ? t1.rerankScore - t2.rerankScore
                : null;
            const clearWin = /^exact/.test(result.profile) || (margin !== null && margin >= 0.1);
            const mergedAt = rows.findIndex(row => row.id === t1.id && row.collection === t1.collection);
            if (clearWin && mergedAt > 0) {
                const above = rows.slice(0, mergedAt);
                const foreign = above.filter(row => row.collection !== t1.collection);
                if (foreign.length) {
                    flags.push({
                        type: 'inversion',
                        detail: `clear winner of single-collection "${t1.collection}" [${t1.path}] (rerank=${score(t1.rerankScore)}`
                            + `${margin !== null ? `, margin ${margin.toFixed(4)}` : ''}, profile=${result.profile}) merged to #${mergedAt + 1}; `
                            + `${foreign.length} foreign row(s) above: `
                            + foreign.map(row => `[${row.collection}:${row.path}] rerank=${score(row.rerankScore)}`).join(', '),
                    });
                }
            }
        }
    }

    if (result.assessment.rejected !== result.toolRejected) {
        flags.push({
            type: 'rejection-mismatch',
            detail: `searchDocuments+assessRelevance rejected=${result.assessment.rejected}, vdb_search rejected=${result.toolRejected}`,
        });
    }
    return flags;
}

function printCase(result, flags, per) {
    const lines = [];
    const collDesc = result.collections.join(',') + (result.folder ? ` folder=${result.folder}` : '');
    lines.push(`[${result.id}] "${result.query}"  (${collDesc})`);
    lines.push(`  mode: ${result.mode}`);
    lines.push(`  latency: searchDocuments=${result.latencyMs}ms  vdb_search=${result.toolLatencyMs}ms`
        + (result.mix ? `  mix=${result.mix}` : ''));
    lines.push(`  relevance: best=${score(result.assessment.best)} floor=${score(result.assessment.floor)} `
        + `rejected=${result.assessment.rejected} scored=${result.assessment.scoredCount}`
        + (typeof result.expect === 'object' && result.expect ? `  expected-hit=${result.expectedHit ?? 'MISS'}` : ''));
    if (per) {
        lines.push('  single-collection: ' + Object.entries(per).map(([c, v]) =>
            `${c} best=${score(v.assessment.best)} rejected=${v.assessment.rejected}`
            + (v.top[0] ? ` top1=[${v.top[0].path}]` : ' top1=none')
        ).join(' | '));
    }
    for (const [i, row] of result.rows.entries()) {
        lines.push(`  ${i + 1}. [${row.collection}:${row.path}] rrf=${score(row.rrfScore)} rerank=${score(row.rerankScore)}`
            + ` rej=${row.rejected}${row.lexicalRank != null ? ` lex#${row.lexicalRank}` : ''}${row.vectorRank != null ? ` vec#${row.vectorRank}` : ''}`);
    }
    if (!result.rows.length) lines.push('  (no rows)');
    if (result.note) lines.push(`  note: ${result.note}`);
    if (flags.length) {
        for (const flag of flags) lines.push(`  FLAG ${flag.type}: ${flag.detail}`);
    } else {
        lines.push('  flags: none');
    }
    return lines.join('\n');
}

async function main() {
    const mainStart = performance.now();
    const config = await loadConfig();
    const gatewayHttp = process.env.GATEWAY_HTTP_URL || config.gateway?.httpUrl || 'http://localhost:3400';
    const gatewayKey = process.env.GATEWAY_ACCESS_KEY || config.gateway?.accessKey || null;
    const embedUrl = process.env.EMBED_URL || gatewayHttp;
    const embedClient = createEmbedClient(embedUrl, gatewayKey);
    const gateway = createGatewayClient(process.env.GATEWAY_URL || config.gateway?.wsUrl, gatewayHttp, gatewayKey, embedClient);

    const instance = await vdb.init({ config, gateway, agents: new Map() });
    const colls = await instance.client.listCollections();
    const counts = Object.fromEntries((colls.collections || []).map(c => [c.name, c.doc_count]));

    console.log(`=== realworld-e2e ${RUN_ID} ===`);
    console.log(`nvdb: ${instance.serviceUrl}  reranker=${instance.rerankerLoaded}  model=${instance.modelVersion}`);
    console.log(`collections: storage=${counts.storage ?? 0} memory=${counts.memory ?? 0}  (config: autoSync=false)`);
    console.log(`gateway: ${gatewayHttp}  embed=${embedUrl}`);

    const warmStart = performance.now();
    await vdb.searchDocuments({ query: 'warmup retrieval benchmark nvdb', collections: ['storage'], top_k: 3 });
    console.log(`warmup: ${ms(warmStart)}ms (excluded from results)\n`);

    const results = [];
    const failures = [];

    for (const bucket of ['multi', 'storage', 'memory', 'ood']) {
        const cases = CASES.filter(c => c.bucket === bucket);
        const title = {
            multi: 'Bucket 1 — multi-collection vdb.search [storage, memory]',
            storage: 'Bucket 2 — storage-focused (incl. folder=documentation)',
            memory: 'Bucket 3 — memory-focused',
            ood: 'Bucket 4 — out-of-domain controls on multi-collection',
        }[bucket];
        console.log(`\n──── ${title} ────`);
        for (const def of cases) {
            try {
                const result = await runCase(def);
                let per = null;
                const flags = [];
                if (def.collections.length > 1) {
                    per = await perCollection(def);
                    result.perCollection = per;
                    flags.push(...multiFlags(result, per));
                }
                if (def.expect === 'reject') {
                    if (!result.assessment.rejected || !result.toolRejected) {
                        flags.push({
                            type: 'ood-accepted',
                            detail: `out-of-domain query was NOT rejected (best=${score(result.assessment.best)} floor=${score(result.assessment.floor)}, toolRejected=${result.toolRejected})`,
                        });
                    }
                } else if (def.collections.length === 1 && typeof def.expect === 'object' && def.expect) {
                    if (result.expectedHit === null) {
                        flags.push({ type: 'missing-expected', detail: `expected ${def.expect.collection} doc (${(def.expect.paths || []).join(' | ')}) absent from top-${TOP_K}` });
                    }
                }
                result.flags = flags;
                results.push(result);
                console.log(printCase(result, flags, per));
                console.log('');
            } catch (err) {
                failures.push({ id: def.id, query: def.query, error: err.stack || err.message });
                console.log(`[${def.id}] ERROR: ${err.message}\n`);
            }
        }
    }

    // ── sequential vs parallel probe ────────────────────────────────────
    const probes = [];
    console.log('──── Timing probe: sequential vs Promise.all (storage + memory) ────');
    for (const id of PROBE_IDS) {
        const def = CASES.find(c => c.id === id);
        const seq = [];
        const seqStorage = [];
        const seqMemory = [];
        const par = [];
        const multi = [];
        const embeds = [];
        for (let rep = 0; rep < 3; rep++) {
            let t = performance.now();
            await vdb.searchDocuments({ query: def.query, collections: ['storage'], folder: def.folder ?? null, top_k: TOP_K });
            seqStorage.push(ms(t));
            t = performance.now();
            await vdb.searchDocuments({ query: def.query, collections: ['memory'], top_k: TOP_K });
            seqMemory.push(ms(t));
            seq.push(seqStorage[rep] + seqMemory[rep]);

            t = performance.now();
            await Promise.all([
                vdb.searchDocuments({ query: def.query, collections: ['storage'], folder: def.folder ?? null, top_k: TOP_K }),
                vdb.searchDocuments({ query: def.query, collections: ['memory'], top_k: TOP_K }),
            ]);
            par.push(ms(t));

            t = performance.now();
            await vdb.searchDocuments({ query: def.query, collections: ['storage', 'memory'], folder: def.folder ?? null, top_k: TOP_K });
            multi.push(ms(t));

            t = performance.now();
            await gateway.embed(vdb.formatQueryForEmbedding(def.query), { path: '/v1/embeddings' });
            embeds.push(ms(t));
        }
        const seqMs = median(seq);
        const parMs = median(par);
        const multiMs = median(multi);
        const storageMs = median(seqStorage);
        const memoryMs = median(seqMemory);
        const embedMs = median(embeds);
        // If one shared embed could feed both collections and the backend served
        // both concurrently without contention, the call would cost at most the
        // slower single-collection call. The gap to the measured Promise.all is
        // backend contention, not scheduling overhead.
        const idealInternalMs = Math.max(storageMs, memoryMs);

        const probe = {
            id,
            query: def.query,
            seqMs,
            parMs,
            multiMs,
            seqStorageMs: storageMs,
            seqMemoryMs: memoryMs,
            embedMs,
            idealInternalMs,
            measuredSavingPct: Math.round(((seqMs - parMs) / seqMs) * 1000) / 10,
            theoreticalSavingPct: Math.round(((multiMs - idealInternalMs) / multiMs) * 1000) / 10,
        };
        probes.push(probe);
        console.log(`[${id}] seq(storage ${storageMs} + memory ${memoryMs})=${seqMs}ms  par=${parMs}ms  multi(current)=${multiMs}ms  embed-only=${embedMs}ms`
            + `  | measured par saving ${probe.measuredSavingPct}%  theoretical internal saving ${probe.theoreticalSavingPct}%`);
    }

    // ── summary ─────────────────────────────────────────────────────────
    const curated = results.filter(r => r.bucket !== 'ood');
    const ood = results.filter(r => r.bucket === 'ood');
    const allFlags = results.flatMap(r => (r.flags || []).map(f => ({ id: r.id, bucket: r.bucket, ...f })));

    console.log('\n════════ SUMMARY ════════');
    for (const bucket of ['multi', 'storage', 'memory', 'ood']) {
        const group = results.filter(r => r.bucket === bucket);
        const lat = stats(group.map(r => r.latencyMs));
        const tool = stats(group.map(r => r.toolLatencyMs));
        const evaluable = group.filter(r => typeof r.expect === 'object' && r.expect);
        const hits = evaluable.filter(r => r.expectedHit !== null).length;
        const rejectedOod = group.filter(r => r.assessment.rejected).length;
        console.log(`${bucket.padEnd(8)} n=${group.length}`
            + ` searchDocuments min/med/mean/max = ${lat ? `${lat.min}/${lat.median}/${lat.mean}/${lat.max}ms` : 'n/a'}`
            + ` | vdb_search mean=${tool ? tool.mean : 'n/a'}ms`
            + (bucket === 'ood'
                ? ` | rejected ${rejectedOod}/${group.length}`
                : evaluable.length ? ` | expected-hit ${hits}/${evaluable.length}` : ''));
    }
    console.log(`\nflags: ${allFlags.length}`);
    for (const flag of allFlags) console.log(`  [${flag.id}] ${flag.type}: ${flag.detail}`);
    if (!allFlags.length) console.log('  none');
    const flagCounts = new Map();
    for (const flag of allFlags) flagCounts.set(flag.type, (flagCounts.get(flag.type) || 0) + 1);
    console.log('flag counts: ' + ([...flagCounts.entries()].map(([type, n]) => `${type}=${n}`).join(', ') || 'none'));
    const multiResults = results.filter(r => r.bucket === 'multi');
    console.log('multi-collection top-5 mixes: ' + multiResults.map(r => `${r.id}=${r.mix}`).join('  '));

    const probeMedian = key => median(probes.map(p => p[key]));
    const seqMs = probeMedian('seqMs');
    const parMs = probeMedian('parMs');
    const multiMs = probeMedian('multiMs');
    const idealMs = probeMedian('idealInternalMs');
    const embedMs = probeMedian('embedMs');
    console.log(`\ntiming probe (median of 5 queries): seq(2 calls)=${seqMs}ms  par(Promise.all)=${parMs}ms  multi(current)=${multiMs}ms  embed-only=${embedMs}ms`);
    console.log(`  measured Promise.all saving vs sequential: ${Math.round(((seqMs - parMs) / seqMs) * 1000) / 10}%`);
    console.log(`  theoretical internal parallel ceiling (share one embed, wait for the slower collection): ${idealMs}ms = ${Math.round(((multiMs - idealMs) / multiMs) * 1000) / 10}% faster than the current path`);
    console.log(`  => measured concurrency gain is ${parMs < multiMs ? `${Math.round(((multiMs - parMs) / multiMs) * 1000) / 10}%` : `negative (${Math.round(((multiMs - parMs) / multiMs) * 1000) / 10}%)`} — the backend, not the scheduling, is the bottleneck.`);
    console.log(`total run time: ${Math.round(ms(mainStart) / 100) / 10}s`);

    const artifact = {
        runId: RUN_ID,
        generatedAt: new Date().toISOString(),
        service: { url: instance.serviceUrl, engine: 'nvdb-v2', rerankerLoaded: instance.rerankerLoaded, counts },
        config: {
            rerank: config.agents.vdb.rerank,
            hybrid: config.agents.vdb.hybrid,
            relevanceFloor: config.agents.vdb.relevanceFloor,
            autoSync: config.agents.vdb.autoSync,
        },
        results,
        probes,
        summary: {
            flags: allFlags,
            failures,
            probeMeans: { seqMs, parMs, multiMs, embedMs, idealInternalMs: idealMs },
        },
    };
    await fs.mkdir(OUT_DIR, { recursive: true });
    await fs.writeFile(path.join(OUT_DIR, 'results.json'), JSON.stringify(artifact, null, 2), 'utf8');
    console.log(`\nartifact: ${path.join(OUT_DIR, 'results.json')}`);

    if (failures.length) {
        console.error(`\n${failures.length} query/queries threw:`);
        for (const f of failures) console.error(`\n[${f.id}] ${f.query}\n${f.error}`);
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});
