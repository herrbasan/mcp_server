// Review-UI routes for the nConvert surface.
//
// The engine and the artefacts live in nTeligence now, so this module owns only
// what mcp_server still owns: serving the page and accepting an upload. Uploads
// go through the shared upload handoff writer (src/upload.js) and are handed to
// the service as an absolute path, deleted once the call returns — the service
// runs the ingest inline, so there is nothing left to track afterwards.

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import express from 'express';
import { receiveUpload, handleUploadError, uploadLimits } from '../../upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NUI_ROOT = path.resolve(__dirname, '..', '..', 'nui_wc2', 'NUI');
const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', '..', 'data', 'nconvert', 'uploads');

function booleanArg(value, fallback) {
    if (value === undefined) return fallback;
    if (value === true || value === 'true' || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    throw new Error(`expected a boolean, got ${value}`);
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

    // Same streamed writer as POST /upload (src/upload.js) — one implementation
    // so the two routes cannot drift on cap, cleanup or error behaviour. The
    // body cap stays nconvert's maxInputMb; the copy dies with the ingest call,
    // so the shared TTL lifecycle never actually applies here.
    app.post('/nconvert/upload', async (req, res) => {
        const maxMb = deps.conf.maxInputMb ?? 250;
        let handle = null;
        try {
            handle = await receiveUpload(req, {
                root: UPLOAD_ROOT,
                maxBytes: maxMb * 1024 * 1024,
                capMessage: `upload exceeds maxInputMb=${maxMb} — raise agents.nconvert.maxInputMb`,
                minFreeGb: uploadLimits(context.config).minFreeGb
            });
            try {
                const result = await deps.submitIngest({
                    path: handle.path,
                    depth: req.query.depth ?? 'mechanical',
                    keepOriginal: booleanArg(req.query.keepOriginal, deps.conf.keepOriginal),
                    assets: booleanArg(req.query.assets, deps.conf.assets),
                    force: booleanArg(req.query.force, false),
                    name: req.query.name
                });
                res.json(result);
            } finally {
                // The service ingests inline and has already copied what it keeps.
                fs.rmSync(handle.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            }
        } catch (error) {
            handleUploadError(req, res, error, handle?.directory);
        }
    });
}

export function shutdownNconvertUi() {
    // Nothing held open: uploads are cleaned up per request.
}
