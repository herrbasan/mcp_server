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

### Phase 1: Query Preparation Tool ✅ COMPLETE (Jan 11, 2026)
- Implemented `prepare_research_query` (backpocket - not exposed)
- Guardrails configuration added
- Updated `research_topic` description to guide calling LLM on query formulation
- Calling LLM naturally optimizes queries using conversation context
- Low risk, high value

### Phase 2: Smart Search Routing - SKIPPED
**Rationale**: Auto-modification of user queries is presumptuous. The calling LLM already knows search syntax (`site:`, recency filters, quotes) and will use it when appropriate. No need to second-guess.

**Alternative**: Could provide search syntax reference in tool description, but "if you know it, you know it already."

### Phase 3: Content Extraction (CURRENT)
**Goal**: Extract only relevant content, dramatically reduce noise

**Current Problems**:
- Still contains: ads, cookie banners, related articles, comments sections
- No section awareness (can't extract just "Performance" section from long article)
- Wastes local LLM tokens on irrelevant content
- Large pages truncated arbitrarily at 12MB limit
- Simple tag stripping misses complex layouts

**Solutions**:
1. **Readability Filtering** - Use Mozilla Readability algorithm or equivalent
   - Strips boilerplate: nav, ads, footers, sidebars
   - Identifies main article content using heuristics
   - Preserves structure (headings, code blocks, lists)

2. **Section-Aware Extraction** - Parse document structure before full scrape
   - Extract heading hierarchy (h1, h2, h3)
   - Let LLM identify relevant sections based on query
   - Fetch only those sections (don't scrape entire page)
   - Example: "Performance" section from 50-section tutorial

3. **Smart Chunking** - Split large content intelligently
   - Preserve sentence boundaries (not arbitrary character cuts)
   - Keep code blocks intact
   - Maintain context with small overlaps between chunks

**Expected Impact**:
- 70-80% noise reduction per page
- Faster LLM synthesis (fewer tokens)
- More relevant extractions (section targeting)
- Better handling of documentation sites with deep structure

### Phase 4: Iterative Loop (Week 4) - FUTURE
- Self-evaluation prompt
- Follow-up query generation  
- Synthesis merging

### Phase 5: Source Selection Enhancement (Week 5) - FUTURE
- Two-phase preview + ranking
- Link following from authoritative sources
- Visited URL tracking

## Technical Considerations

**Reliability Guardrails** (Local-First Focus):
- **Hard timeouts**: 30s total pipeline, 5s per web scrape, 10s per LLM call
- **Iteration caps**: Max 2 refinement loops (prevent runaway)
- **Memory limits**: Max 10MB per scraped page, cleanup after each stage
- **State tracking**: Visited URLs set, answered questions list (prevent duplicates)
- **Resource monitoring**: Watch local LLM load, queue requests if busy
- **Connection health**: Auto-reconnect to LM Studio on failures

**Performance** (Not Cost-Related):
- Parallel scraping with limit (max 5 concurrent to avoid overwhelming network)
- Cache scraped content (avoid re-fetching, saves time not money)
- Token window management: chunk content to fit local LLM context limits

**LLM Usage** (All Local):
- Stage 0: Calling LLM (GitHub Copilot - uses conversation context)
- Stages 2-4: Local LLM via LM Studio (limit concurrent calls to 1)
- Context window: respect model limits, chunk large content

**Error Handling**:
- Graceful degradation: If Stage 2 fails, fall back to Stage 1 results
- Scrape failures: Continue with successful sources (don't abort pipeline)
- LLM timeouts: Return partial results with confidence score
- WebSocket errors: Auto-reconnect and retry (implemented Jan 11)

## Success Metrics

**Quality**:
- **Relevance**: % of sources directly answering query (target: >80%)
- **Depth**: Average content quality score (LLM-evaluated)
- **Coverage**: % of user questions answered (target: >90%)

**Reliability** (Local Focus):
- **Completion rate**: % of pipelines that complete without errors (target: >95%)
- **Timeout handling**: % of timed-out stages that return partial results (target: 100%)
- **Reconnection success**: % of LM Studio disconnects that auto-recover (target: >99%)
- **Memory stability**: No pipeline should exceed 100MB total memory

**Performance**:
- **Time to first result**: <30s for simple queries, <60s with refinement
- **Iteration efficiency**: % of queries requiring follow-up (target: <30%)
- **Parallel utilization**: Web scraping should use 3-5 concurrent connections

## Local-First Implementation Notes

**LM Studio Integration**:
- Use WebSocket connection with auto-reconnect (implemented Jan 11)
- Serialize LLM calls (no concurrent requests to avoid overload)
- Respect model's configured memory/GPU settings (don't override)
- Monitor connection health before each stage

**Resource Management**:
- Track memory per pipeline, cleanup scraped content after synthesis
- Limit concurrent web scrapes to 5 (avoid network saturation)
- Use streaming where possible (don't load entire pages into memory)
- Implement graceful shutdown (cleanup in-progress pipelines)

**Guardrails Configuration**:
```javascript
const PIPELINE_LIMITS = {
  totalTimeout: 60000,        // 60s total
  scrapeTimeout: 5000,        // 5s per page
  llmTimeout: 10000,          // 10s per LLM call
  maxIterations: 2,           // refinement loops
  maxSources: 10,             // pages to scrape
  maxMemoryPerPage: 10485760, // 10MB
  concurrentScrapes: 5
};
```

## Next Steps

1. **Review this architecture** - discuss trade-offs
2. **Prototype Stage 0** - validate query preparation improves results
3. **Test reliability** - simulate LM Studio restarts, network failures, timeouts
4. **Measure metrics** - track completion rate, memory usage, reconnection success
5. **Iterate** - tune prompts, adjust guardrail limits based on real usage

---

**Original Insight** (User):
> "Firstly instruct you (the calling LLM) to describe well what to search for. Then instruct the researching LLM well how to collect meaningful references. Then instruct the LLM well how to determine the relevant bits of a page, and allow it to collect further URLs to potentially better sources. I imagine this a bit like an improvement loop (with limits)."

This architecture implements that vision: calling LLM → research LLM → extraction LLM → evaluation loop.
