// Smoke test the chart agent outside the server: init against a temp storage root,
// render a spec, render it into a slide box, render it chrome-free and sketch, and
// prove the guards still refuse what they refuse.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, chart_guide, chart_render } from '../src/agents/chart/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-agent-'));
const chartDir = path.join(root, 'charts');
const failures = [];

const expect = (name, ok, detail = '') => {
    console.log(`${ok ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(name);
};

const context = (nMediaUrl = process.env.NMEDIA ?? 'http://192.168.0.100:3500') => ({
    config: {
        agents: { storage: { root }, chart: { previewSize: 1200 } },
        nMediaUrl
    }
});

console.log('init:', JSON.stringify(await init(context())));

const guide = await chart_guide({});
expect('guide lists examples', guide.content[0].text.includes('flow-gateway'));
expect('contract documents frame', guide.content[0].text.includes('frame'));

const spec = JSON.parse((await chart_guide({ example: 'flow-gateway' })).content[0].text);

const out = await chart_render({ spec });
console.log(out.content[0].text);
expect('render writes svg + spec + preview', /svg\s+charts\/\S+\.svg/.test(out.content[0].text) && /preview\s+charts\/\S+_preview\.webp/.test(out.content[0].text));
expect('render attaches a preview raster', out.content.some((c) => c.type === 'image'));

const readSvg = (text) => {
    const rel = text.match(/svg\s+(charts\/\S+\.svg)/)[1];
    return { rel, svg: fs.readFileSync(path.join(root, rel), 'utf8') };
};
const readSpec = (text) => {
    const rel = text.match(/spec\s+(charts\/\S+\.json)/)[1];
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
};
const size = (svg) => {
    const m = /<svg[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(svg);
    return { width: Number(m[1]), height: Number(m[2]) };
};

// A frame: the canvas takes the box's aspect, and the sidecar records what the
// renderer resolved so a re-render reproduces the file.
for (const [frame, aspect] of [['16:9', 16 / 9], ['8:9', 8 / 9], ['1:1', 1]]) {
    const framed = await chart_render({ spec: { ...spec, frame }, preview: false });
    const { svg } = readSvg(framed.content[0].text);
    const { width, height } = size(svg);
    expect(`${frame} canvas has the box aspect`, Math.abs(width / height - aspect) < 0.01, `${width}x${height}`);
    expect(`${frame} reports the variant`, /frame\s+\S+ · .+ · scale [\d.]+x/.test(framed.content[0].text));
    const sidecar = readSpec(framed.content[0].text);
    expect(`${frame} sidecar keeps the frame`, sidecar.frame === frame, JSON.stringify(sidecar.frame));
    const again = await chart_render({ specPath: framed.content[0].text.match(/spec\s+(charts\/\S+\.json)/)[1], preview: false });
    const rerendered = size(readSvg(again.content[0].text).svg);
    expect(`${frame} sidecar re-renders to the same canvas`, rerendered.width === width && rerendered.height === height, `${rerendered.width}x${rerendered.height}`);
}

// Chrome is optional: a slide renders its own header and footer.
const bare = await chart_render({ spec: { ...spec, title: undefined, caption: undefined }, frame: '16:9', preview: false });
const bareSvg = readSvg(bare.content[0].text).svg;
expect('a chrome-free render carries no title or caption', !/class="t-title|class="t-caption/.test(bareSvg));

// The hand-drawn style is a vector pass, not a model call.
const sketch = await chart_render({ spec, style: 'sketch', preview: false });
const sketchSvg = readSvg(sketch.content[0].text).svg;
expect('sketch style injects the ink filters', /id="sk-ink"/.test(sketchSvg) && /<text/.test(sketchSvg));

// A spec the audit must refuse: three tones where colour is emphasis, not a key.
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
expect('three tones are refused with no file written', bad.isError === true && /aton?e|tones/.test(bad.content[0].text));
console.log(bad.content[0].text.split('\n')[0]);

// Geometry is not the caller's business.
try {
    await chart_render({ spec: { type: 'flow', nodes: [{ label: 'A', x: 10 }] } });
    expect('geometry key is rejected', false);
} catch (err) {
    expect('geometry key is rejected', /geometry|x/i.test(err.message), err.message.split('\n')[0]);
}

// An unknown frame is named, not ignored.
try {
    await chart_render({ spec: { ...spec, frame: '21:9' } });
    expect('unknown frame is rejected', false);
} catch (err) {
    expect('unknown frame is rejected', /frame/.test(err.message), err.message.split('\n')[0]);
}

console.log('files:', fs.readdirSync(chartDir).sort().join(', '));

// nMedia down: the render must still land, and say so.
await init(context('http://127.0.0.1:1'));
const noPreview = await chart_render({ spec });
console.log(noPreview.content[0].text.split('\n').filter((l) => l.includes('preview')).join(' | '));
expect('a dead rasterizer still yields the svg', noPreview.isError === false && noPreview.content.length === 1);

fs.rmSync(root, { recursive: true, force: true });

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
