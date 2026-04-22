# Master Prompt

**MCP Memory Protocol** - You have full autonomy to manage memories without user prompting.

## Autonomous Memory Workflow

**Session Start** (automatic):
```javascript
mcp_orchestrator_memory_recall({ query: "current task context", domain: "project-name", limit: 10 })
```

**During Work** (proactive):
- Store insights immediately after discovery via `memory_remember`
- Query before implementation: `memory_recall({ category: "proven", query: "..." })`
- Check anti_patterns before trying approaches: `memory_recall({ category: "anti_patterns", ... })`

**Memory Maintenance** (self-directed):
- Update memories as understanding deepens: `memory_update({ id, text, category })`
- Delete obsolete/wrong memories: `memory_forget({ id })`
- Consolidate related memories periodically

**Categories**:
- `proven` - Evidence-backed solutions that work
- `anti_patterns` - Approaches that caused problems
- `hypotheses` - Untested ideas to validate
- `context` - Project facts and background
- `observed` - Behavioral patterns noticed

## Bug Reports to Memory

Report verifiable orchestrator issues autonomously:
```javascript
mcp_orchestrator_memory_remember({
  text: "Specific issue with reproducible context and suggested fix",
  category: "anti_patterns",
  domain: "orchestrator_feedback"
});
```

**Report**: Reproducible failures, performance degradation, data corruption, API violations
**Skip**: Subjective opinions, expected behavior, user errors, isolated failures

## Self-Improvement via LLM Feedback

Calling LLMs can report orchestrator bugs/issues back to the memory system for continuous improvement:

**When to Report** (HIGH bar - signal over noise):
- **Reproducible failures**: "API returned 500 for 3+ consecutive calls to [tool]"
- **Performance degradation**: "search_semantic took 45s vs usual 5s with [specific query]"
- **Data corruption**: "refresh_index corrupted file count: expected 28k, got 110"
- **API contract violations**: "browser_fetch returned HTML when mode='json' specified"

**How to Report**:
```javascript
mcp_orchestrator_memory_remember({
  text: "browser_fetch timeout: 30s limit insufficient for heavy pages. Example: research_topic failed on 3/10 pages during [session]. Suggest: Add timeout parameter or increase default to 60s.",
  category: "anti_patterns",
  domain: "orchestrator_feedback"
});
```

**Required Elements**:
- Specific tool/API that failed
- Reproducible context (query, parameters, session details)
- Impact (blocked task, degraded performance, wrong output)
- Suggested fix (if obvious)

**Do NOT Report**:
- Subjective opinions ("API is confusing")
- Expected behavior ("search returned 0 results" without context)
- User errors ("I called it wrong")
- Single isolated failures without pattern

**Review Process**: User or autonomous agents periodically query `domain="orchestrator_feedback"` memories to extract improvement tasks.

---

# MCP Server Orchestrator - Development Guidelines

## Project Overview

Centralized MCP server running as an **independent HTTP service**.

**Architecture**: Meta-MCP with nested agent modules
- Server: src/server.js - Port 3100 (MCP via custom SSE)
- Transport: Per-session SSE transport mapped by sessionId
- Gateway: Talks to central LLM Gateway at localhost:3400
- Agents: src/agents/ - (browser, codebase, docs, inspector, llm, memory, nui_docs, research, vision)

## File Referencing (Absolute Paths Only)

**IMPORTANT**: Only absolute file paths are supported in `inspect_code` and `query_model`.

**Valid formats**:
- Windows: `D:\Work\_GIT\Project\file.js`
- UNC: `\\server\share\file.js`

**Invalid formats** (removed):
- ❌ Hash IDs: `e8580ad5e276908e773ad9273e57e6c6`
- ❌ SPACE:path format: `COOLKID-Work:_GIT/file.js`
- ❌ Relative paths: `src/file.js`

## Documentation

Documentation is now in `mcp_documentation/` folder:
- `orchestrator.md` - Tools guide (main reference)
- `coding-philosophy.md` - Deterministic mind doc

Access via MCP tools:
```javascript
mcp_orchestrator_get_philosophy()           // ⚠️ START HERE - coding philosophy
mcp_orchestrator_get_orchestrator_doc()     // Full tools reference (35+ tools)
```

## Gateway Client Architecture

**Location**: `src/gateway-client.js` - WebSocket client to external LLM Gateway

The orchestrator connects to a central LLM Gateway (localhost:3400) for all LLM operations. The Gateway handles model providers (LM Studio, Ollama, Gemini) internally.

**Task-Based API** (Recommended):
```javascript
import { createGatewayClient } from './src/gateway-client.js';

const gateway = createGatewayClient(wsUrl, httpUrl);

// Chat with streaming support using tasks
const response = await gateway.chat({
  task: 'query',  // Gateway resolves model, prompt, temperature, etc.
  messages: [{ role: 'user', content: 'Hello' }],
  systemPrompt: 'You are helpful',  // Optional override
  maxTokens: 500,                    // Optional override
  temperature: 0.7,                  // Optional override
  responseFormat: { type: 'json_schema', ... },  // Optional structured output
  onDelta: (chunk, meta) => console.log(chunk),  // Streaming deltas
  onProgress: (phase, context) => console.log(phase)  // Progress notifications
});

// Prediction (adapter for old router API)
const result = await gateway.predict({
  prompt: 'Explain async/await',
  systemPrompt: '...',
  task: 'query',  // Gateway-managed task
  maxTokens: 500,
  temperature: 0.7,
  responseFormat: { schema: {...} }  // Returns parsed JSON if schema provided
});

// Embeddings (uses task='embed' automatically)
const vector = await gateway.embedText('search query');
const vectors = await gateway.embedBatch(['text1', 'text2', 'text3']);
```

**Available Tasks** (managed by Gateway):

| Task Key | Used By | Purpose |
|----------|---------|---------|
| `query` | `query_model` tool | General LLM queries |
| `inspect` | `inspect_code` tool | Code analysis |
| `synthesis` | `research_topic` | Research synthesis |
| `analysis` | `analyze_codebase`, `search_codebase` (with `analyze: true`) | Code analysis |
| `embed` | `memory_remember`, `memory_recall`, code indexing | Text embeddings |
| `vision` | `vision_analyze` | Image analysis |

**Note**: Model routing is now handled entirely by the Gateway. The `models` section in `config.json` has been removed. To change which model handles a task, update the Gateway's configuration instead.

## nIndexer Integration

**Location**: `src/agents/codebase/nindexer-client.js`

Codebase indexing uses a separate nIndexer service (WebSocket on port 3666) for vector search:
- Semantic code search via nDB vector database
- File structure indexing with metadata
- LLM-powered codebase analysis

**Config** (config.json):
```json
{
  "nIndexer": {
    "wsUrl": "ws://localhost:3666",
    "connectTimeout": 15000,
    "requestTimeout": 30000
  }
}
```

## Deployment & Configuration
- **Environment**: `.env` file for sensitive config (Gateway endpoints, host/port binding)
- **Config**: `config.json` for non-sensitive settings (models, nIndexer connection, agent options)
- **Start**: `npm start` (or `npm run dev` for watch mode)
- **Binding**: `HOST` in .env must be `0.0.0.0` for remote access (not localhost)
- **Client Config**: VS Code `mcp.json` with `{"type": "sse", "url": "http://IP:3100/sse"}` or `{"type": "http", "url": "http://IP:3100/mcp"}`

## Browser Architecture

**Consolidated to browser.js** - Single persistent browser with lingering tab support:
- **browser.js**: Central browser service (used by all modules)
  - Persistent browser with idle timeout (5 min default)
  - Lingering tabs (10-30s random delay) for realistic behavior
  - Exported APIs:
    - `browser_session_create/goto/click/fill/scroll/type/evaluate/content/metadata` - MCP browser tools
    - `browser_session_inspect/console/wait/list/close` - Session management tools
    - Supports: `text` / `html` / `markdown` / `screenshot` content modes
- **google-adapter.js**: Uses `browserServer.getPage()` for search
- **duckduckgo-adapter.js**: Uses `browserServer.getPage()` for search  
- **web-research.js**: Uses `browserServer.getPage()` and `fetch()` for scraping

## NUI Docs Agent

**Location**: `src/agents/nui_docs/`

Provides documentation access for the NUI (Native UI) web component library. Reads **dynamically** from the nui_wc2 git submodule's `docs/components.json` registry.

**Architecture**:
```
src/agents/nui_docs/
├── index.js          ← Wrapper (reads from submodule at runtime)
├── config.json       ← Tool definitions (unchanged)
└── nui_wc2/          ← git submodule → nui_wc2 repo
    ├── docs/components.json   ← Source of truth (auto-generated)
    ├── Playground/pages/      ← HTML documentation pages
    ├── NUI/css/nui-theme.css  ← CSS variables
    └── NUI/assets/material-icons-sprite.svg  ← Icons
```

**Tools**:
- `nui_list_components` - List all components, addons, and reference pages from registry
- `nui_get_component` - Get full documentation for a specific component or addon (LLM guide + code examples)
- `nui_get_guide` - Get guide documentation from reference pages (getting-started, architecture-patterns, etc.)
- `nui_get_reference` - Dynamic API reference cheat sheet (generated from registry)
- `nui_get_css_variables` - List all CSS variables from nui-theme.css (cached per commit)
- `nui_get_icons` - List all available icon names from material-icons-sprite.svg (cached per commit)

**Registry Schema** (`components.json`):
- `reg.components` — 25 core NUI components (e.g., nui-button, nui-dialog)
- `reg.addons` — 8 optional modules (e.g., nui-menu, nui-list, nui-lightbox)
- `reg.reference` — 8 documentation pages (e.g., getting-started, accessibility)
- `reg.setup` — Setup code snippets (minimal, FOUC prevention)
- `reg.api` — Root API, Components API, Utilities
- `reg.patterns` — data-action syntax, router contract
- `reg.events` — Component event reference

**Updating** (when NUI repo changes):
```bash
# 1. Pull latest submodule
cd src/agents/nui_docs/nui_wc2 && git pull origin main && cd ../../../..

# 2. Regenerate components.json (in NUI repo)
cd src/agents/nui_docs/nui_wc2 && node scripts/update-docs.js && cd ../../../..

# 3. Copy updated wrapper
cp src/agents/nui_docs/nui_wc2/scripts/mcp-server-mcp-wrapper.js src/agents/nui_docs/index.js

# 4. Restart mcp_server
```

**Usage**:
```javascript
// List all components, addons, reference pages
mcp_orchestrator_nui_list_components()

// Get component docs (works for core components AND addons)
mcp_orchestrator_nui_get_component({ component: "nui-button" })
mcp_orchestrator_nui_get_component({ component: "nui-list" })  // addon

// Get guide (from reference pages)
mcp_orchestrator_nui_get_guide({ topic: "getting-started" })
mcp_orchestrator_nui_get_guide({ topic: "accessibility" })

// Quick reference (dynamically generated from registry)
mcp_orchestrator_nui_get_reference()
```

**Troubleshooting**:
| Symptom | Cause | Fix |
|---------|-------|-----|
| "Failed to load component registry" | Submodule not initialized | `git submodule update --init nui_wc2` |
| "Documentation page not found" | Stale submodule | `git pull` in submodule directory |
| Tool returns empty/old data | `components.json` out of sync | Run `node scripts/update-docs.js` in NUI repo |

## Web Research Module

Major refactoring completed with significant reliability and performance improvements:

**Content Extraction Hardening:**
- **4-tier fallback strategy**: Readability → Semantic → Density → Raw fallback
- **Pre-cleaning**: Removes scripts/styles/nav before DOM parsing
- **Content validation**: Bot detection, link density checks, minimum length enforcement
- **Metadata extraction**: Multi-selector fallback for title, description, OG tags

**Search Adapter Fixes:**
- **Google**: Updated selectors (`.g`, `div[data-hveid]`, `.tF2Cxc`) + faster `domcontentloaded` wait
- **DuckDuckGo**: Direct URL `/?q=QUERY&ia=web` with data-testid selectors

**Performance Optimizations:**
- **Streaming research pipeline**: Scrape + synthesize concurrently, early termination when sufficient content found (3+ quality sources)
- **URL prioritization**: Docs > StackOverflow > GitHub > blogs (heuristic ranking, no LLM wait)
- **Dual-engine support**: Both Google and DuckDuckGo queried in parallel, deduplicated by URL

**Embedding Model Configuration:**
- All providers now have endpoint-specific embedding models (e.g., `LM_STUDIO_EMBEDDING_MODEL`, `GEMINI_EMBEDDING_MODEL`)
- **Recommended**: Use local embeddings (LM Studio/Ollama) for speed - cloud embeddings (Gemini) work but have network latency

## Memory System Philosophy
Memory exists to improve OUTPUT QUALITY, not store user preferences. Categories:
- **proven**: Evidence-backed approaches that produce good outcomes
- **anti_patterns**: Approaches that have caused problems
- **observed**: Behavioral patterns, may be promoted to proven
- **hypotheses**: Untested ideas
- **context**: Project facts, background info

Domain scoping: Memories can be tagged with optional `domain` field for project-specific organization. Use domain parameter in memory_recall/memory_list to filter results.

## Code Style & Philosophy
- **Language**: Vanilla JavaScript (ES modules) - NO TypeScript
- **Approach**: Lean, simple, fast code
- **Priority**: Performance and conciseness over readability/maintainability
- **Rationale**: Code is maintained by LLM, not humans
- **Style**: Minimal abstractions, direct implementations, no unnecessary complexity
- **Comments**: Avoid - code should be self-documenting
- **Hardening**: Use promise locks, validate inputs, proper error rollback, URL constructor for endpoints

## LLM-Optimized Code Design
Code should be **optimized for maintenance by LLMs**, not by humans. Human readability concerns are secondary. Prioritize patterns that LLMs handle well:

| LLM-Friendly | Avoid |
|--------------|-------|
| Clear function boundaries | Deep inheritance chains |
| Explicit state (visible mutations) | Hidden state in `this.*` properties |
| Flat structures | Deep hierarchies, decorator patterns |
| Minimal abstraction layers | Over-DRY code that scatters logic |
| Complete context in one place | Framework magic/conventions |

**What humans find "unreadable" (dense, compact, inline logic) is often easier for LLMs to reason about because it reduces indirection.** LLMs don't get tired reading long files - they prefer complete context over jumping between 10 files.

## Key Principles
- **Avoid OOP meta-state**: No classes with scattered `this.*` properties mixing data and behavior
- **Closures with state are fine**: Functions can capture and maintain local state - that's natural JS
- **Pass what's needed**: Don't reach for globals, but don't be religious about "pure functions"
- Use modern ES6+ features (async/await, destructuring, etc.)
- Keep functions small and focused
- Avoid over-engineering
- Inline code when it makes execution faster
- Minimal dependencies - build custom solutions over third-party libraries
- Preserve stack traces in errors, throw don't log
- Validate model IDs against available models before use
- When prompting local LLMs for structured output: ask the model how it wants to be prompted (meta-prompting)

## Code Inspector Architecture

**Status**: Production-ready LLM-based code analysis

**Implementation**:
- `src/agents/inspector/index.js` - LLM-based code analysis
- Tool: inspect_code

**File Referencing**: Only absolute paths supported
- Windows: `D:\project\file.js`
- UNC: `\\server\share\file.js`

## LLM-Powered Project Analysis

**Status**: Production-ready

**Implementation**:
- `src/agents/codebase/index.js` - Two-phase LLM analysis via nIndexer
- Phase 1: File tree analysis → key file selection (high/medium/low priority)
- Phase 2: Content analysis → project summary (description, purpose, tech stack)

**Integration with Indexing**:
- **Manual**: Call `analyze_codebase` tool after indexing
- **Auto on index**: Set `analyze: true` in `index_codebase` or `refresh_codebase`
- **list_codebases** now includes: `description`, `hasAnalysis`, `analysisStale`

**Key Features**:
- **Structured Output**: JSON schema enforcement for reliable parsing
- **Staleness Detection**: MD5 hashes of source files tracked, auto-detects outdated descriptions
- **Prioritized Search**: Files ranked by importance for better search relevance

**Web Interface** (`http://localhost:3010`):
- Codebases list shows description + "Analyzed"/"Analysis Stale" badges
- Double-click codebase for details overlay with full analysis
- "Analyze Project" button for unanalyzed codebases
- "Re-Analyze" button for re-triggering analysis
- "Analyze Selected" bulk action in list footer

**Storage** (in `metadata.json`):
```json
{
  "llmAnalysis": {
    "analyzedAt": "2026-02-17T20:00:00Z",
    "model": "qwen2.5-coder-14b",
    "description": "MCP orchestrator with semantic memory",
    "purpose": "Centralized MCP server managing AI tools...",
    "keyFiles": {
      "high": ["src/server.js", "README.md"],
      "medium": ["src/gateway-client.js"],
      "low": ["test/"]
    },
    "entryPoints": ["src/index.js"],
    "insights": {
      "architecture": "modular-mcp-server",
      "techStack": ["nodejs", "express", "ndb-vector-db"],
      "keyConcepts": ["embeddings", "mcp-tools"],
      "coreModules": ["memory", "web-research"]
    },
    "sourceHashes": { "README.md": "a1b2c3..." }
  }
}
```

**MCP Tools**:
- `index_codebase` - Add `analyze: true` to auto-analyze after indexing
- `refresh_codebase` - Add `analyze: true` to re-analyze if stale
- `analyze_codebase` - Manual analysis
- `get_codebase_description` - Get description with staleness check
- `get_prioritized_files` - Get files ordered by importance

**Web API Endpoints**:
- `GET /api/codebase/description?codebase={name}` - Get description
- `POST /api/codebase/analyze` - Trigger analysis `{name}`

**Precise Prompting Strategy**:
- Uses JSON schema via `responseFormat` parameter
- LMStudio/Ollama: llama.cpp grammar-based sampling
- Temperature 0.3 for deterministic results
- Clear rules in prompts (max file counts, priority definitions)

## Search Result Analysis (Token Cost Reduction)

**Status**: Production-ready

**Purpose**: Use the LOCAL LLM to pre-analyze search results before returning them. This gives you a structured summary ("Found X implementations using Y pattern") instead of 20+ raw code snippets. Saves tokens and gives faster insights.

### When to Use `analyze: true`

| ✅ USE IT | ❌ SKIP IT |
|-----------|------------|
| Exploring unknown codebases ("find how X is implemented") | You need exact line numbers for editing |
| Broad searches with many results (10+ files) | Feeding results into another automated tool |
| Initial research before diving deep | Very specific search with <5 results |
| Getting patterns across multiple projects | You want to see all raw matches |

### Basic Usage

```javascript
// 🔥 RECOMMENDED for exploration
mcp_orchestrator_search_all_codebases({
  query: "drag and drop file upload electron",
  strategy: "semantic",
  limit: 10,
  analyze: true           // ← AI summarizes results
})

// Returns:
// {
//   analysis: {
//     summary: "Found 5 implementations...",
//     keyFindings: ["Uses webUtils.getPathForFile()", ...],
//     relevantFiles: ["js/mixer/main.js - Drag handler", ...],
//     implementationPatterns: ["Event: dragover/drop", ...]
//   },
//   stats: { resultCount: 46, ... }
// }
```

### Include Raw Results Too

```javascript
// Get BOTH analysis and raw snippets
mcp_orchestrator_search_all_codebases({
  query: "drag and drop",
  analyze: true,
  includeRaw: true        // ← Analysis + raw results
})
```

Use this when you want the summary for quick understanding, but might need to drill into specific file content later.

### Token Savings

| Result Size | Raw Size | Analyzed | Savings |
|-------------|----------|----------|---------|
| Small (5-10 results) | ~2K chars | ~1.5K chars | 10-30% |
| Medium (15-25 results) | ~8K chars | ~3K chars | 50-70% |
| Large (30+ results) | ~20K chars | ~4K chars | 70-90% |

Savings increase with result count. Small searches see modest gains; large searches see dramatic reductions.

### How It Works

1. You call search with `analyze: true`
2. Search runs normally, gets raw results
3. Local LLM (on orchestrator server) analyzes results
4. You receive structured summary instead of raw snippets
5. **Time cost**: +1-2 seconds for LLM analysis

### Supported Tools

All search tools support `analyze`:
- `search_codebase` - Single codebase
- `search_semantic` - Semantic/conceptual search
- `search_keyword` - Keyword search
- `grep_codebase` - Regex search
- `search_all_codebases` - Cross-codebase (most useful!)

### Implementation Details

- `src/agents/codebase/index.js` - `analyzeSearchResults()` method
- Uses `taskType: 'analysis'` for routing to appropriate LLM
- 800 token limit, temperature 0.3 for consistent formatting
- Analysis happens server-side before response

### Testing

```bash
# Unit test (fast, mocks LLM)
node test/test-search-analysis-unit.js

# Integration test (requires running server)
node test/test-search-analysis-integration.js
```

## Search Tool Selection Guide

**Updated March 2026** - grep_codebase optimized, search_keyword now with content search

| Tool | Speed | Best For | Avoid When |
|------|-------|----------|------------|
| `search_keyword` | <50ms | Exact function/class names, fast lookups | Conceptual queries, fuzzy matching |
| `search_codebase` (hybrid) | <200ms | General search, combines semantic + keyword | You need exact line numbers |
| `search_semantic` | 100-300ms | "How is X implemented?", conceptual similarity | You need exact matches |
| `grep_codebase` | 1-3s | Regex patterns, stale index, exact line numbers | Simple name lookups (use keyword!) |

### Why grep_codebase is slower
- Spawns ripgrep process (fork/exec overhead)
- Scans filesystem live (no index)
- **NEW:** Now with result caching (60s TTL, fingerprint invalidation)
- **NEW:** Early termination when limit reached
- **NEW:** Multi-threaded ripgrep (`--threads 0`)

### grep_codebase Options (NEW)
```javascript
mcp_orchestrator_grep_codebase({
  codebase: "mcp_server",
  pattern: "handleRequest",
  regex: false,              // Literal string (faster)
  maxMatchesPerFile: 1,      // Find files only
  caseSensitive: false,
  pathPattern: "*.js",       // Filter by path
  noCache: false             // Force fresh search
})
```

### search_keyword Content Search (NEW)
Now searches both file paths AND content with indexed tokenization:
```javascript
mcp_orchestrator_search_keyword({
  codebase: "mcp_server",
  query: "handleFileUpload",
  searchContent: true        // Include line matches
})
// Returns: { file, path, rank, contentMatches: [{line, content}] }
```

## Historical Changes

### April 2026 - Task-Based Gateway API
- Migrated to Gateway's task-based query system
- Removed `models` section from `config.json` — Gateway is now ground truth for model routing
- All agents now use `task` parameter (`query`, `inspect`, `synthesis`, `analysis`, `vision`, `embed`) instead of explicit model names
- `gateway-client.js` simplified: no longer accepts `embedModel` or `models` parameters
- Embedding calls automatically use `task: 'embed'`
- `predict()` adapter updated: `taskType` → `task` parameter

### April 2026 - Architecture Simplification
- Removed local LLM Router (`src/router/`)
- Now uses external LLM Gateway exclusively via `src/gateway-client.js`
- Simplified model configuration in config.json
- Added nIndexer integration for codebase indexing (separate service on port 3666)

### March 2026 - Search Optimizations
- `grep_codebase`: Added result caching, early termination, multi-threading
- `grep_codebase`: New options `maxMatchesPerFile`, `caseSensitive`, `pathPattern`, `noCache`
- `search_keyword`: Added true content search with inverted index
- Tool descriptions updated to guide LLMs toward faster alternatives

### Feb 2026 - Code Search Removed
- Code Search module archived to `_Archive/code-search/`
- File referencing simplified to absolute paths only
- Removed hash IDs and SPACE:path format support
- Tool count: 30 → 16 (removed 14 code-search tools)

## Contributors
- **@herrbasan** - Initial architecture, LM Studio integration, memory system
- **GitHub Copilot (Claude Sonnet 4.5)** - Web research iterative refinement, anti-bot hardening
- **GitHub Copilot (Claude Opus 4.5)** - Local Agent and Code Search (now archived)
- **Kimi K 2.5 (Kimi Code CLI)** - Web research content extraction hardening, streaming research pipeline

## Useful Links
- x.ai Grok API Reference - https://docs.x.ai/developers/api-reference
- OpenAI API Reference - https://platform.openai.com/docs/api-reference/introduction
- LM Studio API Reference - https://lmstudio.ai/docs/developer/rest
- Ollama API Reference - https://docs.ollama.com/quickstart
- Gemini API Reference - https://ai.google.dev/gemini-api/docs#rest
