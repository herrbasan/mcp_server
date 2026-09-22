# Chat — persistent headless LLM sessions

Reference documentation for named, disk-persisted LLM sessions. Last verified
2026-09-22 against `src/agents/chat/index.js` and root `config.json`.

## What it is

The chat app minus the interface: named sessions with a pinned model, full
conversation history persisted to disk, and the ability to call workshop
tools through a single `workshop` dispatcher. Sessions survive restarts and
are addressable by name from any platform.

## Persistence

- One pretty-printed JSON per session: `data/chat/sessions/<name>.json` =
  `{name, model, systemPrompt, createdAt, updatedAt, messages[]}`.
- Name charset `/^[a-z0-9][a-z0-9._-]*$/`; create throws if the name exists.
- Stored messages are a superset of the wire format (`createdAt, toolName,
  toolStatus, model, usage, tool_calls, tool_call_id`) — `toWire()` strips
  them for API calls.
- **Atomicity**: a user message persists only with its first completed hop;
  each completed hop (assistant message + its tool results) is one atomic
  write. Malformed tool-call arguments are sanitized to `'{}'` BEFORE
  persisting (prevents history poisoning → provider 502).

## Tools (10)

| Tool | Args | Returns (JSON in text) |
|---|---|---|
| `chat.create` | `name*`, `model*`, `systemPrompt?` | `{ok, name, model, messageCount: 0, historyBytes: 0}`. Model validated against `chat.models` at create. |
| `chat.models` | — | `{models: [{id, ownedBy?, type?}]}` — the authoritative model-ID source. |
| `chat.send` | `name*`, `message*`, `model?` (per-send override, pin unchanged) | `{reply, toolCalls: [{name,status,error?}], hops, usage, messageCount, historyBytes}`. |
| `chat.inject` | `name*`, `messages? [{role,content}]`, `files? [storage paths]` | Appends context WITHOUT calling the model. Files: `storage.stat` → size check (≤5 MB) → full read, appended as `=== storage:<path> ===\n<content>`. |
| `chat.list` | — | All sessions with counts and sizes. |
| `chat.status` | `name?` | Live/last run detail: phase, hops, current tool, token tally, last 20 events. In-memory only (dies with the process); unknown name → phase `never-run`. |
| `chat.history` | `name*`, `lastN?` | Stored messages, chronological, full fidelity. |
| `chat.update` | `name*`, `systemPrompt?`, `model?` (≥1 required) | Mid-life re-pin. |
| `chat.compact` | `name*`, `strategy*` clear\|truncate\|summarize, `keep?`, `upTo?`, `model?` | clear: wipe (keep last N); truncate: keep last N; summarize: messages [0..upTo) replaced by ONE model-generated summary — history rewritten only after the summary exists. |
| `chat.delete` | `name*` | Irreversible. |

## Tool loop (chat.send)

- The model sees exactly ONE function tool: **`workshop`** —
  `{method: 'agent.action', payload: {…}}`. Its description is built live
  from the server's method catalog minus `toolsExclude` prefixes.
- `finish_reason: 'tool_calls'` → tools execute sequentially; unknown tool /
  bad JSON / excluded method / router throw → stored as tool-result with
  `toolStatus: 'error'` and the loop CONTINUES. `'stop'` → persist + reply.
  Anything else → throw.
- **Hop cap** 25 (`maxHopsPerSend`); exceeding throws with guidance (history
  persists through the last completed hop).
- **Concurrency**: per-session arrival-order queue + global cap of 4
  concurrent runs (`maxConcurrentRuns`); over → throw.
- **Retry**: exactly 1 retry after 3 s on connection-level failures
  (ECONNREFUSED/ECONNRESET/EPIPE/…); retry failure explicitly says the
  session is intact.
- **Recursion guard**: a session calling `chat.send` on an ancestor in its
  run-chain fails as a tool-result error before queueing (bounded recursion).
- Gateway call: `stream: false`, `timeoutMs: 120000` (`requestTimeoutMs`).

## Config (`agents.chat`, effective)

`dir: 'data/chat/sessions'`, `maxHopsPerSend: 25`, `maxConcurrentRuns: 4`,
`toolsExclude: []`, `requestTimeoutMs: 120000`, `maxInjectFileBytes: 5 MB`
(code default — not overridden).
