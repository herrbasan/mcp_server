# LLM Translation Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Application Layer                      │
│  (MCP Servers: memory, web-research, lm-studio-ws, etc.)    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                        LLMRouter                             │
│  • Provider selection (default or explicit)                  │
│  • Capability checking                                       │
│  • Progress callback propagation                             │
│  • Connection management                                     │
│  • Unified API: predict(), embedText(), listModels(), etc.  │
└────┬────────┬────────┬────────┬─────────────────────────────┘
     │        │        │        │
     ▼        ▼        ▼        ▼
┌─────────┐ ┌──────┐ ┌──────┐ ┌─────────┐
│LMStudio │ │Ollama│ │Gemini│ │ OpenAI  │
│ Adapter │ │Adapter│ │Adapter│ │ Adapter │
└────┬────┘ └──┬───┘ └──┬───┘ └────┬────┘
     │         │        │          │
     │         │        │          │
┌────▼────────────────────────────────────────────────────────┐
│                    BaseLLMAdapter                            │
│  Abstract interface:                                         │
│  • connect() / disconnect() / isConnected()                  │
│  • listModels() / loadModel() / unloadModel()                │
│  • predict({ prompt, systemPrompt, maxTokens, ... })         │
│  • embedText(text)                                           │
│  • getCapabilities()                                         │
│  • setProgressCallback() / sendProgress()                    │
└────┬────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│                  Provider Endpoints                          │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  LM Studio   │   Ollama     │    Gemini    │    OpenAI      │
│ (WebSocket)  │ (HTTP REST)  │  (REST API)  │  (REST API)    │
│ localhost:   │ localhost:   │   Google     │   OpenAI/      │
│   12345      │   11434      │   Cloud      │   Azure        │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

## Data Flow: Text Generation

```
1. Application calls:
   router.predict({ 
     prompt: "Hello", 
     provider: "lmstudio",
     maxTokens: 100 
   })
   
2. Router:
   - Gets adapter: router.getAdapter("lmstudio")
   - Calls: adapter.predict({ ... })
   
3. LMStudioAdapter:
   - sendProgress(5, 100, "Ensuring model loaded...")
   - Ensures WebSocket connection
   - Loads model if needed (with progress updates)
   - sendProgress(35, 100, "Generating response...")
   - Calls session.predict() with streaming
   - Aggregates chunks
   - sendProgress(100, 100, "Complete")
   - Returns full response
   
4. Router returns response to application
```

## Capability Matrix

| Provider  | Streaming | Embeddings | Vision | Tools | Model Mgmt | Progress |
|-----------|-----------|------------|--------|-------|------------|----------|
| LMStudio  | ✓         | ✓          | ✓      | ✓     | ✓          | ✓        |
| Ollama    | ✓         | ✓          | ✗      | ✗     | ✗          | ✓        |
| Gemini    | ✓         | ✓          | ✓      | ✓     | ✗          | ✓        |
| OpenAI    | ✓         | ✗          | ✗      | ✓     | ✗          | ✓        |

## Configuration Flow

```
config.json → Router Constructor → Adapter Initialization
     ↓
{
  "llm": {
    "defaultProvider": "lmstudio",
    "providers": {
      "lmstudio": {
        "enabled": true,  ← Only enabled providers are initialized
        "endpoint": "${LM_STUDIO_WS_ENDPOINT}",  ← Env var substitution
        "model": "nemotron-70b",
        ...
      }
    }
  }
}
     ↓
Router iterates providers:
  For each provider:
    if (config.enabled):
      adapter = createAdapter(type, config)
      adapters.set(name, adapter)
```

## Error Handling

```
Application
    │
    ▼
Router.predict()
    │
    ├─► Provider not found
    │   └─► Error: "Provider 'X' not found. Available: lmstudio, ollama"
    │
    ├─► Capability check
    │   └─► Error: "Provider 'openai' does not support embeddings"
    │
    ▼
Adapter.predict()
    │
    ├─► Connection error
    │   └─► Auto-reconnect (LMStudio) or throw
    │
    ├─► Model not found
    │   └─► Error: "Model 'X' not found. Available: model1, model2"
    │
    ├─► API error
    │   └─► Error: "HTTP 401: Invalid API key"
    │
    └─► Success
        └─► Return response
```

## Progress Reporting

```
Progress Timeline (LMStudio example):

0%    ─┐
      ├─ Connection establishment
10%   ─┘

10%   ─┐
      │
      ├─ Model loading
      │   (granular progress from LMStudioSession)
35%   ─┘

35%   ─┐
      │
      ├─ Text generation
      │   (streaming chunks)
100%  ─┘

Each phase:
  sendProgress(percentage, 100, "status message")
  → progressCallback(percentage, 100, "status message")
  → Application UI update
```

## Extension Pattern

```javascript
// 1. Create new adapter
import { BaseLLMAdapter } from './base-adapter.js';

export class MyCustomAdapter extends BaseLLMAdapter {
  async connect() {
    // Initialize connection
  }
  
  async predict({ prompt, systemPrompt, maxTokens, temperature, model }) {
    this.sendProgress(10, 100, 'Starting...');
    // ... implementation
    this.sendProgress(100, 100, 'Complete');
    return response;
  }
  
  getCapabilities() {
    return {
      streaming: true,
      embeddings: false,
      // ... other capabilities
    };
  }
}

// 2. Register in router.js
case 'mycustom':
  return new MyCustomAdapter(config);

// 3. Add to config.json
{
  "llm": {
    "providers": {
      "mycustom": {
        "enabled": true,
        "type": "mycustom",
        // ... custom config
      }
    }
  }
}
```
