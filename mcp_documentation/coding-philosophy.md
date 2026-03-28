# Deterministic Mind — Coding Maxims

## Core Maxims

- **Reliability > Performance > Everything else.**
- **LLM-Native Codebase:** No human readability goals. Optimize for what an LLM can most efficiently understand and modify.
- **Vanilla JS everywhere.** No TypeScript. `.d.ts` files are generated for context only, never used at runtime.
- **Zero Dependencies.** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always.** No defensive coding. No mock data, no fallback defaults, no silencing `try/catch`. Let it crash and fix the root cause.

## Design Principles

- **Design Failures Away:** Prevention over handling. Every eliminated failure condition is a state that can never occur. When failures remain (external systems), fail fast.
- **No Defensive Programming:** Silent fallbacks, swallowed exceptions, and default values hide bugs — they make failures invisible and let bad state propagate. Each fallback trades a visible failure you can fix now for an invisible inconsistency you'll debug later. Defensive patterns belong only at boundaries you don't control (third-party libs, external APIs, user input) — and only as temporary band-aids in production while you fix the underlying design.
- **Disposal is Mandatory and Verifiable.** Every resource created must have a proven, confirmed disposal path.
- **Block Until Truth.** State is authoritative. UI reflects truth, never intent. Inputs are blocked during transitions — race conditions are structurally impossible.
- **Prefer Self-Explanatory Code.** Comments drift; code doesn't. Comment only what code cannot express: regulatory requirements, historical context, non-obvious consequences.
- **Single Responsibility.** If you need "and" or "or" to describe a function, it has multiple responsibilities.
- **Functional Purity.** Isolate impurity (I/O, state, randomness) at boundaries. Keep the core pure for local reasoning.
- **Explicit Dependencies.** Accessing via globals or registries hides contracts. Pass dependencies explicitly where it matters.
- **Immutability by Default.** Mutation creates temporal dependencies. Start immutable; optimize with mutation only when measurement proves it necessary.
- **Composition Over Inheritance.** Inheritance forces premature classification and tight coupling.
- **Measure Before Optimizing.** Intuition about performance is frequently wrong. Profile first.
- **Abstraction From Evidence.** First use case: write direct. Second: copy-modify. Third (now the pattern is visible): abstract. Wrong abstraction is harder to remove than no abstraction.
- **Know Your Data Shapes.** Type annotations are claims, not proofs. Validate at boundaries. When the type system and reality disagree, reality wins.

## Boundaries

**These apply where you have design authority.** At boundaries you don't control, defensive patterns are acceptable as temporary measures — but they are not the goal. The goal is to fix the underlying design so the defensive pattern becomes unnecessary.

---

**Key signal:** When you reach for an inherited pattern, ask — does the problem this solves actually exist in my context?
