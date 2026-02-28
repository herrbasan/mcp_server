# Research Cache Architecture Design

**Status:** Proposal  
**Author:** AI Assistant + User  
**Date:** 2026-02-28

---

## Overview

This document proposes a **Research Cache** system that stores scraped web pages from `research_topic` operations in a searchable, semantic database. This allows LLMs to:

1. Retrieve full documents from previous research sessions
2. Search across all cached research semantically
3. Avoid re-scraping the same URLs (cache-first lookup)
4. Build a persistent knowledge base over time

---

## Motivation

Currently, when `research_topic` completes:
- The synthesized report is returned
- Individual scraped pages are discarded
- URLs must be re-scraped for follow-up questions
- No way to "cite the source document" in detail

**Research Cache solves this by:**
- Storing full page content with vector embeddings
- Enabling semantic search across all previous research
- Providing TTL-based cleanup (auto-expire old research)
- Linking content to job IDs for traceability

---

## Architecture

### Storage Layout

```
data/
├── codebases/              # Existing code indexing
├── memories.json           # Existing memory system
└── research-cache/         # NEW: Research cache
    ├── research.db         # nDB vector database
    ├── metadata.json       # Job mappings, TTL tracking
    └── config.json         # Cache settings
```

### Data Schema

#### 1. Cached Document (stored in nDB)

```typescript
interface CachedDocument {
  // Unique identifier
  id: string;                    // URL hash (SHA-256)
  
  // Job linkage
  job_id: string;                // research_1772281373380_858fsfpiz
  query_id: string;              // Original search query
  
  // Source metadata
  url: string;                   // Full URL
  title: string;                 // Page title
  domain: string;                // bun.com
  scraped_at: number;            // Unix timestamp (ms)
  expires_at: number;            // TTL: +7 days default
  
  // Content
  content: string;               // Full extracted text
  content_vector: number[];      // 768-dim embedding
  content_hash: string;          // For change detection
  
  // Quality metrics
  source_quality: 'high' | 'medium' | 'low';
  extraction_method: 'readability' | 'semantic' | 'density' | 'raw';
  word_count: number;
  
  // Search metadata
  query_terms: string[];         // Stemmed terms from original query
  research_topics: string[];     // Tags extracted from content
}
```

#### 2. Job Metadata (stored in metadata.json)

```typescript
interface ResearchJob {
  job_id: string;
  query: string;
  created_at: number;
  completed_at?: number;
  status: 'running' | 'completed' | 'failed';
  document_count: number;
  urls: string[];                // List of cached URLs
  
  // Synthesis result (optional - if we want to cache this too)
  synthesis?: string;
  synthesis_vector?: number[];
}
```

---

## MCP Tools

### Existing Tools (Modified)

#### `research_topic`
**Changes:**
- Before scraping, check cache for existing URL (within TTL)
- Store each scraped page to nDB after extraction
- Update job metadata with document references

**New Parameters:**
```json
{
  "use_cache": true,           // Check cache before scraping
  "cache_ttl_days": 7,         // Override default TTL
  "store_in_cache": true       // Store results for later retrieval
}
```

---

### New Tools

#### 1. `search_research_cache`

Search across all cached research documents semantically.

**Input:**
```json
{
  "query": "bun SQLite performance",
  "top_k": 5,
  "filters": {
    "domain": "bun.com",
    "min_quality": "high",
    "after_date": "2026-01-01"
  }
}
```

**Output:**
```json
{
  "results": [
    {
      "url": "https://bun.com/blog/bun-v1.2",
      "title": "Bun 1.2 Blog Post",
      "excerpt": "SQLite is now 2.3x faster than better-sqlite3...",
      "relevance_score": 0.94,
      "scraped_at": "2026-02-28T10:23:45Z",
      "job_id": "research_1772281373380_858fsfpiz",
      "source_quality": "high"
    }
  ]
}
```

---

#### 2. `get_research_document`

Retrieve full content of a cached document by URL.

**Input:**
```json
{
  "url": "https://bun.com/blog/bun-v1.2",
  "job_id": "research_1772281373380_858fsfpiz"  // Optional: verify access
}
```

**Output:**
```json
{
  "url": "https://bun.com/blog/bun-v1.2",
  "title": "Bun 1.2 Blog Post",
  "content": "# Bun 1.2: Built-in PostgreSQL...",
  "scraped_at": "2026-02-28T10:23:45Z",
  "expires_at": "2026-03-07T10:23:45Z",
  "word_count": 3420
}
```

---

#### 3. `list_research_jobs`

List recent research jobs with summaries.

**Input:**
```json
{
  "limit": 10,
  "status": "completed"
}
```

**Output:**
```json
{
  "jobs": [
    {
      "job_id": "research_1772281373380_858fsfpiz",
      "query": "Bun 1.2 new features",
      "status": "completed",
      "created_at": "2026-02-28T10:23:45Z",
      "duration_seconds": 47,
      "document_count": 3,
      "has_synthesis": true
    }
  ]
}
```

---

## Workflow Examples

### Example 1: Follow-up Questions

```javascript
// First research
mcp_orchestrator_research_topic({
  query: "TYPO3 Fluid f:uri.action arguments"
});
// → Returns job_id

// Later, ask about specific detail
mcp_orchestrator_get_research_document({
  url: "https://docs.typo3.org/other/typo3/view-helper-reference/main/en-us/Global/Uri/Action.html"
});
// → Returns full page content with all arguments
```

### Example 2: Cross-Research Search

```javascript
// Search across ALL previous research
mcp_orchestrator_search_research_cache({
  query: "SQLite performance benchmarks"
});
// → Finds mentions from Bun 1.2, Node.js, Python, etc.
```

### Example 3: Cache-First Research

```javascript
// Research with cache checking
mcp_orchestrator_research_topic({
  query: "React 19 features",
  use_cache: true  // Skip scraping if URL in cache
});
// → If sources cached < 7 days, uses cache
// → Only scrapes new/updated URLs
```

---

## Configuration

```json
{
  "research_cache": {
    "enabled": true,
    "data_dir": "data/research-cache",
    "embedding_dimension": 768,
    "default_ttl_days": 7,
    "max_cache_size_mb": 500,
    
    "cleanup": {
      "enabled": true,
      "interval_hours": 24,
      "max_age_days": 30
    },
    
    "cache_behavior": {
      "check_on_research": true,
      "store_on_complete": true,
      "compress_content": true
    }
  }
}
```

---

## Storage Estimates

| Metric | Value |
|--------|-------|
| Per page (text) | ~50-100 KB |
| Per page (vector) | ~3 KB (768 × 4 bytes) |
| Per page (total) | ~100 KB |
| 10 pages × 100 jobs | ~100 MB |
| Annual (1000 jobs) | ~1 GB |

**Cleanup keeps this bounded** - old research auto-expires.

---

## TTL Strategy

| Content Type | Default TTL | Rationale |
|--------------|-------------|-----------|
| Documentation | 30 days | Changes infrequently |
| Blog posts | 7 days | May have updates |
| News articles | 3 days | Time-sensitive |
| GitHub repos | 14 days | Active development |
| StackOverflow | 30 days | Stable answers |

---

## Implementation Phases

### Phase 1: Basic Storage
- Create `ResearchCache` class
- Modify `WebResearchServer` to store pages
- Add `get_research_document` tool

### Phase 2: Semantic Search
- Add `search_research_cache` tool
- Implement vector similarity search
- Add metadata indexing

### Phase 3: Cache-First
- Check cache before scraping
- Implement content change detection (hash)
- Add cache hit/miss metrics

### Phase 4: Advanced Features
- Cross-research synthesis
- Knowledge graph extraction
- Duplicate detection across jobs

---

## Open Questions

1. **Multi-user support?**
   - Current: Single-user, shared cache
   - Future: User isolation, private vs public research

2. **Content compression?**
   - Gzip content to save ~70% space?
   - Trade-off: CPU vs storage

3. **Offline mode?**
   - Allow research without internet if cache hit?
   - Partial results from cache?

4. **Export capability?**
   - Export research as markdown/PDF?
   - Share research bundles?

---

## Related Work

- **Codebase Indexing** (`src/servers/codebase-indexing/`)
  - Uses same nDB + embedding approach
  - Can share embedding provider config
  
- **Memory System** (`src/servers/memory.js`)
  - Semantic memory for user preferences
  - Research cache is semantic memory for web content

---

## Next Steps

1. ✅ This design document approved
2. Create `ResearchCache` class stub
3. Integrate with `WebResearchServer`
4. Add new MCP tools
5. Test with real research workflows
6. Measure cache hit rates

---

## Appendix: Code Structure

```
src/
├── servers/
│   ├── web-research.js           # Modified: store to cache
│   └── research-cache/           # NEW directory
│       ├── index.js              # Main cache service
│       ├── document-store.js     # nDB operations
│       ├── job-manager.js        # Job metadata
│       └── search.js             # Semantic search
└── lib/
    └── nDB/                      # Existing (reused)
```
