# Local Agent Module

**Module**: `src/servers/local-agent.js`
**Status**: Planned
**Created**: January 31, 2026
**Updated**: February 1, 2026

## Design Principles

1. **Robustness over performance** - Every operation must fail gracefully with clear diagnostics
2. **LLM-maintainable code** - Explicit logic, no clever abstractions, self-documenting
3. **Defense in depth** - Multiple validation layers for path security
4. **Graceful degradation** - Always return useful partial results when possible

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

### Path Resolution (Critical - Security Boundary)

Client machines expose shares, MCP server translates local paths to UNC.

**Resolution algorithm** (implemented in `src/lib/workspace.js`):

```javascript
resolvePath(localPath, machine) {
  // 1. Normalize input: lowercase, forward slashes, no trailing slash
  const normalized = localPath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
  
  // 2. Get shares for machine, sorted by prefix length DESCENDING
  const shares = Object.entries(config.machines[machine])
    .map(([local, unc]) => ({ 
      local: local.toLowerCase().replace(/\\/g, '/').replace(/\/$/, ''), 
      unc 
    }))
    .sort((a, b) => b.local.length - a.local.length);
  
  // 3. Find longest matching prefix
  for (const share of shares) {
    if (normalized.startsWith(share.local)) {
      const remainder = normalized.slice(share.local.length);
      return share.unc + remainder.replace(/\//g, '\\');
    }
  }
  
  throw new Error(`No share configured for path: ${localPath} on machine: ${machine}`);
}
```

**Post-resolution validation** (MANDATORY after every resolvePath call):

```javascript
async validateResolvedPath(uncPath, allowedShares) {
  // 1. Resolve to real path (follows symlinks/junctions)
  const realPath = await fs.realpath(uncPath);
  
  // 2. Normalize for comparison
  const normalizedReal = realPath.toLowerCase().replace(/\//g, '\\');
  
  // 3. Check real path is still within allowed shares
  const isAllowed = allowedShares.some(share => 
    normalizedReal.startsWith(share.toLowerCase())
  );
  
  if (!isAllowed) {
    throw new Error(`Path escapes allowed shares: ${uncPath} resolved to ${realPath}`);
  }
  
  return realPath;
}
```

**Edge cases handled**:
| Case | Handling |
|------|----------|
| Case mismatch (`D:\work` vs `D:\Work`) | Normalize to lowercase before matching |
| Overlapping shares | Sort by length descending, match first (longest) |
| Symlinks/junctions escaping share | `fs.realpath()` + re-validate against allowed shares |
| Trailing slashes | Strip before matching |
| `..` in path | Reject BEFORE resolution, also caught by realpath validation |
| Path not in any share | Throw clear error with configured shares listed |

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

**IMPORTANT**: Workspace config is TOP-LEVEL, shared by Local Agent and Code Search modules.

```json
{
  "workspaces": {
    "defaultMachine": "COOLKID",
    "machines": {
      "COOLKID": {
        "D:\\Work": "\\\\COOLKID\\Work",
        "D:\\DEV": "\\\\COOLKID\\DEV"
      },
      "FATTEN": {
        "E:\\Projects": "\\\\FATTEN\\Projects"
      }
    }
  },
  "servers": {
    "local-agent": {
      "enabled": true,
      "maxTokenBudget": 50000,
      "maxIterations": 20,
      "model": null,
      "toolCallingFormat": "json-in-prompt"
    },
    "code-search": {
      "enabled": true,
      "indexPath": "data/indexes"
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `workspaces.defaultMachine` | Machine to use when not specified in tool call |
| `workspaces.machines` | Map of machine name → share mappings (shared by all modules) |
| `servers.local-agent.maxTokenBudget` | Max tokens agent can read before forced stop |
| `servers.local-agent.maxIterations` | Max tool-call loops before forced stop |
| `servers.local-agent.model` | Specific model for agent (null = router default for task `agent`) |
| `servers.local-agent.toolCallingFormat` | `json-in-prompt` or `native` - model-dependent |

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

## Error Handling (Exhaustive)

**Principle**: Every error returns actionable diagnostics. Never fail silently.

| Error | Detection | Response | Recovery |
|-------|-----------|----------|----------|
| UNC share unreachable | `fs.access()` fails with ENOENT/ETIMEDOUT | `{ error: 'SHARE_UNREACHABLE', share: '\\\\COOLKID\\Work', hint: 'Check: 1) Machine online, 2) Share exists, 3) Firewall allows SMB' }` | None - fail fast |
| Share permission denied | `fs.access()` fails with EACCES | `{ error: 'SHARE_ACCESS_DENIED', share: '...', hint: 'Check share permissions for MCP server machine account' }` | None - fail fast |
| Path escapes share (symlink) | `validateResolvedPath()` throws | `{ error: 'PATH_ESCAPE', requested: '...', resolved: '...', hint: 'Symlink points outside allowed shares' }` | None - security violation |
| Token budget exceeded | `tokensUsed > maxTokenBudget` | `{ warning: 'TOKEN_BUDGET_EXCEEDED', tokensUsed: 52000, budget: 50000, partialResult: '...' }` | Return partial results |
| Max iterations exceeded | `iteration >= maxIterations` | `{ warning: 'MAX_ITERATIONS', iterations: 20, partialResult: '...' }` | Return partial results |
| LLM tool parse failure | JSON.parse throws or schema validation fails | Retry once with repair prompt, then `{ error: 'TOOL_PARSE_FAILED', lastOutput: '...', attempts: 2 }` | Retry once |
| LLM stuck in loop | Same tool+args 3x consecutively | Force `done` with current findings | Force completion |
| LLM unavailable | Router returns connection error | `{ error: 'LLM_UNAVAILABLE', provider: 'lmstudio', hint: 'Check LM Studio is running' }` | None - fail fast |
| File read error (single file) | `fs.readFile()` throws | Log warning, skip file, continue | Continue with other files |
| No files found | `list_dir` returns empty | `{ warning: 'EMPTY_WORKSPACE', path: '...' }` | Return warning, not error |

## Agent Loop Implementation (Detailed)

```javascript
async runAgentLoop(task, basePath, maxTokens, maxIterations) {
  const state = {
    tokensUsed: 0,
    iteration: 0,
    history: [],           // { role, content } for LLM context
    toolCallHistory: [],   // [{ tool, args }] for loop detection
    findings: []           // Accumulated results
  };

  // Build system prompt with tool definitions
  const systemPrompt = buildAgentSystemPrompt(this.agentTools, basePath);
  state.history.push({ role: 'system', content: systemPrompt });
  state.history.push({ role: 'user', content: task });

  while (state.iteration < maxIterations) {
    state.iteration++;

    // 1. Call LLM
    const llmResponse = await this.router.predict({
      messages: state.history,
      taskType: 'agent',
      model: this.config.model
    });

    // 2. Parse tool call from response
    const toolCall = this.parseToolCall(llmResponse.content);
    
    if (!toolCall) {
      // No valid tool call - retry once with hint
      if (state.lastWasRetry) {
        return { error: 'TOOL_PARSE_FAILED', lastOutput: llmResponse.content };
      }
      state.history.push({ role: 'assistant', content: llmResponse.content });
      state.history.push({ role: 'user', content: 'Please respond with a valid tool call in JSON format.' });
      state.lastWasRetry = true;
      continue;
    }
    state.lastWasRetry = false;

    // 3. Loop detection
    state.toolCallHistory.push(toolCall);
    if (this.isStuckInLoop(state.toolCallHistory)) {
      return {
        warning: 'AGENT_STUCK',
        iterations: state.iteration,
        partialResult: this.synthesizeFindings(state.findings)
      };
    }

    // 4. Execute tool
    if (toolCall.tool === 'done') {
      return { success: true, result: toolCall.args.summary, iterations: state.iteration };
    }

    const toolResult = await this.executeTool(toolCall, basePath, state);
    
    // 5. Update state
    state.history.push({ role: 'assistant', content: llmResponse.content });
    state.history.push({ role: 'user', content: `Tool result:\n${JSON.stringify(toolResult)}` });
    
    if (toolResult.content) {
      state.findings.push({ tool: toolCall.tool, result: toolResult });
    }

    // 6. Check token budget
    if (state.tokensUsed > maxTokens) {
      return {
        warning: 'TOKEN_BUDGET_EXCEEDED',
        tokensUsed: state.tokensUsed,
        budget: maxTokens,
        partialResult: this.synthesizeFindings(state.findings)
      };
    }
  }

  return {
    warning: 'MAX_ITERATIONS',
    iterations: maxIterations,
    partialResult: this.synthesizeFindings(state.findings)
  };
}

isStuckInLoop(history) {
  if (history.length < 3) return false;
  const last3 = history.slice(-3);
  return last3.every(h => 
    h.tool === last3[0].tool && 
    JSON.stringify(h.args) === JSON.stringify(last3[0].args)
  );
}
```

## Tool Calling Format

**Two modes** (configured via `toolCallingFormat`):

### Mode 1: `json-in-prompt` (Default, More Reliable)

System prompt includes tool definitions as JSON schema. LLM responds with:

```json
{"tool": "read_file", "args": {"path": "src/auth.js"}}
```

Parsing: `JSON.parse()` + schema validation against tool inputSchema.

### Mode 2: `native` (Model-Dependent)

Use LLM's native function calling (OpenAI-style). Only for models that support it well.

**Recommended models for tool-calling** (tested):
- ✅ Qwen 2.5-Coder 7B/14B - Excellent JSON adherence
- ✅ Llama 3.1 8B/70B - Good with json-in-prompt
- ⚠️ Mistral-Nemo - Occasional format issues
- ❌ Smaller models (<7B) - Unreliable

## Security Considerations

- **Path validation**: All paths checked against configured shares before access
- **No write access**: Agent is read-only by design
- **Token limits**: Prevent local model from consuming excessive resources
- **Iteration limits**: Prevent infinite loops
- **Share boundaries**: Cannot access paths outside configured shares

## Open Questions (Resolved)

1. **Model selection**: Use Qwen 2.5-Coder for reliable tool-calling. Configure via `model` field or router task `agent`.
2. **Tool format**: Default to `json-in-prompt` for reliability. Support `native` for compatible models.
3. **Progress streaming**: Send MCP notifications during iteration (iteration count, current tool).
4. **Caching**: No file listing cache - UNC access is fast enough, cache invalidation is complex.

## Graceful Degradation Matrix

| Component Down | Behavior |
|----------------|----------|
| Target machine offline | Fail with SHARE_UNREACHABLE, list configured machines |
| LM Studio unavailable | Fail with LLM_UNAVAILABLE, suggest checking LM Studio |
| Code Search index missing | Fall back to basic file tools (no semantic search) |
| Code Search server disabled | Use basic file tools only |
| Single file unreadable | Skip file, log warning, continue with others |

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
