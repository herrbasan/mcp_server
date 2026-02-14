# MCP Orchestrator - Tools Reference Guide

> **Total Tools**: 16 across 5 modules  
> **📍 Scope**: Use IDE shortcuts for **current project** (faster!). Use MCP tools for **web content** and **LLM queries**.

> ✅ **You have read this documentation via `get_documentation()`. Follow the scope guidelines and workflows below.**

---

## Quick Navigation

| Module | Tools | Purpose |
|--------|-------|---------|
| [Memory](#memory-module) | 7 | Quality-focused semantic memory |
| [LLM](#llm-module) | 1 | Local model querying |
| [Web Research](#web-research-module) | 1 | Multi-source research pipeline |
| [Browser](#browser-module) | 6 | Puppeteer browser automation |
| [Code Inspector](#code-inspector-module) | 1 | LLM-based code analysis |

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
| Code analysis | Code Inspector with absolute paths |
| Web content | Browser / Research |
| LLM queries | query_model |

---

## Performance Cheat Sheet

| Tool | Typical Time |
|------|--------------|
| `inspect_code` | 2-5s |
| `query_model` | 0.5-3s |
| `research_topic` | 12-45s |
| `browser_fetch` | 0.2-2s |
| `remember` / `recall` | 0.2-0.5s |

---

## Troubleshooting

| Error | Solution |
|-------|----------|
| `Research timeout` | Narrow query, reduce max_pages |
| `No content synthesized` | Try different engines |
| `Model not loaded` | Wait 10-30s, retry |
| `Path must be absolute` | Use full paths like `D:\project\file.js` |
