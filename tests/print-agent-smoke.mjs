import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { init, shutdown, print_render, print_preview, chromeTemplate } from '../src/agents/print/index.js';
import express from 'express';

const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'print-agent-'));
const sourcePath = path.join(root, 'fixture.md');
const failures = [];
const check = (name, condition, detail = '') => {
    console.log(`${condition ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures.push(name);
};

const source = `---
title: Print fixture
---
<!-- mb:block repeat=header -->
Fixture header
<!-- mb:/block -->
<!-- mb:block repeat=footer -->
Fixture footer

Page {{page}} of {{pages}}
<!-- mb:/block -->
<!-- mb:section id=first -->
# First page
A short fixture for real Chromium pagination.

![One pixel](pixel.png)

<!-- mb:block preset=page-break -->
<!-- mb:/block -->
## After the explicit break
This heading follows the source-authored page-break block.

---

<!-- mb:section id=second -->
# Second section
The MCP caller can force this section onto its own page by ID.
`;
fs.writeFileSync(sourcePath, source, 'utf8');
fs.writeFileSync(path.join(root, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

let apiServer;
try {
    const app = express();
    await init({ config: { agents: { storage: { root }, print: { previewWidth: 900 } } }, app });
    await new Promise((resolve, reject) => {
        apiServer = app.listen(0, '127.0.0.1', resolve);
        apiServer.once('error', reject);
    });

    const rendered = await print_render({ path: sourcePath, name: 'fixture', _mapTargets: true });
    console.log(rendered.content[0].text);
    check('render returns PDF page images', rendered.content.filter((item) => item.type === 'image').length === 2);
    const manifestPath = rendered.content[0].text.match(/manifest\s+(\S+)/)[1];
    const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
    check('source page-break produces two PDF pages', manifest.pageCount === 2, `pages=${manifest.pageCount}`);
    check('default print profile is editorial', manifest.options.style === 'editorial');
    check('semantic targets come from NUI', manifest.targets.some((target) => target.id === 'second' && target.kind === 'section'));
    check('semantic targets map to exact PDF pages', manifest.targets.find((target) => target.id === 'first')?.page === 1 && manifest.targets.find((target) => target.id === 'second')?.page === 2, JSON.stringify(manifest.targets.map((target) => ({ id: target.id, page: target.page }))));
    const native = require('../nConvert/napi/index.js');
    const cleanPdf = JSON.parse(await native.convert(fs.readFileSync(path.join(root, manifest.pdf)), 'document.pdf', '{}'));
    check('mapping markers are absent from the final PDF', !cleanPdf.page_texts.some((text) => text.includes('MBTARGET')));
    check('preview PNGs are written', manifest.previews.every((preview) => fs.existsSync(path.join(root, preview.path))));
    const footerTemplate = chromeTemplate(manifest.chrome.footer, 'footer', manifest.options.margin, manifest.options.style);
    check('page placeholders become Chromium native fields', footerTemplate.includes('class="pageNumber"') && footerTemplate.includes('class="totalPages"'));
    check('bleed chrome uses the light gray surface', footerTemplate.includes('background:#e2e6e9!important'));
    const headerTemplate = chromeTemplate(manifest.chrome.header, 'header', manifest.options.margin, manifest.options.style);
    check('chrome bleed offsets the native inset', headerTemplate.includes('margin-top:-5mm') && footerTemplate.includes('margin-bottom:-5mm'));

    const broken = await print_render({ path: sourcePath, name: 'fixture-break', breakBefore: ['second'], pages: [3] });
    const brokenManifestPath = broken.content[0].text.match(/manifest\s+(\S+)/)[1];
    const brokenManifest = JSON.parse(fs.readFileSync(path.join(root, brokenManifestPath), 'utf8'));
    check('breakBefore adds a real PDF page', brokenManifest.pageCount === 3, `pages=${brokenManifest.pageCount}`);
    check('selected inline page is attached', broken.content.filter((item) => item.type === 'image').length === 1);
    check('break settings survive in the sidecar', brokenManifest.breakBefore[0] === 'second');

    const preview = await print_preview({ path: brokenManifest.pdf, pages: [2], width: 700 });
    check('existing PDF preview returns one page', preview.content.filter((item) => item.type === 'image').length === 1);

    const tallPath = path.join(root, 'tall-chrome.md');
    fs.writeFileSync(tallPath, source.replace('Fixture header', Array.from({ length: 12 }, (_, index) => `Header line ${index + 1}`).join('\n\n')), 'utf8');
    const tall = await print_render({ path: tallPath, preview: false });
    const tallManifestPath = tall.content[0].text.match(/manifest\s+(\S+)/)[1];
    const tallManifest = JSON.parse(fs.readFileSync(path.join(root, tallManifestPath), 'utf8'));
    check('tall header automatically increases top margin', parseFloat(tallManifest.options.margin.top) > 18, tallManifest.options.margin.top);

    const excessivePath = path.join(root, 'excessive-chrome.md');
    fs.writeFileSync(excessivePath, source.replace('Fixture header', Array.from({ length: 100 }, (_, index) => `Header line ${index + 1}`).join('\n\n')), 'utf8');
    let excessive = false;
    try {
        await print_render({ path: excessivePath, preview: false });
    } catch (error) {
        excessive = /page-height limit/.test(error.message);
    }
    check('pathological chrome fails loudly', excessive);

    let rejected = false;
    try {
        await print_render({ path: sourcePath, breakBefore: ['does-not-exist'], preview: false });
    } catch (error) {
        rejected = /break target/.test(error.message);
    }
    check('unknown break target fails loudly', rejected);

    let badMargin = false;
    try {
        await print_render({ path: sourcePath, margin: [], preview: false });
    } catch (error) {
        badMargin = /margin must be/.test(error.message);
    }
    check('invalid margin fails loudly', badMargin);

    let badStyle = false;
    try {
        await print_render({ path: sourcePath, style: 'glossy', preview: false });
    } catch (error) {
        badStyle = /style must be/.test(error.message);
    }
    check('unknown print profile fails loudly', badStyle);

    let outOfRange = false;
    try {
        await print_preview({ path: brokenManifest.pdf, pages: [99] });
    } catch (error) {
        outOfRange = /out of range/.test(error.message);
    }
    check('out-of-range preview page fails loudly', outOfRange);

    const apiBase = `http://127.0.0.1:${apiServer.address().port}`;
    const post = async (action, body) => {
        const response = await fetch(`${apiBase}/print/api/${action}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        return result;
    };
    const editorPage = await fetch(`${apiBase}/print`);
    check('print editor HTML is served', editorPage.ok && (await editorPage.text()).includes('See the paper. Change the break.'));
    const editor = await post('open', { path: sourcePath });
    check('editor opens exact pages and their targets', editor.pageCount === 2 && editor.targets.find((target) => target.id === 'second')?.page === 2);
    const second = editor.targets.find((target) => target.id === 'second');
    const first = editor.targets.find((target) => target.id === 'first');
    check(
        'editor targets carry a vertical position on the page',
        first.y < 0.2 && second.y < 0.2 && first.pageHeight > 700,
        JSON.stringify({ first: [first.page, first.y], second: [second.page, second.y], pageHeight: first.pageHeight })
    );
    const changed = await post('render', { token: editor.token, breakBefore: ['second'], breakAfter: [] });
    check('editor break toggle rerenders real pagination', changed.pageCount === 3 && changed.targets.find((target) => target.id === 'second')?.page === 3);
    check(
        'editor break toggle reuses the loaded page',
        changed.timings?.layout === 0 && changed.timings.pdf > 0,
        JSON.stringify(changed.timings)
    );
    const savedMarkdown = editor.source.replace('title: Print fixture', 'title: Print fixture\nprint:\n  breakBefore:\n    - second\n  breakAfter: []');
    await post('save', { token: editor.token, markdown: savedMarkdown, baseSha256: editor.sourceSha256 });
    const persisted = await post('render', { token: editor.token });
    check('editor save persists frontmatter breaks', persisted.pageCount === 3 && persisted.options.breakBefore[0] === 'second');
    await post('close', { token: editor.token });
} finally {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    await shutdown();
    fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
