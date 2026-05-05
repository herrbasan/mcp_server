# MCP Orchestrator - Tools Reference Guide

> **📍 Scope**: Use IDE shortcuts for **current project** (faster!). Use MCP tools for **cross-project search**, **web content**, and **LLM queries**.

> ✅ **You have read this documentation via `get_documentation()`. Follow the scope guidelines and workflows below.**

---

## Quick Navigation

| Agent | Purpose |
|-------|---------|
| [Memory](#memory-module) | Quality-focused semantic memory |
| [LLM](#llm-module) | Local model querying |
| [Research](#web-research-module) | Multi-source research pipeline |
| [Browser](#browser-module) | Headless browser with persistent sessions |
| [GitHub](#github-module) | Browse code, history, PRs, issues from any GitHub repo |
| [Inspector](#code-inspector-module) | LLM-based code analysis |
| [Vision](#vision-module) | Iterative image analysis with drill-down focus |
| [Docs](#docs-module) | Documentation access |

---

---

## Memory Module (6 tools)

> **AUTONOMOUS USAGE**: You forget everything between sessions. Store insights as you work, recall context at session start, and maintain memory quality — or lose what you learned.

**Tools**: `memory_store`, `memory_recall`, `memory_get`, `memory_list`, `memory_update`, `memory_forget`

**Schema**: `description` (short summary), `category` (freeform domain tag), `confidence` (0-1), `data` (optional extended content)

### `memory_store`
You forget everything between sessions — store it or lose it.

```javascript
mcp_orchestrator_memory_store({
  description: "Use exponential backoff with jitter for WebSocket reconnects",
  category: "notes",           // freeform: 'notes', 'personal preference', 'hardware', etc.
  confidence: 0.8,             // 0-1 reliability (default 0.5)
  data: "Optional extended context..."  // only visible via memory_get
})
```

**When to call autonomously**:
- After solving a non-trivial problem
- When discovering project-specific patterns
- After learning what doesn't work
- When user confirms a solution worked

### `memory_recall`
CALL THIS FIRST at every session start. Also use before implementation to check for prior solutions.

```javascript
mcp_orchestrator_memory_recall({
  query: "WebSocket reconnection",
  limit: 5
})
```

**Results format**: `[#id] [category] match% conf:0.x [has data]`

### `memory_get`
Retrieve full content including data payload for a specific memory.

### `memory_list` / `memory_update` / `memory_forget`
Browse, evolve, and cleanup memories autonomously.

```javascript
// Periodic review
mcp_orchestrator_memory_list({ domain: "mcp_server" })
mcp_orchestrator_memory_list({ category: "anti_patterns" })

// Evolve knowledge
mcp_orchestrator_memory_update({ 
  id: 42, 
  text: "Updated with refined approach...", 
  category: "proven"  // promoted from hypotheses
})

// Remove obsolete/wrong memories
mcp_orchestrator_memory_forget({ id: 42 })
```

**Autonomous maintenance**: Call during natural pauses, after identifying outdated info during recall, or when consolidating related memories.

---

## LLM Module (1 tool)

### `query_model`
Query local LLM on orchestrator server.

```javascript
mcp_orchestrator_query_model({
  prompt: "Explain async/await",
  systemPrompt: "Optional custom system prompt",
  maxTokens: 500,                    // optional limit
  temperature: 0.7,                  // optional (default: 0.7)
  files: ["D:\\project\\src\\api.js"] // optional file paths for context
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

---

## GitHub Module (15 tools)

> **Scope**: Browse code, history, PRs, and issues from any GitHub repo. No local checkout needed — reads directly from GitHub API.

**Requires**: `GIT_TOKEN` in `.env` (GitHub Personal Access Token with `repo` scope)

**Tools**: `git_read_file`, `git_list_tree`, `git_log`, `git_get_commit`, `git_diff`, `git_list_branches`, `git_search_repos`, `git_search_code`, `git_search_issues`, `git_repo_info`, `git_pr_list`, `git_get_pr`, `git_issue_list`, `git_get_issue`, `git_create_issue`

### `git_search_repos`
Search GitHub repositories or list repos for a user/org.

```javascript
mcp_orchestrator_git_search_repos({
  query: "user:herrbasan sort:updated",
  limit: 10
})
```

### `git_read_file`
Read a file's contents or list a directory from a GitHub repo.

```javascript
mcp_orchestrator_git_read_file({
  owner: "herrbasan",
  repo: "mcp_server",
  path: "src/server.js",      // empty for root directory listing
  branch: "main"              // optional, defaults to default branch
})
```

### `git_list_tree`
Recursively list all files in a repo or subdirectory.

```javascript
mcp_orchestrator_git_list_tree({
  owner: "herrbasan",
  repo: "mcp_server",
  path: "src/agents/",        // optional scope
  branch: "main"
})
```

### `git_log`
List commit history for a repo or specific file.

```javascript
mcp_orchestrator_git_log({
  owner: "herrbasan",
  repo: "mcp_server",
  path: "src/server.js",      // optional file filter
  branch: "main",
  limit: 20
})
```

### `git_get_commit`
Get details of a single commit with full diff.

```javascript
mcp_orchestrator_git_get_commit({
  owner: "herrbasan",
  repo: "mcp_server",
  sha: "a9a8b24"
})
```

### `git_diff`
Compare two refs (branches, tags, SHAs).

```javascript
mcp_orchestrator_git_diff({
  owner: "herrbasan",
  repo: "mcp_server",
  base: "main",
  head: "feature-branch"
})
```

### `git_search_code`
Search code across GitHub repos.

```javascript
mcp_orchestrator_git_search_code({
  query: "websocket repo:herrbasan/mcp_server",
  limit: 10
})
```

### `git_search_issues`
Search issues and pull requests across GitHub.

```javascript
mcp_orchestrator_git_search_issues({
  query: "repo:herrbasan/mcp_server is:issue is:open",
  limit: 10
})
```

### `git_repo_info`
Get repo metadata: description, default branch, language, size, topics.

```javascript
mcp_orchestrator_git_repo_info({
  owner: "herrbasan",
  repo: "mcp_server"
})
```

### `git_list_branches`
List branches or tags for a repo.

```javascript
mcp_orchestrator_git_list_branches({
  owner: "herrbasan",
  repo: "mcp_server",
  type: "branches"    // or "tags"
})
```

### `git_pr_list` / `git_get_pr`
List or get details of pull requests.

```javascript
mcp_orchestrator_git_pr_list({
  owner: "herrbasan", repo: "mcp_server", state: "open", limit: 10
})

mcp_orchestrator_git_get_pr({
  owner: "herrbasan", repo: "mcp_server", number: 5
})
```

### `git_issue_list` / `git_get_issue`
List or get details of issues (with optional comments).

```javascript
mcp_orchestrator_git_issue_list({
  owner: "herrbasan", repo: "mcp_server", state: "open", labels: "bug"
})

mcp_orchestrator_git_get_issue({
  owner: "herrbasan", repo: "mcp_server", number: 3,
  comments: true    // include issue comments
})
```

### `git_create_issue`
Create a new issue in a GitHub repo.

```javascript
mcp_orchestrator_git_create_issue({
  owner: "herrbasan",
  repo: "mcp_server",
  title: "Bug: something broken",
  body: "Description of the issue...",
  labels: ["bug"],
  assignees: ["herrbasan"]
})
```

---

## Code Inspector Module (1 tool) — continued

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

---

## Documentation Module (2 tools)

> Access MCP orchestrator documentation

### `get_philosophy`
Get the coding philosophy document. **⚠️ START HERE** when working with this codebase.

```javascript
mcp_orchestrator_get_philosophy()
// Returns: Deterministic mind principles (33 lines)
```

### `get_orchestrator_doc`
Get the full tools reference guide (this document).

```javascript
mcp_orchestrator_get_orchestrator_doc()
// Returns: Complete tools reference (35+ tools)
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

## Performance Notes

| Tool | Typical Time | Notes |
|------|--------------|-------|
| `git_read_file` | 0.5-2s | GitHub API call |
| `git_list_tree` | 1-3s | Recursive tree, may be truncated for large repos |
| `git_search_code` | 1-3s | GitHub search API |
| `research_topic` | 12-45s | Depends on pages scraped |
| `query_model` | 2-10s | Depends on model & tokens |
| `vision_analyze` | 3-15s | Depends on image size and model |







