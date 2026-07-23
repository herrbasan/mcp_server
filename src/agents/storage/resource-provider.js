import fs from 'fs';
import path from 'path';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

// MCP Resource provider for the storage agent.
// Exposes files under the storage root as MCP resources using the
// custom URI scheme storage://<relative-path>.
//
// Spec alignment:
//   - resources/list          paginated discovery
//   - resources/read          inline content or URL pointer for large files
//   - resources/templates/list one URI template for arbitrary paths
//   - resources/subscribe     accepted but currently no-op (no watchers)

let STORAGE_ROOT;
let STORAGE_TRANSLATOR;
let INLINE_BYTE_LIMIT;

const URI_SCHEME = 'storage';

export function initResourceProvider({ storageRoot, translator, inlineByteLimit }) {
    if (!storageRoot) throw new Error('storage.resourceProvider: storageRoot is required');
    STORAGE_ROOT = storageRoot;
    STORAGE_TRANSLATOR = translator || null;
    INLINE_BYTE_LIMIT = inlineByteLimit ?? 64 * 1024;
}

function safeRel(absolutePath) {
    const rel = path.relative(STORAGE_ROOT, absolutePath);
    if (rel.startsWith('..')) throw new Error(`Path escapes storage root: ${absolutePath}`);
    return rel.replace(/\\/g, '/');
}

function toResourceUri(relPath) {
    const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    return `${URI_SCHEME}://${normalized}`;
}

function fromResourceUri(uri) {
    if (typeof uri !== 'string') throw new Error(`Invalid resource URI: ${uri}`);
    const prefix = `${URI_SCHEME}://`;
    if (!uri.startsWith(prefix)) throw new Error(`Invalid resource URI scheme: ${uri}`);
    return uri.slice(prefix.length).replace(/\\/g, '/');
}

function guessMime(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.md': 'text/markdown',
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.csv': 'text/csv',
        '.tsv': 'text/tab-separated-values',
        '.xml': 'text/xml',
        '.yaml': 'text/yaml',
        '.yml': 'text/yaml',
        '.html': 'text/html',
        '.htm': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.log': 'text/plain',
        '.sql': 'text/plain',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.pdf': 'application/pdf',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf'
    };
    return map[ext] || 'application/octet-stream';
}

function isBinaryMime(mime) {
    if (!mime) return true;
    if (mime.startsWith('text/')) return false;
    if (mime === 'application/json' || mime === 'application/xml' || mime === 'application/javascript') return false;
    if (mime === 'image/svg+xml') return false;
    return true;
}

function walkResources(dir, out, baseRel = '') {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const rel = baseRel ? `${baseRel}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
            out.push({
                uri: toResourceUri(rel),
                name: entry.name,
                mimeType: 'application/x-directory',
                size: 0,
                annotations: { directory: true }
            });
            walkResources(full, out, rel);
        } else {
            out.push({
                uri: toResourceUri(rel),
                name: entry.name,
                mimeType: guessMime(full),
                size: stat.size,
                annotations: {}
            });
        }
    }
}

export function listResources({ cursor } = {}) {
    if (!STORAGE_ROOT) throw new Error('storage.resourceProvider: not initialized');

    const pageSize = 1000;
    const offset = cursor ? parseInt(cursor, 10) : 0;
    if (Number.isNaN(offset) || offset < 0) throw new Error(`Invalid cursor: ${cursor}`);

    const all = [];
    walkResources(STORAGE_ROOT, all);
    all.sort((a, b) => a.uri.localeCompare(b.uri));

    const page = all.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;

    return {
        resources: page,
        nextCursor: nextOffset < all.length ? String(nextOffset) : undefined
    };
}

export function listResourceTemplates() {
    return [
        {
            uriTemplate: 'storage://{path}',
            name: 'Any storage file',
            mimeType: 'application/octet-stream',
            description: 'Arbitrary file under the storage root. {path} is the relative path using forward slashes.'
        }
    ];
}

export function readResource({ uri, encoding }) {
    if (!STORAGE_ROOT) throw new Error('storage.resourceProvider: not initialized');

    const rel = fromResourceUri(uri);
    const localRel = rel.replace(/\\/g, '/');
    const target = path.join(STORAGE_ROOT, localRel);

    if (!fs.existsSync(target)) {
        throw new Error(`Resource not found: ${uri}`);
    }
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
        throw new Error(`Resource is a directory, not readable: ${uri}`);
    }

    const mime = guessMime(target);
    const requestedEncoding = encoding || (isBinaryMime(mime) ? 'base64' : 'utf8');

    if (stat.size > INLINE_BYTE_LIMIT) {
        const urlPath = safeRel(target).replace(/\\/g, '/');
        // Return a RELATIVE path — the client prepends its own MCP origin.
        const relPath = `/storage/${encodeURI(urlPath)}`;
        return [{
            uri,
            mimeType: 'text/plain',
            text: `File is too large to inline (${stat.size} bytes). Fetch it via HTTP at this relative path (prepend your MCP server origin): ${relPath}`
        }];
    }

    const content = fs.readFileSync(target, requestedEncoding === 'base64' ? undefined : 'utf8');

    if (requestedEncoding === 'base64' || isBinaryMime(mime)) {
        return [{
            uri,
            mimeType: mime,
            blob: content.toString('base64')
        }];
    }

    return [{
        uri,
        mimeType: mime,
        text: content
    }];
}

export function subscribeResource({ uri }) {
    // No-op: the storage agent currently has no file watchers. The MCP spec
    // says clients may subscribe, but servers can ignore if they don't support
    // update notifications.
    logger.info(`[Storage:resources] Subscribe requested for ${uri} (no-op, no watchers)`, null, 'Storage');
    return null;
}
