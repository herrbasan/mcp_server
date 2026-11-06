import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { createRequire } from 'module';
import puppeteer from 'puppeteer';
import { initEditor, shutdownEditor } from './editor-api.js';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const NUI_ROOT = path.join(PROJECT_ROOT, 'src', 'nui_wc2', 'NUI');

let storageRoot;
let outputRoot;
let conf;
let server;
let serverPort;
const jobs = new Map();

const MIME = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4'
};

function confined(root, relative) {
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('path escapes served root');
    return resolved;
}

function serveFile(res, absolute) {
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        res.writeHead(404).end('not found');
        return;
    }
    res.writeHead(200, {
        'content-type': MIME[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store'
    });
    fs.createReadStream(absolute).pipe(res);
}

function renderHtml(token, source, options) {
    const payload = JSON.stringify({ token, source, options }).replaceAll('<', '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MD-Blocks print</title>
<link rel="stylesheet" href="/nui/css/nui-theme.css">
<link rel="stylesheet" href="/agent/print.css">
<style id="print-page-options"></style>
</head>
<body>
<script type="application/json" id="print-job">${payload}</script>
<div id="output"></div>
<script type="module" src="/agent/page.js"></script>
</body>
</html>`;
}

async function handleRequest(req, res) {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method !== 'GET') {
            res.writeHead(405).end('method not allowed');
            return;
        }
        if (url.pathname === '/favicon.ico') {
            res.writeHead(204).end();
            return;
        }
        if (url.pathname.startsWith('/nui/')) {
            serveFile(res, confined(NUI_ROOT, decodeURIComponent(url.pathname.slice(5))));
            return;
        }
        if (url.pathname.startsWith('/agent/')) {
            serveFile(res, confined(__dirname, decodeURIComponent(url.pathname.slice(7))));
            return;
        }
        const render = /^\/render\/([0-9a-f-]+)$/.exec(url.pathname);
        if (render) {
            const job = jobs.get(render[1]);
            if (!job) {
                res.writeHead(404).end('render not found');
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(renderHtml(job.token, job.source, job.options));
            return;
        }
        const source = /^\/source\/([0-9a-f-]+)\/(.*)$/.exec(url.pathname);
        if (source) {
            const job = jobs.get(source[1]);
            if (!job) {
                res.writeHead(404).end('source not found');
                return;
            }
            serveFile(res, confined(job.baseDir, decodeURIComponent(source[2])));
            return;
        }
        res.writeHead(404).end('not found');
    } catch (error) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(error.message);
    }
}

export async function init(context) {
    storageRoot = context.config.agents?.storage?.root;
    if (!storageRoot) throw new Error('[print] config agents.storage.root is required');
    storageRoot = path.resolve(storageRoot);

    conf = {
        folder: 'prints',
        maxPages: 100,
        inlinePreviewLimit: 8,
        previewWidth: 1240,
        previewTimeoutMs: 120000,
        chromeGapMm: 8,
        chromeInsetMm: 5,
        maxChromeFraction: 0.35,
        pdfiumPath: 'nConvert/napi/pdfium/bin',
        ...(context.config.agents?.print ?? {})
    };
    outputRoot = path.join(storageRoot, conf.folder);
    fs.mkdirSync(outputRoot, { recursive: true });

    server = http.createServer(handleRequest);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    serverPort = server.address().port;
    initEditor(context, { renderDocument, createRenderSession, resolveExisting, storageRoot, outputRoot, nuiRoot: NUI_ROOT });
    return { status: 'initialized', folder: conf.folder };
}

export async function shutdown() {
    await shutdownEditor();
    if (!server) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server = null;
}

function slugify(value) {
    return String(value).toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim().split(/\s+/).slice(0, 6).join('-')
        .replace(/-+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'document';
}

function localTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function uniqueFolder(slug) {
    const stamp = localTimestamp();
    let candidate = path.join(outputRoot, `${stamp}_${slug}`);
    let index = 2;
    while (fs.existsSync(candidate)) candidate = path.join(outputRoot, `${stamp}_${slug}-${index++}`);
    return candidate;
}

function storageRelative(absolute) {
    return path.relative(storageRoot, absolute).replaceAll('\\', '/');
}

function resolveExisting(inputPath, kind) {
    if (typeof inputPath !== 'string' || !inputPath.trim()) throw new Error(`${kind}: "path" is required`);
    const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : confined(storageRoot, inputPath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`${kind}: file not found: ${inputPath}`);
    return absolute;
}

function resolveBase(inputPath) {
    if (!inputPath) return storageRoot;
    const absolute = path.isAbsolute(inputPath) ? path.resolve(inputPath) : confined(storageRoot, inputPath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new Error(`print.render: basePath is not a directory: ${inputPath}`);
    return absolute;
}

function stringArray(value, name) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new Error(`print.render: ${name} must be an array of non-empty MD-Blocks IDs`);
    }
    if (new Set(value).size !== value.length) throw new Error(`print.render: ${name} contains duplicate IDs`);
    return value;
}

function pageSelection(value, defaultValue = null) {
    if (value === undefined) return defaultValue;
    if (!Array.isArray(value) || value.length === 0 || value.some((page) => !Number.isInteger(page) || page < 1)) {
        throw new Error('print: pages must be a non-empty array of positive 1-based integers');
    }
    return [...new Set(value)].sort((a, b) => a - b);
}

function previewWidth(value) {
    const width = value ?? conf.previewWidth;
    if (!Number.isInteger(width) || width < 320 || width > 3000) throw new Error('print: width must be an integer from 320 to 3000');
    return width;
}

function pdfiumDir() {
    return path.isAbsolute(conf.pdfiumPath) ? conf.pdfiumPath : path.resolve(PROJECT_ROOT, conf.pdfiumPath);
}

async function rasterize(pdfPath, folder, pages, width) {
    const onlyPages = pages ? pages.map((page) => page - 1) : [];
    const limit = pages ? pages.length : conf.maxPages + 1;
    const job = { pdfPath, outputDir: folder, dllDir: pdfiumDir(), width, limit, onlyPages };
    const rendered = await new Promise((resolve, reject) => {
        const child = fork(path.join(__dirname, 'pdfium-worker.js'), { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`print.preview: PDFium worker timed out after ${conf.previewTimeoutMs}ms`));
        }, conf.previewTimeoutMs);
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.once('message', (message) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (message.ok) resolve(message.pages);
            else reject(new Error(message.error));
        });
        child.once('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`print.preview: PDFium worker exited (${code})${stderr ? `: ${stderr.trim()}` : ''}`));
        });
        child.send(job);
    });
    if (pages && rendered.length !== pages.length) {
        const found = new Set(rendered.map((page) => page.page));
        const missing = pages.filter((page) => !found.has(page));
        throw new Error(`print.preview: page(s) out of range: ${missing.join(', ')}`);
    }
    if (!pages && rendered.length > conf.maxPages) {
        throw new Error(`print.render: PDF exceeds the ${conf.maxPages}-page preview limit; raise agents.print.maxPages`);
    }
    return rendered.map((page) => {
        const absolute = path.join(folder, page.filename);
        return { page: page.page, path: storageRelative(absolute), absolute };
    });
}

export function chromeTemplate(html, slot, margin, style) {
    if (!html) return '<div></div>';
    // A background on the template's html/body paints the entire PDF page and
    // hides the document. Only the chrome containers may carry a background.
    const font = style === 'classic' ? 'Georgia,serif' : style === 'minimal' ? 'Arial,sans-serif' : '"Segoe UI",Arial,sans-serif';
    const withPageFields = html
        .replaceAll('{{pages}}', '<span class="totalPages"></span>')
        .replaceAll('{{page}}', '<span class="pageNumber"></span>');
    return `<!doctype html><html><head><style>
html,body{margin:0;padding:0;background:transparent;font-family:${font};font-size:8px;color:#58646c;print-color-adjust:exact;-webkit-print-color-adjust:exact}
.print-chrome{box-sizing:border-box;width:100%;line-height:1.25;letter-spacing:.025em;background:#e2e6e9!important}
.print-chrome *{box-sizing:border-box;margin:0;padding:0;border:0;font:inherit;color:inherit;background:transparent}
.print-chrome .header,.print-chrome .footer{width:100%;padding:3mm ${margin.right} 3mm ${margin.left};background:#e2e6e9!important}
.print-chrome .header{text-align:left;border-bottom:.6px solid #c4cfd6;margin-top:-${conf.chromeInsetMm}mm;padding-top:calc(3mm + ${conf.chromeInsetMm}mm)}
.print-chrome .header p+p{margin-top:1mm;color:#737d84;font-size:7.5px}
.print-chrome .header p:first-child{font-size:9px;font-weight:600}
.print-chrome .footer{display:flex;justify-content:space-between;gap:12px;text-align:left;border-top:.6px solid #d2d9de;margin-bottom:-${conf.chromeInsetMm}mm;padding-bottom:calc(3mm + ${conf.chromeInsetMm}mm)}
.print-chrome .footer .nui-blocks-block{display:flex;justify-content:space-between;gap:12px;width:100%}
.print-chrome .footer p:last-child{text-align:right;white-space:nowrap}
</style></head><body><div class="print-chrome"><div class="${slot}">${withPageFields}</div></div></body></html>`;
}

const PAGE_SIZES_MM = {
    A4: [210, 297],
    A5: [148, 210],
    Letter: [215.9, 279.4],
    Legal: [215.9, 355.6]
};
const PX_PER_MM = 96 / 25.4;

function lengthToMm(value) {
    const match = /^(\d+(?:\.\d+)?)(mm|cm|in|px)$/.exec(value);
    if (!match) throw new Error(`print.render: cannot convert margin "${value}" to millimetres`);
    const amount = Number(match[1]);
    return amount * ({ mm: 1, cm: 10, in: 25.4, px: 1 / PX_PER_MM }[match[2]]);
}

function pageDimensions(options) {
    const [width, height] = PAGE_SIZES_MM[options.format];
    return options.orientation === 'landscape' ? [height, width] : [width, height];
}

async function measureChrome(browser, html, slot, options) {
    if (!html) return 0;
    const [pageWidth] = pageDimensions(options);
    const measure = await browser.newPage();
    try {
        await measure.setViewport({ width: Math.round(pageWidth * PX_PER_MM), height: 600 });
        await measure.setContent(chromeTemplate(html, slot, options.margin, options.style), { waitUntil: 'load' });
        const height = await measure.$eval('.print-chrome', (element) => element.getBoundingClientRect().height);
        // Negative margins extend the bleed visually but do not cancel the added
        // padding in getBoundingClientRect(); remove that padding for page fitting.
        return Math.max(0, height / PX_PER_MM - conf.chromeInsetMm);
    } finally {
        await measure.close();
    }
}

async function fitChrome(page, browser, rendered) {
    const options = rendered.options;
    const [, pageHeight] = pageDimensions(options);
    for (const [slot, side] of [['header', 'top'], ['footer', 'bottom']]) {
        const height = await measureChrome(browser, rendered.chrome[slot], slot, options);
        if (!height) continue;
        const required = height + conf.chromeInsetMm + conf.chromeGapMm;
        if (required > pageHeight * conf.maxChromeFraction) {
            throw new Error(`print.render: ${slot} needs ${required.toFixed(1)}mm including body gap, exceeding the ${(conf.maxChromeFraction * 100).toFixed(0)}% page-height limit`);
        }
        if (required > lengthToMm(options.margin[side])) options.margin[side] = `${required.toFixed(2)}mm`;
    }
    await page.addStyleTag({
        content: `@page { size: ${options.format} ${options.orientation}; margin: ${options.margin.top} ${options.margin.right} ${options.margin.bottom} ${options.margin.left}; }`
    });
}

function imageContent(previews) {
    return previews.map((preview) => ({
        type: 'image',
        data: fs.readFileSync(preview.absolute).toString('base64'),
        mimeType: 'image/png'
    }));
}

// Marker spans are absolutely positioned, so the probe PDF and the final PDF
// paginate identically — which makes a text search on the probe a valid
// geometry probe for the delivered pages, not just a page-number lookup.
async function locateTargets(pdfBytes, targets) {
    const marked = targets.filter((target) => target.marker);
    if (!marked.length) return null;

    const native = require('../../../nConvert/napi/index.js');
    const found = JSON.parse(await native.searchText(
        pdfBytes,
        pdfiumDir(),
        marked.map((target) => target.marker),
        conf.maxPages + 1
    ));
    const boxes = new Map(found.pages.map((box) => [box.page, box]));
    const hits = new Map(found.hits.map((hit) => [hit.query, hit]));

    for (const target of marked) {
        const hit = hits.get(target.marker);
        if (!hit) continue;
        const box = boxes.get(hit.page);
        target.page = hit.page;
        target.y = Math.round((hit.y / box.height) * 10000) / 10000;
        target.pageWidth = Math.round(box.width * 100) / 100;
        target.pageHeight = Math.round(box.height * 100) / 100;
    }

    const missing = marked.filter((target) => !target.page);
    if (missing.length) {
        if (process.env.PRINT_PROBE_PDF) fs.writeFileSync(process.env.PRINT_PROBE_PDF, pdfBytes);
        throw new Error(`print.render: could not locate semantic target(s) in the PDF text layer: ${missing.map((target) => target.id).join(', ')}`);
    }
    return found.pages.length;
}

function targetLines(targets) {
    if (!targets.length) return ['Break targets: none (add id= to MD-Blocks directives to create semantic targets)'];
    return [
        `Break targets (${targets.length}):`,
        ...targets.map((target) => `  ${target.id}  ${target.kind}${target.preset ? `/${target.preset}` : ''}${target.heading ? ` — ${target.heading}` : ''}`)
    ];
}

const BREAK_CLASS = { breakBefore: 'nui-print-break-before', breakAfter: 'nui-print-break-after' };

async function printPdf(page, rendered) {
    return page.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: Boolean(rendered.chrome.header || rendered.chrome.footer),
        headerTemplate: chromeTemplate(rendered.chrome.header, 'header', rendered.options.margin, rendered.options.style),
        footerTemplate: chromeTemplate(rendered.chrome.footer, 'footer', rendered.options.margin, rendered.options.style)
    });
}

// Rewrites break classes in place. Reusing a loaded page is what makes a break
// toggle cheap: the markdown parse, font loading and image decoding that cost
// ~1.3 s happen once per document, not once per click. The checks mirror
// page.js so an unknown ID fails the same way whether it arrives at load or
// during a warm render.
async function applyBreaks(page, options) {
    await page.evaluate(({ breakBefore, breakAfter, breakClass }) => {
        for (const element of document.querySelectorAll(`.${breakClass.breakBefore}, ${breakClass.breakAfter}`)) {
            element.classList.remove(breakClass.breakBefore, breakClass.breakAfter);
        }
        for (const [ids, className] of [[breakBefore, breakClass.breakBefore], [breakAfter, breakClass.breakAfter]]) {
            for (const id of ids) {
                const matches = [...document.querySelectorAll('[id]')].filter((element) => element.id === id);
                if (matches.length !== 1) {
                    throw new Error(`print.render: break target "${id}" resolves to ${matches.length} elements; expected exactly one MD-Blocks ID`);
                }
                matches[0].classList.add(className);
            }
        }
    }, {
        breakBefore: options.breakBefore ?? [],
        breakAfter: options.breakAfter ?? [],
        breakClass: BREAK_CLASS
    });
}

async function openPrintPage({ source, baseDir, options }) {
    const token = crypto.randomUUID();
    jobs.set(token, { token, source, options, baseDir });
    const started = Date.now();
    const marks = {};
    const stamp = (name) => { marks[name] = Date.now() - started; };
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        stamp('chromeLaunch');
        const page = await browser.newPage();
        const warnings = [];
        page.on('console', (message) => {
            if (message.type() === 'warning' || message.type() === 'error') warnings.push(`${message.type()}: ${message.text()}`);
        });
        page.on('pageerror', (error) => warnings.push(`pageerror: ${error.message}`));
        await page.setViewport({ width: 1280, height: 960 });
        await page.emulateMediaType('print');
        // domcontentloaded, not networkidle0: the render page sets
        // __PRINT_RESULT__ only after fonts and images are settled, so waiting
        // for it is stricter — networkidle0 only added its 500 ms idle window.
        await page.goto(`http://127.0.0.1:${serverPort}/render/${token}?skip-init`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        stamp('pageLoad');
        await page.waitForFunction(() => window.__PRINT_RESULT__ || window.__PRINT_ERROR__, { timeout: 60000 });
        const renderError = await page.evaluate(() => window.__PRINT_ERROR__);
        if (renderError) throw new Error(renderError);
        const rendered = await page.evaluate(() => window.__PRINT_RESULT__);
        if (!rendered) throw new Error('print.render: NUI renderer returned no result');
        stamp('rendered');

        if (rendered.chrome.header || rendered.chrome.footer) {
            await fitChrome(page, browser, rendered);
            stamp('chromeFit');
        }
        return { token, browser, page, rendered, warnings, marks, startedAt: started };
    } catch (error) {
        jobs.delete(token);
        if (browser) await browser.close().catch(() => {});
        throw error;
    }
}

async function paginate(runtime, source, options, { preview, requestedPages, width, outputFolder, name, sourcePath, warm }) {
    const { page, rendered } = runtime;
    const started = warm ? Date.now() : runtime.startedAt;
    const timings = {};
    const mark = (phase) => { timings[phase] = Date.now() - started; };
    if (warm) {
        timings.layout = 0;
    } else {
        timings.launch = runtime.marks.chromeLaunch;
        timings.load = runtime.marks.pageLoad;
        timings.rendered = runtime.marks.rendered;
        timings.layout = runtime.marks.chromeFit ?? runtime.marks.rendered;
    }
    const warningStart = runtime.warnings.length;

    // A page resolves its own breaks from frontmatter + the request when it
    // loads; only an explicit array means "replace them now". Without this a
    // warm render with no break arguments would wipe the authored breaks.
    if (options.breakBefore !== undefined || options.breakAfter !== undefined) await applyBreaks(page, options);
    const effective = {
        ...rendered.options,
        breakBefore: options.breakBefore ?? rendered.options.breakBefore,
        breakAfter: options.breakAfter ?? rendered.options.breakAfter
    };
    let pdfBytes = await printPdf(page, rendered);
    mark('pdf');
    let mappedPageCount = null;
    if (options.mapTargets) {
        mappedPageCount = await locateTargets(pdfBytes, rendered.targets);
        mark('geometry');
        // display:none keeps the markers out of the text layer without touching
        // layout, so the delivered PDF stays free of probe text.
        await page.evaluate(() => document.body.classList.add('print-deliver'));
        try {
            pdfBytes = await printPdf(page, rendered);
        } finally {
            await page.evaluate(() => document.body.classList.remove('print-deliver'));
        }
        mark('pdfFinal');
    }

    const folder = outputFolder ? path.resolve(outputFolder) : uniqueFolder(slugify(name ?? (sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : 'document')));
    const pdfPath = path.join(folder, 'document.pdf');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(pdfPath, pdfBytes);

    let previews = [];
    if (preview) {
        if (outputFolder) fs.rmSync(path.join(folder, 'pages'), { recursive: true, force: true });
        previews = await rasterize(pdfPath, path.join(folder, 'pages'), null, previewWidth(width));
    }
    mark('raster');
    const pageCount = preview ? previews.length : null;
    if (mappedPageCount !== null && preview && pageCount !== mappedPageCount) {
        throw new Error(`print.render: target mapping changed pagination (${mappedPageCount} marked pages, ${pageCount} final pages)`);
    }
    const selected = preview
        ? (requestedPages ?? previews.slice(0, conf.inlinePreviewLimit).map((item) => item.page))
        : [];
    const missing = selected.filter((number) => !previews.some((item) => item.page === number));
    if (missing.length) throw new Error(`print.render: requested preview page(s) out of range: ${missing.join(', ')}`);

    const manifest = {
        source: sourcePath ?? null,
        sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
        renderer: 'nui_wc2/NUI/nui.js',
        createdAt: new Date().toISOString(),
        pdf: storageRelative(pdfPath),
        pageCount,
        options: effective,
        chrome: rendered.chrome,
        breakBefore: effective.breakBefore,
        breakAfter: effective.breakAfter,
        targets: rendered.targets.map(({ marker, ...target }) => target),
        previews: previews.map(({ page: number, path: previewPath }) => ({ page: number, path: previewPath })),
        timings,
        warnings: runtime.warnings.slice(warningStart)
    };
    const manifestPath = path.join(folder, 'render.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifest, manifestPath, previews, selected };
}

// A render session owns one Chromium page for one document. Break-only changes
// reuse that page; anything that alters layout (source text, style, format,
// orientation, section-per-page) reloads it, because those are baked into the
// page at load time.
export async function createRenderSession(args = {}) {
    if (Boolean(args.path) === Boolean(args.markdown)) throw new Error('print.render: provide exactly one of path or markdown');
    const sourcePath = args.path ? resolveExisting(args.path, 'print.render') : null;
    const baseDir = sourcePath ? path.dirname(sourcePath) : resolveBase(args.basePath);
    const mapTargets = Boolean(args._mapTargets);
    let runtime = null;
    let signature = null;

    const close = async () => {
        if (!runtime) return;
        const current = runtime;
        runtime = null;
        signature = null;
        jobs.delete(current.token);
        await current.browser.close().catch(() => {});
    };

    const ensure = async (options) => {
        const source = sourcePath ? fs.readFileSync(sourcePath, 'utf8') : args.markdown;
        if (typeof source !== 'string' || !source.trim()) throw new Error('print.render: source Markdown is empty');
        const sha = crypto.createHash('sha256').update(source).digest('hex');
        if (runtime && (runtime.page.isClosed() || runtime.browser.connected === false)) await close();
        // Unspecified options mean "whatever this page already resolved", so an
        // open that named no style and a later render that names the resolved
        // one are the same page, not a reason to reload.
        const resolved = runtime?.rendered.options;
        const signatureFor = (style, format, orientation, sectionPages) => JSON.stringify([sha, style, format, orientation, sectionPages]);
        const next = signatureFor(
            options.style ?? resolved?.style,
            options.format ?? resolved?.format,
            options.orientation ?? resolved?.orientation,
            options.sectionPages ?? resolved?.sectionPages
        );
        const warm = Boolean(runtime) && next === signature;
        if (runtime && !warm) await close();
        if (!runtime) {
            runtime = await openPrintPage({ source, baseDir, options });
            const pageOptions = runtime.rendered.options;
            signature = signatureFor(pageOptions.style, pageOptions.format, pageOptions.orientation, pageOptions.sectionPages);
        }
        return { source, warm };
    };

    return {
        async render(options, extra = {}) {
            const merged = { ...options, mapTargets };
            const { source, warm } = await ensure(merged);
            return paginate(runtime, source, merged, { ...extra, sourcePath, warm });
        },
        close
    };
}

export async function renderDocument(args = {}) {
    const preview = args.preview !== false;
    const requestedPages = pageSelection(args.pages);
    if (!preview && requestedPages) throw new Error('print.render: pages requires preview=true');
    const options = {
        style: args.style,
        format: args.format,
        orientation: args.orientation,
        margin: args.margin,
        sectionPages: args.sectionPages,
        breakBefore: args.breakBefore === undefined ? undefined : stringArray(args.breakBefore, 'breakBefore'),
        breakAfter: args.breakAfter === undefined ? undefined : stringArray(args.breakAfter, 'breakAfter'),
        mapTargets: Boolean(args._mapTargets)
    };
    const session = await createRenderSession(args);
    try {
        return await session.render(options, {
            preview,
            requestedPages,
            width: args.width,
            outputFolder: args._outputFolder,
            name: args.name
        });
    } finally {
        await session.close();
    }
}

export async function print_render(args = {}) {
    const { manifest, manifestPath, previews, selected } = await renderDocument(args);
    const lines = [
        `PDF       ${manifest.pdf}`,
        `manifest  ${storageRelative(manifestPath)}`,
        `pages     ${manifest.pageCount ?? 'not rasterized (preview=false)'}`,
        `format    ${manifest.options.format} ${manifest.options.orientation}`,
        `style     ${manifest.options.style}`,
        `margins   top=${manifest.options.margin.top} bottom=${manifest.options.margin.bottom} (auto-fitted to chrome)`,
        `breaks    before=[${manifest.breakBefore.join(', ')}] after=[${manifest.breakAfter.join(', ')}] sectionPages=${manifest.options.sectionPages}`
    ];
    if (manifest.pageCount !== null) {
        const previewFolder = path.dirname(manifest.previews[0].path).replaceAll('\\', '/');
        lines.push(`previews  ${previewFolder} (inline: ${selected.join(', ')})`);
    }
    lines.push('', ...targetLines(manifest.targets));
    if (manifest.warnings.length) lines.push('', 'Renderer warnings:', ...manifest.warnings.map((warning) => `  ${warning}`));

    const inline = previews.filter((item) => selected.includes(item.page));
    return { content: [{ type: 'text', text: lines.join('\n') }, ...imageContent(inline)], isError: false };
}

export async function print_preview(args = {}) {
    const pdfPath = resolveExisting(args.path, 'print.preview');
    const pdfBytes = fs.readFileSync(pdfPath);
    if (pdfBytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`print.preview: not a PDF: ${args.path}`);
    const pages = pageSelection(args.pages, [1]);
    const folder = uniqueFolder(slugify(args.name ?? `preview-${path.basename(pdfPath, path.extname(pdfPath))}`));
    let previews;
    try {
        previews = await rasterize(pdfPath, folder, pages, previewWidth(args.width));
    } catch (error) {
        fs.rmSync(folder, { recursive: true, force: true });
        throw error;
    }
    const lines = [
        `PDF       ${args.path}`,
        `previews  ${storageRelative(folder)}`,
        ...previews.map((preview) => `  page ${preview.page}: ${preview.path}`)
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }, ...imageContent(previews)], isError: false };
}
