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
Centralized MCP server running as an **independent HTTP service** on remote machine (192.168.0.100). Manages multiple specialized servers and exposes **24 tools** to VS Code Copilot clients via network.

**Architecture**: StreamableHTTPServerTransport (not legacy SSE)
- Server: `src/http-server.js` - Ports 3100 (MCP), 3010 (web monitoring)
- Transport: Streamable HTTP at `/mcp` with `mcp-session-id` header (stateful sessions)
- Multi-client: DO NOT share a single transport across clients; create one `StreamableHTTPServerTransport` per session and route requests by `mcp-session-id`
- Web UI: Real-time SSE log streaming, memory browser
- Deployment: Remote server, clients connect via `mcp.json` with `type: "sse"`, `url: "http://IP:3100/mcp"`

**Tools** (27 across 6 modules):
- **Memory** (7): Quality-focused semantic memory with confidence ranking (remember, recall, forget, list_memories, update_memory, reflect_on_session, apply_reflection_changes)
- **LM Studio** (4): REST API local model integration (query_model, get_second_opinion, list_available_models, get_loaded_model)
- **Web Research** (1): Multi-source web research with iterative refinement (research_topic)
  - 5-phase pipeline: search → select → scrape → synthesize → evaluate
  - Intelligent source selection via local LLM (strict JSON-only prompting)
  - 10 concurrent isolated browser instances for anti-bot resilience
  - SSL certificate error handling, retry logic, rate limiting
  - Iterative loop: re-searches if confidence < 80%, max 2 iterations
- **Browser** (5): Direct browser automation (browser_fetch, browser_click, browser_fill, browser_evaluate, browser_pdf)
- **Local Agent** (2): Autonomous code analysis with UNC file access (run_local_agent, retrieve_file)
- **Code Search** (9): Semantic search for large codebases (get_workspace_config, get_file_info, refresh_index, refresh_all_indexes, get_index_stats, search_files, search_keyword, search_semantic, search_code)

## Workspace Architecture (For LLMs Using MCP Orchestrator)

**YOU ARE A CALLING LLM** - You don't see local files. Use MCP tools to interact with codebases.

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
  file: "BADKID-DEV:src/http-server.js"
})
// Returns: functions (with line numbers), classes, imports, exports, language, size
// Use this to decide which sections to retrieve with partial retrieval
```

**Partial File Retrieval** - For large files, retrieve only the lines you need:
```javascript
retrieve_file({ 
  file: "COOLKID-Work:project/large-file.js",
  startLine: 100,   // Optional: start line (1-indexed)
  endLine: 200      // Optional: end line (1-indexed)
})
// Returns lines 100-200 instead of entire file (saves tokens!)
```

**Complete Workflow Example**:
```javascript
// 1. Search finds file with specific functions
const results = search_semantic({ workspace: "BADKID-DEV", query: "HTTP request handling" });
// Returns: { file: "BADKID-DEV:src/http-server.js", functions: ["handleRequest", "sendResponse"], ... }

// 2. Get detailed metadata with line numbers
const info = get_file_info({ file: "BADKID-DEV:src/http-server.js" });
// Returns: { functions: [{ name: "handleRequest", line: 45 }, { name: "sendResponse", line: 123 }], ... }

// 3. Retrieve just the function you need (saves tokens!)
const content = retrieve_file({ 
  file: "BADKID-DEV:src/http-server.js",
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
All search results return file IDs in format `workspace:relative/path`:
- `BADKID-DEV:src/http-server.js`
- `COOLKID-Work:project/index.ts`

Pass these directly to `retrieve_file` - no path manipulation needed.

### Search Tools (use workspace name, not paths)

| Tool | Use For | Returns | Example |
|------|---------|---------|---------|
| `search_semantic` | Find by meaning | Files with similarity scores + **functions/classes arrays** | `{ workspace: "BADKID-DEV", query: "HTTP request handling" }` |
| `search_keyword` | Exact text/regex | File matches | `{ workspace: "BADKID-DEV", pattern: "StreamableHTTP" }` |
| `search_files` | Glob patterns | File paths | `{ workspace: "BADKID-DEV", glob: "src/**/*.js" }` |
| `search_code` | Combined search | Enriched results | `{ workspace: "BADKID-DEV", query: "authentication" }` |
| `get_file_info` | Detailed metadata | **Functions/classes with line numbers**, imports, exports | `{ file: "BADKID-DEV:src/server.js" }` |

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

## LLM Router Architecture
- **Multi-Provider**: Unified interface for LMStudio, Ollama, Gemini, OpenAI via adapter pattern
- **Task-Based Routing**: Config defines taskDefaults (embedding, analysis, synthesis, query) mapped to providers
- **Routing Logic**: explicitProvider > taskType default > global default
- **Adapters**: BaseLLMAdapter abstract class, provider-specific implementations
- **Structured Output**: Use `responseFormat` with JSON schema for guaranteed valid JSON (llama.cpp grammar-based sampling)
- **Current Config**:
  - embedding → lmstudio (local, fast, nomic-embed-text-v2-moe 768-dim)
  - analysis → gemini (source selection, credibility)
  - synthesis → gemini (multi-source synthesis)
  - query → gemini (query_model, get_second_opinion)
  - agent → lmstudio (local agent tool calls with structured output)
- **Dimension Compatibility**: All embedding models use 768-dim nomic-embed-text-v2-moe (LMStudio Q4/Q5, Ollama Q8)

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

## Key Principles
- Use modern ES6+ features (async/await, destructuring, etc.)
- Keep functions small and focused
- Avoid over-engineering
- Inline code when it makes execution faster
- Minimal dependencies - build custom solutions over third-party libraries
- Preserve stack traces in errors, throw don't log
- Validate model IDs against available models before use
- When prompting local LLMs for structured output: ask the model how it wants to be prompted (meta-prompting)

## Local Agent & Code Search

**Status**: Fully implemented and validated (all tests passing)

Implementation complete with all planned features:
- **Workspace Resolver**: `src/lib/workspace.js` (166 lines) - UNC path mapping with longest-prefix matching, security validation
- **Local Agent**: `src/servers/local-agent.js` (662 lines) - Autonomous LLM agent with 2 tools (run_local_agent, retrieve_file)
- **Code Search**: `src/servers/code-search.js` (711 lines) - Semantic/keyword/file search with 6 tools
- **Index Builder**: `scripts/build-index.js` (241 lines) - CLI tool for initial index creation
- **Tests**: 22/22 passing (test-workspace.js, test-modules-init.js, test-glob.js)

**Technical Details**:
- Agent Loop: Max 20 iterations, 50k token budget, loop detection (3x same call)
- Embeddings: nomic-embed-text-v2-moe 768-dim vectors via LLM router
- Path Resolution: UNC paths for Windows SMB shares, post-realpath validation
- Index Format: JSON with mtime-based incremental updates, streaming atomic writes
- Streaming JSON: `_writeIndexStreaming()` handles 500MB+ indexes without "Invalid string length" error
- Code Parsing: Regex-based extraction (functions/classes/imports) - tree-sitter deferred
- Security: Path traversal rejection, .git/node_modules filtering
- Glob Support: Full ** pattern support with placeholder-based conversion
- Batch Indexing: build-index.js uses parallel batch embedding (50 texts × 4 concurrent = 2.3x faster)

**Agent Workflow**:
1. Dynamic tool selection (search tools if indexed, fs tools otherwise)
2. Message→prompt conversion for LLM router compatibility
3. JSON tool call extraction from LLM responses
4. Findings aggregation across iterations (NO CODE in summaries)
5. Complete search→retrieve workflow via retrieve_file tool

**Config Structure**:
- `config.workspaces`: {defaultMachine, machines: {MACHINE: {localPath: uncPath}}}
- `config.servers.local-agent`: {enabled, maxTokenBudget, maxIterations, toolCallingFormat}
- `config.servers.code-search`: {enabled, indexPath}
- `config.llm.taskDefaults.agent`: Provider for agent predictions (lmstudio/gemini/ollama)

**Known Bugs Fixed**:
- Agent loop: Findings collection, LLM format mismatch, response parsing, silent errors (5 bugs)
- Glob patterns: ** replacement clobbering via placeholder technique
- Environment variables: ${VAR} substitution in build script
- UNC mapping: Correct share structure (\\MACHINE\Share\Path)

## Contributors
- **@herrbasan** - Initial architecture, LM Studio integration, memory system
- **GitHub Copilot (Claude Sonnet 4.5)** - Web research iterative refinement, anti-bot hardening, LLM source selection debugging
- **GitHub Copilot (Claude Opus 4.5)** - Local Agent and Code Search design, batch embedding optimization
