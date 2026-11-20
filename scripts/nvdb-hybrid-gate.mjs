// Golden gate for the nVDB hybrid + rerank production path.
//
// Runs the REAL agents (vdb, memory) against a throwaway copy of the candidate
// index, so the index the service uses stays untouched. Exits non-zero when a
// gate fails.
//
// Requirements: an nVDB addon built with --features rerank-onnx, resolvable by
// src/agents/vdb/nvdb-loader.js (or passed with --addon <path>), and a live
// Gateway serving /v1/embeddings/wizkid.
//
// Usage: node scripts/nvdb-hybrid-gate.mjs [--keep] [--addon <path>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const addonArg = args.indexOf('--addon');

process.chdir(repo);
if (addonArg !== -1) {
    const addon = path.resolve(args[addonArg + 1]);
    if (!fs.existsSync(addon)) {
        console.error(`gate: addon not found: ${addon}`);
        process.exit(1);
    }
    process.env.NODE_NVDB_NATIVE_PATH = addon;
}
// Without --addon the gate loads exactly what the service would load, so a
// missing/stale addon is caught here rather than at the restart.

const config = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const candidate = path.resolve(repo, config.agents.vdb.dbPath);
const workRoot = path.join(repo, 'data', 'temp', 'nvdb-gate');
const workNvdb = path.join(workRoot, 'nvdb');

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });
fs.cpSync(candidate, workNvdb, { recursive: true });
config.agents.vdb.dbPath = path.relative(repo, workNvdb).replace(/\\/g, '/');

const load = spec => import(pathToFileURL(path.join(repo, spec)).href);
const { createEmbedClient } = await load('src/embed-client.js');
const { createGatewayClient } = await load('src/gateway-client.js');
const vdb = await load('src/agents/vdb/index.js');
const memory = await load('src/agents/memory/index.js');

const gateway = createGatewayClient(
    config.gateway.wsUrl,
    config.gateway.httpUrl,
    config.gateway.accessKey,
    createEmbedClient(config.gateway.httpUrl, config.gateway.accessKey)
);
const agents = new Map();
const context = { config, gateway, agents, prompts: new Map(), app: null };

const failures = [];
function check(label, condition, detail) {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures.push(label);
}

try {
    const instance = await vdb.init(context);
    agents.set('vdb', instance);
    await memory.init(context);

    check('reranker loaded', instance.reranker !== null);
    check('hybrid enabled', instance.hybrid?.enabled === true);
    check('snapshot mode', instance.snapshot === true);

    const started = performance.now();
    const results = await vdb.searchDocuments({ query: 'Consciousness Is the Record', top_k: 10 });
    const storageMs = Math.round(performance.now() - started);
    console.log(`\nstorage top-10 (${storageMs} ms):`);
    results.forEach((r, i) => console.log(`  ${i + 1}. ${r.path}  rerank=${r.rerankScore?.toFixed(3) ?? '-'} vec#${r.vectorRank ?? '-'}/lex#${r.lexicalRank ?? '-'}`));

    const rank = results.findIndex(r => (r.path || '').includes('consciousness-is-the-record'));
    check('storage exact title top-3', rank >= 0 && rank < 3, rank >= 0 ? `rank ${rank + 1}` : 'not in top 10');
    check('no result re-sorted over the reranked head', results[0].rerankScore !== undefined && results[0].rerankScore !== null, `head rerank=${results[0].rerankScore}`);

    const withContent = await vdb.searchDocuments({ query: 'markdown blocks spec', top_k: 5, include_content: true });
    check('include_content slices the embedded chunk', withContent.length === 5 && typeof withContent[0].content === 'string' && withContent[0].content.length > 0);

    const folderHits = await vdb.searchDocuments({ query: 'markdown blocks spec', top_k: 10, folder: 'documentation' });
    check('folder filter applies on snapshot payloads', folderHits.length > 0 && folderHits.every(r => (r.path || '').startsWith('documentation/')), `${folderHits.length} hit(s)`);

    // ── per-request layer selection (A/B) ──────────────────────────────
    const modes = [
        ['all layers', {}],
        ['no rerank', { rerank: false }],
        ['dense only', { lexical: false }],
        ['lexical only', { dense: false }],
        ['no diversity', { diversity: false }]
    ];
    console.log('\nA/B matrix (same query, layer by layer):');
    for (const [label, search] of modes) {
        const started = performance.now();
        const rows = await vdb.searchDocuments({ query: 'Consciousness Is the Record', top_k: 5, search });
        const ms = Math.round(performance.now() - started);
        console.log(`  ${label.padEnd(13)} ${String(ms).padStart(4)} ms  ${rows.map(r => `${r.path}#${r.splitIdx}`).join(', ') || '(none)'}`);
        check(`${label}: returns hits`, rows.length > 0);
        if (search.lexical === false) check('dense only: every hit carries a vector rank', rows.every(r => r.vectorRank !== null && r.vectorRank !== undefined));
        if (search.dense === false) check('lexical only: every hit carries a lexical rank', rows.every(r => r.lexicalRank !== null && r.lexicalRank !== undefined));
        if (search.dense === false) check('lexical only: no vector-only hit survives', rows.every(r => r.lexicalRank !== null && r.lexicalRank !== undefined));
        if (search.rerank === false) check('no rerank: no rerank scores', rows.every(r => r.rerankScore === null || r.rerankScore === undefined));
        if (search.rerank !== false) check('rerank on: head carries a rerank score', rows[0].rerankScore !== undefined && rows[0].rerankScore !== null);
    }

    // Bad selections fail loudly — no silent fallback to the default search.
    for (const bad of [{ wibble: 1 }, { dense: false, lexical: false }, { rrfK: 0 }, { rerank: 'yes' }, { shortlist: 0 }]) {
        let message = null;
        try {
            await vdb.searchDocuments({ query: 'x', top_k: 3, search: bad });
        } catch (e) {
            message = e.message;
        }
        check(`rejects ${JSON.stringify(bad)}`, message !== null, message ?? 'no error thrown');
    }

    const modeLabel = vdb.describeSearchRequest({ dense: true, lexical: false, rerank: false });
    check('mode label names the active layers', modeLabel.startsWith('layers=dense'), modeLabel);

    const memStarted = performance.now();
    const reply = await memory.memory_recall({ query: 'German public funding Prototype Fund open source application window', limit: 5 }, context);
    const memoryMs = Math.round(performance.now() - memStarted);
    const text = reply.content[0].text;
    console.log(`\nmemory top-5 (${memoryMs} ms):\n${text.split('\n').filter(l => l.startsWith('[#')).join('\n')}`);
    const order = [...text.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]));
    const memRank = order.indexOf(6830);
    check('memory #6830 top-3', memRank >= 0 && memRank < 3, memRank >= 0 ? `rank ${memRank + 1}` : 'not in the recalled set');

    // ── Prototype Fund source-intent regression (2026-11-20) ───────────
    // A verification record (#7137) quotes this exact query in its data, so both
    // lanes read it as a perfect match and it outranked #6830, the funding
    // memory that answers the query. The echo demotion must put #6830 back at
    // rank 1 without removing the record — it stays stored and returned.
    const proto = await memory.memory_recall({ query: 'Prototype Fund 47.5k application November 30 funding', limit: 5 }, context);
    const protoText = proto.content[0].text;
    console.log(`\nPrototype Fund golden:\n${protoText.split('\n').filter(l => l.startsWith('[#') || l.startsWith('mode:')).join('\n')}`);
    const protoOrder = [...protoText.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]));
    check('Prototype Fund: #6830 rank 1', protoOrder[0] === 6830, protoOrder.slice(0, 3).map(id => `#${id}`).join(', '));
    check('Prototype Fund: echoed record is not rank 1', protoOrder[0] !== 7137);
    check('Prototype Fund: demoted record is still returned', protoOrder.includes(7137) || protoText.includes('#7137'), `top: ${protoOrder.join(', ')}`);
    check('Prototype Fund: echo is visible in the output', protoText.includes('·echo'));

    console.log(`\nlatency: storage ${storageMs} ms, memory ${memoryMs} ms`);
} finally {
    await vdb.shutdown().catch(() => {});
    await memory.shutdown().catch(() => {});
    if (!keep) fs.rmSync(workRoot, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nGOLDEN GATE PASSED' : `\nGOLDEN GATE FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
