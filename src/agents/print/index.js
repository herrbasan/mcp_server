import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import puppeteer from 'puppeteer';

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
    return { status: 'initialized', folder: conf.folder };
}

export async function shutdown() {
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

function targetLines(targets) {
    if (!targets.length) return ['Break targets: none (add id= to MD-Blocks directives to create semantic targets)'];
    return [
        `Break targets (${targets.length}):`,
        ...targets.map((target) => `  ${target.id}  ${target.kind}${target.preset ? `/${target.preset}` : ''}${target.heading ? ` — ${target.heading}` : ''}`)
    ];
}

export async function print_render(args = {}) {
    if (Boolean(args.path) === Boolean(args.markdown)) throw new Error('print.render: provide exactly one of path or markdown');
    const sourcePath = args.path ? resolveExisting(args.path, 'print.render') : null;
    const source = sourcePath ? fs.readFileSync(sourcePath, 'utf8') : args.markdown;
    if (typeof source !== 'string' || !source.trim()) throw new Error('print.render: source Markdown is empty');
    const baseDir = sourcePath ? path.dirname(sourcePath) : resolveBase(args.basePath);
    const preview = args.preview !== false;
    const requestedPages = pageSelection(args.pages);
    if (!preview && requestedPages) throw new Error('print.render: pages requires preview=true');

    const options = {
        style: args.style,
        format: args.format,
        orientation: args.orientation,
        margin: args.margin,
        sectionPages: args.sectionPages,
        breakBefore: stringArray(args.breakBefore, 'breakBefore'),
        breakAfter: stringArray(args.breakAfter, 'breakAfter')
    };
    const token = crypto.randomUUID();
    jobs.set(token, { token, source, options, baseDir });

    let browser;
    let folder;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        const warnings = [];
        page.on('console', (message) => {
            if (message.type() === 'warning' || message.type() === 'error') warnings.push(`${message.type()}: ${message.text()}`);
        });
        page.on('pageerror', (error) => warnings.push(`pageerror: ${error.message}`));
        await page.setViewport({ width: 1280, height: 960 });
        await page.emulateMediaType('print');
        await page.goto(`http://127.0.0.1:${serverPort}/render/${token}?skip-init`, { waitUntil: 'networkidle0', timeout: 60000 });
        await page.waitForFunction(() => window.__PRINT_RESULT__ || window.__PRINT_ERROR__, { timeout: 60000 });
        const renderError = await page.evaluate(() => window.__PRINT_ERROR__);
        if (renderError) throw new Error(renderError);
        const rendered = await page.evaluate(() => window.__PRINT_RESULT__);
        if (!rendered) throw new Error('print.render: NUI renderer returned no result');

        const hasChrome = Boolean(rendered.chrome.header || rendered.chrome.footer);
        if (hasChrome) await fitChrome(page, browser, rendered);
        const pdfBytes = await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: hasChrome,
            headerTemplate: chromeTemplate(rendered.chrome.header, 'header', rendered.options.margin, rendered.options.style),
            footerTemplate: chromeTemplate(rendered.chrome.footer, 'footer', rendered.options.margin, rendered.options.style)
        });

        folder = uniqueFolder(slugify(args.name ?? (sourcePath ? path.basename(sourcePath, path.extname(sourcePath)) : 'document')));
        const pdfPath = path.join(folder, 'document.pdf');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(pdfPath, pdfBytes);

        let previews = [];
        if (preview) previews = await rasterize(pdfPath, path.join(folder, 'pages'), null, previewWidth(args.width));
        const pageCount = preview ? previews.length : null;
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
            options: rendered.options,
            chrome: rendered.chrome,
            breakBefore: options.breakBefore,
            breakAfter: options.breakAfter,
            targets: rendered.targets,
            previews: previews.map(({ page: number, path: previewPath }) => ({ page: number, path: previewPath })),
            warnings
        };
        const manifestPath = path.join(folder, 'render.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

        const lines = [
            `PDF       ${storageRelative(pdfPath)}`,
            `manifest  ${storageRelative(manifestPath)}`,
            `pages     ${pageCount ?? 'not rasterized (preview=false)'}`,
            `format    ${rendered.options.format} ${rendered.options.orientation}`,
            `style     ${rendered.options.style}`,
            `margins   top=${rendered.options.margin.top} bottom=${rendered.options.margin.bottom} (auto-fitted to chrome)`,
            `breaks    before=[${options.breakBefore.join(', ')}] after=[${options.breakAfter.join(', ')}] sectionPages=${rendered.options.sectionPages}`
        ];
        if (preview) lines.push(`previews  ${storageRelative(path.join(folder, 'pages'))} (inline: ${selected.join(', ')})`);
        lines.push('', ...targetLines(rendered.targets));
        if (warnings.length) lines.push('', 'Renderer warnings:', ...warnings.map((warning) => `  ${warning}`));

        const inline = previews.filter((item) => selected.includes(item.page));
        return { content: [{ type: 'text', text: lines.join('\n') }, ...imageContent(inline)], isError: false };
    } finally {
        jobs.delete(token);
        if (browser) await browser.close();
    }
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
