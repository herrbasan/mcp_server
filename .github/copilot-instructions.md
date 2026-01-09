# MCP Server Orchestrator - Development Guidelines

## Project Overview
Centralized MCP server that manages multiple specialized servers and exposes them to VS Code Copilot. Provides 10 tools across 4 server modules:
- **Memory**: Persistent semantic memory with embeddings (remember, recall, forget, list_memories, update_memory)
- **LM Studio**: Local model integration (get_second_opinion)
- **Code Analyzer**: Code quality analysis (analyze_code_quality, suggest_refactoring)
- **Docs Helper**: Documentation generation (generate_jsdoc, explain_api)

## Code Style & Philosophy
- **Language**: Vanilla JavaScript (ES modules) - NO TypeScript
- **Approach**: Lean, simple, fast code
- **Priority**: Performance and conciseness over readability/maintainability
- **Rationale**: Code is maintained by LLM, not humans
- **Style**: Minimal abstractions, direct implementations, no unnecessary complexity
- **Comments**: Avoid - code should be self-documenting

## Key Principles
- Use modern ES6+ features (async/await, destructuring, etc.)
- Keep functions small and focused
- Avoid over-engineering
- Inline code when it makes execution faster
- Minimal dependencies - build custom solutions over third-party libraries
