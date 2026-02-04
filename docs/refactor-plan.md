# Router & Server Refactor Progress

## Current Status (Feb 4, 2026)

### ✅ Router Implementation - COMPLETE

All 6 phases completed with full test coverage:

| Phase | Status | Details |
|-------|--------|---------|
| 1. Tokenization Layer | ✅ Done | `/v1/tokenize` wrapper, caching |
| 2. Chunking Logic | ✅ Done | Token-boundary splitting |
| 3. Rolling Compaction | ✅ Done | Chunk + Summary → NewSummary loop |
| 4. Assembly & Validation | ✅ Done | Recursive compaction if needed |
| 5. Error Hardening | ✅ Done | Retry logic, graceful degradation |
| 6. Multi-Provider Support | ✅ Done | LMStudio, Ollama, Gemini adapters |

**Test Results:**
- LMStudio adapter: 6/6 ✅
- Ollama adapter: 10/10 ✅
- Gemini adapter: 8/8 ✅
- Router integration: 7/7 ✅

### ✅ Server Module Migration - COMPLETE (Partial)

Most servers refactored from class-based to functional pattern:

| Server | Status | Notes |
|--------|--------|-------|
| llm.js (was lm-studio.js) | ✅ Done | Factory function, 3 tools (Feb 3) |
| memory.js | ✅ Done | Factory function, 7 tools + prompts (Feb 4) |
| code-search.js | ✅ Done | Reorganized with indexer.js, 9 tools (Feb 4) |
| local-agent.js | ✅ Done | Factory function, 3 tools (Jan 2026) |
| browser.js | ✅ Done | Closure-based, lingering tabs, 5 tools + APIs (Feb 4) |
| web-research.js | ✅ Done | Router structured output, browser.js integration (Feb 4) |

**Browser Architecture Consolidation** (Feb 4):
- browser.js is now the central service with lingering tab support
- browser-pool.js deprecated (fully merged)
- All modules use browser.js:
  - web-research.js → `getPage()` and `fetch()`
  - google-adapter.js → `getPage()`
  - duckduckgo-adapter.js → `getPage()`

### 🎯 Code Search Enhancements - COMPLETE (Feb 4)

**File ID System:**
- ✅ 32-char SHA256 hash-based file IDs (collision-free for 50K+ files)
- ✅ Centralized indexer.js with generateFileId, parseFile, walkWorkspace
- ✅ All search tools return hash IDs: `fc745a690e4db10279c18241a0a572c7`
- ✅ retrieve_file accepts hash IDs
- ✅ All 3 workspaces rebuilt (50,618 files total)
- ✅ Cryptographic integrity verified (SHA256 of workspace:path matches stored ID)

**In-Memory Caching:**
- ✅ Index cache with reload-after-maintenance pattern
- ✅ Auto-reload on refreshIndex completion
- ✅ Manual control via clearCache/reloadIndex functions
- ✅ ~900MB total footprint (0.7% of 128GB RAM)
- ✅ Performance: 100-200ms first load → 5-10ms cached (20-40x faster)

---

## Core Design Principles

**Avoid OOP meta-state:**
- No classes with `this.x`, `this.y` scattered properties
- Don't mix data and behavior in class structures
- Closures with local state are fine - that's natural JS

**Self-contained tasks:**
- Keep tasks as self-contained as possible
- Enables focused optimization without side effects
- Pass what's needed, don't reach for globals

**Prefer specialized over generalized:**
- Simple code can be duplicated - don't force abstraction
- Avoid helpers with switches/flags for different behaviors
- Clarity > DRY when DRY adds complexity

**No JSDoc, minimal comments:**
- Function names and parameters are self-documenting
- Only comment non-obvious design decisions ("why" not "what")
- LLM reads code better than comments

---

---

## Completed: Router Architecture

```
src/
  router/
    router.js              # Multi-provider orchestrator (193 lines)
    adapters/
      lmstudio.js          # LM Studio HTTP adapter (137 lines)
      ollama.js            # Ollama HTTP adapter (173 lines)
      gemini.js            # Gemini cloud adapter (120 lines)
    context-manager.js     # Token estimation, auto-compaction
    formatter.js           # Thinking tag stripping, JSON extraction
    chunk.js               # Chunking logic
    compact.js             # Compaction engine
    tokenize.js            # Token counting
    README.md              # Consolidated documentation
```

**Router API:**
```javascript
const router = await createRouter(config.llm);

// Prediction with task-based routing
await router.predict({ prompt, systemPrompt, taskType, maxTokens, responseFormat });

// Embeddings
await router.embedText(text, provider);
await router.embedBatch(texts, provider);

// Model management
await router.listModels(provider);
await router.getLoadedModel(provider);
await router.getRunningModels(provider);  // Ollama only
```

---

## Current Focus: Server Migration

### Completed: llm.js

Refactored from class-based `LMStudioServer` to functional `createLLMServer`:

**Before (lm-studio.js):**
```javascript
export class LMStudioServer {
  constructor(config, llmRouter) {
    this.config = config;
    this.router = llmRouter;
  }
  async _query(prompt, ...) {
    return this.router.predict({ ... });
  }
}
```

**After (llm.js):**
```javascript
export function createLLMServer(config, router) {
  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    async callTool(name, args) {
      if (name === 'query_model') return await queryModel(router, config, args);
      // ...
    }
  };
}
```

**Changes:**
- Factory function instead of class
- No `this.*` - pure functions with closure
- Config key: `servers['llm']` (was `servers['lm-studio']`)
- Removed `get_second_opinion` (replaced by `inspect_code`)
- Resource URI: `llm://models`

### Completed: memory.js

Refactored from class-based `MemoryServer` to functional `createMemoryServer`:

**Changes:**
- Factory function returning object with methods
- Pure helper functions: `chunkText`, `extractDomain`, `cosineSimilarity`, `loadMemories`, `saveMemories`, `getEmbedding`
- Tool handlers as closures accessing shared state (memories, storePath, maxChars, progressCallback)
- All 7 tools working: remember, recall, forget, list_memories, update_memory, reflect_on_session, apply_reflection_changes
- Prompts support maintained: `getPrompts()`, `handlesPrompt()`, `getPrompt()`
- No `this.*` references - uses closure state and function parameters

### Completed: code-search.js

Major reorganization and enhancement (Feb 4):

**Module Structure:**
- `src/servers/code-search/indexer.js` (178 lines) - Centralized utilities
  - `generateFileId(workspace, filePath)` - SHA256 hash generation
  - `parseFile`, `walkWorkspace`, `detectLanguage`, `generateEmbeddingText`
  - `writeIndexStreaming`, `atomicWriteIndex`, `loadIndex`
- `src/servers/code-search/server.js` (820 lines) - MCP server with 9 tools
- `src/servers/code-search/build-index.js` (286 lines) - CLI indexing tool

**File ID System:**
- Hash-based IDs replace "workspace:path" string format
- 32-character SHA256 hash of `${workspace}:${filePath}`
- Collision-free for 50K+ files
- All search tools return hash IDs
- retrieve_file accepts both hash IDs and legacy format (backward compatible)

**Performance Enhancements:**
- In-memory index caching (Map-based)
- Auto-reload after refreshIndex/refreshAllIndexes
- Cache management: `clearCache()`, `reloadIndex(workspace)`
- ~900MB memory footprint for all 3 workspaces (0.7% of 128GB RAM)
- Search performance: 100-200ms (disk) → 5-10ms (cached, 20-40x faster)

**Workspaces Indexed:**
- COOLKID-Work: 21,717 files (284 MB index)
- BADKID-DEV: 28,110 files (613 MB index)
- BADKID-SRV: 791 files (4 MB index)
- Total: 50,618 files across all workspaces

### Migration Complete - Next Steps

4/6 servers migrated to functional pattern. Infrastructure mostly complete:

**Optional Migrations (Low Priority):**
- web-research.js - Complex, 1014 lines, works correctly as class
- browser.js - Simple, 588 lines, persistent browser state works well as class

Both servers function correctly and aren't causing issues. Migration would be for consistency only.

---

## Reference: Router Compaction Algorithm

### The Problem
Data exceeds context window → Router must compact it intelligently while preserving maximum information.

### The Solution: Rolling Compaction (✅ Implemented)

**Given:**
- Context window: Auto-detected from provider API
- System prompt: Variable
- Output buffer: 30% of context window
- **Available for data: Calculated dynamically**

**Strategy:**
1. **Tokenize** - Estimate token count
2. **If fits** → send directly
3. **If overflow** → Rolling compaction (chunk → compress → accumulate)

---

## Archived: Original Implementation Phases

> These phases are complete. Kept for historical reference.

### Phase 1: Tokenization Layer ✅ COMPLETE
Build reliable token counting with proper error handling.

**Deliverables:**
- Tokenize wrapper using `/v1/tokenize` endpoint
- Token count for: system_prompt, data, combined
- Cache model tokenizer to avoid redundant calls
- Error handling: "Tokenization failed: [reason]"

**Acceptance criteria:**
- Can count tokens for any text reliably
- Handles network errors gracefully
- Fast enough for production (< 100ms for typical inputs)

---

### Phase 2: Chunking Logic
Split large data into processable pieces.

**Deliverables:**
- Calculate safe chunk size based on context window
- Split at token boundaries (not character/mid-token)
- Progress updates: "Splitting 120k tokens into 3 chunks..."

---

### Phase 3: Rolling Compaction Engine
The core compression loop.

**Deliverables:**
- Compaction system prompt (configurable, task-aware)
- Sequential processing: Chunk + PreviousSummary → NewSummary
- Validate each step (summary smaller than input)
- Progress: "Compacting chunk 2/3... (summary: 850 tokens)"

---

### Phase 4: Assembly & Validation ✅ COMPLETE

### Phase 5: Error Hardening ✅ COMPLETE

### Phase 6: Multi-Provider Support ✅ COMPLETE (Added)

---

## Archived: Test Planning

> Router tests now live in `test/` directory:
> - `test-llm-router.js` - Router integration
> - `test-ollama.js` - Ollama adapter
> - (Gemini tests inline in development)

---

## Future Steps

All core infrastructure complete. Potential enhancements:

1. **Index Optimization**
   - Incremental embedding updates (only changed files)
   - Streaming JSON write for indexes >512MB (already implemented)
   - Background index refresh scheduling

2. **Search Enhancements**
   - Hybrid search (semantic + keyword fusion)
   - File content preview in search results
   - Multi-workspace search (search across all workspaces)

3. **Agent Improvements**
   - Better tool calling format detection
   - Improved loop detection and planning
   - Cost tracking and token budgets

4. **Memory System**
   - Domain-scoped recall optimization
   - Confidence decay over time
   - Memory export/import for backup

5. **Performance**
   - Batch embedding optimization (currently 50 texts × 4 parallel = 2.3x speedup)
   - Index compression (gzip storage)
   - Query result caching

---

## History

- **Feb 2, 2026**: Initial plan created, Phase 1 started
- **Feb 3, 2026**: All 6 router phases complete, 3 adapters (LMStudio, Ollama, Gemini)
- **Feb 3, 2026**: Server migration started - llm.js complete
- **Feb 4, 2026**: memory.js complete - 2/6 servers migrated
- **Feb 4, 2026**: code-search.js reorganized - file ID system + in-memory caching implemented
- **Feb 4, 2026**: Server migration status: 4/6 migrated (web-research.js and browser.js remain class-based)