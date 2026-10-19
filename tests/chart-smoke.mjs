// Smoke test the chart agent outside the server: init against a temp storage root,
// render a real spec, and check what lands on disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, chart_guide, chart_render } from '../src/agents/chart/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chart-agent-'));
const context = {
    config: {
        agents: { storage: { root }, chart: { previewSize: 1200 } },
        nMediaUrl: process.env.NMEDIA ?? 'http://192.168.0.100:3500'
    }
};

console.log('init:', JSON.stringify(await init(context)));

const guide = await chart_guide({});
console.log('guide chars:', guide.content[0].text.length);
console.log('guide head:', guide.content[0].text.split('\n')[0]);

const spec = JSON.parse((await chart_guide({ example: 'flow-gateway' })).content[0].text);
const out = await chart_render({ spec });
console.log('--- render ---');
console.log(out.content[0].text);
console.log('parts:', out.content.map((c) => c.type).join(','));

// A spec the audit must refuse: three tones in a structure diagram, where colour is
// emphasis rather than a category key. The point of the test is that the caller gets
// the reason and the fields, and no file is written.
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
console.log('isError:', bad.isError);
console.log(bad.content[0].text.split('\n').slice(0, 1).join('\n'));

// Geometry is not the caller's business — supplying it must throw, not render.
try {
    await chart_render({ spec: { type: 'flow', nodes: [{ label: 'A', x: 10 }] } });
    console.log('--- geometry key: NOT REJECTED (bug) ---');
} catch (err) {
    console.log('--- geometry key rejected:', err.message.split('\n')[0]);
}

console.log('files:', fs.readdirSync(path.join(root, 'charts')).join(', '));

// nMedia down: the render must still land, and say so.
await init({ config: { ...context.config, nMediaUrl: 'http://127.0.0.1:1' } });
const noPreview = await chart_render({ spec });
console.log('--- nMedia unreachable ---');
console.log(noPreview.content[0].text.split('\n').filter((l) => l.includes('preview')).join(' | '));
console.log('isError:', noPreview.isError, '| parts:', noPreview.content.map((c) => c.type).join(','));

fs.rmSync(root, { recursive: true, force: true });
