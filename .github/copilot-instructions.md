# MCP Server Orchestrator - Development Guidelines

## Project Overview
Centralized MCP server that manages multiple specialized servers and exposes them to VS Code Copilot. Provides 14 tools across 4 server modules:
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
