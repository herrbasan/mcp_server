// Refined determinism analysis: is it "first-call anomaly" or "truly random"?
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
const S = 'The quick brown fox jumps over the lazy dog.';
// 6 sequential single calls
const v = [];
for (let i = 0; i < 6; i++) v.push((await embed(S))[0]);
console.log('=== pairwise cosine, same text, 6 sequential single calls ===');
for (let i = 0; i < v.length; i++) {
    const row = [];
    for (let j = 0; j < v.length; j++) row.push(i === j ? '1.000' : cosine(v[i], v[j]).toFixed(3));
    console.log('  ' + row.join('  '));
}
