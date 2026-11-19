# Memory Refactor Lab

Creates an isolated, disposable copy of the knowledge system for the recall /
index / reference / dreamer refactor. Live services keep running; the tooling
never writes to a source path and never starts an agent, scanner, or timer.

## Create a snapshot

From an elevated 64-bit PowerShell prompt:

```powershell
npm run snapshot:memorylab
```

VSS is the default. The script detects the source volumes, creates shadow
copies, copies through temporary symlinks, and removes only its own links and
shadows in `finally`.

A non-elevated direct copy requires an explicit choice:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/snapshot-memory-lab.ps1 `
  -AllowCrashConsistentCopy -Name baseline-2026-11-17
```

Direct mode reads live files while services run. It is **crash-consistent, not
point-in-time**; the manifest records that limitation and validation is
mandatory before using the copy.

## Validate

```powershell
node scripts/validate-memory-lab.mjs --snapshot D:\MCP_Lab\memory-refactor\baseline-2026-11-17
```

Validation parses the manifest and canonical JSON artifacts, checks reference/work hashes,
and opens only copied nDB/nVDB databases through the native loaders. Raw dreamer
model-output captures are debug text: malformed JSON in those files is reported
as a named warning, while malformed canonical dream/map JSON remains fatal.
Validation makes no Gateway calls and never imports agent `init()` functions.
A failed check exits nonzero.

## Layout and scope

Each timestamped snapshot contains:

- `reference/` — untouched baseline used for comparison and reset.
- `work/` — the only database copy opened by the validator or future experiments.
- `manifest.json` + `MANIFEST.sha256` — source paths, consistency mode, counts,
  sizes, critical-file hashes, exclusions, and copy status.

Included: full storage corpus, memory nDB, nVDB (including WAL files), dream
artifacts/history, MCP headless-chat sessions, and LLM-Gateway-Chat server data.
Chat ZIP backups are omitted. Notepad, browser profiles, forge state, uploads,
and temp data are outside the snapshot scope.

The destination must be outside every source tree. Preflight requires space for
both copies plus a configurable margin. Existing snapshot names are never
overwritten.

## Phase 0 retrieval baseline

```powershell
npm run baseline:memorylab -- --snapshot D:\MCP_Lab\memory-refactor\baseline-2026-11-17
```

The runner executes the versioned golden cases in
`tests/fixtures/memory-lab-phase0-golden.json` and writes a timestamped report to
`<snapshot>\reports`. It records raw lexical/semantic candidates, labeled target
ranks, timings, source-intent buckets, chat contamination, and vector integrity.
Stored live `absolutePath` metadata is never followed; content evidence resolves
against `work/storage`.

The default runs full memory/storage vector coverage. `--skip-integrity` is
available for quick query-only iterations. Temporary nDB text indexes are staged
under the snapshot's own `scratch/` directory and removed after the run.

## Lab vector repair

```powershell
npm run repair:memorylab -- --snapshot D:\MCP_Lab\memory-refactor\baseline-2026-11-17
```

The default audit/probe re-embeds only the five known #82 chunks and writes no
database changes. It proves the current provider returns distinct valid vectors.
The audit distinguishes suspicious cross-content duplicates from legitimate
identical-content embeddings.

After a healthy probe, `--apply` repairs every suspicious memory/storage vector
in `work/` only. All planned embeddings are validated before the first insert;
before/after reports land in `reports/`. `reference/`, source content, scan-index
hashes, and memory nDB content/status remain unchanged. Use `--storage-only` or
`--memory-only` to narrow scope.

## Storage rebuild: scan limit and resume

`scripts/rebuild-memory-lab-storage.mjs` lets the VDB agent's own initial scan do the
indexing. The agent aborts a scan after `agents.vdb.scanTimeoutMinutes` (30 by
default); `--scan-timeout-ms N` sets that agent limit, and the runner waits 5 minutes
longer so the agent always fails first. A timed-out scan publishes `lastScanError`
and failure stats (`errors >= 1`) in `vdb_status`, never `lastScanAt`; the runner
throws `initial scan failed: <error>` immediately instead of polling to its deadline.
The timed-out scan is not cancelled, so after such a failure wait until the process
has exited, then continue with `--resume` (unchanged files skip, nothing is rebuilt
from scratch). For a full corpus raise the limit, e.g. `--scan-timeout-ms 14400000`.

## Candidate storage comparison

```powershell
npm run compare:memorylab -- --snapshot D:\MCP_Lab\memory-refactor\baseline-2026-11-17
```

Compares canonical `work` storage against the clean rebuild at
`<snapshot>\candidate\nvdb` without renaming the candidate over `work`. Only the
`storage` collection is opened on each side; candidate memory/chat collections are
not needed. The newest `rebuild-storage-*.json` report must have `status: ok` for
that candidate (the rebuild writes it only when finished); `--allow-incomplete`
skips that gate. Never run it while a rebuild is still writing.

Report `compare-storage-candidate-<stamp>.json` (in `<snapshot>\reports`, exit 1 on
any failed check) holds per side: missing vectors (alias entries are excluded),
bad-dimension/non-finite/zero vector totals (samples capped, totals true), duplicate
vector groups, the five explicit golden vectors (`allDistinct`), plus the golden
storage cases (ranks, final-window overlap, target/adjacent rank deltas, timings).
Each golden query is embedded once and the same vector is replayed against both
collections through Phase 0's shared `storageLaneFromVector`.

Duplicate groups are classified by exact chunk text, because `payload.contentHash`
is the whole-file hash: one `contentHash#splitIdx` = `sameContent`; different keys
but byte-identical chunk text (read from `work/storage` via `path` +
`charOffset/charLen`, group members only) = `sameText`, legitimate; different text
under one vector = `crossContent`, corruption; unreadable evidence = `unverified`,
which is never counted as clean (check `candidate-duplicate-groups-verified`).

## Test

`node tests\compare-memory-lab-storage-candidate.test.mjs` covers the comparison.

```powershell
npm run test:memorylab
```

The fixture suites exercise snapshot copies, manifests, validation, exclusions,
destination refusal, production-shaped retrieval lanes, golden metrics, chat
contamination, vector integrity, and nVDB `topK`/`top_k` behavior. VSS requires
real elevation and is parse-checked but not exercised by fixtures.
