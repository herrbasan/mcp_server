# Browser & Research agents

Reference documentation for headless web automation and web research. Last
verified 2026-09-22 against `src/agents/browser/`, `src/agents/research/`,
and their `config.json` files.

## Browser agent (`src/agents/browser/`)

Puppeteer-based headless Chrome with persistent sessions. 14 tools, all under
the `browser.*` method namespace (`browser.session_create`, `browser.goto`, …).

### Engine & lifecycle

- **Connect-first**: tries `puppeteer.connect(ws://localhost:9222, 3 s)` to an
  already-running Chrome; else launches with `--no-sandbox`,
  `--disable-blink-features=AutomationControlled`, `--remote-debugging-port=9222`,
  `--user-data-dir=data/chrome-profile`.
- Default viewport **1280×1280** (agent-local config `defaultViewport`; the
  root config's `agents.browser.viewport/userDataDir` are **dead config** —
  never read). Default UA `Chrome/120.0.0.0`, `Accept-Language: en-US,en;q=0.9`.
- **Idle timers**: browser closes after 5 min idle (only when zero sessions);
  individual sessions close after 10 min idle. Visible (`visible: true`)
  sessions close the whole browser on expiry.
- Pages auto-recreate on next use if closed; viewport restored.
- Retry helper: 3 attempts, exponential backoff (500 ms base); hard errors
  (unknown session, navigation failed) short-circuit. Per-tool overrides:
  goto 2/1000 ms, click 2/300 ms, fill 2/500 ms.

### Tools

| Tool | Key args (defaults) | Notes |
|---|---|---|
| `browser.session_create` | `viewport? {width,height}`, `userAgent?`, `visible?` | Returns `{sessionId, visible, pageUrl}`. |
| `browser.session_list` | — | `[id][VISIBLE] url (age)`. |
| `browser.session_metadata` | `sessionId*` | URL, title, viewport. |
| `browser.goto` | `url*`, `waitFor?` (CSS, 15 s), `timeout?` (30 s), `retries?` (2) | `waitUntil: 'load'`. |
| `browser.content` | `mode?` text\|html\|markdown\|screenshot | text/markdown: Readability extraction, whitespace-collapsed, **50 000 char cap** (markdown prefixed `# <title>`); html: **100 000 char cap**; screenshot: full-page PNG as image content. Extraction failure returns raw first 5 000 chars, not an error. |
| `browser.click` | `selector*`, `waitAfter?`, `mode?`, `retries?` (2) | |
| `browser.fill` | `fields* [{selector,value}]`, `submit?`, `waitAfter?`, `retries?` (2) | Clears via input event first; submit waits navigation (networkidle2, 15 s). |
| `browser.type` | `text?`, `key?`, `selector?`, `delay?` (0 ms/keystroke), `keystrokes?` | Named keys: Enter, Tab, Escape, arrows, Backspace, Delete, Home, End, PageUp, PageDown. |
| `browser.evaluate` | `script*`, `waitFor?` | Expression first, statement fallback on SyntaxError. |
| `browser.scroll` | `direction?` (down), `amount?` (500 px) | |
| `browser.inspect` | `selector*`, `screenshot?` | 5 s wait → tag/id/classes/attrs/text(200)/rect/visible/disabled + optional clipped screenshot. |
| `browser.console` | `sessionId*` | Drains the per-session console/pageerror buffer (each capture has type+text+location). |
| `browser.wait` | `selectors?` (OR race), `text?`, `urlPattern?` (regex), `condition?` (JS expr), `timeout?` (15 s) | No condition → error. |
| `browser.session_close` | `sessionId*` | |

Caveats: `offsetParent`-style visibility tricks don't apply (no shadow DOM
anywhere in this stack); fixed-position elements break `offsetParent !== null`
checks — use bounding rects. `browser.research` in the method map is an alias
for `research.topic`, not a browser tool.

### Exported seam for other agents

`init()` returns `{ getPage(), fetch(url) }` — research (and any future
agent) borrows pages from the shared browser: `getPage()` →
`{page, markUsed(), close(delay)}`; `fetch()` navigates to networkidle2
(30 s), returns full HTML, leaves the page alive 15 s.

## Research agent (`src/agents/research/`)

One tool: `research.topic` (`research_topic`) — deep multi-source web
research. `dependsOn: ["browser"]`; scrapes through the browser agent's page
pool.

Args: `query*`, `engines?` (default `['duckduckgo','google']` — bing was
removed from the enum 2026-09-22; the handler never supported it),
`max_pages?` (default **5**).

Pipeline (streaming-research.js):

1. **Search**: Google + DuckDuckGo in parallel (15 s timeout each, browser-
   driven form fill + result extraction), allSettled, URLs deduped.
2. **Prioritize** heuristically: docs/api/reference URLs +100, StackOverflow
   questions +90, GitHub issues +85 / discussions +80, github.blog +70,
   dev.to +50, Wikipedia +45, Medium +40, query words in URL +20 each, app-
   store pages −100, short-path noise −30. Keeps `max_pages × 2`.
3. **Scrape**: `getPage()` → domcontentloaded (15 s) → content extraction →
   page released after 5 s linger. `scrapeTimeout 10 s`, `maxConcurrent 5`,
   `maxTotalTime 60 s`.
4. **Synthesize** (gateway task `synthesis`): report with `[Source N: url]`
   citations; partial synthesis streams every 3 pages.
5. **Evaluate** (task `analysis`): confidence assessment appended.

Content extraction cascade (`scrapers/content-extractor.js`):
readability → semantic (article/main/[role=main]/.content/… selectors) →
paragraph-density scoring (top 20 `<p>`) → fallback (body minus chrome);
each capped at 50 000 chars, excerpt 300. Bot-wall detection (captcha /
cloudflare / "verify you are human" patterns) exists but only on the legacy
code path.

Known dead weight (documented for archaeology, do not build on it):
`web-research-ref.js` (unreachable legacy job system), the root config's
`agents.research` section (maxPages/maxDepth/timeout/searchEngines — never
read), prompts `query_optimization/source_ranking/merge` (loaded, unused).
