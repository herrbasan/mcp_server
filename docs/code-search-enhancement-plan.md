# Code Search Enhancement Plan

**Status:** Complete  
**Goal:** Simplify code tools, improve UX, remove unpredictable autonomous behavior

---

## Summary of Changes

### Module Restructure

| Old | New | Purpose |
|-----|-----|---------|
| `local-agent.js` | `code-inspector.js` | LLM-based code analysis only |
| `code-search/server.js` | `code-search/server.js` | Discovery, retrieval, and exploration |

### Domain Separation

**`code-search`** - Discovery & Retrieval:
- `search_semantic` / `search_keyword` / `search_code`
- `search_files` (glob patterns)
- `peek_file` - One-step file access
- `retrieve_file` - Partial file retrieval
- `get_context` - Smart context expansion
- `get_file_tree` - Directory exploration
- `get_function_tree` - Symbol outline
- `get_file_info` - Metadata with line numbers
- `refresh_index` / `refresh_all_indexes`

**`code-inspector`** - LLM Analysis:
- `inspect_code` - Analyze files or code snippets with LLM

---

## inspect_code API

```javascript
// File-based inspection
inspect_code({
  target: "fc745a690e4db10279c18241a0a572c7",  // 32-char hash ID from search
  question: "Explain this code"
})

// Direct code inspection
inspect_code({
  code: "function sum(a, b) { return a + b; }",
  question: "Is this correct?"
})
```

---

## Implementation Checklist

- [x] Remove `run_local_agent` tool (unpredictable)
- [x] Add `code` parameter to `inspect_code`
- [x] Add `peek_file` tool
- [x] Add `get_context` tool
- [x] Auto-search all workspaces (remove workspace requirement)
- [x] Add `get_file_tree` tool
- [x] Add `get_function_tree` tool
- [x] Move `retrieve_file` to `code-search`
- [x] Rename `local-agent.js` → `code-inspector.js`
- [x] Update `http-server.js` imports
- [ ] Update tests
- [x] Update config.json (rename `local-agent` to `code-inspector`)

---

## Rationale

**Why drop `run_local_agent`?**
- Unpredictable behavior - can't verify what files it will analyze
- Broken path format in retrieval plans
- High token usage with uncertain value
- Explicit tools (`search` → `inspect`) are clearer

**Why separate domains?**
- `code-search`: Fast operations (index-based, no LLM)
- `code-inspector`: LLM-powered analysis (slower, intentional)
- Clear mental model: Find → Retrieve → Analyze

---

## Migration Guide

**Old workflow:**
```javascript
search_semantic({ query: "authentication flow" })  // Searches all workspaces
```

**New workflow:**
```javascript
// Step 1: Find (code-search)
const results = search_semantic({ query: "authentication flow" })

// Step 2: Inspect (code-inspector)
inspect_code({
  target: results[0].file_id,
  question: "Explain this authentication code"
})
```

More explicit, more predictable, same result.
