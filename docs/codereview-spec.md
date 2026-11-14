# Code Review Agent — Design Spec

**Date:** 2026-11-12 (original); **Rewritten 2026-11-13 (v2 — Direct Parallel Pipeline)**
**Status:** ACTIVE (v2) — Tier-1 digests and sequential multi-round orchestrator loop replaced on 2026-11-13 with direct parallel per-file reviews driven by Tier-0 ranking and hard budgets. Original v1 postmortem retained in §0.
**Home:** `src/agents/codereview/`

### Measured v2 benchmark (2026-11-13, `D:\DEV\nTeligence`, `r_mwfhuj1b_dgi0`)

- Tree: **644 snapshotted text files** (71 JS, 92 Rust, 481 generic); exclusions (`target/`, `_Archive/`, `.git`, `.test-output`, binaries) disclosed.
- Pipeline: `deepseek-flash-chat`, `maxFiles: 12`, `concurrency: 4`, `maxTokens: 400k` (no Tier-1 digests, no multi-round loop).
- Result: **12/12 targets completed in 219.6s (3m40s)**, **419,215 tokens** (16k output cap, per-call ledger), **41 validated findings** (31 free wins, 10 trade-offs), 2 rejected by validator.
- Seeded corpus smoke (`CODEVIEW_SMOKE=1`): **6/6 files in 34.9s**, **23,461 tokens**, 7 findings, 0 rejected.
- Contrast with v1 (`r_mwfekpnp_bm79` on `nConvert`, 43 files): **23m20s** PARTIAL (10 findings, interrupted at round 4).

---

## 0. Postmortem — why v1 failed (historical)

This section is the current primary result. The rest of the document records the design as built, not a recommendation to build it again.

### 0.1 Outcome

The review core demonstrated real value:

- Rust source selection worked after #76.
- Models found concrete, source-verifiable bugs: malformed-input panics, non-BMP text corruption, unbounded decompression, lost hyperlinks/images, YAML type changes, and nondeterministic asset selection.
- Evidence validation and structured findings were useful.
- After #77, orchestrator failure produced an honest PARTIAL report instead of destroying completed findings.

The surrounding architecture nevertheless failed operationally:

- Reviews were slow, token-heavy, and vulnerable to sequential transport/model failures.
- A small project did not complete within a reasonable interactive or batch-review budget.
- David stopped further redesign (#78, not planned). The correct decision was to stop, not to keep hardening the pipeline.

### 0.2 Measured evidence

Reference run: `r_mwfekpnp_bm79`, source `D:\DEV\nTeligence\nConvert`, 2026-11-13.

- Snapshot: **43 text files**, including **24 Rust** files — not a large project.
- Result: **10 validated Rust findings across 15 reviewed files**, with four digest gaps and explicit incomplete coverage.
- `state.json` created at **21:03:41**; final PARTIAL report written at **21:27:01**.
- Elapsed: **23 minutes 20 seconds**.
- Kimi disconnected during orchestrator round 4; three rounds completed.
- The run performed **43 tier-1 digest calls** before the sequential orchestrator dives.
- Other attempts failed on gateway timeout or malformed JSON. Those failures exposed result-preservation bugs, but fixing them did not fix the economics.

No trustworthy per-call token/cost ledger existed. That absence is itself part of the failure: the design had no operational measurements capable of rejecting it early.

### 0.3 Architectural root cause

**Coordination and repeated context dominated the useful work.**

The pipeline inserted two expensive coordination layers around the activity that actually produced value: a capable model reading real source.

1. **All-file digest phase before review.** Every eligible text file could incur a model call even when that file was never dived. The digest map therefore spent tokens and wall time before any finding existed.
2. **Sequential frontier-model rounds.** Dive rounds ran one after another. Total latency grew with the number of rounds rather than with the slowest independent target.
3. **Stateless context replay.** Each round resent the rubric/system context, the map, accumulated finding summaries, and newly selected source. Round N repeated work already paid for in rounds 1…N−1.
4. **Dynamic dive selection created a serial dependency.** The model chose the next files from the previous response, so the expensive dives could not be scheduled independently.
5. **Every round enlarged the failure surface.** A disconnect or malformed response late in the chain could invalidate an otherwise useful run. PARTIAL reporting preserved data, but did not reduce time or tokens.
6. **Retries multiplied already-expensive calls.** They improved resilience semantics while potentially repeating the same large prompt and generation cost.
7. **Coverage expansion amplified the coordination cost.** Making config/docs/data eligible was correct, but the architecture responded by digesting them all instead of separating eligibility from budgeted target selection.
8. **The budget unit was wrong.** `maxRounds` bounded neither elapsed time nor token spend. It limited loop count while allowing each round's input, output, timeout, and retries to dominate the review.

### 0.4 Process failure behind the architecture

This was a **collective design failure**, not a single implementation mistake.

- Multiple models reviewed the design before implementation. We refined the rubric, validation, state persistence, and failure semantics together.
- We treated multi-model agreement as evidence. It was only consensus around the same unmeasured assumptions.
- We did not first establish the minimal baseline: **one capable model reviewing one real file**, with findings, elapsed time, input tokens, output tokens, and cost recorded.
- We did not require each additional pipeline stage to prove a marginal recall/precision benefit worth its added latency and tokens.
- We optimized for conceptual completeness before defining an operational acceptance budget.

The lesson is not “use more models to review the next architecture.” It is **measure the core loop before designing infrastructure around it**.

### 0.5 What was not the root cause

- **Rust support:** worked and produced substantive findings.
- **Model capability:** the models were capable of finding useful bugs.
- **Malformed JSON alone:** a real reliability issue, fixed by schema guidance and PARTIAL reports, but not the economic root cause.
- **Partial-report semantics:** preserved completed work successfully; again, mitigation rather than a cure.
- **Configuration/docs being review-eligible:** appropriate review inputs. The mistake was an architecture that turned eligibility into blanket model processing.

### 0.6 Questions for a future architectural exploration

Do not answer these with another speculative pipeline. Answer them with measurements against the minimal direct-review baseline.

- What is the smallest useful review unit: changed hunk, file, dependency cluster, or module?
- Which context is actually required for cross-file findings, and when is it worth fetching?
- Do maps and digests improve precision/recall enough to justify their calls? Compare directly against source-only review.
- Can deterministic tier-0 candidates be reported without a model when no judgment is needed?
- Should review be diff-first so unchanged files incur zero model work?
- Can independent targets run concurrently with per-target idempotency and failure isolation?
- What are the hard wall-clock, token, and monetary budgets, and what partial result is returned when each is exhausted?
- What recall and precision does the system achieve per minute and per 1,000 tokens compared with one direct subagent reading the same targets?
- Is a persistent agent pipeline justified at all, or is a direct targeted subagent the better interface?

### 0.7 Acceptance criteria for any future design

A future proposal must start with a real corpus and report:

- End-to-end elapsed time and per-target latency.
- Input/output tokens and cost per call and in total.
- Validated findings, false-positive rate, and seeded-bug recall.
- Comparison against one model reviewing the same files directly.
- The marginal benefit of every extra model call or pipeline stage.
- Behavior under one target's timeout/malformed response without retrying unrelated completed work.

If these measurements are absent, the design is not ready for implementation.

---

## 1. Purpose

An agent that reviews a codebase — local, remote, or transmitted — and produces **optimization suggestions for reliability and performance, weighted against each other**: the most reliability at the lowest performance cost.

The review applies the Prime Directive's coding maxims mechanically. The rubric is not invented here; it is `Agents_Prime.md` § "Principles — Coding Maxims" encoded as review criteria.

**Anti-goal:** bloating code with try/catches, error-reporting ritual, and "clean code" conventions. The aim is architectures that cannot fail. If code *can* fail, the suggestion is to change it so it can't — not to handle the failure. No defensive programming.

---

## 2. Review rubric

The reviewer judges code against these rules (from the Prime Directive):

- **Fail fast & loud** — internal invariants (required config, impossible states, contracts between own functions) must crash, never degrade.
- **Design failures away** — eliminate failure conditions; validation at boundaries so invalid data never enters.
- **Hunt defensive patterns** — swallowed try/catches, fallback defaults masking missing config, optional chaining on invariants, `||` defaults, silent degradation paths.
- **Comments** — narration comments are a finding; only load-bearing comments (fixed-bug history, non-obvious external behavior, hard constraints) survive.
- **Zero-dependency bias** — each external dependency must justify itself against a hand-built alternative.

### 2.1 The boundary ladder

"Can fail" is only acceptable after climbing. Every external dependency (network call, disk, other process, external API) is judged on three rungs:

| Rung | Question | Action |
|------|----------|--------|
| 1. Eliminate | "Why does this dependency exist at all?" | Local copy, precomputed data, in-process call. The best failure handling is the request not existing. |
| 2. Shrink blast radius | "What happens to the process when it fails?" | Name the consequence class: corrupts state / wrong answer → feature degrades → cosmetic. Redesign until it drops a class. |
| 3. Tolerate visibly | Only what survives rungs 1–2. | Handler required to leave a trace (log level matching severity). |

- **Rung-2 pattern of record:** design the failure into the contract — failure as *data* (Result-style returns, an "Unexplored Sources" section in an output), not a control-flow hijack. The caller decides what the failure means.
- **Every finding names its rung.** "This try/catch is hiding a rung-1 question" is actionable; "consider adding error handling" never is.
- A handler that exists without having climbed the ladder first is the smell.

---

## 3. Findings contract

- **Cite exact lines** — file + line range, every time.
- **Name the concrete failure mode** — what breaks, when, in production shape. No generic advice.
- **Classify:**
  - **Free win** — improves reliability *and* performance (most findings: deleting a swallowed catch is both safer and faster). Rank these first.
  - **Trade-off** — reliability vs performance genuinely opposed (retry = reliability but latency; cache = speed but invalidation failure modes). Surfaced as an explicit either/or decision for the human, never auto-suggested, never scored by formula.
- **Report-first.** The tool never modifies code. Diffs are generated only for findings the user accepts.
- **Report format** (per David's reading preference): what the finding is, actual risk/decision, suggested next action. No architectural jargon walls.

### 3.1 Finding ↔ test pairing

Every finding pairs with a **test spec** (shape, load pattern, data source from the hierarchy below, and the named bug it proves) at review time. The *executable* test is generated only on `accept` (§6).

- A finding whose test spec cannot name a concrete bug → it was **speculation** → dropped outright. No "low-confidence" tier — hedged findings are silent degradation.
- A test that corresponds to no finding is **ritual** → not suggested.

Test realism rules (the hierarchy names the *ideal* source; what is actually available is a per-project fact the test spec states explicitly — no invented fixtures):

- **Real data hierarchy:** production replay → recorded fixtures from real I/O → generated data calibrated to observed distributions. Never `hello world` / `foo` / uniform random — synthetic uniform data hides exactly the skew being hunted (the 20 KB line, the zero, the unicode, the ten-year-old record).
- **Load is a shape, not a number.** Shapes that break things: thundering herd at startup, slow-then-burst, one huge payload among small ones, two concurrent writers on the same key mid-operation.
- **Reference case:** the VDB scan stall — all tests passed, but none ran a real 9.7k-file scan *while serving requests*; 13–20 s event-loop freeze shipped. Real shape, real volume, real concurrency catches it; a fixture never would.

### 3.2 Bias containment — the validator

Every model in the pipeline was trained on human code where defensive programming is the norm: the rubric's anti-goals are each model's training prior. Prompting suppresses the reflex; it does not remove it. Conventions smuggle back in as "consider adding", as guard-wrapped diffs, as mock-heavy tests. The philosophy is therefore enforced by a **deterministic gate, not requested from the models** — the same principle as tier-0 owning the mechanical hunts: what can be checked mechanically is never left to model judgment. Never a model as the only judge of model output.

- **Findings are structured JSON, not prose**: `{ file, lines, evidence, failure_mode, rung, class, test_spec }`. The `evidence` field must quote the snapshot **verbatim** (string-match verified by tier 0, whitespace/CRLF-normalized) **and fall inside the cited `lines` range** — a real quote attached to generic advice still fails the range check.
- **Ladder fields are structured, not prose** — "rung 1: necessary" boilerplate is the ritual the rule would create. Rung documentation must name: the dependency, the rejected elimination and why, the consequence class before and after. Field *presence* is checked mechanically; field *truth* cannot be — that limit goes to tier-2 adjudication, and the spec states plainly: past the validator, a biased model is back in the loop. The validator is a floor, not a judge.
- **Throwing guards ≠ degrading guards.** The validator classifies the branch action of any added check: `throw`/`exit`/`process.abort` = fail-fast assertion (prescribed by §2 — always legal) vs. return-a-default/continue = degradation (needs the ladder). A blanket "no null-checks" rule would reject the rubric's own prescriptions.
- **Boundary validation is not a handler.** §2 prescribes validating inputs at boundaries so invalid data never enters — that is design-away, not rung-3 tolerance, and needs no ladder license. The validator's handler rule targets degrading fallbacks, not input validation at tier-0-classified boundaries.
- **Validator rules (tier 0, applied to every generative output):**
  - A finding whose diff *adds* a degrading guard (see above) without documented rung analysis is rejected — the ladder is the license; no ladder, no handler.
  - Vocabulary blocklist ("best practice", "defensive", "for safety", "consider adding"): **counter only, never a rejection** — the words also appear in legitimate findings ("removes defensive fallback").
  - Accept-time diffs are scanned on **added lines only** — a "delete this catch" diff must not trip the handler scan.
  - Test specs are rejected for placeholder data (`foo`, `bar`, uniform random where real distributions exist). **Stubbing is boundary-relative:** proving rung-2/3 tolerance requires fault injection *at* the boundary — stubbing anything outside the tier-0 boundary classification is allowed; stubbing inside it is not. "No mocks" without this carve-out would ban the tests the ladder itself demands.
  - Tier-1 digests are schema'd (not free prose) and get the same blocklist counter — bias like "lacks error handling" must not enter the map and steer dive selection before any finding exists.
- **Rejections are visible, counted, and reported** — "7 findings rejected: 5 undocumented handlers, 2 placeholder-data tests" is itself a signal about the model pair in use. Fail loud applies to our own pipeline.
- **Omission is invisible to the validator** — it sees what models say, never what they miss. The recall floor is a **seeded regression corpus**: known bugs + planted defensive patterns, run per model pair, reported as recall numbers. The tool tests its reviewers with the tool's own rule: real shape, real volume.
- Tier-1 and tier-2 calls run with the rubric (Prime Directive maxims + ladder) as system prompt — `llm.query` is already primed with the Principles section, so this is native. The prompt is the first line of defense; the validator is the one that counts.

---

## 4. Pipeline

Two passes, never a cold whole-codebase review (that degenerates into generic advice):

1. **Map** — architecture overview, load-bearing seams, boundary classification. The map is **hierarchical** (module-level summary; file detail loaded on demand) — a flat 10k-file map overflows any window. Map overflow → loud failure, never truncation.
2. **Targeted dives** — orchestrator selects from a **deterministically ranked candidate list** (boundary-touching, fan-in, churn, tier-0 hit density), not from prose digests — dive selection quality must not rest on grunt prose. Raw source of selected targets is loaded for the orchestrator.

### 4.1 Tiers

| Tier | Executor | Cost | Work |
|------|----------|------|------|
| 0 | Deterministic (grep/AST), no model | free | Structure extraction, dependency graph, boundary classification (which files touch network/disk/other processes), swallowed-catch hunt, comment-narration candidates. |
| 1 | Grunt model | cheap | File digests, module summaries ("what does this actually do"), judgment-level observations grep can't make. **Mechanical pattern hunts (swallowed catches, `\|\|` defaults, narration comments) are Tier-0 only** — anything deterministic stays deterministic; a missed grep result is a bug in the hunt list, not model variance. |
| 2 | Orchestrator model | expensive | Sees the **map and digests** for the whole tree, plus **raw source of the dive targets it selects** (verification and exact line citations require reading the real code — digests alone cannot support either). Chooses dive targets, judges the ladder, adjudicates trade-offs, **verifies tier-1 findings are real** (kills hallucinated findings), writes the final report. |

- **Grunt floor is format reliability, not intelligence.** Tier-1 output feeds tier-2's context; erratic instruction-following poisons the map the smart model navigates. The pipeline tolerates mediocre conclusions, not malformed structure. (This is why David does not trust small local models even for grunt work.)
- **The orchestrator owns the budget.** After N targeted dives yielding no new findings, marginal value is spent — stop (the stop-rule ends early; the hard cap from §7.5 is the ceiling; hitting either → report what was **not** reviewed). A cheap model cannot judge that; it is what the expensive tier is paid for.
- **Orchestrator output is bounded and schema-guided:** top-level JSON schema (max 5 findings + max 5 next files), 16,000-token output cap, 600 s transport timeout. These reduce truncation; they are not a correctness guarantee.
- **Completed work survives orchestrator failure.** If transport retries or malformed-JSON retry exhaust, the pipeline writes and returns a report marked **PARTIAL**, with the interruption round/error, incomplete coverage, and every validated finding from completed rounds persisted normally. Partial reviews are not eligible as completed incremental baselines.
- **Coverage is reported, never silent.** The report lists un-reviewed files — the browser.research "Unexplored Sources" pattern applied to ourselves. 10 dives × 3–5 files in a large tree reviews a fraction; pretending otherwise is silent degradation.
- **Malformed grunt output climbs the pipeline's own ladder** (a gateway call is a boundary): retry once with the schema error attached (visible), then record the gap in the map and continue; kill the review only if the map is unusable.
- **Honest v1 scope: static analysis only.** The VDB-stall class of bug (cross-file, concurrent, runtime) is findable by the paired-test *specs* but not provable by static reads; runtime probes are a future tier. The spec does not promise what static review cannot see.

### 4.2 Model configuration

Config, not code. Defaults overridable per call:

```json
"codereview": {
  "models": {
    "grunt": "deepseek-flash-chat",
    "orchestrator": "kimi-k31-chat"
  }
}
```

- Per-call override: `codereview.review { source, models: { grunt, orchestrator } }` — e.g. `minimax-m31-flash-chat` + `gemini-argon-chat`.
- Model names validated against the gateway's `chat.models` list. Unknown name → **loud failure**, never a silent fallback to a default model.
- Overriding strengthens both roles; the pipeline shape never changes.

### 4.3 Incremental review

The biggest cost lever — bigger than model choice:

- Findings cached keyed by file hash (snapshots keyed by tree hash). **Cache key includes the model pair and rubric/validator version** — findings from a different model pair or an updated validator are a different review, not a cache hit.
- Re-review = **diff + blast radius** against the last snapshot. Blast radius = changed files **plus everything reachable from them in the Tier-0 dependency graph** — file-hash equality alone is a false negative when a caller changes but the callee's bytes don't.
- **Unresolved edges are reported, never trusted.** Dynamic imports, event emitters, and config-driven wiring are invisible to a static import graph; files reachable only through unresolved edges are listed as uncovered in the report. The incremental cache is itself a cache-trade-off (§3) — its failure mode (false "unchanged") must stay visible.
- **Rejected findings stay rejected.** Finding identity = content fingerprint (hash of evidence quote + failure mode), not line numbers — otherwise rejected findings resurface on every incremental run as lines shift.
- Most runs (a PR, a change) cost a fraction of a cold review.

---

## 5. Source resolution

One front door; the pipeline never knows where code came from:

| Input | Resolution |
|-------|------------|
| Local path (Badkid) | Copy into the snapshot — a live workspace edited mid-review would break the stability guarantee, same as any remote source. |
| UNC path (`\\coolkid\Work\...`) | SMB. **Copy once** — no random-access reads of thousands of files over the network. |
| `owner/repo@ref` | GitHub relay (git agent, REST). |
| Archive upload | nconvert's octet-stream upload pattern. |

All four **materialize to a local snapshot** under the agent's data dir, plus a tree hash. The snapshot is load-bearing:

- **Stability** — the reviewed tree cannot change mid-review.
- **Cache key** — incremental reviews diff snapshots.
- **Provenance** — findings cite content that still exists on disk, not a moving target.

**Snapshot hygiene** (without it, snapshots blow up disk and Tier-0 chokes on vendor bundles):

- Exclusions at copy time: `.git`, `node_modules`, binary files, minified/vendor bundles, **secrets — `.env*`, key/cert/credential patterns**. Lock files, configuration, documentation, and data are retained: they can carry reliability- and security-relevant behavior. Snapshots feed third-party model gateways; a secret in a snapshot leaves the lab.
- **Every exclusion is listed in the report** — heuristic exclusion (minified detection) silently dropping a relevant file is the same sin as silent degradation. The user sees what the review never saw.
- GC: keep the N newest snapshots per source path + any snapshot with un-disposed findings **or accepted-but-unapplied diffs** (they anchor to the snapshot); older ones deleted on a schedule.

---

## 6. Tool surface (draft)

| Tool | Purpose |
|------|---------|
| `codereview.review` | Run a review: `{ source, models?, budget?, scope? }` → report. |
| `codereview.findings` | List cached findings for a snapshot (filter by status/class). |
| `codereview.accept` | Mark a finding accepted → generates the diff proposal + executable paired test. **Diffs are anchored to the snapshot hash** — never a blind patch against a working tree that may have moved since the review. |

Read-only by design until `accept`. No tool writes to the reviewed codebase.

### 6.1 The acceptance gate — fail before, pass after

The generated test is **executed in a sandbox** against the snapshot twice: it must **fail on the unpatched snapshot** (proving the bug is real) and **pass on the patched snapshot** (proving the diff fixes it). A test that passes before or fails after → the acceptance fails loudly with the run output. This is the real anti-speculation gate — everything upstream filters claims; this one runs them. No bug reproducible on the snapshot, no accepted finding.

- The sandbox runs the snapshot's tests, not the lab's — dependencies installed inside the sandbox dir, no access to agent data or credentials.
- Findings whose bug needs runtime conditions the sandbox cannot reproduce (the §4.1 honest-scope limit) are marked **unprovable** at accept and never claimed as verified.

---

## 7. Decisions (Argon round, 2026-11-12; revised after Opus round same day)

1. **Language scope** — **JavaScript AST analysis + Rust structural analysis**, with **every snapshotted text file** eligible for model digest/dive through generic boundary analysis and ranking. That explicitly includes configuration, documentation, data, and extensionless files: language or extension controls deterministic depth only, never eligibility. Coverage names every generic-language file instead of silently treating it as reviewed by a language-specific analyzer. `codereview.accept` remains JavaScript-only and refuses other languages loudly rather than generating a mismatched Node test. **JS AST parsing uses `acorn`** — the one accepted dependency: hand-building a JS parser is a project in itself (the genuine-expertise exception to zero-dep, stated here as justification, not habit). Rust needs no parser dependency: its tier-0 pass extracts module/use edges and error-discard candidates structurally; model judgment remains mandatory.
2. **Concurrency** — **one review at a time**, grunt fan-out inside. Reviews are batch jobs; concurrency thrashes rate limits and state.
3. **Findings store** — **nDB** (notepad pattern). Status transitions (`new → accepted/rejected`) need mutation; JSONL append-only makes that a rewrite mess.
4. **Tier-2 execution** — **stateless calls passing a structured state object** (`{ map, verified_findings, remaining_budget }`). Pinned sessions accumulate dead-end dive context; explicit state survives crashes and keeps attention on the live map. The state object is persisted to `data/codereview/reviews/<id>/state.json` **after every turn** — crash survival is only real if it's on disk.
5. **Budget unit** — **hard cap on dives** (default ~10), not wall clock or tokens: ceilings that trigger mid-synthesis leave no report. Dives exhausted → forced final report pass.
6. **Dive fan-out** — **1 file per Tier-1 call** (parallelized), 3–5 files per Tier-2 dive turn. Batching files into one grunt prompt invites the format failures §4.1 warns about.
7. **Report location** — **both**: returned inline and written to `codereview/<snapshot>/report.md`. An expensive report lost to a dropped connection is unforgivable.
