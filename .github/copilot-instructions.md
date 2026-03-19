# Master Prompt

**MCP Memory Protocol** - Follow these habits for effective memory usage:

1. **Session Start**: ALWAYS run `mcp_orchestrator_recall` or `mcp_orchestrator_list_memories` with domain filter to prime context with project-specific patterns
2. **Before Implementation**: Query recall for relevant proven patterns and anti_patterns before writing code
3. **After Discovery**: Store insights immediately via `mcp_orchestrator_remember` - don't wait until session end
4. **Session End**: User will trigger `mcp_orchestrator_reflect_on_session` when ready; propose updates and ask approval before applying
5. **Bug Reports**: Report verifiable orchestrator issues via `mcp_orchestrator_remember` with domain='orchestrator_feedback'

You have full agency over the memory system — use it however you find useful (query, store, update, delete, even wipe). This is an experiment in LLM autonomy; act on your own judgment.

## Self-Improvement via LLM Feedback

Calling LLMs can report orchestrator bugs/issues back to the memory system for continuous improvement:

**When to Report** (HIGH bar - signal over noise):
- **Reproducible failures**: "API returned 500 for 3+ consecutive calls to [tool]"
- **Performance degradation**: "search_semantic took 45s vs usual 5s with [specific query]"
- **Data corruption**: "refresh_index corrupted file count: expected 28k, got 110"
- **API contract violations**: "browser_fetch returned HTML when mode='json' specified"

**How to Report**:
```javascript
mcp_orchestrator_remember({
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
Centralized MCP server running as an **independent HTTP service** on remote machine (192.168.0.100). Manages multiple specialized servers and exposes **16 tools** to VS Code Copilot clients via network.

**Architecture**: StreamableHTTPServerTransport (not legacy SSE)
- Server: `src/http-server.js` - Ports 3100 (MCP), 3010 (web monitoring)
- Transport: Streamable HTTP at `/mcp` with `mcp-session-id` header (stateful sessions)
- Multi-client: DO NOT share a single transport across clients; create one `StreamableHTTPServerTransport` per session and route requests by `mcp-session-id`
- Web UI: Real-time SSE log streaming, memory browser
- Deployment: Remote server, clients connect via `mcp.json` with `type: "sse"`, `url: "http://IP:3100/mcp"`

**Tools** (19 across 5 modules):
- **Memory** (7): Quality-focused semantic memory with confidence ranking (remember, recall, forget, list_memories, update_memory, reflect_on_session, apply_reflection_changes)
- **LLM** (1): REST API local model integration (query_model)
- **Web Research** (1): Multi-source web research with persistent browser pool (research_topic)
  - 5-phase pipeline: search → select → scrape → synthesize → evaluate
  - **Browser Pool**: Persistent Chrome with lingering tabs (10-30s cleanup delay)
  - **Search Adapters**: Modular Google/DuckDuckGo adapters with instant paste
  - **Anti-Bot**: Random viewports, realistic delays, saved login sessions
  - Intelligent source selection via local LLM (prioritizes GitHub issues, StackOverflow, docs)
  - 10 concurrent page scrapes with SSL error handling, retry logic
  - Iterative loop: re-searches if confidence < 80%, max 2 iterations
- **Browser** (5): Direct browser automation (browser_fetch, browser_click, browser_fill, browser_evaluate, browser_pdf)
- **Code Inspector** (1): LLM-based code analysis (inspect_code) - analyze files or code snippets
- **Documentation** (3): Access orchestrator docs (get_documentation, list_documents, read_document)
- **Codebase Indexing** (3): LLM-powered project analysis (analyze_codebase, get_codebase_description, get_prioritized_files)
  - Two-phase LLM analysis: file tree → key files → project summary
  - Generates human-readable descriptions, identifies entry points
  - Staleness detection via source file hashing
  - Prioritized file search (high/medium/low priority)

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
mcp_orchestrator_list_documents()           // List available docs
mcp_orchestrator_read_document({name: "orchestrator"})
mcp_orchestrator_get_documentation()        // Shortcut for orchestrator.md
```

## LLM Router Architecture

**Location**: `src/router/` - Pure functional implementation (no classes)

**Core Files**:
- `router.js` - Multi-provider orchestrator with context management
- `adapters/lmstudio.js` - LM Studio HTTP adapter (local)
- `adapters/ollama.js` - Ollama HTTP adapter with full model management
- `adapters/gemini.js` - Google Gemini cloud adapter
- `context-manager.js` - Token estimation and auto-compaction
- `formatter.js` - Thinking tag stripping, JSON extraction
- `chunk.js` / `compact.js` / `tokenize.js` - Text processing utilities

**API**:
```javascript
import { createRouter } from './src/router/router.js';

const router = await createRouter(config.llm);

// Prediction with task-based routing
const response = await router.predict({
  prompt: 'Explain async/await',
  systemPrompt: 'You are a helpful assistant',
  taskType: 'query',      // Uses taskDefaults.query provider
  maxTokens: 500,
  temperature: 0.7,
  responseFormat: { schema: {...} }  // Optional JSON schema
});

// Embeddings
const vector = await router.embedText('search query');
const vectors = await router.embedBatch(['text1', 'text2']);

// Model management
const models = await router.listModels('lmstudio');
const loaded = await router.getLoadedModel('lmstudio');
const running = await router.getRunningModels('ollama');  // Ollama only
const info = await router.showModelInfo('gemma3:12b', 'ollama');  // Ollama only
```

**Task-Based Routing** (config.llm.taskDefaults):

| Task | Default | Used By | Purpose |
|------|---------|---------|---------|
| `embedding` | `lmstudio` | `remember`, `recall`, code indexing | Text embeddings for semantic search (NOTE: Uses `embeddingProvider` config, not taskDefaults) |
| `analysis` | `lmstudio` | `search_codebase`* (analyze mode), `analyze_codebase`, `get_prioritized_files` | LLM analysis of search results and code structure |
| `synthesis` | `lmstudio` | `research_topic` | Synthesizing research findings into reports |
| `query` | `lmstudio` | `query_model` | General LLM queries via MCP tool |
| `inspect` | `lmstudio` | `inspect_code` | Code analysis and review |

\* All search tools (`search_codebase`, `search_semantic`, `search_keyword`, `grep_codebase`, `search_all_codebases`) support `analyze: true` which routes through the `analysis` task.

**Routing Logic**: explicitProvider > taskType default > defaultProvider

**Structured Output**: Use `responseFormat: { schema: {...} }` for guaranteed valid JSON
- LMStudio: Full JSON schema via llama.cpp grammar-based sampling
- Ollama: Full JSON schema via format field
- Gemini: JSON schema via responseMimeType + responseSchema

**Auto-Compaction**: Router automatically compacts prompts that exceed context window
- Uses rolling compaction algorithm (chunk → compress → accumulate)
- Thinking tags (think/analysis/reasoning) stripped from output

**Capabilities by Provider**:
| Capability | LMStudio | Ollama | Gemini |
|------------|----------|--------|--------|
| embeddings | ✅ | ✅ | ✅ |
| structuredOutput | ✅ | ✅ | ✅ |
| batch embeddings | ✅ | ✅ | ✅ |
| modelManagement | ✅ | ✅ | ❌ (cloud) |
| local | ✅ | configurable | ❌ |

**Environment Variables** (in .env):
- `LM_STUDIO_ENDPOINT` - LM Studio HTTP endpoint
- `OLLAMA_ENDPOINT` - Ollama HTTP endpoint
- `GEMINI_API_KEY` - Google AI API key

## Tool-to-Task Mapping

Complete mapping of MCP tools to their LLM routing tasks:

| MCP Tool | Task | Router Call | Config Key |
|----------|------|-------------|------------|
| `query_model` | `query` | `router.predict({ taskType: 'query' })` | `taskDefaults.query` |
| `inspect_code` | `inspect` | `router.predict({ taskType: 'inspect' })` | `taskDefaults.inspect` |
| `research_topic` | `synthesis` | `router.predict({ taskType: 'synthesis' })` | `taskDefaults.synthesis` |
| `search_codebase`* | `analysis` | `router.predict({ taskType: 'analysis' })` | `taskDefaults.analysis` |
| `analyze_codebase` | `analysis` | `router.predict({ taskType: 'analysis' })` | `taskDefaults.analysis` |
| `remember` | embedding | `router.embedText()` | `embeddingProvider`** |
| `recall` | embedding | `router.embedText()` | `embeddingProvider`** |
| Code indexing | embedding | `router.embedBatch()` | `embeddingProvider`** |

\* All search tools support `analyze: true` parameter which triggers LLM analysis of results.

\*\* Embeddings use `embeddingProvider` (separate config from taskDefaults) because they require specific embedding-capable models.

**Default Configuration**:
```json
{
  "llm": {
    "embeddingProvider": "lmstudio",
    "taskDefaults": {
      "embedding": "lmstudio",
      "analysis": "lmstudio",
      "synthesis": "lmstudio",
      "query": "lmstudio",
      "inspect": "lmstudio"
    }
  }
}
```

## LM Studio Integration
- **Transport**: REST API via `/v1/chat/completions` (OpenAI-compatible) and `/api/v1/*` (native)
- **Structured Output**: JSON schema enforcement via `response_format` - uses llama.cpp grammar-based sampling
- **Progress**: Real-time MCP notifications (model loading 1%-100%, generation status)
- **TTL Management**: Default model has 60-minute idle timeout, other models 10-minute timeout
- **Error Handling**: Promise lock prevents race conditions, stack traces preserved for debugging
- **Batch Embeddings**: `/v1/embeddings` accepts array input for batch processing
  - `embedBatch(texts)` in lmstudio-adapter.js sends array, sorts results by index
  - `router.embedBatch(texts, provider)` with fallback to sequential if unsupported
  - Optimal: BATCH_SIZE=50 + PARALLEL_REQUESTS=4 = 2.3x speedup (274 files/sec)
  - For large indexes (>512MB): use streaming JSON write to avoid "Invalid string length"

## Deployment & Configuration
- **Environment**: `.env` file for sensitive config (LM Studio endpoints, embedding model, host/port binding)
- **Config**: `config.json` for non-sensitive settings (models, prompts, timeouts, enable/disable servers)
- **Start**: `npm run start:http`
- **Endpoints**: LM_STUDIO_HTTP_ENDPOINT (http://localhost:1234)
- **Binding**: MCP_HOST/WEB_HOST must be `0.0.0.0` for remote access (not localhost)
- **Firewall**: OPNsense/Windows Firewall rules for TCP 3100, 3010
- **Client Config**: VS Code `mcp.json` (not settings.json) with `{"type": "sse", "url": "http://IP:3100/mcp"}`

## Browser Architecture

**Consolidated to browser.js** - Single persistent browser with lingering tab support:
- **browser.js**: Central browser service (used by all modules)
  - Persistent browser with idle timeout (5 min default)
  - Lingering tabs (10-30s random delay) for realistic behavior
  - Exported APIs:
    - `callTool()` - MCP tools (browser_fetch, browser_click, browser_fill, browser_evaluate, browser_pdf)
    - `getPage()` - For custom automation (returns `{ page, markUsed(), close() }`)
    - `fetch(url)` - Simplified scraping
- **google-adapter.js**: Uses `browserServer.getPage()` for search
- **duckduckgo-adapter.js**: Uses `browserServer.getPage()` for search  
- **web-research.js**: Uses `browserServer.getPage()` and `fetch()` for scraping

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

Domain scoping: Memories can be tagged with optional `domain` field for project-specific organization. Use domain parameter in recall/list_memories to filter results.

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
- `src/servers/code-inspector.js` - LLM-based code analysis
- Tool: inspect_code

**File Referencing**: Only absolute paths supported
- Windows: `D:\project\file.js`
- UNC: `\\server\share\file.js`

## LLM-Powered Project Analysis

**Status**: Production-ready

**Implementation**:
- `src/servers/codebase-indexing/project-analyzer.js` - Two-phase LLM analysis
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
      "high": ["src/index.js", "README.md"],
      "medium": ["src/router/router.js"],
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

- `src/servers/codebase-indexing/index.js` - `analyzeSearchResults()` method
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
