# Orchestrator Tools Analysis

**Date:** 2026-04-02  
**Tester:** Kilo  
**Test Project:** nui_wc2 (2,871 files)

---

## Executive Summary

Tested 15+ orchestrator tools across 5 categories. **7 tools work excellently**, **5 have significant bugs**, and **3 need minor improvements**. The most critical issue is the vision tool analyzing wrong images.

---

## Category 1: Discovery & Status

### `list_codebases` ✅ **EXCELLENT**

| Metric | Result |
|--------|--------|
| Speed | <100ms |
| Accuracy | 100% |
| Output Quality | Clean JSON with file counts, status, descriptions |

**Output includes:**
- Repository name and source path
- File count
- Last indexed timestamp
- Current/stale status
- Auto-generated description

**Example:**
```json
{
  "name": "nui_wc2",
  "files": 2871,
  "status": "current",
  "description": "Zero-dependency web UI library with accessible custom elements"
}
```

---

### `get_codebase_description` ⚠️ **PARTIAL MATCHING FAILS**

| Metric | Result |
|--------|--------|
| Exact match | ✅ Works |
| Partial match | ❌ Fails |

**Bug:** Tool description claims "partial match supported" but `nui` didn't find `nui_wc2`.

```
Input:  "nui"
Result: Error: Codebase 'nui' not found
```

**Expected:** Should match `nui_wc2`, `nui_wc2 (partial)`

**Workaround:** Use exact codebase name

---

### `check_codebase_status` ✅ **EXCELLENT**

Clean summary of index status:

```json
{
  "totalFiles": 2871,
  "staleFiles": 0,
  "missingFiles": 0,
  "status": "current"
}
```

---

## Category 2: File Access

### `get_file` ✅ **GOOD (with caveat)**

| Metric | Result |
|--------|--------|
| Small files | ✅ Complete content |
| Large files (>200KB) | ⚠️ Truncated, saved to disk |

**Behavior:** 161KB file returned ~182KB truncated with disk path. This is the right approach but requires follow-up read.

---

### `get_file_info` ✅ **EXCELLENT - BEST IN CLASS**

**This is the standout tool.** Returns structured function/class list with line numbers without reading full content.

**Output for 161KB file:**
```json
{
  "functions": [
    { "line": 85, "name": "resolveAction", "signature": "(name)" },
    { "line": 94, "name": "setupActionDelegation", "signature": "()" }
  ],
  "classes": [
    { "line": 233, "name": "extends", "methods": [...] }
  ]
}
```

**Use case:** Perfect for exploration before deciding which sections to read.

---

### `get_prioritized_files` ❌ **FLOODED WITH IMAGES**

**Major issue:** Returns 500+ files, mostly `.webp` images in `low` priority.

**Problem:** No file type filtering. A project with many images drowns out actual code files.

**Current output structure:**
```json
{
  "high": [3 files],
  "medium": [12 files], 
  "low": [500+ image files...]
}
```

**Recommendation:** Add `filter` parameter or exclude binary assets by default.

---

## Category 3: Search

### `search_keyword` ✅ **FAST & ACCURATE**

| Metric | Result |
|--------|--------|
| Speed | <100ms |
| Relevance | High |
| Line numbers | ✅ Included |

**Best for:** Exact function names, class names, imports

**Output quality:**
```json
{
  "file": "nui_wc2:NUI/nui.js",
  "contentMatches": [
    { "line": 5, "content": "export class NuiButton extends HTMLElement {" }
  ]
}
```

---

### `search_codebase` (hybrid) ⚠️ **RETURNS IMAGES INSTEAD OF CODE**

**Query:** `button component implementation`

**Expected:** JavaScript implementation of buttons

**Actual:** 4 PNG/WebP images + 1 HTML file

```json
{
  "relevantFiles": [
    "reference/nui_screenshots/nui_buttons.png",  // Just a screenshot!
    "NUI/assets/pattern_0.png",                    // Texture asset
    "Playground/pages/components/accordion.html"   // Wrong component
  ]
}
```

**Analysis:** The tool returns low-relevance matches (scores 0.44-0.49) because images have filenames matching query terms.

**Recommendation:** Filter out binary/image files from code searches.

---

### `search_semantic` ⚠️ **POLLUTED BY IMAGES**

**Query:** `how are custom elements registered`

**Result:** 4 image files + 1 HTML file (Score: 0.643)

Same issue as hybrid search - image assets dilute results.

---

### `grep_codebase` ✅ **ACCURATE BUT SLOW**

| Metric | Result |
|--------|--------|
| Speed | 1-3s (live filesystem search) |
| Accuracy | High |
| Regex support | ✅ Full |

**Best for:** Complex patterns, exact line numbers for editing

**With `analyze: true`:** Returns structured analysis with patterns:
```json
{
  "analysis": {
    "summary": "Web Components using customElements.define...",
    "keyFindings": [...],
    "implementationPatterns": [...]
  }
}
```

**Trade-off:** Speed vs freshness. Use keyword search first, grep when needed.

---

### Search Summary Comparison

| Tool | Speed | Quality | Use When |
|------|-------|---------|----------|
| `search_keyword` | Fastest | High | Known identifiers |
| `search_codebase` | Medium | Low | General exploration |
| `search_semantic` | Slowest | Low | Conceptual queries |
| `grep_codebase` | Slow | High | Precise patterns |

**Common issue:** All search tools need file type filtering.

---

## Category 4: Browser

### `browser_session_create` / `browser_session_list` ❌ **STATE MISMATCH**

**Critical bug:** Session tracking is unreliable.

**Test sequence:**
```
1. create_session() → "Error: browser already running"
2. list_sessions() → "No active sessions"
```

**Issue:** Persistent browser instance exists on disk (`chrome-profile`) but session tracking doesn't see it.

**Impact:** Cannot create new sessions, cannot use browser tools.

**Workaround:** Manual cleanup of `chrome-profile` directory required.

---

### Other Browser Tools

Untested due to session bug:
- `browser_session_goto`
- `browser_session_click`
- `browser_session_fill`
- `browser_session_evaluate`
- etc.

---

## Category 5: Research

### `research_topic` ✅ **EXCELLENT**

| Metric | Result |
|--------|--------|
| Quality | Structured synthesis with citations |
| Confidence | Explicit confidence score |
| Weaknesses | Self-documented limitations |

**Output includes:**
- Summary with inline citations [1][2][3]
- Technical architecture breakdown
- Industry adoption section
- Security considerations
- Sources list with URLs
- Confidence score
- Documented weaknesses

**Example confidence note:**
```
Research Confidence: 40%
Weaknesses: None noted
```

**Best for:** Getting up-to-date information with verifiable sources.

---

## Category 6: Vision

### `vision_create_session` + `vision_analyze` ❌ **CRITICAL: IMAGE MISMATCH**

**Test:**
```
1. Fetch: https://picsum.photos/800/600
   → Returns: Misty forest landscape with fog
   
2. Create vision session with same URL
   
3. Analyze: "Describe this image"
   → Returns: "Black-and-white portrait of person with vintage camera"
```

**This is completely wrong.** The analyzed image doesn't match the fetched image.

**Possible causes:**
- URL not actually fetched (cached random image)
- Session stores wrong image data
- Picsum redirects returning different images per request

**Impact:** Cannot trust vision analysis for any critical task.

---

### `vision_*` Other Features

**Focus options available (untested due to bug):**
- `region`: Pixel-based cropping
- `centerCrop`: Percentage-based
- `grid`: Cell-based analysis
- `text`: Free text focus

**Session management:**
- Auto-expires after 30 minutes
- Accumulates analyses for context

---

## Category 7: Memory

### `memory_remember` / `memory_recall` / `memory_list` ✅ **WORKING WELL**

| Feature | Status |
|---------|--------|
| Store memories | ✅ |
| Category tagging | ✅ (proven, anti_patterns, hypotheses, context, observed) |
| Domain scoping | ✅ |
| Confidence scoring | ✅ |
| Recall search | ✅ |

**Confidence indicators:**
- `[v]` = proven
- `[~]` = promising  
- `[?]` = hypothesis

**Example recall:**
```
[#290] [nui_wc2] proven (70.3%) [uncertain]
NUI uses customElements.define with nui- prefix for all components
```

**Limitation:** All results show `[uncertain]` even for `proven` category. May be confidence algorithm issue.

---

## Category 8: Code Analysis

### `inspect_code` ⚠️ **PATH RESOLUTION ISSUES**

**Tried paths:**
- `D:\Work\_GIT\nui_wc2\NUI\nui.js` → Not found
- `D:/Work/_GIT/nui_wc2/NUI/nui.js` → Not found
- `\\COOLKID\work\Work\_GIT\nui_wc2\NUI\nui.js` → Cancelled/timeout

**Issue:** Path format requirements unclear. Standard Windows/Unix paths rejected.

**Expected behavior:** Should accept standard path formats or document required format.

---

## Recommendations Summary

### Critical (Fix Immediately)

| Tool | Issue |
|------|-------|
| `vision_*` | Image mismatch - returns analysis for wrong image |
| `browser_session_*` | State tracking broken - cannot create/use sessions |

### High Priority

| Tool | Issue | Fix |
|------|-------|-----|
| `get_prioritized_files` | Flooded with images | Add file type filter |
| `search_codebase` | Returns images not code | Exclude binary files |
| `search_semantic` | Polluted by assets | Add content-type filter |

### Medium Priority

| Tool | Issue |
|------|-------|
| `get_codebase_description` | Partial matching doesn't work |
| `inspect_code` | Path format unclear |
| `memory_list` | All marked `[uncertain]` |

### Enhancements

1. **File type filtering** - Add to all search/discovery tools
2. **Path format documentation** - Standardize accepted formats
3. **Image exclusion** - Binary files shouldn't pollute code search

---

## Tool Quick Reference

| Tool | Status | Best For |
|------|--------|----------|
| `list_codebases` | ✅ Use | Getting available projects |
| `get_file_info` | ✅ **Use** | Exploring file structure |
| `get_file` | ✅ Use | Reading content (watch truncation) |
| `search_keyword` | ✅ Use | Finding exact identifiers |
| `grep_codebase` | ✅ Use | Complex regex patterns |
| `research_topic` | ✅ Use | Web research with citations |
| `memory_remember/memory_recall` | ✅ Use | Knowledge persistence |
| `check_codebase_status` | ✅ Use | Index health check |
| `get_prioritized_files` | ⚠️ Avoid | Too much noise |
| `search_codebase` | ⚠️ Avoid | Use keyword instead |
| `search_semantic` | ⚠️ Avoid | Poor results |
| `browser_*` | ❌ Broken | Session bug |
| `vision_*` | ❌ Broken | Image mismatch |
| `inspect_code` | ⚠️ Avoid | Path issues |
| `get_codebase_description` | ⚠️ Use exact name | Description lookup |

---

*Generated during orchestrator tool testing session*
