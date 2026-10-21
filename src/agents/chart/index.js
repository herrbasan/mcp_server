// Diagrams as SVG, from a semantic spec. The renderer is vendored as a submodule
// (src/nCharts) and imported directly — it is zero-dependency ESM with no build
// step, so there is nothing to install and no version to drift.
//
// Two tools, one idea: the caller supplies meaning, nCharts supplies geometry.
//   chart_guide  — the spec contract, so a caller never guesses a field name
//   chart_render — spec -> SVG, spec sidecar, preview raster
//
// Two rules shape the agent:
//   1. The spec travels as an object, not as a file. The chat hemisphere has no
//      filesystem, so a path-based signature would be unusable there.
//   2. The response names files, it does not carry them. A diagram is ~20 KB of
//      markup; the preview raster is what a reader actually needs to see.
//
// The spec sidecar holds the spec the renderer RESOLVED, not the one the caller
// sent: a frame picks a layout variant and a canvas width, and a sidecar that kept
// the authored shape would re-render to a different file.

import fs from 'fs';
import path from 'path';
import { getLogger } from '../../utils/logger.js';
import { audit, check, CONTRACT, variantSvg, resolve } from '../../nCharts/src/index.js';
import { sketchify } from './sketch.js';

const logger = getLogger();

let storageRoot;
let chartDir;
let nMediaUrl;
let previewSize;

export async function init(context) {
    storageRoot = context.config.agents?.storage?.root;
    if (!storageRoot) throw new Error('[chart] config agents.storage.root is required');
    nMediaUrl = context.config.nMediaUrl ?? 'http://localhost:3500';

    const conf = context.config.agents?.chart ?? {};
    chartDir = conf.folder ?? 'charts';
    previewSize = conf.previewSize ?? 1600;

    fs.mkdirSync(path.join(storageRoot, chartDir), { recursive: true });
    return { status: 'initialized', chartDir, previewSize };
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

function stripDataUri(value) {
    const m = /^data:[^;]+;base64,(.*)$/s.exec(value);
    return m ? m[1] : value;
}

// nMedia's base64 route: hand it an SVG and it rasterizes through Chrome, hand it a
// raster and it transcodes. One endpoint, both jobs.
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

    // style: 'sketch' redraws the shapes as hand-drawn ones. Unknown values are
    // refused rather than ignored — a silently flat diagram is the failure mode.
    const style = args?.style ?? 'flat';
    if (style !== 'flat' && style !== 'sketch') {
        throw new Error(`chart_render: style must be "flat" or "sketch", got "${style}"`);
    }

    // The resolution the audit judged: frame variant, canvas size, scale.
    const resolved = resolve(spec);

    // Static rules over the emitted markup. These are renderer bugs, not caller
    // mistakes — an undefined class paints black — so they fail loudly rather than
    // quietly shipping a file. Run against the renderer's own output: a restyle is
    // not the renderer, and its weights are deliberately not the system's.
    const staticReport = check(resolved.svg);
    if (!staticReport.ok) {
        throw new Error(`chart_render: the renderer emitted invalid SVG — ${staticReport.errors.join('; ')}`);
    }

    const svg = style === 'sketch' ? sketchify(resolved.svg) : resolved.svg;

    const base = uniqueBase(slugify(args?.name ?? spec.title ?? 'chart'));
    const dir = path.join(storageRoot, chartDir);
    const svgPath = path.join(dir, `${base}.svg`);
    const specPath = path.join(dir, `${base}.json`);

    fs.writeFileSync(svgPath, svg, 'utf8');
    fs.writeFileSync(specPath, JSON.stringify(resolved.spec, null, 2), 'utf8');

    const rel = (p) => path.relative(storageRoot, p).split(path.sep).join('/');
    const lines = [
        `${base}`,
        `  svg      ${rel(svgPath)}`,
        `  spec     ${rel(specPath)}`
    ];
    if (report.frame) {
        lines.push(`  frame    ${report.frame} · ${report.variant} · scale ${report.scale.toFixed(2)}x`);
    }

    let previewPng = null;
    if (args?.preview !== false) {
        // nMedia is an outside service, and the diagram is already written. A
        // preview failure is reported in the result rather than thrown, so a
        // caller does not lose a good render because a rasterizer was down.
        try {
            const raster = await nmediaProcess(Buffer.from(variantSvg(svg, args?.theme), 'utf8').toString('base64'), {
                format: 'png',
                maxDimension: previewSize
            });
            previewPng = raster.buf;
            const previewWebp = await nmediaProcess(previewPng.toString('base64'), {
                format: 'webp',
                maxDimension: previewSize,
                quality: 90
            });
            const previewPath = path.join(dir, `${base}_preview.webp`);
            fs.writeFileSync(previewPath, previewWebp.buf);
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

    lines.push('', `The spec sidecar is the diagram's source — it holds the layout the renderer resolved. Edit it and call chart_render with specPath to re-render.`);

    const content = [{ type: 'text', text: lines.join('\n') }];
    if (previewPng) content.push({ type: 'image', data: previewPng.toString('base64'), mimeType: 'image/png' });

    logger.info(`[chart] Wrote ${base}${previewPng ? ' + preview' : ''}`, null, 'Chart');
    return { content, isError: false };
}
