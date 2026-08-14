// Test: does the first-call anomaly cause batch duplicates?
// Send the SAME batch of 5 distinct texts 3x sequentially.
// Report within-batch duplicates AND cross-batch consistency per item.
const URL = 'http://localhost:3400/v1/embeddings';
const HEADERS = { 'Content-Type': 'application/json', 'Authorization': 'Bearer someKey33!!' };
async function embed(input) {
    const r = await fetch(URL, { method: 'POST', headers: HEADERS, body: JSON.stringify({ input }) });
    const j = await r.json();
    return j.data.map(d => d.embedding);
}
function cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb));
}
const TEXTS = [
    'The quick brown fox jumps over the lazy dog.',
    'quantum physics and pizza recipes',
    'a recipe for homemade sourdough bread',
    'the capital of France is Paris',
    'machine learning model training on GPUs',
];
const rounds = [];
for (let r = 0; r < 3; r++) rounds.push(await embed(TEXTS));

console.log('=== within-batch duplicates (cosine>0.999) ===');
for (let r = 0; r < rounds.length; r++) {
    let found = false;
    for (let i = 0; i < rounds[r].length; i++)
        for (let j = i + 1; j < rounds[r].length; j++)
            if (cosine(rounds[r][i], rounds[r][j]) > 0.999) { console.log(`  round${r}: text[${i}] vs text[${j}] identical`); found = true; }
    if (!found) console.log(`  round${r}: no duplicates`);
}
console.log('=== cross-batch determinism (each text vs its counterpart in round0) ===');
for (let i = 0; i < TEXTS.length; i++) {
    const c1 = cosine(rounds[0][i], rounds[1][i]);
    const c2 = cosine(rounds[0][i], rounds[2][i]);
    console.log(`  text[${i}]: r0vsR1=${c1.toFixed(3)} r0vsR2=${c2.toFixed(3)}`);
}
