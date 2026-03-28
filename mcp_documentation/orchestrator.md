# MCP Orchestrator - Tools Reference Guide

> **📍 Scope**: Use IDE shortcuts for **current project** (faster!). Use MCP tools for **cross-project search**, **web content**, and **LLM queries**.

> ✅ **You have read this documentation via `get_documentation()`. Follow the scope guidelines and workflows below.**

---

## Quick Navigation

| Agent | Purpose |
|-------|---------|
| [Codebase](#codebase-indexing-module) | Semantic code search, indexing |
| [Memory](#memory-module) | Quality-focused semantic memory |
| [LLM](#llm-module) | Local model querying |
| [Research](#web-research-module) | Multi-source research pipeline |
| [Browser](#browser-module) | Headless browser with persistent sessions |
| [Inspector](#code-inspector-module) | LLM-based code analysis |
| [Vision](#vision-module) | Iterative image analysis with drill-down focus |
| [Docs](#docs-module) | Documentation access |

---

## Codebase Indexing Module

**Decision Guide:**

| You want to... | Use this |
|----------------|---------|
| Search a specific codebase you know | `search_codebase` |
| Find exact function/class names | `search_keyword` |
| Conceptual/similarity search | `search_semantic` |
| Live regex, stale index, or line numbers | `grep_codebase` |
| Don't know which codebase has it | `search_all_codebases` (last resort) |

**⚡ Performance:**
| Tool | Speed | Best For |
|------|-------|----------|
| `search_keyword` | <50ms | Exact names |
| `search_codebase` | <200ms | Focused search |
| `search_semantic` | 100-300ms | Conceptual |
| `search_all_codebases` | 2-5s | **Use rarely** |
| `grep_codebase` | 1-3s | Regex, live search |

### `search_codebase`
Search within a specific codebase. **Preferred approach** - be specific about which codebase.

```javascript
mcp_orchestrator_search_codebase({
  codebase: "my-project",      // Use the project name
  query: "webSocket retry",
  limit: 10
})
```

### `search_keyword`
**Fast exact-match search** for function names, class names, identifiers.

```javascript
mcp_orchestrator_search_keyword({
  codebase: "my-project",
  query: "StreamableHTTPServerTransport"
})
```

### `search_semantic`
Conceptual/similarity search using embeddings.

```javascript
mcp_orchestrator_search_semantic({
  codebase: "my-project",
  query: "how does the router handle failures?"
})
```

### `grep_codebase`
Live regex search. Slower but always current.

```javascript
mcp_orchestrator_grep_codebase({
  codebase: "my-project",
  pattern: "async.*function",
  regex: true
})
```

### `search_all_codebases`
**⚠️ Last resort** - searches ALL indexed codebases. Slow and expensive. Only use when you genuinely don't know which codebase contains what you're looking for.

```javascript
// AVOID unless necessary
mcp_orchestrator_search_all_codebases({
  query: "drag and drop implementation"
})
```

**Do this instead:**
1. Use `list_codebases` to find relevant projects
2. Use `search_codebase` on specific projects
3. Use `search_keyword` for exact matches

```javascript
mcp_orchestrator_search_semantic({
  codebase: "mcp_server",
  query: "how does the router handle provider fallback?",
  limit: 5,
  analyze: true
})
```

#### `search_keyword`
**FAST indexed keyword search** - Best for exact function names, class names, and identifiers. Searches both file paths AND content.

```javascript
// Find function by name (fastest)
mcp_orchestrator_search_keyword({
  codebase: "mcp_server",
  query: "StreamableHTTPServerTransport",
  limit: 20
})

// Search content (includes line matches)
mcp_orchestrator_search_keyword({
  codebase: "mcp_server",
  query: "handleRequest",
  searchContent: true,  // Include content matches
  limit: 10
})
// Returns: { file, path, rank, contentMatches: [{line, content}] }
```

**💡 Prefer this over `grep_codebase`** when:
- Searching for specific function/class names
- You need fast results (<50ms vs 1-3s)
- You don't need regex patterns
- You don't need exact line numbers for editing

#### `grep_codebase`
**Live regex search** with ripgrep. Always current (searches filesystem directly). **Use sparingly** - it's 10-50x slower than indexed search.

### `get_file` / `get_file_info`
Retrieve file content or structure from a codebase.

```javascript
mcp_orchestrator_get_file({ codebase: "my-project", path: "src/main.js" })
mcp_orchestrator_get_file_info({ codebase: "my-project", path: "src/main.js" })
```

---

## Memory Module (5 tools)

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

## Browser Module (14 tools)

Headless browser (Puppeteer) with persistent sessions for multi-step workflows.

**Workflow**: Create session → Navigate/interact → Get content → Close

```javascript
// 1. Create session (returns sessionId in response text)
mcp_orchestrator_browser_session_create()
// → "Session created: a1b2c3d4-..."

// 2. Navigate to URL
mcp_orchestrator_browser_session_goto({
  sessionId: "a1b2c3d4-...",
  url: "https://example.com/login",
  waitFor: "#username"      // optional: wait for selector
})

// 3. Fill form and submit
mcp_orchestrator_browser_session_fill({
  sessionId: "a1b2c3d4-...",
  fields: [
    { selector: "#username", value: "user@example.com" },
    { selector: "#password", value: "secret123" }
  ],
  submit: "#login-button"
})

// 4. Click element
mcp_orchestrator_browser_session_click({
  sessionId: "a1b2c3d4-...",
  selector: "#next-button",
  waitAfter: 1000
})

// 5. Scroll page
mcp_orchestrator_browser_session_scroll({
  sessionId: "a1b2c3d4-...",
  direction: "down",
  amount: 500
})

// 6. Execute JS
mcp_orchestrator_browser_session_evaluate({
  sessionId: "a1b2c3d4-...",
  script: "document.title"
})

// 7. Get page content
mcp_orchestrator_browser_session_content({
  sessionId: "a1b2c3d4-...",
  mode: "text"              // text | html | markdown | screenshot
})

// 8. Get page metadata
mcp_orchestrator_browser_session_metadata({
  sessionId: "a1b2c3d4-..."
})
// → URL, title, viewport

// 9. List active sessions
mcp_orchestrator_browser_session_list()

// 10. Close session
mcp_orchestrator_browser_session_close({
  sessionId: "a1b2c3d4-..."
})

// 11. Type text / send keystrokes (character-by-character, triggers key events)
mcp_orchestrator_browser_session_type({
  sessionId: "a1b2c3d4-...",
  selector: "#search",         // optional: focuses element first
  text: "hello world",
  delay: 50,                   // ms between keystrokes
  keystrokes: ["Enter"]       // or: ["Tab", "ArrowDown", "Escape"]
})

// 12. Inspect element (tag, attributes, text, position, visibility, screenshot)
mcp_orchestrator_browser_session_inspect({
  sessionId: "a1b2c3d4-...",
  selector: "#username",
  screenshot: true             // include cropped element screenshot
})

// 13. Get captured console messages (clears buffer after reading)
mcp_orchestrator_browser_session_console({
  sessionId: "a1b2c3d4-..."
})

// 14. Enhanced waiting (OR selectors, text, URL pattern, or JS condition)
mcp_orchestrator_browser_session_wait({
  sessionId: "a1b2c3d4-...",
  selectors: [".success", ".error", "#result"],  // OR logic - any match
  // OR: text: "Thank you for your order"
  // OR: urlPattern: "/checkout/success"          // regex
  // OR: condition: "document.querySelector('.loading').style.display === 'none'"
  timeout: 15000
})
```

**Session lifecycle**: 10 min idle timeout per session. Browser stays open while sessions exist.

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

## Vision Module (5 tools)

Iterative image analysis with "ever-sharpening" drill-down capability. Sessions store the original image and accumulate analyses over time.

### `vision_create_session`
Create a new image analysis session.

```javascript
// From URL
mcp_orchestrator_vision_create_session({
  image_url: "https://example.com/photo.jpg"
})

// From base64
mcp_orchestrator_vision_create_session({
  image_data: "data:image/jpeg;base64,...",
  image_mime_type: "image/jpeg"
})
// → { session_id: "img_1234567890_abc123", ... }
```

### `vision_analyze`
Analyze an image with optional focus for zoomed-in detail.

```javascript
mcp_orchestrator_vision_analyze({
  session_id: "img_1234567890_abc123",
  query: "Describe everything in this image",
  include_context: true  // include previous analyses (default: true)
})

// Text focus (free-form description)
mcp_orchestrator_vision_analyze({
  session_id: "img_1234567890_abc123",
  query: "What is this person wearing?",
  focus: { text: "person on the left" }
})

// Grid focus (divide image, analyze specific cells)
// Grid index: 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right
mcp_orchestrator_vision_analyze({
  session_id: "img_1234567890_abc123",
  query: "Describe the top-right area",
  focus: { grid: { cols: 2, rows: 2, cells: [1] } }
})

// Region focus (normalized coordinates 0-1)
mcp_orchestrator_vision_analyze({
  session_id: "img_1234567890_abc123",
  query: "Read the text",
  focus: { region: { left: 0.7, top: 0.1, right: 0.95, bottom: 0.3 } }
})

// Center crop (percentage)
mcp_orchestrator_vision_analyze({
  session_id: "img_1234567890_abc123",
  query: "What is the main subject?",
  focus: { centerCrop: 50 }  // keep center 50%
})

// Asymmetric center crop
mcp_orchestrator_vision_analyze({
  session_id: "img_1234567890_abc123",
  query: "Analyze the vertical center",
  focus: { centerCrop: { widthPercent: 40, heightPercent: 80 } }
})
```

**Focus Types:**
| Type | Use Case |
|------|----------|
| `text` | Free description: "top-left corner", "person on the left" |
| `grid` | Divide image into cols×rows grid, select cell indices |
| `region` | Normalized pixel coordinates (left, top, right, bottom) |
| `centerCrop` | Percentage crop from center (single number or {width, height}) |

### `vision_list_sessions`
List all active image sessions.

```javascript
mcp_orchestrator_vision_list_sessions()
// → "Active sessions:\n- img_xxx: 3 analyses\n- img_yyy: 1 analysis"
```

### `vision_get_session`
Get session details including accumulated analyses.

```javascript
mcp_orchestrator_vision_get_session({
  session_id: "img_1234567890_abc123"
})
// → Session info with all previous analyses
```

### `vision_close_session`
Close a session and free memory.

```javascript
mcp_orchestrator_vision_close_session({
  session_id: "img_1234567890_abc123"
})
```

**Session Lifecycle:**
- Sessions auto-expire after 30 minutes of inactivity
- Original image stored in memory (FleetingMemory with TTL)
- Crops are generated on-demand via MediaService

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
| `search_keyword` | <50ms | Indexed content search |
| `search_all_codebases` | 1-2s | Preloaded at startup |
| `search_codebase` | <500ms | Single codebase |
| `grep_codebase` | 1-3s | Live filesystem search (cached) |
| `research_topic` | 12-45s | Depends on pages scraped |
| `query_model` | 2-10s | Depends on model & tokens |
| `vision_analyze` | 3-15s | Depends on image size and model |
