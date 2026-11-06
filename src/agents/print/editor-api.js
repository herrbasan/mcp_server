import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
// Each live session holds a warm Chromium so break edits do not re-parse the
// document. Browsers that were never closed (crash, killed tab) would otherwise
// accumulate until the TTL, so the oldest idle one is evicted.
const MAX_SESSIONS = 4;
let editorRoot;
let deps;

const sha256 = (source) => crypto.createHash('sha256').update(source).digest('hex');
const storageUrl = (relative) => '/storage/' + relative.split('/').map(encodeURIComponent).join('/');
const log = (message) => console.log(`[Print] ${message}`);

function route(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req, res);
            if (!res.headersSent) res.json(result);
        } catch (error) {
            res.status(error.statusCode ?? 400).json({ error: error.message });
        }
    };
}

function sessionFor(req) {
    const session = sessions.get(req.body?.token);
    if (!session) throw new Error('print.editor: session not found; reopen the document');
    session.lastTouched = Date.now();
    return session;
}

function conflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    return error;
}

function assertIdle(session) {
    if (session.rendering) throw conflict('print.editor: another operation is still rendering this session');
}

async function cleanupExpired() {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const session of sessions.values()) {
        if (session.rendering || session.lastTouched > cutoff) continue;
        sessions.delete(session.token);
        if (session.renderer) await session.renderer.close();
        fs.rmSync(session.folder, { recursive: true, force: true });
    }
}

async function evictOldestIdle() {
    while (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions.values()]
            .filter((session) => !session.rendering)
            .sort((left, right) => left.lastTouched - right.lastTouched)[0];
        if (!oldest) return;
        sessions.delete(oldest.token);
        if (oldest.renderer) await oldest.renderer.close();
        fs.rmSync(oldest.folder, { recursive: true, force: true });
    }
}

function printOptions(body) {
    const options = {};
    for (const key of ['style', 'format', 'orientation', 'margin', 'sectionPages', 'breakBefore', 'breakAfter']) {
        if (body[key] !== undefined) options[key] = body[key];
    }
    return options;
}

async function renderSession(session, body = {}) {
    assertIdle(session);
    session.rendering = true;
    try {
        const result = await session.renderer.render(printOptions(body), {
            preview: true,
            width: body.width ?? 1100,
            outputFolder: session.folder
        });
        session.revision++;
        const { manifest } = result;
        return {
            token: session.token,
            revision: session.revision,
            sourceSha256: session.sourceSha256,
            externallyChanged: manifest.sourceSha256 !== session.sourceSha256,
            options: manifest.options,
            targets: manifest.targets.filter((target) => target.page && ['section', 'block', 'columns', 'heading', 'paragraph', 'item', 'unit'].includes(target.kind)),
            pageCount: manifest.pageCount,
            pages: manifest.previews.map((preview) => ({ page: preview.page, url: storageUrl(preview.path) })),
            pdfUrl: storageUrl(manifest.pdf),
            timings: manifest.timings,
            warnings: manifest.warnings
        };
    } finally {
        session.rendering = false;
    }
}

async function open(req) {
    await cleanupExpired();
    await evictOldestIdle();
    const remote = req.socket.remoteAddress;
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (path.isAbsolute(String(req.body?.path ?? '')) && !loopback) {
        const error = new Error('print.editor: absolute source paths are loopback-only; use a storage-relative path');
        error.statusCode = 403;
        throw error;
    }
    const sourcePath = deps.resolveExisting(req.body?.path, 'print.editor');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const token = crypto.randomUUID();
    const session = {
        token,
        sourcePath,
        inputPath: req.body.path,
        source,
        sourceSha256: sha256(source),
        folder: path.join(editorRoot, token),
        revision: 0,
        lastTouched: Date.now(),
        rendering: false,
        renderer: null
    };
    sessions.set(token, session);
    try {
        const started = Date.now();
        session.renderer = await deps.createRenderSession({
            path: req.body.path,
            name: 'editor',
            _mapTargets: true
        });
        const rendered = await renderSession(session, req.body);
        log(`open ${req.body.path} ${Date.now() - started}ms ${JSON.stringify(rendered.timings)}`);
        return { ...rendered, path: session.inputPath, source };
    } catch (error) {
        log(`open ${req.body.path} FAILED: ${error.message}`);
        sessions.delete(token);
        if (session.renderer) await session.renderer.close();
        fs.rmSync(session.folder, { recursive: true, force: true });
        throw error;
    }
}

async function render(req) {
    const session = sessionFor(req);
    const started = Date.now();
    const result = await renderSession(session, req.body);
    log(`render ${session.inputPath} ${Date.now() - started}ms ${JSON.stringify(result.timings)}`);
    return result;
}

async function save(req) {
    const session = sessionFor(req);
    assertIdle(session);
    if (typeof req.body.markdown !== 'string' || !req.body.markdown.trim()) {
        throw new Error('print.editor: markdown must be a non-empty string');
    }
    if (req.body.baseSha256 !== session.sourceSha256) {
        throw conflict('print.editor: save base is stale; reopen the document');
    }
    const current = fs.readFileSync(session.sourcePath, 'utf8');
    if (sha256(current) !== session.sourceSha256) {
        throw conflict('print.editor: source changed on disk; reopen before saving');
    }
    const temporary = session.sourcePath + `.print-editor-${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, req.body.markdown, 'utf8');
        fs.renameSync(temporary, session.sourcePath);
    } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
    session.source = req.body.markdown;
    session.sourceSha256 = sha256(session.source);
    return { token: session.token, source: session.source, sourceSha256: session.sourceSha256 };
}

async function close(req) {
    const session = sessionFor(req);
    assertIdle(session);
    sessions.delete(session.token);
    if (session.renderer) await session.renderer.close();
    fs.rmSync(session.folder, { recursive: true, force: true });
    return { closed: true };
}

export function initEditor(context, dependencies) {
    deps = dependencies;
    editorRoot = path.join(deps.outputRoot, '_editor');
    // Session folders are owned by this process only: anything still on disk
    // belongs to a previous run whose renderers are gone.
    fs.rmSync(editorRoot, { recursive: true, force: true });
    fs.mkdirSync(editorRoot, { recursive: true });
    const app = context.app;
    if (!app) return;
    app.get('/print', (_req, res) => res.sendFile(path.join(__dirname, 'editor.html')));
    app.get('/print/editor.js', (_req, res) => res.sendFile(path.join(__dirname, 'editor.js')));
    app.get('/print/editor.css', (_req, res) => res.sendFile(path.join(__dirname, 'editor.css')));
    app.use('/print/nui', express.static(deps.nuiRoot, { fallthrough: false, index: false }));
    app.post('/print/api/open', express.json({ limit: '64kb' }), route(open));
    app.post('/print/api/render', express.json({ limit: '64kb' }), route(render));
    app.post('/print/api/save', express.json({ limit: '4mb' }), route(save));
    app.post('/print/api/close', express.json({ limit: '64kb' }), route(close));
}

export async function shutdownEditor() {
    for (const session of sessions.values()) {
        if (session.renderer) await session.renderer.close();
        fs.rmSync(session.folder, { recursive: true, force: true });
    }
    sessions.clear();
}
