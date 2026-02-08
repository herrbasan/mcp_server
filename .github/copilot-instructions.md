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

**Tools** (30 across 6 modules):
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
- **Browser** (5): Direct browser automation (browser_fetch, browser_click, browser_fill, browser_evaluate, browser_pdf)
- **Code Inspector** (1): LLM-based code analysis (inspect_code) - analyze files or code snippets
- **Code Search** (13): Semantic search and retrieval for large codebases
  - Discovery: search_semantic, search_keyword, search_files, search_code
  - Retrieval: retrieve_file, peek_file, get_context
  - Exploration: get_file_tree, get_function_tree
  - Index: refresh_index, refresh_all_indexes, get_spaces_config, get_file_info, get_index_stats

## Space Architecture (For LLMs Using MCP Orchestrator)

**YOU ARE A CALLING LLM** - You don't see local files. Use MCP tools to interact with codebases.

**Core Utilities**:
- `src/lib/space.js` - UNC path mapping, security validation (shared by Code Inspector and Code Search)

### Quick Start Workflow
```
1. get_spaces_config()           → Discover available spaces
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
const results = search_semantic({ space: "BADKID-DEV", query: "HTTP request handling" });
// Returns: { file: "fc745a690e4db10279c18241a0a572c7", functions: ["handleRequest"], ... }

// 2. Get detailed metadata with line numbers
const info = get_file_info({ file: "fc745a690e4db10279c18241a0a572c7" });
// Returns: { space: "BADKID-DEV", path: "src/http-server.js", functions: [{ name: "handleRequest", line: 45 }], ... }

// 3. Retrieve just the function you need
const content = retrieve_file({ 
  file: "fc745a690e4db10279c18241a0a572c7",
  startLine: 45,
  endLine: 80
});
```

### Space Model (Code Repositories)
Spaces are **named root folders** - network shares (UNC paths) or local drives containing code repositories. Think of them as drives - each space name maps to a root directory.

| Space Name | Maps To | Description |
|------------|---------|-------------|
| `COOLKID-Work` | `\\COOLKID\Work\Work` | Main dev machine share |
| `BADKID-DEV` | `d:\DEV` | Local dev drive |
| `BADKID-SRV` | `d:\SRV` | Local server drive |

**Terminology Note**: "COOLKID-Work" is a **space name** (configured identifier), NOT a folder name. The share `\\COOLKID\Work` happens to contain a `Work` subfolder, which can be confusing. Always use space names in API calls.

**IMPORTANT**: When using `get_file_tree` or searching, paths are **relative to the space root**. A project at `\\COOLKID\Work\Work\_GIT\SoundApp` is accessed via `space: "COOLKID-Work", path: "Work/_GIT/SoundApp"`.

**Exploration Workflow**:
```javascript
// 1. See available spaces
get_spaces_config()  // Returns: COOLKID-Work, BADKID-DEV, etc.

// 2. Explore space structure to find your project
get_file_tree({ space: "COOLKID-Work" })  
// Returns: { Work: { type: "directory", children: { _GIT: {...} } } }

// 3. Drill down to your project
get_file_tree({ space: "COOLKID-Work", path: "Work/_GIT/SoundApp" })
```

### File ID Format
All search results return **32-character SHA256 hash IDs** (collision-free):
- Format: `fc745a690e4db10279c18241a0a572c7`
- Generated from: SHA256(`${spaceName}:${filePath}`).slice(0, 32)
- Pass hash IDs directly to `retrieve_file` and `get_file_info`

### File Path Formats (Recommended)
When referencing files in `inspect_code` and `query_model`, use these formats in order of preference:

| Format | Example | Status | Use When |
|--------|---------|--------|----------|
| **Hash ID** | `fc745a690e4db10279c18241a0a572c7` | ✅ Recommended | You have search results |
| **SPACE:path** | `BADKID-DEV:src/router.js` | ✅ Recommended | You know the space name and relative path |
| **Relative + space param** | `src/router.js` + `space: "BADKID-DEV"` | ✅ Works | Clean separation of concerns |

**Complete Workflow Example**:
```javascript
// 1. Search finds file with hash IDs
const results = search_semantic({ space: "BADKID-DEV", query: "HTTP request handling" });
// Returns: { file: "fc745a690e4db10279c18241a0a572c7", functions: ["handleRequest"], ... }

// 2. Get detailed metadata with line numbers
const info = get_file_info({ file: "fc745a690e4db10279c18241a0a572c7" });
// Returns: { space: "BADKID-DEV", path: "src/http-server.js", functions: [{ name: "handleRequest", line: 45 }], ... }

// 3. Retrieve just the function you need
const content = retrieve_file({ 
  file: "fc745a690e4db10279c18241a0a572c7",
  startLine: 45,
  endLine: 80
});
```
| **Absolute path** | `D:\DEV\project\file.js` | ⚠️ Deprecated | Avoid - fragile auto-detection |

**Terminology note:** "Spaces" are configured root folders (network shares or local drives). The `BADKID-DEV` in the example is a **space name**, not a folder name. Spaces map to paths like `\\BADKID\Stuff\DEV` or `D:\DEV` in config.json.

**Why avoid absolute paths?** Drive letters vs UNC paths, case sensitivity, and network share variations make reliable auto-detection complex. Use `SPACE:path` format instead - it's explicit and unambiguous.

### Search Tools (use space name, not paths)

| Tool | Use For | Returns | Example |
|------|---------|---------|---------|
| `search_semantic` | Find by meaning | Files with similarity scores + **functions/classes arrays** | `{ query: "HTTP request handling" }` (omit space name to search all) |
| `search_keyword` | Exact text/regex | File matches | `{ space: "BADKID-DEV", pattern: "StreamableHTTP" }` |
| `search_files` | Glob patterns | File paths | `{ space: "BADKID-DEV", glob: "src/**/*.js" }` |
| `search_code` | Combined search | Enriched results | `{ query: "authentication" }` (omit space name to search all) |
| `get_file_info` | Detailed metadata | **Functions/classes with line numbers**, imports, exports | `{ file: "fc745a690e4db10279c18241a0a572c7" }` |

**Key Feature**: `search_semantic` and `get_file_info` both return function/class names, but `get_file_info` includes **line numbers** for precise partial retrieval.

### Code Analysis Workflow
For code analysis, use explicit search → inspect pattern:
```javascript
// Step 1: Find relevant files
const results = search_semantic({ query: "HTTP server architecture" })

// Step 2: Inspect specific files
inspect_code({
  files: [results[0].file_id],
  question: "Explain the HTTP server architecture"
})
// Explicit, predictable, saves context
```

### Index Management
```javascript
refresh_index({ space: "BADKID-DEV" })      // Update single space
refresh_all_indexes()                            // Update all spaces
get_index_stats({ space: "BADKID-DEV" })    // Check index health
refresh_all_indexes()                            // Update all spaces
get_index_stats({ space: "BADKID-DEV" })    // Check index health
search_semantic({ query: "auth logic" })         // Search ALL spaces (omit space param)
```

**Index Files**: Located at `data/indexes/{space}.json`
**Index Caching**: In-memory cache with auto-reload after maintenance (refresh_index/refresh_all_indexes)
- ~900MB footprint for all 3 spaces (0.7% of 128GB RAM)
- Performance: 100-200ms first load → 5-10ms cached (20-40x faster)
- Cache management: `clearCache()`, `reloadIndex(space)` functions available

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

**Embedding Model Configuration:**
- All providers now have endpoint-specific embedding models (e.g., `LM_STUDIO_EMBEDDING_MODEL`, `GEMINI_EMBEDDING_MODEL`)
- **Recommended**: Use local embeddings (LM Studio/Ollama) for speed - cloud embeddings (Gemini) work but have network latency
- Gemini's `text-embedding-004` model tested and working via API

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
  - `generateFileId(space, filePath)` - SHA256 hash generation (32 chars)
  - `parseFile`, `walkSpace`, `detectLanguage`, `generateEmbeddingText`
  - `writeIndexStreaming`, `atomicWriteIndex`, `loadIndex`
- `src/servers/code-search/server.js` (820 lines) - MCP server with 9 tools
- `src/servers/code-search/build-index.js` (286 lines) - CLI indexing tool

**File ID System**:
- 32-character SHA256 hash of `${space}:${filePath}`
- Collision-free for 50K+ files
- All search tools return hash IDs
- retrieve_file accepts hash IDs (backward compatible with legacy format)

**Performance**:
- In-memory caching with auto-reload after maintenance
- Search: 5-10ms cached (20-40x faster than disk load)
- Batch embeddings: 50 texts × 4 parallel = 2.3x speedup
- Streaming JSON write for indexes >512MB

**Spaces**:
- COOLKID-Work: 21,717 files (284 MB index)
- BADKID-DEV: 28,110 files (613 MB index)
- BADKID-SRV: 791 files (4 MB index)

**Tools**: get_spaces_config, get_file_info, refresh_index, refresh_all_indexes, get_index_stats, search_files, search_keyword, search_semantic, search_code

## Code Inspector Architecture

**Status**: Production-ready LLM-based code analysis

**Implementation**:
- `src/lib/space.js` - UNC path mapping, security validation
- `src/servers/code-inspector.js` - LLM-based code analysis
- Tools: inspect_code

**Agent Workflow**:
1. Dynamic tool selection (search tools if indexed, fs tools otherwise)
2. Message→prompt conversion for LLM router compatibility
3. JSON tool call extraction from LLM responses
4. Findings aggregation across iterations (NO CODE in summaries)
5. Complete search→retrieve workflow via retrieve_file tool
6. Max 20 iterations, 50k token budget, loop detection (3x same call)

**Config**: `config.servers.local-agent` - maxTokenBudget, maxIterations, toolCallingFormat
**Provider**: `config.llm.taskDefaults.agent` (lmstudio/gemini/ollama)

**Tool Improvements (Feb 5, 2026)**:
- ✅ **RENAMED**: `local-agent.js` → `code-inspector.js` - Removed autonomous agent, kept explicit `inspect_code` tool
- ✅ **FIXED**: `inspect_code` supports hash IDs from search results (32-char format) WITHOUT space parameter - space is auto-resolved from the hash
- ✅ **FIXED**: `retrieve_file` description updated to accurately reflect hash ID format instead of legacy "workspace:path" format

**Tool Improvements (Feb 7, 2026)**:
- ✅ **SIMPLIFIED**: Workspace path resolution - replaced complex suffix-matching with straightforward prefix matching
- ✅ **DEPRECATED**: Absolute path auto-detection in `inspect_code` and `query_model`. Tools now recommend hash IDs or `WORKSPACE:path` format for reliability



## Contributors
- **@herrbasan** - Initial architecture, LM Studio integration, memory system
- **GitHub Copilot (Claude Sonnet 4.5)** - Web research iterative refinement, anti-bot hardening, LLM source selection debugging, browser pool architecture (persistent tabs, search adapters, realistic scraping behavior)
- **GitHub Copilot (Claude Opus 4.5)** - Local Agent and Code Search design, batch embedding optimization, file ID system, in-memory caching
- **Kimi K 2.5 (Kimi Code CLI)** - Web research content extraction hardening (4-tier fallback), DuckDuckGo adapter complete rebuild, streaming research pipeline, LLM-optimized code design philosophy, per-provider embedding model configuration


## Useful Links
- x.ai Grok API Reference - https://docs.x.ai/developers/api-reference
- OpenAI API Reference - https://platform.openai.com/docs/api-reference/introduction
- LM Studio API Reference - https://lmstudio.ai/docs/developer/rest
- Ollama API Reference - https://docs.ollama.com/quickstart
- Gemini API Reference - https://ai.google.dev/gemini-api/docs#rest