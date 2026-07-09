import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayConfig = JSON.parse(fs.readFileSync('D:\\DEV\\LLM Gateway\\config.json', 'utf-8'));
const apiKey = 'sk-cca79083195f4ab29cc8f3d41eec7bc4';
const endpoint = 'https://ws-etl47ajy6ckbya0x.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/embeddings';

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(model, text, dimensions, bodyFormat = 'string') {
    let input;
    if (bodyFormat === 'string') input = text;
    else if (bodyFormat === 'array') input = [text];
    else input = { texts: [text] };
    const body = { model, input };
    if (dimensions) body.dimensions = dimensions;
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const emb = data.output?.embeddings?.[0]?.embedding ?? data.data?.[0]?.embedding;
    return emb;
}

const pairs = [
    ['a dog', 'a cat'],
    ['pizza', 'quantum physics'],
    ['i like animals, they are really smart', 'His dog Balu was an exceptionally intelligent Jagdhund who could solve multi-step puzzles through reasoning'],
    ['artificial intelligence', 'machine learning'],
];

const models = [
    { name: 'text-embedding-v4', display: 'text-embedding-v4 (1024d)', dims: 1024 },
    { name: 'text-embedding-v4', display: 'text-embedding-v4 (2048d)', dims: 2048 },
    { name: 'text-embedding-v3', display: 'text-embedding-v3 (1024d)', dims: 1024 },
];

console.log('Testing DashScope embedding models:\n');
for (const { name, dims } of models) {
    console.log(`\n=== ${name} (${dims}d) ===`);
    try {
        const sample = await embed(name, 'hello world', dims);
        console.log(`actual dimensions: ${sample.length}`);
        for (const [a, b] of pairs) {
            const [ea, eb] = await Promise.all([embed(name, a, dims), embed(name, b, dims)]);
            console.log(`[${cosine(ea, eb).toFixed(4)}] "${a}" <-> "${b}"`);
        }
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}
