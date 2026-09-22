# GitHub — repository relay

Reference documentation for the GitHub REST relay. Last verified 2026-09-22
against `src/agents/github/index.js`.

## What it is

Browse and manage GitHub repos without cloning:
read files, trees, history, diffs; search repos/code/issues; create/update
issues and comment; list/get PRs. Read-mostly — the only writes are issue
create/update/comment (plus PR reads).

Auth: `GIT_TOKEN` from `.env` (init throws if missing; verified at boot via
`GET /user`). API `https://api.github.com` v3. No timeouts, no retries, no
caching — one fetch per call.

## Tools (17), method namespace `git.*`

### Read / history

| Tool | Args | Output |
|---|---|---|
| `git.read` (`git_read_file`) | `owner*`, `repo*`, `path?`, `branch?` | Decoded file text; directory paths return a type/size listing. Default branch when omitted. |
| `git.tree` (`git_list_tree`) | `owner*`, `repo*`, `path?`, `branch?` | Recursive `git/trees` listing; prefix path filter. Truncated trees → isError with guidance. |
| `git.log` | `owner*`, `repo*`, `path?`, `branch?`, `limit?` (20, cap 100) | `<sha7> date author message` lines. |
| `git.commit` (`git_get_commit`) | `owner*`, `repo*`, `sha*` | Header + per-file status (+adds/−dels); patches included under 4 000 chars. |
| `git.diff` | `owner*`, `repo*`, `base*`, `head*` | `compare` API; per-file patches truncated at 3 000 chars. |
| `git.branches` | `owner*`, `repo*`, `type?` branches\|tags, `limit?` (30, cap 100) | Branches marked `(protected)`. |
| `git.repo_info` | `owner*`, `repo*` | Description, language, size, stars/forks/issues, dates, topics. |

### Search

| Tool | Args | Notes |
|---|---|---|
| `git.search_repos` | `query*`, `limit?` (10, cap 30) | Sorted by updated. Supports `language:`, `path:` GitHub search syntax. |
| `git.search_code` | `query*`, `limit?` (10, cap 30) | `repo/path` lines. |
| `git.search_issues` | `query*`, `limit?` (10, cap 30) | Issues AND PRs, `PR|IS` tagged. |

### Issues

| Tool | Args | Notes |
|---|---|---|
| `git.issue_list` | `owner*`, `repo*`, `state?` (open), `labels?`, `limit?` (10, cap 50) | PRs filtered OUT of the listing. |
| `git.issue_get` | `owner*`, `repo*`, `number*`, `comments?` | `comments: true` pulls up to 50 comments. |
| `git.issue_create` | `owner*`, `repo*`, `title*`, `body?`, `labels?`, `assignees?` | Returns `#N + url`. |
| `git.issue_update` | `owner*`, `repo*`, `number*`, then ≥1 of `state?/title?/body?/labels?` | `state` must be open\|closed; throws on nothing-to-update. |
| `git.issue_comment` | `owner*`, `repo*`, `number*`, `body*` | Works on issues and PRs. |

### Pull requests

| Tool | Args | Notes |
|---|---|---|
| `git.pr_list` | `owner*`, `repo*`, `state?` (open), `limit?` (10, cap 50) | `#num state head → base title`. |
| `git.pr_get` | `owner*`, `repo*`, `number*` | Meta + body + first 20 files with patches. |

## Conventions

- All output is compact single-line-per-item text, not raw JSON.
- `requireFields` failures name the tool, the missing field, and the keys you
  actually sent.
- Search tools don't validate `query` presence — an undefined query becomes a
  literal `"undefined"` search (returns junk, not an error). Always pass it.
