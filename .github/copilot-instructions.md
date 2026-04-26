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
- Agents: src/agents/ - (browser, docs, inspector, llm, memory, research, vision)

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


