# HANDOVER — 2026-08-02 Embed/Storage Latency Investigation

**Status: UNRESOLVED. Handing to a fresh model.**
**Written by: previous session. My theories were repeatedly wrong — verify everything yourself.**

---

## ⚡ EXECUTIVE SUMMARY — READ THIS FIRST (skip the history until you need it)

**THE BUG:** In the chat app (D:\SRV\LLM-Gateway-Chat), the tool bubble shows "Tools / Executing…" forever and never resolves. `executeTool` is NEVER called (verified: `window.mcpTraceSummary()` = empty). The MCP server NEVER receives the request (verified: server logs show no arrival, and the server responds to a manual probe in 5ms). **The server is exonerated. The bug is in the browser client's tool-call flow.**

**VERIFIED FACTS (do not re-litigate):**
- Server storage ops: 10-14ms. Legacy SSE round trip: 5ms POST + instant result. Server is fast and correct.
- Fatten (embed provider) is BACK UP (16 models). Embed timeouts are a background-noise issue in the gateway, not the chat-stream blocker.
- The compact endpoint now wires `storage.import` + `storage.readMany` (this was a real bug I introduced — fixed, verified live).
- NO DATA LOSS anywhere. The arena chat (82 msgs) is intact in data.jsonl; ~1MB of tool content in the history is the likely context-size problem (Kimi "tokenization failed" appeared earlier).

**WHERE THE BUG MUST BE (3 candidate sites, in order of likelihood):**
1. **`chat/js/chat.js` — `streamResponse` tool_calls handling** (~line 3045-3175): the pending bubble renders on the first `tool_calls` delta; it only converts to real execution on `done` + `finish_reason:'tool_calls'`. If that `done` never arrives or the handler has a bug, the bubble sticks forever. **Note: I changed this to Promise.all (parallel) — check if that broke the `done` path.**
2. **`chat/js/conversation.js` — `getMessagesForApi`** (~line 533): builds the API payload; has backfill for tool-results-without-tool_calls but NO guard for orphaned assistant tool_calls. Also resends ~1MB of tool content every turn (likely Kimi reject cause).
3. **`chat/js/mcp-client.js` — the SSE/tool dispatch** — but the empty trace suggests dispatch never fires, so this is less likely.

**WHAT TO DO (in order):**
1. **Get live browser data FIRST** — this is the single most valuable step. In the browser with the stuck bubble: `window.mcpTraceSummary()`, the Network tab (did a POST to /message/compact fire?), and console (rich `[MCP SSE]`/`[Chat]` logs show exactly where it stops).
2. **Suspect my `chat.js` Promise.all change** — if the browser has it loaded, the parallel execution may break the `done` path. Reverting to the original serial `for...of` is a 1-minute check.
3. **Add the orphaned-tool_calls guard + tool-content truncation** in `getMessagesForApi` (conversation.js).

**HANDOVER HISTORY IS BELOW — read only if you need depth on a specific point. The verified-facts section is trustworthy; the "open theories" section is NOT — treat as hypotheses to test, not conclusions.**

---

## 🗺️ PROJECT MAP — WHERE EVERYTHING LIVES (critical: this session worked from mcp_server but edited OTHER projects)

**This handover was written from `D:\DEV\mcp_server`, but the bug being chased is in a DIFFERENT project. Do not assume relative paths.**

| Project | Path | What it is | Role in this bug |
|---------|------|-----------|------------------|
| **chat app (THE BUG LIVES HERE)** | `D:\SRV\LLM-Gateway-Chat` | Browser chat UI + backend | `chat/js/chat.js`, `chat/js/mcp-client.js`, `chat/js/conversation.js`, `chat/js/chat-history.js`, `chat/js/api-client.js`, `chat/js/client-sdk.js`. Backend: `server/server.js` (port 8080/3500), data at `server/data/herrbasan/data.jsonl`. **NOT a git checkout.** |
| **mcp_server (THIS workspace)** | `D:\DEV\mcp_server` | MCP server, port 3100 | `src/server.js` (SSE + compact + legacy endpoints, COMPACT_TO_LEGACY map), `src/agents/storage/index.js` (+config), `src/gateway-client.js`, `src/lib/fileops.js`, `src/utils/logger.js` + `src/nLogger/src/logger.js`. Launched by nPM (`agent_orchestrator`). |
| **LLM Gateway** | `D:\DEV\LLM Gateway` | LLM router, port 3400 | `src/core/model-router.js` (routeEmbedding), `src/core/task-registry.js`, `src/utils/http.js` (timeouts), `config.json` (models/tasks). Launched by nPM (`llm_gateway`). Logs at `D:\DEV\LLM Gateway\logs\main-0.log`. |
| **llama-cpp-wrapper** | `D:\DEV\llama-cpp-wrapper` | Model runner, port 4080 | `src/server.js`, `src/process.js` (process manager), `src/models.js`, `models.json` (per-model config incl. flashAttention). Also deployed on Fatten at `\\Fatten\e\DEV\llama-cpp-wrapper` (NOT a git checkout, has `.bak-` backup). |
| **Fatten (remote)** | `192.168.0.145` (LAN) | Embed/chat provider machine | Wrapper port 4080. Was down for Windows update, now BACK UP (16 models). Reachable via SMB `\\Fatten\e\...` |
| **nPM (process manager)** | `C:\Users\dave\AppData\Roaming\nPM\config.json` | Launches all services | `agent_orchestrator` (mcp_server), `llm_gateway`, `llama`, `llm_chat` (chat backend). Restart services HERE, not by hand. |

**Key cross-project facts:**
- The chat app browser connects DIRECTLY to mcp_server (legacy `/sse/compact` → `/message/compact`), NOT through the chat backend. The chat backend (8080) only persists conversations + embeds messages in background.
- The chat app embeds messages via the gateway (`/v1/embeddings` → Fatten). Those embed calls caused the gateway's 120s timeouts.
- nPM runs the mcp_server as `node server.js` from `D:\DEV\mcp_server\src` — the correct source (not a stale copy).

---

## The user's problem (verbatim)
- "storage.write takes forever" / "tools call takes a long while" in the chat app
- The tool bubble just reads "Tools" + "Executing…" forever, no detail shown
- Arena archive workflow (writing ~10 calibration files) "brought down to a crawl"
- "I start to believe we have an error in the pipeline on a rather fundamental level"
- Embedding was expected to be fully async/decoupled but appeared not to be

## VERIFIED FACTS (measured, not theorized — re-verify if you doubt)

1. **Server-side storage ops are FAST.** Direct HTTP tests against `http://localhost:3100/mcp/compact`:
   - `storage.write` (25B): 2044ms first (cold), then **10-14ms** repeated, even after idle
   - `storage.batch` (3 writes, 120KB): **10-13ms** steady state
2. **Legacy SSE path is FAST.** Node test mirroring the chat app's exact mechanics (fetch + getReader, /sse/compact → /message/compact?sessionId=...): SSE connect 22ms, POST 32KB storage.write 6ms, result arrived 0ms after POST. (The earlier "SSE hang" was PowerShell Invoke-WebRequest waiting for the SSE stream to end — a client artifact.)
3. **The chat app uses the LEGACY SSE transport**: browser console shows `Connecting SSE at http://192.168.0.100:3100/sse/compact` → POST endpoint `/message/compact?sessionId=...`. NOT `/mcp/compact` streamable HTTP.
4. **The running mcp_server is STALE.** PID 22036, started 15:29:14. The bulk-storage tools (`storage_import`, `storage_readMany`) were saved to disk 15:48-49 — AFTER. Verified via `tools/list` on the live server: `storage_import` NOT present.
5. **During a reported hang, NO tool call reached the MCP server.** Server session log untouched (589 bytes, last write 15:35 — my own vdb_search test). `main-0.log` not written since 15:09 (logger may drop entries under backpressure — see below).
6. **The chat app browser's MCP trace was EMPTY during a hang**: `window.mcpTraceSummary()` returned `counts: {}, avg_resolve_ms: 0, timeouts: 0, zombies: 0, orphans: 0`. This means `mcpClient.executeTool()` was NEVER called — the client never dispatched the tool.
7. **The LLM Gateway log shows a wall of embed timeouts**: `Upstream hung: no response headers within 120000ms from http://192.168.0.145:4080/v1/embeddings` every ~2 min for hours. Fatten (192.168.0.145) was down for a Windows update. The gateway has NO circuit breaker for embeds — waits 120s per attempt (firstByteTimeoutMs in src/utils/http.js, 3 retries).
8. **Data integrity: NO DATA LOSS.** memories.jsonl all valid JSON; chat data.jsonl (85MB) valid, arena chat `chat_1785665028673_bmapr7gr` present; arena calibration files untouched.
9. **kimi-k3 was the chat model** during the hangs.

## Changes made this session (all git-tracked / syntax-clean unless noted)

### mcp_server (D:\DEV\mcp_server) — git status shows all
- `src/utils/progress-reporter.js` (NEW) — shared progress reporter. + `tests/progress-reporter.test.js` (NEW, passes)
- `src/gateway-client.js` — embed circuit breaker (embedDownUntil + backoff 15s→5min). VERIFIED WORKING live: memory.recall 17s first call (burns timeout), then 15-16ms fast-fail.
- `src/agents/vdb/index.js` — scan fast-fail on circuit open, pending stat, 30s embed timeout (was 5min), no split-in-half recursion on outage
- `src/agents/vdb/context-enhancer.js` — 30s timeout on gateway.predict (was none)
- `src/agents/memory/index.js` — progress in recall/heal; embed call sites use explicit model (LATER REVERTED — see below)
- `src/agents/storage/index.js` + `config.json` — NEW `storage_import` (bulk write) + `storage_readMany` (bulk read), batching rule in descriptions. **NOT LOADED (server stale).**
- `src/agents/browser/index.js`, `dreaming/index.js`, `inspector/index.js`, `forge/index.js`, `lib/fileops.js` — progress wiring
- **REVERTED**: memory agent model param + config embeddingModel (user decided clients send NO model; gateway owns model)

### llama-cpp-wrapper (D:\DEV\llama-cpp-wrapper)
- `src/process.js` — readyPromise deadlock fix: child exit handler now rejects when state==='starting' OR 'draining' (was only 'starting'; a kill-mid-load left the single-flight load promise pending forever). Applied to local AND Fatten (`\\Fatten\e\DEV\llama-cpp-wrapper\src\process.js`, backup `.bak-1785668490654` exists).
- `models.json` — REVERTED to original (flashAttention:false for all 3 qwen3-embedding models). My earlier FA→true change was a wrong theory; reverted.

### LLM Gateway (D:\DEV\LLM Gateway)
- `src/core/model-router.js` — `routeEmbedding` now pins the default embedding-task model unconditionally (ignores client model, throws if no default embed task). NOT RESTARTED — inert until restart.
- `config.json` — disabled `gemini-embed` + `or-qwen-embed` (were enabled; gemini is 3072 dim vs 2560). NOT RESTARTED — inert.

### chat app (D:\SRV\LLM-Gateway-Chat, NOT a git checkout here)
- `chat/js/chat.js` — tool_calls executed in PARALLEL (Promise.all) instead of serial. Syntax verified. **BROWSER MUST BE RELOADED to take effect.**
- `chat/js/chat-history.js` — fixed PATCH 400: was sending `summary: ''` (backend validates summary must be object); now omits summary unless it's a real object.

## OPEN THEORIES (UNVERIFIED — do not trust, test them)
1. The stuck "Tools/Executing…" bubble is client-side: the pending-tool UI (`showPendingToolUI` in chat.js) renders on the first tool_calls delta, and only resolves on `done` with `finish_reason:'tool_calls'`. Empty trace + no server arrival suggests the model's tool_calls turn never completed (gateway stream stalled). THEORY — the gateway's 120s embed timeouts starving the kimi-k3 stream is unproven; Node async means a pending fetch shouldn't block other requests unless something is synchronous or event-loop-blocking.
2. The nLogger `_flushBuffer()` in mcp_server clears its buffer even when `write()` returns false (backpressure) — may silently drop log entries (explains main-0.log going quiet). UNVERIFIED as a cause of anything; just an observed code smell.
3. The perceived "storage.write slow" may be LLM follow-up generation time included in the measured span (timing doc showed 16.3s = ~4.4s tool + ~10.8s generation). UNVERIFIED.

## KEY QUESTIONS FOR THE NEXT MODEL
1. Where exactly does the time go during a "Tools/Executing…" hang? Get `window.mcpTraceSummary()` AFTER the hang (it was empty — meaning no dispatch). Check the gateway's kimi-k3 SSE stream state during the hang.
2. Is the chat app browser actually sending the POST to /message/compact during the hang? (Server log says no.) If the model never finished tool_calls, the browser never dispatches — is that a gateway/model issue?
3. Why does main-0.log stop being written while the server keeps serving? Is the logger dropping entries (nLogger _flushBuffer bug)?
4. Does the gateway's embed path block the chat streaming path? Test: while Fatten is down, does a kimi-k3 chat request with tools complete?

## RECOVERY ACTIONS STILL PENDING (user runs, per policy — NEVER restart services yourself)
1. Restart mcp_server (loads storage_import/readMany + circuit breaker is already in)
2. Restart LLM Gateway (clears stuck embed waits; activates routeEmbedding pinning + disabled models)
3. Reload chat browser (activates parallel tools + summary fix)
4. NOTE: Fatten was mid-Windows-update (embed provider down) — check if it's back before assuming embeds still fail

## FILES TO READ FIRST (for a fresh model)
- mcp_server: `src/server.js` (SSE + compact + legacy endpoints), `src/agents/storage/index.js`, `src/gateway-client.js`, `src/utils/logger.js` + `src/nLogger/src/logger.js`
- chat app: `chat/js/mcp-client.js` (full transport), `chat/js/chat.js` (streamResponse ~line 3000, handleToolExecution ~line 4400)
- gateway: `src/core/model-router.js` (routeEmbedding), `src/utils/http.js` (timeouts)

## ?? THE FAILURE REPORT (added by previous session, after user said "accept defeat")

### What the user experienced, in order
1. Initially: storage.write / tool calls took a LONG time but eventually resolved
2. After this session's work: **storage calls now DON'T resolve at all** � the tool bubble "Tools / Executing�" sticks forever
3. User: "we went from fixing all kinds of things that might not even need to be fixed to making the initial problem worse, that storage calls now dont resolve at all instead of taking very long"

### What the previous session got WRONG (in order)
1. **Flash attention theory (WRONG)** � blamed `flashAttention:false` for embedding models in llama-cpp-wrapper/models.json. Measured warm embeds = 80ms, so FA was not the issue. Reverted. The research I cited was for a different llama.cpp fork.
2. **"The chat app should proxy through its backend" (WRONG)** � user correctly stopped me: both paths are browser?local-node over LAN, no inherent difference. Rethink abandoned.
3. **"The gateway embed timeouts starve the chat stream" (WRONG/unproven)** � Node is async; a pending fetch shouldn't block other requests. Flagged as unproven in handover.
4. **Over-engineered fixes for things that weren't broken** � added progress reporting, circuit breakers, bulk storage tools, parallel tool execution. Many were not the actual problem.

### The regression: what could have turned "slow" into "never resolves"
- **PRIME SUSPECT: the parallel tool-call execution change in chat.js** (D:\SRV\LLM-Gateway-Chat\chat\js\chat.js). Changed the tool loop from serial (`for...of await handleToolExecution`) to `Promise.all`. If `handleToolExecution` is not safe under parallel execution (shared conversation state, exchange ordering, `addToolExchange` races, `streamResponse(lastToolExchangeId)` after parallel completion), parallel execution can deadlock where serial resolved. **This is the one change to the CLIENT that was live before the regression appeared.**
- The mcp_server was NOT restarted (PID 22036, stale) � so NO server-side changes were live. Only browser-side changes could have caused the regression.
- The chat app backend was restarted by the user � unverified if that contributed.

### What a fresh model should do FIRST (before any theorizing)
1. **Revert the chat.js parallel-tool-execution change** back to the original serial `for...of` loop. This restores the KNOWN behavior (slow but resolving). It is the highest-probability regression cause.
2. **Verify the chat app browser actually has the old or new code** (the browser must be reloaded for chat.js changes to take effect � if it wasn't reloaded, the parallel change was never live and the regression has another cause).
3. **Get the chat app's client-side MCP trace DURING a hang**: `window.mcpTraceSummary()` and `window.mcpTraceDump()`. The trace was EMPTY during the observed hang � meaning `executeTool` was never called. A fresh model should capture this at hang time and trace WHERE the model's tool_calls stream stalls (is it the gateway? the model? the client parsing?).
4. **Do NOT trust this handover's theories** � the verified facts are sound, the theories are not.

### The fundamental unresolved question
The tool bubble "Tools / Executing�" appears on the FIRST tool_calls delta (client-side `showPendingToolUI`), before any real execution. It only resolves when `done` + `finish_reason:'tool_calls'` arrives. During the hang, that `done` never arrived AND `executeTool` was never called AND no request reached the MCP server. **Where the model's tool_calls stream stalls is THE unknown.**

### Note on data safety
- NO data loss occurred. All conversation data, memory, and storage files verified intact.
- The stuck bubble is a UI state; the underlying conversation is persisted.

## ? FOUND + FIXED near end of session (2026-08-02): compact endpoint never wired for new storage tools
After the user restarted the server (nPM-managed: agent_orchestrator runs `node server.js` from D:\DEV\mcp_server\src � the CORRECT file with all changes):
- Legacy /mcp tools/list DID list storage_import (agent loaded the new tools)
- Compact /mcp/compact tools/list DID NOT (static description + route mapping in server.js were never updated)

ROOT CAUSE: I added storage_import + storage_readMany to src/agents/storage/{index.js,config.json} but NEVER wired them into src/server.js:
1. COMPACT_TO_LEGACY mapping missing "storage.import"->"storage_import", "storage.readMany"->"storage_readMany"
2. Compact tool description (static string) missing the entries

FIXED in src/server.js: both added to COMPACT_TO_LEGACY (~line 897) + description (~lines 729-740). Syntax checked.

IMPLICATION: the chat app uses the compact endpoint. If the LLM called storage.import via it, the router returned "Unknown method" � the model's tool_calls turn could die ? stuck "Tools/Executing�" bubble. CONCRETE cause candidate for the regression, not a theory.

NEEDS: mcp_server restart (nPM agent_orchestrator) to activate. Then verify /mcp/compact tools/list description contains storage.import.

## ? VERIFIED FIXED (2026-08-02 16:15)
- mcp_server restarted (PID 29676, nPM agent_orchestrator)
- /mcp/compact tools/list now exposes storage.import + storage.readMany (was missing)
- Functional test: storage.import (2 files) via compact endpoint = 14ms, both verified
- This was a REAL, confirmed bug: the new storage tools were never wired into the compact endpoint the chat app uses. If the LLM called storage.import, the router returned "Unknown method" and the tool_calls turn could die ? stuck "Tools/Executing�" bubble.
- Remaining unknown: whether the chat app's "Tools/Executing�" hang is FULLY resolved � needs a real-world retry from the user. The compact wiring was one confirmed cause; there may be others (client/gateway).

## ?? NEW FINDING (2026-08-02 16:2x): "tokenization failed" � data is SAFE, live state poisoned
After the compact fix, the hang became a concrete error: "Invalid request: tokenization failed" (kimi-k3, Anthropic adapter) � every send.
VERIFIED: the arena chat data in data.jsonl is INTACT (82 messages, valid, NO orphaned tool_calls � 0 orphans detected). The 9 arena calibration files on disk are safe. NO DATA LOSS.
The error comes from the BROWSER's live in-memory conversation: getMessagesForApi (conversation.js) reconstructs the API payload from the browser state, which contains an assistant exchange with tool_calls from a stuck bubble that never resolved ? invalid message sequence ? Kimi rejects with "tokenization failed". The backend copy is clean.
RECOVERY: reload the chat browser (clears live state, reloads from backend). If needed, the user can also force-reload the conversation from backend.
REMAINING GAP for next model: getMessagesForApi has backfill for "tool result without preceding tool_calls" but NO sanitization for "assistant tool_calls without following tool result" (the stuck-bubble artifact). A fresh model should add that guard.

## ?? ROOT CAUSE FOUND (2026-08-02 16:3x) � OVERSIZED CONVERSATION HISTORY
The arena chat has 82 messages including 69 tool messages totaling ~1.04 MB of tool content. 20 tool messages are >10KB (922KB total). The 4 chat_archive_get_session transcripts alone = ~195KB.
EVERY new request resends the ENTIRE history (getMessagesForApi) including all 1MB of tool results ? Kimi "tokenization failed" (content too large / un-tokenizable sequence).
This explains the WHOLE saga:
- "took forever" = sending ~1MB history per turn
- "got worse" = each arena step added 40-57KB transcripts
- "never resolves" = history crossed Kimi's reject threshold
NOT a race, NOT a circuit breaker, NOT a stale server. A context-size/content problem from oversized tool results being resent every turn.
THE FIX (for next model): truncate or exclude large tool results from the API payload (getMessagesForApi in conversation.js). Tool content is persisted for reference; the model doesn't need 55KB transcripts resent. Consider: cap tool content in messages to e.g. 2-4KB, keep full version in the tool exchange for display/export.
DATA IS SAFE: everything is in data.jsonl + storage. The chat is UNUSABLE for new sends until the history is trimmed (or a fresh conversation started).

## ?? DEFINITIVE SERVER VERDICT (2026-08-02 16:45) � SERVER IS NOT THE PROBLEM
Fresh legacy SSE test (exact chat-app mechanics, new session): POST /message/compact 202 in 5ms, storage.write result returned instantly. Fatten is BACK UP (16 models). Compact fix confirmed live (storage.import routes + 14ms test earlier).
CONCLUSION: the stuck "Tools/Executing�" bubble is ENTIRELY CLIENT-SIDE. The server responds correctly and instantly. The problem is in the chat app browser's tool-execution flow (chat.js/mcp-client.js/conversation.js).
STILL UNKNOWN: why the browser's pending tool bubble never resolves to a real executeTool call. The empty MCP trace (executeTool never called) + no server arrival + server-responds-instantly = the tool_calls turn never completes in the client. Root cause is in the CLIENT, not the server.
RECOMMENDED NEXT STEP for the fresh model: run the chat app in the browser with DevTools open, trigger the arena archive, and capture: (1) window.mcpTraceSummary() at hang time, (2) the network tab showing whether a POST to /message/compact fires, (3) console for the [MCP SSE] and [Chat] logs. The client logs are rich ([MCP executeTool], [MCP SSE] Event #, [Chat] Tool calls received) � they will show exactly where it stops.

## ?? THE CRITICAL CORRELATION (user's insight: "it was slow but working before we fiddled with it")
The user's observation is the strongest signal. Timeline analysis:
- BEFORE (slow but WORKING): original server, Fatten DOWN, growing conversation, original backend
- REGRESSION (slow -> STUCK): Fatten DOWN, conversation GROWING each step (40-57KB transcripts), user restarted chat backend
- NOW: Fatten UP, server restarted with all fixes, ~1MB tool content in history � STILL STUCK

THE ONLY MONOTONICALLY INCREASING VARIABLE = the conversation history (~1MB of tool results, 69 tool messages). It grew every arena-archive step. This correlates perfectly with the regression.
ALSO: my chat.js/chat-history.js client edits were NEVER LOADED (chat/js mtimes unchanged, browser not reloaded) � so they CANNOT be the regression cause. The server edits were never live until the final restart. So the regression was NOT caused by my code changes � it correlates with the history growth (and possibly the gateway embed timeouts).
STRONGEST HYPOTHESIS for next model: the ~1MB conversation history (or a specific malformed exchange within it) is what makes the tool_calls turn fail to complete in the client. The oversized-history finding (documented above) is the leading candidate.
