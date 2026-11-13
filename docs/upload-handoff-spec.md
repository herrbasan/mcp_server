# Upload handoff — spec (draft, 2026-11-13)

How bytes get from a client (browser chat app, VS Code shell, script) into a
tool that only understands **paths**. This is the missing half of every ingest
tool we own: `nconvert.convert`, `image.ingest`, `media.process`,
`print.render`, `forge.call` payloads and `notepad.attach` all take a path or a
URL, and until now exactly one of them — nConvert — had a way in for bytes.

Status: implemented 2026-11-13, route name `/upload` approved. The writer
lives in `src/upload.js`; routes are registered in `src/server.js`;
`/nconvert/upload` is re-pointed at the same writer
(`src/agents/nconvert/ui-api.js`). Tests: `npm run test:upload` (routes on an
ephemeral port) and `npm run test:nconvert` (the nConvert surface). Reference
doc: `documentation/tools/upload.md`.

## 1. Problem

### What we are trying to do

A user picks a file — a 150 MB PowerPoint, a 4 GB deck, a logo, a scanned PDF —
and asks an agent to work with it. The agent is a model calling **MCP tools**;
the tools that understand documents (`nconvert.convert`), images
(`image.ingest`), media (`media.process`), print (`print.render`) and forge
payloads all take a **path or a URL**. Nothing in the agent's hands can hand them
bytes.

So the job is narrow and mechanical: **get the bytes onto the machine where the
tools run, and give the model a short name for them.** Everything else in this
spec is the consequences of doing that safely.

### Why it is hard — the constraints that shape the design

- **Tool arguments are JSON.** A 150 MB file cannot travel inside a tool call,
  and must not: bytes in the argument become bytes in the model's context. That
  is the whole reason the shell appears in the workflow at all — it is the only
  component that can move a file without *reading* it.
- **The model must never touch the payload.** It passes a name, the way a shell
  passes a path. Any design where the model base64s a file is a non-starter,
  both for cost and for the 4 GB case.
- **Two different clients, two different capabilities.** The chat app is a browser:
  it holds the bytes (a `File`), it can POST, it cannot write the server's disk.
  A VS Code session on the same machine as the server has the opposite profile —
  it can name a file on disk directly, and needs no transfer at all. The
  mechanism has to serve both without two mental models.
- **Files are big now.** The converter accepts up to 4 GB (raised 2026-11-13,
  both the upload cap and the engine's `max_input_mb`). Anything that buffers a
  body in memory is disqualified at that size, and a disk that fills silently is
  a worse outcome than a refusal.
- **Uploads are untrusted input.** They arrive from a LAN-trusted, unauthenticated
  route and are parsed by engines. They must never be rendered back from the
  server's own origin (see §6).

### What exists today

| Path | Works for | Fails at |
|---|---|---|
| `nconvert.convert({ path })` with an absolute path on the server's machine | VS Code on the same machine — verified 2026-11-13 | Any client that does not share the filesystem with the server |
| `POST /nconvert/upload` (raw body, `?filename=`) | The chat app, and the nConvert review page | nConvert only. It ingests immediately and returns a job — there is no way to park bytes for `image.ingest`, `media.process` or anything else |
| The shell doing `curl.exe --data-binary @file` | A Copilot session on a *different* machine (verified over LAN, 2026-11-13) | Nothing, for nConvert — but it is a one-off recipe, not a contract, and every new consumer grows its own route and its own quoting hazards |

Measured while establishing the above: 101 MB against the old 100 MB cap →
`413`; 95 MB accepted in 3.8 s (≈25 MB/s, loopback); a 150 MB target needs the
cap raised in **two** places (this server and `nteligence.toml`) because each is
enforced by a different process.

### Why the existing route is not the answer

`/nconvert/upload` conflates three things: accept bytes, park them, run a
conversion. Only the first two are general. Because the third is baked in, the
route cannot serve any other tool, it cannot be reused for a second conversion of
the same file, and its lifecycle (delete when the job ends) is wrong for a file
that several tools might read.

The generic piece is the **handoff**: bytes in, a name out, the file left alone
until it expires.

### What "solved well" means — acceptance criteria

1. A browser can upload 150 MB and a 4 GB file can be uploaded by a script,
   with nothing buffered in memory on either side.
2. One tool call per consumer afterwards: `nconvert.convert({ path })` and
   friends take the returned path with no translation step.
3. One implementation of the writer, shared with `/nconvert/upload`, so the two
   routes cannot drift.
4. Nothing accumulates: every upload expires, and the disk guard refuses before a
   write rather than after.
5. An upload is never served back as renderable content from this origin.
6. A fresh session can read this file and know *why* each rule exists, not just
   what it is.

## 2. Shape

One route, one handle, every consumer.

```
POST /upload?filename=<name>[&ttl=<hours>]
  Content-Type: application/octet-stream
  body: raw bytes, streamed
  → 200 { id, path, bytes, sha256, expiresAt }
```

`path` is the handle. Absolute, readable by every tool, valid until `expiresAt`.
`id` exists for the sweeper, for logging, and for provenance in sidecars — it is
not required to consume the file.

```
DELETE /upload/:id            → 200 { removed: true } | 404
GET    /upload/:id            → metadata only, never the bytes (see §6)
```

Deliberately **not** in scope: resumable/chunked upload, per-user auth, a file
browser, serving bytes back, virus scanning, or any notion of "attachment" in the
model context.

## 3. Where the bytes live

`<repo>/data/uploads/<id>/<sanitized-name>` — **outside** the storage root, on
purpose: VDB watches all of `D:\MCP_Storage` (`agents.vdb.watch.storage`), so an
upload parked there would be scanned and embedded — a 150 MB deck becomes an
indexing job and a searchable document nobody asked for. `data/` is already where
nConvert's temp copies go, so this is the same volume, the same cleanup story and
no new exception in any scanner.

Filename: reuse `uploadName()` (basename, unicode-preserving, `[^\p{L}\p{N}._ ()-]`
→ `_`). Path traversal is rejected before the directory is created — that check
already exists and stays.

## 4. Lifecycle

- **Write:** streamed to disk with a counting cap (§5). Nothing is buffered; the
  client's `Content-Length` is untrusted and only ever used as an early reject.
- **Reuse:** none by default. The same bytes uploaded twice are two handles. A
  consumer that cares about identity (nConvert does) computes its own hash; the
  response `sha256` is there so a caller *can* skip a re-upload, not so we dedupe
  behind its back.
- **Expiry:** `ttl` query (hours), default `agents.upload.ttlHours` (24). A sweep
  runs on startup and on an interval, deletes expired directories, and logs the
  count at `info`. A running tool may still hold a path when the sweep fires, so
  the floor is 1 h and a job longer than that is the caller's problem — the handle
  it was given names its own expiry.
- **Disk guard:** refuse (`507`) when free space on the data volume is below
  `agents.upload.minFreeGb` (default 20) *before* creating the directory. A 4 GB
  cap with no disk guard is a way to fill a drive by accident.
- **Crash:** a directory with no `meta.json` is an interrupted write — the sweep
  removes it first. `meta.json` is written last, so its presence means "complete".

## 5. Limits

| Limit | Where declared | Default |
|---|---|---|
| Body cap | `agents.upload.maxBytes` | 4096 MB |
| Default TTL | `agents.upload.ttlHours` | 24 h |
| Minimum free disk | `agents.upload.minFreeGb` | 20 GB |

The cap is enforced **while streaming** (measured behaviour of the current
writer): the response is `413` with a message naming the config key, the client's
remaining body is drained rather than socket-reset — a reset reaches the caller as
`fetch failed` and hides the reason.

The same writer must serve `/nconvert/upload`: one implementation, two routes.

## 6. Serving bytes back: do not

`GET /files/...` already proxies the engine's artefact namespace. Uploads are
**untrusted input** and must never be rendered from this origin: an uploaded
`.html` or `.svg` served as `text/html`/`image/svg+xml` is stored XSS against
every tool page the server hosts.

Therefore: `GET /upload/:id` returns metadata only; if bytes must ever be served,
they go out with `Content-Disposition: attachment`, `X-Content-Type-Options:
nosniff` and a non-renderable content type. A consumer reads the file from disk;
it never comes back over HTTP.

## 7. Consumers

| Tool | Consumes | Change needed |
|---|---|---|
| `nconvert.convert` | `path` | none — already accepts absolute paths |
| `/nconvert/upload` | — | re-implement on the shared writer; keep URL and semantics |
| `image.ingest` | `source` | none — upload root added to `agents.image.ingestRoots` (verified 2026-11-13) |
| `media.process` | `in` | fixed 2026-11-13: `in` accepts the upload root alongside storage (`out` stays storage-confined) |
| `print.render` | `path` | none |
| `forge.call` | `payload[]` | paths resolve on the main thread already |
| `notepad.attach` | `path` | none |

## 8. Failure modes

| Case | Behaviour |
|---|---|
| Client aborts mid-upload | directory removed, `400 upload aborted by the client` |
| Body over cap | `413` naming `agents.upload.maxBytes`, drain, no partial file |
| Disk below floor | `507`, nothing created |
| Empty body | `400`, nothing created |
| `filename` missing/unsafe | `400` before any directory is created |
| Wrong content-type | `400` naming `application/octet-stream` |
| Sweep vs running job | TTL floor 1 h; the handle states its expiry in the response |
| Two uploads, same name | separate `<id>` directories — collision impossible |

## 9. Open decisions

1. **Name.** ~~`/upload` vs `/handoff`~~ — resolved 2026-11-13: **`/upload`**
   (approved; `/files` is taken by the engine proxy, `/storage` by the storage
   tool).
2. **Scope of the path.** ~~storage-relative variant?~~ — resolved: **no**, one
   form, absolute, as recommended.
3. **Does an upload survive the session?** Still open, later spec: with a 24 h
   TTL, yes, by accident. If handles should die with the chat that made them,
   the chat app must send a session id and the sweeper must know about it.

## 10. Migration

1. Lift the streamed writer out of `nconvert/ui-api.js` into a shared module.
2. Add `/upload`, `/upload/:id` (GET metadata, DELETE).
3. Re-point `/nconvert/upload` at the writer, keep its response shape exactly.
4. Add the sweep; log only the count and the bytes freed.
5. Write `documentation/tools/upload.md`, link it from `tools/overview.md`, and
   add the two-line client recipe (browser `fetch`, `curl.exe --data-binary`) —
   the same one already in `documentation/tools/nconvert.md`.
