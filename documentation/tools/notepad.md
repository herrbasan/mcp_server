# notepad

Deliberate state store — ideas (pins), tasks with step checklists, important dates, contacts, attachments.

> NOT memory. Memory is associative ("what do I know about X"); the notepad is
> deliberate state someone decided matters ("what's outstanding, what's due,
> what shouldn't be lost"). Don't merge them.

v2 spec: `scratch/notepad-proposal.md` (agreed brainstorm).

## Data model

One nDB database at `data/notepad/data.jsonl` (own folder → own `_files/`
buckets). One shared integer id space, sequential via a `_meta` counter doc.
Indexes: `id`, `type`, `status`.

Every item: `{ id, type, title, notes, owner, createdAt, updatedAt, …type fields }`.

| field | rules |
|-------|-------|
| `owner` | REQUIRED on every write: `"david"` (his board — the machine maintains it as secretary, writes only on his explicit request) or `"machine"` (the machine's own board, invisible to David unless he asks). Pre-v2 items read as `david`. |
| `context` | Optional, idea/task/date only (never contact). Registry-validated — unknown context errors with a fuzzy suggestion (`unknown context "raum.com" — did you mean "raum"?`). Canonical: lowercase, hyphens. |
| `ref` | Optional array of strings — pointers, not copies: session ids, storage paths, URLs. Replaced wholesale on update. |
| `body` | Optional long payload. Delivered ONLY by `notepad.get(id)` — never in `list`/`snapshot` (token economy: the snapshot enters every session's context). `title` is the post-it line; `notes` is a one-line clarifier. |

| type | fields | notes |
|------|--------|-------|
| `idea` | `status` (open/promoted/archived), `promotedTo`, `context` | the pin; `notepad.promote` turns one into a task (carrying owner/context/ref/body), link kept |
| `task` | `status` (open/done/cancelled), `due` (YYYY-MM-DD), `steps[]` `{text, done}`, `context` | subtasks are flat ordered steps — a step needing its own checklist should be promoted to a task |
| `date` | `when` (YYYY-MM-DD), `recur` (none/yearly), `context` | yearly dates map forward to their next occurrence in the snapshot |
| `contact` | `phone`, `email`, `address` | flat fields; extras go in `notes`. Lookup data — never in the Today view |

Type changes are rejected (`notepad.update` has no `type`); field validation is
per-type — setting `due` on a contact is a 400, not a silent drop.

Attachments: `attachments[]` of `{ref, name, type, size, addedAt}` where `ref`
is an nURI (`notepad:<8-char-hash>.<ext>`) into the nDB file bucket. SHA-256
dedup; deleting an item releases its refs and nDB trashes files no active doc
references (restorable). Served at `GET /notepad/files/:hash.:ext`
(immutable-cache headers — content-hashed URLs).

## Context registry

Contexts are deliberate state too — freeform contexts rot into drift:

- `notepad.context_add({name})` · `notepad.contexts()` ·
  `notepad.context_rename({from, to})` (rewrites referencing items; no alias
  system — aliases recreate the drift) · `notepad.context_remove({name})`
  (added beyond the proposal so the seed list can be trimmed; refuses while
  items still reference the context).
- Seeded on first boot: `raum`, `blog`, `arena`, `teaching`, `materna-bav`,
  `materna-tremonia`, `materna-dok-tools`, `nspeech`, `infrastructure`,
  `research`. Stored as `_ctx`-prefixed docs in the same nDB.
- Registry is in the snapshot footer so the vocabulary is visible before
  inventing a new name.

## MCP tools

`notepad.add` · `notepad.list` · `notepad.get` · `notepad.update` ·
`notepad.complete` (stepIndex? → step done, else task done) · `notepad.remove` ·
`notepad.promote` · `notepad.attach` (absolute file path) · `notepad.snapshot` ·
`notepad.context_add` · `notepad.contexts` · `notepad.context_rename` ·
`notepad.context_remove`

`notepad.snapshot({context?})` is the **Today view**, computed on read (never
stored), both boards with David's items first: optional per-context
project-start view (open pins + open tasks — run when starting project work,
same slot as reading the project's `Agents.md`), overdue tasks, tasks due
within `dueSoonDays` (default 7, config `agents.notepad.dueSoonDays`), all
open tasks with step progress, upcoming dates, 5 newest open ideas, **stale
pins** (open ideas older than `staleDays`, default 60 — cleanup prompts only,
never acted on automatically), context registry footer.
This is what session-start priming and dashboards should read.

## Boundary (non-negotiable)

The dreaming system and any background automation never create, edit, remove,
or archive notepad items. All mutations flow through explicit `notepad.*`
calls initiated by David or a seat in an active session. Verified mechanically:
`src/agents/dreaming/` has no import of the notepad module and no toolRouter
access — the boundary holds by construction. Nothing automatic: no
auto-archive, no background curation.

## REST API (same server, port 3100)

One writer (the agent's nDB), two transports. LAN-trust posture, no auth —
same as `/storage/`, revisit at multi-user time.

| Route | Purpose |
|-------|---------|
| `GET /notepad/snapshot?context=` | Today view (poll this from components) |
| `GET /notepad/items?type=&status=&owner=&context=&limit=` | list |
| `POST /notepad/items` | create (JSON body = same fields as `notepad.add`, `owner` required) |
| `GET /notepad/items/:id` | full record incl. body |
| `PATCH /notepad/items/:id` | update fields |
| `DELETE /notepad/items/:id` | remove (attachments GC'd) |
| `POST /notepad/items/:id/promote` | idea → task |
| `POST /notepad/items/:id/complete` | body `{stepIndex}` optional |
| `POST /notepad/items/:id/attachments?name=x.jpg` | raw-body upload (25 MB) |
| `GET /notepad/files/:hash.:ext` | bucket file (immutable cache) |
| `GET /notepad/contexts` | registry list |
| `POST /notepad/contexts` | `{name}` — create |
| `PATCH /notepad/contexts/:name` | `{to}` — rename (rewrites items) |
| `DELETE /notepad/contexts/:name` | remove (refuses while referenced) |

CORS `PATCH`/`DELETE` were added to the server's allowed methods for these
routes — browser components need the preflight to pass.

## Consumers

- **Session start** — prime directive protocol step 6 reads the notepad
  snapshot; every model opens a session knowing what's outstanding.
- **Chat app** — post-it wall rendering `owner=david` (polls the snapshot
  ~30–60 s); machine notes collapsed secondary view, off by default.
  Click-through fetches `get(id)` for body + refs.
- **localweb dashboard** — same data; per-context swimlanes via
  `list(context)` / `snapshot(context)`.
- **Machine ritual** — `snapshot()` at session start; `snapshot(context)`
  when project work starts (the pin check).

## Explicitly out of scope (do not add)

Recurrence beyond `none|yearly` · step-level dates/reordering · typed/structured
refs (plain strings; display pattern-matches) · context aliases ·
origin-based owner stamping (explicit `owner` on every write replaces it).
