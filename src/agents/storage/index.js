import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { getLogger } from '../../utils/logger.js';
import { createTranslatorFromConfig } from './path-translator.js';

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

// ── Resource pointer registry ───────────────────────────────────────────────
// storage_read returns a resource_link for files too big to inline. The URI
// encodes the file path so resources/read can always re-read from disk —
// no TTL, no in-memory cache. The pointer stays valid as long as the file
// exists on disk.
const RESOURCES = new Map();   // uri → { uri, name, mimeType, absolutePath, size }

function publishResource({ userPath, absolutePath, content, mimeType, size }) {
    // URI encodes the file path (percent-encoded) so resources/read can
    // always resolve the file from disk. Path is the canonical reference;
    // content/mimeType/size are cached for listResources only.
    const enc = encodeURIComponent(absolutePath);
    const uri = `storage://${enc}`;
    const entry = {
        uri,
        name: path.basename(absolutePath),
        mimeType: mimeType || 'text/plain',
        absolutePath,
        size: size ?? Buffer.byteLength(content, 'utf8')
    };
    RESOURCES.set(uri, entry);
    return entry;
}

function listResources() {
    const out = [];
    for (const [, r] of RESOURCES) {
        out.push({ uri: r.uri, name: r.name, mimeType: r.mimeType, size: r.size });
    }
    return out;
}

function readResource(uri) {
    // Path-encoded URI — look up the registered entry, then re-read from disk.
    // If the file is gone (deleted/renamed) we return null. No TTL pressure.
    const entry = RESOURCES.get(uri);
    if (!entry) return null;
    if (!fs.existsSync(entry.absolutePath)) return null;
    const content = fs.readFileSync(entry.absolutePath, 'utf8');
    return { uri: entry.uri, mimeType: entry.mimeType, text: content };
}

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

// Files larger than this go through the resource_link path — their content is
// published as a resource the MCP client fetches via resources/read, bypassing
// the JSON-RPC message-size limit that kills inline text transport on large
// files (chat-app clients without filesystem access).
const INLINE_BYTE_LIMIT = 64 * 1024;

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

function toMcp(ok, data) {
    const text = JSON.stringify({ ok, ...data }, null, 2);
    return { content: [{ type: 'text', text }] };
}

// toMcpWithContent emits an MCP result with one or more typed content items.
// First item is always a small JSON text summary; the rest may be resource_link
// items for large data the client should fetch separately.
function toMcpWithContent(summary, extras = []) {
    const content = [{ type: 'text', text: JSON.stringify(summary, null, 2) }];
    for (const e of extras) content.push(e);
    return { content };
}

function result(ok, op, userPath, data) {
    return toMcp(ok, { op, path: userPath, ...data });
}

export async function init(context) {
    const agentConfig = context.config?.agents?.storage;
    if (!agentConfig) throw new Error('storage.init: context.config.agents.storage is required — missing from config.json');
    initConfig(agentConfig);

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
        app.use('/storage', (req, res, next) => {
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
    }

    return {
        root: STORAGE_ROOT,
        listResources,
        readResource,
        publishResource
    };
}

export async function storage_stat(args) {
    const userPath = args.path;
    logger.info(`[Storage] storage_stat: "${userPath}"`, null, 'Storage');
    if (!userPath) throw new Error('storage_stat: args.path is required');
    const target = safeResolve(userPath);
    try {
        const stat = fs.statSync(target);
        logger.info(`[Storage] storage_stat OK: "${userPath}" (${stat.isDirectory() ? 'dir' : 'file'}, ${stat.size}B)`, null, 'Storage');
        return result(true, 'storage_stat', userPath, {
            exists: true,
            type: stat.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            modified: stat.mtime.toISOString()
        });
    } catch (err) {
        if (err.code === 'ENOENT') {
            logger.info(`[Storage] storage_stat OK: "${userPath}" (not found)`, null, 'Storage');
            return result(true, 'storage_stat', userPath, { exists: false });
        }
        throw err;
    }
}

export async function storage_read(args) {
    const userPath = args.path;
    logger.info(`[Storage] storage_read: "${userPath}"`, { encoding: args.encoding }, 'Storage');
    if (!userPath) throw new Error('storage_read: args.path is required');
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

    // Files above the inline threshold are published as a resource. The MCP
    // client (chat app) fetches via resources/read — bypasses the JSON-RPC
    // message-size limit. Below the threshold, inline as today.
    if (stat.size > INLINE_BYTE_LIMIT) {
        const mime = guessMime(userPath);
        const resource = publishResource({
            userPath,
            absolutePath: target,
            content: out,
            mimeType: mime,
            size: stat.size
        });
        return toMcpWithContent(
            {
                ok: true,
                op: 'storage_read',
                path: userPath,
                size: stat.size,
                encoding,
                inline: false,
                resourceUri: resource.uri,
                note: 'File is above the inline size threshold. Use resources/read (uri shown) to fetch the content — this avoids transport-size failures on large payloads.'
            },
            [{
                type: 'resource_link',
                uri: resource.uri,
                name: resource.name,
                mimeType: resource.mimeType,
                description: `${stat.size}B ${userPath} — fetch via resources/read`
            }]
        );
    }
    return result(true, 'storage_read', userPath, { content: out, encoding, size: stat.size, inline: true });
}

export async function storage_write(args) {
    const userPath = args.path;
    const content = args.content;
    logger.info(`[Storage] storage_write: "${userPath}" (${content?.length || 0} chars)`, null, 'Storage');
    if (!userPath) throw new Error('storage_write: args.path is required');
    if (content === undefined || content === null) throw new Error('storage_write: args.content is required');
    const encoding = args.encoding || 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') {
        throw new Error(`storage_write: invalid encoding "${encoding}" — must be "utf8" or "base64"`);
    }
    const target = safeResolve(userPath);
    const buffer = encoding === 'base64'
        ? Buffer.from(content, 'base64')
        : Buffer.from(content, 'utf8');
    if (buffer.length > CONFIG.maxWriteSize) {
        throw new Error(`storage_write: content exceeds maxWriteSize (${buffer.length} > ${CONFIG.maxWriteSize})`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    logger.info(`[Storage] storage_write OK: "${userPath}" (${buffer.length}B)`, null, 'Storage');
    return result(true, 'storage_write', userPath, { size: buffer.length });
}

function listEntry(fullPath, basePath) {
    const stat = fs.statSync(fullPath);
    const rel = path.relative(basePath, fullPath);
    return {
        name: path.basename(fullPath),
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        modified: stat.mtime.toISOString(),
        path: rel
    };
}

function listDir(dirPath, basePath, recursive) {
    const entries = [];
    const items = fs.readdirSync(dirPath);
    for (const name of items) {
        const fullPath = path.join(dirPath, name);
        const entry = listEntry(fullPath, basePath);
        entries.push(entry);
        if (recursive && entry.type === 'dir') {
            entries.push(...listDir(fullPath, basePath, true));
        }
    }
    return entries;
}

export async function storage_list(args) {
    const userPath = args.path || '';
    const recursive = args.recursive || false;
    logger.info(`[Storage] storage_list: "${userPath}"`, { recursive }, 'Storage');
    const target = safeResolve(userPath);
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
        throw new Error('storage_list: path is not a directory');
    }
    const entries = listDir(target, STORAGE_ROOT, recursive);
    logger.info(`[Storage] storage_list OK: "${userPath}" (${entries.length} entries)`, null, 'Storage');
    return result(true, 'storage_list', userPath, { entries });
}

export async function storage_move(args) {
    const fromPath = args.from;
    const toPath = args.to;
    logger.info(`[Storage] storage_move: "${fromPath}" → "${toPath}"`, null, 'Storage');
    if (!fromPath) throw new Error('storage_move: args.from is required');
    if (!toPath) throw new Error('storage_move: args.to is required');
    const fromTarget = safeResolve(fromPath);
    const toTarget = safeResolve(toPath);
    if (fs.existsSync(toTarget)) {
        throw new Error(`storage_move: destination already exists: "${toPath}"`);
    }
    fs.mkdirSync(path.dirname(toTarget), { recursive: true });
    fs.renameSync(fromTarget, toTarget);
    const type = fs.statSync(toTarget).isDirectory() ? 'dir' : 'file';
    logger.info(`[Storage] storage_move OK: "${fromPath}" → "${toPath}" (${type})`, null, 'Storage');
    return result(true, 'storage_move', `${fromPath} -> ${toPath}`, { from: fromPath, to: toPath, type });
}

export async function storage_delete(args) {
    const userPath = args.path;
    logger.info(`[Storage] storage_delete: "${userPath}"`, { recursive: args.recursive }, 'Storage');
    if (!userPath) throw new Error('storage_delete: args.path is required');
    const recursive = args.recursive || false;
    const target = safeResolve(userPath);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
        fs.rmdirSync(target, { recursive });
    } else {
        fs.unlinkSync(target);
    }
    logger.info(`[Storage] storage_delete OK: "${userPath}" (${stat.isDirectory() ? 'dir' : 'file'})`, null, 'Storage');
    return result(true, 'storage_delete', userPath, { deleted: true });
}
