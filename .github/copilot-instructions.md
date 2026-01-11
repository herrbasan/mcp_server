# MCP Server Orchestrator - Development Guidelines

## Project Overview
Centralized MCP server running as **independent HTTP/SSE service** on remote machine (192.168.0.100). Manages multiple specialized servers and exposes 14 tools to VS Code Copilot clients via network.

**Architecture**: StreamableHTTPServerTransport (not stdio, not legacy SSE)
- Server: `src/http-server.js` - Ports 3100 (MCP), 3010 (web monitoring)
- Transport: HTTP POST with `Mcp-Session-Id` header, session-based multiplexing
- Web UI: Real-time SSE log streaming, memory browser
- Deployment: Remote server, clients connect via `mcp.json` with `type: "sse"`, `url: "http://IP:3100/mcp"`

**Tools** (14 across 4 modules):
- **Memory**: Quality-focused semantic memory with confidence ranking (remember, recall, forget, list_memories, update_memory, reflect_on_session, apply_reflection_changes)
- **LM Studio**: WebSocket-based local model integration (query_model, get_second_opinion, list_available_models, get_loaded_model)
- **Code Analyzer**: Code quality analysis (analyze_code_quality, suggest_refactoring)
- **Web Research**: Multi-source web research with local LLM synthesis (research_topic)

## LM Studio Integration
- **Transport**: WebSocket via custom LMStudioAPI submodule (github.com/herrbasan/LMStudioAPI.git)
- **Progress**: Real-time MCP notifications (model loading 1%-100%, generation status)
- **Auto-unload**: Single model enforcement via `enforceSingleModel: true`
- **Model Management**: Auto-detect loaded model, validate against whitelist, fallback to config default
- **Error Handling**: Promise lock prevents race conditions, stack traces preserved for debugging

## Deployment & Configuration
- **Environment**: `.env` file for sensitive config (LM Studio endpoints, embedding model, host/port binding)
- **Config**: `config.json` for non-sensitive settings (models, prompts, timeouts, enable/disable servers)
- **Start**: `npm run start:http` (production remote), `npm start` (local stdio dev)
- **Endpoints**: LM_STUDIO_WS_ENDPOINT (ws://localhost:12345), LM_STUDIO_HTTP_ENDPOINT (http://localhost:12345)
- **Binding**: MCP_HOST/WEB_HOST must be `0.0.0.0` for remote access (not localhost)
- **Firewall**: OPNsense/Windows Firewall rules for TCP 3100, 3010
- **Client Config**: VS Code `mcp.json` (not settings.json) with `{"type": "sse", "url": "http://IP:3100/mcp"}`

## Memory System Philosophy
Memory exists to improve OUTPUT QUALITY, not store user preferences. Categories:
- **proven**: Evidence-backed approaches that produce good outcomes
- **anti_patterns**: Approaches that have caused problems
- **observed**: Behavioral patterns, may be promoted to proven
- **hypotheses**: Untested ideas
- **context**: Project facts, background info

## Code Style & Philosophy
- **Language**: Vanilla JavaScript (ES modules) - NO TypeScript
- **Approach**: Lean, simple, fast code
- **Priority**: Performance and conciseness over readability/maintainability
- **Rationale**: Code is maintained by LLM, not humans
- **Style**: Minimal abstractions, direct implementations, no unnecessary complexity
- **Comments**: Avoid - code should be self-documenting
- **Hardening**: Use promise locks, validate inputs, proper error rollback, URL constructor for endpoints

## Key Principles
- Use modern ES6+ features (async/await, destructuring, etc.)
- Keep functions small and focused
- Avoid over-engineering
- Inline code when it makes execution faster
- Minimal dependencies - build custom solutions over third-party libraries
- Preserve stack traces in errors, throw don't log
- Validate model IDs against available models before use
