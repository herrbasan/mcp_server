// Per-request selection of the retrieval layers.
//
// The config defines the defaults; one request may switch a layer off (or tune
// a knob) to A/B the layers against each other. Resolution is pure and strict:
// an unknown key, an out-of-range value, an impossible combination, or a layer
// the bound index cannot serve is an error that names the problem. A request
// never silently runs a different search than the one it asked for.
//
// The layers are the four things that actually change the ranking:
//   dense      vector lane (needs the query embedding)
//   lexical    BM25 lane over the index's lexical fields
//   diversity  per-document cap inside the native call
//   rerank     ONNX cross-encoder over the fused shortlist

const BOOLEAN_KEYS = ['dense', 'lexical', 'diversity', 'rerank'];

const NUMBER_KEYS = {
    rrfK: { min: 1, integer: true },
    candidateK: { min: 1, integer: true },
    vectorWeight: { min: 0 },
    lexicalWeight: { min: 0 },
    maxPerDocument: { min: 1, integer: true },
    shortlist: { min: 1, integer: true },
    rerankWeight: { min: 0, max: 1 }
};

export const SEARCH_KEYS = [...BOOLEAN_KEYS, ...Object.keys(NUMBER_KEYS)];

function assertBoolean(key, value) {
    if (typeof value !== 'boolean') throw new Error(`search.${key} must be a boolean (got ${value === null ? 'null' : typeof value})`);
    return value;
}

function assertNumber(key, value, rule) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`search.${key} must be a finite number (got ${value === null ? 'null' : typeof value})`);
    }
    if (rule.integer && !Number.isInteger(value)) throw new Error(`search.${key} must be an integer (got ${value})`);
    if (value < rule.min) throw new Error(`search.${key} must be >= ${rule.min} (got ${value})`);
    if (rule.max !== undefined && value > rule.max) throw new Error(`search.${key} must be <= ${rule.max} (got ${value})`);
    return value;
}

export function resolveSearchOptions({ overrides = null, hybrid, rerank, rerankerAvailable, diversityField }) {
    if (!hybrid || hybrid.enabled !== true) {
        throw new Error('per-request layers need agents.vdb.hybrid.enabled — the bound index is vector-only');
    }
    if (overrides !== null && overrides !== undefined) {
        if (typeof overrides !== 'object' || Array.isArray(overrides)) {
            throw new Error(`search must be an object (got ${Array.isArray(overrides) ? 'array' : typeof overrides})`);
        }
        for (const key of Object.keys(overrides)) {
            if (!SEARCH_KEYS.includes(key)) {
                throw new Error(`search: unknown key "${key}". Allowed: ${SEARCH_KEYS.join(', ')}`);
            }
        }
    }

    const resolved = {
        dense: true,
        lexical: true,
        diversity: Boolean(diversityField),
        rerank: Boolean(rerankerAvailable && rerank?.enabled),
        rrfK: hybrid.rrfK,
        candidateK: hybrid.candidateK,
        vectorWeight: hybrid.vectorWeight,
        lexicalWeight: hybrid.lexicalWeight,
        maxPerDocument: hybrid.maxPerDocument,
        shortlist: rerank?.shortlist,
        rerankWeight: rerank?.weight,
        rerankTextField: rerank?.textField,
        diversityField: diversityField ?? null
    };

    for (const key of BOOLEAN_KEYS) {
        if (overrides?.[key] !== undefined) resolved[key] = assertBoolean(key, overrides[key]);
    }
    for (const [key, rule] of Object.entries(NUMBER_KEYS)) {
        if (overrides?.[key] !== undefined) resolved[key] = assertNumber(key, overrides[key], rule);
    }

    if (!resolved.dense && !resolved.lexical) {
        throw new Error('search: dense and lexical cannot both be off — there would be no lane to search');
    }
    if (resolved.dense && resolved.vectorWeight === 0) {
        throw new Error('search: vectorWeight is 0 while dense is on — turn the dense layer off instead');
    }
    if (resolved.lexical && resolved.lexicalWeight === 0) {
        throw new Error('search: lexicalWeight is 0 while lexical is on — turn the lexical layer off instead');
    }
    if (resolved.diversity && !resolved.diversityField) {
        throw new Error('search: the diversity layer is on but this collection has no group field configured');
    }
    if (resolved.rerank && !rerankerAvailable) {
        throw new Error(rerank?.enabled
            ? 'search: rerank is on but nvdb serve has no reranker loaded — start nvdb serve with --reranker-model'
            : 'search: rerank is on but agents.vdb.rerank.enabled is false');
    }
    return resolved;
}

// Compact, stable description for the tool output: an A/B run must be
// attributable from the transcript alone.
export function describeSearchOptions(options) {
    const layers = [
        options.dense && 'dense',
        options.lexical && 'lexical',
        options.diversity && 'diversity',
        options.rerank && 'rerank'
    ].filter(Boolean);
    return `layers=${layers.join('+')} rrfK=${options.rrfK} candidateK=${options.candidateK} v=${options.vectorWeight} l=${options.lexicalWeight}`
        + (options.diversity ? ` mpd=${options.maxPerDocument}` : '')
        + (options.rerank ? ` short=${options.shortlist} w=${options.rerankWeight}` : '');
}
