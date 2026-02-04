# Router Implementation Roadmap - Fresh Build

## Guiding Principles (From SIMPLIFICATION_PLAN.md)

1. **Functional Paradigm**
   - Pure functions with all dependencies as parameters
   - No access to external/global state from within functions
   - Deterministic: same inputs → same outputs
   - Testable in isolation

2. **Specialized Over Generalized**
   - Prefer duplicated simple code over complex abstractions
   - Avoid helper functions with switches/flags
   - If complex AND reused → extract as dedicated module
   - Clarity > DRY when DRY adds complexity

3. **Minimal Dependencies**
   - Build custom solutions over third-party libraries
   - Keep code lean and fast
   - Performance first (code is maintained by LLM)

4. **No JSDoc, Minimal Comments**
   - Function names should be self-explanatory
   - Parameter names should be descriptive
   - Code structure is the source of truth
   - Only comment "why" not "what"
   - JSDoc goes stale and creates confusion
   - Example: `// Conservative: 3 chars/token to avoid underestimation` is useful
   - Example: `@param {string} text - Text to process` is redundant

## What We're Taking From Legacy

### ✅ Good Ideas to Keep
1. **Multi-provider abstraction** - Support LMStudio, Ollama, Gemini, OpenAI
2. **Thinking tag stripping** - The streaming stripper works well
3. **Task-based routing** - embedding→lmstudio, synthesis→gemini
4. **Structured output** - responseFormat with JSON schema
5. **Batch embeddings** - Fallback to sequential if unsupported
6. **Progress callbacks** - For model loading, generation

### ❌ Complexity to Remove
1. **BaseLLMAdapter class** - Over-engineered, use plain functions/objects
2. **Full model lifecycle** - User said "optimize for specific model", simplify
3. **connectAll() method** - Unnecessary, connect on-demand
4. **Capability discovery** - Just hardcode capabilities per provider
5. **Class instances** - Use factory functions returning plain objects

## Fresh Architecture

```
src/router/
├── router.js              # Main orchestrator
├── formatter.js           # Output formatting (thinking, JSON, markdown)
├── context-manager.js     # Chunking/compaction wrapper
├── adapters/
│   ├── lmstudio.js       # LMStudio adapter (pure functions)
│   ├── ollama.js         # Ollama adapter
│   ├── gemini.js         # Gemini adapter
│   └── openai.js         # OpenAI adapter
├── tokenize.js           # ✅ Already exists
├── chunk.js              # ✅ Already exists
├── compact.js            # ✅ Already exists
├── test-router.js        # Integration tests
└── README.md
```

## Component Design

### 1. Adapters (Pure Function Style)

Instead of classes, each adapter is a plain object with functions:

```javascript
// src/router/adapters/lmstudio.js
export function createLMStudioAdapter(config) {
  const { httpEndpoint, model } = config;
  
  return {
    name: 'lmstudio',
    
    async predict({ prompt, systemPrompt, maxTokens, temperature, responseFormat }) {
      // Pure function - all data passed in, no external state
      const response = await fetch(`${httpEndpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ],
          max_tokens: maxTokens || 2000,
          temperature: temperature ?? 0.3,
          response_format: responseFormat
        })
      });
      
      if (!response.ok) {
        throw new Error(`LMStudio predict failed: ${response.status}`);
      }
      
      const data = await response.json();
      return data.choices[0].message.content;
    },
    
    async embedText(text) {
      const response = await fetch(`${httpEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.embeddingModel, input: text })
      });
      
      if (!response.ok) {
        throw new Error(`LMStudio embed failed: ${response.status}`);
      }
      
      const data = await response.json();
      return data.data[0].embedding;
    },
    
    async embedBatch(texts) {
      // LMStudio supports batch
      const response = await fetch(`${httpEndpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.embeddingModel, input: texts })
      });
      
      if (!response.ok) {
        throw new Error(`LMStudio embedBatch failed: ${response.status}`);
      }
      
      const data = await response.json();
      return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    },
    
    async getContextWindow() {
      // Query LM Studio API for actual context
      const response = await fetch(`${httpEndpoint}/api/v1/models`);
      const data = await response.json();
      const loaded = data.models.find(m => 
        m.type === 'llm' && 
        m.loaded_instances?.length > 0 &&
        (m.key === model || m.id === model)
      );
      
      if (!loaded) throw new Error(`Model ${model} not loaded`);
      return loaded.loaded_instances[0].config.context_length;
    },
    
    capabilities: {
      embeddings: true,
      structuredOutput: true,
      batch: true
    }
  };
}
```

**Benefits:**
- No inheritance, no classes, no `this`
- Plain object with functions
- All dependencies injected via config
- Easy to test (just call functions)
- Can add new adapters by copying pattern

### 2. Formatter (Pure Functions)

```javascript
// src/router/formatter.js

export function stripThinking(text, tags = ['think', 'analysis', 'reasoning']) {
  // Copy the working implementation from legacy
  // Pure function: text in → text out
}

export function extractJSON(text) {
  // Handle mixed thinking + JSON responses
  // Try direct JSON.parse, then regex extraction
}

export function formatOutput(text, options) {
  let result = text;
  
  if (options.stripThinking) {
    result = stripThinking(result, options.thinkingTags);
  }
  
  if (options.extractJSON) {
    result = extractJSON(result);
  }
  
  return result;
}
```

### 3. ContextManager (Wrapper Around Existing)

```javascript
// src/router/context-manager.js
import { estimateTokens, tokenizeText } from './tokenize.js';
import { chunkText, checkFits } from './chunk.js';
import { rollingCompact } from './compact.js';

export function createContextManager(config) {
  return {
    checkFits(text, contextWindow, systemPromptTokens = 500, outputBuffer = 2000) {
      const available = contextWindow - systemPromptTokens - outputBuffer;
      return checkFits(text, available);
    },
    
    async compact(text, contextWindow, endpoint, model) {
      const available = contextWindow - 500 - 2000;
      const { chunks } = chunkText(text, available);
      const { summaries } = await rollingCompact(chunks, endpoint, model, 1000);
      return summaries.join('\n\n---\n\n');
    },
    
    estimateTokens(text) {
      return estimateTokens(text);
    }
  };
}
```

### 4. Main Router (Orchestrator)

```javascript
// src/router/router.js

export function createRouter(config) {
  const {
    providers = {},           // { lmstudio: {...}, gemini: {...} }
    taskDefaults = {},        // { embedding: 'lmstudio', synthesis: 'gemini' }
    defaultProvider = 'lmstudio',
    stripThinking = true,
    thinkingTags = ['think', 'analysis', 'reasoning']
  } = config;
  
  // Initialize adapters (factory functions, not classes)
  const adapters = new Map();
  for (const [name, providerConfig] of Object.entries(providers)) {
    if (!providerConfig.enabled) continue;
    
    const adapter = createAdapter(name, providerConfig);
    if (adapter) adapters.set(name, adapter);
  }
  
  const contextManager = createContextManager();
  
  return {
    async predict({ prompt, systemPrompt, provider, taskType, responseFormat, maxTokens, temperature }) {
      // 1. Select provider
      const providerName = provider || taskDefaults[taskType] || defaultProvider;
      const adapter = adapters.get(providerName);
      if (!adapter) throw new Error(`Provider ${providerName} not found`);
      
      // 2. Check context fit
      const contextWindow = await adapter.getContextWindow();
      const systemTokens = contextManager.estimateTokens(systemPrompt).tokens;
      const fit = contextManager.checkFits(prompt, contextWindow, systemTokens);
      
      // 3. Compact if needed
      const preparedPrompt = fit.fits 
        ? prompt 
        : await contextManager.compact(prompt, contextWindow, adapter);
      
      // 4. Call LLM
      let response = await adapter.predict({
        prompt: preparedPrompt,
        systemPrompt,
        maxTokens,
        temperature,
        responseFormat
      });
      
      // 5. Format output
      response = formatOutput(response, {
        stripThinking,
        thinkingTags,
        extractJSON: responseFormat?.type === 'json_schema'
      });
      
      return response;
    },
    
    async embedText(text, provider) {
      const providerName = provider || taskDefaults.embedding || defaultProvider;
      const adapter = adapters.get(providerName);
      if (!adapter) throw new Error(`Provider ${providerName} not found`);
      return adapter.embedText(text);
    },
    
    async embedBatch(texts, provider) {
      const providerName = provider || taskDefaults.embedding || defaultProvider;
      const adapter = adapters.get(providerName);
      if (!adapter) throw new Error(`Provider ${providerName} not found`);
      
      // Use batch if supported, fallback to sequential
      if (adapter.capabilities.batch) {
        return adapter.embedBatch(texts);
      }
      
      const results = [];
      for (const text of texts) {
        results.push(await adapter.embedText(text));
      }
      return results;
    }
  };
}

function createAdapter(name, config) {
  switch (name.toLowerCase()) {
    case 'lmstudio': return createLMStudioAdapter(config);
    case 'ollama': return createOllamaAdapter(config);
    case 'gemini': return createGeminiAdapter(config);
    case 'openai': return createOpenAIAdapter(config);
    default: return null;
  }
}
```

## Implementation Plan

### Phase 1: Formatter ✅ (Can copy from legacy)
- [ ] Create `src/router/formatter.js`
- [ ] Copy `stripThinkingFromText` → rename to `stripThinking`
- [ ] Add `extractJSON` function
- [ ] Add `formatOutput` orchestrator
- [ ] Create `test-formatter.js`

### Phase 2: Context Manager Wrapper
- [ ] Create `src/router/context-manager.js`
- [ ] Wrap existing chunk/compact/tokenize functions
- [ ] Provide clean API: `checkFits`, `compact`, `estimateTokens`
- [ ] Create `test-context-manager.js`

### Phase 3: LMStudio Adapter (Start with most important)
- [ ] Create `src/router/adapters/lmstudio.js`
- [ ] Implement `predict()` function
- [ ] Implement `embedText()` and `embedBatch()`
- [ ] Implement `getContextWindow()`
- [ ] Create `test-lmstudio-adapter.js`

### Phase 4: Main Router
- [ ] Create new `src/router/router.js` (overwrite simple version)
- [ ] Implement `createRouter()` factory
- [ ] Implement `predict()` orchestration
- [ ] Implement `embedText()` and `embedBatch()`
- [ ] Create `test-router-integration.js`

### Phase 5: Additional Adapters (Lower priority)
- [ ] `adapters/ollama.js` (if needed)
- [ ] `adapters/gemini.js` (if needed)
- [ ] `adapters/openai.js` (if needed)

### Phase 6: Migration
- [ ] Update http-server.js to use new router
- [ ] Test with all servers
- [ ] Delete legacy router
- [ ] Update memory system

## Key Simplifications

1. **No classes** - Factory functions returning plain objects
2. **No BaseLLMAdapter** - Each adapter is independent
3. **No capability discovery** - Hardcoded per adapter
4. **No connect/disconnect** - Connect on-demand
5. **No model lifecycle** - Assume model is loaded (optimize for specific model)
6. **Simpler error handling** - Throw errors, let caller handle
7. **No streaming** - Add later if needed

## Testing Strategy

Each component gets dedicated test file:
- `test-formatter.js` - Thinking stripping, JSON extraction
- `test-context-manager.js` - Fit checking, compaction
- `test-lmstudio-adapter.js` - Predict, embed, context window
- `test-router-integration.js` - Full workflow

## Next Step

Start with **Phase 1: Formatter** - it's self-contained and we can copy working code from legacy.

Ready to begin?
