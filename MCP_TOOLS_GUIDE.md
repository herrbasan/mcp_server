# MCP Orchestrator - Tools Reference Guide

> **Total Tools**: 30 across 6 modules  
> **📍 Scope**: Use IDE shortcuts for **current project** (faster!). Use MCP tools for **external workspaces** and **web content**.

> ✅ **You have read this documentation via `get_documentation()`. Follow the scope guidelines and workflows below.**

---

## Quick Navigation

| Module | Tools | Purpose |
|--------|-------|---------|
| [Memory](#memory-module) | 7 | Quality-focused semantic memory |
| [LLM](#llm-module) | 1 | Local model querying |
| [Web Research](#web-research-module) | 1 | Multi-source research pipeline |
| [Browser](#browser-module) | 6 | Puppeteer browser automation |
| [Code Inspector](#code-inspector-module) | 1 | LLM-based code analysis (external files only) |
| [Code Search](#code-search-module) | 14 | Semantic/kw search across workspaces |

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

> **Scope**: For **external files** only. Analyze current project files directly (no tool needed).

### `inspect_code`
```javascript
// Analyze file(s) by hash ID from search
mcp_orchestrator_inspect_code({
  target: "fc745a690e4db10279c18241a0a572c7",  // or "hash1,hash2"
  question: "What security issues exist?"
})

// Or direct code snippet
mcp_orchestrator_inspect_code({
  code: "function add(a,b) { return a+b }",
  question: "Is this correct?"
})
```

---

## Code Search Module (14 tools)

> **Scope**: For **external workspaces** only. Use IDE shortcuts (Ctrl+P, F12) for current project.

### The 3-Step Workflow

```javascript
// STEP 1: Discover workspaces
mcp_orchestrator_get_workspace_config()
// Returns: [{ name: "BADKID-DEV", uncPath: "d:\DEV", indexed: true }, ...]

// STEP 2: Search
mcp_orchestrator_search_semantic({     // By meaning (embeddings)
  workspace: "BADKID-DEV",              // omit to search ALL workspaces
  query: "HTTP request handling",
  limit: 10
})
// Returns: [{ file: "7b75d9c0...", similarity: 0.89, functions: [...] }, ...]

mcp_orchestrator_search_keyword({      // Exact text/regex
  workspace: "BADKID-DEV",
  pattern: "createMCPServer",
  regex: false                         // set true for regex
})
// Returns: [{ file: "7b75d9c0...", line: 243, content: "..." }, ...]

mcp_orchestrator_search_files({        // Glob patterns
  workspace: "BADKID-DEV",
  glob: "src/**/*.js"                   // or "**/*auth*"
})

// STEP 3: Get structure
mcp_orchestrator_get_file_info({
  file: "7b75d9c08788a8863da8e1654e287b1c"  // 32-char hash ID
})
// Returns: { functions: [{name, line}], classes: [...], imports: [...] }

// STEP 4: Retrieve specific lines
mcp_orchestrator_retrieve_file({
  file: "7b75d9c08788a8863da8e1654e287b1c",
  startLine: 243,
  endLine: 260
})
```

### Utility Tools

```javascript
// Quick preview without full workflow
mcp_orchestrator_peek_file({
  query: "http-server.js",
  workspace: "BADKID-DEV",
  max_lines: 50
})

// Get context around line
mcp_orchestrator_get_context({
  file: "7b75d9c0...",
  line: 245,
  radius: 20              // or "function" for auto-expand
})

// Symbol outline
mcp_orchestrator_get_function_tree({ file: "7b75d9c0..." })

// Directory exploration
mcp_orchestrator_get_file_tree({
  workspace: "COOLKID-Work",
  path: "_GIT/SoundApp",  // relative to workspace root
  max_depth: 2
})

// Index management
mcp_orchestrator_get_index_stats({ workspace: "BADKID-DEV" })
mcp_orchestrator_refresh_index({ workspace: "BADKID-DEV" })
mcp_orchestrator_refresh_all_indexes({ force: false })
```

---

## Common Workflows

### Cross-Project Reference
```javascript
// Reference implementation from another workspace while coding
mcp_orchestrator_search_semantic({
  workspace: "COOLKID-Work",
  query: "WebSocket connection handler"
})
// ... get_file_info ... retrieve_file specific lines
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

---

## File ID Format

- **32-character SHA256 hash**: `7b75d9c08788a8863da8e1654e287b1c`
- Generated from: `SHA256("workspace:filePath").slice(0, 32)`
- All search tools return hash IDs
- Pass hash IDs directly to `retrieve_file`, `get_file_info`, `inspect_code`

---

## Scope Guidelines

| Scenario | Tool |
|----------|------|
| Current IDE project | IDE shortcuts (Ctrl+P, F12, Ctrl+Click) |
| Code analysis in current project | Analyze directly (in context) |
| Other workspaces | Code Search / Inspector |
| Web content | Browser / Research |

---

## Performance Cheat Sheet

| Tool | Typical Time |
|------|--------------|
| `search_semantic` | 1-2s |
| `search_keyword` | 2-5s |
| `retrieve_file` | 50-100ms |
| `inspect_code` | 2-5s |
| `query_model` | 0.5-3s |
| `research_topic` | 12-45s |
| `browser_fetch` | 0.2-2s |
| `remember` / `recall` | 0.2-0.5s |

---

## Troubleshooting

| Error | Solution |
|-------|----------|
| `File not found in index` | Run `refresh_index` |
| `No search results` | Check workspace name with `get_workspace_config` |
| `Hash ID not found` | Search without workspace param |
| `Research timeout` | Narrow query, reduce max_pages |
| `No content synthesized` | Try different engines |
| `Model not loaded` | Wait 10-30s, retry |
