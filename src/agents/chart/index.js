// Diagrams as SVG, from a semantic spec. The renderer is vendored as a submodule
// (src/nCharts) and imported directly — it is zero-dependency ESM with no build
// step, so there is nothing to install and no version to drift.
//
// Three tools, one idea: the caller supplies meaning, nCharts supplies geometry.
//   chart_guide  — the spec contract, so a caller never guesses a field name
//   chart_render — spec -> SVG; with text:false, the textless base
//   chart_hybrid — SVG -> base -> image model restyle -> vector text on top
//
// The hybrid exists because diffusion cannot preserve lettering: it generates
// glyph-shaped marks (measured, see src/nCharts/docs/HYBRID.md). The words stay
// vector; the model only touches the surface.
//
// Two rules shape the agent:
//   1. The spec travels as an object, not as a file. The chat hemisphere has no
//      filesystem, so a path-based signature would be unusable there.
//   2. The response names files, it does not carry them. A diagram is ~20 KB of
//      markup; the preview raster is what a reader actually needs to see.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getLogger } from '../../utils/logger.js';
import { render, audit, check, CONTRACT, variantSvg, geometryBase } from '../../nCharts/src/index.js';

const logger = getLogger();

let storageRoot;
let chartDir;
let nMediaUrl;
let gatewayHttp;
let gatewayKey;
let previewSize;
let hybridSize;
let hybridTimeoutMs;
let driftFloor;
let presets;
let hybridModels;
let defaultPreset;

export async function init(context) {
    storageRoot = context.config.agents?.storage?.root;
    if (!storageRoot) throw new Error('[chart] config agents.storage.root is required');
    nMediaUrl = context.config.nMediaUrl ?? 'http://localhost:3500';

    const conf = context.config.agents?.chart ?? {};
    chartDir = conf.folder ?? 'charts';
    previewSize = conf.previewSize ?? 1600;
    hybridSize = conf.hybridSize ?? 1920;
    hybridTimeoutMs = conf.hybridTimeoutMs ?? 180000;
    driftFloor = conf.driftFloor ?? 0.55;

    gatewayHttp = context.config.gateway?.httpUrl ?? 'http://localhost:3400';
    gatewayKey = context.config.gateway?.accessKey ?? null;

    presets = conf.presets ?? {};
    defaultPreset = conf.defaultPreset ?? 'handdrawn';
    if (!presets[defaultPreset]) {
        throw new Error(`[chart] agents.chart.presets.${defaultPreset} is required — it is the default preset`);
    }
    for (const [name, preset] of Object.entries(presets)) {
        if (typeof preset?.prompt !== 'string' || preset.prompt.length === 0) {
            throw new Error(`[chart] agents.chart.presets.${name}.prompt must be a non-empty string`);
        }
    }

    hybridModels = conf.hybridModels ?? [];
    if (!Array.isArray(hybridModels) || hybridModels.length === 0) {
        throw new Error('[chart] agents.chart.hybridModels must list at least one image model, local first');
    }

    fs.mkdirSync(path.join(storageRoot, chartDir), { recursive: true });
    return { status: 'initialized', chartDir, previewSize, defaultPreset, hybridModels };
}

const EXAMPLES = new URL('../../nCharts/examples/', import.meta.url);

function exampleNames() {
    return fs.readdirSync(EXAMPLES)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.basename(f, '.json'))
        .sort();
}

function slugify(text) {
    return String(text).toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim().split(/\s+/).slice(0, 6).join('-')
        .replace(/-+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'chart';
}

function localTimestamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function uniqueBase(slug) {
    const dir = path.join(storageRoot, chartDir);
    const stamp = localTimestamp();
    let candidate = `${stamp}_${slug}`;
    let i = 2;
    // Both sidecars count: a render writes <base>.json, a hybrid writes
    // <base>-hybrid.json. Checking one lets two hybrids in the same minute
    // overwrite each other.
    const taken = (name) => fs.existsSync(path.join(dir, `${name}.json`)) || fs.existsSync(path.join(dir, `${name}-hybrid.json`));
    while (taken(candidate)) candidate = `${stamp}_${slug}-${i++}`;
    return candidate;
}

const TEXT_ELEMENT = /<text\b[^>]*>[\s\S]*?<\/text>/g;
const SHAPE_ELEMENT = /<(?:rect|circle|ellipse|line|polygon|polyline|path|image|use)\b[^>]*\/?>(?:<\/image>)?/g;

function stripDataUri(value) {
    const m = /^data:[^;]+;base64,(.*)$/s.exec(value);
    return m ? m[1] : value;
}

// nMedia's base64 route. One endpoint for both jobs: hand it an SVG and it
// rasterizes through Chrome; hand it a raster and it transcodes.
async function nmediaProcess(base64, { format, maxDimension, quality } = {}) {
    const res = await fetch(`${nMediaUrl}/v1/process/image`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            base64,
            format,
            ...(maxDimension ? { max_dimension: maxDimension } : {}),
            ...(quality ? { quality } : {}),
            response_type: 'base64'
        })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`nMedia ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    const payload = json.data ?? json;
    if (!payload.base64) throw new Error('nMedia returned no image');
    return { buf: Buffer.from(stripDataUri(payload.base64), 'base64'), width: payload.width, height: payload.height };
}

// nMedia's color_scheme option is accepted and ignored on this route — measured:
// light and dark requests return identical bytes. So the scheme is resolved in
// the SVG first. A document with no dark block simply rasterizes as it is.
async function previewRaster(svg, theme) {
    const resolved = variantSvg(svg, theme === 'dark' ? 'dark' : 'light');
    return nmediaProcess(Buffer.from(resolved, 'utf8').toString('base64'), {
        format: 'webp',
        maxDimension: previewSize,
        quality: 90
    });
}

function canvasSize(svg) {
    const m = /<svg\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/.exec(svg);
    if (!m) throw new Error('chart: the SVG needs width and height attributes — the backdrop is placed against them');
    return { width: Number(m[1]), height: Number(m[2]) };
}

// What the image model is given: the drawing without its type, on a page colour
// (an SVG with no background rasterizes to transparency and the model invents a
// ground for it) and, for nCharts documents, with uniformly weighted strokes (at
// stroke 1 a downscaled base reads as scratches, so the model loses the shape).
function prepareBase(svg, strength) {
    if (/<svg\b[^>]*class="nc"/.test(svg)) return geometryBase(svg, strength ?? 2.5);

    const { width, height } = canvasSize(svg);
    const ground = `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`;
    const weighted = strength ? `<style>[stroke]{stroke-width:${strength}}</style>` : '';
    return svg
        .replace(TEXT_ELEMENT, '')
        .replace(/<svg\b[^>]*>/, (tag) => `${tag}\n${ground}${weighted}`);
}

// Vector type over a raster surface. Every drawing element goes — the backdrop
// takes its place — and the image is inserted before the body so the text paints
// on top of it. `slice` crops the sampler's 64-pixel rounding instead of
// stretching it, which would slide the shapes out from under the words.
//
// The edge-label chips are the exception. A chip is a background rect whose only
// job is to read as a gap in the wire behind a word — it belongs to the text
// layer, not to the drawing. Stripped, every label sits straight on the
// hand-drawn line; at denoise 0.3 the model reproduced the chips itself so the
// gap survived by luck, and at 0.45 it stopped. They are put back under the text.
const NC_CHIP = /<rect\b[^>]*class="nc-chip"[^>]*\/>/g;

function compositeHybrid(svg, href) {
    const { width, height } = canvasSize(svg);
    const chips = svg.match(NC_CHIP) ?? [];
    const image = `<image href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`;
    const layer = [image, ...chips].join('\n');
    const textOnly = svg.replace(SHAPE_ELEMENT, '');
    if (textOnly.includes('</defs>')) return textOnly.replace('</defs>', () => `</defs>\n${layer}`);
    return textOnly.replace(/<svg\b[^>]*>/, (tag) => `${tag}\n${layer}`);
}

// ── Drift audit ─────────────────────────────────────────────────────────────
// The geometry audit is the oracle for layout; this is the oracle for the
// surface. A restyle that moves the boxes leaves the vector type sitting off its
// shapes, which is invisible until someone looks. Comparing ink coverage per grid
// cell turns that into a number.
//
// A minimal PNG reader: 8-bit, non-interlaced — what Chrome and the image models
// emit. Anything else is refused by name rather than guessed at.
function pngInk(buf) {
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('chart audit: not a PNG');
    let pos = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette = null;
    const idat = [];

    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'PLTE') palette = data;
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (depth !== 8) throw new Error(`chart audit: PNG bit depth ${depth} — 8 expected`);
    if (interlace !== 0) throw new Error('chart audit: interlaced PNG is not supported');
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error(`chart audit: PNG colour type ${colorType} is not supported`);
    if (colorType === 3 && !palette) throw new Error('chart audit: palette PNG without PLTE');

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const pixels = Buffer.alloc(stride * height);
    let prev = Buffer.alloc(stride);
    let p = 0;

    for (let y = 0; y < height; y += 1) {
        const filter = raw[p];
        p += 1;
        const cur = Buffer.from(raw.subarray(p, p + stride));
        p += stride;
        for (let i = 0; i < stride; i += 1) {
            const a = i >= channels ? cur[i - channels] : 0;
            const b = prev[i];
            const c = i >= channels ? prev[i - channels] : 0;
            let v = cur[i];
            if (filter === 1) v = (v + a) & 255;
            else if (filter === 2) v = (v + b) & 255;
            else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
            else if (filter === 4) {
                const pa = Math.abs(b - c);
                const pb = Math.abs(a - c);
                const pc = Math.abs(a + b - 2 * c);
                v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
            } else if (filter !== 0) throw new Error(`chart audit: PNG filter ${filter} is not supported`);
            cur[i] = v;
        }
        cur.copy(pixels, y * stride);
        prev = cur;
    }

    const ink = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
        const o = i * channels;
        let r;
        let g;
        let b;
        if (colorType === 3) {
            const idx = pixels[o] * 3;
            r = palette[idx];
            g = palette[idx + 1];
            b = palette[idx + 2];
        } else if (colorType === 0 || colorType === 4) {
            r = g = b = pixels[o];
        } else {
            r = pixels[o];
            g = pixels[o + 1];
            b = pixels[o + 2];
        }
        ink[i] = 1 - (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }
    return { width, height, ink };
}

// Ink coverage per cell, on a grid whose aspect matches the image. Coarse on
// purpose: a hand-drawn line wanders a few pixels, and the question is whether
// the boxes are still where the layout put them — not whether the pixels match.
function inkGrid({ width, height, ink }, cols = 16) {
    const rows = Math.max(1, Math.round((cols * height) / width));
    const cell = new Float32Array(cols * rows);
    const cellW = width / cols;
    const cellH = height / rows;
    for (let y = 0; y < height; y += 1) {
        const gy = Math.min(rows - 1, Math.floor(y / cellH));
        for (let x = 0; x < width; x += 1) {
            const gx = Math.min(cols - 1, Math.floor(x / cellW));
            cell[gy * cols + gx] += ink[y * width + x];
        }
    }
    for (let i = 0; i < cell.length; i += 1) cell[i] /= cellW * cellH;
    return { cols, rows, cell };
}

function driftReport(basePng, surfacePng) {
    const a = inkGrid(pngInk(basePng));
    const b = inkGrid(pngInk(surfacePng));
    const n = a.cell.length;
    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < n; i += 1) {
        sumA += a.cell[i];
        sumB += b.cell[i];
    }

    // Correlation, not difference. A restyle adds paper grain, which raises ink
    // everywhere and would swamp an absolute comparison; what has to match is
    // *where* the ink is. Pearson on the cell coverage ignores the global scale.
    const meanA = sumA / n;
    const meanB = sumB / n;
    let covariance = 0;
    let varianceA = 0;
    let varianceB = 0;
    const cells = [];
    for (let i = 0; i < n; i += 1) {
        const x = a.cell[i] - meanA;
        const y = b.cell[i] - meanB;
        covariance += x * y;
        varianceA += x * x;
        varianceB += y * y;
        // The worst-cell list uses each surface's *share* of total ink, so a
        // heavy-texture render does not drown the structural difference.
        const shareA = sumA > 0 ? a.cell[i] / sumA : 0;
        const shareB = sumB > 0 ? b.cell[i] / sumB : 0;
        cells.push({ i, diff: Math.abs(shareA - shareB) });
    }
    const score = varianceA > 0 && varianceB > 0 ? covariance / Math.sqrt(varianceA * varianceB) : 0;
    const worst = cells
        .sort((x, y) => y.diff - x.diff)
        .slice(0, 5)
        .map((c) => ({ x: c.i % a.cols, y: Math.floor(c.i / a.cols), diff: Math.round(c.diff * 1000) / 1000 }));

    return {
        score: Math.round(score * 100) / 100,
        grid: `${a.cols}x${a.rows}`,
        inkBase: Math.round(sumA * 100) / 100,
        inkSurface: Math.round(sumB * 100) / 100,
        worst
    };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function storageFile(tool, filePath) {
    const abs = path.join(storageRoot, filePath);
    if (!abs.startsWith(path.resolve(storageRoot))) throw new Error(`${tool}: path escapes the storage root: ${filePath}`);
    if (!fs.existsSync(abs)) throw new Error(`${tool}: no such file: ${filePath}`);
    return abs;
}

// Local first, cloud only when the local model refuses — the chain is config, not
// code. No size and no aspect_ratio: with an init image the reference defines the
// frame, and sending a size makes some upstreams treat it as authoritative.
async function restyle(reference, { prompt, denoise, steps }) {
    if (!gatewayKey) {
        throw new Error('chart_hybrid: config gateway.accessKey is missing — the image route needs it (chart.guide and chart.render do not)');
    }
    const failures = [];
    for (const model of hybridModels) {
        const body = { model, prompt, input_references: [reference] };
        if (/krea/i.test(model)) body.extra_body = { denoise, steps };
        const started = Date.now();
        try {
            const res = await fetch(`${gatewayHttp}/v1/images/generations`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(gatewayKey ? { authorization: `Bearer ${gatewayKey}` } : {})
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(hybridTimeoutMs)
            });
            const text = await res.text();
            if (!res.ok) {
                failures.push(`${model}: ${res.status} ${text.slice(0, 200)}`);
                logger.warn(`[chart] ${model} refused the restyle (${res.status})`, null, 'Chart');
                continue;
            }
            const json = JSON.parse(text);
            const b64 = json.data?.[0]?.b64_json;
            if (!b64) {
                failures.push(`${model}: response carried no image`);
                logger.warn(`[chart] ${model} returned no image`, null, 'Chart');
                continue;
            }
            const seconds = Math.round((Date.now() - started) / 100) / 10;
            logger.info(`[chart] restyled through ${model} in ${seconds}s`, null, 'Chart');
            return { buf: Buffer.from(stripDataUri(b64), 'base64'), model, seconds, usage: json.usage ?? null };
        } catch (err) {
            failures.push(`${model}: ${err.message}`);
            logger.warn(`[chart] ${model} failed: ${err.message}`, null, 'Chart');
        }
    }
    throw new Error(`chart_hybrid: no image model accepted the restyle —\n  ${failures.join('\n  ')}`);
}

export async function chart_guide(args) {
    const wanted = args?.example;

    if (wanted) {
        const file = new URL(`${slugify(wanted)}.json`, EXAMPLES);
        if (!fs.existsSync(file)) {
            const names = exampleNames();
            throw new Error(`chart_guide: no example "${wanted}". Available: ${names.join(', ')}`);
        }
        return {
            content: [{ type: 'text', text: fs.readFileSync(file, 'utf8') }],
            isError: false
        };
    }

    const text = [
        CONTRACT,
        '',
        '─── Bundled examples ───',
        'Call chart_guide with { example: "<name>" } for a complete working spec.',
        exampleNames().join(', ')
    ].join('\n');

    return { content: [{ type: 'text', text }], isError: false };
}

export async function chart_render(args) {
    let spec = args?.spec;

    if (!spec && args?.specPath) {
        const abs = path.join(storageRoot, args.specPath);
        if (!abs.startsWith(path.resolve(storageRoot))) throw new Error('chart_render: specPath escapes the storage root');
        if (!fs.existsSync(abs)) throw new Error(`chart_render: no such spec: ${args.specPath}`);
        spec = JSON.parse(fs.readFileSync(abs, 'utf8'));
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        throw new Error('chart_render: "spec" (object) or "specPath" is required — see chart_guide');
    }

    // Audit before writing: a diagram that overlaps or leaves the canvas is a
    // broken input, and leaving a file behind would present it as a result.
    const report = audit(spec);
    if (!report.ok) {
        return {
            content: [{
                type: 'text',
                text: `chart_render: the spec does not pass the geometry audit, nothing was written.\n\n${report.errors.map((e) => `- ${e}`).join('\n')}\n\nFix these and render again. chart_guide has the field list.`
            }],
            isError: true
        };
    }

    const svg = render(spec);

    // Static rules over the emitted markup. These are renderer bugs, not caller
    // mistakes — an undefined class paints black — so they fail loudly rather than
    // quietly shipping a file.
    const staticReport = check(svg);
    if (!staticReport.ok) {
        throw new Error(`chart_render: the renderer emitted invalid SVG — ${staticReport.errors.join('; ')}`);
    }

    const base = uniqueBase(slugify(args?.name ?? spec.title ?? 'chart'));
    const dir = path.join(storageRoot, chartDir);
    const withText = args?.text !== false;
    const svgPath = path.join(dir, withText ? `${base}.svg` : `${base}-base.svg`);
    const specPath = path.join(dir, `${base}.json`);

    // text:false is the hybrid handoff — the drawing without its type, weighted
    // and pinned to a page colour. geometryBase only *hides* the type (CSS), so it
    // is removed here: a base that still carries text looks like a text layer to
    // chart_hybrid, and the composite would come out wordless. The spec sidecar is
    // still written, because the text layer can only be recovered by re-rendering.
    const svgOut = withText ? svg : geometryBase(svg, args?.strength).replace(TEXT_ELEMENT, '');
    fs.writeFileSync(svgPath, svgOut, 'utf8');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    const rel = (p) => path.relative(storageRoot, p).split(path.sep).join('/');
    const lines = [
        `${base}`,
        `  ${withText ? 'svg ' : 'base'}     ${rel(svgPath)}`,
        `  spec     ${rel(specPath)}`
    ];

    let previewBuf = null;
    if (args?.preview !== false) {
        // nMedia is an outside service, and the diagram is already written. A
        // preview failure is reported in the result rather than thrown, so a
        // caller does not lose a good render because a rasterizer was down.
        try {
            previewBuf = (await previewRaster(svgOut, withText ? args?.theme : 'light')).buf;
            const previewPath = path.join(dir, `${base}${withText ? '' : '-base'}_preview.webp`);
            fs.writeFileSync(previewPath, previewBuf);
            lines.push(`  preview  ${rel(previewPath)}`);
        } catch (err) {
            logger.warn(`[chart] preview failed for ${base}: ${err.message}`, null, 'Chart');
            lines.push(`  preview  FAILED — ${err.message}`);
        }
    }

    if (report.warnings.length) {
        lines.push('', 'Audit warnings — legible, but worth a look:');
        for (const w of report.warnings) lines.push(`  - ${w}`);
    }

    lines.push(
        '',
        withText
            ? `The spec sidecar is the diagram's source: edit it and call chart_render with specPath to re-render.`
            : `This is the textless base. chart_hybrid with specPath "${rel(specPath)}" re-renders the text layer and puts it on a restyled surface.`
    );

    const content = [{ type: 'text', text: lines.join('\n') }];
    if (previewBuf) content.push({ type: 'image', data: previewBuf.toString('base64'), mimeType: 'image/webp' });

    logger.info(`[chart] Wrote ${base}${withText ? '' : ' (textless base)'}${previewBuf ? ' + preview' : ''}`, null, 'Chart');
    return { content, isError: false };
}

// Resolve the SVG a hybrid starts from: a spec (rendered here), an SVG string, or
// a storage path. A base written by chart_render has no text, so it is refused —
// the text layer has to come from a full render.
function resolveSvg(args) {
    let spec = args?.spec;
    if (!spec && args?.specPath) {
        spec = JSON.parse(fs.readFileSync(storageFile('chart_hybrid', args.specPath), 'utf8'));
    }
    if (spec) {
        const report = audit(spec);
        if (!report.ok) {
            throw new Error(`chart_hybrid: the spec does not pass the geometry audit:\n  ${report.errors.join('\n  ')}`);
        }
        return { svg: render(spec), spec };
    }
    let svg = args?.svg;
    if (!svg && args?.svgPath) {
        svg = fs.readFileSync(storageFile('chart_hybrid', args.svgPath), 'utf8');
    }
    if (typeof svg !== 'string' || !/<svg[\s>]/i.test(svg)) {
        throw new Error('chart_hybrid: "spec", "specPath", "svg" or "svgPath" is required');
    }
    if (!/<text\b/.test(svg)) {
        throw new Error('chart_hybrid: this SVG has no <text> elements — it is a textless base, so the words would be lost. Pass the spec (or its sidecar) instead: the text layer is re-rendered from it.');
    }
    return { svg, spec: null };
}

export async function chart_hybrid(args) {
    const presetName = args?.preset ?? defaultPreset;
    const preset = presets[presetName];
    if (!preset) {
        throw new Error(`chart_hybrid: unknown preset "${presetName}". Available: ${Object.keys(presets).join(', ')}`);
    }
    const prompt = typeof args?.prompt === 'string' && args.prompt.length > 0 ? args.prompt : preset.prompt;
    const denoise = args?.denoise ?? preset.denoise ?? 0.45;
    const steps = args?.steps ?? preset.steps ?? 20;
    const theme = args?.theme === 'dark' ? 'dark' : 'light';

    const { svg, spec } = resolveSvg(args);
    const base = uniqueBase(slugify(args?.name ?? spec?.title ?? 'hybrid'));
    const dir = path.join(storageRoot, chartDir);
    const rel = (p) => path.relative(storageRoot, p).split(path.sep).join('/');

    // 1. Textless, weighted base — this is what the model sees, and what the
    // drift audit compares the surface against.
    const baseSvg = prepareBase(svg, args?.strength);
    const baseSvgPath = path.join(dir, `${base}-base.svg`);
    fs.writeFileSync(baseSvgPath, baseSvg, 'utf8');

    const raster = await nmediaProcess(Buffer.from(baseSvg, 'utf8').toString('base64'), {
        format: 'png',
        maxDimension: hybridSize
    });
    const basePngPath = path.join(dir, `${base}-base.png`);
    fs.writeFileSync(basePngPath, raster.buf);

    // 2. The surface: restyled now, or a backdrop kept from an earlier run. Reuse
    // is the cheap path — text edits stop costing a generation, and the picture
    // you approved stops changing under you.
    let surface;
    if (args?.backdropPath) {
        const abs = storageFile('chart_hybrid', args.backdropPath);
        surface = { buf: fs.readFileSync(abs), model: 'saved backdrop', seconds: 0, usage: null, reused: args.backdropPath };
    } else {
        surface = await restyle(`data:image/png;base64,${raster.buf.toString('base64')}`, { prompt, denoise, steps });
    }

    // The audit reads PNG; a saved WebP is normalised first. The PNG on disk is
    // therefore always the bytes that were judged.
    let surfacePng = surface.buf;
    if (!surfacePng.subarray(0, 8).equals(PNG_SIGNATURE)) {
        surfacePng = (await nmediaProcess(surfacePng.toString('base64'), { format: 'png', maxDimension: hybridSize })).buf;
    }
    const backdropPath = path.join(dir, `${base}-backdrop.png`);
    fs.writeFileSync(backdropPath, surfacePng);

    // 3. Embed it as WebP (a photo-like surface: PNG would be several megabytes of
    // base64 in the SVG) and put the vector type back on top.
    const webp = await nmediaProcess(surfacePng.toString('base64'), { format: 'webp', maxDimension: hybridSize, quality: 92 });
    const backdropWebpPath = path.join(dir, `${base}-backdrop.webp`);
    fs.writeFileSync(backdropWebpPath, webp.buf);

    const hybridSvg = compositeHybrid(variantSvg(svg, theme), `data:image/webp;base64,${webp.buf.toString('base64')}`);
    const hybridPath = path.join(dir, `${base}.svg`);
    fs.writeFileSync(hybridPath, hybridSvg, 'utf8');

    // 4. Did the surface stay where the layout is? Type is placed from the
    // original geometry, so a surface that drifted leaves the words off the boxes.
    const drift = driftReport(raster.buf, surfacePng);
    const drifted = drift.score < driftFloor;

    const sidecar = {
        kind: 'hybrid',
        created: new Date().toISOString(),
        preset: presetName,
        prompt,
        denoise,
        steps,
        theme,
        model: surface.model,
        reused: surface.reused ?? null,
        usage: surface.usage,
        seconds: surface.seconds,
        drift,
        spec: spec ?? null,
        files: {
            hybrid: rel(hybridPath),
            preview: rel(path.join(dir, `${base}_preview.webp`)),
            backdrop: rel(backdropWebpPath),
            backdropSource: rel(backdropPath),
            baseSvg: rel(baseSvgPath),
            basePng: rel(basePngPath)
        }
    };
    fs.writeFileSync(path.join(dir, `${base}-hybrid.json`), JSON.stringify(sidecar, null, 2), 'utf8');

    const lines = [
        `${base}  (hybrid, ${presetName}, ${surface.model})`,
        `  svg       ${rel(hybridPath)}`,
        `  backdrop  ${rel(backdropWebpPath)}  (${webp.width}x${webp.height}, from ${surface.model})`,
        `  base      ${rel(baseSvgPath)}`,
        `  meta      ${rel(path.join(dir, `${base}-hybrid.json`))}`,
        `  drift     ${drift.score}  (${drift.grid} grid, ink ${drift.inkBase} → ${drift.inkSurface})`,
        '',
        `The type is vector and pinned to ${theme}; the surface is one raster.`,
        `Re-composite without another model call: pass backdropPath "${rel(backdropPath)}".`
    ];

    if (drifted) {
        lines.push(
            '',
            `DRIFT: the surface moved away from the geometry (${drift.score} < ${driftFloor}). The type is`,
            'placed from the original layout, so the words no longer sit on their shapes.',
            `Worst cells (grid x,y — difference): ${drift.worst.map((c) => `${c.x},${c.y} Δ${c.diff}`).join('  ')}`,
            'Lower denoise (0.35–0.45 holds), or use a preset whose model keeps the structure.'
        );
        logger.warn(`[chart] drift ${drift.score} below floor ${driftFloor} for ${base}`, null, 'Chart');
    }

    let previewBuf = null;
    if (args?.preview !== false) {
        try {
            previewBuf = (await previewRaster(hybridSvg, theme)).buf;
            const previewPath = path.join(dir, `${base}_preview.webp`);
            fs.writeFileSync(previewPath, previewBuf);
            lines.push(`  preview   ${rel(previewPath)}`);
        } catch (err) {
            logger.warn(`[chart] hybrid preview failed for ${base}: ${err.message}`, null, 'Chart');
            lines.push(`  preview   FAILED — ${err.message}`);
        }
    }

    const content = [{ type: 'text', text: lines.join('\n') }];
    if (previewBuf) content.push({ type: 'image', data: previewBuf.toString('base64'), mimeType: 'image/webp' });

    logger.info(`[chart] Wrote hybrid ${base} via ${surface.model}, drift ${drift.score}`, null, 'Chart');
    return { content, isError: drifted };
}
