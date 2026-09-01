# Spec: `chat` agent — persistent headless LLM sessions

**Status**: DRAFT — for review by other models before implementation.
**Workspace**: `d:\DEV\mcp_server` · **Date**: 2026-09-01
**Reference implementation studied**: `D:\SRV\LLM-Gateway-Chat\server\runner.js` (ConversationRunner), `conversation-store.js`

---

## 1. Purpose

Headless chat sessions with a pinned model, persisted to disk, addressable by name from any MCP client. The chat app minus the interface.

Use cases (from the owner, verbatim intent):

1. **Digital twin**: a `deepseek-flash-chat` session (1M context) with all digital-twin documents injected, acting as the twin. Lesser local models ingest new facts by *asking* the session where to place incoming info.
2. **Model-to-model consult**: a `kimi-k3-chat` "coding buddy" session (e.g. `kimi-mcp_server`) that a working model (e.g. GLM) uses to outsource architecture decisions.
3. **Research endpoint**: a long-lived session another model asks while working.

Design stance (owner-confirmed):

- **No templates.** Sessions start blank. The calling model or human seeds context via `chat.inject` (text or storage file paths). Naming is free-form; conventions like `kimi-mcp_server` emerge from use, not schema.
- **No automatic compaction.** The session never compacts on its own. An outside caller explicitly invokes `chat.compact` and picks the strategy.
- **Sessions get MCP tool access.** A session's model can call workshop tools — including other chat sessions. Recursion is bounded, not forbidden.

## 2. Architecture

New agent `src/agents/chat/` following the house pattern (`storage` agent as template):

- `config.json` — `agent: "chat"`, `description`, `tools[]` (8 tools, §4).
- `index.js` — `init(context)` + one exported handler per tool.

Wiring:

- `server.js`: method docs in `COMPACT_TOOL` description (~line 156–719), `COMPACT_TO_LEGACY` entries `"chat.<action>": "chat_<action>"` (~lines 732–773).
- Root `config.json`: new `agents.chat` section (§7).

### 2.1 Gateway call path

`src/gateway-client.js` `chat()` is SSE-only (`stream: true` hardcoded). Extension: **add a `stream: false` mode** to `chat()` returning `{ content, tool_calls, finish_reason, usage }`. Non-streaming is correct for headless turns (no UI to feed), and the gateway supports it (`docs/LLM_GATEWAY_REST_API.md:141`). The SSE path stays untouched; existing callers unaffected.

Request body sent by the chat agent:

```json
{ "model": "<pinned>", "messages": [...], "stream": false }
```

- Model pinned via `model`, never `task` — task routing lets the gateway reroute; a session's identity IS its model. (Lesson from forge model routing, 2026-06-28.)
- `tools` advertised as ONE dispatcher function (§5), so `tools: [dispatcherDef]`.

### 2.2 Tool execution

The agent receives a `callTool(name, args)` function at init — `server.js:105` already destructures `routeToolCall` from `loadAgents`; pass it into the chat agent's init context. Tool calls from a session model execute **in-process** — no HTTP hop to ourselves.

Guard rails (all throw-capable, none silent):

| Guard | Value (config) | Rationale |
|---|---|---|
| Hop cap per `chat.send` | `maxHopsPerSend: 25` | Runner uses 100/200 for supervised UI work; headless one-shot calls get a tighter cap. Cap trips → throw with hop count (caller can inspect + continue). |
| Concurrent session runs | `maxConcurrentRuns: 4` | Bounds cross-session ping-pong (A→B→A→…) resource burn. At capacity → throw. |
| Run-chain cycle guard | in-process chain | See below. **Replaces the self-send rule.** |

### 2.2.1 Run-chain cycle guard (resolves the deadlock the original spec missed)

The per-session queue makes a cycle hang: A's send in-flight → A calls B → B calls A → B's send to A *queues behind A's in-flight send* → A waits for B, B waits for A's queue. Deadlock, held until `requestTimeoutMs` fires. Hop caps and the concurrency cap never trip — nothing exceeds a cap, it just waits.

Guard: an **active run chain** — the stack of session names for the current nested call chain, threaded through `callTool` context into every nested `chat.send`. Before queueing a send: if the target session name is already in the current chain → the tool call fails immediately with `toolStatus:"error"`, message `session <name> is already upstream in this call chain`. Key semantics:

- **The failure surfaces as a tool-result error, not a throw through the nested send.** The inner model sees the error and adapts (per tool-error semantics, §6) — the loop stays alive and reroutes. Self-send is the trivial cycle (name is always in its own chain) and needs no separate rule.
- Non-cyclic nesting (A→B→C) stays legal, bounded by `maxConcurrentRuns`.
- Chain is per-call-tree, not global state: a top-level send to A from an unrelated client starts a fresh chain `[A]`.

A session may call `chat.send` on another session: that inner send runs its own loop with its own hop cap. Termination: every loop is capped, total concurrency is capped, and cycles are refused before they can queue — bounded by construction.

### 2.3 Concurrency & single-author

- One in-process **per-session queue** (promise chain). Concurrent `chat.send`s to one session execute in arrival order; each caller gets its own reply. No interleaved turns in stored history.
- Sessions file = single author (this agent). Writes are `writeFileSync` full-file replace (house convention: `dreaming/index.js:101`, `forge/index.js`).

## 3. Storage

```
data/chat/sessions/<name>.json
```

One pretty-printed JSON file per session (`null, 2`). `name` is the ID — human-addressable from any client, no generated IDs to lose. Name charset enforced: `[a-z0-9][a-z0-9._-]*` (safe as filename and as JSON key).

```json
{
  "name": "kimi-mcp_server",
  "model": "kimi-k3-chat",
  "systemPrompt": "You are a coding companion for another LLM...",
  "createdAt": "2026-09-01T12:00:00.000Z",
  "updatedAt": "2026-09-01T12:05:00.000Z",
  "messages": [
    { "role": "user",      "content": "...", "createdAt": "..." },
    { "role": "assistant", "content": "...", "createdAt": "...", "model": "kimi-k3-chat", "usage": { } },
    { "role": "assistant", "content": null,  "createdAt": "...", "tool_calls": [ ... ] },
    { "role": "tool",      "content": "...", "createdAt": "...", "tool_call_id": "call_1", "toolName": "storage.read", "toolStatus": "success" }
  ]
}
```

Message stored-form: role, content, createdAt, plus `tool_calls` / `tool_call_id` / `toolName` / `toolStatus` when present (mirrors conversation-store normalization, minus chat-app-only fields: attachments, embeds, versions, reasoning).

**Atomicity**: one file write per completed hop — assistant message (+ its tool results) persist together after the hop completes. Crash mid-chain leaves a valid prefix; no dangling `tool_calls` without results, no half-turns. No activeRun stamp needed (v1 has no SSE viewers to recover); the file is always loadable.

**No truncation, no windowing, ever.** Full history goes on the wire each send. Overflow surfaces as the gateway's own error (fail loud). Every `send`/`inject`/`compact` response includes `messageCount` and `historyBytes` so callers see growth. A session that outgrows its model gets `chat.update` (new model) or `chat.compact` — the caller decides, never the agent.

## 4. Tool surface

All methods via `agent.action` (compact endpoint), legacy names `chat_*`. `*` = required.

### `chat.create` — `{ name*, model*, systemPrompt? }`
Creates session. Throws if name exists (no silent reuse). `model` must be a known gateway model ID (verified against `listModels('chat')` at create time — typos fail immediately, not on first send).

### `chat.send` — `{ name*, message*, model? }`
Appends user message, runs the tool loop (§5), appends assistant outcome(s). Returns:
```json
{ "reply": "...", "toolCalls": [ { "name": "memory.recall", "status": "success" } ],
  "hops": 2, "usage": { }, "messageCount": 14, "historyBytes": 38211 }
```
Optional `model` override for one send (does NOT re-pin the session; `chat.update` re-pins).

### `chat.inject` — `{ name*, messages?[], files?[] }`
Appends context **without** calling the model. This is the twin-ingest primitive: stuffing N documents via `send` would pay for N DeepSeek replies saying "noted".
- `messages`: array of `{ role, content }` (role: `user`|`assistant`) — appended verbatim.
- `files`: array of **storage paths**. Each is read via the storage agent (`storage_read` — inherits its sandbox, UNC translation, and `maxReadSize` cap) and appended as one user message: `"=== storage:<path> ===\n<content>"`. Reading via the storage agent keeps ONE file-access authority; larger-than-cap files must be pre-chunked by the caller (documented limitation, no silent truncation here — the storage read throws).
- At least one of `messages`/`files` required.

### `chat.list` — `{}`
All sessions: name, model, messageCount, historyBytes, createdAt, updatedAt.

### `chat.history` — `{ name*, lastN? }`
Stored messages (chronological). `lastN` trims from the tail for large sessions. Full-fidelity by default — callers need the exact wire form to reason about context.

### `chat.update` — `{ name*, systemPrompt?, model? }`
Mid-life re-pin. At least one field required. Model change validated like create.

### `chat.compact` — `{ name*, strategy*, keep? , upTo?, model? }`
Caller-invoked compaction, three strategies:
- `"clear"` — wipe `messages[]`. `systemPrompt` survives. `keep` (default 0) preserves the last N messages.
- `"truncate"` — keep last `keep*` messages (required for this strategy).
- `"summarize"` — messages `[0 .. upTo)` are replaced by ONE summary message. The summary is generated by the session's own model (override via `model?` arg) with a fixed extractive prompt ("compress the following conversation segment, preserving facts, decisions, and open threads"). Fails loud: throws if the gateway call fails; history is rewritten only after the summary text exists.

Summary message stored as `role: "user"`, content prefixed `[context summary]` — rationale: `system` mid-conversation is provider-fragile; `assistant` would fabricate provenance. **Resolved R1: keep as spec'd** (correct call — most portable across adapters).

`chat.delete` — `{ name* }` — removes the file. Irreversible; no recycle bin (owner: "until it is deleted").

## 5. Tool loop inside `chat.send`

Per hop:

1. Assemble payload: `[{role:'system', content: systemPrompt}, ...messages]`.
2. POST `/v1/chat/completions` — `stream:false`, `tools:[dispatcherDef]`, pinned `model`.
3. On `finish_reason === 'tool_calls'`: execute each call via `callTool(method, payload)` (the dispatcher form — see below), append assistant message with `tool_calls` + one `tool` message per result **(single atomic write per hop)**, increment hop counter, go to 2.
4. On `finish_reason === 'stop'`: append assistant message, persist, return reply.
5. Hop cap exceeded → throw (history remains valid up to last completed hop).

### Tool advertisement — the dispatcher, not 50 schemas

The session model sees ONE tool:

```
tools: [{
  type: 'function',
  function: {
    name: 'workshop',
    description: '<method catalog: agent.action methods + payload shapes>',
    parameters: { method: string, payload: object }
  }
}]
```

Rationale: this is exactly how the chat app already drives this server (runner.js auto-vision: "exposes a SINGLE dispatcher tool named 'tools' — agent.action METHODS routed through it"), and how every client talks to `/mcp/compact`. One definition, catalog in the description, ~50 tools' worth of reach without 50 schemas eating context. Execution: `callTool('tools', { method, payload })` — or a direct method→handler map; the legacy names are already known to `routeToolCall`.

### What a session may call

Everything the compact endpoint exposes — including `chat.*` (recursion), `memory.*`, `storage.*`, `browser.*`, `forge.*`. Trust note for reviewers: a session model is an agent holding the workshop's tool permissions; the sandbox is the workshop's sandbox.

Config knob `agents.chat.toolsExclude: []` — array of `agent.action` prefixes removed from the advertised catalog (e.g. `["chat.", "forge."]` to defuse recursion for a given deployment). Empty default = advertise all (owner explicitly wants recursion available).

Stall guards from the runner, adapted: request-level **TTFT abort 120 s**, **stall abort** n/a (non-streaming — no stream to stall; the whole-response timeout is the TTFT timer). One in-flight gateway call per session run (§2.3 queue).

## 6. Failure semantics (fail fast & loud)

| Condition | Behavior |
|---|---|
| `chat.create` on existing name | throw |
| unknown model at create/update | throw (checked against `listModels('chat')`) |
| gateway non-2xx / timeout on send/summarize | throw; user msg NOT appended (append happens only with a successful reply — see below) |
| tool call fails inside loop | tool result message records `toolStatus:"error"` + error text; loop CONTINUES (the model sees the error and can adapt — matches runner behavior) |
| hop cap / concurrency cap | throw with counts |
| malformed `chat.inject` (neither messages nor files) | throw |
| invalid session name charset | throw at create; lookups of nonexistent names throw with `session not found: <name>` |

**Send atomicity decision**: the caller's user message is appended only when the run completes (reply or tool-loop outcome), written together with the assistant outcome in one write per hop, first hop includes the user message. A failed send therefore leaves NO trace — the caller retries cleanly. Alternative (append user msg first, like the runner) was rejected: headless callers have no UI showing the orphaned message; silent residue is worse than a clean slate. **Resolved R2: keep as spec'd** (clean retry wins; an orphaned user message is silent residue).

## 7. Config

Root `config.json`:

```json
"chat": {
  "dir": "data/chat/sessions",
  "maxHopsPerSend": 25,
  "maxConcurrentRuns": 4,
  "toolsExclude": [],
  "requestTimeoutMs": 120000
}
```

Gateway URL + access key come from the existing `gateway` section (no duplication).

## 8. Out of scope (v1)

- Attachments / images / vision pipeline (runner's auto-vision is UI-driven; headless callers can pass vision through dedicated `vision.*` tool calls instead).
- Streaming output to callers (non-streaming only).
- Per-session tool filters beyond the global exclude list.
- Session rename (`name` is the ID; rename = create + inject history + delete — rarely needed, add if it bites).

## 9. Review questions — RESOLVED 2026-09-01 (Kimi K3 review, owner-approved)

- **R1 — summary placement**: RESOLVED — `role:"user"` + `[context summary]` prefix. Most provider-portable; `system` mid-history is adapter-fragile, `assistant` fabricates provenance.
- **R2 — send atomicity**: RESOLVED — append-on-success. Headless callers retry cleanly; an orphaned user message with no reply is silent residue.
- **R3 — dispatcher vs individual schemas**: RESOLVED — single dispatcher. Weak local models are *callers* of sessions, not session models; sessions pin strong models (deepseek-flash, kimi-k3) that already drive this server via the dispatcher pattern in production (chat app runner).
- **R4 — recursion bounds**: RESOLVED — original answer was WRONG: cross-session ping-pong deadlocks on the per-session queue (A busy → B calls A → queues forever), no cap trips. Fixed via the run-chain cycle guard (§2.2.1): cyclic sends fail as tool-result errors before they can queue. Non-cyclic nesting bounded by `maxConcurrentRuns`.
- **R5 — history bytes vs tokens**: RESOLVED — bytes + per-send `usage` from the gateway. Callers get real token counts per send for free; no tokenizer needed.
- **R6 — summarize prompt ownership**: RESOLVED — fixed hardcoded prompt. A caller wanting a custom summary can do it manually (`chat.history` → summarize externally → `chat.inject` + `chat.compact truncate`). No knob.

## 10. Implementation checklist (post-approval)

1. `src/gateway-client.js` — `stream:false` mode in `chat()` (content + tool_calls + finish_reason + usage).
2. `src/agents/chat/config.json` + `index.js` — 8 handlers, per-session queue, run-chain cycle guard (§2.2.1) threaded through `callTool` context, tool loop, dispatcher advertisement.
3. `server.js` — pass `routeToolCall` into chat agent context; `COMPACT_TOOL` description block; `COMPACT_TO_LEGACY` × 8.
4. Root `config.json` — `agents.chat` section.
5. Smoke test: create → inject file → send (tool loop fires `storage.read`) → compact summarize → history verify → delete. Then a recursion probe: A calls B, B attempts to call A → must get the chain-guard tool error (not a hang).
6. Update `Agents.md` (new agent, new data dir).

## 11. Appendix A — verified codebase facts (2026-09-01, all line-checked)

Everything below was read this session so implementation needs **no further exploration**. Paths relative to `d:\DEV\mcp_server` unless marked.

### 11.1 Agent pattern (template: `src/agents/storage/`)

- `config.json`: `{ "agent": "storage", "description": "...", "tools": [ { "name", "description", "inputSchema": {type, properties, required} } ] }`. Standard JSON Schema per tool.
- `index.js`: `init(context)` + **named exports matching tool names exactly** (`export async function storage_stat(args)`). Loader hard-fails (`process.exit(1)`) if `mod[tool.name]` is not a function (`agent-loader.js:183-188`).
- Config resolution: `init` reads `context.config?.agents?.<name>`, throws if missing; DEFAULTS merged inside agent (`storage/index.js:34-46`).

### 11.2 Agent loader (`src/agent-loader.js`)

- Discovery: scans `src/agents/` subdirs (:31-34); `config.dependsOn` topological sort with cycle detection (:55-81); `agents.<folder>.disabled` filter (:84-94).
- `init(localContext)` where `localContext = { ...globalContext, prompts }` (:137-142). Instance stored in `globalContext.agents` Map (:144). **`dependsOn` guarantees init ORDER only — dependency instances are NOT injected** (memory agent reaches vdb via `agents.get('vdb')`, `memory/index.js:106-115`).
- Handler invocation: `route.handler(args, localScopeCtx)` (:246); thrown errors wrapped as `{ content:[{type:'text',text:'Error: …'}], isError:true }` (:252-258). Optional `mod.shutdown()` in reverse init order (:263-287).

### 11.3 server.js wiring points

- `:105` — `const { tools, adminTools, routeToolCall, shutdownAll } = await loadAgents(globalContext);` → **pass `routeToolCall` into the chat agent's init context** (in-process tool execution, no HTTP hop).
- COMPACT_TOOL at `:156`: description block ~`:156-719` (per-method doc lines, e.g. storage.write at :577), inputSchema = free-form `{method, payload}` (:722-727), `compactTools` at `:730`.
- `COMPACT_TO_LEGACY` at `:732-773` — format `"storage.write": "storage_write"` (:772). Add 8 entries `"chat.<action>": "chat_<action>"`.
- `routeCompactCall` at `:787` → resolves method → `routeToolCall(legacyName, payload, context)` (:806-807).

### 11.4 Gateway client (`src/gateway-client.js`)

- `createGatewayClient(_wsUrl, httpUrl, accessKey, embedClient)` (:27) — embedClient required.
- `chat({ task, model, messages, systemPrompt, maxTokens, temperature, responseFormat, enableThinking, onDelta, onProgress })` (:36) — **SSE hardcoded** (`stream: true`, `strip_thinking: true`). Precedence gotcha: `if (task) body.task = task; else if (model) body.model = model;` — task shadows model. Chat sessions send ONLY `model`, never `task`.
- Extension point for `stream:false`: body assembly at :36-53, SSE consumption ~:95-224 (has STALL_TIMEOUT_MS guard), response object `{ content, cancelled }` returned at :225. For non-streaming: POST, read full JSON, return `{ content: choices[0].message.content, tool_calls: choices[0].message.tool_calls, finish_reason: choices[0].finish_reason, usage }`.
- `listModels(type?)` — GET `/v1/models` (HTTP, already implemented). Gateway is **stateless**: no sessions, no `X-Session-Id` (`docs/LLM_GATEWAY_REST_API.md:24, :858`).
- Non-streaming support confirmed: REST doc :141, examples :164, :563. Client disconnect aborts upstream (:274).

### 11.5 Model IDs (from `data/models.json`, shape `{object:'list', data:[{id, prettyName, owned_by, type, context_length, capabilities}]}`)

Relevant chat IDs: `deepseek-flash-chat` (1M ctx — twin use case), `kimi-k3-chat`, `kimi-k3-256k-chat`, `glm5-chat`, `glm5-flash-chat`, `deepseek-chat`, `minimax-m3-chat`, `gpt-chat`, `claude-*`, local `badkid-llama-chat` / `coolkid-llama-chat`. **Never hardcode — validate at create/update via `listModels('chat')`** (IDs are gateway-side and can change).

### 11.6 Persistence convention

Pretty-printed JSON via `writeFileSync(path, JSON.stringify(x, null, 2))` + `mkdirSync(dir, {recursive:true})` — precedent `dreaming/index.js:101-108`, `vdb/index.js:71-72`, `forge/index.js:19-21,177`. New dir: `data/chat/sessions/`.

### 11.7 Chat-app runner patterns (source: `D:\SRV\LLM-Gateway-Chat\server\runner.js`, ConversationRunner — PA-3)

Adopted into this spec:

- **Tool loop**: `finish_reason === 'tool_calls'` → execute → insert `role:'tool'` results at reserved positions `f.idx + 1 + i` with `tool_call_id` → loop. Results persisted atomically per hop (runner: `executeToolCalls`, ~:838-855).
- **Tool-call fragment assembly**: streaming `delta.tool_calls` accumulate by index (name + arguments strings) (~:905-916) — irrelevant for us (non-streaming), cited for completeness.
- **Hop caps, steps not time**: 200 attended / 100 unattended (:67-70). Rationale: a loop IS repeated hops; wall-clock punishes slow-but-correct. We tighten to 25 for headless one-shots.
- **Timers**: TTFT 120 s (:55-63), stream stall 300 s. For non-streaming: single request timeout = TTFT equivalent (config `requestTimeoutMs`).
- **Tool errors don't break the loop**: catch → `toolStatus:'error'`, result text `Tool error: <msg>` → model sees it and adapts (:838-841).
- **Single dispatcher tool**: chat app drives THIS server via one tool named `tools`, called as `callTool(dispatcher, { method, payload })` (:338-342) — precedent for §5 advertisement.
- **Args parsing**: runner does `try { JSON.parse(arguments) } catch { args = {} }` — tolerant boundary. Our spec: malformed args → tool result records `toolStatus:'error'` (model sees the parse error; no silent {}-substitution).
- **NOT adopted**: activeRun orphan stamp (v1 has no SSE viewers; per-hop atomic writes keep files always-valid), vision pipeline (out of scope §8), chunk-view/retirement transforms (chat-app-only), per-turn token reports (§9 R5 covers growth signal).

## 12. Appendix B — handover notes (2026-09-01)

- **State**: spec REVIEWED by Kimi K3, owner-approved for implementation. R1–R6 resolved (§9). One real defect found and fixed in spec: run-chain cycle guard (§2.2.1) replaces the insufficient self-send rule.
- **Next step**: implement per §10 checklist using §11 facts (no re-exploration needed). Implementation delegated to GLM 5.3 via subagent with this spec as sole blueprint; Kimi reviews the diff and runs the smoke test.
- **Owner preferences relevant here**: no TypeScript, vanilla JS, fail-fast/loud, zero defensive fallbacks, functions get everything as arguments, IDE file tools for edits, never restart live services without confirmation, model personality notes (Kimi = strong architecture, DeepSeek = strong comprehension at scale).
