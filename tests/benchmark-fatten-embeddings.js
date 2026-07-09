const FATTEN_URL = 'http://192.168.0.145:4080/v1/embeddings';
const GATEWAY_HTTP_URL = 'http://localhost:3400';

const MODELS_TO_TEST = [
    {
        name: 'Qwen3-Embedding-4B-Q4_K_M',
        path: 'E:\\LM Studio Models\\Qwen\\Qwen3-Embedding-4B-GGUF\\Qwen3-Embedding-4B-Q4_K_M.gguf',
        dims: 2560
    },
    {
        name: 'Qwen3-Embedding-4B-f16',
        path: 'E:\\LM Studio Models\\Qwen\\Qwen3-Embedding-4B-GGUF\\Qwen3-Embedding-4B-f16.gguf',
        dims: 2560
    },
    {
        name: 'Qwen3-Embedding-0.6B-f16',
        path: 'E:\\LM Studio Models\\Qwen\\Qwen3-Embedding-0.6B-GGUF\\Qwen3-Embedding-0.6B-f16.gguf',
        dims: 1024
    },
    {
        name: 'Qwen3-Embedding-8B-Q4_K_M',
        path: 'E:\\LM Studio Models\\Qwen\\Qwen3-Embedding-8B-GGUF\\Qwen3-Embedding-8B-Q4_K_M.gguf',
        dims: 2560
    },
    {
        name: 'nomic-embed-text-v2-moe-Q8_0',
        path: 'E:\\LM Studio Models\\nomic-ai\\nomic-embed-text-v2-moe-GGUF\\nomic-embed-text-v2-moe.Q8_0.gguf',
        dims: 768
    },
    {
        name: 'jina-v5-small-retrieval-Q8_0',
        path: 'E:\\LM Studio Models\\jinaai\\jina-embeddings-v5-text-small-retrieval\\v5-small-retrieval-Q8_0.gguf',
        dims: 2048
    },
    {
        name: 'jina-v5-nano-retrieval-Q8_0',
        path: 'E:\\LM Studio Models\\jinaai\\jina-embeddings-v5-text-nano-retrieval\\v5-nano-retrieval-Q8_0.gguf',
        dims: 1024
    },
    {
        name: 'embeddinggemma-300M-F32',
        path: 'E:\\LM Studio Models\\unsloth\\embeddinggemma-300m-GGUF\\embeddinggemma-300M-F32.gguf',
        dims: 768
    },
    {
        name: 'embeddinggemma-300M-Q8_0',
        path: 'E:\\LM Studio Models\\ggml-org\\embeddinggemma-300M-GGUF\\embeddinggemma-300M-Q8_0.gguf',
        dims: 768
    }
];

const PAIRS = [
    { a: 'a dog', b: 'a cat', label: 'related-animals', expected: 'high' },
    { a: 'pizza', b: 'quantum physics', label: 'unrelated', expected: 'low' },
    { a: 'AI', b: 'machine learning', label: 'related-tech', expected: 'high' },
    { a: 'the dog solved puzzles', b: 'animals are smart', label: 'related-concept', expected: 'high' }
];

async function stopAllModels() {
    try {
        const res = await fetch('http://192.168.0.145:4080/stop', { method: 'POST' });
        const txt = await res.text();
        console.log(`  [stop] ${txt}`);
    } catch (e) {
        console.log(`  [stop] error: ${e.message}`);
    }
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        throw new Error('cosineSimilarity: mismatched or non-array vectors');
    }
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildHeaders(modelPath) {
    return {
        'Content-Type': 'application/json',
        'X-Model-Path': modelPath,
        'X-Model-Embedding': 'true',
        'X-Model-Pooling': 'mean',
        'X-Model-CtxSize': '32000',
        'X-Model-GpuLayers': '99',
        'X-Model-Mlock': 'true'
    };
}

async function fattenEmbed(texts, modelPath, dims) {
    const body = { input: Array.isArray(texts) ? texts : [texts], model: 'test', dimensions: dims };
    const res = await fetch(FATTEN_URL, {
        method: 'POST',
        headers: buildHeaders(modelPath),
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`fatten ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.data.map(d => d.embedding);
}

async function openRouterEmbed(texts) {
    const res = await fetch(`${GATEWAY_HTTP_URL}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: Array.isArray(texts) ? texts : [texts], model: 'or-qwen-embed' })
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data.map(d => d.embedding);
}

async function benchmarkModel(model) {
    console.log(`\n--- ${model.name} ---`);
    const results = [];
    let loadMs = null;
    try {
        const start = Date.now();
        const run = async (texts) => fattenEmbed(texts, model.path, model.dims);
        const allTexts = PAIRS.flatMap(p => [p.a, p.b]);
        const vectors = await run(allTexts);
        loadMs = Date.now() - start;
        for (let i = 0; i < PAIRS.length; i++) {
            const pair = PAIRS[i];
            const sim = cosineSimilarity(vectors[i * 2], vectors[i * 2 + 1]);
            results.push({ label: pair.label, sim });
            console.log(`  ${pair.label}: ${sim.toFixed(4)}`);
        }
        console.log(`  first-call time: ${loadMs}ms`);
        return { name: model.name, ok: true, results, loadMs };
    } catch (e) {
        console.log(`  FAILED: ${e.message}`);
        return { name: model.name, ok: false, error: e.message };
    }
}

async function benchmarkOpenRouter() {
    console.log('\n--- OpenRouter or-qwen-embed ---');
    const results = [];
    const allTexts = PAIRS.flatMap(p => [p.a, p.b]);
    const start = Date.now();
    const vectors = await openRouterEmbed(allTexts);
    const loadMs = Date.now() - start;
    for (let i = 0; i < PAIRS.length; i++) {
        const pair = PAIRS[i];
        const sim = cosineSimilarity(vectors[i * 2], vectors[i * 2 + 1]);
        results.push({ label: pair.label, sim });
        console.log(`  ${pair.label}: ${sim.toFixed(4)}`);
    }
    console.log(`  time: ${loadMs}ms`);
    return { name: 'OpenRouter or-qwen-embed', ok: true, results, loadMs };
}

async function main() {
    const summary = [];
    summary.push(await benchmarkOpenRouter());

    for (const model of MODELS_TO_TEST) {
        summary.push(await benchmarkModel(model));
        await stopAllModels();
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('\n=== SUMMARY ===');
    for (const row of summary) {
        if (!row.ok) {
            console.log(`${row.name}: FAILED - ${row.error}`);
            continue;
        }
        const unrelated = row.results.find(r => r.label === 'unrelated')?.sim.toFixed(3);
        const related = row.results.filter(r => r.label !== 'unrelated').map(r => r.sim.toFixed(3)).join('/');
        console.log(`${row.name}: unrelated=${unrelated} related=[${related}] time=${row.loadMs}ms`);
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
