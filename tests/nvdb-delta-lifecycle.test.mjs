// Incremental storage freshness lifecycle.
//
// Runs against a THROWAWAY COPY of the real candidate index and a temp storage
// root — the live index and the live corpus are never touched.
//
//   1. create  → the new file becomes searchable
//   2. edit    → the new evidence is searchable and the old chunk is gone
//                (including a shrinking edit that must prune stale chunk ids)
//   3. delete  → the file is gone from the index
//   4. failure → an embedding failure leaves the prior state intact and the
//                file is retried successfully afterwards
//   5. restart → a fresh process resumes from the persisted checkpoint without
//                re-embedding unchanged files
//
// Usage: node tests/nvdb-delta-lifecycle.test.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repo);
const keep = process.argv.includes('--keep');
const load = spec => import(pathToFileURL(path.join(repo, spec)).href);

const config = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const workRoot = path.join(repo, 'data', 'temp', `delta-lifecycle-${Date.now().toString(36)}`);
const indexDir = path.join(workRoot, 'index');
const storageRoot = path.join(workRoot, 'storage');

console.log(`[delta-test] work root: ${workRoot}`);
fs.mkdirSync(storageRoot, { recursive: true });
fs.cpSync(path.resolve(repo, config.agents.vdb.dbPath), indexDir, { recursive: true });

// Test config: same chunking/embedding route as production, reranker off (it is
// irrelevant to delta and costs a 268 MB model load), timers parked so the test
// drives every cycle itself.
config.agents.vdb.dbPath = indexDir;
config.agents.vdb.snapshot = true;
config.agents.vdb.delta = { enabled: true, intervalMinutes: 600, initialDelaySeconds: 3600, compactAfterDeletes: false };
config.agents.vdb.rerank = { ...config.agents.vdb.rerank, enabled: false };
config.agents.storage = { ...config.agents.storage, root: storageRoot };

const { createEmbedClient } = await load('src/embed-client.js');
const { createGatewayClient } = await load('src/gateway-client.js');
const vdb = await load('src/agents/vdb/index.js');

let embedFails = false;
const base = createGatewayClient(
    config.gateway.wsUrl,
    config.gateway.httpUrl,
    config.gateway.accessKey,
    createEmbedClient(config.gateway.httpUrl, config.gateway.accessKey)
);
const gateway = {
    ...base,
    async embed(text, opts) {
        if (embedFails) throw new Error('simulated provider outage');
        return base.embed(text, opts);
    },
    async embedBatch(texts, opts) {
        if (embedFails) throw new Error('simulated provider outage');
        return base.embedBatch(texts, opts);
    },
    // The delta embeds through the background tier, which calls the embed client
    // directly — overriding embed/embedBatch alone would not intercept it.
    async embedBackground(text, opts) {
        if (embedFails) throw new Error('simulated provider outage');
        return base.embedBackground(text, opts);
    },
    async embedBatchBackground(texts, opts) {
        if (embedFails) throw new Error('simulated provider outage');
        return base.embedBatchBackground(texts, opts);
    }
};

const failures = [];
function check(label, condition, detail = '') {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures.push(label);
}

function write(relPath, content) {
    const full = path.join(storageRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
}

async function start() {
    const agents = new Map();
    await vdb.init({ config, gateway, agents, prompts: new Map(), app: null });
}

// Lexical-only so the test never spends its own query embedding; the DELTA still
// uses the real /v1/embeddings route.
async function finds(token, relPath) {
    const rows = await vdb.searchDocuments({ query: token, top_k: 10, search: { dense: false }, collections: ['storage'] });
    return rows.some(row => row.path === relPath);
}

const LONG = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(1);

try {
    // ── 1. create ─────────────────────────────────────────────────────
    write('alpha.md', `# Alpha\n\nzephyrquartz marker for the created file.\n`);
    await start();
    let run = await vdb.runDeltaReconcile();
    console.log(`[delta-test] create run: ${JSON.stringify({ added: run.added, updated: run.updated, adopted: run.adopted, chunks: run.chunksAdded, failed: run.failed })}`);
    check('created file was added', run.added === 1, `added=${run.added}`);
    check('created file is searchable', await finds('zephyrquartz', 'alpha.md'));

    // ── 2. edit, including a shrinking chunk count ────────────────────
    write('gamma.md', `# Gamma one\n\nfirstmarker ${LONG}\n\n# Gamma two\n\n${LONG}\n\nsecondmarker ${LONG}\n`);
    run = await vdb.runDeltaReconcile();
    check('multi-chunk file was added', run.added === 1, `added=${run.added}`);
    const before = (await vdb.searchDocuments({ query: 'firstmarker', top_k: 10, search: { dense: false }, collections: ['storage'] })).some(r => r.path === 'gamma.md');
    check('both markers searchable before the edit', before && await finds('secondmarker', 'gamma.md'));

    write('gamma.md', `# Gamma two\n\nsecondmarker only now ${LONG}\n`);
    run = await vdb.runDeltaReconcile();
    console.log(`[delta-test] edit run: ${JSON.stringify({ added: run.added, updated: run.updated, chunks: run.chunksAdded })}`);
    check('shrunken file counted as an update', run.updated >= 1, `updated=${run.updated}`);
    check('new evidence is searchable after the edit', await finds('secondmarker', 'gamma.md'));
    check('old chunk is gone after the edit', !(await finds('firstmarker', 'gamma.md')));

    // ── 3. delete ─────────────────────────────────────────────────────
    fs.unlinkSync(path.join(storageRoot, 'alpha.md'));
    run = await vdb.runDeltaReconcile();
    console.log(`[delta-test] delete run: ${JSON.stringify({ removed: run.removed })}`);
    check('delete was detected', run.removed === 1, `removed=${run.removed}`);
    check('deleted file is gone from the index', !(await finds('zephyrquartz', 'alpha.md')));

    // ── 4. embedding failure: consistent, then retryable ──────────────
    write('beta.md', `# Beta\n\nquillfeather marker that must wait for the provider.\n`);
    embedFails = true;
    run = await vdb.runDeltaReconcile();
    console.log(`[delta-test] failed run: ${JSON.stringify({ failed: run.failed, added: run.added })}`);
    check('embedding failure is reported', run.failed >= 1, `failed=${run.failed}`);
    check('nothing was written for the failed file', !(await finds('quillfeather', 'beta.md')));
    const statusAfterFailure = vdb.deltaStatus();
    check('failure is recorded in the checkpoint', typeof statusAfterFailure.lastError === 'string' && statusAfterFailure.lastError.length > 0, statusAfterFailure.lastError);

    embedFails = false;
    run = await vdb.runDeltaReconcile();
    console.log(`[delta-test] retry run: ${JSON.stringify({ added: run.added, failed: run.failed })}`);
    check('retry after the failure succeeds', run.added === 1 && run.failed === 0, `added=${run.added} failed=${run.failed}`);
    check('retried file is searchable', await finds('quillfeather', 'beta.md'));

    // ── 5. restart resumes from the persisted checkpoint ──────────────
    const beforeRestart = vdb.deltaStatus();
    await vdb.shutdown();
    await start();
    const afterRestart = vdb.deltaStatus();
    check('checkpoint survives a restart', afterRestart.initialized === true && afterRestart.trackedFiles === beforeRestart.trackedFiles,
        `tracked ${beforeRestart.trackedFiles} -> ${afterRestart.trackedFiles}`);
    run = await vdb.runDeltaReconcile();
    console.log(`[delta-test] post-restart run: ${JSON.stringify({ unchanged: run.unchanged, added: run.added, updated: run.updated, removed: run.removed, adopted: run.adopted })}`);
    check('restart does not re-embed unchanged files', run.added === 0 && run.updated === 0 && run.adopted === 0, `added=${run.added} updated=${run.updated} adopted=${run.adopted}`);
    check('restart still sees the fixture files', await finds('quillfeather', 'beta.md'));

    await vdb.shutdown();
} finally {
    if (!keep) fs.rmSync(workRoot, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nDELTA LIFECYCLE PASSED' : `\nDELTA LIFECYCLE FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
