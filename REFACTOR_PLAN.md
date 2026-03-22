# Refactoring Plan: MCP Server Orchestrator

I want to completely refactor this project with the following major goals:

## 1. Externalize LLM Communication
- Remove all internal LLM communication logic.
- Integrate and make use of the external **LLM Gateway** (refer to the `LLM Gateway` codebase) instead.

## 2. Remove WebAdmin
- Remove the WebAdmin from this project.
- Integrate the admin functions into the existing standalone WebAdmin tool (refer to the `WebAdmin` codebase).

## 3. Switch to SSE Transport
- The MCP Orchestrator must be **SSE (Server-Sent Events) based**.
- *Reasoning:* Long-running tasks currently run into timeouts on certain extensions (e.g., Kimi VS Code extension). Sending periodic connection or progress updates will prevent these timeout issues.

## 4. Restructure & Modularize Tools
- The Orchestrator should primarily act as a **proxy** for the tools and serve as the definition for which tool should use which LLM endpoint in the Gateway.
- Each tool should be isolated in a **separate folder** with a standardized definition for its integration into the Orchestrator.
- **Tool Configuration:** The tool name, description, and the prompts used for its tasks should reside in a configuration file within the tool's respective folder.
- **Standalone Capability:** It would be ideal if each tool could operate independently without relying strictly on the Orchestrator.

## 5. Open for Suggestions
Feel free to suggest alternative approaches, structural improvements, or completely different paradigms. These are initial thoughts, and I am open to suggestions on how this should be structured and function.
