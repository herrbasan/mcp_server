# Local Agent Module

**Module**: `src/servers/local-agent.js`
**Status**: Planned
**Created**: January 31, 2026

## Summary

Autonomous local LLM agent with file access to remote workspaces via UNC paths. Enables Claude to delegate code analysis tasks to local models, saving context tokens and leveraging free local compute.

**Key insight**: Claude passes a task + workspace path → MCP server translates to UNC → local LLM browses files autonomously → returns summary only (no code in response).

## Motivation

When Claude needs a "second opinion" or code analysis from a local LLM, it currently must:
1. Read the file (costs Claude tokens)
2. Send content to MCP tool (costs Claude tokens again)
3. Wait for response

With local agent:
1. Claude sends task + path reference
2. Local LLM reads files directly via UNC
3. Claude receives summary only

**Token savings**: 100% of file content tokens saved in Claude's context.

## Architecture

### Path Resolution

Client machines expose shares, MCP server translates local paths to UNC:

```
Input:  D:\Work\_GIT\SoundApp  (machine: COOLKID)
Match:  D:\Work → \\COOLKID\Work
Output: \\COOLKID\Work\_GIT\SoundApp
```

Longest prefix match ensures specific shares override general ones.

### Agent Loop

```
┌─────────────────────────────────────────────────────────┐
│  Claude: "Find auth bugs in D:\Work\_GIT\SoundApp"      │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  MCP Server: Resolve path → \\COOLKID\Work\_GIT\...     │
│              Initialize agent with file tools           │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Local LLM Agent Loop:                                  │
│    1. list_dir("src/")                                  │
│    2. read_file("src/auth.js")                          │
│    3. grep("password", recursive=true)                  │
│    4. read_file("src/utils/crypto.js", lines=50-80)     │
│    5. done("Found 2 issues: ...")                       │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Claude receives: Summary only (no code)                │
└─────────────────────────────────────────────────────────┘
```

### Token Budget

Agent tracks tokens consumed by file reads. Configurable limit (default 50k) prevents runaway costs on local model. When exceeded, agent returns partial results with warning.

## Configuration

```json
{
  "localAgent": {
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
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Enable/disable the module |
| `defaultMachine` | Machine to use when not specified in tool call |
| `machines` | Map of machine name → share mappings |
| `maxTokenBudget` | Max tokens agent can read before forced stop |
| `maxIterations` | Max tool-call loops before forced stop |
| `model` | Specific model for agent (null = router default) |

## MCP Tool

```javascript
{
  name: 'run_local_agent',
  description: 'Run autonomous local LLM agent with file access to analyze code, find bugs, or answer questions about a codebase. Returns summary only - no code in response.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { 
        type: 'string', 
        description: 'What the agent should do' 
      },
      path: { 
        type: 'string', 
        description: 'Local path to workspace (e.g., D:\\Work\\_GIT\\SoundApp)' 
      },
      machine: { 
        type: 'string', 
        description: 'Machine name (default: from config)' 
      },
      maxTokens: { 
        type: 'number', 
        description: 'Token budget (default: 50000)' 
      }
    },
    required: ['task', 'path']
  }
}
```

**Example calls:**
```javascript
// Uses default machine (COOLKID)
{ task: "Find potential security issues", path: "D:\\Work\\_GIT\\SoundApp" }

// Override machine
{ task: "Check build config", path: "E:\\Projects\\webapp", machine: "FATTEN" }

// Custom token budget
{ task: "Summarize architecture", path: "D:\\DEV\\mcp_server", maxTokens: 100000 }
```

## Agent File Tools

Tools available to the local LLM during agent loop (not exposed via MCP):

| Tool | Args | Returns | Notes |
|------|------|---------|-------|
| `list_dir` | `path` | `{ files[], dirs[] }` | Relative to basePath |
| `read_file` | `path`, `startLine?`, `endLine?` | `{ content, lineCount, truncated }` | Counts against token budget |
| `grep` | `pattern`, `path?`, `regex?` | `{ matches[] }` | Recursive by default |
| `find_files` | `glob` | `string[]` | Glob pattern matching |
| `done` | `summary` | Ends loop | Required to complete |

**Security constraints:**
- All paths resolved relative to basePath
- No `..` traversal outside workspace
- Path must resolve to configured share prefix

## Code Search Integration

When code-search module is available, agent **replaces** basic file tools with search tools:

| Basic Tool | Replaced By | Benefit |
|------------|-------------|---------||
| `find_files` | `search_files` | Same, but cached |
| `grep` | `search_keyword` | Ripgrep, faster |
| `read_file` | `get_file_summary` + `read_file` | Read less |
| (none) | `search_semantic` | Find by meaning |

**Detection**: Check if workspace has index via `get_index_stats`. If yes, use search tools. If no, fall back to direct fs access.

**Optimized flow:**
1. `search_semantic("authentication")` → top 10 files with descriptions
2. Pick 2-3 most relevant
3. `read_file` only those
4. Synthesize answer

This further reduces token usage vs. reading everything.

## Implementation Plan

| Phase | Effort | Deliverable |
|-------|--------|-------------|
| 1. Config schema + path resolver | 1h | Path translation works |
| 2. File tools (list, read, grep) | 2h | Can browse UNC paths |
| 3. Agent loop | 3h | Local LLM can iterate |
| 4. MCP tool registration | 1h | Claude can invoke |
| 5. Testing + hardening | 2h | Error handling, edge cases |
| **Total** | **~9h** | Working local agent |

## Performance Targets

| Metric | Target |
|--------|--------|
| Path resolution | <1ms |
| list_dir | <100ms |
| read_file (small) | <50ms |
| grep (1000 files) | <2s |
| Full agent task | <60s |

## Error Handling

| Error | Handling |
|-------|----------|
| UNC path unreachable | Return error with troubleshooting hint |
| Share permission denied | Return error, suggest checking share perms |
| Token budget exceeded | Return partial results + warning |
| Max iterations exceeded | Return current findings + warning |
| LLM tool parse failure | Retry once, then abort with error |
| File read error | Skip file, log warning, continue |

## Security Considerations

- **Path validation**: All paths checked against configured shares before access
- **No write access**: Agent is read-only by design
- **Token limits**: Prevent local model from consuming excessive resources
- **Iteration limits**: Prevent infinite loops
- **Share boundaries**: Cannot access paths outside configured shares

## Open Questions

1. **Model selection**: Which local models handle tool-calling well? Test Qwen 2.5, Llama 3.x, Mistral.
2. **Tool format**: Native function calling vs. JSON-in-prompt? Model-dependent.
3. **Progress streaming**: Send MCP notifications during iteration, or just final result?
4. **Caching**: Cache file listings? Invalidation strategy?

## Shared Utilities

Path resolution is shared with Code Search module:

```
src/lib/workspace.js
├── resolvePath(localPath, machine) → uncPath
├── validatePath(uncPath, basePath) → boolean
└── listWorkspaces() → configured workspaces
```

Both modules use the same config for machine/share mappings.

## Dependencies

- LLM router (existing)
- `src/lib/workspace.js` (shared path resolver)
- Node.js `fs` module (UNC path support built-in)
- Optional: `ripgrep` for fast grep (fallback to JS if unavailable)
- Optional: Code Search module (enhanced search when available)

## Related

- [Code Search Module](code-search-module.md) - Semantic search integration
- [LLM Architecture](llm-architecture.md) - Router and adapter patterns

## Contributors

- **@herrbasan** - Architecture, requirements
- **GitHub Copilot (Claude Opus 4.5)** - Design, documentation
