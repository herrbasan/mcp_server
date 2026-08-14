// Embed degradation evidence capture — 2026-08-14
// Chain: mcp_server -> gateway (/v1/embeddings, hardcoded proxy)
//        -> Fatten wrapper (192.168.0.145:4080, thin proxy)
//        -> llama-server (Qwen3-Embedding-4B)
// Tests: (A) determinism: same text embedded repeatedly
//        (B) duplicates: distinct texts in a batch

const URL = 'http://localhost:3400/v1/embeddings';
const HEADERS = { 'Content-Type': 'application/json', 'Authorization': 'Bearer someKey33!!' };

async function embed(input) {
    const res = await fetch(URL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ input }) });
    const j = await res.json();
    return j.data.map(d => d.embedding);
}
function cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb));
}

const SAME = 'The quick brown fox jumps over the lazy dog.';

// (A) Determinism: same text 5 times, sequential single calls
const reps = [];
for (let i = 0; i < 5; i++) {
    const e = await embed(SAME);
    reps.push(e[0]);
}
console.log('=== (A) DETERMINISM: same text embedded 5x ===');
for (let i = 1; i < reps.length; i++) {
    console.log(`  rep0 vs rep${i}: cosine = ${cosine(reps[0], reps[i]).toFixed(4)}  (expected ~1.0000 for a deterministic model)`);
}

// (B) Duplicates: distinct texts in one batch, 3 rounds
const DISTINCT = [
    'The quick brown fox jumps over the lazy dog.',
    'quantum physics and pizza recipes',
    'a recipe for homemade sourdough bread',
    'the capital of France is Paris',
    'machine learning model training on GPUs',
];
console.log('\n=== (B) DUPLICATES: 5 distinct texts in a batch, 3 rounds ===');
for (let round = 1; round <= 3; round++) {
    const embs = await embed(DISTINCT);
    let dupFound = false;
    const seen = [];
    for (let i = 0; i < embs.length; i++) {
        for (let j = i + 1; j < embs.length; j++) {
            const c = cosine(embs[i], embs[j]);
            if (c > 0.999) { console.log(`  round${round}: text[${i}] vs text[${j}] -> IDENTICAL (cosine ${c.toFixed(4)})`); dupFound = true; }
        }
    }
    if (!dupFound) console.log(`  round${round}: no duplicates detected in this batch`);
}
