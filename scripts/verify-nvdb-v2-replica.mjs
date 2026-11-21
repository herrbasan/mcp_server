import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as vdb from '../src/agents/vdb/index.js';
import * as memory from '../src/agents/memory/index.js';
import { createV2Client } from '../src/agents/vdb/v2-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NVDB_ROOT = process.env.NVDB_ROOT || 'D:\\DEV\\nVDB';
const NVDB_EXE = process.env.NVDB_BIN || path.join(NVDB_ROOT, 'target', 'release', 'nvdb.exe');
const RERANKER_DIR = process.env.NVDB_RERANKER_MODEL || path.join(NVDB_ROOT, 'models', 'reranker', 'atelasi-multilingual-reranker-small');
const REAL_STORAGE_ROOT = 'D:\\MCP_Storage';
const REAL_MEMORY_DB = path.join(PROJECT_ROOT, 'data', 'memories', 'data.jsonl');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(err => (err ? reject(err) : resolve(port)));
        });
        srv.on('error', reject);
    });
}

async function waitForHealth(client, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const h = await client.health();
            if (h?.ok) return h;
        } catch (err) {
            lastErr = err;
        }
        await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(`nvdb serve unhealthy after ${timeoutMs}ms: ${lastErr?.message}`);
}

const failures = [];
function check(label, condition, detail = '') {
    if (condition) {
        console.log(`  PASS  ${label}${detail ? ` (${detail})` : ''}`);
    } else {
        console.error(`  FAIL  ${label}${detail ? ` (${detail})` : ''}`);
        failures.push({ label, detail });
    }
}

function extractMemIds(text) {
    return [...text.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]));
}

async function run() {
    const replicaRoot = path.join(PROJECT_ROOT, 'data', 'temp', `nvdb-v2-replica-${Date.now()}`);
    const nvdbDir = path.join(replicaRoot, 'nvdb');
    const memDir = path.join(replicaRoot, 'memories');
    const memDbPath = path.join(memDir, 'data.jsonl');
    await fs.mkdir(nvdbDir, { recursive: true });
    await fs.mkdir(memDir, { recursive: true });
    await fs.copyFile(REAL_MEMORY_DB, memDbPath);

    const port = await getFreePort();
    const serviceUrl = `http://127.0.0.1:${port}`;
    const proc = spawn(
        NVDB_EXE,
        ['serve', '--dir', nvdbDir, '--host', '127.0.0.1', '--port', String(port), '--reranker-model', RERANKER_DIR],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // No-op gateway for lexical + Level-2 ONNX rerank replica run (dense=false)
    const noopGateway = {
        async embed() { throw new Error('unexpected embed call in lexical+level2 replica gate'); },
        async embedBatch() { throw new Error('unexpected embedBatch call in lexical+level2 replica gate'); },
    };

    try {
        const client = createV2Client(serviceUrl, { timeoutMs: 120_000 });
        const health = await waitForHealth(client);
        check('nvdb serve healthy + reranker loaded', health.ok === true && health.reranker_loaded === true);

        const config = {
            agents: {
                storage: { root: REAL_STORAGE_ROOT },
                vdb: {
                    enabled: true,
                    serviceUrl,
                    principals: ['default'],
                    modelVersion: 'qwen3-embedding-4b',
                    embeddingPath: '/v1/embeddings',
                    fuzzyEdits: 1,
                    relevanceFloor: 0.02,
                    autoSync: false,
                    embeddingDim: 2560,
                    hybrid: { enabled: true, rrfK: 60, candidateK: 200, lexicalWeight: 1.0, vectorWeight: 0.3, diversityField: 'parent_id', maxPerDocument: 2 },
                    rerank: { enabled: true, shortlist: 20, weight: 0.2 },
                },
                memory: {
                    dbPath: memDbPath,
                    maxMemoryChars: 6000,
                },
            },
        };

        const agents = new Map();
        const vdbInstance = await vdb.init({ config, gateway: noopGateway, agents });
        agents.set('vdb', vdbInstance);

        console.log('\n── 1. Real-corpus ingest (storage + memory) ──');
        const tStorage = Date.now();
        const storageSync = await vdbInstance.storageConnector.sync();
        console.log(`Storage sync: ${storageSync.files} files, ${storageSync.chunks} chunks, ${storageSync.upserted} upserted in ${Date.now() - tStorage}ms`);
        check('real storage corpus ingested (>1000 chunks)', storageSync.chunks > 1000, `${storageSync.chunks} chunks`);

        const tMem = Date.now();
        const memInstance = await memory.init({ config, gateway: noopGateway, agents });
        agents.set('memory', memInstance);
        const memCount = memInstance.memories.count();
        console.log(`Memory sync: ${memCount} memories indexed in ${Date.now() - tMem}ms`);
        check('real memory corpus ingested (>1000 memories)', memCount > 1000, `${memCount} memories`);

        console.log('\n── 2. Full-corpus integrity_check ──');
        const tInt = Date.now();
        const storageInt = await vdb.integrityCheck({ collection: 'storage', checkVectors: false });
        const memInt = await memory.memoryIntegrityCheck({ checkVectors: false });
        console.log(`integrity_check finished in ${Date.now() - tInt}ms`);
        check('storage integrity_check clean', storageInt.clean === true, `missing=${storageInt.missing.length} extra=${storageInt.extra.length} content_mis=${storageInt.content_mismatched.length} env_mis=${storageInt.envelope_mismatched.length}`);
        check('memory integrity_check clean', memInt.clean === true, `missing=${memInt.missing.length} extra=${memInt.extra.length} content_mis=${memInt.content_mismatched.length} env_mis=${memInt.envelope_mismatched.length}`);

        // Idempotent re-sync should upsert 0 and delete 0
        const resyncStorage = await vdbInstance.storageConnector.sync();
        const resyncMem = await memory.syncMemories();
        check('storage re-sync is a 0-write no-op', resyncStorage.upserted === 0 && resyncStorage.deleted === 0, `upserted=${resyncStorage.upserted} deleted=${resyncStorage.deleted}`);
        check('memory re-sync is a 0-write no-op', resyncMem.upserted === 0 && resyncMem.deleted === 0, `upserted=${resyncMem.upserted} deleted=${resyncMem.deleted}`);

        console.log('\n── 3. Real-corpus retrieval gates (lexical + Level-2 ONNX rerank) ──');
        const lexRerank = { dense: false, lexical: true, rerank: true };
        const ctx = { gateway: noopGateway };

        // Exact title
        const exact = await vdb.searchDocuments({ query: 'Consciousness Is the Record', top_k: 10, search: lexRerank });
        const exactRank = exact.findIndex(r => /consciousness.*record/i.test(r.path) || /consciousness is the record/i.test(r.title));
        check('storage exact title top-3 ("Consciousness Is the Record")', exactRank >= 0 && exactRank < 3, exactRank >= 0 ? `rank ${exactRank + 1}: ${exact[exactRank].path}` : `top=${exact[0]?.path}`);
        check('reranked head carries rerankScore', typeof exact[0]?.rerankScore === 'number', `head=${exact[0]?.rerankScore?.toFixed(4)}`);

        // include_content + folder filter
        const withContent = await vdb.searchDocuments({ query: 'markdown blocks spec', top_k: 5, include_content: true, search: lexRerank });
        check('include_content returns real chunk text', withContent.length === 5 && typeof withContent[0].content === 'string' && withContent[0].content.length > 0);
        const docFolder = await vdb.searchDocuments({ query: 'markdown blocks spec', top_k: 10, folder: 'documentation', search: lexRerank });
        check('native folder=documentation pre-filter', docFolder.length > 0 && docFolder.every(r => r.path.startsWith('documentation/')), `${docFolder.length} hit(s)`);

        // R3: folder + extension filters
        const relMd = await vdb.searchDocuments({ query: 'religion', folder: 'religion', extension: 'md', top_k: 5, search: lexRerank });
        const relDotMd = await vdb.searchDocuments({ query: 'religion', folder: 'religion', extension: '.MD', top_k: 5, search: lexRerank });
        check('R3 folder=religion + extension=.md matches only religion/*.md', relMd.length > 0 && relMd.every(r => r.path.startsWith('religion/') && r.path.toLowerCase().endsWith('.md')), `${relMd.length} hit(s)`);
        check('R3 ".MD" equals "md"', JSON.stringify(relMd.map(r => r.id)) === JSON.stringify(relDotMd.map(r => r.id)));

        // R2: misspelling "AI Conciousness" via native 1-edit fuzzy (no query-normalizer.js!)
        const typo = await vdb.searchDocuments({ query: 'AI Conciousness', top_k: 5, search: lexRerank });
        check('R2 native 1-edit fuzzy "AI Conciousness" -> consciousness rank 1', /conscious/i.test(typo[0]?.path || '') || /conscious/i.test(typo[0]?.title || ''), typo[0]?.path);

        // R1: nonsense rejection on storage
        for (const q of ['zxqjvplkmn wqertyuiop', 'flibbertigibbet snorkleblat']) {
            const out = await vdb.vdb_search({ query: q, collections: ['storage'], search: lexRerank }, {});
            const text = out.content[0].text;
            check(`R1 storage rejects nonsense ("${q}")`, /No relevant/.test(text) && !text.includes('100.0%'), text.split('\n')[1]);
        }

        // Memory golden queries
        const proto = await memory.memory_recall({ query: 'German public funding Prototype Fund open source application window', limit: 5, search: lexRerank }, ctx);
        const protoIds = extractMemIds(proto.content[0].text);
        check('memory #6830 top-3 (Prototype Fund)', protoIds.slice(0, 3).includes(6830), `top=${protoIds.slice(0, 5).map(id => '#' + id).join(', ')}`);

        const quote = await memory.memory_recall({ query: 'A Little Religion v6 final', limit: 3, search: lexRerank }, ctx);
        const quoteIds = extractMemIds(quote.content[0].text);
        check('memory #2103 rank 1 (A Little Religion v6 final)', quoteIds[0] === 2103, `top=${quoteIds.slice(0, 3).map(id => '#' + id).join(', ')}`);

        const nui = await memory.memory_recall({ query: 'nui_wc2', limit: 3, search: lexRerank }, ctx);
        const nuiIds = extractMemIds(nui.content[0].text);
        check('memory nui_wc2 returns relevant hits', nuiIds.length > 0 && !/No relevant/.test(nui.content[0].text), `top=${nuiIds.slice(0, 3).map(id => '#' + id).join(', ')}`);

        // R1: nonsense rejection on memory
        for (const q of ['zxqjvplkmn wqertyuiop', 'flibbertigibbet snorkleblat']) {
            const out = await memory.memory_recall({ query: q, limit: 5, search: lexRerank }, ctx);
            const text = out.content[0].text;
            check(`R1 memory rejects nonsense ("${q}")`, /No relevant|No memories found/.test(text) && !text.includes('100.0%'), text.split('\n')[1]);
        }

        await memory.shutdown();
        console.log(`\nSummary: ${failures.length === 0 ? 'ALL REAL-CORPUS REPLICA GATES PASSED' : `${failures.length} FAILURE(S)`}`);
        if (failures.length > 0) process.exitCode = 1;
    } catch (err) {
        if (stderr) console.error('nvdb serve stderr:\n', stderr);
        throw err;
    } finally {
        proc.kill();
        await fs.rm(replicaRoot, { recursive: true, force: true }).catch(() => {});
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
