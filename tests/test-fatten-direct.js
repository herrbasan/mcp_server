async function embedDirect(url, text, model, modelPath, headerName = 'X-Model-Path') {
    const body = model ? { input: text, model } : { input: text };
    const headers = { 'Content-Type': 'application/json' };
    if (modelPath) headers[headerName] = modelPath;
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const pairs = [
    ['a dog', 'a cat'],
    ['pizza', 'quantum physics'],
    ['i like animals, they are really smart', 'His dog Balu was an exceptionally intelligent Jagdhund who could solve multi-step puzzles through reasoning'],
    ['artificial intelligence', 'machine learning'],
];

const QWEN_PATH = 'E:\\LM Studio Models\\Qwen\\Qwen3-Embedding-4B-GGUF\\Qwen3-Embedding-4B-Q4_K_M.gguf';

const endpoints = [
    { label: 'fatten /v1/embeddings (X-Model-Path lowercase)', url: 'http://192.168.0.145:4080/v1/embeddings', model: null, modelPath: QWEN_PATH, headerName: 'x-model-path' },
    { label: 'fatten /v1/embeddings (X-Model-Path mixed)', url: 'http://192.168.0.145:4080/v1/embeddings', model: null, modelPath: QWEN_PATH, headerName: 'X-Model-Path' },
    { label: 'fatten /embedding (native, X-Model-Path mixed)', url: 'http://192.168.0.145:4080/embedding', model: null, modelPath: QWEN_PATH, headerName: 'X-Model-Path' },
];

for (const ep of endpoints) {
    console.log(`\n=== ${ep.label} ===`);
    try {
        const sample = await embedDirect(ep.url, 'hello world', ep.model);
        console.log(`dimensions: ${sample.length}, norm: ${Math.sqrt(sample.reduce((s,x)=>s+x*x,0)).toFixed(4)}`);
        for (const [a, b] of pairs) {
            const [ea, eb] = await Promise.all([embedDirect(ep.url, a, ep.model, ep.modelPath), embedDirect(ep.url, b, ep.model, ep.modelPath)]);
            console.log(`[${cosine(ea, eb).toFixed(4)}] "${a}" <-> "${b}"`);
        }
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}
