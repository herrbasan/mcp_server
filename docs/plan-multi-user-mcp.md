# Multi-User MCP — Parked Project Note

Status: DEFERRED — do not start until Dave explicitly schedules a
high-capacity session. Created 2026-09-22 after an initial design
conversation. Everything below is provisional; nothing is implemented.

## Origin

- Memory #1662 (2026-08-23): family model — wife + eventually kids, family
  READ, owner WRITE/DELETE, never public. Threat model: accidents (an LLM
  acting for a family member deleting work), not adversaries.
- Conversation 2026-09-22: first design pass, then Dave parked it.

## Provisionally settled in the 2026-09-22 conversation (not implemented)

1. **Identity arrives at connection time, not per call.** User binds when a
   client connects (token → user), attached to `context` for every tool call.
   **No user context = owner** — all existing clients keep working unchanged.
2. **Three-tier memory** (Dave endorsed): `machine` bank (operational
   lessons — mcp_server, infra, architecture; shared read — this is where the
   bulk of the current 3272 memories go, they're coding-lessons that mean
   nothing to family), `dave` bank (private: biography, psychology, digital
   twin, writing clusters), family members get own private banks + machine
   read. Migration = category-based split, LLM-assisted, one pass.
3. **Per-user dreaming**: N pipelines (2 now, maybe 3 in a couple years —
   only if a kid gets interested). Non-issue at that scale.
4. Storage scoping sketch: `users/<name>/` personal, `shared/` family
   collaboration space, rest = owner-only. Resolver above fileops; REST
   endpoint needs the same scoping (the forgotten leak); vdb `folder` filter
   becomes enforcement.

## Dave's three observations when parking it (2026-09-22) — the real design drivers

1. **"Everything we want to do ends up in shared storage anyway"** — family
   collaboration concentrates in the shared namespace; per-user dirs are
   secondary (scratch/private at most). Shared is the primary object.
2. **Conflict management** — concurrent edits (two LLMs, or LLM vs mounted
   editor). Current state: copy-before-mutate snapshots (10/path) but
   last-write-wins, no conflict detection.
3. **Versioning must survive direct SMB mounts** — `D:\MCP_Storage` is an
   SMB share; a mounted editor bypasses MCP entirely, so no tool-level
   mechanism (snapshots, replace diagnostics, scoping) can protect anything.

## Candidate shape (to be evaluated, not decided)

- **Git-backed shared storage**: make the storage root (or just `shared/`)
  a git repo — the forge agent already proves the pattern (git-versioned
  tool sources, auto-commit, rollback). Answers all three observations:
  versioning at the filesystem level (mount-immune), conflicts become
  merges/diffs instead of silent overwrites, history for free. Open
  questions: repo granularity (whole root vs shared/ only — documentation/
  and forge/ churn in the same repo?), commit cadence (per-write hooks vs
  periodic sweep commits), binary files, repo size over years.
- **OS-level SMB ACLs** for the read/write split (owner write, family read
  on shared/) — enforcement lives in the filesystem, which mounted edits
  can't bypass, unlike tool-level checks.
- Complements, not replaces: MCP-level scoping still wanted for the clean
  UX (family sessions never even see owner paths).

## Open forks (never decided)

- Identity mechanism: nPort token verified at MCP connect (aligns with chat
  BFF direction) vs per-user keys in config for direct clients. Depends on
  how family connects (chat app vs direct MCP clients — unanswered).
- Memory bank mechanics: per-user nDB file + nVDB collection + dream map;
  memory agent singletons → per-user registry. Migration mechanics.
- vdb: per-user collections vs folder-based filtering on one index.
- REST + SSE endpoint auth: same identity binding, else it's the bypass.

## Why parked

Dave at low capacity ("too dumb right now to think") — the git-vs-ACL
layering and identity plumbing deserve a fresh, high-capacity session.
