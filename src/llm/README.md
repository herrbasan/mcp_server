# LLM Translation Layer

Unified interface for multiple LLM providers with consistent API, progress reporting, and error handling.

## Quick Start

\`\`\`javascript
import { LLMRouter } from './router.js';

const router = new LLMRouter(config.llm);

// Generate text with any provider
const response = await router.predict({
  prompt: 'Explain JavaScript promises',
  provider: 'lmstudio', // optional, uses default if omitted
  maxTokens: 500
});
\`\`\`

## Directory Structure

\`\`\`
src/llm/
├── base-adapter.js      # Abstract base class for all adapters
├── lmstudio-adapter.js  # LM Studio WebSocket adapter (feature-complete blueprint)
├── ollama-adapter.js    # Ollama HTTP adapter
├── gemini-adapter.js    # Google Gemini API adapter
├── copilot-adapter.js   # GitHub Copilot/Azure OpenAI adapter
├── router.js            # Multi-provider router/orchestrator
└── index.js             # Public exports
\`\`\`

## Adapters

### LMStudioAdapter (Blueprint)
- Full model lifecycle management
- Real-time progress reporting (connection, loading, generation)
- TTL-based auto-unload for memory management
- Embeddings support
- WebSocket with auto-reconnect
- Connection pooling and promise locks

### OllamaAdapter
- Simple HTTP REST API
- Stateless operations
- Basic embeddings support
- No model management (handled by Ollama)

### GeminiAdapter
- Google Generative AI SDK
- Latest Gemini models (2.0-flash-exp, 1.5-pro, etc.)
- Vision and tool use support
- Text embeddings via text-embedding-004

### CopilotAdapter
- OpenAI-compatible chat completions API
- GPT-4o, o1 models
- Works with GitHub Copilot and Azure OpenAI
- No embeddings support

## Router API

### Initialization
\`\`\`javascript
const router = new LLMRouter({
  defaultProvider: 'lmstudio',
  providers: { /* provider configs */ }
});
\`\`\`

### Methods

- \`listProviders()\` - Get all providers with connection status
- \`listModels(provider?)\` - List available models
- \`getLoadedModel(provider?)\` - Get currently loaded model
- \`loadModel(modelId, provider?)\` - Load a specific model
- \`unloadModel(modelId, provider?)\` - Unload a model
- \`predict({ prompt, systemPrompt, maxTokens, temperature, model, provider })\` - Generate text
- \`embedText(text, provider?)\` - Generate embeddings
- \`getCapabilities(provider?)\` - Get provider feature flags
- \`disconnect(provider?)\` - Disconnect provider(s)

### Progress Callbacks

\`\`\`javascript
router.setProgressCallback((progress, total, message) => {
  console.log(\`[\${progress}/\${total}] \${message}\`);
});
\`\`\`

## Configuration

See [config.json](../../config.json) for example configuration.

Environment variables:
- \`LM_STUDIO_WS_ENDPOINT\` - LM Studio WebSocket endpoint
- \`GEMINI_API_KEY\` - Google Gemini API key
- \`COPILOT_API_KEY\` - GitHub Copilot/Azure API key

## Design Principles

1. **Consistency**: All providers expose the same interface
2. **Capability Discovery**: Adapters declare what they support via \`getCapabilities()\`
3. **Progressive Enhancement**: Use advanced features (progress, model management) where available
4. **Error Transparency**: Preserve stack traces, clear error messages
5. **Performance**: Caching, connection pooling, minimal overhead

## Blueprint Pattern

LMStudioAdapter serves as the reference implementation. Other adapters should aspire to:

- Real-time progress reporting for long operations
- Graceful error handling with auto-recovery
- Resource management (TTLs, auto-cleanup)
- Efficient caching with TTL
- Concurrency control (promise locks)

Not all providers can support all features (e.g., API services don't have model loading), but the interface accommodates maximum capability.

## Testing

Run the test suite:
\`\`\`bash
node test/test-llm-router.js
\`\`\`

This tests all enabled providers and verifies:
- Connection establishment
- Model listing
- Text generation
- Embeddings (where supported)
- Capability detection

## Extending

Create new adapter:

\`\`\`javascript
import { BaseLLMAdapter } from './base-adapter.js';

export class MyAdapter extends BaseLLMAdapter {
  async connect() { /* ... */ }
  async predict({ prompt, systemPrompt, maxTokens, temperature, model }) {
    this.sendProgress(50, 100, 'Generating...');
    // ...
    return text;
  }
  getCapabilities() {
    return { streaming: true, embeddings: false, /* ... */ };
  }
}
\`\`\`

Register in \`router.js\`:
\`\`\`javascript
case 'myprovider':
  return new MyAdapter(config);
\`\`\`

## Dependencies

- \`@google/generative-ai\` - Gemini adapter
- \`../../LMStudioAPI/vanilla-sdk.js\` - LM Studio adapter

Ollama and Copilot use built-in \`fetch\` (Node 18+).

## See Also

- [Full Documentation](../../docs/llm-translation-layer.md)
- [LMStudioAPI](../../LMStudioAPI/README.md)
