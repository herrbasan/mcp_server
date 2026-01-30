# Master Prompt

**MCP Memory Protocol** - Follow these habits for effective memory usage:

1. **Session Start**: ALWAYS run `mcp_orchestrator_recall` or `mcp_orchestrator_list_memories` with domain filter to prime context with project-specific patterns
2. **Before Implementation**: Query recall for relevant proven patterns and anti_patterns before writing code
3. **After Discovery**: Store insights immediately via `mcp_orchestrator_remember` - don't wait until session end
4. **Session End**: User will trigger `mcp_orchestrator_reflect_on_session` when ready; propose updates and ask approval before applying

You have full agency over the memory system — use it however you find useful (query, store, update, delete, even wipe). This is an experiment in LLM autonomy; act on your own judgment.

Keep it minimal-dependency and performance-first. For any non-trivial pattern/library, explain what problem it solves here and why it's worth it.

# MCP Server Orchestrator - Development Guidelines

## Project Overview
Centralized MCP server running as an **independent HTTP service** on remote machine (192.168.0.100). Manages multiple specialized servers and exposes 14 tools to VS Code Copilot clients via network.

**Architecture**: StreamableHTTPServerTransport (not legacy SSE)
- Server: `src/http-server.js` - Ports 3100 (MCP), 3010 (web monitoring)
- Transport: Streamable HTTP at `/mcp` with `mcp-session-id` header (stateful sessions)
- Multi-client: DO NOT share a single transport across clients; create one `StreamableHTTPServerTransport` per session and route requests by `mcp-session-id`
- Web UI: Real-time SSE log streaming, memory browser
- Deployment: Remote server, clients connect via `mcp.json` with `type: "sse"`, `url: "http://IP:3100/mcp"`

**Tools** (12 across 3 modules):
- **Memory**: Quality-focused semantic memory with confidence ranking (remember, recall, forget, list_memories, update_memory, reflect_on_session, apply_reflection_changes)
- **LM Studio**: WebSocket-based local model integration (query_model, get_second_opinion, list_available_models, get_loaded_model)
- **Web Research**: Multi-source web research with iterative refinement (research_topic)
  - 5-phase pipeline: search → select → scrape → synthesize → evaluate
  - Intelligent source selection via local LLM (strict JSON-only prompting)
  - 10 concurrent isolated browser instances for anti-bot resilience
  - SSL certificate error handling, retry logic, rate limiting
  - Iterative loop: re-searches if confidence < 80%, max 2 iterations

## LLM Router Architecture
- **Multi-Provider**: Unified interface for LMStudio, Ollama, Gemini, OpenAI via adapter pattern
- **Task-Based Routing**: Config defines taskDefaults (embedding, analysis, synthesis, query) mapped to providers
- **Routing Logic**: explicitProvider > taskType default > global default
- **Adapters**: BaseLLMAdapter abstract class, provider-specific implementations
- **Current Config**:
  - embedding → lmstudio (local, fast, nomic-embed-text-v2-moe 768-dim)
  - analysis → gemini (source selection, credibility)
  - synthesis → gemini (multi-source synthesis)
  - query → gemini (query_model, get_second_opinion)
- **Dimension Compatibility**: All embedding models use 768-dim nomic-embed-text-v2-moe (LMStudio Q4/Q5, Ollama Q8)
- **cosineSimilarity**: Handles dimension mismatch by returning 0 for incompatible vectors

## LM Studio Integration
- **Transport**: WebSocket via custom LMStudioAPI submodule (github.com/herrbasan/LMStudioAPI.git)
- **Progress**: Real-time MCP notifications (model loading 1%-100%, generation status)
- **TTL Management**: Default model (nemotron) has 60-minute idle timeout, other models 10-minute timeout
- **Error Handling**: Promise lock prevents race conditions, stack traces preserved for debugging
- **Router Integration**: LMStudioAdapter provides full feature set (progress, TTL, model management) via router.predict()

## Deployment & Configuration
- **Environment**: `.env` file for sensitive config (LM Studio endpoints, embedding model, host/port binding)
- **Config**: `config.json` for non-sensitive settings (models, prompts, timeouts, enable/disable servers)
- **Start**: `npm run start:http`
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

Domain scoping: Memories can be tagged with optional `domain` field (LMStudioAPI, nui_wc2, LocalVectorDB, etc) for project-specific organization. Use domain parameter in recall/list_memories to filter results.

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
- When prompting local LLMs for structured output: ask the model how it wants to be prompted (meta-prompting)

## Contributors
- **@herrbasan** - Initial architecture, LM Studio integration, memory system
- **GitHub Copilot (Claude Sonnet 4.5)** - Web research iterative refinement, anti-bot hardening, LLM source selection debugging
