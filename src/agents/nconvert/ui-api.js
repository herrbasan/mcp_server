// Review-UI routes for the nConvert surface.
//
// The engine and the artefacts live in nTeligence now, so this module owns only
// what mcp_server still owns: serving the page and accepting an upload. Uploads
// are handed to the service as an absolute path and deleted once the call
// returns — the service runs the ingest inline, so there is nothing left to
// track afterwards.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NUI_ROOT = path.resolve(__dirname, '..', '..', 'nui_wc2', 'NUI');
const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', '..', 'data', 'nconvert', 'uploads');

function booleanArg(value, fallback) {
    if (value === undefined) return fallback;
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    throw new Error(`expected a boolean, got ${value}`);
}

function uploadName(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('filename query parameter is required');
    const name = path.basename(value).replace(/[^\p{L}\p{N}._ ()-]/gu, '_').trim();
    if (!name || name === '.' || name === '..') throw new Error('filename is not usable');
    return name;
}

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

export function initNconvertUi(context, deps) {
    const app = context.app;
    if (!app) return;
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

    app.get('/nconvert', (_req, res) => res.sendFile(path.join(__dirname, 'ui.html')));
    app.get('/nconvert/ui.js', (_req, res) => res.sendFile(path.join(__dirname, 'ui.js')));
    app.get('/nconvert/ui.css', (_req, res) => res.sendFile(path.join(__dirname, 'ui.css')));
    app.use('/nconvert/nui', express.static(NUI_ROOT, { fallthrough: false, index: false }));
    app.get('/nconvert/items/:id', route(async (req) => deps.readItemPayload(req.params.id, {
        documentChars: req.query.documentChars
    })));

    // The engine serves artefact bytes at /files/<storage-relative path> and the
    // review UI uses those URLs verbatim — layer links, document images, page
    // rasters. The service binds loopback while the UI is served from this
    // origin (often viewed from another machine), so the namespace is proxied
    // rather than rewritten in every payload the service returns.
    app.get(/^\/files\/(.+)$/, async (req, res) => {
        try {
            const upstream = await fetch(`${deps.serviceBase()}/files/${req.params[0]}`, {
                signal: AbortSignal.timeout(120000)
            });
            if (!upstream.ok) {
                res.status(upstream.status).json({ error: `nTeligence /files/${req.params[0]} → ${upstream.status}` });
                return;
            }
            res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
            const length = upstream.headers.get('content-length');
            if (length) res.setHeader('Content-Length', length);
            const cache = upstream.headers.get('cache-control');
            if (cache) res.setHeader('Cache-Control', cache);
            // pipeline, not pipe: a client that hangs up mid-file must cancel the
            // upstream body too, or the engine's socket stays open.
            await pipeline(Readable.fromWeb(upstream.body), res);
        } catch (error) {
            if (!res.headersSent) res.status(502).json({ error: `nTeligence /files unreachable: ${error.message}` });
            else res.destroy(error);
        }
    });

    const raw = express.raw({ type: 'application/octet-stream', limit: deps.conf.maxInputMb * 1024 * 1024 });
    app.post('/nconvert/upload', (req, res, next) => {
        raw(req, res, (error) => {
            if (!error) return next();
            res.status(error.statusCode ?? 400).json({ error: error.message });
        });
    }, route(async (req) => {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            throw new Error('upload a non-empty file as application/octet-stream');
        }
        const filename = uploadName(req.query.filename);
        const directory = path.join(UPLOAD_ROOT, crypto.randomUUID());
        // Cleanup deletes recursively — the escape check has to run before the
        // write, not in the finally block where a throw would mask the result.
        if (path.dirname(directory) !== UPLOAD_ROOT) throw new Error('upload directory escaped its root');
        const file = path.join(directory, filename);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(file, req.body);
        try {
            return await deps.submitIngest({
                path: file,
                depth: req.query.depth ?? 'mechanical',
                keepOriginal: booleanArg(req.query.keepOriginal, deps.conf.keepOriginal),
                assets: booleanArg(req.query.assets, deps.conf.assets),
                force: booleanArg(req.query.force, false),
                name: req.query.name
            });
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }));
}

export function shutdownNconvertUi() {
    // Nothing held open: uploads are cleaned up per request.
}
