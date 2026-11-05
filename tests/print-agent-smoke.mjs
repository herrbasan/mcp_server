import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, shutdown, print_render, print_preview, chromeTemplate } from '../src/agents/print/index.js';

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
<!-- mb:main id=fixture -->
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

try {
    await init({ config: { agents: { storage: { root }, print: { previewWidth: 900 } } } });

    const rendered = await print_render({ path: sourcePath, name: 'fixture' });
    console.log(rendered.content[0].text);
    check('render returns PDF page images', rendered.content.filter((item) => item.type === 'image').length === 2);
    const manifestPath = rendered.content[0].text.match(/manifest\s+(\S+)/)[1];
    const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestPath), 'utf8'));
    check('source page-break produces two PDF pages', manifest.pageCount === 2, `pages=${manifest.pageCount}`);
    check('default print profile is editorial', manifest.options.style === 'editorial');
    check('semantic targets come from NUI', manifest.targets.some((target) => target.id === 'second' && target.kind === 'section'));
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
} finally {
    await shutdown();
    fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
