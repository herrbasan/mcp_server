import { createGatewayClient } from '../src/gateway-client.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf-8'));

const gateway = createGatewayClient(config.gateway.wsUrl, config.gateway.httpUrl);

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function norm(v) {
    return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function meanAbs(v) {
    return v.reduce((s, x) => s + Math.abs(x), 0) / v.length;
}

const pairs = [
    ['a dog', 'a cat'],
    ['animals are smart', 'the dog solved puzzles'],
    ['i like animals, they are really smart', 'His dog Balu was an exceptionally intelligent Jagdhund who could solve multi-step puzzles through reasoning'],
    ['i love my children', 'deep relationship with wife and kids'],
    ['death and memory', 'music as original memory technology'],
    ['artificial intelligence', 'machine learning'],
    ['pizza', 'quantum physics'],
    ['companionship and pets', 'the dog was simple and true'],
];

const models = ['or-qwen-embed', 'gemini-embed', 'badkid-llama-embed', 'fatten-llama-embed'];

async function embedWithModel(model, text) {
    const body = model ? { input: text, model } : { input: text, task: 'embed' };
    const res = await fetch(`${config.gateway.httpUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${model || 'task:embed'} HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
}

const targets = [
    { label: 'task: embed', model: null },
    { label: 'model: or-qwen-embed', model: 'or-qwen-embed' },
    { label: 'model: gemini-embed', model: 'gemini-embed' },
    { label: 'model: fatten-llama-embed', model: 'fatten-llama-embed' },
];

console.log('Comparing embedding routes/models on controlled pairs:\n');
for (const { label, model } of targets) {
    console.log(`\n=== ${label} ===`);
    try {
        const sample = await embedWithModel(model, 'hello world');
        console.log(`dimensions: ${sample.length}, norm: ${norm(sample).toFixed(4)}, meanAbs: ${meanAbs(sample).toFixed(6)}`);
        for (const [a, b] of pairs) {
            const [ea, eb] = await Promise.all([embedWithModel(model, a), embedWithModel(model, b)]);
            console.log(`[${cosine(ea, eb).toFixed(4)}] "${a}" <-> "${b}"`);
        }
    } catch (e) {
        console.log(`FAILED: ${e.message}`);
    }
}

process.exit(0);
