# LLM Translation Layer

Unified interface for multiple LLM providers with **task-based routing**, consistent API, progress reporting, and error handling.

## Architecture

- **Base Adapter**: Abstract interface defining common LLM operations (BaseLLMAdapter)
- **Provider Adapters**: Specific implementations for each LLM service
- **Router**: Manages multiple providers and routes requests based on task type
- **Task-Based Routing**: Configurable mapping of task types to providers
  - Priority: explicit provider > task default > global default
  - Task types: `embedding`, `analysis`, `synthesis`, `query`

## Supported Providers

### LM Studio (Local)
- **Transport**: WebSocket via LMStudioAPI submodule
- **Features**: Full model management, progress reporting, TTL-based auto-unload
- **Embeddings**: text-embedding-nomic-embed-text-v2-moe (768-dim, Q4/Q5, 8192 context)
- **Use Case**: Fast local embeddings, secondary text generation
- **Hardware**: Local machine with RTX 4090

### Ollama (Remote)
- **Transport**: HTTP REST API
- **Features**: Stateless model interactions, embeddings
- **Embeddings**: nomic-embed-text-v2-moe (768-dim, Q8, 8192 context)
- **Use Case**: Remote text generation, backup embeddings
- **Hardware**: Remote Intel Arc A770 (192.168.0.145:11434)

### Google Gemini (Cloud)
- **Transport**: Google Generative AI SDK
- **Features**: Latest Gemini models, vision, tool use
- **Embeddings**: text-embedding-004
- **Use Case**: Primary text generation (analysis, synthesis, queries)
- **Models**: gemini-2.0-flash-exp, gemini-1.5-flash, gemini-1.5-pro

### OpenAI (Cloud)
- **Transport**: OpenAI-compatible HTTP API
- **Features**: GPT-4o, o1 models, Azure-compatible
- **Use Case**: Alternative cloud provider, compatible with LM Studio's OpenAI endpoint
- **Models**: gpt-4o, o1-preview, o1-mini

## Embedding Dimension Compatibility

**All providers standardized on 768-dimension embeddings** for semantic memory compatibility:

- **LMStudio**: nomic-embed-text-v2-moe (500MB Q4/Q5 quantization)
- **Ollama**: nomic-embed-text-v2-moe (1GB Q8 quantization, higher precision)
- **Same model family**: 8192 token context, Mixture of Experts architecture

**Memory System Handling**:
- `cosineSimilarity()` checks dimension match before comparison
- Returns 0 for incompatible dimensions (graceful degradation)
- Prevents NaN errors when mixing different embedding models

## Features

All adapters expose:
- `connect()` / `disconnect()` - Connection management
- `listModels()` - Available models
- `loadModel()` / `unloadModel()` - Model lifecycle (where supported)
- `predict()` - Text generation
- `embedText()` - Vector embeddings (where supported)
- `getCapabilities()` - Feature detection
- Progress callbacks for long operations

## Usage

### Basic Setup

\`\`\`javascript
import { LLMRouter } from './src/llm/router.js';
import config from './config.json' assert { type: 'json' };

const router = new LLMRouter(config.llm);

// Optional: Set progress callback
router.setProgressCallback((progress, total, message) => {
  console.log(\`[\${progress}/\${total}] \${message}\`);
});
\`\`\`

### List Providers

\`\`\`javascript
const providers = await router.listProviders();
// [
//   { name: 'lmstudio', connected: true, capabilities: {...}, isDefault: true },
//   { name: 'ollama', connected: false, capabilities: {...}, isDefault: false }
// ]
\`\`\`
### Task-Based Routing

```javascript
// Router automatically selects provider based on task type
const router = new LLMRouter(config.llm);

// Embeddings use taskDefaults.embedding (lmstudio - local, fast)
const embedding = await router.embedText('search query');

// Text generation with task type (uses taskDefaults.query - gemini)
const response = await router.predict({
  prompt: 'Explain async/await',
  taskType: 'query',
  maxTokens: 500
});

// Override task default with explicit provider
const localResponse = await router.predict({
  prompt: 'What is quantum computing?',
  provider: 'lmstudio',  // Force specific provider
  taskType: 'query'
});
```

**Task Types**:
- `embedding` - Vector embeddings for semantic search
- `analysis` - Source selection, credibility analysis
- `synthesis` - Multi-source content synthesis
- `query` - Direct model queries (query_model, get_second_opinion)

**Routing Priority**:
1. Explicit `provider` parameter
2. `taskDefaults[taskType]` from config
3. `defaultProvider` from config
### Generate Text

\`\`\`javascript
// Use default provider
const response = await router.predict({
  prompt: 'Explain async/await in JavaScript',
  systemPrompt: 'You are a helpful coding assistant',
  maxTokens: 500,
  temperature: 0.7
});

// Use specific provider
const geminiResponse = await router.predict({
  prompt: 'What is quantum computing?',
  provider: 'gemini',
  model: 'gemini-2.0-flash-exp'
});
\`\`\`

### Embeddings

\`\`\`javascript
// Default provider (must support embeddings)
const embedding = await router.embedText('Hello world');

// Specific provider
const embedding = await router.embedText('Hello world', 'lmstudio');
\`\`\`

### Model Management

\`\`\`javascript
// List models for a provider
const models = await router.listModels('lmstudio');

// Load a specific model
await router.loadModel('llama3.2', 'ollama');

// Check what's loaded
const loaded = await router.getLoadedModel('lmstudio');

// Unload model
await router.unloadModel('llama3.2', 'ollama');
\`\`\`

### Check Capabilities

\`\`\`javascript
const caps = router.getCapabilities('gemini');
// {
//   streaming: true,
//   embeddings: true,
//   vision: true,
//   toolUse: true,
//   modelManagement: false,
//   progressReporting: true
// }
\`\`\`

## Configuration

Add to `config.json`:

```json
{
  "llm": {
    "defaultProvider": "lmstudio",
    "taskDefaults": {
      "embedding": "lmstudio",
      "analysis": "gemini",
      "synthesis": "gemini",
      "query": "gemini"
    },
    "providers": {
      "lmstudio": {
        "enabled": true,
        "type": "lmstudio",
        "endpoint": "${LM_STUDIO_WS_ENDPOINT}",
        "model": "nvidia/nemotron-3-nano",
        "embeddingModel": "text-embedding-nomic-embed-text-v2-moe",
        "maxTokens": 8192
      },
      "ollama": {
        "enabled": true,
        "type": "ollama",
        "endpoint": "http://192.168.0.145:11434",
        "model": "gemma3:12b",
        "embeddingModel": "nomic-embed-text-v2-moe",
        "maxTokens": 8192
      },
      "gemini": {
        "enabled": true,
        "type": "gemini",
        "apiKey": "${GEMINI_API_KEY}",
        "model": "gemini-2.0-flash-exp",
        "embeddingModel": "text-embedding-004",
        "maxTokens": 8192
      },
      "openai": {
        "enabled": false,
        "type": "openai",
        "apiKey": "${OPENAI_API_KEY}",
        "endpoint": "${LM_STUDIO_HTTP_ENDPOINT}/v1/chat/completions",
        "model": "gpt-4o",
        "maxTokens": 8192
      }
    }
  }
}
```

Environment variables (`.env`):
```
LM_STUDIO_WS_ENDPOINT=ws://localhost:12345
LM_STUDIO_HTTP_ENDPOINT=http://localhost:12345
GEMINI_API_KEY=your-google-api-key
OPENAI_API_KEY=your-openai-api-key
```

**Task Mapping**:
- `embedding` → lmstudio (memory server semantic search)
- `analysis` → gemini (web-research source selection)
- `synthesis` → gemini (web-research content synthesis)
- `query` → gemini (query_model, get_second_opinion tools)

## Error Handling

All adapters throw descriptive errors:

\`\`\`javascript
try {
  await router.predict({ prompt: 'test', provider: 'gemini' });
} catch (err) {
  console.error(\`Prediction failed: \${err.message}\`);
  // "Provider 'gemini' not found. Available: lmstudio, ollama"
  // "Model 'invalid-model' not found. Available: ..."
  // "Gemini prediction failed: API key invalid"
}
\`\`\`

## Progress Reporting

LM Studio adapter provides detailed progress:
- Connection establishment (0-10%)
- Model loading (10-35%)
- Text generation (35-100%)

\`\`\`javascript
router.setProgressCallback((progress, total, message) => {
  console.log(\`Progress: \${progress}/\${total} - \${message}\`);
  // Progress: 5/100 - Ensuring model loaded...
  // Progress: 15/100 - Loading llama3.1-70b-instruct...
  // Progress: 35/100 - Generating response...
  // Progress: 100/100 - Complete
});
\`\`\`

## Creating Custom Adapters

Extend \`BaseLLMAdapter\`:

\`\`\`javascript
import { BaseLLMAdapter } from './base-adapter.js';

export class MyCustomAdapter extends BaseLLMAdapter {
  async connect() {
    // Implementation
  }

  async predict({ prompt, systemPrompt, maxTokens, temperature, model }) {
    // Implementation
    this.sendProgress(50, 100, 'Generating...');
    // ...
    return responseText;
  }

  getCapabilities() {
    return {
      streaming: true,
      embeddings: false,
      vision: false,
      toolUse: false,
      modelManagement: false,
      progressReporting: true
    };
  }
}
\`\`\`

Then register in \`router.js\`:

\`\`\`javascript
case 'mycustom':
  return new MyCustomAdapter(config);
\`\`\`

## Performance Notes

- **LM Studio**: Best for local deployment, full features, highest overhead
- **Ollama**: Fast local deployment, simpler, less control
- **Gemini**: Cloud-based, fast, rate-limited by API quota
- **Copilot**: Cloud-based, best GPT-4 access, rate-limited

## Blueprint: LM Studio Features

Other adapters should aspire to LM Studio's capabilities:

1. **Progress Reporting**: Real-time status updates during long operations
2. **Error Management**: Connection errors trigger reconnect, distinguish transient vs permanent failures
3. **Model Lifecycle**: Explicit load/unload with TTL-based auto-management
4. **Connection Pooling**: Single persistent connection, auto-reconnect on failure
5. **Caching**: Model list caching with TTL to reduce API calls
6. **Concurrency Control**: Promise locks prevent race conditions during model loading

Not all providers can support all features (e.g., API-based services don't have model loading), but the interface is designed for maximum capability exposure where available.
