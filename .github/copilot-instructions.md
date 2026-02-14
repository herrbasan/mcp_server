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

**Tools** (16 across 5 modules):
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
- `embedding` → lmstudio (local, fast, nomic-embed-text-v2-moe 768-dim)
- `analysis` → lmstudio
- `synthesis` → lmstudio
- `query` → lmstudio
- `inspect` → lmstudio

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

## Historical Changes

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
