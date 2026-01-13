# AI Contribution Notes

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
