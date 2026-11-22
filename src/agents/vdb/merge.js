// Rank-preserving merge across collections.
//
// A single-collection result must come back exactly as `nvdb serve` ordered it.
// When several collections are queried together their rows have to be
// interleaved WITHOUT ever breaking one collection's internal order: the
// collection itself is the only component that sees both lanes and the
// cross-encoder together, so re-sorting its rows by a raw score (the former
// `b.rerankScore - a.rerankScore` merge) inverts winners the collection had
// already ranked correctly (Agents_Prime.md regression, 2026-11-22).
//
// Reciprocal-rank weighting is per-collection confidence, not per-row rank:
//   mergeScore = 1 / (5 + rank) * (0.35 + 0.65 * collectionStrength)
// Strength comes from the collection's best cross-encoder score, so a weak
// collection contributes late rather than not at all.

function assertCollectionEntry(entry, index) {
    if (!entry || typeof entry !== 'object') {
        throw new TypeError(`perCollectionResults[${index}] must be an object (got ${entry === null ? 'null' : typeof entry})`);
    }
    if (typeof entry.collection !== 'string' || !entry.collection) {
        throw new TypeError(`perCollectionResults[${index}].collection must be a non-empty string`);
    }
    if (!Array.isArray(entry.rows)) {
        throw new TypeError(`perCollectionResults[${index}].rows must be an array (collection "${entry.collection}")`);
    }
    if (typeof entry.rejected !== 'boolean') {
        throw new TypeError(`perCollectionResults[${index}].rejected must be a boolean (collection "${entry.collection}")`);
    }
}

function collStrength(entry) {
    const raw = entry.bestRerankScore ?? 0;
    return Math.max(0, Math.min(1, raw));
}

export function mergeCollectionResults(perCollectionResults, { topK, rerankActive } = {}) {
    if (!Array.isArray(perCollectionResults)) {
        throw new TypeError(`perCollectionResults must be an array (got ${perCollectionResults === null ? 'null' : typeof perCollectionResults})`);
    }
    if (!Number.isInteger(topK) || topK < 1) {
        throw new Error(`topK must be an integer >= 1 (got ${String(topK)})`);
    }
    if (typeof rerankActive !== 'boolean') {
        throw new TypeError(`rerankActive must be a boolean (got ${rerankActive === null ? 'null' : typeof rerankActive})`);
    }

    for (const [index, entry] of perCollectionResults.entries()) assertCollectionEntry(entry, index);

    if (perCollectionResults.length === 0) return [];
    if (perCollectionResults.length === 1) return perCollectionResults[0].rows.slice(0, topK);

    const accepted = perCollectionResults.filter(c => !c.rejected && c.rows.length > 0);
    // A rejected collection is noise next to a real match: drop it entirely.
    // When every collection was rejected the rows stay, so the caller's
    // relevance assessment still sees the evidence that produced the rejection.
    const active = accepted.length > 0
        ? accepted
        : perCollectionResults.filter(c => c.rows.length > 0);

    if (active.length === 0) return [];
    if (active.length === 1) return active[0].rows.slice(0, topK);

    const merged = [];
    for (const entry of active) {
        const strength = rerankActive ? collStrength(entry) : 0;
        const weight = rerankActive ? 0.35 + 0.65 * strength : 1;
        entry.rows.forEach((row, idx) => {
            const rank = idx + 1;
            merged.push({ row, rank, strength, mergeScore: (1 / (5 + rank)) * weight });
        });
    }

    merged.sort((a, b) => {
        if (b.mergeScore !== a.mergeScore) return b.mergeScore - a.mergeScore;
        if (rerankActive) {
            if (b.strength !== a.strength) return b.strength - a.strength;
            if (a.rank !== b.rank) return a.rank - b.rank;
            return (b.row.rerankScore ?? 0) - (a.row.rerankScore ?? 0);
        }
        return (b.row.rrfScore ?? 0) - (a.row.rrfScore ?? 0);
    });

    return merged.slice(0, topK).map(entry => entry.row);
}
