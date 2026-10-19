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
    while (fs.existsSync(path.join(dir, `${candidate}.json`))) candidate = `${stamp}_${slug}-${i++}`;
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
function compositeHybrid(svg, href) {
    const { width, height } = canvasSize(svg);
    const image = `<image href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`;
    const textOnly = svg.replace(SHAPE_ELEMENT, '');
    if (textOnly.includes('</defs>')) return textOnly.replace('</defs>', () => `</defs>\n${image}`);
    return textOnly.replace(/<svg\b[^>]*>/, (tag) => `${tag}\n${image}`);
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
    if (args?.spec) {
        const report = audit(args.spec);
        if (!report.ok) {
            throw new Error(`chart_hybrid: the spec does not pass the geometry audit:\n  ${report.errors.join('\n  ')}`);
        }
        return { svg: render(args.spec), spec: args.spec };
    }
    let svg = args?.svg;
    if (!svg && args?.svgPath) {
        const abs = path.join(storageRoot, args.svgPath);
        if (!abs.startsWith(path.resolve(storageRoot))) throw new Error('chart_hybrid: svgPath escapes the storage root');
        if (!fs.existsSync(abs)) throw new Error(`chart_hybrid: no such SVG: ${args.svgPath}`);
        svg = fs.readFileSync(abs, 'utf8');
    }
    if (typeof svg !== 'string' || !/<svg[\s>]/i.test(svg)) {
        throw new Error('chart_hybrid: "spec", "svg" or "svgPath" is required');
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
    const denoise = args?.denoise ?? preset.denoise ?? 0.3;
    const steps = args?.steps ?? preset.steps ?? 12;
    const theme = args?.theme === 'dark' ? 'dark' : 'light';

    const { svg, spec } = resolveSvg(args);
    const base = uniqueBase(slugify(args?.name ?? spec?.title ?? 'hybrid'));
    const dir = path.join(storageRoot, chartDir);
    const rel = (p) => path.relative(storageRoot, p).split(path.sep).join('/');

    // 1. Textless, weighted base — this is what the model sees.
    const baseSvg = prepareBase(svg, args?.strength);
    const baseSvgPath = path.join(dir, `${base}-base.svg`);
    fs.writeFileSync(baseSvgPath, baseSvg, 'utf8');

    const raster = await nmediaProcess(Buffer.from(baseSvg, 'utf8').toString('base64'), {
        format: 'png',
        maxDimension: hybridSize
    });
    const basePngPath = path.join(dir, `${base}-base.png`);
    fs.writeFileSync(basePngPath, raster.buf);

    // 2. Restyle the surface. Local model first; the chain is agents.chart.hybridModels.
    const restyled = await restyle(`data:image/png;base64,${raster.buf.toString('base64')}`, { prompt, denoise, steps });
    const backdropPath = path.join(dir, `${base}-backdrop.png`);
    fs.writeFileSync(backdropPath, restyled.buf);

    // 3. Embed it as WebP (a photo-like surface: PNG would be several megabytes of
    // base64 in the SVG) and put the vector type back on top.
    const webp = await nmediaProcess(restyled.buf.toString('base64'), { format: 'webp', maxDimension: hybridSize, quality: 92 });
    const backdropWebpPath = path.join(dir, `${base}-backdrop.webp`);
    fs.writeFileSync(backdropWebpPath, webp.buf);

    const hybridSvg = compositeHybrid(variantSvg(svg, theme), `data:image/webp;base64,${webp.buf.toString('base64')}`);
    const hybridPath = path.join(dir, `${base}.svg`);
    fs.writeFileSync(hybridPath, hybridSvg, 'utf8');

    const sidecar = {
        kind: 'hybrid',
        created: new Date().toISOString(),
        preset: presetName,
        prompt,
        denoise,
        steps,
        theme,
        model: restyled.model,
        usage: restyled.usage,
        seconds: restyled.seconds,
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
        `${base}  (hybrid, ${presetName}, ${restyled.model})`,
        `  svg       ${rel(hybridPath)}`,
        `  backdrop  ${rel(backdropWebpPath)}  (${webp.width}x${webp.height}, from ${restyled.model})`,
        `  base      ${rel(baseSvgPath)}`,
        `  meta      ${rel(path.join(dir, `${base}-hybrid.json`))}`,
        '',
        `The type is vector and pinned to ${theme}; the surface is one raster.`,
        `Re-composite without another model call by reusing ${rel(backdropPath)}.`
    ];

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

    logger.info(`[chart] Wrote hybrid ${base} via ${restyled.model}`, null, 'Chart');
    return { content, isError: false };
}
