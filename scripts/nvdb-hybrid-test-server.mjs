import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Database, Reranker } = require('../src/nVDB/target/release/nvdb-hybrid-rerank-test.node');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const indexPath = path.join(repo, 'data', 'candidates', 'wizkid-hybrid-rerank', 'nvdb');
const modelDir = path.join(repo, 'src', 'nVDB', 'models', 'reranker', 'atelasi-multilingual-reranker-small');
const port = Number(process.env.PORT || 3197);

const db = new Database(indexPath);
const collections = {
    storage: db.getCollection('storage'),
    memory: db.getCollection('memory')
};
const reranker = new Reranker({
    modelPath: path.join(modelDir, 'model.onnx'),
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    maxLength: 64,
    batchSize: 10
});

async function embed(query) {
    const response = await fetch(`${config.gateway.httpUrl}/v1/embeddings/wizkid`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.gateway.accessKey}`
        },
        body: JSON.stringify({ input: [query] })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`query embedding failed: HTTP ${response.status} ${body.error?.message || ''}`);
    return body.data[0].embedding;
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, indexPath, collections: Object.keys(collections) }));
            return;
        }
        if (url.pathname !== '/search') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'use /search?lane=storage|memory&q=...' }));
            return;
        }
        const lane = url.searchParams.get('lane') || 'storage';
        const collection = collections[lane];
        if (!collection) throw new Error(`unknown lane: ${lane}`);
        const query = url.searchParams.get('q');
        if (!query) throw new Error('q is required');
        const topK = Math.min(50, Math.max(1, Number(url.searchParams.get('k') || 10)));
        const vector = await embed(query);
        const started = performance.now();
        const results = await collection.hybridSearchReranked(
            {
                vector,
                text: query,
                topK,
                candidateK: 200,
                groupBy: lane === 'storage' ? 'path' : 'id',
                maxPerDocument: 2,
                rrfK: 10
            },
            reranker,
            'content',
            0.2,
            10
        );
        const elapsedMs = performance.now() - started;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            lane,
            query,
            elapsedMs,
            results: results.map(result => {
                const payload = JSON.parse(result.payload);
                return {
                    id: result.id,
                    label: lane === 'storage' ? payload.path : payload.id,
                    score: result.score,
                    rrfScore: result.rrfScore,
                    rerankScore: result.rerankScore,
                    vectorRank: result.vectorRank,
                    lexicalRank: result.lexicalRank
                };
            })
        }, null, 2));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`hybrid rerank test server: http://127.0.0.1:${port}`);
    console.log(`health: http://127.0.0.1:${port}/health`);
    console.log(`search: http://127.0.0.1:${port}/search?lane=storage&q=Consciousness%20Is%20the%20Record`);
});
