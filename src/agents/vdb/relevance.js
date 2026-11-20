// Separating rank position from actual relevance.
//
// Rank position is not confidence: the first row of a nonsense query is still
// "rank 1", and the previous display called that 100%. The only calibrated
// relevance signal in the funnel is the cross-encoder score — measured on the
// real corpus (2026-11-20):
//
//   nonsense (1–4 token)        0.0001 … 0.0089
//   weakest verified real match 0.0453   (German storage paraphrase)
//   typical real match          0.62 … 0.995
//
// Dense cosine is useless here (~0.43–0.76 for noise AND for real matches) and
// BM25 is worse than useless as a gate (`radiator` scored 31.7 on an unrelated
// document). Weak single-token queries overlap real paraphrases (memory `set`
// 0.160 vs German legit 0.139), so a floor cannot separate them either — it
// must not try. What a floor CAN do is separate nonsense, which is what this
// gate does, with the margin measured on both sides.
export const RELEVANCE_FLOOR_DEFAULT = 0.02;

export function resolveRelevanceFloor(value) {
    if (value === undefined || value === null) return RELEVANCE_FLOOR_DEFAULT;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
        throw new Error(`agents.vdb.relevanceFloor must be a number in (0, 1) (got ${String(value)})`);
    }
    return value;
}

// `rows` are search results carrying `rerankScore` (null beyond the rerank
// shortlist). Without a reranker there is no calibrated signal, so absence of
// relevance is reported, never guessed.
export function assessRelevance(rows, { rerankActive, floor }) {
    if (!rerankActive) {
        return { rerankActive: false, floor, best: null, rejected: false, scoredCount: 0 };
    }
    const scores = rows
        .map(row => row.rerankScore)
        .filter(score => typeof score === 'number' && Number.isFinite(score));
    const best = scores.length > 0 ? Math.max(...scores) : 0;
    return { rerankActive: true, floor, best, rejected: best < floor, scoredCount: scores.length };
}

// Display form: relevance when measured, never a rank position.
export function formatRelevance(score) {
    return typeof score === 'number' && Number.isFinite(score) ? `${(score * 100).toFixed(1)}%` : 'n/a';
}
