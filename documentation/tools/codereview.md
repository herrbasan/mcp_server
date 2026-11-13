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

**`codereview.review`** — `{ source*, models?, budget?, scope? }`

Runs the pipeline. `source`: absolute local path, UNC path (`\\coolkid\Work\…`),
`owner/repo[@ref]` (GitHub, shallow fetch via `GIT_TOKEN`), or a `.zip`/`.tar.gz`
archive. `models`: `{ grunt, orchestrator }` gateway ids — defaults
`deepseek-flash-chat` + `kimi-k31-chat` from `config.json`
(`agents.codereview.models`); unknown ids fail loudly, never silently default.
`budget.maxRounds` (default 10) caps orchestrator dive rounds. `scope`:
`{ include, exclude }` snapshot-relative path prefixes. Returns the report +
`reviewId`; report also on disk at `data/codereview/reviews/<id>/report.md`.

**`codereview.findings`** — `{ reviewId?, status?, snapshotHash? }` — compact
persisted findings (id, status, file, class, failure mode).

**`codereview.accept`** — `{ findingId* }` — generates diff + test (orchestrator
model), then the **acceptance gate**: the test is executed in a sandbox and must
**fail on the unpatched snapshot, pass on the patched one**. `failed-before` =
bug not proven; `failed-after` = diff doesn't fix it; either blocks acceptance
loudly with run output. Runtime-only bugs → `unprovable` (artifacts stored, no
verification claim). The automated gate currently supports **JavaScript only**;
other languages are refused before generation so a Rust finding never receives
a bogus Node test. Review and findings are language-general; use the project's
native runner to verify non-JavaScript fixes.

## Pipeline

1. **Snapshot** (resolver) — every source kind materializes to
   `data/codereview/snapshots/<treeHash16>/` + tree hash. Exclusions at copy
   time (`.git`, `node_modules`, `vendor`/`third_party`/`external`/`pdfium`,
   lock files, binaries, minified heuristic,
   **secrets — snapshots feed third-party gateways**), every exclusion listed
   in the report.
2. **Tier 0** (analyzer, no model) — JavaScript: acorn parse → import graph and defensive-pattern hunts. Rust: structural `mod`/`use`/`include!` graph plus discarded-Result, empty-`Err`-branch, and config-default candidates. Both get boundary classification (network/process/fs) and deterministic dive ranking (boundary weight + fan-in + hunt density). Other source languages get generic boundary analysis and ranking and remain fully eligible for model digest/dive; documentation/data files are not ranked as source. Unresolved edges are recorded, never trusted.
3. **Incremental** — prior review of the same source + model pair + validator
   version: changed files (per-file hashes) + **blast radius** (importers via
   the dependency graph) are re-digested; findings outside the radius are
   carried. Cache key includes model pair and validator version.
4. **Tier 1** (grunt model) — one file per call, schema'd JSON digests
   (`role`, `boundaries`, `risks`), 4 concurrent, retry once with the error
   attached, then the gap is recorded and visible. Free prose never enters the
   map.
5. **Tier 2** (orchestrator model) — sees the map + digests + raw source of
   its own dive selections. System prompt = Prime Directive principles +
   rubric. Stateless calls: full state (`map, verified_findings,
   remaining_budget`) rebuilt each turn, persisted to `state.json` after every
   round. Stops on `done`, no-further-targets, two empty rounds, or budget.
6. **Report** — rendered deterministically from validated findings (free wins
   first, then trade-off decisions as explicit either/or), coverage
   (un-reviewed files listed — never silent; JavaScript/Rust/generic source
   totals; every generic-language file named with its reduced tier-0 depth),
   exclusions, digest gaps, validator rejections, blocklist counter.

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
