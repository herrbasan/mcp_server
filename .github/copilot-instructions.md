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

Keep it minimal-dependency and performance-first. For any non-trivial pattern/library, explain what problem it solves here and why it's worth it.

# MCP Server Orchestrator - Development Guidelines

## Project Overview
Centralized MCP server running as an **independent HTTP service** on remote machine (192.168.0.100). Manages multiple specialized servers and exposes **26 tools** to VS Code Copilot clients via network.

**Architecture**: StreamableHTTPServerTransport (not legacy SSE)
- Server: `src/http-server.js` - Ports 3100 (MCP), 3010 (web monitoring)
- Transport: Streamable HTTP at `/mcp` with `mcp-session-id` header (stateful sessions)
- Multi-client: DO NOT share a single transport across clients; create one `StreamableHTTPServerTransport` per session and route requests by `mcp-session-id`
- Web UI: Real-time SSE log streaming, memory browser
- Deployment: Remote server, clients connect via `mcp.json` with `type: "sse"`, `url: "http://IP:3100/mcp"`

**Tools** (26 across 6 modules):
- **Memory** (7): Quality-focused semantic memory with confidence ranking (remember, recall, forget, list_memories, update_memory, reflect_on_session, apply_reflection_changes)
- **LM Studio** (3): REST API local model integration (query_model, list_available_models, get_loaded_model)
- **Web Research** (1): Multi-source web research with persistent browser pool (research_topic)
  - 5-phase pipeline: search → select → scrape → synthesize → evaluate
  - **Browser Pool**: Persistent Chrome with lingering tabs (10-30s cleanup delay)
  - **Search Adapters**: Modular Google/DuckDuckGo adapters with instant paste
  - **Anti-Bot**: Random viewports, realistic delays, saved login sessions
  - Intelligent source selection via local LLM (prioritizes GitHub issues, StackOverflow, docs)
  - 10 concurrent page scrapes with SSL error handling, retry logic
  - Iterative loop: re-searches if confidence < 80%, max 2 iterations
  - **Known Issues**: research_topic currently failing with "No content could be synthesized from available sources" error (Feb 5, 2026) - may be issue with search adapters, scraping, or synthesis step
- **Browser** (5): Direct browser automation (browser_fetch, browser_click, browser_fill, browser_evaluate, browser_pdf)
- **Local Agent** (3): Autonomous code analysis with UNC file access (run_local_agent, retrieve_file, inspect_code)
- **Code Search** (9): Semantic search for large codebases (get_workspace_config, get_file_info, refresh_index, refresh_all_indexes, get_index_stats, search_files, search_keyword, search_semantic, search_code)

## Workspace Architecture (For LLMs Using MCP Orchestrator)

**YOU ARE A CALLING LLM** - You don't see local files. Use MCP tools to interact with codebases.

**Core Utilities**:
- `src/lib/workspace.js` - UNC path mapping, security validation (shared by Local Agent and Code Search)

### Quick Start Workflow
```
1. get_workspace_config()           → Discover available workspaces
2. search_semantic/keyword/files()  → Find relevant code
3. get_file_info({ file: "..." })   → Get metadata (functions, classes, imports)
4. retrieve_file({ file: "..." })   → Get file content using file ID from search
```

**Get File Metadata** - After search, get detailed structure before retrieving content:
```javascript
get_file_info({ 
  file: "fc745a690e4db10279c18241a0a572c7"  // Hash ID from search results
})
// Returns: workspace, path, functions (with line numbers), classes, imports, exports
```

**Partial File Retrieval** - For large files, retrieve only the lines you need:
```javascript
retrieve_file({ 
  file: "fc745a690e4db10279c18241a0a572c7",
  startLine: 100,   // Optional: start line (1-indexed)
  endLine: 200      // Optional: end line (1-indexed)
})
// Returns lines 100-200 instead of entire file (saves tokens!)
```

**Complete Workflow Example**:
```javascript
// 1. Search finds file with hash IDs
const results = search_semantic({ workspace: "BADKID-DEV", query: "HTTP request handling" });
// Returns: { file: "fc745a690e4db10279c18241a0a572c7", functions: ["handleRequest"], ... }

// 2. Get detailed metadata with line numbers
const info = get_file_info({ file: "fc745a690e4db10279c18241a0a572c7" });
// Returns: { workspace: "BADKID-DEV", path: "src/http-server.js", functions: [{ name: "handleRequest", line: 45 }], ... }

// 3. Retrieve just the function you need
const content = retrieve_file({ 
  file: "fc745a690e4db10279c18241a0a572c7",
  startLine: 45,
  endLine: 80
});
```

### Workspace Model
Workspaces are named identifiers mapped to UNC network paths. You don't need to know the actual paths - just use workspace names.

**Available Workspaces**:
- `COOLKID-Work` - Main work projects
- `BADKID-DEV` - Development projects (contains mcp_server)
- `BADKID-SRV` - Server/service projects

### File ID Format
All search results return **32-character SHA256 hash IDs** (collision-free):
- Format: `fc745a690e4db10279c18241a0a572c7`
- Generated from: SHA256(`${workspace}:${filePath}`).slice(0, 32)
- Pass hash IDs directly to `retrieve_file` and `get_file_info`

### Search Tools (use workspace name, not paths)

| Tool | Use For | Returns | Example |
|------|---------|---------|---------|
| `search_semantic` | Find by meaning | Files with similarity scores + **functions/classes arrays** | `{ workspace: "BADKID-DEV", query: "HTTP request handling" }` |
| `search_keyword` | Exact text/regex | File matches | `{ workspace: "BADKID-DEV", pattern: "StreamableHTTP" }` |
| `search_files` | Glob patterns | File paths | `{ workspace: "BADKID-DEV", glob: "src/**/*.js" }` |
| `search_code` | Combined search | Enriched results | `{ workspace: "BADKID-DEV", query: "authentication" }` |
| `get_file_info` | Detailed metadata | **Functions/classes with line numbers**, imports, exports | `{ file: "fc745a690e4db10279c18241a0a572c7" }` |

**Key Feature**: `search_semantic` and `get_file_info` both return function/class names, but `get_file_info` includes **line numbers** for precise partial retrieval.

### Agent Delegation
For complex analysis, delegate to local LLM agent:
```javascript
run_local_agent({
  workspace: "BADKID-DEV",
  task: "Explain the HTTP server architecture"
})
// Agent explores autonomously, returns summary only (saves your context)
```

### Index Management
```javascript
refresh_index({ workspace: "BADKID-DEV" })      // Update single workspace
refresh_all_indexes()                            // Update all workspaces
get_index_stats({ workspace: "BADKID-DEV" })    // Check index health
```

**Index Files**: Located at `data/indexes/{workspace}.json`
**Index Caching**: In-memory cache with auto-reload after maintenance (refresh_index/refresh_all_indexes)
- ~900MB footprint for all 3 workspaces (0.7% of 128GB RAM)
- Performance: 100-200ms first load → 5-10ms cached (20-40x faster)
- Cache management: `clearCache()`, `reloadIndex(workspace)` functions available

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
- `embedding` → lmstudio (local, fast, nomic-embed-text-v2-moe 768-dim)
- `analysis` → gemini (source selection, credibility)
- `synthesis` → gemini (multi-source synthesis)
- `query` → gemini (query_model tool)
- `agent` → lmstudio (local agent with structured output)

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

## Browser Architecture (Feb 4, 2026)

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
- **Deprecated**: browser-pool.js (fully merged into browser.js)

## Web Research Module (Feb 2026 Overhaul)

Major refactoring completed with significant reliability and performance improvements:

**Content Extraction Hardening:**
- **4-tier fallback strategy**: Readability → Semantic → Density → Raw fallback
- **Pre-cleaning**: Removes scripts/styles/nav before DOM parsing (fixed regex bug where `on\w+` matched "content=")
- **Content validation**: Bot detection, link density checks, minimum length enforcement
- **Metadata extraction**: Multi-selector fallback for title, description, OG tags

**Search Adapter Fixes:**
- **Google**: Updated selectors (`.g`, `div[data-hveid]`, `.tF2Cxc`) + faster `domcontentloaded` wait
- **DuckDuckGo**: Completely rebuilt - now uses direct URL `/?q=QUERY&ia=web` with data-testid selectors (was returning 0 results before)

**Performance Optimizations:**
- **Streaming research pipeline**: Scrape + synthesize concurrently, early termination when sufficient content found (3+ quality sources)
- **URL prioritization**: Docs > StackOverflow > GitHub > blogs (heuristic ranking, no LLM wait)
- **Dual-engine support**: Both Google and DuckDuckGo queried in parallel, deduplicated by URL
- **Target**: 5-10 pages in ~12s (was timing out at 3-5 pages)

**New Components:**
- `src/lib/streaming-research.js` - Pipeline for concurrent scraping with progress tracking
- `src/scrapers/content-extractor.js` - Hardened extraction with 4 strategies
- `test/test-content-extractor.js` - 23-test suite for extraction validation

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

## Code Search Architecture (Feb 4, 2026)

**Status**: Production-ready with hash-based file IDs and in-memory caching

**Module Structure**:
- `src/servers/code-search/indexer.js` (178 lines) - Centralized utilities
  - `generateFileId(workspace, filePath)` - SHA256 hash generation (32 chars)
  - `parseFile`, `walkWorkspace`, `detectLanguage`, `generateEmbeddingText`
  - `writeIndexStreaming`, `atomicWriteIndex`, `loadIndex`
- `src/servers/code-search/server.js` (820 lines) - MCP server with 9 tools
- `src/servers/code-search/build-index.js` (286 lines) - CLI indexing tool

**File ID System**:
- 32-character SHA256 hash of `${workspace}:${filePath}`
- Collision-free for 50K+ files
- All search tools return hash IDs
- retrieve_file accepts hash IDs (backward compatible with legacy format)

**Performance**:
- In-memory caching with auto-reload after maintenance
- Search: 5-10ms cached (20-40x faster than disk load)
- Batch embeddings: 50 texts × 4 parallel = 2.3x speedup
- Streaming JSON write for indexes >512MB

**Workspaces**:
- COOLKID-Work: 21,717 files (284 MB index)
- BADKID-DEV: 28,110 files (613 MB index)
- BADKID-SRV: 791 files (4 MB index)

**Tools**: get_workspace_config, get_file_info, refresh_index, refresh_all_indexes, get_index_stats, search_files, search_keyword, search_semantic, search_code

## Local Agent Architecture

**Status**: Production-ready autonomous code exploration

**Implementation**:
- `src/lib/workspace.js` (166 lines) - UNC path mapping, security validation
- `src/servers/local-agent.js` (662 lines) - Autonomous LLM agent with 3 tools
- Tools: run_local_agent, retrieve_file, inspect_code

**Agent Workflow**:
1. Dynamic tool selection (search tools if indexed, fs tools otherwise)
2. Message→prompt conversion for LLM router compatibility
3. JSON tool call extraction from LLM responses
4. Findings aggregation across iterations (NO CODE in summaries)
5. Complete search→retrieve workflow via retrieve_file tool
6. Max 20 iterations, 50k token budget, loop detection (3x same call)

**Config**: `config.servers.local-agent` - maxTokenBudget, maxIterations, toolCallingFormat
**Provider**: `config.llm.taskDefaults.agent` (lmstudio/gemini/ollama)

**Known Issues**:
- **BUG**: `run_local_agent` creates retrieval plans with old-format paths like `"BADKID-DEV:mcp_server/src/router.js"` instead of using search tools to get hash IDs first. Agent should: (1) use search_files/search_keyword/search_semantic to find files, (2) get hash IDs from results, (3) use retrieve_file with hash IDs. Currently fails with "I don't have access to your specific codebase" error.

## Contributors
- **@herrbasan** - Initial architecture, LM Studio integration, memory system
- **GitHub Copilot (Claude Sonnet 4.5)** - Web research iterative refinement, anti-bot hardening, LLM source selection debugging, browser pool architecture (persistent tabs, search adapters, realistic scraping behavior)
- **GitHub Copilot (Claude Opus 4.5)** - Local Agent and Code Search design, batch embedding optimization, file ID system, in-memory caching
