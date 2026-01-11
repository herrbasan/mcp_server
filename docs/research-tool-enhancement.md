# Web Research Tool Enhancement Strategy

## Current State (Jan 11, 2026)
- Basic query enhancement implemented (technical term wrapping, context keywords)
- Successfully disambiguates "Virtual DOM" from "Virtual Regatta" 
- Single-pass: search → LLM selects sources → scrape → synthesize
- Location: `src/servers/web-research.js`

## Problem
Search quality depends on manual query preprocessing. No iterative refinement, no intelligent content extraction, limited source evaluation.

## Vision: Multi-Stage Intelligent Research Pipeline

### Stage 0: Query Preparation (Calling LLM)
**Goal**: Leverage calling LLM's contextual intelligence before execution

- New tool: `prepare_research_query(user_query, context?)`
- Input: Raw user question + optional context (conversation history, domain)
- Output: 3-5 optimized search variants with reasoning
- Examples:
  - "Virtual DOM" → ["Virtual DOM React performance", "Virtual DOM vs Shadow DOM", "Virtual DOM reconciliation algorithm"]
  - "Best practices X" → ["X performance optimization", "X security patterns", "X scalability"]
- User reviews/approves before execution
- Calling LLM uses domain knowledge, conversation context, technical vocabulary

### Stage 1: Smart Search Execution
**Goal**: Domain-aware query routing and result scoring

**Query Routing**:
```javascript
// Technical queries
if (isTechnical(query)) {
  query += " site:stackoverflow.com OR site:github.com OR site:dev.to"
}
// Academic
if (isAcademic(query)) {
  query += " site:.edu OR site:.org filetype:pdf"
}
// News/current events
if (isNews(query)) {
  query += " after:2025-01-01" // recency filter
}
```

**Result Scoring**:
- Boost known authoritative domains (MDN, official docs, peer-reviewed)
- De-rank marketing/SEO spam (detect patterns)
- Diversity: Prefer sources from different domains

### Stage 2: Intelligent Source Selection (Iterative)
**Goal**: Two-phase selection with link following

**Phase 1 - Fast Preview**:
```javascript
// For each search result (top 20)
const preview = await fetchFirst500Chars(url);
const candidates = {url, title, snippet, preview};
```

**Phase 2 - LLM Ranking**:
```javascript
const prompt = `
Rank these sources by relevance to: "${query}"
For top 3, identify:
1. Relevance score (0-10)
2. Information gaps: What's missing?
3. Follow-up links: Extract URLs mentioned that might be better sources
`;
```

**Phase 3 - Link Following**:
- Extract referenced URLs from top sources
- Add to candidate pool (limit: +5 per iteration)
- Track visited URLs to avoid duplicates

### Stage 3: Smart Content Extraction
**Goal**: Extract only relevant content, not entire pages

**Readability Filtering**:
```javascript
// Remove noise
const cleaned = removeNavAdsFooter(html);
const readable = extractMainContent(cleaned); // Algorithm: Mozilla Readability
```

**LLM-Guided Extraction**:
```javascript
const prompt = `
From this page about "${query}", extract:
1. Sections directly answering the question
2. Code examples
3. Benchmark data
4. Contradictory viewpoints
Ignore: ads, navigation, related articles
`;
```

**Chunking Strategy**:
- For large pages: Extract headings first
- LLM identifies relevant sections
- Fetch only those chunks (don't scrape entire page)

### Stage 4: Iterative Refinement Loop
**Goal**: Self-evaluation and follow-up queries

**After Initial Synthesis**:
```javascript
const evaluation = await llm(`
Based on this synthesis:
${initialReport}

Self-evaluate:
1. What questions remain unanswered?
2. Are there contradictions needing more sources?
3. Which claims lack verification?
4. Confidence level (0-100%)

If confidence < 80%, suggest 2 follow-up queries.
`);

if (evaluation.confidence < 80 && iteration < 2) {
  // Execute follow-up queries
  // Merge with existing synthesis
}
```

**Loop Constraints**:
- Max iterations: 2 (prevents runaway)
- Track: visited URLs, answered questions, remaining gaps
- Each iteration narrows focus (don't repeat same searches)

## Implementation Phases

### Phase 1: Query Preparation Tool (Week 1)
- Add `prepare_research_query` to expose search strategy to calling LLM
- Allows review before execution
- Low risk, high value

### Phase 2: Smart Search Routing (Week 2)
- Domain detection (technical/academic/news)
- Site filters and recency
- Result deduplication

### Phase 3: Content Extraction (Week 3)
- Integrate Readability algorithm
- LLM-guided section extraction
- Chunking for large pages

### Phase 4: Iterative Loop (Week 4)
- Self-evaluation prompt
- Follow-up query generation
- Synthesis merging

### Phase 5: Source Selection Enhancement (Week 5)
- Two-phase preview + ranking
- Link following from authoritative sources
- Visited URL tracking

## Technical Considerations

**Performance**:
- Parallel scraping (current: sequential)
- Cache scraped content (avoid re-fetching)
- Timeout per iteration (don't exceed total timeout)

**LLM Usage**:
- Stage 0: Calling LLM (cheap - uses conversation context)
- Stages 2-4: Local LLM (expensive - multiple calls)
- Budget token usage: estimate before execution

**Error Handling**:
- Graceful degradation: If Stage 2 fails, fall back to Stage 1 results
- Scrape failures: Continue with successful sources
- LLM timeouts: Use partial results

## Success Metrics

- **Relevance**: % of sources directly answering query (target: >80%)
- **Depth**: Average content quality score (LLM-evaluated)
- **Coverage**: % of user questions answered (target: >90%)
- **Efficiency**: Time to first useful result (<30s)
- **Iteration rate**: % of queries requiring follow-up (target: <30%)

## Next Steps

1. **Review this architecture** - discuss trade-offs
2. **Prototype Stage 0** - validate query preparation improves results
3. **A/B test** - compare old vs new pipeline on sample queries
4. **Iterate** - measure metrics, tune prompts, adjust limits

---

**Original Insight** (User):
> "Firstly instruct you (the calling LLM) to describe well what to search for. Then instruct the researching LLM well how to collect meaningful references. Then instruct the LLM well how to determine the relevant bits of a page, and allow it to collect further URLs to potentially better sources. I imagine this a bit like an improvement loop (with limits)."

This architecture implements that vision: calling LLM → research LLM → extraction LLM → evaluation loop.
