import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { image_generate, init } from '../src/agents/image/index.js';

const storageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'image-agent-test-'));
const reference = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
await fsp.writeFile(path.join(storageRoot, 'reference.png'), reference);

let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360"/></svg>';
let previewFailure = false;
let lastGenerationBody = null;
const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
        let body = '';
        for await (const chunk of req) body += chunk;
        lastGenerationBody = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            model: 'fixture-vector',
            data: [{ b64_json: Buffer.from(svg).toString('base64'), media_type: 'image/svg+xml' }]
        }));
        return;
    }
    if (req.method === 'POST' && req.url === '/v1/process/image') {
        if (previewFailure) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'fixture renderer unavailable' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ base64: Buffer.from('fixture-webp').toString('base64'), width: 640, height: 360 }));
        return;
    }
    res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
function ok(condition, label) {
    assert.ok(condition, label);
    passed++;
    console.log(`  ok  ${label}`);
}

try {
    await init({
        config: {
            gateway: { httpUrl: base, accessKey: null },
            nMediaUrl: base,
            agents: {
                storage: { root: storageRoot },
                image: { defaultSize: '1920x1440', folder: 'images', sizes: [1280, 180] }
            }
        }
    });

    await image_generate({ prompt: 'reference geometry', name: 'with-reference', references: ['reference.png'] });
    ok(!('size' in lastGenerationBody), 'img2img omits invented default size');
    ok(lastGenerationBody.input_references[0].startsWith('data:image/png;base64,'), 'reference bytes still forwarded');

    await image_generate({ prompt: 'text to image', name: 'text-default' });
    ok(lastGenerationBody.size === '1920x1440', 'text-to-image keeps configured default size');

    previewFailure = true;
    const preserved = await image_generate({ prompt: 'preview failure', name: 'preview-failure' });
    const svgPath = path.join(storageRoot, 'images');
    const preservedSvg = fs.readdirSync(svgPath).find((name) => name.endsWith('_preview-failure.svg'));
    const preservedMeta = fs.readdirSync(svgPath).find((name) => name.endsWith('_preview-failure.json'));
    ok(Boolean(preservedSvg), 'valid SVG survives downstream preview failure');
    ok(preserved.isError === false && preserved.content[0].text.includes('Preview rendering failed'), 'preview failure returns usable artifact with visible warning');
    const sidecar = JSON.parse(await fsp.readFile(path.join(svgPath, preservedMeta), 'utf8'));
    ok(sidecar.preview.status === 'failed' && sidecar.preview.error.includes('fixture renderer unavailable'), 'sidecar records exact preview renderer error');
    ok(sidecar.files.svg && !sidecar.files.preview, 'sidecar names source artifact without inventing preview files');

    svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0';
    await assert.rejects(
        () => image_generate({ prompt: 'truncated vector', name: 'truncated' }),
        /missing closing <\/svg>.*source preserved/
    );
    const truncatedSvg = fs.readdirSync(svgPath).find((name) => name.endsWith('_truncated.svg'));
    const truncatedMeta = fs.readdirSync(svgPath).find((name) => name.endsWith('_truncated.json'));
    ok(Boolean(truncatedSvg && truncatedMeta), 'malformed SVG and diagnostic sidecar are preserved');
    const truncatedSidecar = JSON.parse(await fsp.readFile(path.join(svgPath, truncatedMeta), 'utf8'));
    ok(truncatedSidecar.validation.ok === false, 'malformed vector fails loudly with validation metadata');

    console.log(`\n${passed} passed`);
} finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(storageRoot, { recursive: true, force: true });
}
