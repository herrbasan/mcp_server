import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { createTranslatorFromConfig } from './path-translator.js';
import { createFileOps } from '../../lib/fileops.js';
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
let OPS;          // createFileOps engine — copy, append, readWindow, grep, batch, history, restore
let PUBLIC_URL;  // e.g. http://192.168.0.100:3100 — used to build retrieval URLs for big files

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
        translator: TRANSLATOR,
        keepVersions: agentConfig.keepVersions ?? 10
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

function toMcp(ok, data) {
    const text = JSON.stringify({ ok, ...data }, null, 2);
    return { content: [{ type: 'text', text }] };
}

function result(ok, op, userPath, data) {
    return toMcp(ok, { op, path: userPath, ...data });
}

function isLocalhostUrl(url) {
    if (!url) return true;
    try {
        const u = new URL(url);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1';
    } catch {
        return false;
    }
}

export async function init(context) {
    const agentConfig = context.config?.agents?.storage;
    if (!agentConfig) throw new Error('storage.init: context.config.agents.storage is required — missing from config.json');
    initConfig(agentConfig);

    // Public URL for constructing retrieval links for big files. Lookup order:
    // 1. agents.storage.publicUrl (storage-specific override)
    // 2. agents.forge.publicUrl (server-wide setting — typically the same)
    // 3. PUBLIC_URL env var
    // 4. http://localhost:{PORT} — last resort, only works for same-machine clients
    PUBLIC_URL = agentConfig.publicUrl
        || context.config?.agents?.forge?.publicUrl
        || process.env.PUBLIC_URL
        || `http://localhost:${process.env.PORT || 3100}`;

    if (isLocalhostUrl(PUBLIC_URL)) {
        logger.warn(`[Storage] PUBLIC_URL is set to localhost (${PUBLIC_URL}). Large files will return URLs that are unreachable from other LAN machines. Set agents.storage.publicUrl to the server's LAN IP, e.g. http://192.168.0.100:3100`, null, 'Storage');
    } else {
        logger.info(`[Storage] Public URL for large files: ${PUBLIC_URL}`, null, 'Storage');
    }

    // Initialize the MCP resource provider so resources/list and resources/read work.
    resources.initResourceProvider({
        storageRoot: STORAGE_ROOT,
        translator: TRANSLATOR,
        publicUrl: PUBLIC_URL,
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
        resources: {
            listResources: resources.listResources,
            listResourceTemplates: resources.listResourceTemplates,
            readResource: resources.readResource,
            subscribeResource: resources.subscribeResource
        }
    };
}

export async function storage_stat(args) {
    const userPath = args.path;
    logger.info(`[Storage] storage_stat: "${userPath}"`, null, 'Storage');
    if (!userPath) throw new Error('storage_stat: args.path is required');
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
    const userPath = args.path;
    logger.info(`[Storage] storage_read: "${userPath}"`, { encoding: args.encoding }, 'Storage');
    if (!userPath) throw new Error('storage_read: args.path is required');

    // Windowed read: delegate to OPS.readWindow when any window arg is present.
    const hasWindow = args.offset !== undefined || args.length !== undefined ||
                      args.head !== undefined || args.tail !== undefined;
    if (hasWindow) {
        if (args.offset !== undefined && args.length === undefined) {
            throw new Error('storage_read: length is required when offset is given');
        }
        const wResult = await OPS.readWindow(userPath, {
            offset: args.offset,
            length: args.length,
            head: args.head,
            tail: args.tail
        });
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
        const httpUrl = `${PUBLIC_URL}/storage/${encodeURI(urlPath)}`;
        const response = {
            size: stat.size,
            inline: false,
            httpUrl,
            encoding,
            nextStep: `fetch_webpage({ url: "${httpUrl}" })`,
            note: `File is above the inline size threshold. Call fetch_webpage with the httpUrl above to stream the file. The HTTP endpoint has no MCP transport-size limit. ${isLocalhostUrl(httpUrl) ? 'WARNING: this URL points to localhost/127.0.0.1, so it is only reachable from the server machine. For LAN access, set agents.storage.publicUrl to the server LAN IP (e.g. http://192.168.0.100:3100) and restart.' : 'This URL uses the configured public address and should be reachable from LAN clients.'}`
        };
        if (isLocalhostUrl(httpUrl)) {
            response.warning = `httpUrl points to localhost (${httpUrl}). It will fail from any machine other than the server. Configure agents.storage.publicUrl to the server's LAN IP (e.g. http://192.168.0.100:3100) and restart.`;
        }
        return result(true, 'storage_read', userPath, response);
    }
    return result(true, 'storage_read', userPath, { content: out, encoding, size: stat.size, inline: true });
}

export async function storage_write(args) {
    const t0 = Date.now();
    const userPath = args.path;
    const content = args.content;
    logger.info(`[Storage] storage_write: "${userPath}" (${content?.length || 0} chars)`, null, 'Storage');
    if (!userPath) throw new Error('storage_write: args.path is required');
    if (content === undefined || content === null) throw new Error('storage_write: args.content is required');
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
    logger.info(`[Storage] storage_write OK: "${userPath}" (${engineResult.size}B, total=${Date.now() - t0}ms)`, null, 'Storage');
    return result(true, 'storage_write', userPath, { size: engineResult.size });
}

export async function storage_list(args) {
    const userPath = args.path || '';
    const recursive = args.recursive || false;
    logger.info(`[Storage] storage_list: "${userPath}"`, { recursive }, 'Storage');
    const st = await OPS.stat(userPath);
    if (!st.exists || st.type !== 'dir') {
        throw new Error('storage_list: path is not a directory');
    }
    const { entries } = await OPS.list(userPath, { recursive });
    // Normalize modified to ISO string to preserve the legacy response shape.
    const normalized = entries.map(e => ({ ...e, modified: new Date(e.modified).toISOString() }));
    logger.info(`[Storage] storage_list OK: "${userPath}" (${normalized.length} entries)`, null, 'Storage');
    return result(true, 'storage_list', userPath, { entries: normalized });
}

export async function storage_move(args) {
    const fromPath = args.from;
    const toPath = args.to;
    logger.info(`[Storage] storage_move: "${fromPath}" → "${toPath}"`, null, 'Storage');
    if (!fromPath) throw new Error('storage_move: args.from is required');
    if (!toPath) throw new Error('storage_move: args.to is required');
    // Engine refuses overwrite and snapshots the source before moving.
    const engineResult = await OPS.move(fromPath, toPath);
    logger.info(`[Storage] storage_move OK: "${fromPath}" → "${toPath}" (${engineResult.type})`, null, 'Storage');
    return result(true, 'storage_move', `${fromPath} -> ${toPath}`, { from: engineResult.from, to: engineResult.to, type: engineResult.type });
}

export async function storage_delete(args) {
    const userPath = args.path;
    logger.info(`[Storage] storage_delete: "${userPath}"`, { recursive: args.recursive }, 'Storage');
    if (!userPath) throw new Error('storage_delete: args.path is required');
    const recursive = args.recursive || false;
    // Engine snapshots before deleting; non-empty dir requires recursive:true.
    const st = await OPS.stat(userPath);
    if (!st.exists) throw new Error(`storage_delete: path does not exist: "${userPath}"`);
    await OPS.remove(userPath, { recursive });
    logger.info(`[Storage] storage_delete OK: "${userPath}" (${st.type})`, null, 'Storage');
    return result(true, 'storage_delete', userPath, { deleted: true });
}

export async function storage_search(args) {
    const { query, folder, extension, top_k = 10, include_content = false } = args || {};
    if (!query) throw new Error('storage_search: query is required');
    logger.info(`[Storage] storage_search: "${query}"`, { folder, extension, top_k }, 'Storage');

    const results = await searchDocuments({
        query,
        collections: ['storage'],
        folder,
        extension,
        top_k,
        include_content
    });

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
    const { uri, encoding } = args || {};
    if (!uri) throw new Error('storage_resources_read: uri is required');
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
    const { from, to, overwrite } = args;
    logger.info(`[Storage] storage_copy: "${from}" → "${to}"`, null, 'Storage');
    if (!from) throw new Error('storage_copy: args.from is required');
    if (!to) throw new Error('storage_copy: args.to is required');
    const engineResult = await OPS.copy(from, to, { overwrite: !!overwrite });
    logger.info(`[Storage] storage_copy OK: "${from}" → "${to}" (${engineResult.size}B)`, null, 'Storage');
    return result(true, 'storage_copy', `${from} -> ${to}`, engineResult);
}

export async function storage_append(args) {
    const { path: userPath, content, encoding } = args;
    logger.info(`[Storage] storage_append: "${userPath}" (${content?.length || 0} chars)`, null, 'Storage');
    if (!userPath) throw new Error('storage_append: args.path is required');
    if (content === undefined || content === null) throw new Error('storage_append: args.content is required');
    const engineResult = await OPS.append(userPath, content, { encoding });
    logger.info(`[Storage] storage_append OK: "${userPath}" (total=${engineResult.size}B)`, null, 'Storage');
    return result(true, 'storage_append', userPath, { size: engineResult.size });
}

export async function storage_grep(args) {
    const { path: userPath, pattern, maxMatches, context, ignoreCase } = args;
    logger.info(`[Storage] storage_grep: "${userPath}" pattern="${pattern}"`, null, 'Storage');
    if (!userPath) throw new Error('storage_grep: args.path is required');
    if (!pattern) throw new Error('storage_grep: args.pattern is required');
    const engineResult = await OPS.grep(userPath, pattern, { maxMatches, context, ignoreCase });
    logger.info(`[Storage] storage_grep OK: "${userPath}" (${engineResult.matches.length} match(es))`, null, 'Storage');
    return result(true, 'storage_grep', userPath, { matches: engineResult.matches, truncated: engineResult.truncated });
}

export async function storage_batch(args) {
    const { ops, onError } = args;
    logger.info(`[Storage] storage_batch: ${ops?.length || 0} op(s)`, null, 'Storage');
    if (!ops || !Array.isArray(ops) || ops.length === 0) {
        throw new Error('storage_batch: args.ops must be a non-empty array');
    }
    const engineResult = await OPS.batch(ops, { onError });
    logger.info(`[Storage] storage_batch OK: ${engineResult.results.length} result(s)`, null, 'Storage');
    return result(true, 'storage_batch', '', { results: engineResult.results });
}

export async function storage_history(args) {
    const { path: userPath } = args;
    logger.info(`[Storage] storage_history: "${userPath}"`, null, 'Storage');
    if (!userPath) throw new Error('storage_history: args.path is required');
    const engineResult = await OPS.history(userPath);
    logger.info(`[Storage] storage_history OK: "${userPath}" (${engineResult.versions.length} version(s))`, null, 'Storage');
    return result(true, 'storage_history', userPath, { versions: engineResult.versions });
}

export async function storage_restore(args) {
    const { path: userPath, steps } = args;
    logger.info(`[Storage] storage_restore: "${userPath}" steps=${steps ?? 1}`, null, 'Storage');
    if (!userPath) throw new Error('storage_restore: args.path is required');
    const engineResult = await OPS.restore(userPath, { steps: steps ?? 1 });
    logger.info(`[Storage] storage_restore OK: "${userPath}" from=${engineResult.from}`, null, 'Storage');
    return result(true, 'storage_restore', userPath, { restored: engineResult.restored, from: engineResult.from });
}
