# LLM-Powered Project Analysis Enhancement

## Overview

Enhance the codebase indexing system with intelligent LLM analysis that generates project descriptions and identifies key files for improved search relevance.

## Motivation

Current embeddings capture file-level semantics but lose high-level project context:
- Embeddings dilute symbol names in large files
- No understanding of project architecture or entry points
- Search returns results without prioritization
- Users can't quickly understand what a codebase does

## Proposed Solution

Two-phase LLM analysis triggered during indexing:

### Phase 1: File Tree Analysis
**Input:** Directory structure (file paths only)
**Output:** Prioritized file selection

The LLM analyzes the tree and categorizes files:
```json
{
  "keyFiles": {
    "high": ["src/index.js", "README.md", "AGENTS.md"],
    "medium": ["src/router/router.js", "package.json"],
    "low": ["tests/", "docs/", "examples/"]
  },
  "entryPoints": ["src/index.js", "src/http-server.js"],
  "exclude": ["node_modules/", "dist/", ".git/"]
}
```

### Phase 2: Content Analysis
**Input:** Content of selected high-priority files
**Output:** Structured project summary

```json
{
  "description": "MCP orchestrator with semantic memory, web research, and code inspection",
  "purpose": "Centralized MCP server managing multiple AI tools via HTTP",
  "architecture": "modular-mcp-server",
  "techStack": ["nodejs", "express", "ndb-vector-db", "puppeteer"],
  "keyConcepts": ["mcp-tools", "embeddings", "browser-automation"],
  "coreModules": ["memory", "web-research", "codebase-indexing"]
}
```

## Data Storage

Stored in `metadata.json` alongside existing fields:

```json
{
  "name": "mcp_server",
  "source": "d:\\DEV\\mcp_server",
  "fileCount": 164,
  "llmAnalysis": {
    "analyzedAt": "2026-02-17T20:00:00Z",
    "model": "qwen2.5-coder-14b",
    "version": "1",
    
    "description": "MCP orchestrator...",
    "purpose": "Centralized MCP server...",
    
    "keyFiles": {
      "high": ["src/index.js", "README.md"],
      "medium": ["src/router/router.js"],
      "low": ["tests/"]
    },
    
    "insights": {
      "architecture": "modular-mcp-server",
      "techStack": ["nodejs", "express"],
      "entryPoints": ["src/index.js"],
      "coreModules": ["memory", "web-research"]
    }
  }
}
```

## Benefits

### 1. Human-Readable Descriptions
Users see "MCP orchestrator with semantic memory" instead of guessing from file counts.

### 2. Prioritized Search Results
Grep/search can prioritize `keyFiles.high` over test files:
```javascript
// Search order: high → medium → low
const results = [
  ...grep(highPriorityFiles),
  ...grep(mediumPriorityFiles),
  ...grep(remainingFiles)
];
```

### 3. Faster Search
Skip 80% of files (tests, docs) initially; only expand if no results found.

### 4. Staleness Detection
Track file hashes of analyzed sources:
```json
"sourceHashes": {
  "README.md": "a1b2c3...",
  "package.json": "d4e5f6..."
}
```

Compare on refresh to detect if description is outdated.

## Implementation Options

### Option A: Local LLM (Recommended for Start)
- **Model:** qwen2.5-coder-14b (14B params)
- **Cost:** Free (local inference)
- **Time:** 5-10 seconds per codebase
- **Context:** ~4K tokens (file tree + selected files)

### Option B: Cloud LLM (For Large Projects)
- **Model:** Grok (2M context)
- **Cost:** $1-3 per analysis
- **Time:** 30-60 seconds
- **Context:** Full codebase in one shot

### Option C: Hybrid (Smart Routing)
```javascript
if (totalLines < 10000) {
  useLocalModel();  // Fast, free
} else {
  useGrok();  // Comprehensive
}
```

## UI Integration

### Codebase List View
```
┌─ mcp_server ───────────────────────┐
│ 164 files | Indexed: 2h ago         │
│                                     │
│ MCP orchestrator with semantic      │
│ memory, web research, and code      │
│ inspection tools.                   │
│ ⚠️ Description may be outdated      │
│                                     │
│ [Rebuild Index] [Refresh Desc]      │
└─────────────────────────────────────┘
```

### Search Enhancement
When searching "router":
1. **First:** Search `keyFiles.high` (entry points)
2. **Then:** Expand to medium/low priority
3. **Show:** "Related to core module: router"

## Trigger Points

| Trigger | When | Pros/Cons |
|---------|------|-----------|
| **Auto on index** | After initial indexing | Always fresh; adds delay |
| **Manual button** | User clicks "Analyze" | On-demand; user might forget |
| **Maintenance** | During periodic refresh | Background; complexity |
| **Staleness detect** | Key files changed | Smart; requires hash tracking |

**Recommendation:** Start with **Manual** + **Staleness indicator**, add **Auto** later.

## Future Enhancements

### Query Understanding
Use LLM insights to improve search:
```
User: "find the router"
→ LLM knows "router" = core module
→ Prioritize src/router/
→ Suggest related: "See also: src/web/server.js"
```

### Multi-Project Relationships
Track cross-project dependencies:
```json
"relationships": {
  "dependsOn": ["nui_wc2"],
  "usedBy": ["internal-tools"]
}
```

### Change Summaries
On incremental refresh, generate:
```
"Added auth module, refactored router, +45 files"
```

## Considerations

### Privacy
- Local LLM: No data leaves machine
- Cloud LLM: File names/content sent to API

### Cost (Cloud)
- Local: $0
- Grok: ~$1-3 per large codebase
- Rate limits may apply

### Failure Modes
- LLM picks wrong entry point → Manual override needed
- Analysis times out → Fallback to basic description
- API unavailable → Queue for retry

## Success Metrics

- [ ] Descriptions are accurate (human review)
- [ ] Search relevance improves (faster to find)
- [ ] Users actually read/use descriptions
- [ ] Staleness detection catches >80% of major changes

## Next Steps

1. Implement local LLM version with tree → selection → summary
2. Add UI for displaying descriptions
3. Add "Refresh Description" button
4. Implement hash tracking for staleness
5. Measure search improvement
6. Consider cloud LLM for large projects
