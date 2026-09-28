# Harvest agent

Reference documentation for documentation harvesting. Last verified 2026-09-28
against `src/agents/harvest/` and its `config.json`.

## What it is

Pass 1 of the docs-harvest design: given a seed URL, find the pages around it,
choose which to fetch, render and convert them into storage, and write a manifest.

It is the **mechanical** pass, with exactly **one** model call in it: when the
section holds more pages than the budget allows, a model is asked once to rank
the link list against `intent`. Everything else — discovery, retrieval,
conversion, storage, the manifest — is code. Judging what belongs in the final
document is pass 2's job.

Two principles decide its behaviour:

- **Recall over precision.** What gets *fetched* is decided by scope (same
  origin, the seed's section) plus that one ranking. What gets *kept* is
  everything the budget allows — a short model answer is topped up in heuristic
  order rather than returning less, because pass 2 can discard surplus and cannot
  recover an omission.
- **Nothing is dropped silently.** Every discovered link appears in the manifest
  — fetched, failed, not selected, or filtered out — each with its reason.

## Location

```
src/agents/harvest/index.js     — agent (ES module)
src/agents/harvest/config.json  — agent + tool declarations
tests/smoke-harvest-collect.mjs — node smoke test against a local fixture site
tests/harvest-run.mjs           — run against real URLs with a throwaway storage root
```

Depends on `browser`. Retrieval is delegated to `browser.runBrowserFetch`, so
rendering, conversion, block-page detection and the per-page storage layout are
shared with the single-URL `browser.fetch` tool.

Run smoke: `node tests/smoke-harvest-collect.mjs`
Run live: `node tests/harvest-run.mjs <url> [maxPages] [--keep]`

## Tool

### `harvest.collect`

| Arg | Default | Meaning |
|---|---|---|
| `url*` | — | Seed URL. Fetched exactly as written. |
| `intent` | — | What you want out of the docs. This is what the selecting model ranks against. |
| `max_pages` | 30 | Pages to fetch. Rejected links stay in the manifest. |
| `select` | `'auto'` | `auto` \| `llm` \| `deep` \| `heuristic`. Ignored when everything fits in the budget. |
| `select_model` | `badkid-llama-chat` | Gateway chat model to do the selecting. |
| `whole_site` | false | Widen scope from the seed's own directory to the whole origin. |
| `include` / `exclude` | `[]` | Substring filters on discovered URLs (scope narrowing, not relevance). |
| `dir` | `'harvest'` | Storage folder. |
| `concurrency` | 4 | Pages rendered in parallel. |

Returns a summary plus the manifest path — never the pages themselves.

## Scope

The section is the seed's **directory**: `/3/library/json.html` → `/3/library/`.
A seed written with a trailing slash is already a directory, so
`https://docs.astral.sh/uv/` scopes to `/uv/`, not the whole site.

This is computed from the **original** pathname, not the normalised one.
Normalisation strips a trailing slash to make `/uv/` and `/uv` compare equal,
which would erase the only signal that the seed was a directory.

URLs are fetched exactly as given. Canonicalisation happens only in `urlKey()`,
for dedupe — because fetching the normalised form of a directory URL is a 404 on
any server that does not redirect.

## Discovery

Four sources, unioned, the seed first so its exact form wins the dedupe:

| Source | What it gives |
|---|---|
| `sitemap.xml` | Complete where it exists; follows a `<sitemapindex>` one level down. |
| `llms.txt` | Curated, and written for exactly this purpose. Checked at the site root and in the seed's directory. |
| `nav links` | The seed page's own nav/sidebar — what it considers adjacent. |
| `section index` | The seed's directory landing page. |

The **section index is what makes this work on Sphinx-style sites.** The sidebar
there links *up* and *within* the page; the complete chapter list exists only on
the section's own landing page. Measured on `docs.python.org/3/library/json.html`:
without it, 5 pages found in section; with it, **265** (the section index alone
contributed 316 links).

`sitemap.xml` and `llms.txt` are not pages, so they are read over plain HTTP
rather than rendered — rendering would wrap them in a viewer document. Failure
is not an error; it just means the next source is tried.

Nav extraction prefers `nav` / `aside` / `[class*="sidebar"]` / `[class*="menu"]`
/ `[class*="toc"]` / `[role="navigation"]`, and falls back to content-area links
when that yields fewer than five — a short list usually means JavaScript-built
navigation, not a small site.

## Candidates

Kept: same origin, inside the section, a document (no asset extensions), not
already seen, passing `include`/`exclude`. Sorted shallowest-path-first, ties
alphabetical, so a harvest is reproducible. Then cut to the budget.

Dropped links are deduped by URL — the same link is routinely found by three
sources, and listing `github.com/astral-sh/uv` three times as "different origin"
misrepresents how much was set aside.

## Selection

The seed is always fetched. If the remaining pages fit in the budget, nothing is
chosen and **no model is called** (`selection.mode: 'all'`). Otherwise:

1. Candidates are numbered and labelled — label is the anchor text the site
   itself uses, the only signal available short of fetching each page. A URL
   discovered first by a sitemap (unlabelled) is enriched by the nav's label when
   that arrives later.
2. One call, non-streaming, to **`badkid-llama-chat`** by default — the
   always-available local model. Its context is 262144 tokens, so the whole
   candidate list fits: there is no reason to reach for a cloud model, and none to
   grind the list down to what a smaller window could hold. `MAX_LINKS_TO_MODEL`
   is 2000 (~50k tokens), a ceiling rather than a constraint, because a crawler
   that finds tens of thousands of links should not be able to build an unbounded
   prompt.
3. Parsing is deliberately forgiving: first bracketed run, numbers or numeric
   strings, out-of-range and duplicate entries ignored. A small model wraps JSON
   however it likes, and failing a harvest over formatting would be absurd.
4. A short answer is topped up in heuristic order to the budget; the manifest
   records `model_picks` and `topped_up` separately, so a lazy answer is visible.
5. If the reply yields nothing usable, or the call fails, selection falls back to
   shallowest-path-first and the manifest records the reason.

Measured 2026-09-28 against the 264-page Python standard library index, asking
"working with dates, times and timezones":

| Route | Picks | Time |
|---|---|---|
| `badkid-llama-chat` (default) | `datetime`, `time`, `zoneinfo`, `calendar`, then `ipaddress`, `math`, `internet` | 8.6–10.0 s |
| `kimi-chat` | `datetime`, `time`, `zoneinfo`, `calendar`, `sched`, `timeit` | 3.7 s |
| gateway task routing | `datetime`, `time`, `zoneinfo`, `calendar`, `sched`, `timeit` | 19–43 s |

The local model gets the first four right and its tail picks are weaker. It stays
the default because it is free, always available, twice as fast as the routed
model, and pass 2 reads the manifest — where every rejected link is still listed —
so a mediocre tail pick costs a page, not the document.

An earlier test asked for "the JSON encoder API" over that same index and got
noise. The failure was the test, not the selector: the Python *standard library*
has exactly one JSON page, and it is the seed, which is excluded from the
candidate list. A selection task needs an intent the corpus actually contains.

### Deep mode — `select: 'deep'`

Slower, and the one to use when you actually want to dig into something.

One call over hundreds of items asks the model to do a **global ranking** —
compare every candidate against every other — and a small model skims that.
Deep mode cuts the list into batches of 45 and asks each batch to **score every
item** 0 (irrelevant), 1 (marginal), 2 (relevant), 3 (core). That turns one hard
judgement into 45 easy ones, and merging is arithmetic because the numbering is
per-batch — no second model call, no merge failure mode.

Measured on the same 264 candidates and question:

| Mode | Time | Solid 4/4 in top-8 | In top-4 |
|---|---|---|---|
| `auto` (one call) | 0.7–2.4 s | 4/4 | 3/4, then 4/4 |
| `deep` (6 batches) | 9–10 s | 4/4 | 4/4 both runs |

So it buys **stability**, not peak quality. Two things it gives that a pick-N
answer cannot:

- The score distribution. A real run returned `{0: 216, 1: 40, 2: 3, 3: 5}` —
  216 of 264 pages were irrelevant, only 8 scored 2 or above. That is a much
  better answer to "was the budget the right size?" than a list of 8 URLs.
- `left_at_cutoff`: how many rejected pages scored as well as the weakest page
  that was taken. That run left 1 behind.

An unrated candidate is **unknown, not irrelevant** — the model omitting an index
returns `null`, which ranks below everything scored, so it is a first candidate
for the top-up rather than a silent loser. If the model rates *nothing*, deep mode
refuses: it returns no selection and the caller falls back, because the input
order dressed up as a model's choice is exactly the silent degradation this pass
must not produce.

Batches run four at a time, and `MAX_DEEP_BATCHES` (20) caps the work at 900
candidates; beyond that the remainder is recorded as unrated rather than
silently dropped.

## Gotcha found here — a reasoning model spends `max_tokens` before answering

With a 1024 or 4096 token budget the gateway's task-routed model returned an
**empty string** with `finish_reason: max_tokens`. Not truncated output — nothing
at all, because its reasoning is counted against the same budget and the answer
never starts. `SELECT_MAX_TOKENS` is 8192 (equal to the local model's output cap)
for that reason, and `finish_reason` is logged whenever a reply is unusable,
because this failure is otherwise undiagnosable. Also: use `stream: false` for
the call, since the streaming path sets `strip_thinking` and an all-reasoning
reply arrives empty with no clue why.

## Output

```
<dir>/<host>/<slug>.md          one file per page, with provenance frontmatter
<dir>/<host>/_manifest.json     machine-readable: pages, failed, not_fetched
<dir>/<host>/_index.md          the same information, readable
```

`<host>` is slugged the same way `browser.fetch` does it, so the manifest sits
beside the pages it describes rather than in a sibling directory differing only
in punctuation (`127.0.0.1` vs `127-0-0-1`).

Manifest shape:

```json
{
  "seed": "...", "collected": "...", "section": "/uv/", "whole_site": false,
  "sources": [{ "name": "llms.txt", "links": 55 }],
  "budget": 30,
  "selection": { "mode": "deep", "intent": "...", "requested": "badkid-llama-chat",
                 "considered": 264, "scored": 264, "batches": 6,
                 "scores": { "0": 216, "1": 40, "2": 3, "3": 5, "unrated": 0 },
                 "left_at_cutoff": 1, "model_picks": 7 },
  "pages":      [{ "url", "storage", "title", "bytes", "strategy", "codeBlocks", "tables" }],
  "failed":     [{ "url", "error" }],
  "not_fetched":[{ "url", "reason" }],
  "links":      { "discovered": 438, "unique_in_section": 265, "fetched": 8 }
}
```

`selection.mode` is `all` (nothing to decide), `llm` (one call), `deep` (batched
scoring), or `heuristic` — and when it is `heuristic` the `reason` says why,
whether that was `select: 'heuristic'`, an unreachable gateway, a failed call, a
model reply with nothing in it, or a deep run where nothing was rated.

## Failure behaviour

Per-page failure is tolerated and recorded — a 404 or a block page lands in
`failed` with its error and the run continues. That is a boundary (the network),
so it tolerates with a trace.

A run where **every** page fails throws, with each URL and its error. That is not
a boundary condition, it is a broken harvest.

## Measured

| Seed | Sources | In section | Fetched | Corpus | Time |
|---|---|---|---|---|---|
| `docs.astral.sh/uv/` (mkdocs) | llms.txt, nav | 139 | 10 | 46 KB | 5.9 s |
| `docs.python.org/3/library/json.html` (Sphinx), heuristic | sitemap, nav, section index | 265 | 10 | 263 KB | 8.6 s |
| `docs.python.org/3/library/json.html`, local model selecting on "dates and times" | sitemap, nav, section index | 265 | 8 | 260 KB | 8.6–10.0 s |
| `docs.python.org/3/library/json.html`, `select: 'deep'` on the same intent | sitemap, nav, section index | 265 | 8 | 260 KB | 19.1 s |

The deep run's picks: `calendar`, `datetime`, `time`, `timeit`, `zoneinfo`,
`i18n`, `locale` — all four solid answers in the top four.

## Gotcha found here — HTTP 304 is not a failure

This agent uses a persistent Chrome profile, so a second visit sends a
conditional request and the server answers `304 Not Modified` while Chrome serves
the cached body. An `if (!response.ok())` status test rejected those, which failed
an entire harvest on the **second** run against the same pages. `browser.fetch`
now fails only on `status >= 400`.

## Not built yet

- **Pass 2.** The manifest is designed as its input: pages with storage paths plus
  the full link list, including everything not fetched. The intent is a chat
  session with a pinned model that can read pages out of storage and go back for
  the abandoned links.
- **Git repositories.** A repo is the other half of the original idea and a
  different code path entirely — `git.tree` + `git.read` walk README and `docs/`
  with no rendering at all. Not implemented.
