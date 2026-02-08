# LLM Router

Multi-provider LLM router with task-based routing, auto-compaction, and structured output.

## Quick Start

```javascript
import { createRouter } from './router.js';

const router = await createRouter(config.llm);

// Prediction with task routing
const response = await router.predict({
  prompt: 'Explain async/await',
  systemPrompt: 'You are helpful',
  taskType: 'query'  // Routes via config.llm.taskDefaults
});

// Embeddings
const vector = await router.embedText('search query');
const vectors = await router.embedBatch(['text1', 'text2']);

// Model management
const models = await router.listModels('ollama');
const running = await router.getRunningModels('ollama');
```

## API

### `predict(options)` - LLM Query

| Param | Default | Description |
|-------|---------|-------------|
| `prompt` | **required** | User input |
| `systemPrompt` | **required** | System instructions |
| `taskType` | `'query'` | Routes via `taskDefaults` |
| `temperature` | `0.7` | Sampling temperature |
| `maxTokens` | 30% of context | Output token limit |
| `responseFormat` | `null` | JSON schema for structured output |
| `provider` | auto | Override provider selection |

**Behavior:**
- Auto-routes: `taskType` → `taskDefaults[taskType]` → `defaultProvider`
- Auto-compacts if prompt exceeds context (rolling compaction)
- Strips thinking tags if provider config has `stripThinking: true`
- Extracts JSON if `responseFormat` provided

### `embedText(text, provider?)` - Single Embedding

Returns `number[]` (768-dim for nomic-embed-text-v2-moe)

### `embedBatch(texts, provider?)` - Batch Embeddings

Returns `number[][]`. Uses native batch if available, else sequential fallback.

### Model Management

```javascript
router.listModels(provider)         // List available models
router.getLoadedModel(provider)     // Get current model
router.getRunningModels(provider)   // Ollama: running models with VRAM
router.showModelInfo(name, provider) // Ollama: detailed model info
router.loadModel(name, provider)    // Ollama: pre-load model
router.unloadModel(name, provider)  // Ollama: unload from memory
router.getProviders()               // List enabled providers
router.getAdapter(provider)         // Direct adapter access
```

## Providers

| Provider | Type | Capabilities |
|----------|------|--------------|
| `lmstudio` | Local HTTP | embeddings, structuredOutput, batch, modelManagement |
| `ollama` | Local/Remote HTTP | embeddings, structuredOutput, batch, modelManagement |
| `gemini` | Cloud | embeddings, structuredOutput, batch |

## Task Routing

Configured in `config.llm.taskDefaults`:

| Task | Provider | Use Case |
|------|----------|----------|
| `embedding` | lmstudio | Code search, memory embeddings |
| `analysis` | gemini | Web research source selection |
| `synthesis` | gemini | Multi-source content synthesis |
| `query` | gemini | query_model tool |
| `inspect` | kimi-cli | Code inspection tool |

## Auto-Compaction

When prompt exceeds context window:
1. Chunks text at safe token boundaries
2. Compresses each chunk via rolling summarization
3. Combines summaries to fit context

Stats from tests: 45k tokens → 253 tokens (99.5% compression, ~10s)

## Files

```
router/
├── router.js           # Main orchestrator
├── adapters/
│   ├── lmstudio.js    # LM Studio HTTP adapter
│   ├── ollama.js      # Ollama HTTP adapter
│   └── gemini.js      # Google Gemini adapter
├── context-manager.js  # Token estimation, compaction wrapper
├── formatter.js        # Thinking tag stripping, JSON extraction
├── chunk.js           # Text chunking
├── compact.js         # Rolling compaction
├── tokenize.js        # Token estimation
└── tests/             # Test files
```

## Tests

```bash
node src/router/tests/test-formatter.js        # 12/12 ✅
node src/router/tests/test-lmstudio-adapter.js # 6/6 ✅
node src/router/tests/test-ollama-adapter.js   # 10/10 ✅
node src/router/tests/test-gemini-adapter.js   # 8/8 ✅
node src/router/tests/test-router-integration.js # 7/7 ✅
```
