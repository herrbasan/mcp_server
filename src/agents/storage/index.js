import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { createProgressReporter } from '../../utils/progress-reporter.js';
import { createTranslatorFromConfig } from './path-translator.js';
import { createFileOps } from '../../lib/fileops.js';
import { requireFields } from '../../utils/require-fields.js';
import { searchDocuments } from '../vdb/index.js';
import * as resources from './resource-provider.js';

const logger = getLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const DEFAULTS = {
    root: 'data/storage',
    maxReadSize: 10 * 1024 * 1024,
    maxWriteSize: 100 * 1024 * 1024
};

let STORAGE_ROOT;
let CONFIG;
let TRANSLATOR;  // null when no uncShare is configured — pass-through mode
let OPS;          // createFileOps engine — copy, append, readWindow, grep, batch

// Threshold above which storage_read returns a URL pointer instead of inline
// content. The MCP transport chokes on large inline responses (chat-app side
// hits "MCP stream ended without response" around 400 KB). Below the threshold
// the response is small enough to fit; above it, the LLM fetches via HTTP.
const INLINE_BYTE_LIMIT = 64 * 1024;

function initConfig(agentConfig) {
    if (!agentConfig) throw new Error('storage.init: agentConfig is required');
    const root = agentConfig.root ?? DEFAULTS.root;
    if (!root) throw new Error('storage.init: agentConfig.root is required');
    STORAGE_ROOT = path.resolve(PROJECT_ROOT, root);
    CONFIG = {
        maxReadSize: agentConfig.maxReadSize ?? DEFAULTS.maxReadSize,
        maxWriteSize: agentConfig.maxWriteSize ?? DEFAULTS.maxWriteSize
    };
    TRANSLATOR = createTranslatorFromConfig(agentConfig);
    if (TRANSLATOR) {
        logger.info(`[Storage] UNC translator active: ${TRANSLATOR.uncShare} ↔ ${TRANSLATOR.localRoot}`, null, 'Storage');
    }
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
    OPS = createFileOps({
        root: STORAGE_ROOT,
        translator: TRANSLATOR
    });
}

function safeResolve(userPath) {
    if (typeof userPath !== 'string') throw new Error(`Path must be a string: ${userPath}`);
    // Translate UNC form of the storage share to the local form BEFORE
    // path.resolve — otherwise UNC segments get appended as nested directories
    // inside the storage root (silent corruption).
    const normalized = TRANSLATOR ? TRANSLATOR.toLocal(userPath) : userPath;
    const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(STORAGE_ROOT, normalized);
    const realRoot = fs.realpathSync(STORAGE_ROOT);

    // Walk up from resolved path until we hit an existing ancestor, realpath it,
    // then reconstruct the rest. This allows safeResolve to work for not-yet-created
    // paths (e.g. test/hello.md before test/ exists) while still catching symlink escapes.
    let check = resolved;
    const suffix = [];
    while (check !== path.dirname(check)) {
        if (fs.existsSync(check)) break;
        suffix.unshift(path.basename(check));
        check = path.dirname(check);
    }
    if (!fs.existsSync(check)) {
        throw new Error(`Storage root does not exist: ${realRoot}`);
    }
    const realBase = fs.realpathSync(check);
    const realTarget = path.join(realBase, ...suffix);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        throw new Error(`Path escapes storage root: ${userPath}`);
    }
    return realTarget;
}

function safeRel(userPath) {
    return path.relative(PROJECT_ROOT, safeResolve(userPath));
}

const TEXT_MIME = {
    '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
    '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.xml': 'text/xml',
    '.yaml': 'text/yaml', '.yml': 'text/yaml', '.html': 'text/html', '.htm': 'text/html',
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.log': 'text/plain', '.sql': 'text/plain'
};

function guessMime(p) {
    const ext = path.extname(p).toLowerCase();
    return TEXT_MIME[ext] || 'application/octet-stream';
}

// Normalize root-path probes: LLMs often try "/" or "\\" which on Windows
// resolve as absolute drive root and fail confinement. Map them to "" (storage
// root). Also strip LEADING slashes from subpaths ("/docs" → "docs") — without
// this, path.resolve treats the input as absolute, the ancestor-walk in
// safeResolve fails with "cannot find existing ancestor" on Windows drive roots.
function normPath(userPath) {
    if (!userPath) return '';
    // Root aliases: "/", "\\", "*", "/*" all mean the storage root itself.
    // "*" is included because LLMs often probe with it as a wildcard.
    if (/^[/*\\]+$/.test(userPath)) return '';
    return userPath.replace(/^[/\\]+/, '');
}

function toMcp(ok, data) {
    const text = JSON.stringify({ ok, ...data }, null, 2);
    return { content: [{ type: 'text', text }] };
}

function result(ok, op, userPath, data) {
    return toMcp(ok, { op, path: userPath, ...data });
}

// Self-verification: after a mutating op, re-stat the file straight from disk
// and check it matches what the engine claims. Returns { verified:true, size,
// mtime } as evidence the caller can trust without a second read. A mismatch
// means the response would be a lie — throw instead (fail loud, no ok:true
// for a write that didn't land).
function verifyFile(userPath, expectedSize) {
    const abs = safeResolve(userPath);
    const st = fs.statSync(abs); // throws ENOENT if the file is missing
    if (!st.isFile()) throw new Error(`storage verify failed: not a file after write: "${userPath}"`);
    if (expectedSize !== undefined && st.size !== expectedSize) {
        throw new Error(`storage verify failed: size mismatch for "${userPath}" (expected ${expectedSize}B, disk has ${st.size}B)`);
    }
    return { verified: true, size: st.size, mtime: st.mtime.toISOString() };
}

// Counterpart for delete/move-source: assert the path is GONE from disk.
function verifyGone(userPath) {
    const abs = safeResolve(userPath);
    if (fs.existsSync(abs)) {
        throw new Error(`storage verify failed: path still exists after delete/move: "${userPath}"`);
    }
    return { verified: true };
}

export async function init(context) {
    const agentConfig = context.config?.agents?.storage;
    if (!agentConfig) throw new Error('storage.init: context.config.agents.storage is required — missing from config.json');
    initConfig(agentConfig);

    // NOTE: the storage agent deliberately does NOT stamp a host into pointer
    // responses. Large-file reads return a RELATIVE path (/storage/...); the
    // client prepends its own MCP origin. The server cannot know how each
    // client reaches it (LAN IP, dyndns, localhost), so it never guesses.

    // Initialize the MCP resource provider so resources/list and resources/read work.
    resources.initResourceProvider({
        storageRoot: STORAGE_ROOT,
        translator: TRANSLATOR,
        inlineByteLimit: INLINE_BYTE_LIMIT
    });

    // ── REST API ─────────────────────────────────────────────────────
    const app = context.app;
    if (app) {
        const mimeMap = {
            '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
            '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain',
            '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
            '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
            '.pdf': 'application/pdf', '.xml': 'application/xml',
            '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
        };

        // GET /storage — list root directory
        app.get('/storage', (_req, res) => {
            const entries = fs.readdirSync(STORAGE_ROOT, { withFileTypes: true });
            res.json({
                path: '/',
                entries: entries.map(e => ({
                    name: e.name,
                    type: e.isDirectory() ? 'dir' : 'file'
                }))
            });
        });

        // GET /storage/* — serve file content (middleware catches all sub-paths)
        // Method guard: only handle GET/HEAD, pass through PUT etc. to the next handler.
        app.use('/storage', (req, res, next) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            const urlPath = req.path.replace(/^\//, '');
            if (!urlPath || urlPath === '/') return next(); // let /storage itself fall through
            let target;
            try {
                target = safeResolve(urlPath);
            } catch (err) {
                return res.status(403).json({ error: err.message });
            }
            if (!fs.existsSync(target)) return res.status(404).json({ error: `Not found: "${urlPath}"` });

            const stat = fs.statSync(target);
            if (stat.isDirectory()) {
                const entries = fs.readdirSync(target, { withFileTypes: true });
                return res.json({
                    path: '/' + urlPath,
                    entries: entries.map(e => ({
                        name: e.name,
                        type: e.isDirectory() ? 'dir' : 'file',
                        size: e.isFile() ? fs.statSync(path.join(target, e.name)).size : undefined
                    }))
                });
            }

            const ext = path.extname(urlPath).toLowerCase();
            const mime = mimeMap[ext] || 'application/octet-stream';
            res.set('Content-Type', mime);
            fs.createReadStream(target).pipe(res);
        });

        // PUT /storage/* — upload raw binary body to a path.
        // Accepts any Content-Type. The body is streamed to a temp file then
        // atomically renamed (crash-safe). No base64, no JSON wrapping —
        // just raw bytes over HTTP, bypassing MCP JSON-RPC transport limits.
        // Uses app.use (not app.put) because Express 5 / path-to-regexp
        // rejects the '*' wildcard in route paths. We gate on req.method inside.
        app.use('/storage', (req, res, next) => {
            if (req.method !== 'PUT') return next();
            const urlPath = req.path.replace(/^\//, '');
            if (!urlPath || urlPath === '/') {
                return res.status(400).json({ error: 'PUT /storage requires a file path' });
            }
            let target;
            try {
                target = safeResolve(urlPath);
            } catch (err) {
                return res.status(403).json({ error: err.message });
            }

            // Ensure the parent directory exists — the writeStream below fails
            // with ENOENT when the path has a subdirectory (e.g. sessions/foo.json
            // when sessions/ doesn't exist yet). Creates the tree on demand.
            fs.mkdirSync(path.dirname(target), { recursive: true });

            // Stream the request body to a temp file, then rename atomically.
            const tmp = target + '.upload-' + Date.now() + '-' + process.pid;
            const writeStream = fs.createWriteStream(tmp);
            let bytesReceived = 0;

            req.on('data', (chunk) => {
                bytesReceived += chunk.length;
                if (bytesReceived > CONFIG.maxWriteSize) {
                    req.destroy();
                    writeStream.destroy();
                    try { fs.unlinkSync(tmp); } catch (_) { /* already cleaned up */ }
                    res.status(413).json({
                        error: `Upload exceeds maxWriteSize (${bytesReceived} > ${CONFIG.maxWriteSize})`
                    });
                }
            });
            writeStream.on('error', (err) => {
                try { fs.unlinkSync(tmp); } catch (_) { /* tmp may not exist */ }
                if (!res.headersSent) {
                    res.status(500).json({ error: `Write failed: ${err.message}` });
                }
            });
            req.pipe(writeStream);
            writeStream.on('finish', () => {
                fs.rename(tmp, target, (err) => {
                    if (err) {
                        try { fs.unlinkSync(tmp); } catch (_) { /* tmp may not exist */ }
                        if (!res.headersSent) {
                            res.status(500).json({ error: `Rename failed: ${err.message}` });
                        }
                        return;
                    }
                    const stat = fs.statSync(target);
                    logger.info(`[Storage] PUT /storage/${urlPath} (${stat.size}B)`, null, 'Storage');
                    res.json({
                        ok: true,
                        path: '/' + urlPath,
                        size: stat.size,
                        content_type: req.headers['content-type'] || 'application/octet-stream'
                    });
                });
            });
        });
    }

    return {
        root: STORAGE_ROOT,
        resources: {
            listResources: resources.listResources,
            listResourceTemplates: resources.listResourceTemplates,
            readResource: resources.readResource,
            subscribeResource: resources.subscribeResource
        }
    };
}

export async function storage_stat(args) {
    // Path optional — defaults to the storage root (issue #18 pattern).
    const userPath = normPath(args.path ?? '');
    logger.info(`[Storage] storage_stat: "${userPath}"`, null, 'Storage');
    const st = await OPS.stat(userPath);
    if (!st.exists) {
        logger.info(`[Storage] storage_stat OK: "${userPath}" (not found)`, null, 'Storage');
        return result(true, 'storage_stat', userPath, { exists: false });
    }
    logger.info(`[Storage] storage_stat OK: "${userPath}" (${st.type}, ${st.size}B)`, null, 'Storage');
    return result(true, 'storage_stat', userPath, {
        exists: true,
        type: st.type,
        size: st.size,
        modified: new Date(st.modified).toISOString()
    });
}

export async function storage_read(args) {
    requireFields(args, ['path'], 'storage_read');
    const userPath = args.path;
    logger.info(`[Storage] storage_read: "${userPath}"`, { encoding: args.encoding }, 'Storage');

    // Windowed read: delegate to OPS.readWindow when any window arg is present.
    // Window params are mutually exclusive: offset+length, head, or tail.
    const hasWindow = args.offset !== undefined || args.length !== undefined ||
                      args.head !== undefined || args.tail !== undefined;
    if (hasWindow) {
        const windowArgs = ['offset', 'length', 'head', 'tail'].filter(k => args[k] !== undefined);
        const hasOffsetLength = args.offset !== undefined || args.length !== undefined;
        const hasHeadTail = args.head !== undefined || args.tail !== undefined;
        if (hasOffsetLength && hasHeadTail) {
            throw new Error(`storage_read: window params are mutually exclusive — pass EITHER offset+length OR head OR tail, not both. (received: ${windowArgs.join(', ')})`);
        }
        if (args.offset !== undefined && args.length === undefined) {
            throw new Error('storage_read: offset requires length — pass both together for a byte window. (If you want lines, use head or tail instead.)');
        }
        const wResult = await OPS.readWindow(userPath, {
            offset: args.offset,
            length: args.length,
            head: args.head,
            tail: args.tail
        });
        // Raw-text window: return the content verbatim, NOT wrapped in a JSON
        // envelope. Enveloped content reaches LLM clients as one JSON-escaped
        // line, which line-based file readers truncate (issue #12). Plain text
        // pages as readable content.txt. Pointer/metadata responses stay JSON —
        // a plain-text result IS the requested window.
        if (typeof wResult.content === 'string') {
            return { content: [{ type: 'text', text: wResult.content }] };
        }
        logger.info(`[Storage] storage_read OK: "${userPath}" (windowed, ${wResult.size}B)`, null, 'Storage');
        return result(true, 'storage_read', userPath, wResult);
    }

    const encoding = args.encoding || 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') {
        throw new Error(`storage_read: invalid encoding "${encoding}" — must be "utf8" or "base64"`);
    }
    const target = safeResolve(userPath);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
        throw new Error('storage_read: cannot read a directory');
    }
    if (stat.size > CONFIG.maxReadSize) {
        return result(true, 'storage_read', userPath, {
            truncated: true,
            size: stat.size,
            pointer: safeRel(userPath),
            note: `File exceeds maxReadSize (${stat.size} > ${CONFIG.maxReadSize}). Use the REST endpoint or chunk via offset/length.`
        });
    }
    const content = fs.readFileSync(target, encoding === 'base64' ? undefined : 'utf8');
    const out = encoding === 'base64' ? content.toString('base64') : content;
    logger.info(`[Storage] storage_read OK: "${userPath}" (${stat.size}B, ${encoding})`, null, 'Storage');

    // Files above the inline threshold are NOT inlined. The MCP transport
    // chokes on large responses (chat-app client hits "MCP stream ended without
    // response" around 400 KB). Instead, return a URL pointer to the existing
    // HTTP endpoint, which serves the file via streaming createReadStream.
    // The LLM fetches via fetch_webpage (or any HTTP fetch primitive the chat
    // client supports).
    if (stat.size > INLINE_BYTE_LIMIT) {
        const urlPath = userPath.replace(/\\/g, '/');
        // Return a RELATIVE path, not an absolute URL. The server cannot know
        // how each client reaches it (LAN IP, dyndns, localhost), so it does
        // not stamp a host. The client prepends its own base — the address it
        // already uses for MCP — and fetches it. No rewriting, no guessing.
        const path = `/storage/${encodeURI(urlPath)}`;
        const response = {
            size: stat.size,
            inline: false,
            path,
            encoding,
            nextStep: `Fetch the file over HTTP: prepend your MCP server origin to "path" and pass the full URL to your fetch tool (e.g. browser_fetch). The HTTP endpoint streams the file, bypassing the MCP transport-size limit.`,
            note: 'File is above the inline size threshold. Chunked alternative: call storage_read again with offset+length to page through the file in MCP-sized windows.'
        };
        return result(true, 'storage_read', userPath, response);
    }
    // Raw-text return (utf8): the file content IS the tool result, verbatim,
    // with no JSON envelope. Enveloped content reaches LLM clients as a single
    // JSON-escaped line that line-based readers truncate at ~2000 chars
    // (issue #12). Plain text pages as readable content.txt and survives.
    // Discrimination rule: plain text = the complete file; a JSON object with
    // inline:false / truncated:true = pointer to fetch or window args to retry.
    // base64 keeps the envelope — it has no newlines to preserve and is
    // consumed programmatically, not read by line-based tools.
    if (encoding === 'utf8') {
        return { content: [{ type: 'text', text: out }] };
    }
    return result(true, 'storage_read', userPath, { content: out, encoding, size: stat.size, inline: true });
}

export async function storage_write(args) {
    const t0 = Date.now();
    requireFields(args, ['path', 'content'], 'storage_write');
    const userPath = args.path;
    const content = args.content;
    logger.info(`[Storage] storage_write: "${userPath}" (${content?.length || 0} chars)`, null, 'Storage');
    const encoding = args.encoding || 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') {
        throw new Error(`storage_write: invalid encoding "${encoding}" — must be "utf8" or "base64"`);
    }
    const buffer = encoding === 'base64'
        ? Buffer.from(content, 'base64')
        : Buffer.from(content, 'utf8');
    if (buffer.length > CONFIG.maxWriteSize) {
        throw new Error(`storage_write: content exceeds maxWriteSize (${buffer.length} > ${CONFIG.maxWriteSize})`);
    }
    // Route through the engine: versions the prior content, writes atomically
    // (temp+rename). overwrite:true here preserves the historical silent-overwrite
    // contract of storage_write while gaining snapshot + crash-safe write.
    const engineResult = await OPS.write(userPath, content, { encoding, overwrite: true });
    const proof = verifyFile(userPath, engineResult.size);
    logger.info(`[Storage] storage_write OK: "${userPath}" (${engineResult.size}B, verified, total=${Date.now() - t0}ms)`, null, 'Storage');
    return result(true, 'storage_write', userPath, { size: engineResult.size, ...proof });
}

export async function storage_list(args) {
    const userPath = normPath(args.path ?? '');
    const recursive = args.recursive || false;
    const detail = args.detail ?? 'compact';
    if (detail !== 'compact' && detail !== 'full') {
        throw new Error(`storage_list: invalid detail "${detail}" — must be "compact" or "full"`);
    }
    logger.info(`[Storage] storage_list: "${userPath}"`, { recursive, detail }, 'Storage');
    const st = await OPS.stat(userPath);
    if (!st.exists || st.type !== 'dir') {
        throw new Error('storage_list: path is not a directory');
    }
    const { entries } = await OPS.list(userPath, { recursive });
    // Normalize modified to ISO string to preserve the legacy response shape.
    // Flag directories that carry an Agents.md briefing so callers know where
    // directory-specific instructions live (Windows fs is case-insensitive, so
    // one probe covers Agents.md / agents.md).
    const normalized = entries.map(e => {
        const out = { ...e, modified: new Date(e.modified).toISOString() };
        if (e.type === 'dir' && fs.existsSync(safeResolve(userPath ? `${userPath}/${e.name}/Agents.md` : `${e.name}/Agents.md`))) {
            out.hasAgents = true;
        }
        return out;
    });
    logger.info(`[Storage] storage_list OK: "${userPath}" (${normalized.length} entries, ${detail})`, null, 'Storage');

    if (detail === 'full') {
        return result(true, 'storage_list', userPath, { entries: normalized });
    }

    // ---- compact render: one line per entry, human sizes, ✓ = has Agents.md ----
    const MAX_ENTRIES = 2000;
    const truncated = normalized.length > MAX_ENTRIES;
    const shown = truncated ? normalized.slice(0, MAX_ENTRIES) : normalized;
    const nDirs = shown.filter(e => e.type === 'dir').length;
    const nFiles = shown.length - nDirs;
    const totalBytes = shown.reduce((s, e) => s + (e.size || 0), 0);
    const human = (n) => {
        if (n < 1024) return `${n}B`;
        const units = ['K', 'M', 'G'];
        let v = n, i = -1;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v >= 10 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
    };
    const lines = [
        `${userPath || '.'}/ — ${nFiles} file(s), ${nDirs} dir(s), ${human(totalBytes)} total${truncated ? ` — TRUNCATED at ${MAX_ENTRIES} of ${normalized.length} entries` : ''} (detail:'full' for JSON with timestamps)`
    ];
    if (!recursive) {
        // shallow: dirs first, then files — name alone suffices (parent known)
        const sorted = [...shown].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        for (const e of sorted) {
            lines.push(e.type === 'dir'
                ? `d${e.hasAgents ? '✓' : ' '} ${e.name}/`
                : `f   ${human(e.size).padStart(6)} ${e.name}`);
        }
    } else {
        // recursive flat: group by parent directory, header per group —
        // keeps full paths visible without repeating them per entry
        const sorted = [...shown].sort((a, b) => a.path.localeCompare(b.path));
        let curParent = null;
        for (const e of sorted) {
            const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
            if (parent !== curParent) { curParent = parent; lines.push(`== ${parent || userPath || '.'} ==`); }
            lines.push(e.type === 'dir'
                ? `d${e.hasAgents ? '✓' : ' '} ${e.name}/`
                : `f   ${human(e.size).padStart(6)} ${e.name}`);
        }
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
}

export async function storage_move(args) {
    requireFields(args, ['from', 'to'], 'storage_move');
    const fromPath = args.from;
    const toPath = args.to;
    logger.info(`[Storage] storage_move: "${fromPath}" → "${toPath}"`, null, 'Storage');
    // Engine refuses overwrite and snapshots the source before moving.
    const engineResult = await OPS.move(fromPath, toPath);
    const gone = verifyGone(fromPath);
    const proof = engineResult.type === 'file' ? verifyFile(toPath) : { verified: fs.existsSync(safeResolve(toPath)) };
    logger.info(`[Storage] storage_move OK: "${fromPath}" → "${toPath}" (${engineResult.type}, verified)`, null, 'Storage');
    return result(true, 'storage_move', `${fromPath} -> ${toPath}`, { from: engineResult.from, to: engineResult.to, type: engineResult.type, ...gone, ...proof });
}

export async function storage_delete(args) {
    requireFields(args, ['path'], 'storage_delete');
    const userPath = args.path;
    logger.info(`[Storage] storage_delete: "${userPath}"`, { recursive: args.recursive, trash: args.trash }, 'Storage');
    const st = await OPS.stat(userPath);
    if (!st.exists) throw new Error(`storage_delete: path does not exist: "${userPath}"`);

    // SOFT DELETE: move to <root>/_trash/<timestamp>/<original-path> instead of
    // destroying. Reversible via storage_restore. Rejected inside _trash itself.
    if (args.trash) {
        const norm = normPath(userPath);
        if (norm === '_trash' || norm.startsWith('_trash/')) {
            throw new Error('storage_delete: path is already in _trash — use storage_delete without trash:true to destroy permanently, or storage_restore to bring it back');
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const trashPath = `_trash/${stamp}/${norm}`;
        fs.mkdirSync(path.dirname(safeResolve(trashPath)), { recursive: true });
        await OPS.move(norm, trashPath);
        const proof = verifyGone(norm);
        logger.info(`[Storage] storage_delete(trash) OK: "${userPath}" → "${trashPath}"`, null, 'Storage');
        return result(true, 'storage_delete', userPath, { trashed: true, trashPath, originalPath: norm, ...proof, restorableVia: `storage_restore {path:"${trashPath}"}` });
    }

    const recursive = args.recursive || false;
    // Engine snapshots before deleting; non-empty dir requires recursive:true.
    await OPS.remove(userPath, { recursive });
    const proof = verifyGone(userPath);
    logger.info(`[Storage] storage_delete OK: "${userPath}" (${st.type}, verified gone)`, null, 'Storage');
    return result(true, 'storage_delete', userPath, { deleted: true, ...proof });
}

// Restore a trashed item to its original location. Works off the
// _trash/<timestamp>/<original-path> layout: the path segment AFTER the
// timestamp folder IS the original path. Collision at destination → suffixed.
export async function storage_restore(args) {
    requireFields(args, ['path'], 'storage_restore');
    const trashPath = normPath(args.path);
    logger.info(`[Storage] storage_restore: "${trashPath}"`, null, 'Storage');
    const parts = trashPath.split('/');
    if (parts.length < 3 || parts[0] !== '_trash') {
        throw new Error('storage_restore: path must be inside _trash with the layout _trash/<timestamp>/<original-path> (get such paths from storage_delete trash:true or storage_list _trash/ recursive)');
    }
    const originalPath = parts.slice(2).join('/');
    const st = await OPS.stat(trashPath);
    if (!st.exists) throw new Error(`storage_restore: path does not exist: "${trashPath}"`);
    let dest = originalPath;
    if (fs.existsSync(safeResolve(dest))) {
        dest = `${dest}.restored-${Date.now()}`;
        logger.warn(`[Storage] storage_restore: destination exists, restoring as "${dest}"`, null, 'Storage');
    }
    fs.mkdirSync(path.dirname(safeResolve(dest)), { recursive: true });
    await OPS.move(trashPath, dest);
    const proof = st.type === 'file' ? verifyFile(dest) : { verified: fs.existsSync(safeResolve(dest)) };
    logger.info(`[Storage] storage_restore OK: "${trashPath}" → "${dest}"`, null, 'Storage');
    return result(true, 'storage_restore', trashPath, { restored: true, originalPath: dest, ...proof });
}

// "What was recently worked on?" — N most recently modified files under a path.
// Walks the tree (engine SKIP_DIRS already excludes noise like node_modules),
// sorts by mtime desc. Ignores the VDB index and forge outputs by default via
// ignoreDirs (caller can override with []).
const RECENT_DEFAULT_IGNORES = ['nvdb', 'forge', 'temp', '_trash'];
export async function storage_recent(args) {
    const userPath = normPath(args.path ?? '');
    const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
    const ignoreDirs = args.ignoreDirs ?? RECENT_DEFAULT_IGNORES;
    logger.info(`[Storage] storage_recent: "${userPath}" limit=${limit}`, { ignoreDirs }, 'Storage');
    const { entries } = await OPS.list(userPath, { recursive: true });
    const ignore = new Set(ignoreDirs);
    const recent = entries
        .filter(e => e.type === 'file')
        .filter(e => !e.path.split('/').some(seg => ignore.has(seg)))
        .sort((a, b) => b.modified - a.modified)
        .slice(0, limit)
        .map(e => ({ path: e.path, size: e.size, modified: new Date(e.modified).toISOString() }));
    const lines = recent.map(e => `${e.modified.slice(0, 16).replace('T', ' ')}  ${String(e.size).padStart(8)}B  ${e.path}`);
    logger.info(`[Storage] storage_recent OK: "${userPath}" (${recent.length} file(s))`, null, 'Storage');
    if (recent.length === 0) return { content: [{ type: 'text', text: `No files found under "${userPath || 'storage root'}".` }] };
    return { content: [{ type: 'text', text: [
        `Recently modified files under ${userPath || 'storage root'} (newest first, ${recent.length} of ${entries.length} entries scanned):`,
        ...lines
    ].join('\n') }] };
}

export async function storage_search(args, context) {
    requireFields(args, ['query'], 'storage_search');
    const { query, folder, extension, top_k = 10, include_content = false } = args;
    logger.info(`[Storage] storage_search: "${query}"`, { folder, extension, top_k }, 'Storage');

    const pr = createProgressReporter(context?.progress);
    const results = await searchDocuments({
        query,
        collections: ['storage'],
        folder,
        extension,
        top_k,
        include_content,
        onProgress: (msg, pct) => pr.set(msg, pct)
    });
    pr.done('Search complete');

    const formatted = results.map(r => {
        const line = `[${r.path}] score: ${r.score.toFixed(4)}${r.folder ? ` folder:${r.folder}` : ''}`;
        if (include_content && r.content) {
            return `${line}\n--- snippet ---\n${r.content.slice(0, 500)}${r.content.length > 500 ? '...' : ''}`;
        }
        return line;
    }).join('\n\n');

    return {
        content: [{
            type: 'text',
            text: `Storage search results (${results.length}):\n\n${formatted || 'No matches.'}\n\nRaw results:\n${JSON.stringify(results, null, 2)}`
        }]
    };
}

// ── MCP Resource bridge tools ────────────────────────────────────────────────
// These expose the MCP Resource provider as regular tools so clients that only
// support tools/call (like this chat environment's compact MCP wrapper) can
// still discover and read resources. The implementation delegates to the same
// provider used by the native resources/* JSON-RPC methods.

function getResourceProvider() {
    if (!resources) throw new Error('storage resource provider is not available');
    return resources;
}

export async function storage_resources_list(args) {
    const provider = getResourceProvider();
    const listResult = provider.listResources(args || {});
    logger.info(`[Storage] storage_resources_list: ${listResult.resources.length} resources`, { hasNextCursor: !!listResult.nextCursor }, 'Storage');
    return result(true, 'storage_resources_list', '', listResult);
}

export async function storage_resources_read(args) {
    const provider = getResourceProvider();
    requireFields(args, ['uri'], 'storage_resources_read');
    const { uri, encoding } = args;
    const contents = provider.readResource({ uri, encoding });
    logger.info(`[Storage] storage_resources_read: "${uri}" (${contents.length} content item(s))`, null, 'Storage');
    return result(true, 'storage_resources_read', uri, { contents });
}

export async function storage_resources_templates(args) {
    const provider = getResourceProvider();
    const resourceTemplates = provider.listResourceTemplates();
    logger.info(`[Storage] storage_resources_templates: ${resourceTemplates.length} template(s)`, null, 'Storage');
    return result(true, 'storage_resources_templates', '', { resourceTemplates });
}

// ── fileops-bridged tools ───────────────────────────────────────────────────
// These delegate to the OPS engine (createFileOps). Each follows the existing
// house pattern: validate required args (throw if missing), log, call engine,
// wrap via result(). Engine errors propagate — no try/catch wrapping.

export async function storage_copy(args) {
    requireFields(args, ['from', 'to'], 'storage_copy');
    const { from, to, overwrite } = args;
    logger.info(`[Storage] storage_copy: "${from}" → "${to}"`, null, 'Storage');
    const engineResult = await OPS.copy(from, to, { overwrite: !!overwrite });
    // engineResult.size is only set for file copies; directory copies verify existence only.
    const proof = engineResult.size !== undefined ? verifyFile(to, engineResult.size) : { verified: fs.existsSync(safeResolve(to)) };
    logger.info(`[Storage] storage_copy OK: "${from}" → "${to}" (${engineResult.size ?? 'dir'}B, verified)`, null, 'Storage');
    return result(true, 'storage_copy', `${from} -> ${to}`, { ...engineResult, ...proof });
}

export async function storage_append(args) {
    requireFields(args, ['path', 'content'], 'storage_append');
    const { path: userPath, content, encoding } = args;
    logger.info(`[Storage] storage_append: "${userPath}" (${content?.length || 0} chars)`, null, 'Storage');
    const engineResult = await OPS.append(userPath, content, { encoding });
    const proof = verifyFile(userPath, engineResult.size);
    logger.info(`[Storage] storage_append OK: "${userPath}" (total=${engineResult.size}B, verified)`, null, 'Storage');
    return result(true, 'storage_append', userPath, { size: engineResult.size, ...proof });
}

export async function storage_replace(args) {
    // Alias support: LLMs coming from other editors (oldString/newString) get
    // their reasonable guess honored instead of a bare "marker is required".
    requireFields(args, ['path'], 'storage_replace');
    const userPath = args.path;
    const marker = args.marker ?? args.oldString;
    const replacement = args.replacement ?? args.newString;
    const { occurrence } = args;
    logger.info(`[Storage] storage_replace: "${userPath}" occurrence=${occurrence ?? 'first'}`, null, 'Storage');
    if (marker === undefined || marker === null) {
        throw new Error('storage_replace: args.marker is required (the exact string to find; alias: oldString). Replacement arg is "replacement" (alias: newString).');
    }
    if (replacement === undefined || replacement === null) {
        throw new Error('storage_replace: args.replacement is required (the string to swap in; alias: newString). Find arg is "marker" (alias: oldString).');
    }
    const engineResult = await OPS.replace(userPath, marker, replacement, { occurrence });
    const proof = verifyFile(userPath, engineResult.size);
    logger.info(`[Storage] storage_replace OK: "${userPath}" (${engineResult.replacements} replacement(s), ${engineResult.size}B, verified)`, null, 'Storage');
    return result(true, 'storage_replace', userPath, { ...engineResult, ...proof });
}

export async function storage_find(args) {
    // Path optional — defaults to the storage root; directories are scanned
    // recursively (all text files under the tree are probed).
    const userPath = normPath(args.path ?? '');
    const marker = args.marker ?? args.oldString ?? args.pattern;
    const { occurrence } = args;
    logger.info(`[Storage] storage_find: "${userPath}"`, null, 'Storage');
    if (marker === undefined || marker === null) {
        throw new Error('storage_find: args.marker is required (the exact string to locate; aliases: oldString, pattern)');
    }
    const engineResult = await OPS.find(userPath, marker, { occurrence });
    logger.info(`[Storage] storage_find OK: "${userPath}" found=${engineResult.found}`, null, 'Storage');
    return result(true, 'storage_find', userPath, engineResult);
}

export async function storage_grep(args, context) {
    // path defaults to the storage root (issue #18)
    const userPath = normPath(args.path ?? '');
    const pattern = args.pattern;
    if (!pattern) throw new Error('storage_grep: args.pattern is required (JavaScript regex)');
    const { maxMatches, context: ctxLines, ignoreCase } = args;
    logger.info(`[Storage] storage_grep: "${userPath}" pattern="${pattern}"`, null, 'Storage');
    const pr = createProgressReporter(context?.progress);
    const engineResult = await OPS.grep(userPath, pattern, {
        maxMatches,
        context: ctxLines,
        ignoreCase,
        onProgress: (done, total, msg) => pr.step(done, total, msg, 10, 90)
    });
    pr.done('Search complete');
    logger.info(`[Storage] storage_grep OK: "${userPath}" (${engineResult.matches.length} match(es))`, null, 'Storage');
    return result(true, 'storage_grep', userPath, { matches: engineResult.matches, truncated: engineResult.truncated });
}

export async function storage_batch(args, context) {
    const { ops, onError } = args;
    logger.info(`[Storage] storage_batch: ${ops?.length || 0} op(s)`, null, 'Storage');
    if (!ops || !Array.isArray(ops) || ops.length === 0) {
        throw new Error('storage_batch: args.ops must be a non-empty array');
    }
    const pr = createProgressReporter(context?.progress);
    const engineResult = await OPS.batch(ops, {
        onError,
        onProgress: (done, total, msg) => pr.step(done, total, msg, 10, 90)
    });
    pr.done('Batch complete');
    logger.info(`[Storage] storage_batch OK: ${engineResult.results.length} result(s)`, null, 'Storage');
    return result(true, 'storage_batch', '', { results: engineResult.results });
}

// ── Bulk archive tools ───────────────────────────────────────────────
// The arena-archive-style workflows write MANY files. One call per file
// costs the LLM a round trip + generation per file (~15s each). These tools
// collapse N calls into 1 so the server does the whole archive in ms.

export async function storage_import(args, context) {
    const { files } = args;
    logger.info(`[Storage] storage_import: ${files?.length || 0} file(s)`, null, 'Storage');
    if (!files || !Array.isArray(files) || files.length === 0) {
        throw new Error('storage_import: args.files must be a non-empty array of {path, content}');
    }
    // Validate all entries up front — fail loud before touching the disk.
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f || typeof f !== 'object') throw new Error(`storage_import: files[${i}] must be an object`);
        if (!f.path) throw new Error(`storage_import: files[${i}].path is required`);
        if (f.content === undefined || f.content === null) throw new Error(`storage_import: files[${i}].content is required`);
        const encoding = f.encoding || 'utf8';
        if (encoding !== 'utf8' && encoding !== 'base64') {
            throw new Error(`storage_import: files[${i}].encoding must be "utf8" or "base64"`);
        }
    }

    const pr = createProgressReporter(context?.progress);
    // Reuse the engine's batch with write ops — same atomic/versioned path
    // as storage_write, one snapshot per file.
    const ops = files.map(f => ({
        op: 'write',
        path: f.path,
        content: f.content,
        encoding: f.encoding || 'utf8',
        overwrite: true
    }));

    const engineResult = await OPS.batch(ops, {
        onError: 'collect',
        onProgress: (done, total, msg) => pr.step(done, total, msg, 5, 80)
    });

    // Self-verify each written file.
    const results = [];
    let okCount = 0;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const opResult = engineResult.results[i];
        const entry = { path: f.path };
        if (opResult && opResult.ok) {
            try {
                const proof = verifyFile(f.path, opResult.size);
                entry.verified = true;
                entry.size = proof.size;
                okCount++;
            } catch (err) {
                entry.verified = false;
                entry.error = err.message;
            }
        } else {
            entry.verified = false;
            entry.error = opResult?.error || 'write failed';
        }
        results.push(entry);
        pr.step(i + 1, files.length, `Verified ${f.path}`, 80, 95);
    }

    pr.done(`Import complete: ${okCount}/${files.length} files`);
    logger.info(`[Storage] storage_import OK: ${okCount}/${files.length} verified`, null, 'Storage');
    return result(true, 'storage_import', '', { imported: okCount, total: files.length, files: results });
}

export async function storage_readMany(args, context) {
    const { paths } = args;
    logger.info(`[Storage] storage_readMany: ${paths?.length || 0} file(s)`, null, 'Storage');
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
        throw new Error('storage_readMany: args.paths must be a non-empty array of paths');
    }

    const pr = createProgressReporter(context?.progress);
    const results = [];
    let okCount = 0;
    for (let i = 0; i < paths.length; i++) {
        const userPath = paths[i];
        pr.step(i + 1, paths.length, `Reading ${userPath} (${i + 1}/${paths.length})`, 5, 90);
        try {
            if (!userPath || typeof userPath !== 'string') throw new Error('path must be a string');
            const target = safeResolve(userPath);
            const stat = fs.statSync(target);
            if (stat.isDirectory()) throw new Error('cannot read a directory');
            if (stat.size > CONFIG.maxReadSize) {
                results.push({
                    path: userPath,
                    truncated: true,
                    size: stat.size,
                    pointer: safeRel(userPath),
                    note: `File exceeds maxReadSize — use the REST endpoint or chunk via offset/length.`
                });
                okCount++;
                continue;
            }
            const content = fs.readFileSync(target, 'utf8');
            results.push({ path: userPath, size: stat.size, inline: true, content });
            okCount++;
        } catch (err) {
            results.push({ path: userPath, error: err.message });
        }
    }
    pr.done(`Read ${okCount}/${paths.length} files`);
    logger.info(`[Storage] storage_readMany OK: ${okCount}/${paths.length}`, null, 'Storage');
    // Delimited plain-text stream instead of a JSON envelope (issue #12):
    // enveloped multi-file content arrives as one JSON-escaped line that
    // line-based readers truncate. Delimiters keep per-file boundaries and
    // error/pointer notes readable while paging as content.txt.
    const SEP = '════════════════════════════════════════════';
    const parts = results.map(f => {
        if (f.error) return `${SEP}\n✗ ${f.path} — ERROR: ${f.error}\n${SEP}`;
        if (f.truncated) return `${SEP}\n△ ${f.path} — TOO LARGE (${f.size}B), pointer: ${f.pointer}\n${SEP}`;
        return `${SEP}\n ${f.path} (${f.size}B)\n${SEP}\n${f.content}`;
    });
    return { content: [{ type: 'text', text: `readMany: ${okCount}/${paths.length} files\n\n${parts.join('\n\n')}` }] };
}
