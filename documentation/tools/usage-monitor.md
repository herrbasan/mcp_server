# usage-monitor — provider subscription usage

Reference documentation for the usage-monitor agent. Last verified 2026-10-14
against `src/agents/usage-monitor/index.js` and a live cycle.

## What it is

A collector that reads each LLM subscription's remaining quota and folds it into
ONE normalized snapshot for the localweb2 dashboard. Runs on a 10-minute timer
(`agents.usage-monitor.intervalMinutes`), writes
`data/usage-limits.json`, served by the MCP server at `GET /usage-limits.json`
and proxied by localweb2 at `/api/usage-limits`.

```json
{ "updatedAt": "...", "providers": { "<name>": { "windows": [...] } }, "stale": ["gemini"] }
```

Window kinds: `5h` | `weekly` | `tpm-day` | `monthly` | `pool`.
A window carries whichever of `usedPct` / `used`+`limit` / `remaining` the
provider actually exposes, plus `resetAt`, `unit`, `note`, and `primary: true`
on the ones the card shows first. A provider that failed this cycle keeps its
last-good windows marked `stale: true` with `staleError` and `staleSince`, so
the card shows the reason instead of hiding the last known figures.

## Tools

- **`usage_scan`** — run a cycle now, bypassing the timer; returns the snapshot.
- **`usage_status`** — timer state, last run + duration, per-provider
  last-success age and last error. Read-only.

## Extraction routes

Browser providers share the workshop Chrome profile (`data/chrome-profile`) via
CDP attach-or-launch, exactly like the browser agent, so the logins Dave
established persist. A headless launch strips `Headless` from the UA (OpenAI's
Cloudflare gates on it).

| Provider | Route | Notes |
|---|---|---|
| kimi | page-context RPC, `access_token` from localStorage | retries once on a stale token |
| z.ai | page-context fetch of the quota API, token from localStorage | proto3 drops zero values → an unused window ships no reset time |
| minimax | page-context fetch (cookies) | reads the explicit `*_used_percent` fields; weekly only when status ≠ 3 |
| deepseek | direct REST, gateway key | balance only |
| gemini | DOM scrape: rate-limit table (range forced to 1 Day) + spend page | selected by **account identity**, not by `/u/N` — see below |
| openrouter | direct REST, gateway key | |
| openai | DOM scrape: the `$X / $Y` spend span | |
| anthropic | console JSON: `/api/organizations/<org>/current_spend`, `/spend_limits`, `/prepaid/credits` | all amounts in cents |

## Gemini — the account owns the project, not the URL

The AI Studio rate-limit table renders per **Google Cloud project**, so which
account is signed in is the whole game. Two accounts share this profile and they
**coexist** — that is Google's multi-login, exactly what the account chooser
offers: adding `david@raum.com` does not evict `herrbasan@googlemail.com`.
Measured 2026-10-14 with both signed in:

| index | account | AI Studio |
|---|---|---|
| `/u/0` | `herrbasan@googlemail.com` | no project (the search/scraper account) |
| `/u/1` | `david@raum.com` | rate-limit table, project `gen-lang-client-0971375197` |
| `/u/2`, `/u/3` | funnel to `/u/0` | — |

Which index each account gets is assigned by sign-in order, so it must not be
hardcoded: the committed code used `/u/1`, a later session changed it to `/u/0`,
and both were guesses that fail the other way when the sessions change. With a
single account signed in, every index resolves to that account (measured then:
`/u/0 … /u/3` all landed on `/u/0` with the same email — which is why "it's
either u1 or u2" cannot be answered from the URL alone).

So the extractor selects **by identity**: `agents.usage-monitor.geminiAccount`
(config.json, currently `david@raum.com`; `USAGE_MONITOR_GEMINI_ACCOUNT` in
`.env` overrides it for ad-hoc runs) names the account it needs, it walks
the indices reading the account each page actually shows, and it uses the one
that matches. A mismatch does not fall back to whatever account happens to be
signed in — that fallback is exactly what made the 2026-10-13/14 failures look
like a selector problem while the monitor was quietly reading an account with
no project.

If the account is not signed in, the cycle fails with the probed list
(`/u/0: <email>; /u/1: …`) and one of two remedies:

| Path | How | When |
|---|---|---|
| Visible | `node scripts/gemini-login.mjs` | Always works. Opens a real Chrome window on the shared profile, waits for you to finish the Google sign-in, verifies the table renders, closes. The session persists in `data/chrome-profile`, so it survives restarts. |
| Automated | `USAGE_MONITOR_GEMINI_PASSWORD` in `.env` | Convenience only. Tried at most **once per process**, and only when the account is absent. Google decides: a 2FA/device prompt, a captcha, or "this browser may not be secure" ends as a loud named failure, never a retry loop. Changing the password needs a server restart (dotenv loads at boot). |

History worth keeping: the 2026-10-10 `ERR_TOO_MANY_REDIRECTS` loop on
`accounts.google.com` was cleared by wiping Google cookies from the shared
profile on 2026-10-13 (full profile backup at
`data/chrome-profile-backup-20261013-234000`). **That wipe is what signed the
provider account out** — Gemini had actually been healthy that evening (`ok (2
windows)` on every cycle from 22:19 to 23:33), and the session it removed was
the one holding the project. Nothing else logs the provider out: browser
research and the scraper run read-only pages in the same profile and were
measured before/after a full Google-path research run with both sessions
unchanged. The backup now carries the same single account, so it is not a
restore source.

Search automation also lands on `/u/0` — the *default* account — so the
provider session at `/u/1` is structurally insulated from anything Google
decides to do about bot-like search traffic. That is the practical argument for
keeping the split rather than merging the accounts.

Diagnostic for any "did X log us out?" question:
`node scripts/check-google-sessions.mjs` — prints Chrome's account record, the
account each `/u/N` resolves to, and whether its rate-limit table renders.

## Traps already paid for

- **The Anthropic console is localized.** The shared profile renders it in
  German, where figures arrive as `17,35 $` and the limit line reads
  `von 50 $ Limit · wird am 1. Nov. zurückgesetzt` — every English regex missed.
  Worse, `span.text-primary.text-3xl` is shared by the credits badge and the
  spend metric, so `querySelector` returned the credit *balance* as the month's
  spend (35% reported where the console said 1%). Both faults are gone now that
  the numbers come from the console's own JSON, in cents, with an ISO reset.
- **Never read a provider dashboard's formatted figures when it has an API.**
  Locale, DOM order and class churn are three independent ways to be silently
  wrong; the JSON the dashboard itself fetches has none of them.
- **Zero is a real value.** proto3 JSON omits zero-valued fields (z.ai, kimi),
  so an absent ratio means 0% used, not missing data.
- Failure captures (`data/usage-monitor-debug/`, URL + body text + screenshot)
  are kept at the newest 30 per provider.
- **An account's absence is not a selector error.** Gemini spent 43 cycles
  reporting `Waiting for selector \`table\` failed` while the real cause was a
  signed-out account; the page said so the whole time. Read the page's own
  state before waiting on a selector that cannot appear.
- **Test the hostname, not the URL.** Google's sign-in pages carry
  `continue=https://aistudio.google.com/…`, so `/aistudio\.google\.com/.test(url)`
  is true for a password prompt sitting on `accounts.google.com` — that read a
  sign-in form as a signed-in scrape (2026-10-14).
- **The shared profile accumulates tabs.** Chrome restores the previous session
  on launch, so a pile created once keeps coming back — the browser agent sweeps
  its own *visible* launches, which left every headless launch (one per cycle)
  carrying it. The collector now closes restored tabs on any launch it made
  itself; an attached browser is never touched.
- Cycle verification without the server or a timer:
  `node scripts/dry-run-usage-monitor.mjs [geminiAccount]`.
