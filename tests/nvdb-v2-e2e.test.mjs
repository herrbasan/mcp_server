import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as vdb from '../src/agents/vdb/index.js';
import * as memory from '../src/agents/memory/index.js';
import * as storage from '../src/agents/storage/index.js';
import { createV2Client } from '../src/agents/vdb/v2-client.js';
import { createNdbClient } from '../src/lib/ndb-client.js';
import { startNdbTestServer } from './helpers/ndb-test-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NVDB_ROOT = process.env.NVDB_ROOT || 'D:\\DEV\\nVDB';
const NVDB_EXE = process.env.NVDB_BIN || path.join(NVDB_ROOT, 'target', 'release', 'nvdb.exe');
const RERANKER_DIR = process.env.NVDB_RERANKER_MODEL || path.join(NVDB_ROOT, 'models', 'reranker', 'atelasi-multilingual-reranker-small');

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

async function waitForHealth(client, timeoutMs = 15_000) {
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
    throw new Error(`nvdb serve did not become healthy within ${timeoutMs}ms: ${lastErr?.message}`);
}

// Deterministic 2560-dim unit vector derived from text tokens so dense lane
// tests run offline without depending on live gateway GPU availability.
function deterministicEmbed(text, dim = 2560) {
    const vec = new Float32Array(dim);
    const tokens = String(text).toLowerCase().match(/[a-zäöüß0-9]+/g) || ['empty'];
    for (const tok of tokens) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) {
            h ^= tok.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        const idx = h % dim;
        vec[idx] += 1;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) out[i] = vec[i] / norm;
    return out;
}

const mockGateway = {
    async embed(text) {
        return deterministicEmbed(text);
    },
    async embedBatch(texts) {
        return texts.map(t => deterministicEmbed(t));
    },
};

async function run() {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nvdb-v2-e2e-'));
    const nvdbDir = path.join(tmpRoot, 'nvdb');
    const storageDir = path.join(tmpRoot, 'storage');
    const ndbRootDir = path.join(tmpRoot, 'ndb');
    const memDbPath = path.join(ndbRootDir, 'memories', 'data.jsonl');
    await fs.mkdir(path.join(storageDir, 'documentation'), { recursive: true });
    await fs.mkdir(path.join(storageDir, 'religion'), { recursive: true });
    await fs.mkdir(path.dirname(memDbPath), { recursive: true });

    // Seed replica storage files
    await fs.writeFile(
        path.join(storageDir, 'documentation', 'ai-consciousness.md'),
        '# AI Consciousness\n\nConsciousness Is the Record. This document examines AI consciousness and epistemic grounding.\n',
        'utf8'
    );
    await fs.writeFile(
        path.join(storageDir, 'documentation', 'md-blocks-spec.md'),
        '---\ntitle: MD-Blocks Specification\n---\n\n# MD-Blocks Spec\n\nMarkdown blocks specification for structured authoring.\n',
        'utf8'
    );
    await fs.writeFile(
        path.join(storageDir, 'documentation', 'rechtsschutz.md'),
        '# Rechtsschutzversicherung\n\nHinweise zur Rechtsschutzversicherung und Vertragskündigung.\n',
        'utf8'
    );
    await fs.writeFile(
        path.join(storageDir, 'religion', 'notes.md'),
        '# Little Religion\n\nNotes on philosophy and religion.\n',
        'utf8'
    );
    await fs.writeFile(
        path.join(storageDir, 'religion', 'meta-export.json'),
        JSON.stringify({ topic: 'religion', note: 'json sidecar' }),
        'utf8'
    );

    // Seed replica nDB memory store with _meta
    await fs.writeFile(
        memDbPath,
        JSON.stringify({ _id: '_meta_0', nextId: 1 }) + '\n',
        'utf8'
    );

    const port = await getFreePort();
    const serviceUrl = `http://127.0.0.1:${port}`;
    const args = ['serve', '--dir', nvdbDir, '--host', '127.0.0.1', '--port', String(port), '--reranker-model', RERANKER_DIR];
    const proc = spawn(NVDB_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // Real `ndb serve` hosting the memories DB.
    const ndbServer = await startNdbTestServer({ rootDir: ndbRootDir });

    try {
        const client = createV2Client(serviceUrl);
        const health = await waitForHealth(client);
        assert.equal(health.ok, true, 'nvdb serve /health ok');
        assert.equal(health.reranker_loaded, true, 'nvdb serve loaded ONNX reranker');
        console.log('✓ nvdb serve healthy with reranker_loaded=true');

        // Initialize vdb and memory agents against local nvdb serve + ndb serve
        const config = {
            ndb: {
                serviceUrl: ndbServer.url,
                dbs: { memories: 'memories' },
            },
            agents: {
                storage: { root: storageDir },
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
                    maxMemoryChars: 6000,
                },
            },
        };

        const agents = new Map();
        const vdbInstance = await vdb.init({ config, gateway: mockGateway, agents });
        agents.set('vdb', vdbInstance);
        const memInstance = await memory.init({ config, gateway: mockGateway, agents });
        agents.set('memory', memInstance);
        await storage.init({ config, agents });

        // 1. Sync storage + drain embeddings
        const scanRes = await vdb.vdb_trigger_scan({}, {});
        const scanStats = JSON.parse(scanRes.content[0].text);
        assert.equal(scanStats.files, 5, 'synced all 5 replica files');
        assert.equal(scanStats.upserted, 5, 'upserted 5 chunks');
        assert.equal(scanStats.attached, 5, 'attached 5 vectors');
        console.log('✓ storage sync + vector attach:', scanStats);

        // 2. Integrity check clean (with vectors)
        const storageCheck = await vdb.integrityCheck({ collection: 'storage', checkVectors: true });
        assert.equal(storageCheck.clean, true, `storage integrity_check clean: ${JSON.stringify(storageCheck)}`);
        console.log('✓ storage integrity_check clean');

        // 3. Watermark persistence round-trip
        const wmRes = await client.setWatermark('storage', {
            source_epoch_uuid: '00000000-0000-0000-0000-000000000001',
            synced_seq: 42,
        });
        assert.equal(wmRes.ok, true, 'watermark persisted');
        assert.equal(wmRes.watermark.synced_seq, 42);
        console.log('✓ watermark route verified');

        // 4. Exact title + rerank
        const exact = await vdb.searchDocuments({ query: 'MD-Blocks Specification', top_k: 3, include_content: true });
        assert.equal(exact[0].path, 'documentation/md-blocks-spec.md', 'exact title hits rank 1');
        assert.ok(typeof exact[0].rerankScore === 'number', 'rerankScore attached');
        assert.ok(exact[0].content.includes('Markdown blocks specification'), 'include_content returns full chunk');
        console.log('✓ exact title + rerank + include_content');

        // 4b. Timing: exposed non-enumerably on searchDocuments results
        const timed = await vdb.searchDocuments({ query: 'MD-Blocks Specification', top_k: 3 });
        assert.ok(timed.timing, 'searchDocuments exposes results.timing');
        assert.equal(Object.prototype.propertyIsEnumerable.call(timed, 'timing'), false, 'timing is non-enumerable');
        assert.ok(Number.isFinite(timed.timing.totalMs) && timed.timing.totalMs >= 0, 'timing.totalMs is finite and non-negative');
        assert.ok(Number.isFinite(timed.timing.searchMs) && timed.timing.searchMs >= 0, 'timing.searchMs is finite and non-negative');
        assert.ok(Number.isFinite(timed.timing.rerankMs) && timed.timing.rerankMs >= 0, 'timing.rerankMs is finite when rerank runs');
        assert.ok(!JSON.stringify(timed).includes('timing'), 'JSON.stringify(results) omits timing');
        const vdbTimed = await vdb.vdb_search({ query: 'MD-Blocks Specification', collections: ['storage'] }, {});
        assert.match(vdbTimed.content[0].text.split('\n')[0], /\| took: \d+\.\dms/, 'vdb.search mode line carries timing');
        const storageTimed = await storage.storage_search({ query: 'MD-Blocks Specification', top_k: 3 }, {});
        assert.match(storageTimed.content[0].text.split('\n')[0], /\| took: \d+\.\dms/, 'storage.search mode line carries timing');
        console.log('✓ search timing exposed (non-enumerable) and rendered in vdb/storage replies');

        // 5. Native 1-edit fuzzy typo ("AI Conciousness") — zero JS query-normalizer
        const typo = await vdb.searchDocuments({ query: 'AI Conciousness', top_k: 3 });
        assert.equal(typo[0].path, 'documentation/ai-consciousness.md', 'native 1-edit fuzzy finds AI Consciousness');
        console.log('✓ native fuzzy typo match (no query-normalizer.js)');

        // 6. Native German compound decompounding
        const compound = await vdb.searchDocuments({ query: 'Versicherung', top_k: 3, search: { dense: false, rerank: false } });
        assert.equal(compound[0].path, 'documentation/rechtsschutz.md', 'German compound body_parts matches Versicherung');
        console.log('✓ native German compound match');

        // 7. Native folder + extension filters (R3)
        const dotMd = await vdb.searchDocuments({ query: 'religion', folder: 'religion', extension: '.md', top_k: 5 });
        const plainMd = await vdb.searchDocuments({ query: 'religion', folder: 'religion', extension: 'md', top_k: 5 });
        const upperMd = await vdb.searchDocuments({ query: 'religion', folder: 'religion', extension: 'MD', top_k: 5 });
        assert.equal(dotMd.length, 1);
        assert.equal(dotMd[0].path, 'religion/notes.md');
        assert.deepEqual(dotMd.map(r => r.id), plainMd.map(r => r.id));
        assert.deepEqual(dotMd.map(r => r.id), upperMd.map(r => r.id));
        for (const bad of ['md.', '..md', '', '.', '-md']) {
            await assert.rejects(() => vdb.searchDocuments({ query: 'religion', extension: bad }));
        }
        console.log('✓ native folder + extension filters + strict validation');

        // 8. Nonsense query rejected by Level-2 relevance floor (R1)
        const nonsense = await vdb.vdb_search({ query: 'zxqjvplkmn wqertyuiop', collections: ['storage'] }, {});
        assert.ok(nonsense.content[0].text.includes('No relevant'), `nonsense rejected: ${nonsense.content[0].text.slice(0, 120)}`);
        assert.match(nonsense.content[0].text.split('\n')[0], /\| took: \d+\.\dms/, 'rejected vdb.search carries timing');
        console.log('✓ Level-2 nonsense rejection');

        // 9. Memory store -> recall -> update -> forget -> integrity_check
        await memory.memory_store(
            { description: 'Prototype Fund funding decision for open-source tooling', category: 'funding', confidence: 0.9 },
            { gateway: mockGateway }
        );
        await memory.memory_store(
            { description: 'nui_wc2 web component library uses native custom elements', category: 'architecture', confidence: 0.9 },
            { gateway: mockGateway }
        );
        // Wait briefly for detached background embed attach
        await new Promise(r => setTimeout(r, 300));

        const memRecall = await memory.memory_recall({ query: 'Prototype Fund funding', limit: 3 }, { gateway: mockGateway });
        assert.ok(memRecall.content[0].text.includes('Prototype Fund'), `memory recall hit: ${memRecall.content[0].text}`);
        assert.match(memRecall.content[0].text.split('\n')[0], /\| took: \d+\.\dms/, 'memory.recall mode line carries timing');
        const memMiss = await memory.memory_recall({ query: 'zxqjvplkmn wqertyuiop', limit: 3 }, { gateway: mockGateway });
        assert.ok(memMiss.content[0].text.includes('took: '), 'memory no-hit/reject path carries timing');

        const memCat = await memory.memory_recall({ query: 'web component', category: 'architecture', limit: 3 }, { gateway: mockGateway });
        assert.ok(memCat.content[0].text.includes('nui_wc2'), 'promoted category filter works');

        const memCheck = await memory.memoryIntegrityCheck({ checkVectors: true });
        assert.equal(memCheck.clean, true, `memory integrity_check clean: ${JSON.stringify(memCheck)}`);
        console.log('✓ memory store/recall/category/integrity_check clean');

        // 9b. memories adapter (dreaming's read path) + list via Rust POST /query
        const iterDocs = await memInstance.memories.iter();
        assert.equal(iterDocs.length, 2, `adapter iter() returns both memories (got ${iterDocs.length})`);
        assert.equal(await memInstance.memories.count(), 2, 'adapter count() matches');
        assert.ok(iterDocs.every(d => d._id.startsWith('mem_')), 'iter() excludes the _meta doc');

        const listNewest = await memory.memory_list({}, {});
        assert.ok(listNewest.content[0].text.includes('2 memories'), `list total: ${listNewest.content[0].text.slice(0, 80)}`);
        const newestFirst = listNewest.content[0].text.split('\n').filter(l => l.startsWith('[#'));
        assert.deepEqual(newestFirst.map(l => l.slice(0, l.indexOf(']') + 1)), ['[#2]', '[#1]'], 'list newest-first via query sort');
        const listOldest = await memory.memory_list({ sort: 'oldest', limit: 1 }, {});
        assert.ok(listOldest.content[0].text.includes('[#1]'), 'limit + oldest sort pushed into query');
        assert.ok(listOldest.content[0].text.includes('(1 of 2 shown'), 'limit truncation reported');
        const listCat = await memory.memory_list({ category: 'architecture' }, {});
        assert.ok(listCat.content[0].text.includes('nui_wc2') && !listCat.content[0].text.includes('Prototype Fund'), 'category filter pushed into query');

        // 9c. update through one atomic PATCH, then read back
        await memory.memory_update(
            { id: 1, description: 'Prototype Fund grant approved for open-source tooling', category: 'funding-approved', confidence: 1 },
            { gateway: mockGateway }
        );
        const patched = (await memory.memory_get({ id: 1 }, {})).content[0].text;
        assert.ok(patched.includes('grant approved'), `patched description: ${patched}`);
        assert.ok(patched.includes('funding-approved'), 'patched category visible');
        const patchedDoc = await createNdbClient(ndbServer.url).db('memories').query({
            filter: { id: { $eq: 1 } },
            limit: 1,
        });
        assert.equal(patchedDoc.results[0].embedStatus, 'pending', 'text change marks embedStatus pending');
        const memCheckAfterUpdate = await memory.memoryIntegrityCheck({ checkVectors: false });
        assert.equal(memCheckAfterUpdate.clean, true, `integrity_check clean after PATCH: ${JSON.stringify(memCheckAfterUpdate)}`);

        // 9d. forget removes the doc from ndb serve and the vector index
        await memory.memory_forget({ id: 2 }, {});
        assert.equal((await memInstance.memories.count()), 1, 'count drops after forget');
        const forgotten = await memory.memory_get({ id: 2 }, {});
        assert.equal(forgotten.isError, true, 'forgotten memory no longer resolves');
        const memCheckAfterForget = await memory.memoryIntegrityCheck({ checkVectors: true });
        assert.equal(memCheckAfterForget.clean, true, `integrity_check clean after forget: ${JSON.stringify(memCheckAfterForget)}`);
        console.log('✓ memory list/update(PATCH)/forget via ndb serve HTTP');

        // 10. File edit + delete lifecycle -> integrity_check stays clean
        await fs.unlink(path.join(storageDir, 'religion', 'meta-export.json'));
        const resync = JSON.parse((await vdb.vdb_trigger_scan({}, {})).content[0].text);
        assert.equal(resync.deleted, 1, 'deleted removed file from nvdb');
        const storageCheckAfter = await vdb.integrityCheck({ collection: 'storage', checkVectors: true });
        assert.equal(storageCheckAfter.clean, true, 'storage integrity_check clean after delete');
        console.log('✓ delete lifecycle + post-delete integrity_check clean');

        await memory.shutdown();
        console.log('\nALL PHASE 4 E2E GATES PASSED.');
    } catch (err) {
        if (stderr) console.error('nvdb serve stderr:\n', stderr);
        throw err;
    } finally {
        proc.kill();
        await ndbServer.stop();
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
