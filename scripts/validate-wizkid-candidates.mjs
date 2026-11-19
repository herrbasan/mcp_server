import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import { retryAfterMs } from '../src/wizkid-job-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(repo, 'data', 'candidates', 'wizkid-qwen3-embedding-4b');
const config = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(path.join(repo, 'tests', 'fixtures', 'memory-lab-phase0-golden.json'), 'utf8'));
const gateway = config.gateway.httpUrl.replace(/\/+$/, '');
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.gateway.accessKey}` };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function embedQueries(texts) {
    const vectors = [];
    for (let offset = 0; offset < texts.length; offset += 4) {
        const input = texts.slice(offset, offset + 4);
        let data;
        for (let attempt = 0; ; attempt++) {
            const response = await fetch(`${gateway}/v1/embeddings/wizkid`, { method: 'POST', headers, body: JSON.stringify({ input }) });
            const body = await response.json();
            if (response.status === 429 || response.status === 503) {
                const delay = retryAfterMs(response.headers.get('retry-after'));
                if (delay === null || attempt >= 20) throw new Error(`Wizkid query HTTP ${response.status} without usable Retry-After`);
                await sleep(delay);
                continue;
            }
            if (!response.ok) throw new Error(`Wizkid query HTTP ${response.status}: ${body.error?.message || 'unknown error'}`);
            data = body;
            break;
        }
        if (!Array.isArray(data.data) || data.data.length !== input.length) throw new Error('Wizkid query returned the wrong result count');
        const ordered = new Array(input.length);
        for (const item of data.data) {
            if (!Number.isInteger(item.index) || item.index < 0 || item.index >= input.length || ordered[item.index]) throw new Error('Wizkid query returned invalid indices');
            if (!Array.isArray(item.embedding) || item.embedding.length !== 2560) throw new Error('Wizkid query returned an invalid vector');
            ordered[item.index] = item.embedding;
        }
        vectors.push(...ordered);
    }
    return vectors;
}

const queries = [...golden.memory, ...golden.storage].map(item => item.query);
const vectors = await embedQueries(queries);
const { Database } = loadNvdb();
const db = new Database(path.join(root, 'nvdb'));
const memory = db.getCollection('memory');
const storage = db.getCollection('storage');
const report = { candidate: root, checkedAt: new Date().toISOString(), memory: [], storage: [] };
let failures = 0;

for (let i = 0; i < golden.memory.length; i++) {
    const test = golden.memory[i];
    const hits = await memory.search({ vector: vectors[i], topK: 10, distance: 'cosine', approximate: false });
    const rows = hits.map(hit => ({ id: JSON.parse(hit.payload).id, score: hit.score }));
    const relevant = (test.relevantIds || []).filter(id => rows.some(row => row.id === id));
    const ok = relevant.length === (test.relevantIds || []).length;
    if (!ok) failures++;
    report.memory.push({ id: test.id, ok, relevantFound: relevant, top10: rows });
}

for (let i = 0; i < golden.storage.length; i++) {
    const test = golden.storage[i];
    const hits = await storage.search({ vector: vectors[golden.memory.length + i], topK: 10, distance: 'cosine', approximate: false });
    const rows = hits.map(hit => ({ path: JSON.parse(hit.payload).path, score: hit.score }));
    const relevant = (test.relevantPaths || []).filter(expected => rows.some(row => row.path === expected));
    const adjacent = (test.adjacentPaths || []).filter(expected => rows.some(row => row.path === expected));
    const ok = relevant.length === (test.relevantPaths || []).length;
    if (!ok) failures++;
    report.storage.push({ id: test.id, ok, relevantFound: relevant, adjacentFound: adjacent, top10: rows });
}

memory.close();
storage.close();
db.close();
report.ok = failures === 0;
report.failures = failures;
const reportPath = path.join(root, 'reports', `golden-${Date.now()}.json`);
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: report.ok, failures, memory: report.memory.map(test => ({ id: test.id, ok: test.ok, found: test.relevantFound })), storage: report.storage.map(test => ({ id: test.id, ok: test.ok, found: test.relevantFound, adjacent: test.adjacentFound })), reportPath }, null, 2));
process.exit(failures ? 1 : 0);
