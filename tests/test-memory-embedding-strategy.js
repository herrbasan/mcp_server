import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf-8'));

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(route, text) {
    const body = route.model ? { input: text, model: route.model } : { input: text, task: route.task };
    const res = await fetch(`${config.gateway.httpUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${route.label} HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data[0].embedding;
}

const memoryText = "Dana is load-bearing architecture. Not formally involved in business — was homemaker, name added to fake work history for job market after COVID collapse. Best possible partner, 100% trust including over life/death decisions. Mutual 'humoring' as love language: he shares philosophy, she shares work/social life, both know it's service, both accept it. Without her the Arena intensity would be unbearable.";

const queries = [
    'Dana',
    'Dana load-bearing architecture',
    'wife is essential support',
    'important person in my life',
    'trust and partnership',
    'job market fake work history COVID',
    'mutual humoring love language',
    'without her the Arena intensity would be unbearable',
];

const routes = [
    { label: 'task: embed (memory default)', task: 'embed', model: null },
    { label: 'model: or-qwen-embed', task: null, model: 'or-qwen-embed' },
    { label: 'model: gemini-embed', task: null, model: 'gemini-embed' },
];

console.log('Embedding the Dana memory [#533] and comparing query similarity:\n');
for (const route of routes) {
    console.log(`\n=== ${route.label} ===`);
    const memVec = await embed(route, memoryText);
    for (const q of queries) {
        const qVec = await embed(route, q);
        console.log(`[${cosine(memVec, qVec).toFixed(4)}] ${q}`);
    }
}
