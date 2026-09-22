# LLM — direct model access

Reference documentation for one-shot queries and pinned sessions with clean
context. Last verified 2026-09-22 against `src/agents/llm/index.js`.

## What it is

The escape hatch from context-window tunnel vision: ask a model a question
with NO session baggage. Use for second opinions, sanity checks on
architectural decisions, and meta-analysis.

## Tools (4)

| Tool | Args | Behavior |
|---|---|---|
| `llm.query` (`query_model`) | `prompt*`, `files?` (absolute paths, inlined as `--- File: <path> ---` blocks), `systemPrompt?` | One-shot gateway chat, task `query`, STREAMING with progress (phases: reasoning_started, routing, context_stats). Returns raw response text. |
| `llm.session_create` | `model*`, `files?`, `systemPrompt?` | In-memory pinned session; files ingested once as user/assistant pairs. Model validated against `chat.models` — fail-fast with the valid-ID list. Returns `lls_<ts>_<rand>` id. |
| `llm.session_query` | `sessionId*`, `prompt*`, `model?` (per-call override; pin unchanged) | Replays the FULL message array each call — the gateway is stateless; the session is client-side history. |
| `llm.session_close` | `sessionId*` | Frees the session. |

## System-prompt resolution (llm.query)

Chain, first hit wins:

1. `args.systemPrompt` — only pass one when the situation truly needs a
   different frame; the default is the point.
2. The `## Principles` section of
   `<storageRoot>/documentation/Workshop/Agents_Prime.md` — so second
   opinions reason from the same maxims, not human-conventional habits.
3. `prompts/system.txt` — exists but is EMPTY (0 bytes); effectively dead.
4. All missing → throw `'llm.query: no system prompt available'`.

## Limits

- Session TTL **60 min**, enforced lazily on create/query (no timer).
- Max **8** concurrent sessions (sweep evicts expired first).
- Pin routing: the pinned/override model is sent as `model`, never `task` —
  in the gateway client a `task` would win over `model`.
- Sessions are in-memory only — they die with the process (unlike chat-agent
  sessions, which persist to disk).

## Config

No `agents.llm` section exists in root config.json — code defaults apply.
(`agents.llm.sessionTtlMinutes` / `sessionMaxSessions` are the knobs if ever
needed.)
