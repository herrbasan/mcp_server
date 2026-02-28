# MCP Orchestrator - Tools Reference Guide

> **Total Tools**: 19 across 6 modules  
> **📍 Scope**: Use IDE shortcuts for **current project** (faster!). Use MCP tools for **cross-project search**, **web content**, and **LLM queries**.

> ✅ **You have read this documentation via `get_documentation()`. Follow the scope guidelines and workflows below.**

---

## Quick Navigation

| Module | Tools | Purpose |
|--------|-------|---------|
| [Codebase Indexing](#codebase-indexing-module) | 10 | Search 122 indexed codebases |
| [Memory](#memory-module) | 7 | Quality-focused semantic memory |
| [LLM](#llm-module) | 1 | Local model querying |
| [Web Research](#web-research-module) | 1 | Multi-source research pipeline |
| [Browser](#browser-module) | 6 | Puppeteer browser automation |
| [Code Inspector](#code-inspector-module) | 1 | LLM-based code analysis |

---

## Codebase Indexing Module (10 tools)

> **🚀 FAST**: Preloaded at startup (~1-2s for global search across 122 codebases)  
> **🔍 Scope**: Search across ALL indexed projects (BADKID-*, COOLKID-* prefixes)  
> **💡 Tip**: Use `analyze: true` to get AI-summarized results (saves 50-90% tokens)

### Quick Decision Guide

| You want to... | Use this tool | Strategy |
|---------------|---------------|----------|
| Find how something is implemented | `search_all_codebases` | `semantic` + `analyze: true` |
| Search a specific codebase | `search_codebase` | `hybrid` (default) |
| Find exact function/variable names | `grep_codebase` | exact pattern |
| Quick keyword search | `search_keyword` | FTS5 matching |
| Conceptual similarity search | `search_semantic` | embedding-based |

### Global Search (Most Common)

#### `search_all_codebases`
Search across ALL 122 indexed codebases at once. Perfect for finding implementations when you don't know which project has them.

```javascript
// 🔥 RECOMMENDED: Use analyze:true for exploration
mcp_orchestrator_search_all_codebases({
  query: "drag and drop file upload electron",
  strategy: "semantic",
  limit: 10,
  analyze: true           // ← AI summarizes results (saves tokens!)
})

// Returns structured analysis:
// {
//   analysis: {
//     summary: "Found 5 implementations...",
//     keyFindings: ["Uses webUtils.getPathForFile()", ...],
//     relevantFiles: ["js/mixer/main.js - Drag handler", ...],
//     implementationPatterns: ["Event: dragover/drop", ...]
//   },
//   stats: { resultCount: 46, searchType: "..." }
// }
```

**When to use `analyze: true`:**
- ✅ Exploring unknown codebases ("find how X is implemented")
- ✅ Broad searches with many results
- ✅ Initial research before diving deep
- ✅ Getting high-level patterns across projects

**When to SKIP `analyze: true`:**
- ❌ You need exact line numbers for editing
- ❌ Feeding results into another automated tool
- ❌ Very specific search with <5 results

**Include raw results too:**
```javascript
mcp_orchestrator_search_all_codebases({
  query: "drag and drop",
  analyze: true,
  includeRaw: true        // ← Get analysis + raw snippets
})
```

**Strategies explained:**
- `semantic` (default) - Natural language, finds conceptually similar code
- `keyword` - Exact word matching (fastest)
- `grep` - Live regex search (always current, slower)
- `hybrid` - Combines semantic + keyword

### Single Codebase Search

#### `search_codebase`
Search within one specific codebase.

```javascript
// Basic search
mcp_orchestrator_search_codebase({
  codebase: "BADKID-mcp_server",    // Partial names work: "mcp_server"
  query: "webSocket retry logic",
  limit: 10
})

// With analysis
mcp_orchestrator_search_codebase({
  codebase: "mcp_server",
  query: "error handling pattern",
  analyze: true
})
```

#### `search_semantic`
Pure semantic (embedding) search. Best for conceptual queries.

```javascript
mcp_orchestrator_search_semantic({
  codebase: "mcp_server",
  query: "how does the router handle provider fallback?",
  limit: 5,
  analyze: true
})
```

#### `search_keyword`
Fast keyword search using FTS5. Best for exact terms.

```javascript
mcp_orchestrator_search_keyword({
  codebase: "mcp_server",
  query: "StreamableHTTPServerTransport",
  limit: 20
})
```

#### `grep_codebase`
Live grep with ripgrep. Always current, supports regex.

```javascript
mcp_orchestrator_grep_codebase({
  codebase: "mcp_server",
  pattern: "function.*predict\(",    // Regex supported
  regex: true,
  limit: 50,
  analyze: true                    // Works with analyze too!
})
```

### Discovery Tools

#### `list_codebases`
List all indexed codebases with metadata.

```javascript
mcp_orchestrator_list_codebases()
// Returns: [{ name, files, description, hasAnalysis, ... }, ...]
```

#### `get_file`
Get file content with staleness check.

```javascript
mcp_orchestrator_get_file({
  codebase: "mcp_server",
  path: "src/http-server.js"
})
```

#### `get_file_info`
Get file structure (functions, classes, imports) without full content.

```javascript
mcp_orchestrator_get_file_info({
  codebase: "mcp_server",
  path: "src/router/router.js"
})
```

#### `get_prioritized_files`
Get files ordered by importance (high/medium/low). Useful for understanding project structure.

```javascript
mcp_orchestrator_get_prioritized_files({
  codebase: "mcp_server"
})
// Returns: { high: [...], medium: [...], low: [...] }
```

#### `get_codebase_description`
Get AI-generated project description.

```javascript
mcp_orchestrator_get_codebase_description({
  codebase: "mcp_server"
})
```

### Admin Tools (Hidden from LLM)

These are available but filtered from the LLM tool list:
- `index_codebase` - Add new codebase
- `refresh_codebase` - Update existing
- `remove_codebase` - Delete codebase
- `run_maintenance` - Trigger maintenance cycle
- `get_maintenance_stats` - View maintenance status

---

## Memory Module (7 tools)

> Store evidence for OUTPUT QUALITY. Categories: `proven`, `anti_patterns`, `hypotheses`, `context`, `observed`

### `remember`
```javascript
mcp_orchestrator_remember({
  text: "Pattern description",
  category: "proven",        // or anti_patterns, hypotheses, context, observed
  domain: "mcp_server"       // optional project scope
})
```

### `recall`
```javascript
// Results: [#id] [domain] category (similarity%) confidence-indicator
// ✓=proven(0.7+)  ~=promising(0.5-0.7)  ?=hypothesis(<0.5)

mcp_orchestrator_recall({ 
  query: "authentication patterns", 
  domain: "mcp_server",
  limit: 5 
})
```

### `list_memories` / `update_memory` / `forget`
```javascript
mcp_orchestrator_list_memories({ domain: "mcp_server" })
mcp_orchestrator_update_memory({ id: 42, text: "Updated...", category: "proven" })
mcp_orchestrator_forget({ id: 42 })
```

### `reflect_on_session` / `apply_reflection_changes`
**Purpose**: Memory maintenance at session end. YOU trigger this when work completes.

**What happens**: I scan all project memories, check against current codebase reality, identify outdated patterns, propose updates/deletes for stale items.

**Also check**: Update project documentation (README, AGENTS.md, instructions) if code changes have made them stale.

**Why user-initiated**: Prevents constant memory churn while ensuring regular hygiene. You control when reflection happens; I do the validation work.

---

## LLM Module (1 tool)

### `query_model`
Query local LLM on orchestrator server.

```javascript
mcp_orchestrator_query_model({
  prompt: "Explain async/await",
  systemPrompt: "Optional custom system prompt",
  schema: { type: "object", ... },  // optional JSON schema
  maxTokens: 500                     // optional limit
})
```

**File inclusion**: Pass absolute paths in `files` array or embed them in the prompt.

**Common errors**: `Model not loaded` → wait 10-30s, retry

---

## Web Research Module (1 tool)

### `research_topic`
5-phase pipeline: Search → Select → Scrape → Synthesize → Evaluate

```javascript
mcp_orchestrator_research_topic({
  query: "React 19 Server Components",
  max_pages: 10,                      // default: 10
  engines: ["google", "duckduckgo"]   // default: both
})
```

**Query tips**: Quote terms `"Virtual DOM"`, use `site:stackoverflow.com`

**Typical time**: 12-45 seconds depending on pages

**Common errors**: 
- `Research timeout` → narrow query, reduce max_pages
- `No content synthesized` → try different engines

---

## Browser Module (6 tools)

Real headless browser (Puppeteer). Modes: `text` (default), `html`, `screenshot`, `markdown`

### `browser_fetch`
```javascript
// Text extraction (default) - clean article content
mcp_orchestrator_browser_fetch({ url: "https://example.com" })

// Screenshot
mcp_orchestrator_browser_fetch({
  url: "https://example.com",
  mode: "screenshot",
  fullPage: true
})

// Wait for dynamic content
mcp_orchestrator_browser_fetch({
  url: "https://spa-app.com",
  waitFor: ".data-loaded"     // CSS selector
})
```

### `browser_click` / `browser_fill` / `browser_evaluate` / `browser_pdf`
```javascript
// Click element
mcp_orchestrator_browser_click({
  url: "https://example.com",
  selector: "button.load-more",
  waitAfter: 2000
})

// Fill form
mcp_orchestrator_browser_fill({
  url: "https://example.com/login",
  fields: [
    { selector: "#username", value: "user" },
    { selector: "#password", value: "pass" }
  ],
  submit: "button[type='submit']"
})

// Execute JS in page context
mcp_orchestrator_browser_evaluate({
  url: "https://example.com",
  script: "return document.title"
})

// Generate PDF
mcp_orchestrator_browser_pdf({
  url: "https://example.com",
  format: "A4",           // or Letter, Legal, Tabloid
  landscape: true
})
```

---

## Code Inspector Module (1 tool)

> **Scope**: Analyze code with LLM for quality issues.

### `inspect_code`
```javascript
// Analyze files by absolute path
mcp_orchestrator_inspect_code({
  files: ["D:\\Work\\_GIT\\MyProject\\src\\main.js"],
  question: "What security issues exist?"
})

// Or direct code snippet
mcp_orchestrator_inspect_code({
  code: "function add(a,b) { return a+b }",
  question: "Is this correct?"
})
```

**Note**: Only absolute file paths are supported (Windows `D:\...` or UNC `\\server\...` paths).

---

## Documentation Module (3 tools)

> Access MCP orchestrator documentation

### `list_documents`
List all available documentation files.

```javascript
mcp_orchestrator_list_documents()
// Returns: { documents: ["orchestrator", "coding-philosophy"], count: 2 }
```

### `read_document`
Read a specific documentation file.

```javascript
mcp_orchestrator_read_document({ name: "coding-philosophy" })
```

### `get_documentation`
Get the main orchestrator documentation (equivalent to `read_document({name: "orchestrator"})`).

```javascript
mcp_orchestrator_get_documentation()
```

---

## Common Workflows

### Cross-Project Pattern Discovery
```javascript
// Find how different projects implement WebSocket retry
mcp_orchestrator_search_all_codebases({
  query: "websocket reconnect exponential backoff",
  strategy: "semantic",
  limit: 15,
  analyze: true
})
// Review findings, then inspect specific implementation:
mcp_orchestrator_get_file({
  codebase: "Project-Name",
  path: "src/websocket/client.js"
})
```

### Research → Implement → Remember
```javascript
mcp_orchestrator_research_topic({ query: "WebSocket retry best practices" })
// ... implement pattern ...
mcp_orchestrator_remember({
  text: "Use exponential backoff with jitter",
  category: "proven",
  domain: "my_project"
})
```

### Query with File Context
```javascript
mcp_orchestrator_query_model({
  prompt: "Review this code for issues",
  files: ["D:\\project\\src\\api.js"]
})
```

---

## Scope Guidelines

| Scenario | Tool |
|----------|------|
| Current IDE project | IDE shortcuts (Ctrl+P, F12, Ctrl+Click) |
| Cross-project search | `search_all_codebases` |
| Specific codebase | `search_codebase` / `get_file` |
| Code analysis | Code Inspector with absolute paths |
| Web content | Browser / Research |
| LLM queries | query_model |

---

## Performance Notes

| Tool | Typical Time | Notes |
|------|--------------|-------|
| `search_all_codebases` | 1-2s | Preloaded at startup |
| `search_codebase` | <500ms | Single codebase |
| `grep_codebase` | 1-3s | Live filesystem search |
| `research_topic` | 12-45s | Depends on pages scraped |
| `query_model` | 2-10s | Depends on model & tokens |
