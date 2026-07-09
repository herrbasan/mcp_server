// Benchmark: does the context-enhanced header improve retrieval relevance?
//
// Usage:
//   node tests/benchmark-context-enhancement.js <file> <query1> <query2> ...
//
// Example:
//   node tests/benchmark-context-enhancement.js D:\MCP_Storage\digital-twin\herrbasan-digital-twin.md "Herrbasan philosophy" "Atari ST" "voice rules" "substrate theory"
//
// The script:
//   1. Chunks the file.
//   2. Generates context metadata for the file using the local task.
//   3. Embeds each chunk both raw and with the context header prepended.
//   4. Embeds each query.
//   5. Reports cosine similarity for raw vs. enhanced chunks per query.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createGatewayClient } from '../src/gateway-client.js';
import { makeChunker } from '../src/agents/vdb/chunker.js';
import { createContextEnhancer } from '../src/agents/vdb/context-enhancer.js';
import { getLogger } from '../src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf-8'));
const logger = getLogger();

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedBatch(gateway, texts) {
    const res = await fetch(`${config.gateway.httpUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts, task: 'embed' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data.map(d => d.embedding);
}

async function main() {
    const target = process.argv[2];
    const queries = process.argv.slice(3);
    if (!target || queries.length === 0) {
        console.error('Usage: node benchmark-context-enhancement.js <file> <query1> <query2> ...');
        process.exit(1);
    }

    const content = fs.readFileSync(target, 'utf-8');
    const chunker = makeChunker({ maxTokens: 1024, overlapTokens: 128, tokCharsRatio: 2.5 });
    const chunks = chunker(content);

    const gateway = createGatewayClient(config.gateway.wsUrl, config.gateway.httpUrl);
    let waited = 0;
    while (!gateway.connected && waited < 10000) {
        await new Promise(r => setTimeout(r, 100));
        waited += 100;
    }
    if (!gateway.connected) {
        console.error('Gateway not connected');
        process.exit(1);
    }

    const enhancer = createContextEnhancer({
        enabled: true,
        task: 'local',
        maxInputChars: 12000,
        maxOutputTokens: 512,
        temperature: 0.3,
        truncation: 'headmidtail'
    }, gateway, logger);

    const prepared = {
        absolutePath: target,
        relPath: path.basename(target),
        tokCharsRatio: 2.5,
        metadata: {},
        chunks: chunks.map((c, idx) => ({
            docId: `${path.basename(target)}#${idx}`,
            text: c.text,
            splitIdx: c.splitIdx,
            charOffset: c.charOffset,
            isLastChunk: c.isLastChunk,
            tokEst: c.tokEst
        }))
    };

    console.log('Generating context metadata...');
    const enhanced = await enhancer.enhance(prepared);

    if (!enhanced.metadata.contextEnhanced) {
        console.error('Context enhancement failed:', enhanced.metadata.contextError);
        process.exit(1);
    }

    console.log('Metadata:', {
        docType: enhanced.metadata.docType,
        summary: enhanced.metadata.summary,
        keywords: enhanced.metadata.keywords,
        entities: enhanced.metadata.entities
    });

    console.log(`Embedding ${chunks.length} chunks raw + enhanced, ${queries.length} queries...`);

    const rawTexts = prepared.chunks.map(c => c.text);
    const enhancedTexts = enhanced.chunks.map(c => c.text);

    const rawEmbeddings = await embedBatch(gateway, rawTexts);
    const enhancedEmbeddings = await embedBatch(gateway, enhancedTexts);
    const queryEmbeddings = await embedBatch(gateway, queries);

    console.log('\n=== Per-query top chunk similarity ===\n');

    let rawWins = 0;
    let enhancedWins = 0;
    let ties = 0;

    for (let q = 0; q < queries.length; q++) {
        const query = queries[q];
        const qEmb = queryEmbeddings[q];

        let rawBest = -1, enhancedBest = -1;
        let rawBestIdx = -1, enhancedBestIdx = -1;

        for (let i = 0; i < chunks.length; i++) {
            const r = cosine(qEmb, rawEmbeddings[i]);
            const e = cosine(qEmb, enhancedEmbeddings[i]);
            if (r > rawBest) { rawBest = r; rawBestIdx = i; }
            if (e > enhancedBest) { enhancedBest = e; enhancedBestIdx = i; }
        }

        if (enhancedBest > rawBest) enhancedWins++;
        else if (rawBest > enhancedBest) rawWins++;
        else ties++;

        console.log(`Query: "${query}"`);
        console.log(`  raw best    = ${rawBest.toFixed(4)} (chunk ${rawBestIdx})`);
        console.log(`  enhanced    = ${enhancedBest.toFixed(4)} (chunk ${enhancedBestIdx})`);
        console.log(`  delta       = ${(enhancedBest - rawBest).toFixed(4)}`);
        console.log();
    }

    console.log('=== Summary ===');
    console.log(`Enhanced wins: ${enhancedWins}, Raw wins: ${rawWins}, Ties: ${ties}`);

    gateway.close();
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
