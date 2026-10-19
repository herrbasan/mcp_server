// Smoke test the chart agent outside the server: init against a temp storage root,
// render, the textless base, and — with CHART_HYBRID=1 — a real hybrid through the
// Gateway (local krea2 first) and nMedia.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, chart_guide, chart_render, chart_hybrid } from '../src/agents/chart/index.js';

const env = {};
for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trim().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-agent-'));
const context = {
    config: {
        agents: {
            storage: { root },
            chart: {
                previewSize: 1200,
                hybridSize: 1280,
                hybridModels: ['coolkid-krea2', 'qwen-image'],
                defaultPreset: 'handdrawn',
                presets: {
                    handdrawn: {
                        denoise: 0.45,
                        steps: 20,
                        prompt:
                            'Redraw the boxes and arrows of this diagram by hand in dark ink on warm off-white paper: ' +
                            'fine pen outlines, slightly wobbly hand-drawn edges, no colour fills. ' +
                            'Keep every shape exactly where it is. Draw no lettering at all.'
                    }
                }
            }
        },
        nMediaUrl: process.env.NMEDIA ?? 'http://192.168.0.100:3500',
        gateway: { httpUrl: 'http://127.0.0.1:3400', accessKey: env.GATEWAY_ACCESS_KEY }
    }
};

const chartDir = path.join(root, 'charts');

console.log('init:', JSON.stringify(await init(context)));

const guide = await chart_guide({});
console.log('guide chars:', guide.content[0].text.length, '| examples listed:', guide.content[0].text.includes('flow-gateway'));

const spec = JSON.parse((await chart_guide({ example: 'flow-gateway' })).content[0].text);
const out = await chart_render({ spec });
console.log('--- render ---');
console.log(out.content[0].text);
console.log('parts:', out.content.map((c) => c.type).join(','));

// text:false is the hybrid handoff: no type, weighted strokes, a page colour.
const baseOut = await chart_render({ spec, text: false });
console.log('--- textless base ---');
console.log(baseOut.content[0].text);
const baseRel = baseOut.content[0].text.match(/base\s+(charts\/\S+-base\.svg)/)[1];
const baseSvg = fs.readFileSync(path.join(root, baseRel), 'utf8');
console.log('base has text elements:', /<text\b/.test(baseSvg), '| has a page colour:', /nc-bg|fill="#ffffff"/.test(baseSvg));

// A base has no words, and the words cannot be recovered from it — hybrid refuses.
let refused = false;
try {
    await chart_hybrid({ svgPath: baseRel });
} catch (err) {
    refused = /no <text> elements/.test(err.message);
}
console.log('textless base refused by hybrid:', refused);

// A spec the audit must refuse: three tones in a structure diagram, where colour is
// emphasis rather than a category key. The caller gets the reason and the fields,
// and no file is written.
const threeTones = {
    type: 'flow',
    nodes: [
        { id: 'a', label: 'A', tone: 'blue' },
        { id: 'b', label: 'B', tone: 'green' },
        { id: 'c', label: 'C', tone: 'red' }
    ],
    edges: [{ from: 'a', to: 'b' }]
};
const bad = await chart_render({ spec: threeTones });
console.log('--- rejected spec ---');
console.log('isError:', bad.isError, '|', bad.content[0].text.split('\n')[0]);

// Geometry is not the caller's business — supplying it must throw, not render.
try {
    await chart_render({ spec: { type: 'flow', nodes: [{ label: 'A', x: 10 }] } });
    console.log('--- geometry key: NOT REJECTED (bug) ---');
} catch (err) {
    console.log('--- geometry key rejected:', err.message.split('\n')[0]);
}

if (process.env.CHART_HYBRID === '1') {
    console.log('--- hybrid (real model call) ---');
    const hybrid = await chart_hybrid({ spec });
    console.log(hybrid.content[0].text);
    console.log('parts:', hybrid.content.map((c) => c.type).join(','));
    const hybridRel = hybrid.content[0].text.match(/svg\s+(charts\/\S+\.svg)/)[1];
    const backdropRel = hybrid.content[0].text.match(/backdropPath "([^"]+)"/)[1];
    const hybridSvg = fs.readFileSync(path.join(root, hybridRel), 'utf8');
    const driftScore = Number(hybrid.content[0].text.match(/drift\s+(-?[\d.]+)/)[1]);
    console.log(
        'hybrid has text:', /<text\b/.test(hybridSvg),
        '| webp backdrop:', /<image href="data:image\/webp;base64,/.test(hybridSvg),
        '| drift:', driftScore,
        '| isError:', hybrid.isError
    );

    // Same surface, edited words: no model call, so it must be fast and the text
    // must actually change.
    const edited = structuredClone(spec);
    edited.nodes.find((n) => n.id === 'gw').label = 'Gateway';
    const started = Date.now();
    const recomposed = await chart_hybrid({ spec: edited, backdropPath: backdropRel, preview: false });
    const recomposedSvg = fs.readFileSync(path.join(root, recomposed.content[0].text.match(/svg\s+(charts\/\S+\.svg)/)[1]), 'utf8');
    console.log(
        '--- re-composite ---',
        Date.now() - started, 'ms',
        '| saved backdrop:', recomposed.content[0].text.includes('saved backdrop'),
        '| label swapped:', /Gateway/.test(recomposedSvg) && !/LLM Gateway/.test(recomposedSvg),
        '| isError:', recomposed.isError
    );

    // A restyle that leaves the geometry must be refused, not shipped.
    const drifted = await chart_hybrid({ spec, denoise: 0.85, steps: 20, preview: false });
    console.log('--- drift guard ---', 'isError:', drifted.isError, '|', drifted.content[0].text.match(/drift\s+(-?[\d.]+)/)[1]);
} else {
    console.log('--- hybrid skipped (set CHART_HYBRID=1 to run the real model call) ---');
}

console.log('files:', fs.readdirSync(chartDir).sort().join(', '));

// nMedia down: the render must still land, and say so.
await init({ config: { ...context.config, nMediaUrl: 'http://127.0.0.1:1' } });
const noPreview = await chart_render({ spec });
console.log('--- nMedia unreachable ---');
console.log(noPreview.content[0].text.split('\n').filter((l) => l.includes('preview')).join(' | '));
console.log('isError:', noPreview.isError, '| parts:', noPreview.content.map((c) => c.type).join(','));

fs.rmSync(root, { recursive: true, force: true });
