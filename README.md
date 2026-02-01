# MCP Server Orchestrator

Centralized MCP server running as an independent HTTP service (MCP Streamable HTTP at `/mcp`). Manages multiple specialized servers and exposes **27 tools** to VS Code Copilot via remote connection.

## Features

- **Remote Architecture**: Independent server accessible over network (Streamable HTTP)
- **Code Search & Analysis**: Semantic search across remote codebases via UNC paths (NEW)
- **Autonomous Agent**: Local LLM agent with file access for code analysis (NEW)
- **Web Monitoring**: Real-time log streaming and memory management UI
- **Single Entry Point**: One MCP server manages multiple specialized servers
- **Modular Design**: Easy to add/remove server modules
- **Environment-Based Config**: Sensitive settings in .env (not tracked)
- **Vanilla JavaScript**: No TypeScript, fast and lean

## Quick Start

### Server (192.168.0.100 or remote machine)
```bash
npm install
cp .env.example .env  # Edit with your LM Studio endpoints
npm run start:http    # Starts on ports 3100 (MCP) and 3010 (web)
```

### Client (VS Code)
Add to `%APPDATA%\Code\User\mcp.json`:
```json
{
  "servers": {
    "mcp-server-orchestrator": {
      "type": "sse",
      "url": "http://192.168.0.100:3100/mcp"
    }
  }
}
```
Restart VS Code.

## Project Structure

```
mcp_server/
├── src/
│   ├── http-server.js           # HTTP server (remote mode)
│   ├── web-start.js             # Start web UI only
│   ├── lib/
│   │   └── workspace.js         # UNC path resolver (shared)
│   ├── llm/                     # LLM Translation Layer
│   │   ├── base-adapter.js      # Abstract adapter interface
│   │   ├── lmstudio-adapter.js  # LM Studio WebSocket adapter
│   │   ├── ollama-adapter.js    # Ollama HTTP adapter
│   │   ├── gemini-adapter.js    # Google Gemini API adapter
│   │   ├── copilot-adapter.js   # GitHub Copilot/Azure adapter
│   │   ├── router.js            # Multi-provider orchestrator
│   │   ├── index.js             # Public exports
│   │   └── README.md            # Technical reference
│   └── servers/
│       ├── memory.js            # Persistent semantic memory
│       ├── lm-studio-ws.js      # WebSocket LM Studio integration
│       ├── web-research.js      # Multi-source web research
│       ├── browser.js           # Browser automation
│       ├── local-agent.js       # Autonomous code analysis agent (NEW)
│       └── code-search.js       # Semantic code search (NEW)
├── scripts/
│   └── build-index.js           # CLI: Build semantic code index (NEW)
├── LMStudioAPI/                 # Git submodule (vanilla WebSocket SDK)
├── docs/                        # Documentation
│   ├── llm-translation-layer.md # LLM layer user guide
│   ├── llm-architecture.md      # Architecture diagrams
│   ├── llm-implementation-summary.md  # Implementation details
│   ├── local-agent-module.md    # Agent design (NEW)
│   ├── code-search-module.md    # Search design (NEW)
│   └── integration-plan.md      # Integration guide (NEW)
├── data/
│   ├── memories.json            # Memory storage (gitignored)
│   └── indexes/                 # Code search indexes (gitignored, NEW)
├── test/                        # Test scripts
│   ├── test-llm-router.js       # LLM router test suite
│   ├── test-workspace.js        # Workspace resolver tests (NEW)
│   └── test-modules-init.js     # Module initialization tests (NEW)
├── config.json                  # Server configuration
├── package.json
└── README.md
```

## LLM Translation Layer

Unified interface for multiple LLM providers with **task-based routing**, consistent API, and automatic provider selection.

### Supported Providers
- **LM Studio** (local) - Full model management, progress reporting, embeddings
- **Ollama** (remote) - HTTP interface, embeddings, deployed on Arc A770
- **Google Gemini** (cloud) - Latest Gemini models, vision, embeddings
- **OpenAI** (cloud) - GPT-4o, o1 models, Azure-compatible

### Batch Embedding Support

The LM Studio adapter supports batch embedding for faster indexing:

```javascript
// Single embedding
const embedding = await router.embedText('search query');

// Batch embedding (2.3x faster for large indexes)
const embeddings = await router.embedBatch(['text1', 'text2', 'text3']);
```

**Performance**: BATCH_SIZE=50 + PARALLEL_REQUESTS=4 yields 2.3x speedup (268s→116s for 28k files, 274 files/sec).

### Task-Based Routing

The router automatically selects providers based on task type:

```javascript
import { LLMRouter } from './src/llm/router.js';

const router = new LLMRouter(config.llm);

// Embeddings use lmstudio (local, fast)
const embedding = await router.embedText('search query');

// Text generation uses gemini (quality)
const response = await router.predict({
  prompt: 'Explain async/await',
  taskType: 'query',  // Uses taskDefaults.query provider
  maxTokens: 500
});

// Override with explicit provider
const localResponse = await router.predict({
  prompt: 'What is quantum computing?',
  provider: 'lmstudio',  // Force specific provider
  model: 'nvidia/nemotron-3-nano'
});
```

**Current Routing** (configured in config.json):
- `embedding` → **lmstudio** (local, 768-dim nomic-embed-text-v2-moe)
- `analysis` → **gemini** (web research source selection)
- `synthesis` → **gemini** (web research content synthesis)
- `query` → **gemini** (query_model, get_second_opinion tools)

**Dimension Compatibility**: All embedding models standardized on 768-dim nomic-embed-text-v2-moe. Memory system handles dimension mismatches gracefully (returns 0 similarity for incompatible vectors).

📖 **Full Documentation**: [docs/llm-translation-layer.md](docs/llm-translation-layer.md)

🏗️ **Architecture**: [docs/llm-architecture.md](docs/llm-architecture.md)

## Configuration

### Environment Variables (.env)
**Required** - Copy `.env.example` to `.env` and configure:

```env
# LM Studio endpoints
LM_STUDIO_WS_ENDPOINT=ws://localhost:12345
LM_STUDIO_HTTP_ENDPOINT=http://localhost:12345

# LLM Provider API Keys (for cloud providers)
GEMINI_API_KEY=your-google-api-key-here
COPILOT_API_KEY=your-github-copilot-key-here

# Embedding model for memory system
EMBEDDING_MODEL=text-embedding-nomic-embed-text-v2-moe
MAX_MEMORY_CHARS=30000

# Server binding (0.0.0.0 for remote access)
MCP_HOST=0.0.0.0
MCP_PORT=3100
WEB_HOST=0.0.0.0
WEB_PORT=3010
```

### Server Configuration (config.json)
Non-sensitive settings (models, prompts, timeouts):

```json
{
  "servers": {
    "memory": {
      "enabled": true,
      "storePath": "data/memories.json"
    },
    "lm-studio": {
      "enabled": true,
      "model": "nvidia/nemotron-3-nano",
      "systemPrompt": "You provide concise second opinions...",
      "temperature": 0.7,
      "maxTokens": 2000
    },
    "code-analyzer": {
      "enabled": true
    },
    "web-research": {
      "enabled": true,
      "llmModel": "nvidia/nemotron-3-nano",
      "maxPages": 10,
      "timeout": 180000
    }
  },
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

## Architecture

**Transport**: StreamableHTTPServerTransport (MCP SDK)
- Server: `src/http-server.js` - Streamable HTTP endpoint at `/mcp`
- Web UI: `src/web/server.js` - Real-time SSE log streaming
- Ports: 3100 (MCP protocol), 3010 (web monitoring)

**Multi-client support**:
- Streamable HTTP transports are stateful per instance.
- The server creates one `StreamableHTTPServerTransport` per MCP session and routes requests by the `mcp-session-id` header.
- New sessions are created on the initial request without a session header; unknown session IDs return 404.

**Network Setup**:
- Server binds to `0.0.0.0` for remote access (configurable in .env)
- Firewall: Allow TCP 3100, 3010 on server
- Clients connect via `http://SERVER_IP:3100/mcp` in mcp.json

**Tools Exposed** (26 total):
- **Memory** (7): remember, recall, forget, list_memories, update_memory, reflect_on_session, apply_reflection_changes
- **LM Studio** (4): query_model, get_second_opinion, list_available_models, get_loaded_model
- **Web Research** (1): research_topic
- **Browser** (5): browser_fetch, browser_click, browser_fill, browser_evaluate, browser_pdf
- **Local Agent** (2): run_local_agent, retrieve_file
- **Code Search** (8): get_workspace_config, refresh_index, refresh_all_indexes, get_index_stats, search_files, search_keyword, search_semantic, search_code

## Web Monitoring

Access at `http://SERVER_IP:3010` for:
- Real-time log streaming (SSE)
- Memory browser and search
- Server status

## Development

Run the orchestrator in HTTP mode:
```bash
npm run start:http
```

## Available Tools (14 total)

## Available Tools

### Memory Server (7 tools)
Quality-focused semantic storage with confidence weighting. Memories exist to improve output quality by tracking what works, what fails, and patterns observed across sessions.

- **`remember`** - Store new memory with category and optional domain
  - Categories: `proven` (evidence-backed approaches), `anti_patterns` (known failures), `observed` (behavioral patterns), `hypotheses` (untested ideas), `context` (project facts)
  - Optional domain: Project-specific scoping (LMStudioAPI, nui_wc2, LocalVectorDB, etc)
  - New memories start at confidence 0.3
  
- **`recall`** - Semantic search across memories
  - Returns results ranked by similarity and confidence
  - Indicators: ✓=proven(0.7+), ~=promising(0.5-0.7), ?=hypothesis(<0.5)
  - Optional category and domain filters
  
- **`list_memories`** - Browse all memories or filter by category/domain
  - View complete memory store with IDs, categories, domains, and confidence levels
  
- **`update_memory`** - Modify existing memory text/category/domain by ID
  - Change wording, reclassify, or correct inaccuracies
  - Set or remove domain scoping
  
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

## Code Search & Local Agent

### Overview
Autonomous code analysis and semantic search across remote codebases via UNC network paths. Enables Claude to delegate code exploration to local LLMs, saving massive amounts of context.

**Key Benefits**:
- **Token Savings**: 80%+ reduction in Claude's context usage for code analysis
- **Speed**: Semantic search returns results in <1s from pre-built indexes
- **Scalability**: Handles 100k+ file codebases efficiently
- **Remote Access**: UNC path resolution for network shares (Windows SMB/CIFS)
- **Path-Agnostic**: Calling LLMs use workspace names, not paths

### Setup

#### 1. Configure Workspaces (config.json)
Workspaces are named identifiers mapped to UNC paths:
```json
{
  "workspaces": {
    "COOLKID-Work": "\\\\COOLKID\\Work",
    "BADKID-DEV": "\\\\BADKID\\Stuff\\DEV",
    "BADKID-SRV": "\\\\BADKID\\Stuff\\SRV"
  }
}
```

#### 2. Build Initial Index (CLI - one-time, ~20min for large codebases)
```bash
# Single workspace
node scripts/build-index.js --workspace "BADKID-DEV"

# All workspaces
node scripts/build-index.js --all --force
```

**What it does**:
- Scans workspace recursively (skips node_modules, .git, $RECYCLE.BIN, etc.)
- Parses code structure (regex-based: functions, classes, imports)
- Generates embeddings (768-dim via nomic-embed-text-v2-moe)
- Saves to `data/indexes/{workspace}.json` (~16MB for 650 files)

#### 3. Use via MCP Tools

**Discover Workspaces** - Always call first:
```javascript
// get_workspace_config returns available workspaces
// Returns: { workspaces: { "BADKID-DEV": { indexed: true, fileCount: 647 }, ... } }
```

**Semantic Search** - Find code by meaning:
```javascript
{
  name: "search_semantic",
  args: {
    workspace: "BADKID-DEV",
    query: "HTTP server initialization",
    limit: 10
  }
}
// Returns: [{ file: "BADKID-DEV:src/http-server.js", similarity: 0.85, ... }]
```

**Keyword Search** - Fast text/regex search:
```javascript
{
  name: "search_keyword",
  args: {
    workspace: "BADKID-DEV",
    pattern: "StreamableHTTP",
    regex: false
  }
}
// Returns: [{ file: "BADKID-DEV:src/http-server.js", matches: [...] }]
```

**File Search** - Glob pattern matching:
```javascript
{
  name: "search_files",
  args: {
    workspace: "BADKID-DEV",
    glob: "src/**/*.js"
  }
}
// Returns: [{ file: "BADKID-DEV:src/http-server.js" }, ...]
```

**Retrieve File** - Get raw source code using file ID:
```javascript
{
  name: "retrieve_file",
  args: {
    file: "BADKID-DEV:src/http-server.js"
  }
}
// Returns: Complete file content
```

**Local Agent** - Autonomous code analysis:
```javascript
{
  name: "run_local_agent",
  args: {
    task: "Explain the HTTP server architecture",
    workspace: "BADKID-DEV",
    maxTokens: 20000
  }
}
// Agent autonomously explores code using search tools
// Returns: Summary (no code, just analysis)
```

### Workflow Example

**Typical Claude workflow** (before):
1. Claude asks user to share files
2. User copies 5-10 files manually
3. Claude context: 50k+ tokens consumed

**With Code Search** (after):
1. Claude discovers: `get_workspace_config()` → sees available workspaces
2. Claude searches: `search_semantic({ workspace: "BADKID-DEV", query: "audio player" })`
3. Claude retrieves: `retrieve_file({ file: "BADKID-DEV:src/player.js" })`
4. Claude context: ~6k tokens

**With Local Agent** (ultra-efficient):
1. Claude delegates: `run_local_agent({ workspace: "BADKID-DEV", task: "How does the audio player work?" })`
2. Agent (local LLM) explores autonomously using search tools
3. Claude receives summary only
4. Claude context: ~500 tokens

### Incremental Index Updates

Refresh single workspace:
```javascript
{
  name: "refresh_index",
  args: { workspace: "BADKID-DEV" }
}
// Fast (seconds) - only re-indexes changed files via mtime comparison
```

Refresh all workspaces:
```javascript
{
  name: "refresh_all_indexes",
  args: {}
}
// Refreshes indexes for all configured workspaces
```

Check index health:
```javascript
{
  name: "get_index_stats",
  args: { workspace: "BADKID-DEV" }
}
// Returns: file count, last build time, staleness warnings
```

### Technical Details

**Workspace Resolution**: Named workspaces map directly to UNC paths
- `BADKID-DEV` → `\\BADKID\Stuff\DEV`
- File IDs: `workspace:relative/path` (e.g., `BADKID-DEV:src/http-server.js`)
- Security: Path traversal validation, no escaping workspace root

**Agent Loop** (run_local_agent):
- Max 20 iterations, 50k token budget (configurable)
- Tools: Dynamically selected based on workspace (search tools if indexed)
- Loop detection: Auto-stops if 3 consecutive identical calls
- Returns partial results if limits hit

**Index Format** (JSON at `data/indexes/{workspace}.json`):
```json
{
  "workspace": "BADKID-DEV",
  "uncPath": "\\\\BADKID\\Stuff\\DEV",
  "created_at": "2026-02-01T08:54:40.243Z",
  "file_count": 647,
  "files": {
    "src/index.js": {
      "language": "javascript",
      "size_bytes": 2345,
      "mtime": 1738394080000,
      "embedding": [0.12, -0.45, ...],  // 768-dim vector
      "functions": ["init", "render"],
      "classes": ["App"],
      "imports": ["react", "lodash"]
    }
  }
}
```

**Supported Languages**: JavaScript, TypeScript, Python, Java, C/C++, Go, Rust, C#, Markdown

## Adding New Servers

1. Create new file in `src/servers/your-server.js`
2. Export class with methods: `getTools()`, `handlesTool(name)`, `callTool(name, args)`
3. Import in `src/http-server.js`
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
