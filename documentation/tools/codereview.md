# codereview — Prime-Directive Code Review

**Agent:** `codereview` (`src/agents/codereview/`) · **Spec:** `docs/codereview-spec.md`
· **Data:** `data/codereview/` (snapshots, reviews, sandbox, nDB store) · **Tests:**
`npm run test:codereview` (offline tier; `CODEVIEW_SMOKE=1` adds the live-gateway
seeded-corpus recall run)

Reviews a codebase for reliability and performance optimization — the most
reliability at the lowest performance cost — under the workshop's coding maxims
(fail fast, design failures away, **no defensive programming**, no clean-code
ritual). Two adversarial review rounds shaped the design (Gemini Argon, Claude
Opus 5.5); the spec is the contract.

## Tools

**`codereview.review`** — `{ source*, model?, budget?, scope? }`

Runs the pipeline. `source`: absolute local path, UNC path (`\\coolkid\Work\…`),
`owner/repo[@ref]` (GitHub, shallow fetch via `GIT_TOKEN`), or a `.zip`/`.tar.gz`
archive. `model`: gateway chat model id — defaults to `deepseek-flash-chat` from
`config.json` (`agents.codereview.models.reviewer`); unknown ids fail loudly.
`budget`: `{ maxFiles, concurrency, maxDurationMs, maxTokens, perFileTimeoutMs }`
(defaults: `12` files, `4` concurrent workers, `240000` ms wall clock, `400000`
total tokens, `120000` ms per-file timeout). `scope`: `{ include, exclude }`
snapshot-relative path prefixes. Returns the report (including a per-target
telemetry/token/cost ledger) + `reviewId`; report also on disk at
`data/codereview/reviews/<id>/report.md`.

**`codereview.findings`** — `{ reviewId?, status?, snapshotHash? }` — compact
persisted findings (id, status, file, class, failure mode).

**`codereview.accept`** — `{ findingId* }` — generates diff + test (`agents.codereview.models.accept`,
default `kimi-k31-chat`), then the **acceptance gate**: the test is executed in
a sandbox and must **fail on the unpatched snapshot, pass on the patched one**.
`failed-before` = bug not proven; `failed-after` = diff doesn't fix it; either
blocks acceptance loudly with run output. Runtime-only bugs → `unprovable`
(artifacts stored, no verification claim). The automated gate currently supports
**JavaScript only**; other languages are refused before generation so a Rust
finding never receives a bogus Node test. Review and findings are
language-general; use the project's native runner to verify non-JavaScript fixes.

## Pipeline

1. **Snapshot** (resolver) — every source kind materializes to
   `data/codereview/snapshots/<treeHash16>/` + tree hash. Exclusions at copy
   time (`.git`, `node_modules`, `target`, `dist`, `build`, `logs`, `.test-output`,
   `_Archive`, `vendor`/`third_party`/`external`/`pdfium`, binaries, minified
   heuristic, **secrets — snapshots feed third-party gateways**), every exclusion
   listed in the report.
2. **Tier 0** (analyzer, no model) — JavaScript: acorn parse → import graph and
   defensive-pattern hunts. Rust: structural `mod`/`use`/`include!` graph plus
   discarded-Result, empty-`Err`-branch, and config-default candidates. Both
   get boundary classification (network/process/fs) and deterministic ranking
   (boundary weight + fan-in + bug-hunt density, with passive prose/lock files
   such as `.md`/`.svg`/`.lock` excluded from code boundary weights so they do
   not crowd out source files). **Every snapshotted text file is eligible**,
   including configuration, documentation, data, and extensionless files.
   Unresolved edges are recorded, never trusted.
3. **Incremental** — prior completed review of the same source + model +
   validator version: changed files (per-file hashes) + **blast radius**
   (importers via the dependency graph, including deletions) are re-reviewed
   up to `maxFiles`; findings outside the radius are carried. Unchanged trees
   make zero model calls.
4. **Parallel isolated target reviews** — selected top-ranked targets run
   concurrently (`concurrency` workers, `stream: false`, `maxTokens: 16000`,
   schema-guided JSON). Each call sees ONLY that file's numbered source, Tier-0
   hunt candidates, and 1-hop imports/importers — no upfront digest phase, no
   sequential map replay. Failures are isolated per target; budget exhaustion
   or per-target failure marks remaining/failed targets and returns `partial: true`
   with a PARTIAL report preserving all validated findings.
5. **Report** — rendered deterministically from validated findings (free wins
   first, then trade-off decisions as explicit either/or), per-target telemetry
   and token/cost ledger, coverage (un-reviewed files listed — never silent;
   JavaScript/Rust/generic text totals), exclusions, validator rejections,
   blocklist counter.

## Bias containment (validator, spec §3.2)

Models are trained on defensive-programming norms; prompting alone cannot fix
that. Every generative output crosses a deterministic gate:

- Findings are structured JSON; `evidence` must quote the snapshot verbatim
  (CRLF-normalized) **and** fall inside the cited line range.
- Rung fields are structured (dependency, rejected elimination, consequence
  before/after). **Throwing guards are always legal** (fail-fast is
  prescribed); **degrading guards** (fallback defaults, swallowed catches)
  need documented ladder analysis — no ladder, no handler.
- Boundary validation is not a handler (design-away ≠ rung-3 tolerance).
- Test specs must name the bug, a real data source (production-replay /
  recorded-fixture / calibrated-generated) and a load **shape**; placeholder
  data (`foo`, `hello world`) is rejected. Stubbing is boundary-relative:
  fault injection at tier-0-classified boundaries is allowed, stubbing inside
  the system under test is not.
- Vocabulary blocklist is a **counter, never a rejection** ("removes defensive
  fallback" is legitimate phrasing).
- The validator checks form, not truth — it is a floor, not a judge. Recall
  against omissions is measured by the seeded corpus
  (`tests/fixtures/codereview-corpus/`, 5 planted patterns).

## Store

nDB at `data/codereview/db/` (notepad pattern): reviews + findings with status
lifecycle (`new → accepted | rejected | unprovable`). Finding identity is a
content fingerprint (evidence + failure mode), so rejected findings stay
rejected across snapshots as line numbers shift.

## Gotchas

- One review at a time is the intended shape (batch job); there is no queue —
  concurrent calls run concurrently.
- The acceptance gate runs `npm install` in the sandbox when the generated
  artifacts say deps are needed (180 s cap); a plain-node test avoids it.
- `codereview.accept` requires the snapshot to still exist on disk — GC'd
  snapshots fail loudly with "re-run the review".
- Diffs are anchored to the snapshot hash; a working tree that moved since the
  review is never blindly patched.
- Static v1: cross-file/runtime bugs (the VDB-stall class) can appear as test
  *specs* but the sandbox may mark them `unprovable` — that is the honest
  scope, not a failure.
- An orchestrator timeout or malformed response does **not** discard completed
  work: `codereview.review` returns `partial: true`, a report with a PARTIAL
  banner and exact interruption, and normal finding IDs. Only `done` reviews
  qualify as incremental baselines.
