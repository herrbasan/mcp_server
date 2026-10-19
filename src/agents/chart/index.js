// Diagrams as SVG, from a semantic spec. The renderer is vendored as a submodule
// (src/nCharts) and imported directly — it is zero-dependency ESM with no build
// step, so there is nothing to install and no version to drift.
//
// Two rules shape this agent:
//   1. The spec travels as an object, not as a file. The chat hemisphere has no
//      filesystem, so a path-based signature would be unusable there.
//   2. The response names files, it does not carry them. A diagram is ~20 KB of
//      markup; the preview raster is what a reader actually needs to see.

import fs from 'fs';
import path from 'path';
import { getLogger } from '../../utils/logger.js';
import { render, audit, check, CONTRACT } from '../../nCharts/src/index.js';

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

async function rasterize(svg, name, theme) {
    const buf = Buffer.from(svg, 'utf8');
    const up = await fetch(`${nMediaUrl}/v1/upload`, {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(buf.length),
            'X-Original-Filename': `${name}.svg`
        },
        body: buf
    });
    if (!up.ok) throw new Error(`nMedia upload: ${up.status} ${await up.text()}`);
    const { fileId } = await up.json();

    const created = await fetch(`${nMediaUrl}/v1/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            fileId,
            processor: 'image',
            options: {
                format: 'webp',
                quality: 90,
                max_dimension: previewSize,
                // The SVG carries both themes; the raster has to be told which.
                color_scheme: theme
            }
        })
    });
    if (!created.ok) throw new Error(`nMedia process: ${created.status} ${await created.text()}`);
    const job = await created.json();

    for (let i = 0; i < 120; i += 1) {
        const status = await (await fetch(`${nMediaUrl}/v1/jobs/${job.jobId ?? job.id}`)).json();
        if (status.status === 'completed') {
            const asset = await fetch(`${nMediaUrl}/v1/assets/${status.assetId ?? status.result?.assetId}`);
            if (!asset.ok) throw new Error(`nMedia asset: ${asset.status}`);
            return Buffer.from(await asset.arrayBuffer());
        }
        if (status.status === 'failed') throw new Error(`nMedia job failed: ${JSON.stringify(status)}`);
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('nMedia job timed out');
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
    const svgPath = path.join(dir, `${base}.svg`);
    const specPath = path.join(dir, `${base}.json`);

    fs.writeFileSync(svgPath, svg, 'utf8');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    const rel = (p) => path.relative(storageRoot, p).split(path.sep).join('/');
    const lines = [
        `${base}`,
        `  svg      ${rel(svgPath)}`,
        `  spec     ${rel(specPath)}`
    ];

    let previewBuf = null;
    if (args?.preview !== false) {
        previewBuf = await rasterize(svg, base, args?.theme === 'light' ? 'light' : 'dark');
        const previewPath = path.join(dir, `${base}_preview.webp`);
        fs.writeFileSync(previewPath, previewBuf);
        lines.push(`  preview  ${rel(previewPath)}`);
    }

    if (report.warnings.length) {
        lines.push('', 'Audit warnings — legible, but worth a look:');
        for (const w of report.warnings) lines.push(`  - ${w}`);
    }

    lines.push('', `The spec sidecar is the diagram's source: edit it and call chart_render with specPath to re-render.`);

    const content = [{ type: 'text', text: lines.join('\n') }];
    if (previewBuf) content.push({ type: 'image', data: previewBuf.toString('base64'), mimeType: 'image/webp' });

    logger.info(`[chart] Wrote ${base}${previewBuf ? ' (svg + spec + preview)' : ' (svg + spec)'}`, null, 'Chart');
    return { content, isError: false };
}
