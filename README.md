# MCP Server Orchestrator

Centralized Node.js server that manages multiple MCP servers and exposes them to VS Code Copilot.

## Features

- **Single Entry Point**: One MCP server manages multiple specialized servers
- **Modular Design**: Easy to add/remove server modules
- **Configuration-Driven**: Enable/disable servers via config.json
- **Vanilla JavaScript**: No TypeScript, fast and lean

## Quick Start

```bash
npm install
npm start
```

## Project Structure

```
mcp_server/
├── src/
│   ├── index.js                 # Main orchestrator
│   └── servers/
│       ├── memory.js            # Persistent semantic memory
│       ├── lm-studio-ws.js      # WebSocket LM Studio integration
│       ├── lm-studio-http.js    # HTTP LM Studio (reference)
│       ├── code-analyzer.js     # Code quality analysis
│       └── web-research.js      # Multi-source web research
├── LMStudioAPI/                 # Git submodule (vanilla WebSocket SDK)
├── data/
│   └── memories.json            # Memory storage (gitignored)
├── test/                        # Test scripts
├── config.json                  # Server configuration
├── package.json
└── README.md
```

## Configuration

Edit `config.json` to enable/disable servers and configure endpoints:

```json
{
  "servers": {
    "memory": {
      "enabled": true,
      "embeddingEndpoint": "http://192.168.0.100:12345/v1/embeddings",
      "embeddingModel": "text-embedding-nomic-embed-text-v2-moe",
      "storePath": "data/memories.json"
    },
    "lm-studio": {
      "enabled": true,
      "endpoint": "ws://192.168.0.100:12345",
      "model": "nvidia/nemotron-3-nano",
      "systemPrompt": "You provide concise second opinions on development decisions...",
      "temperature": 0.7,
      "maxTokens": 2000
    },
    "code-analyzer": {
      "enabled": true
    },
    "web-research": {
      "enabled": true,
      "llmEndpoint": "http://192.168.0.100:12345/v1/chat/completions",
      "llmModel": "nvidia/nemotron-3-nano",
      "maxPages": 10,
      "timeout": 180000
    }
**Global Setup (Recommended):**
Add to User Settings JSON (Ctrl+Shift+P → "Preferences: Open User Settings (JSON)"):

```json
{
  "mcp.servers": {
    "orchestrator": {
      "command": "node",
      "args": ["D:/Work/_GIT/mcp_server/src/index.js"]
    }
  }
}
```

Or configure via VS Code: Command Palette → "MCP: Add Server..." → Choose "Command (stdio)"

## Available Tools (14 total)

## Available Tools

### Memory Server (7 tools)
Quality-focused semantic storage with confidence weighting. Memories exist to improve output quality by tracking what works, what fails, and patterns observed across sessions.

- **`remember`** - Store new memory with category
  - Categories: `proven` (evidence-backed approaches), `anti_patterns` (known failures), `observed` (behavioral patterns), `hypotheses` (untested ideas), `context` (project facts)
  - New memories start at confidence 0.3
  
- **`recall`** - Semantic search across memories
  - Returns results ranked by similarity and confidence
  - Indicators: ✓=proven(0.7+), ~=promising(0.5-0.7), ?=hypothesis(<0.5)
  - Optional category filter
  
- **`list_memories`** - Browse all memories or filter by category
  - View complete memory store with IDs, categories, and confidence levels
  
- **`update_memory`** - Modify existing memory text/category by ID
  - Change wording, reclassify, or correct inaccuracies
  
- **`forget`** - Delete memory by ID
  - Remove outdated or incorrect memories
  
- **`reflect_on_session`** - Analyze session outcomes and propose memory updates
  - Identifies what worked, what failed, patterns observed
  - Proposes CREATE (new observation), REINFORCE (+0.1 confidence), UPDATE (add nuance), DECREASE (-0.2 confidence)
  - Returns proposed changes for review
  
- **`apply_reflection_changes`** - Apply approved reflection proposals
  - Updates memory store with confirmed changes
  - Adjusts confidence scores based on evidence

**Confidence System**: Memories gain confidence when reinforced across sessions (+0.1), lose confidence when contradicted (-0.2). High-confidence memories are prioritized in recall.

### LM Studio Server (4 tools)
WebSocket integration with local LM Studio for model queries and management. Real-time MCP progress notifications show model loading (1%-100%) and generation status.

- **`query_model`** - Query model with custom prompt
  - Raw prompt without specialized instructions
  - Optional model parameter to specify which model to use
  - Optional maxTokens parameter (default: 2000)
  - Real-time progress: connection → model loading → generation → complete
  - Auto-unload previous model when switching (enforces single model)
  
- **`get_second_opinion`** - Get development perspective
  - Same as query_model but with specialized system prompt
  - Use for code/architecture decisions, design trade-offs
  - Optional context parameter for code snippets
  - Configured system prompt focuses on performance, maintainability, best practices
  
- **`list_available_models`** - List all LM Studio models
  - Shows context lengths, loaded status, capabilities
  - Indicators: [LOADED], [Vision], [Tools]
  - Use to discover available models before querying
  
- **`get_loaded_model`** - Check currently loaded model
  - Returns model ID and context window size
  - Use to verify which model is active

**Transport**: WebSocket via LMStudioAPI submodule (github.com/herrbasan/LMStudioAPI.git). Model selection auto-detects loaded model or falls back to config default. Validates model IDs against available models.

### Code Analyzer (2 tools)
Fast static analysis for code quality issues and refactoring opportunities.

- **`analyze_code_quality`** - Detect quality issues
  - Checks: function length, cyclomatic complexity, promise chains, var usage, loose equality
  - Optional language parameter (js, py, etc.)
  - Returns list of detected issues with suggestions
  
- **`suggest_refactoring`** - Get refactoring recommendations
  - Focus areas: `performance`, `readability`, `maintainability`
  - Performance: loop optimization, iteration method selection
  - Readability: function extraction, call simplification
  - Maintainability: magic number extraction, error handling

### Web Research (1 tool)
Automated multi-source research using local LLM for synthesis. Dramatically reduces API costs by doing heavy processing locally.

- **`research_topic`** - Comprehensive web research
  - **Phase 1**: Query multiple search engines (DuckDuckGo, Google, Bing)
  - **Phase 2**: Local LLM selects most authoritative sources
  - **Phase 3**: Parallel Puppeteer scraping (handles JS-rendered content)
  - **Phase 4**: Local LLM cross-references facts, synthesizes report
  - Returns markdown report with citations and source URLs
  - Configurable limits: `max_pages` (default 10), 3-minute timeout
  - Use for: library comparisons, technical research, gathering context from multiple sources
  - Cost-effective: 3-4 local LLM calls vs thousands of tokens for you to process raw HTML

**Safety Features**: Hard page limits, total timeout, progress reporting to stderr, graceful degradation if sources fail.

## Adding New Servers

1. Create new file in `src/servers/your-server.js`
2. Export class with methods: `getTools()`, `handlesTool(name)`, `callTool(name, args)`
3. Import in `src/index.js`
4. Add initialization block
5. Update `config.json`

Example:

```javascript
export class YourServer {
  constructor(config) { this.config = config; }
  
  getTools() {
    return [{
      name: 'your_tool',
      description: 'What it does',
      inputSchema: { type: 'object', properties: {...}, required: [...] }
    }];
  }
  
  handlesTool(name) { return name === 'your_tool'; }
  
  async callTool(name, args) {
    return { content: [{ type: 'text', text: 'result' }] };
  }
}
```

## Requirements

- Node.js 18+
- @modelcontextprotocol/sdk
- LM Studio running (if using lm-studio server)
- Git submodule: LMStudioAPI (auto-cloned with `git submodule update --init`)

## Installation

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/herrbasan/mcp_server.git

# Or if already cloned
git submodule update --init

npm install
```

## Development

```bash
# Run with auto-restart on file changes
npm run dev
```

## Notes

- Logs to stderr (visible in VS Code MCP output channel)
- Each server module is independent
- Fast startup, minimal dependencies
