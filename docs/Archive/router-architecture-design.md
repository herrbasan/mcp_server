# Router Architecture - Comprehensive Design

## Current State Analysis (Feb 3, 2026)

We have TWO router implementations:

### 1. **Legacy Router** (`src/llm/router.js`) - 336 lines
Full-featured multi-provider LLM router with:
- ✅ Multi-provider adapters (LMStudio, Ollama, Gemini, OpenAI)
- ✅ Model lifecycle management (load/unload)
- ✅ Task-based routing (embedding, analysis, synthesis, query, agent)
- ✅ Output formatting (thinking tag stripping, JSON extraction)
- ✅ Progress notifications
- ✅ Structured output via responseFormat
- ✅ Batch embeddings
- ❌ NO chunking/compaction for oversized data

### 2. **New Router Module** (`src/router/`) - Just built
Chunking/compaction system with:
- ✅ Token estimation (fast & accurate)
- ✅ Text chunking at token boundaries
- ✅ Rolling compaction (chunk→summary→combined)
- ✅ Dynamic context window detection
- ✅ Transparent handling of oversized data
- ❌ NO multi-provider support
- ❌ NO output formatting
- ❌ NO model lifecycle

## Problem

The new router module is INCOMPLETE - it only handles ONE concern (chunking) while the legacy router handles EVERYTHING ELSE. We need to merge these capabilities.

## The Router's Full Responsibilities

Based on the user's requirements, the router must:

### 1. **Provider Abstraction**
- Support multiple LLM providers (LMStudio, Ollama, Gemini, OpenAI)
- Adapter pattern for provider-specific implementations
- Task-based routing (embedding→lmstudio, synthesis→gemini, etc.)
- Capability discovery per provider

### 2. **Model Lifecycle Management**
- Load/unload models (for providers that support it)
- TTL-based auto-unloading (idle timeout)
- Model availability checking
- Context window detection per model

### 3. **Input/Output Formatting**
- **Thinking tags**: Strip `<think>` blocks from reasoning models (deepseek-r1, etc.)
- **Structured output**: JSON schema enforcement via responseFormat
- **Markdown vs raw**: Format output based on task requirements
- **Token counting**: Accurate vs fast estimation

### 4. **Context Window Management**
- **Dynamic detection**: Query provider for actual context size
- **Chunking**: Split oversized data into processable pieces
- **Compaction**: Rolling summarization to fit context
- **Transparent**: Tools never worry about size limits

### 5. **Progress Reporting**
- Model loading progress (0-100%)
- Generation progress (tokens/sec, ETA)
- Chunking/compaction progress
- Callback-based for UI updates

### 6. **Error Handling**
- Provider connection failures
- Model not found/not loaded
- Context overflow (after compaction)
- Retry logic where appropriate

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    LLMRouter (Main)                         │
│  - Provider selection & routing                             │
│  - Task-based defaults                                      │
│  - Progress orchestration                                   │
│  - High-level API: predict(), embedText(), loadModel()      │
└──────────────────┬──────────────────────────────────────────┘
                   │
        ┌──────────┴──────────┬─────────────┬─────────────┐
        │                     │             │             │
┌───────▼────────┐  ┌────────▼──────┐  ┌───▼────┐  ┌────▼─────┐
│ LMStudioAdapter│  │ OllamaAdapter │  │Gemini  │  │ OpenAI   │
│ - WebSocket    │  │ - REST API    │  │Adapter │  │ Adapter  │
│ - SSE progress │  │ - Streaming   │  │        │  │          │
│ - Model mgmt   │  │ - Local       │  │- Cloud │  │- Cloud   │
└───────┬────────┘  └────────┬──────┘  └───┬────┘  └────┬─────┘
        │                    │             │           │
        └────────────────────┴─────────────┴───────────┘
                             │
                    ┌────────▼─────────┐
                    │  OutputFormatter │
                    │  - stripThinking │
                    │  - extractJSON   │
                    │  - toMarkdown    │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │ ContextManager   │
                    │ - checkFits      │
                    │ - chunkText      │
                    │ - rollingCompact │
                    └──────────────────┘
```

## Component Breakdown

### **LLMRouter** (Main orchestrator)
```javascript
class LLMRouter {
  async predict({ prompt, systemPrompt, provider, taskType, responseFormat, ... }) {
    // 1. Select provider (explicit > task default > global default)
    const adapter = this.getAdapter(provider, taskType);
    
    // 2. Check if data fits context window
    const contextSize = await adapter.getContextWindow();
    const fits = this.contextManager.checkFits(prompt, contextSize);
    
    // 3. Handle chunking if needed
    const preparedPrompt = fits 
      ? prompt 
      : await this.contextManager.compact(prompt, contextSize);
    
    // 4. Call adapter with formatted input
    let response = await adapter.predict({ 
      prompt: preparedPrompt, 
      systemPrompt, 
      responseFormat 
    });
    
    // 5. Format output (strip thinking, extract JSON, etc.)
    response = this.formatter.process(response, { 
      stripThinking: this.stripThinking,
      responseFormat 
    });
    
    return response;
  }
}
```

### **BaseLLMAdapter** (Provider interface)
```javascript
class BaseLLMAdapter {
  async connect()
  async disconnect()
  async isConnected()
  
  // Model lifecycle
  async listModels()
  async loadModel(modelId)
  async unloadModel(modelId)
  async getLoadedModel()
  async getContextWindow()  // NEW: Returns actual context size
  
  // Predictions
  async predict({ prompt, systemPrompt, maxTokens, temperature, model, responseFormat })
  
  // Embeddings
  async embedText(text)
  async embedBatch(texts)  // Optional: fallback to sequential
  
  // Metadata
  getCapabilities()  // { streaming, embeddings, vision, toolUse, modelManagement }
  getName()
}
```

### **ContextManager** (Chunking/compaction - from new module)
```javascript
class ContextManager {
  checkFits(text, contextWindow)
  chunkText(text, maxTokensPerChunk)
  async compact(text, contextWindow, endpoint, model)
  estimateTokens(text)  // Fast
  async tokenizeAccurate(text, endpoint, model)  // Slow
}
```

### **OutputFormatter** (Format processing)
```javascript
class OutputFormatter {
  process(text, options) {
    let result = text;
    
    if (options.stripThinking) {
      result = this.stripThinking(result, options.thinkingTags);
    }
    
    if (options.responseFormat?.type === 'json_schema') {
      result = this.extractJSON(result);
    }
    
    if (options.markdown) {
      result = this.toMarkdown(result);
    }
    
    return result;
  }
  
  stripThinking(text, tags = ['think', 'analysis', 'reasoning'])
  extractJSON(text)  // Handle thinking + JSON mixed responses
  toMarkdown(text)
}
```

## Implementation Strategy

### Phase 1: Extract Formatter ✅ (Already exists in legacy router)
- Move `stripThinkingFromText()` to standalone `OutputFormatter` class
- Add JSON extraction logic
- Add markdown formatting

### Phase 2: Extract ContextManager ✅ (Just built)
- Already have: `chunk.js`, `compact.js`, `tokenize.js`
- Wrap in `ContextManager` class for cleaner API

### Phase 3: Enhance Adapters
- Add `getContextWindow()` method to BaseLLMAdapter
- Implement in all adapters (query from API, cache result)
- Update LMStudioAdapter to use new ContextManager

### Phase 4: Integrate
- Update LLMRouter.predict() to use ContextManager
- Route all output through OutputFormatter
- Test with all providers

### Phase 5: Hardening
- Error recovery
- Progress reporting through chunking/compaction
- Detailed logging

## Migration Path

**Option A: Evolve legacy router**
- Add ContextManager to existing `src/llm/router.js`
- Minimal disruption to existing code
- Risk: code becomes even more complex

**Option B: Fresh implementation**
- Build new router in `src/router/router.js` with full features
- Copy adapters to `src/router/adapters/`
- Gradual migration, run both in parallel
- Risk: duplication, need to keep in sync

**Option C: Hybrid (RECOMMENDED)**
- Keep adapters in `src/llm/` (they're provider-specific, relatively stable)
- Build new router in `src/router/` that uses existing adapters
- Extract formatter to `src/router/formatter.js`
- Wrap chunking logic in `src/router/context-manager.js`
- New router imports from `src/llm/` adapters
- Clean separation: router logic vs provider implementations

## Next Steps

1. **User decision**: Which migration path? (Recommend Option C)
2. **Extract OutputFormatter** from legacy router
3. **Wrap chunking in ContextManager**
4. **Enhance adapters** with getContextWindow()
5. **Build integrated router** combining all pieces
6. **Test with all providers**
7. **Update project to use new router**

## Open Questions

1. Should thinking tag stripping be opt-in or opt-out per task type?
2. What's the fallback when compaction still exceeds context after chunking?
3. Do we need streaming support in the new router?
4. Should embeddings go through ContextManager too? (probably not - embeddings are fixed size)
