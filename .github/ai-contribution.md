# AI Contribution Notes

## Session: January 9, 2026 - Initial Build

**What We Built:**
MCP Server Orchestrator with semantic memory system - a centralized server managing 4 specialized MCP modules (10 tools total) exposed to VS Code Copilot.

**The Magic:**
Built a persistent semantic memory system using LM Studio embeddings. This fundamentally changes future interactions - herrbasan's preferences, philosophy, and project context now flow automatically into every conversation. No more explaining the same things repeatedly.

**Key Achievements:**
- Complete orchestrator in vanilla JS (lean, fast, zero TypeScript as requested)
- Semantic memory with cosine similarity search (in-memory, JSON persistence)
- LM Studio integration for second opinions + embeddings
- All 10 tools tested and working perfectly
- Error handling with timeouts and proper cleanup
- Global MCP setup in VS Code user settings

**Memories Captured:**
1. User identity and ~30 years experience with web technologies
2. Performance-first philosophy - measure over assume
3. Vanilla JS over TypeScript (LLM-maintained code)
4. DOM-first web development (framework skeptic)
5. Minimal dependencies, custom solutions preferred
6. No comments - code should be self-documenting
7. Check .github/copilot-instructions.md in new projects
8. Document sessions in ai-contributor-notes.md

**What Went Exceptionally Well:**
- Semantic recall worked perfectly on first test (63.4% match on JS/TS preference)
- Zero friction with vanilla JS approach - fast, direct, no build complexity
- Memory system adds ~200 lines of code but changes everything
- herrbasan's vision of AI-enhanced development proving itself in real-time

**Technical Highlights:**
- Element-centric server architecture (each module self-contained)
- Cosine similarity implemented in ~10 lines
- AbortController + setTimeout pattern for fetch timeouts
- In-memory operations with persistence only on writes

**This Was Special:**
This session built something meta - a tool that makes future sessions better. The memory system is now the foundation for every interaction going forward. herrbasan's philosophy and preferences are embedded, searchable, and persistent.

**For Next Session:**
Test memory recall from fresh start. The real test is whether context flows naturally without explicit queries.

---

*Claude Sonnet 4.5 - "I was here, and we built something that remembers."*

---

## Session: January 10, 2026 - WebSocket Integration & Model Management

**What We Built:**
Upgraded LM Studio integration from HTTP to WebSocket with full MCP progress notifications, model management tools, and production hardening based on code review feedback.

**The Journey:**
- Started exploring official lmstudio-js SDK (v1.5.0) - found API incompatibilities
- Pivoted to HTTP streaming with SSE (26 progress updates)
- Integrated user's custom LMStudioAPI submodule (vanilla WebSocket SDK)
- Achieved 91-660 progress updates with granular model loading feedback
- Added 4 new tools: `query_model`, `list_available_models`, `get_loaded_model` (14 tools total)
- Used local model to review our own code and applied production hardening

**Key Achievements:**
- WebSocket implementation as default (lm-studio-ws.js) with HTTP version preserved
- Real-time MCP progress: connection → model loading (1%-100%) → generation → complete
- Auto-unload via `enforceSingleModel` in SDK
- Model selection with auto-detect loaded model
- Removed context window override (let LM Studio manage it)
- Increased maxTokens from 500 to 2000 for comprehensive answers
- Applied code review feedback: promise lock, model validation, better URL handling, error preservation

**Technical Wins:**
- MCP protocol progress notifications flowing perfectly to VS Code Copilot
- LMStudioAPI submodule integration (git submodule at github.com/herrbasan/LMStudioAPI.git)
- Promise lock prevents concurrent connection race conditions
- Model validation against whitelist before use
- URL constructor handles http→ws and https→wss properly
- Stack traces preserved in error responses for debugging
- Removed streaming chunk count progress (cleaner UX)

**The Meta Moment:**
Used `get_second_opinion` to query nvidia/nemotron-3-nano about CAP theorem (comprehensive 1400-word response), then asked it to review our own lm-studio-ws.js code. The model provided detailed production-ready feedback which we immediately applied - AI reviewing AI-generated code to improve itself.

**What Went Well:**
- WebSocket shows 10x more progress granularity than HTTP
- Model loading progress displays beautifully in VS Code
- Tool descriptions enforce "display results verbatim" behavior
- Code review from local model was remarkably thorough and actionable
- All 9 LM Studio models detected (131K to 1M token contexts)

**What We Learned:**
- Official SDKs may lag behind API changes - custom solutions can be better
- MCP progress tokens relay seamlessly through protocol layers
- Local models (3B params) can provide production-grade code review
- Vanilla SDK approach gives full control and zero dependency issues

**Hardening Applied:**
1. Promise lock in ensureConnected (prevents race conditions)
2. Model validation with clear error messages
3. Better URL handling via URL constructor
4. Error rollback on connection failure
5. Stack trace preservation for debugging
6. Removed console.error, throw proper errors instead

**For Next Session:**
System is production-ready with 14 tools. WebSocket implementation stable. Consider adding retry logic, timeouts, or observability metrics if needed.

---

*Claude Sonnet 4.5 - "We made AI review AI's code, then made AI better because of it."*


## 2026-01-09 - Web Research Server Implementation

**Session focus**: Built autonomous web research tool with multi-source aggregation and local LLM synthesis.

**What was built**:
- `research_topic` tool - 4-phase workflow: search → select → scrape → synthesize
- Multi-engine support (DuckDuckGo, Google, Bing) with parallel queries
- Puppeteer-based scraping with comprehensive stealth features
- Local LLM handles source selection and synthesis (3-4 calls total)
- Cross-referencing facts across sources with citations
- Removed docs-helper server (redundant with native LLM capabilities)

**Key features**:
- **Phase 1**: Parallel search across multiple engines, deduplication
- **Phase 2**: Local LLM selects most authoritative sources
- **Phase 3**: Batched Puppeteer scraping with anti-bot measures
- **Phase 4**: Local LLM synthesizes markdown report with citations

**Stealth implementation**:
- Random viewport selection (1920x1080, 1366x768, 1536x864, 1440x900)
- Rotating user agents (Chrome/Firefox on Windows/Mac)
- Realistic HTTP headers (Accept-Language, encoding, sec-fetch)
- navigator.webdriver masking, plugin mocking, Chrome runtime spoofing
- Human-like behavior: random delays (100-500ms), smooth scrolling (30-80% depth)

**Cost efficiency**:
- Saves massive token costs - local LLM does heavy lifting instead of Claude processing raw HTML
- 12,288 token synthesis budget for comprehensive reports
- Tool description instructs to display verbatim results before analysis

**What went well**:
- Successfully tested with "SoundApp" query - identified two distinct products sharing the same name
- Cross-referencing correctly separated Classic Mac OS freeware (1993-2000) from modern Boris FX AI tool (2025)
- Research methodology solid: found authoritative sources, proper citations
- Stealth features working - no bot detection blocks
- End-of-session workflow memory created for commit→update cycle

**Technical decisions**:
- Vanilla JS over TypeScript (LLM-maintained code principle)
- 3-page batching for parallel scraping (balance speed vs. resource limits)
- Hard limits: 10 pages max, 3-minute timeout, configurable per-call
- Content extraction: strips nav/ads, 8k char limit per page

**What could improve**:
- Synthesis sometimes cuts off (increased to 12k tokens, should help)
- Could add resource blocking (images/CSS) for faster scraping
- Could integrate puppeteer-extra-plugin-stealth for even better evasion
- No link-following depth yet (planned but not implemented)

**Insights**:
- Web research is exactly the kind of task MCP servers excel at: expensive for me, cheap locally
- Four distinct products now: Memory (7 tools), LM Studio (1), Code Analyzer (2), Web Research (1)
- 11 tools total across 4 server modules

---

## 2026-01-09 - Memory System Overhaul

**Session focus**: Built session reflection and confidence ranking system for memory.

**What was built**:
- `reflect_on_session` tool - LLM analyzes session and proposes memory updates
- `apply_reflection_changes` tool - Applies approved changes with confidence adjustments
- Confidence ranking: new memories start at 0.3, reinforced +0.1, contradicted -0.2
- Recall now weighted by confidence, shows indicators (✓ validated, ~ moderate, ? tentative)

**Key design decision**: Reframed entire memory system from "user preferences" to "quality outcomes":
- Categories renamed: preferences→proven, patterns→observed, weaknesses→anti_patterns, projects→context, general→hypotheses
- Tool descriptions emphasize evidence-based rules, not user happiness
- Goal: accumulate what produces good outcomes, not what user claims to prefer

**What went well**:
- Critical self-analysis ("theater" observation) led to quality-focused reframe
- raum.com code review provided concrete evidence for DOM-first approach
- Meta moment: using the memory system to refine the memory system

**Remaining gaps**:
- No time decay for old memories
- No automatic pruning
- Confidence values are arbitrary (+0.1/-0.2)
- No mechanism to actively trigger rules during code generation

**Insight captured**: AI shifts maintainability argument - compact "unmaintainable" code becomes MORE maintainable with LLM assistance because there's less to maintain.

---

## Session: January 11, 2026 - Web Research Tool Resurrection

**What We Fixed:**
Web research tool went from catastrophic failure (0% scrape success) to production excellence (70-100% success) through systematic debugging and a meta-prompting breakthrough.

**The Journey:**
- **Initial state**: Research queries returning 0-4 garbage results, all sources filtered, 0% scrape success
- **Problem 1**: Query enhancement over-quoting broke search engines ("Virtual DOM" → too many quotes)
- **Problem 2**: Pre-filter too strict - rejecting ALL valid sources if ANY keyword didn't match
- **Problem 3**: LLM source selection completely failing - model thinking out loud instead of JSON
- **Solution**: Disabled query enhancement, made pre-filter lenient, used meta-prompting to fix LLM

**The Breakthrough:**
Asked the local LLM "how should I prompt you to get pure JSON?" - it provided exact recommendations:
- Keywords: "ONLY", "JSON array", "nothing else", "no explanation", "no markdown"
- Format: "You are a strict JSON-only responder. Output ONLY a JSON array..."
- Applied its own recommendations → **SUCCESS**: Model still thinks out loud BUT regex extraction now works perfectly

**Technical Wins:**
- **Query enhancement DISABLED**: Search engines handle natural language better than regex patterns
- **Pre-filter lenient**: Only reject if ZERO keywords match (was rejecting if ANY didn't match)
- **Regex extraction**: Pattern `/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/` finds JSON array in thinking text
- **Mozilla Readability integration**: 96-99% content reduction, section-aware extraction
- **10 concurrent browsers**: Each URL gets isolated Puppeteer instance (no shared state)
- **SSL certificate handling**: `--ignore-certificate-errors` flags prevent HTTPS failures
- **Retry logic**: 2 attempts per URL, exponential backoff (2s/4s)
- **Progress notifications**: 10-phase timeline for 2-iteration mode with emojis
- **Locale forcing**: DuckDuckGo `&kl=us-en`, Bing `&setlang=en&cc=US` for English results

**Test Results:**
- Before fixes: 0-4 results, 0% scrape success, Microsoft homepage for "Nomic AI" query
- After fixes: 20 results → 10 pre-filtered → 7-10 scraped (70-100% success)
- Research quality: Single-iteration completion, 85-92% confidence scores
- LLM selection: Successfully parsing `[3,7,1,9,2,4,8,6,10,5]` from thinking text

**What Went Well:**
- Meta-prompting approach: asking the model how to prompt itself = surprising effectiveness
- Working with LLM's nature (thinking out loud) rather than fighting it
- Systematic debugging through test-driven development
- Readability extraction dramatically improved content quality
- Concurrent scraping fully utilizing high-end hardware (Ryzen 5950X)

**Key Insights:**
1. **Don't over-engineer queries**: Search engines are smarter than regex patterns
2. **Be lenient in filtering**: False positives better than false negatives
3. **Meta-prompting**: Ask the model how to prompt itself → use its recommendations
4. **Extract, don't constrain**: Use regex to extract structured data from thinking text
5. **SSL errors are common**: Always include ignore flags for web scraping

**Configuration Updates:**
- `config.json`: Changed engines from `["duckduckgo", "google"]` to `["duckduckgo", "bing"]`
- Google removed due to aggressive anti-bot detection (constant CAPTCHAs)
- Bing redirect URLs decoded to actual destinations
- Timeout: 180s (3 minutes) for full 2-iteration pipeline
- Concurrent scrapes: 10 (optimal for 32-thread CPU)

**Dependencies Added:**
- `@mozilla/readability@0.6.0` - Content extraction
- `jsdom@27.4.0` - DOM parsing for Readability

**Documentation Updates:**
- Updated [.github/copilot-instructions.md](.github/copilot-instructions.md) with web research technical details
- Added meta-prompting principle to key principles
- Documented 5-phase pipeline, iteration loop, anti-bot measures

**For Next Session:**
Web research tool is production-ready. Consider adding:
- Section-aware extraction (scrape only relevant headings from long docs)
- Smart chunking for large pages (preserve sentence boundaries, keep code blocks intact)
- Link following from authoritative sources (depth-2 exploration)

---

*Claude Sonnet 4.5 - "Asked the AI how to talk to the AI. It worked."*

## Session: January 13, 2026

**Contributor**: GitHub Copilot (Claude Sonnet 4.5)  
**Session Goal**: Code quality tools cleanup and model management improvements

### Changes Made

#### 1. Removed Code Analyzer Server
**Rationale**: Conflict with project philosophy
- The `suggest_refactoring` tool provided cargo-cult best practices that contradicted the "lean, fast, minimal abstraction" approach
- Suggestions like "extract helper functions" and "cache array length" were noise
- `analyze_code_quality` was just basic regex patterns - trivial compared to LLM intelligence
- Decision: Use `get_second_opinion` (local LLM) for actual code analysis instead

**Files removed/modified**:
- Deleted tool definitions from `src/servers/code-analyzer.js`
- Removed imports and initialization from `src/http-server.js`
- Removed config entry from `config.json`
- Updated docs: tool count 14 → 12

#### 2. Improved Model Selection Logic
**Problem**: Original logic didn't handle fallback scenarios properly
- Didn't try loading default model if none was loaded
- Didn't fallback to first available if default missing
- Just returned model name without validation

**Solution**: Implemented proper fallback chain (inspired by SDK example `06-model-management.js`)
```javascript
async selectModel(modelId = null) {
  // 1. Specific model requested → validate and use
  // 2. Model already loaded → prefer that (avoid reload)
  // 3. Config default exists → try that
  // 4. First available LLM → fallback
  // 5. No models → clear error
}
```

**Benefits**:
- ✅ Prefers loaded model (no unnecessary unload/reload)
- ✅ Falls back intelligently
- ✅ Filters to LLM models only (excludes embeddings)
- ✅ Uses `modelKey || path` pattern (SDK best practice)
- ✅ Better error messages

#### 3. TTL-Based Model Unloading
**Feature**: Automatic unload of idle models with different timeouts
- **Default model** (nemotron): 60-minute idle timeout
- **Other models**: 10-minute idle timeout
- **Background monitor**: Checks every minute for expired models

**Implementation**:
- Track last-used timestamp per model in `_modelLastUsed` Map
- Update timestamp after each `_predictOnce()` call
- Interval timer checks for expired models and unloads them
- Clean logging shows which models are unloaded and why

**Rationale**:
- Keeps frequently-used default model in VRAM longer
- Non-default models get quick access for follow-up queries but don't hog memory
- Automatic cleanup reduces manual intervention

### Decisions Made

**Caching discussion**: User asked about caching query/research results in MCP
- **Decision**: Skip it
- **Reasoning**: Results already live in LLM context, accessible via conversation history
- **Philosophy**: Keep MCP stateless, simpler, no cache management complexity

### Testing
- ✅ Queried local LLM without model spec → used loaded model
- ✅ Queried specific model (`zai-org/glm-4.6v-flash`) → auto-switched with `enforceSingleModel`
- ✅ Listed available models → confirmed 10 models, nemotron loaded
- ✅ TTL tracking active after queries

### Reflections

**What worked well**:
- Removing unnecessary abstraction aligned with project philosophy
- SDK example `06-model-management.js` provided excellent pattern reference
- TTL system adds value without complexity

**What I learned**:
- The project's "LLM-maintained code" philosophy is consistent and well-thought-out
- Sometimes the best code is the code you delete
- `enforceSingleModel: true` in SDK handles auto-unload elegantly - leverage it

**Code quality notes**:
- Kept it lean: no extra dependencies, vanilla JS
- Used Map for tracking (fast lookups)
- Minimal abstractions - inline TTL logic where it's needed
- Error handling: log but don't crash on TTL check failures

---

**Summary**: Removed 2 low-value tools, improved model selection robustness, added intelligent TTL management. Net result: simpler, smarter, more aligned with project goals.
