# Upload handoff — `/upload`

Bytes in, a path handle out. The server owns no MCP tool for this: it is the
HTTP front door for every path-taking tool (`nconvert.convert`, `image.ingest`,
`media.process`, `print.render`, `forge.call` payloads, `notepad.attach`). The
model never touches the payload — it receives the `path` and passes it on like
any other path. Spec: `docs/upload-handoff-spec.md`. Shared writer:
`src/upload.js` (also serves `/nconvert/upload` — one implementation, two
routes, so they cannot drift).

## Route contract

```
POST /upload?filename=<name>[&ttl=<hours>]
  Content-Type: application/octet-stream
  body: raw bytes, streamed
  → 200 { id, path, bytes, sha256, expiresAt }
```

`path` is the handle: absolute, readable by every tool, valid until
`expiresAt`. `id` exists for the sweeper and logging; consuming tools never
need it.

```
GET    /upload/:id   → metadata only, never the bytes
DELETE /upload/:id   → 200 { removed: true } | 404
```

`GET` is deliberately metadata-only: uploads are untrusted input and must never
be rendered from this origin (an uploaded `.html`/`.svg` served renderable is
stored XSS against every tool page the server hosts). A consumer reads the
file from disk.

## Where the bytes live

`<repo>/data/uploads/<id>/<sanitized-name>` — outside the storage root on
purpose (the VDB watches all of `D:\MCP_Storage`; an upload parked there would
be scanned and embedded). Filenames keep letters (incl. non-ASCII), digits,
spaces, `.`, `_`, `(`, `)`, `-`; everything else becomes `_`.

## Lifecycle

- **Streaming**: the body is written straight to disk with a counting cap —
  nothing is buffered; a 4 GB upload never becomes a 4 GB Buffer. `sha256` is
  computed in the same pass.
- **Completeness**: `meta.json` is written last. A directory without it is an
  interrupted write; the sweep removes those first.
- **Expiry**: `ttl` (hours, default 24, floor 1) → the sweep runs at startup
  and every `sweepMinutes`, deletes expired directories, and logs the count
  and bytes freed. A running tool may still hold a path when the sweep fires —
  the handle's own `expiresAt` names the deal.
- **Disk guard**: `507` before anything is created when free space on the data
  volume is below `agents.upload.minFreeGb`.

## Limits (config `agents.upload`)

| Key | Default | Enforced |
|---|---|---|
| `maxBytes` | 4294967296 (4096 MB) | while streaming → `413` naming the key; over-cap `Content-Length` → `413` before any write |
| `ttlHours` | 24 | clamped to a 1 h floor |
| `minFreeGb` | 20 | before the directory is created → `507` naming the key |
| `sweepMinutes` | 30 | sweep interval |

## Failure modes

| Case | Behaviour |
|---|---|
| Client aborts mid-upload | directory removed, `400 upload aborted by the client` |
| Body over cap | `413` naming `agents.upload.maxBytes`; body drained, not socket-reset, so the client sees the reason |
| Disk below floor | `507`, nothing created |
| Empty body | `400`, nothing left behind |
| `filename` missing/unsafe | `400` before any directory is created |
| Wrong content-type | `400` naming `application/octet-stream` |

## Client recipe

Browser (chat app):

```js
const r = await fetch(`${host}/upload?filename=deck.pptx`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
const { path } = await r.json();
```

Shell (real `curl.exe`, not the PowerShell alias):

```
curl.exe -H "Content-Type: application/octet-stream" --data-binary "@D:\deck.pptx" "http://192.168.0.100:3100/upload?filename=deck.pptx"
```

Then hand `path` to the tool: `nconvert.convert({ path })`, `print.render({ path })`,
`media.process({ in: path })`, `notepad.attach({ id, path })`, or a
`forge.call` `payload[]` entry.

## Consumers

| Tool | Input | Notes |
|---|---|---|
| `nconvert.convert` | `path` | absolute paths accepted as-is |
| `image.ingest` | `source` | upload root is in `agents.image.ingestRoots` |
| `media.process` | `in` | accepts storage paths or the upload root (`out` stays storage-confined) |
| `print.render` | `path` | absolute paths accepted as-is |
| `forge.call` | `payload[]` | resolved on the main thread |
| `notepad.attach` | `path` | absolute paths accepted as-is |

## Tests

`npm run test:upload` — boots the routes on an ephemeral port; covers the
happy path, streaming, TTL floor, sweep of expired/interrupted dirs, abort
cleanup, cap and disk guard, and the no-leftover rule for every failure mode.
