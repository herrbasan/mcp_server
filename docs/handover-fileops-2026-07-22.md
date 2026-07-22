# Handover — fileops shared layer (2026-07-22)

For the next session picking this up in the `D:\DEV\mcp_server` project.
Read `documentation/fileops.md` first — it's the clean reference. This is the
"where we are and what's next" note.

## What's done and verified

The `fileops` engine (`src/lib/fileops.js`) is built, reviewed, and green:
- 55 node:test tests pass (1 symlink env-skip on Windows).
- Benchmarks clean (copy 100MB=29ms, grep 50MB=167ms).
- Full E2E via the workshop MCP tools against the live server: copy, grep,
  append, windowed read, batch, and the complete write→overwrite→history→
  restore versioning lifecycle.

The **storage agent is fully on the engine** ("debt-free"): every op routes
through one `OPS` instance, no parallel legacy fs paths for mutations. The
compact endpoint routes all 16 storage tools.

## How it was built (model split that worked)

- Engine implemented by **glm5-chat** subagent from an execution spec. It
  overclaimed test coverage and shipped a broken `batch` (positional
  `Object.values` arg spread) — orchestrator (kimi-k3) caught both in review
  and rewrote the dispatcher to route args by name.
- Storage wiring by **deepseek-chat** subagent — zero findings, verbatim spec
  fidelity. Better fit for mechanical execution tasks.
- Lesson recorded in memory: deepseek for execution-spec work, glm/kimi for
  design-ish work, and ALWAYS run an orchestrator review pass regardless.

## What you must know before touching it

1. **Three registration points for any new storage tool.** Agent `config.json`
   schema + agent `index.js` export + `COMPACT_TO_LEGACY` in `src/server.js`.
   Miss the third and the compact endpoint 404s with `Unknown method` even
   though the tool is correctly registered. (Gotcha, memory #822.)
2. **`storage_write` keeps silent-overwrite on purpose.** It calls
   `OPS.write(..., { overwrite: true })` internally to preserve the historical
   contract (memory system, chat app, forge all overwrite silently). Do NOT
   "fix" it to require the flag — that's a breaking change to existing callers.
   The engine's overwrite guard is for the *new* `storage_copy` tool.
3. **Versioning correctness lives in two invariants** (atomic temp+rename
   writes; append breaks inode sharing when nlink>1). If you change the write
   path, re-read `documentation/fileops.md` §Versioning first.
4. **Integration point neither spec covered:** the compact route map. When you
   wire forge/documentation, remember it's a separate edit in `server.js`.

## What's NOT done — the decision the user is mulling

User paused (got dizzy) weighing adoption across three agents. State:

- **Storage** — done (see above).
- **Forge** — NOT wired. `src/agents/forge/worker-bootstrap.js` builds `ctx`
  (~line 192) with `gateway`, `payload`, `workspacePath`, `toolStatePath`,
  `storagePath` — but NO `ctx.fileops`. Forged tools hand-roll `fs` with no
  confinement and no versioning. This is the highest-value remaining gap:
  forged tools are where untested LLM-written file code actually runs.
  Design intent (from `docs/plan-fileops.md`): inject `ctx.fileops` rooted at
  the forge storage dir, with the translator, so forged tools get the same
  confinement + versioning + verbs. Recommendation was **forge first**.
- **Documentation** — NOT wired, and a different shape: it reads from its OWN
  doc root (the LLM_Docs tree), not the storage root. Would need a second
  `createFileOps` instance pointed at its root (the factory supports multiple
  independent instances). Read-mostly, low stakes — could legitimately stay
  as-is. Not urgent.

- **`writeFromUrl`** — implemented in the engine but deliberately NOT exposed.
  Parked until the planned auth/session proxy lands (network-egress surface).
  User: "ignore security for now, the proxy with auth+session management is in
  planning." Do not expose without an allowlist decision.

## Uncommitted work

As of this handover, everything (engine, tests, bench, storage refactor,
compact routes, the two plan docs in `docs/`, this file, and
`documentation/fileops.md`) is **uncommitted** in `D:\DEV\mcp_server`.
Commit before starting new work so the verified state is captured.

## Memory anchors

#819 spec v1 · #820 engine done + glm review findings · #821 deepseek exposure +
model comparison · #822 compact-route gotcha · #823 E2E green · #824 3-way
adoption paused
