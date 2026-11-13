// Upload handoff — bytes in, a path handle out.
//
// Spec: docs/upload-handoff-spec.md. One streamed writer serves both /upload
// (generic handoff, TTL-managed) and /nconvert/upload (ingest, deleted after
// the call returns) so the two routes cannot drift on cap, cleanup or error
// behaviour. The model never touches the payload: it receives the absolute
// `path` from the uploader and passes it to tools like any other path.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Outside the storage root on purpose: the VDB watches all of D:\MCP_Storage,
// so an upload parked there becomes an indexing job nobody asked for. data/ is
// the same volume nConvert's temp copies already live on.
export const UPLOAD_ROOT = path.resolve(__dirname, '..', 'data', 'uploads');

// Directories with a write in progress. The sweeper must skip these: a
// directory has no meta.json for the whole duration of its upload, and
// meta.json is written last precisely so its presence means "complete".
const ACTIVE = new Set();

// A running tool may still hold a path when the sweep fires — the floor keeps
// the minimum usable lifetime at one hour regardless of what a client asks for.
const MIN_TTL_HOURS = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uploadLimits(config) {
    const conf = config?.agents?.upload ?? {};
    return {
        maxBytes: conf.maxBytes ?? 4 * 1024 * 1024 * 1024,
        ttlHours: conf.ttlHours ?? 24,
        minFreeGb: conf.minFreeGb ?? 20,
        sweepMinutes: conf.sweepMinutes ?? 30
    };
}

function httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function uploadName(value) {
    if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'filename query parameter is required');
    const name = path.basename(value).replace(/[^\p{L}\p{N}._ ()-]/gu, '_').trim();
    if (!name || name === '.' || name === '..') throw httpError(400, 'filename is not usable');
    return name;
}

// Free space is checked before the directory is created — a 4 GB cap with no
// disk guard is a way to fill a drive by accident, and refusing after the write
// would strand the partial bytes.
function assertDiskHeadroom(root, minFreeGb) {
    const stats = fs.statfsSync(root);
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3;
    if (freeGb < minFreeGb) {
        throw httpError(507, `insufficient disk space: ${freeGb.toFixed(1)} GB free, requires agents.upload.minFreeGb=${minFreeGb}`);
    }
}

// Streamed to disk, never buffered: at 4 GB a Buffer is a liability, and the
// cap has to bite while the bytes are still arriving rather than after the
// process has already accepted them. sha256 is folded into the same pass so a
// 4 GB file is not read a second time just to hash it.
function writeCapped(req, file, maxBytes, capMessage) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(file);
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            req.unpipe(out);
            out.destroy();
            // Reject only after the fd is released — the route's rmSync cleanup
            // runs on rejection, and on Windows an open handle makes it EBUSY.
            out.once('close', () => reject(error));
        };
        req.on('data', (chunk) => {
            hash.update(chunk);
            bytes += chunk.length;
            if (bytes > maxBytes) fail(httpError(413, capMessage));
        });
        // 'aborted' is deprecated and no longer fires on current Node — a client
        // hangup surfaces as 'close' with an incomplete message instead.
        req.on('aborted', () => fail(httpError(400, 'upload aborted by the client')));
        req.on('close', () => {
            if (!req.complete) fail(httpError(400, 'upload aborted by the client'));
        });
        req.on('error', fail);
        out.on('error', fail);
        out.on('finish', () => {
            if (settled) return;
            settled = true;
            resolve({ bytes, sha256: hash.digest('hex') });
        });
        req.pipe(out);
    });
}

// The client is still uploading a rejected body in every failure path that
// fires before the write completes. Drain it rather than destroying the
// socket: a reset mid-upload surfaces to the caller as a network error and
// hides the status code that explains what went wrong.
export function handleUploadError(req, res, error, directory) {
    if (directory) {
        // maxRetries: an fd can still be closing when we get here — the write
        // stream's 'finish' precedes its 'close'. Windows EBUSYs without this.
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    if (res.headersSent) { res.destroy(); return; }
    if (error.statusCode === 413) res.setHeader('Connection', 'close');
    res.status(error.statusCode ?? 400).json({ error: error.message });
    req.resume();
}

export async function receiveUpload(req, { root, maxBytes, capMessage, ttlHours, minFreeGb }) {
    if (!/^application\/octet-stream/i.test(req.headers['content-type'] ?? '')) {
        throw httpError(400, 'upload a non-empty file as application/octet-stream');
    }
    const filename = uploadName(req.query.filename);
    // Content-Length is untrusted — an early reject only, the counting cap
    // during streaming is what actually bounds the write.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) throw httpError(413, capMessage);

    const id = crypto.randomUUID();
    const directory = path.join(root, id);
    // Cleanup deletes recursively — the escape check has to run before the
    // write, not in a finally block where a throw would mask the result.
    if (path.dirname(directory) !== root) throw httpError(400, 'upload directory escaped its root');
    assertDiskHeadroom(root, minFreeGb);
    fs.mkdirSync(directory, { recursive: true });

    ACTIVE.add(directory);
    try {
        const file = path.join(directory, filename);
        const written = await writeCapped(req, file, maxBytes, capMessage);
        if (written.bytes === 0) throw httpError(400, 'upload a non-empty file as application/octet-stream');
        const expiresAt = new Date(Date.now() + Math.max(ttlHours ?? 24, MIN_TTL_HOURS) * 3600 * 1000).toISOString();
        // meta.json is written last, so its presence means "complete" — the
        // sweeper removes a meta-less directory as an interrupted write.
        const meta = { id, name: filename, path: file, bytes: written.bytes, sha256: written.sha256, createdAt: new Date().toISOString(), expiresAt };
        fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify(meta, null, 2));
        return { ...meta, directory };
    } catch (error) {
        // The writer owns its failure cleanup: every throw after the mkdir
        // (cap, abort, empty body) leaves no directory behind. The caller's
        // handle does not exist yet at this point — it never saw the id.
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        throw error;
    } finally {
        ACTIVE.delete(directory);
    }
}

export function readUploadMeta(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(UPLOAD_ROOT, id, 'meta.json'), 'utf8'));
    } catch {
        return null;
    }
}

export function deleteUpload(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return false;
    const directory = path.join(UPLOAD_ROOT, id);
    if (!fs.existsSync(directory)) return false;
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
}

async function dirSize(directory) {
    let total = 0;
    const entries = await fs.promises.readdir(directory, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const stats = await fs.promises.stat(path.join(entry.parentPath ?? entry.path, entry.name));
        total += stats.size;
    }
    return total;
}

async function sweep(logger) {
    let removed = 0;
    let freed = 0;
    let entries;
    try {
        entries = await fs.promises.readdir(UPLOAD_ROOT, { withFileTypes: true });
    } catch {
        return;
    }
    const now = Date.now();
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(UPLOAD_ROOT, entry.name);
        if (ACTIVE.has(directory)) continue;
        let meta = null;
        try {
            meta = JSON.parse(await fs.promises.readFile(path.join(directory, 'meta.json'), 'utf8'));
        } catch {
            // No parsable meta.json = interrupted write; remove it first.
        }
        const expired = !meta || (meta.expiresAt && Date.parse(meta.expiresAt) < now);
        if (!expired) continue;
        try {
            freed += meta?.bytes ?? await dirSize(directory);
            await fs.promises.rm(directory, { recursive: true, force: true });
            removed += 1;
        } catch (error) {
            logger.warn(`upload sweep: could not remove ${entry.name} — ${error.message}`, null, 'upload');
        }
    }
    logger.info(`upload sweep: removed ${removed} upload(s), freed ${(freed / 1048576).toFixed(1)} MB`, null, 'upload');
}

export async function initUploadRoutes(app, config, logger) {
    const limits = uploadLimits(config);
    const capMessage = `upload exceeds agents.upload.maxBytes (${limits.maxBytes} bytes)`;
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

    const parseTtl = (value) => {
        if (value === undefined) return limits.ttlHours;
        const hours = Number(value);
        if (!Number.isFinite(hours) || hours <= 0) throw httpError(400, 'ttl must be a positive number of hours');
        return hours;
    };

    app.post('/upload', async (req, res) => {
        let handle = null;
        try {
            handle = await receiveUpload(req, {
                root: UPLOAD_ROOT,
                maxBytes: limits.maxBytes,
                capMessage,
                ttlHours: parseTtl(req.query.ttl),
                minFreeGb: limits.minFreeGb
            });
            res.json({ id: handle.id, path: handle.path, bytes: handle.bytes, sha256: handle.sha256, expiresAt: handle.expiresAt });
        } catch (error) {
            handleUploadError(req, res, error, handle?.directory);
        }
    });

    // Metadata only, never the bytes: uploads are untrusted input and must
    // never be rendered from this origin (stored XSS against the tool pages).
    app.get('/upload/:id', (req, res) => {
        const meta = readUploadMeta(req.params.id);
        if (!meta) { res.status(404).json({ error: `upload not found: ${req.params.id}` }); return; }
        res.json({ id: meta.id, name: meta.name, path: meta.path, bytes: meta.bytes, sha256: meta.sha256, createdAt: meta.createdAt, expiresAt: meta.expiresAt });
    });

    app.delete('/upload/:id', (req, res) => {
        try {
            if (!deleteUpload(req.params.id)) { res.status(404).json({ error: `upload not found: ${req.params.id}` }); return; }
            res.json({ removed: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // The startup sweep is awaited so expired/interrupted uploads are gone
    // before the routes serve their first request.
    await sweep(logger);
    const timer = setInterval(() => {
        sweep(logger).catch((error) => logger.error(`upload sweep failed: ${error.message}`, error, 'upload'));
    }, limits.sweepMinutes * 60 * 1000);
    timer.unref();

    return {
        shutdown() { clearInterval(timer); }
    };
}
