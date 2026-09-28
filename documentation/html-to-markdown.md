# html-to-markdown — Shared HTML→CommonMark Converter

Reference documentation for the `html-to-markdown` module: what it is, what it
guarantees, and the contracts callers rely on. Last verified 2026-09-28 (43
tests green; validated against `docs.python.org` and `docs.astral.sh`).

## Why it exists

Before this module the workshop had no real HTML→Markdown conversion.
`extractContent()` (research scrapers) runs Readability and returns
`article.textContent`; the browser agent's `mode: 'markdown'` was that same plain
text with `# <title>` glued on top. Both flatten `<pre><code>` and `<table>` into
prose — the two structures documentation is mostly made of.

This module is the missing half. Readability (or the raw document) selects *what
the content is*; a DOM walker serializes it with structure intact.

## Location & entry points

```
src/lib/html-to-markdown.js       — the module (ES module)
tests/html-to-markdown.test.js    — node:test suite (54 tests)
tests/smoke-browser-markdown.mjs  — end-to-end smoke through browser.content
tests/smoke-browser-fetch.mjs     — browser.fetch: HTTP, shell fallback, raw, binary
tests/page-sweep.mjs              — sweep real docs pages and report quality
```

```javascript
import { htmlToMarkdown, elementToMarkdown } from '../lib/html-to-markdown.js';
```

Run tests: `node --test tests/html-to-markdown.test.js`
Run smoke: `node tests/smoke-browser-markdown.mjs` (launches headless Chrome)
Run fetch smoke: `node tests/smoke-browser-fetch.mjs` (local server, no network)
Run sweep: `node tests/page-sweep.mjs` (network; 12 built-in pages)

### The sweep

`tests/page-sweep.mjs` runs the converter over twelve real documentation sites
(Sphinx, mkdocs, rustdoc, vitepress, MDN, Hugo, DocBook, Docusaurus, react.dev,
Wikipedia) and prints per-page strategy, sizes, code-block and table counts, plus
any chrome signals that leaked. It writes each conversion to
`<tmp>/html-to-markdown-sweep/<slug>.md` for eyeballing.

```
node tests/page-sweep.mjs                            # the built-in list
node tests/page-sweep.mjs <url> [url ...]            # your own
node tests/page-sweep.mjs --scope document <url>     # force a scope
node tests/page-sweep.mjs --diagnose <url>           # raw HTML vs each strategy
node tests/page-sweep.mjs --fetch <url> [url ...]    # run the real browser.fetch tool
```

`--diagnose` is the one to reach for when something is missing: it compares
`<pre>`/`<table>` counts in the raw HTML against what each strategy produced, which
separates a selection failure from a serialization failure immediately.

## Contract

**`htmlToMarkdown(html, options)` returns Markdown or throws.** It never returns
a degraded empty string — a silently empty page is indistinguishable from a
failed extraction, and a caller harvesting 50 pages must be able to tell which
source it lost.

```javascript
const { markdown, title, strategy, stats } = htmlToMarkdown(html, {
    url: 'https://docs.example.com/api/v2',  // base for relative links
    scope: 'auto',                            // auto | article | document
    minChars: 0,                              // reject below this length
    maxLength: 0,                             // truncate at a block boundary; 0 = off
    keepLinks: true,
    keepImages: true
});
```

| Field | Meaning |
|---|---|
| `markdown` | The document. Findings and trailing whitespace normalized. |
| `title` | Document title, or Readability's article title. |
| `byline` / `siteName` / `excerpt` / `language` | Readability metadata, `null` when unavailable. |
| `strategy` | `readability` or `document` — which root was serialized. |
| `stats` | `{ htmlLength, markdownLength, reduction, truncated, codeBlocks, tables, tableRows }`. |

Throws `TypeError` on non-string/empty input, `Error` on an unknown `scope`, on
`scope: 'article'` with no article, and on any extraction shorter than `minChars`.

Note on `minChars`: the default `0` means **only an empty result is an error**. A
legitimately short page is the page's content, not a failure. Callers with a
policy — a docs harvester that does not want stub pages — raise it deliberately.

**`elementToMarkdown(el, options)`** serializes an existing DOM element or
fragment with no selection step. Throws on a non-element.

## Root selection

- `article` — Readability's content selection. Best for docs pages and posts.
  Throws if Readability finds nothing.
- `document` — the whole `<body>` minus chrome. The escape hatch for a reference
  page Readability mangles.
- `auto` (default) — article when it yields at least `MIN_READABILITY_CHARS`
  (200) **and** kept the page's structure, else document.

### Why `auto` is not purely length-based

An early version fell back to the body whenever it was substantially *longer* than
the article. That was wrong: Readability **deletes** "unlikely candidates"
(sidebar, comments, menu), so measuring by length made the fallback resurrect
exactly the junk it had just correctly discarded.

### Why `auto` checks structure, not just length

Readability is a readability heuristic, not a fidelity guarantee. Its conditional
cleaning discards whole subtrees that score poorly, and a `<div>` holding a page's
code blocks is exactly the kind of node it throws away — on
`docs.docker.com/engine/install/ubuntu/` **all 18 fenced blocks vanished** from an
otherwise perfect article (confirmed by instrumenting
`_cleanConditionally`, which removed the wrapper with 18 `<pre>` inside it).

So `auto` compares the page's own `<pre>` and `<table>` counts against the
article's, and uses the document when the article lost more than half
(`structuralLoss()`, with a floor of 3 `<pre>` / 2 `<table>` before the check is
meaningful). A harvester that silently drops code blocks is worse than one that
includes a little extra.

### Chrome removal in document scope

Two passes (`stripChrome()`) — an explicit selector list for semantics the browser
already knows, then token-based detection for the rest:

- Selector: `nav`, `aside`, `header`, `footer`, `form`, `dialog`, `menu`,
  `[role=navigation|banner|contentinfo|complementary]`, `[aria-hidden=true]`,
  `[hidden]`, `.skip-link`.
- Tokens (`isUnlikely()`): matched per hyphen/underscore-delimited token, never as
a substring — a naive regex for `toc` also hits `stock`, and `nav` would match
anything with those letters in a row. The set covers `ad(s)`, `banner`,
`breadcrumb`, `cookie`, `comment`, `disqus`, `fixed`, `footer`, `header`,
`masthead`, `menu`, `modal`, `nav`, `overlay`, `pagination`, `popup`, `related`,
`rss`, `share`, `sidebar`, `sponsor`, `toc`, `toolbar`, `widget`, and more.
- `TableOfContents` is caught by a separate phrase pattern — token splitting turns
  it into `table`/`of`/`contents`, and `contents` alone is as often the main
  content container as a table of contents.
- `MAIN`, `ARTICLE`, `BODY`, `HTML` and `[role=main]` are never removed.

`fixed` and `overlay` are in the token set because a `position:fixed` element is
not in the document flow by construction — on Tailwind-based docs that is how the
floating chat/help widgets are marked (Docker's `#gordon-chat`).

## Serialization rules

| HTML | Markdown |
|---|---|
| `h1`–`h6` | ATX headings; docs-generator permalink anchors unwrapped |
| `pre > code.language-x` | Fenced block, adaptive fence length, language preserved |
| `code` (inline) | Backtick span, fence sized past internal backticks |
| `table` (incl. `colspan`/`rowspan`) | GFM pipe table with alignment from `align`/`text-align` |
| `ul` / `ol` | Nested lists; ordered markers padded to equal width; `start` honoured |
| `blockquote` | `>` prefixed, recursive |
| `hr` | `***` — **not** `---`, which is a section separator in MD-Blocks |
| `dl` | Bold term + definition blocks |
| `figure > figcaption` | Image block + italic caption |
| `details` / `summary` | Bold summary + content (summary emitted **once**) |
| task list (`data-checked`) | `- [x]` / `- [ ]` |
| `kbd`, `mark` | Raw HTML around the element's literal text |
| `sup`, `sub`, `abbr`, `time`, `var`, `samp` | Transparent — text kept, tag and attributes dropped |
| `script`, `style`, `svg`, `noscript`, `canvas` | Dropped |
| Empty-label `<a>` | Dropped — never emits a bare URL for an icon anchor |
| Permalink `<a>` (`#`, `¶`, `§`, or empty, href `#...`) | Dropped |
| MediaWiki `[edit](…action=edit…)` | Dropped |

Code language is looked up on **both** the `<code>` and the `<pre>` (generators
disagree about where it goes), then `data-lang`, then — last resort — the `<pre>`'s
own class, which is the language on rustdoc (`<pre class="rust rust-example-rendered">`).
That last step is deliberately narrow (single lowercase token, no hyphen, not in
`GENERIC_PRE_CLASSES`) so `item-decl` and `line-numbers` cannot masquerade as one.

### Text escaping

One pass, deliberately. Escaping in two passes double-escapes: the emphasis pass
inserts a backslash that the hard-escape pass then escapes again.

- Always escaped: `\` `` ` `` `[` `]` `<`
- `*` and `_` escaped **only at a word boundary** — otherwise every snake_case
  identifier becomes `option\_0`, which is valid but unreadable.
- Line-start markers escaped only in text nodes that actually sit at the start of
  a line, so generated structures are never touched. The ordered-list case escapes
  the **period** (`1\.`), not the digits: a backslash only escapes ASCII
  punctuation, so `\1.` is not an escape at all.

### Tables

- Small tables (total column width ≤ `TABLE_PAD_MAX` = 160) are padded so the
  pipes line up. Larger tables are emitted compact — padding inflates a 40-row
  table by ~60% for no rendering benefit.
- Cells escape `|` and use `<br>` for hard breaks (a backslash break is illegal
  inside a cell).

### Alignment survives Readability

Readability deletes `align` and `style` during cleaning, which would silently drop
GFM column alignment. Before parsing, the module copies alignment intent to a
`data-align` attribute — `data-*` survives cleaning. `cellAlign()` reads
`data-align` first, then `align`, then `text-align`.

## Known gotchas

- **`keepClasses` must stay `true`** in the Readability options. Setting it false
  strips class attributes, which takes `language-js` off every `<code>` with it.
- Readability needs its own parse. It mutates the document it is given (deleting
  everything that is not the article), and document scope needs that tree intact.
  A clone is cheaper but its `baseURI` is unreliable in jsdom.
- `jsdom` parse cost is ~50–100 ms for a large page; `auto` scope parses twice.
- **A summary inside `<details>` must be skipped by `blocksFrom`.** `detailsBlock()`
  renders it, and the walker sees the same node when serializing the details'
  children — without the skip every rustdoc method signature was emitted twice
  (once bolded, once inline).

## Known limitations

- **Responsive duplicates survive.** Docker's docs carry a mobile-only table of
  contents inside the article (`div.not-prose > div.block.lg:hidden`). It is not
  chrome by any token heuristic, so it stays and appears near the top of the
  output. Chasing it would mean stripping breakpoint-hidden elements, which risks
  dropping real content on other sites.
- Duplicate content that exists twice in the source is preserved twice. The
  converter drops nothing it cannot identify as furniture or as a redundant
  duplicate of itself.

## Consumers

- `src/agents/browser/index.js` — `browser.content` with `mode: 'markdown'`
  (`scope`, `maxLength`, `minChars` pass through). Conversion failure returns an
  error result, not raw text.
- `src/agents/browser/index.js` — `browser.fetch`, the retrieval tool (renders
  by default, converts, writes to storage, returns the path). It refuses block
  pages rather than storing them, and rejects binary content-types.
- `src/agents/harvest/index.js` — `harvest.collect`, which delegates every page
  retrieval to `browser.runBrowserFetch` and so inherits the same conversion,
  block-page and storage behaviour.
- Planned: docs harvest pass 2 — composing the collected pages into one document.
