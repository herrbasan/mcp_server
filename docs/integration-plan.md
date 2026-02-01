# MCP Orchestrator Integration Plan

**Created**: February 1, 2026
**Modules**: Local Agent, Code Search
**Target**: Seamless integration with existing MCP architecture

## Current Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  http-server.js                                                             │
│  ├── StreamableHTTPServerTransport (per-session)                            │
│  ├── Server modules (Map<name, ServerModule>)                               │
│  ├── Tool aggregation (tools from all modules)                              │
│  └── LLM Router (shared across modules)                                     │
└─────────────────────────────────────────────────────────────────────────────┘
           │
           ├── LMStudioWSServer (lm-studio)
           │     └── Tools: query_model, get_second_opinion, list_available_models, get_loaded_model
           │
           ├── WebResearchServer (web-research)
           │     └── Tools: research_topic
           │
           ├── MemoryServer (memory)
           │     └── Tools: remember, recall, forget, list_memories, update_memory, reflect_on_session, apply_reflection_changes
           │
           ├── BrowserServer (browser)
           │     └── Tools: browser_fetch, browser_click, browser_fill, browser_evaluate, browser_pdf
           │
           ├── LocalAgentServer (NEW)
           │     └── Tools: run_local_agent
           │
           └── CodeSearchServer (NEW)
                 └── Tools: build_index, get_index_stats, search_files, search_keyword, search_semantic, search_code
```

## Server Module Interface

All server modules follow this pattern (extracted from existing modules):

```javascript
export class ServerModule {
  constructor(config, llmRouter = null) {
    this.router = llmRouter;
    this.progressCallback = null;
  }

  // Required
  getTools() { return [{ name, description, inputSchema }]; }
  handlesTool(name) { return /* boolean */; }
  async callTool(name, args) { return { content: [{ type: 'text', text }] }; }

  // Optional
  setProgressCallback(callback) { this.progressCallback = callback; }
  sendProgress(progress, total, message) { /* ... */ }
  getResources() { return []; }
  readResource(uri) { return { contents: [...] }; }
  getPrompts() { return []; }
  getPrompt(name) { return { ... }; }
}
```

## New Modules Implementation

### 1. Shared Library: `src/lib/workspace.js`

**Must be created first** - used by both Local Agent and Code Search.

```javascript
export class WorkspaceResolver {
  constructor(config) {
    this.defaultMachine = config.defaultMachine;
    this.machines = config.machines || {};
  }

  // Translate local path to UNC path
  resolvePath(localPath, machine = null) { /* longest prefix match */ }
  
  // Validate path is within allowed shares
  validatePath(uncPath) { /* security check */ }
  
  // List configured workspaces
  listMachines() { /* return config */ }
}
```

### 2. Local Agent Server: `src/servers/local-agent.js`

```javascript
import { WorkspaceResolver } from '../lib/workspace.js';

export class LocalAgentServer {
  constructor(config, llmRouter) {
    this.router = llmRouter;
    this.workspace = new WorkspaceResolver(config);
    this.maxTokenBudget = config.maxTokenBudget || 50000;
    this.maxIterations = config.maxIterations || 20;
    this.agentModel = config.model || null; // null = router default
  }

  getTools() {
    return [{
      name: 'run_local_agent',
      description: '...',
      inputSchema: { ... }
    }];
  }

  handlesTool(name) { return name === 'run_local_agent'; }

  async callTool(name, args) {
    const { task, path, machine, maxTokens } = args;
    const uncPath = this.workspace.resolvePath(path, machine);
    return this._runAgentLoop(task, uncPath, maxTokens);
  }

  async _runAgentLoop(task, basePath, maxTokens) {
    // Agent loop using this.router.predict()
    // File tools operate on basePath via fs
  }
}
```

### 3. Code Search Server: `src/servers/code-search.js`

```javascript
import { WorkspaceResolver } from '../lib/workspace.js';

export class CodeSearchServer {
  constructor(config, llmRouter) {
    this.router = llmRouter;
    this.workspace = new WorkspaceResolver(config);
    this.indexPath = config.indexPath || 'data/indexes';
    this.indexes = new Map(); // workspace -> index data
  }

  getTools() {
    return [
      { name: 'build_index', ... },
      { name: 'get_index_stats', ... },
      { name: 'search_files', ... },
      { name: 'search_keyword', ... },
      { name: 'search_semantic', ... },
      { name: 'search_code', ... }
    ];
  }

  handlesTool(name) {
    return ['build_index', 'get_index_stats', 'search_files', 
            'search_keyword', 'search_semantic', 'search_code'].includes(name);
  }
}
```

## Config Schema Addition

Add to `config.json`:

```json
{
  "servers": {
    "local-agent": {
      "enabled": true,
      "defaultMachine": "COOLKID",
      "machines": {
        "COOLKID": {
          "D:\\Work": "\\\\COOLKID\\Work",
          "D:\\DEV": "\\\\COOLKID\\DEV"
        },
        "FATTEN": {
          "E:\\Projects": "\\\\FATTEN\\Projects"
        }
      },
      "maxTokenBudget": 50000,
      "maxIterations": 20,
      "model": null
    },
    "code-search": {
      "enabled": true,
      "indexPath": "data/indexes",
      "embeddingProvider": null
    }
  }
}
```

**Note**: `machines` config is shared. Code Search uses same `machines` from `local-agent` config (or we move to a top-level `workspaces` key).

## http-server.js Modifications

Add to server initialization section (~line 80-110):

```javascript
// After BrowserServer initialization

if (config.servers['local-agent']?.enabled) {
  const { LocalAgentServer } = await import('./servers/local-agent.js');
  const s = new LocalAgentServer(config.servers['local-agent'], llmRouter);
  serverModules.set('local-agent', s);
  tools.push(...s.getTools());
  console.log('✓ Local Agent');
}

if (config.servers['code-search']?.enabled) {
  const { CodeSearchServer } = await import('./servers/code-search.js');
  // Share workspace config from local-agent if not specified
  const searchConfig = {
    ...config.servers['code-search'],
    machines: config.servers['code-search'].machines || config.servers['local-agent']?.machines
  };
  const s = new CodeSearchServer(searchConfig, llmRouter);
  serverModules.set('code-search', s);
  tools.push(...s.getTools());
  console.log('✓ Code Search');
}
```

## LLM Router: New Task Type

Add `agent` task type for agent loop queries:

```json
{
  "llm": {
    "taskDefaults": {
      "embedding": "lmstudio",
      "analysis": "lmstudio",
      "synthesis": "lmstudio",
      "query": "lmstudio",
      "agent": "lmstudio"  // NEW - for local agent tool-calling
    }
  }
}
```

This allows routing agent requests to a model that handles tool-calling well (e.g., Qwen 2.5) while other tasks use different models.

## Module Interaction

```
┌───────────────────────────────────────────────────────────────────┐
│  Claude: "run_local_agent: find bugs in D:\Work\SoundApp"        │
└───────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  LocalAgentServer.callTool()                                      │
│  1. WorkspaceResolver.resolvePath() → \\COOLKID\Work\SoundApp     │
│  2. Check if CodeSearchServer has index for this workspace        │
│     ├── YES: Use search_semantic, search_keyword as agent tools   │
│     └── NO:  Use basic fs tools (list_dir, read_file, grep)       │
│  3. Run agent loop with selected tools                            │
│  4. Return summary                                                │
└───────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│  Claude receives: "Found 3 potential issues: 1) SQL injection..." │
│  (No code in response, just summary)                              │
└───────────────────────────────────────────────────────────────────┘
```

## Inter-Module Communication

LocalAgentServer needs to query CodeSearchServer. Options:

### Option A: Direct Reference (Recommended)
Pass CodeSearchServer instance to LocalAgentServer:

```javascript
// In http-server.js
const codeSearchServer = serverModules.get('code-search');
const localAgentServer = new LocalAgentServer(config, llmRouter, codeSearchServer);
```

### Option B: Lookup via serverModules Map
LocalAgentServer gets reference to serverModules map:

```javascript
constructor(config, llmRouter, serverModules) {
  this.codeSearch = serverModules.get('code-search');
}
```

### Option C: Internal Tool Calls
LocalAgentServer calls `codeSearchServer.callTool()` directly:

```javascript
async _getAgentTools(basePath) {
  if (this.codeSearch) {
    const stats = await this.codeSearch.callTool('get_index_stats', { path: basePath });
    if (stats.indexed) {
      return this._getSearchTools(); // Use search tools
    }
  }
  return this._getBasicTools(); // Fall back to fs tools
}
```

## File Structure After Implementation

```
src/
├── http-server.js          # Add local-agent and code-search initialization
├── lib/
│   └── workspace.js        # NEW: Shared path resolver
├── servers/
│   ├── browser.js
│   ├── code-analyzer.js
│   ├── code-search.js      # NEW: Indexing and search
│   ├── lm-studio-ws.js
│   ├── local-agent.js      # NEW: Autonomous agent
│   ├── memory.js
│   └── web-research.js
└── llm/
    └── router.js           # Add 'agent' task type support
```

## Implementation Order

| Order | Component | Depends On | Effort |
|-------|-----------|------------|--------|
| 1 | `src/lib/workspace.js` | None | 1h |
| 2 | Config schema update | None | 0.5h |
| 3 | `src/servers/local-agent.js` | 1, 2 | 4h |
| 4 | http-server.js integration | 3 | 0.5h |
| 5 | **Test local-agent standalone** | 4 | 1h |
| 6 | `src/servers/code-search.js` | 1, 2 | 6h |
| 7 | http-server.js code-search | 6 | 0.5h |
| 8 | Local-agent ↔ code-search link | 5, 7 | 2h |
| 9 | **End-to-end testing** | 8 | 2h |
| **Total** | | | **~17h** |

## Testing Strategy

### Phase 1: Path Resolution
```javascript
// test/test-workspace.js
const resolver = new WorkspaceResolver(config);
assert(resolver.resolvePath('D:\\Work\\SoundApp', 'COOLKID') === '\\\\COOLKID\\Work\\SoundApp');
assert.throws(() => resolver.resolvePath('C:\\Windows\\System32')); // Not allowed
```

### Phase 2: Local Agent (No Code Search)
```javascript
// Via MCP tool call
{ 
  task: "List all JavaScript files and count lines of code",
  path: "D:\\DEV\\mcp_server"
}
// Expect: Agent uses basic fs tools, returns summary
```

### Phase 3: Code Search Standalone
```javascript
// Build index
{ name: 'build_index', args: { path: 'D:\\DEV\\mcp_server' } }

// Search
{ name: 'search_semantic', args: { query: 'memory embedding', path: 'D:\\DEV\\mcp_server' } }
```

### Phase 4: Integrated
```javascript
// Local agent with indexed workspace
{ 
  task: "How does the LLM router select providers?",
  path: "D:\\DEV\\mcp_server"
}
// Expect: Agent uses search_semantic first, then read_file on top results
```

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| UNC paths fail intermittently | Add retry logic, clear error messages |
| Local LLM tool-calling unreliable | Test multiple models, add fallback parsing |
| Token budget exceeded mid-analysis | Return partial results with warning |
| Index grows too large | Per-workspace indexes, prune on build |
| Module coupling too tight | Clear interface boundaries, dependency injection |

## Success Criteria

1. **Local Agent**: Can answer "What does X do?" about any configured workspace without Claude reading files
2. **Code Search**: Semantic search returns relevant files in <1s
3. **Integration**: Agent uses search tools when index available, falls back gracefully
4. **Token Savings**: Claude's context usage reduced by 80%+ for code analysis tasks

## Related Documents

- [Local Agent Module](local-agent-module.md) - Detailed agent design
- [Code Search Module](code-search-module.md) - Indexing and search design
- [LLM Architecture](llm-architecture.md) - Router and adapter patterns
