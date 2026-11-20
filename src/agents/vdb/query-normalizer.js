// Deterministic query spelling repair.
//
// R2 (2026-11-20): `AI Conciousness` returned arena material first in the dense
// lane and the retrieval-test document first in the lexical lane, while
// `AI Consciousness` and a paraphrase of the same intent both return
// `research/consciousness/…` at rank 1 with a 0.89 rerank score. The retrieval
// is fine; the query was one edit away from the corpus's own vocabulary.
//
// No inference and no expansion: the storage paths already contain the corpus's
// curated labels (`research/consciousness/…`, `blog/attic/consciousness.md`), so
// a token that is absent from that vocabulary but has exactly ONE neighbour at
// Damerau-Levenshtein distance 1 is corrected in place. Ambiguity is left alone
// — a wrong "correction" is worse than the typo.
//
// Measured cost on the real storage root: 1632 terms, 128 ms to build once,
// ~65 µs per token looked up.
const MIN_TOKEN_LENGTH = 6;
const MIN_TERM_OCCURRENCES = 2;
const QUERY_TOKEN = /[A-Za-z]+/g;
// A distance-1 neighbour that is a morphological variant is not a typo:
// `model`/`models` and `licensed`/`license` are both real words, and correcting
// them rewrites a valid query (measured 2026-11-20).
const INFLECTIONS = new Set(['s', 'es', 'ed', 'd', 'ing', 'ly', 'er', 'est']);

function tokensOf(text) {
    return text.toLowerCase().split(/[^a-z]+/).filter(token => token.length >= MIN_TOKEN_LENGTH);
}

function isInflection(a, b) {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (!long.startsWith(short)) return false;
    return INFLECTIONS.has(long.slice(short.length));
}

// True when a and b are at most one insertion, deletion, substitution or
// adjacent transposition apart. Returns early on the common prefixes.
function withinOneEdit(a, b) {
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0;
    while (i < la && i < lb && a[i] === b[i]) i++;
    if (la === lb) {
        if (a.slice(i + 1) === b.slice(i + 1)) return true;
        if (i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true;
        return false;
    }
    return la > lb
        ? a.slice(i + 1) === b.slice(i)
        : a.slice(i) === b.slice(i + 1);
}

export function buildVocabulary(relativePaths) {
    const counts = new Map();
    for (const relativePath of relativePaths) {
        for (const token of tokensOf(relativePath)) counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    const terms = new Set();
    const buckets = new Map();
    for (const [term, count] of counts) {
        // A token seen in one path only is usually a file artefact, not a word
        // the corpus uses — offering it as a correction target invites damage.
        if (count < MIN_TERM_OCCURRENCES) continue;
        terms.add(term);
        const key = `${term[0]}:${term.length}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(term);
        else buckets.set(key, [term]);
    }
    return { terms, buckets, builtAt: new Date().toISOString() };
}

// Pure: returns the corrected query plus the substitutions it made, so the
// caller can show them. A token already in the vocabulary is never touched.
export function correctQuery(query, vocabulary) {
    if (!vocabulary) throw new Error('correctQuery: vocabulary is required');
    if (typeof query !== 'string') throw new Error(`correctQuery: query must be a string (got ${typeof query})`);
    const corrections = [];
    const corrected = query.replace(QUERY_TOKEN, raw => {
        const token = raw.toLowerCase();
        if (vocabulary.terms.has(token)) return raw;
        const candidates = [];
        for (const length of [token.length - 1, token.length, token.length + 1]) {
            const bucket = vocabulary.buckets.get(`${token[0]}:${length}`);
            if (!bucket) continue;
            for (const term of bucket) {
                if (term === token || isInflection(token, term)) continue;
                if (withinOneEdit(token, term)) candidates.push(term);
                if (candidates.length > 1) return raw; // ambiguous — leave the typo
            }
        }
        if (candidates.length !== 1) return raw;
        corrections.push({ from: raw, to: candidates[0] });
        return candidates[0];
    });
    return { query: corrected, corrections };
}

export function describeCorrections(corrections) {
    return corrections.map(c => `${c.from} → ${c.to}`).join(', ');
}
