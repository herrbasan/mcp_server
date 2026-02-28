/**
 * Search Router - Coordinates semantic and keyword search
 * 
 * Currently a thin wrapper since:
 * - Semantic search: handled by nDB
 * - Keyword search: handled by SQLite FTS5
 * - Hybrid ranking: combines both scores
 */

export class SearchRouter {
  /**
   * Combine semantic and keyword results
   * 
   * Scoring:
   * - Semantic score: 0-1 from nDB (higher is better)
   * - Keyword score: 0-1 from FTS5 rank (converted)
   * - Combined: weighted sum (default 0.7 semantic, 0.3 keyword)
   */
  combineResults(semanticResults, keywordResults, weights = { semantic: 0.7, keyword: 0.3 }) {
    const scores = new Map();

    // Normalize semantic scores (already 0-1)
    for (const r of semanticResults) {
      scores.set(r.path, { semantic: r.score, keyword: 0, data: r });
    }

    // Normalize keyword scores (FTS5 rank is negative, lower is better)
    if (keywordResults.length > 0) {
      const maxRank = Math.max(...keywordResults.map(r => Math.abs(r.rank)));
      for (const r of keywordResults) {
        const normalized = maxRank > 0 ? 1 - (Math.abs(r.rank) / maxRank) : 0;
        const existing = scores.get(r.path);
        if (existing) {
          existing.keyword = normalized;
        } else {
          scores.set(r.path, { semantic: 0, keyword: normalized, data: { path: r.path } });
        }
      }
    }

    // Calculate combined scores
    const combined = [];
    for (const [path, scores_data] of scores) {
      const combinedScore = 
        scores_data.semantic * weights.semantic +
        scores_data.keyword * weights.keyword;
      
      combined.push({
        ...scores_data.data,
        score: combinedScore,
        semanticScore: scores_data.semantic,
        keywordScore: scores_data.keyword
      });
    }

    // Sort by combined score
    combined.sort((a, b) => b.score - a.score);

    return combined;
  }

  /**
   * Apply post-filters to results
   */
  filterResults(results, filters) {
    return results.filter(r => {
      if (filters.language && r.language !== filters.language) return false;
      if (filters.pathPattern && !r.path.includes(filters.pathPattern)) return false;
      if (filters.minScore && r.score < filters.minScore) return false;
      return true;
    });
  }
}
