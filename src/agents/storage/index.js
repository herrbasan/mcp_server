import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const DEFAULTS = {
    root: 'data/storage',
    maxReadSize: 10 * 1024 * 1024,
    maxWriteSize: 100 * 1024 * 1024
};

let STORAGE_ROOT;
let CONFIG;

function initConfig(agentConfig) {
    const root = agentConfig?.root ?? DEFAULTS.root;
    STORAGE_ROOT = path.resolve(PROJECT_ROOT, root);
    CONFIG = {
        maxReadSize: agentConfig?.maxReadSize ?? DEFAULTS.maxReadSize,
        maxWriteSize: agentConfig?.maxWriteSize ?? DEFAULTS.maxWriteSize
    };
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
}

function safeResolve(userPath) {
    if (typeof userPath !== 'string') throw new Error(`Path must be a string: ${userPath}`);
    const resolved = path.resolve(STORAGE_ROOT, userPath);
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

function toMcp(ok, data, error) {
    const text = JSON.stringify({ ok, ...data, error: error ? `${error.code ? error.code + ': ' : ''}${error.message}` : undefined }, null, 2);
    return { content: [{ type: 'text', text }] };
}

function result(ok, op, userPath, data, error) {
    return toMcp(ok, {
        op,
        path: userPath,
        size: data?.size ?? null,
        ...data
    }, error);
}

function handleError(op, userPath, err) {
    return result(false, op, userPath, null, err);
}

export async function init(context) {
    const agentConfig = context.config?.agents?.storage ?? {};
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

    return { root: STORAGE_ROOT };
}

function wrap(op, userPath, fn) {
    try {
        return fn();
    } catch (err) {
        return handleError(op, userPath, err);
    }
}

export async function storage_stat(args) {
    const userPath = args.path;
    return wrap('storage_stat', userPath, () => {
        let target;
        try {
            target = safeResolve(userPath);
        } catch (err) {
            return handleError('storage_stat', userPath, err);
        }
        try {
            const stat = fs.statSync(target);
            return result(true, 'storage_stat', userPath, {
                exists: true,
                type: stat.isDirectory() ? 'dir' : 'file',
                size: stat.size,
                modified: stat.mtime.toISOString()
            });
        } catch (err) {
            if (err.code === 'ENOENT') {
                return result(true, 'storage_stat', userPath, { exists: false }, null);
            }
            return handleError('storage_stat', userPath, err);
        }
    });
}

export async function storage_read(args) {
    const userPath = args.path;
    const encoding = args.encoding || 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') {
        return handleError('storage_read', userPath, new Error(`Invalid encoding: ${encoding}`));
    }
    return wrap('storage_read', userPath, () => {
        let target;
        try {
            target = safeResolve(userPath);
        } catch (err) {
            return handleError('storage_read', userPath, err);
        }
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
            return handleError('storage_read', userPath, new Error('Cannot read a directory'));
        }
        if (stat.size > CONFIG.maxReadSize) {
            return result(true, 'storage_read', userPath, {
                truncated: true,
                size: stat.size,
                pointer: safeRel(userPath)
            });
        }
        const content = fs.readFileSync(target, encoding === 'base64' ? undefined : 'utf8');
        const out = encoding === 'base64' ? content.toString('base64') : content;
        return result(true, 'storage_read', userPath, { content: out, encoding, size: stat.size });
    });
}

export async function storage_write(args) {
    const userPath = args.path;
    const encoding = args.encoding || 'utf8';
    if (encoding !== 'utf8' && encoding !== 'base64') {
        return handleError('storage_write', userPath, new Error(`Invalid encoding: ${encoding}`));
    }
    return wrap('storage_write', userPath, () => {
        let target;
        try {
            target = safeResolve(userPath);
        } catch (err) {
            return handleError('storage_write', userPath, err);
        }
        const buffer = encoding === 'base64'
            ? Buffer.from(args.content, 'base64')
            : Buffer.from(args.content, 'utf8');
        if (buffer.length > CONFIG.maxWriteSize) {
            return handleError('storage_write', userPath, new Error(`Content exceeds maxWriteSize (${CONFIG.maxWriteSize} bytes)`));
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
        return result(true, 'storage_write', userPath, { size: buffer.length });
    });
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
    return wrap('storage_list', userPath, () => {
        let target;
        try {
            target = safeResolve(userPath);
        } catch (err) {
            return handleError('storage_list', userPath, err);
        }
        const stat = fs.statSync(target);
        if (!stat.isDirectory()) {
            return handleError('storage_list', userPath, new Error('Path is not a directory'));
        }
        const entries = listDir(target, STORAGE_ROOT, recursive);
        return result(true, 'storage_list', userPath, { entries });
    });
}

export async function storage_move(args) {
    const fromPath = args.from;
    const toPath = args.to;
    return wrap('storage_move', `${fromPath} -> ${toPath}`, () => {
        let fromTarget, toTarget;
        try {
            fromTarget = safeResolve(fromPath);
            toTarget = safeResolve(toPath);
        } catch (err) {
            return handleError('storage_move', `${fromPath} -> ${toPath}`, err);
        }
        if (fs.existsSync(toTarget)) {
            return handleError('storage_move', toPath, new Error('Destination already exists'));
        }
        fs.mkdirSync(path.dirname(toTarget), { recursive: true });
        fs.renameSync(fromTarget, toTarget);
        const type = fs.statSync(toTarget).isDirectory() ? 'dir' : 'file';
        return result(true, 'storage_move', `${fromPath} -> ${toPath}`, { from: fromPath, to: toPath, type });
    });
}

export async function storage_delete(args) {
    const userPath = args.path;
    const recursive = args.recursive || false;
    return wrap('storage_delete', userPath, () => {
        let target;
        try {
            target = safeResolve(userPath);
        } catch (err) {
            return handleError('storage_delete', userPath, err);
        }
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
            fs.rmdirSync(target, { recursive });
        } else {
            fs.unlinkSync(target);
        }
        return result(true, 'storage_delete', userPath, { deleted: true });
    });
}
