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

    const memStarted = performance.now();
    const reply = await memory.memory_recall({ query: 'German public funding Prototype Fund open source application window', limit: 5 }, context);
    const memoryMs = Math.round(performance.now() - memStarted);
    const text = reply.content[0].text;
    console.log(`\nmemory top-5 (${memoryMs} ms):\n${text.split('\n').filter(l => l.startsWith('[#')).join('\n')}`);
    const order = [...text.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]));
    const memRank = order.indexOf(6830);
    check('memory #6830 top-3', memRank >= 0 && memRank < 3, memRank >= 0 ? `rank ${memRank + 1}` : 'not in the recalled set');

    console.log(`\nlatency: storage ${storageMs} ms, memory ${memoryMs} ms`);
} finally {
    await vdb.shutdown().catch(() => {});
    await memory.shutdown().catch(() => {});
    if (!keep) fs.rmSync(workRoot, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nGOLDEN GATE PASSED' : `\nGOLDEN GATE FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
