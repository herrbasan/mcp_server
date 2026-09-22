# Inspector — code analysis

Reference documentation for the code-analysis agent. Last verified
2026-09-22 against `src/agents/inspector/index.js`.

## What it is

Iterative code review over one or more files: find bugs, explain
architecture, suggest improvements. A thin, deliberate wrapper — files are
read whole and handed to a gateway model with the "Deterministic Mind"
coding-philosophy system prompt (`prompts/system.txt`).

## Tool

**`inspector.inspect_code`** — `{ files*: string[] (absolute paths), prompt*: string }`

- `prompt` is the review task ("find defensive patterns that swallow errors",
  "explain the request lifecycle", …). (The server catalog previously
  advertised `task?` — fixed 2026-09-22 to match the handler.)
- Missing files fail fast per file (`File not found: <path>`, isError).
- No size cap, no truncation, no binary detection — whole files are
  concatenated as `--- File: <path> ---` blocks. Keep file lists sane.
- Gateway call: task `inspect`, system prompt from `prompts/system.txt`
  (fallback generic inspector prompt).
- Progress: throttled to ~4 updates/s, monotonic 0–100.

## When to use

- Second-opinion review of code you're about to change.
- Architecture walkthroughs across a handful of files.
- NOT for whole-repo analysis — it has no search; pick the files yourself
  (or pair it with grep/search first).
