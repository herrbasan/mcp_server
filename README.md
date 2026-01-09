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
│       ├── lm-studio.js         # LM Studio integration
│       ├── code-analyzer.js     # Code quality analysis
│       └── docs-helper.js       # Documentation generation
├── data/
│   └── memories.json            # Memory storage (gitignored)
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
      "endpoint": "http://192.168.0.100:12345/v1/chat/completions",
      "model": "nvidia/nemotron-3-nano",
      "systemPrompt": "You provide concise second opinions on development decisions..."
    },
    "code-analyzer": {
      "enabled": true
    },
    "docs-helper": {
      "enabled": true
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

Or configure via VS Code: Command Palette → "MCP: Add Server..." → Choose "Command (stdio)" "orchestrator": {
      "command": "node",
      "args": ["D:/Work/_GIT/mcp_server/src/index.js"]
    }
  }
} (12 total)

### Memory Server (Quality-Focused Storage)
- `remember` - Store evidence-based quality rules (categories: proven, anti_patterns, observed, hypotheses, context)
- `recall` - Semantic search with confidence weighting
- `forget` - Delete memory by ID
- `list_memories` - Browse all memories or filter by category
- `update_memory` - Update existing memory text/category
- `reflect_on_session` - Analyze what worked/failed, propose memory updates
- `apply_reflection_changes` - Apply approved changes with confidence adjustments

**Memory Philosophy**: Exists to improve output quality, not store user preferences. Categories track what produces good outcomes (proven), what causes problems (anti_patterns), and ideas being tested (hypotheses).

**Confidence System**: Memories start at 0.3, increase when reinforced across sessions (+0.1), decrease when contradicted (-0.2). Recall is weighted by confidence. Indicators: ✓=proven(0.7+), ~=promising(0.5-0.7), ?=hypothesis(<0.5).
```

## Available Tools

### LM Studio Server
- `get_second_opinion` - Query local LM Studio model for code/architecture advice

### Code Analyzer
- `analyze_code_quality` - Analyze code for quality issues and complexity
- `suggest_refactoring` - Get refactoring suggestions

### Docs Helper
- `generate_jsdoc` - Generate JSDoc comments
- `explain_api` - Explain API usage

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

## Development

```bash
# Run with auto-restart on file changes
npm run dev
```

## Notes

- Logs to stderr (visible in VS Code MCP output channel)
- Each server module is independent
- Fast startup, minimal dependencies
