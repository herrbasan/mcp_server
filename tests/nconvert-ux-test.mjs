// nconvert review surface — the part mcp_server still owns after the cutover:
// the page, the raw upload route, the item payload read and the /files proxy.
// The engine, job records and artefacts live in nteligence-server, so this test
// requires the service (npm run test:nconvert runs the proxy smoke test first).
//
// The upload body is fixed text, so a repeat run reuses the same
// content-addressed item instead of accumulating artefacts in real storage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import * as agent from '../src/agents/nconvert/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8'));
const uploadRoot = path.join(repoRoot, 'data', 'nconvert', 'uploads');

let failures = 0;
function check(name, condition, detail = '') {
    if (condition) console.log(`  ok  ${name}`);
    else {
        failures += 1;
        console.error(`  FAIL ${name} — ${detail}`);
    }
}

let server;
try {
    const app = express();
    const state = await agent.init({ config, app });
    if (state.status === 'unreachable') {
        console.error(`nTeligence is not reachable at ${state.service} — start it: cd D:\\DEV\\nTeligence; cargo run -p nteligence-server`);
        process.exit(1);
    }
    server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    const capabilities = JSON.parse((await agent.nconvert_capabilities()).content[0].text);
    check(
        'capabilities advertise the UI, upload and file surface',
        capabilities.ui?.path === '/nconvert' && capabilities.ui.upload === true &&
        capabilities.ui.events === '/nconvert/events' && capabilities.ui.files === '/files',
        JSON.stringify(capabilities.ui)
    );

    const page = await fetch(`${base}/nconvert`);
    check('the review page is served', page.status === 200 && (await page.text()).includes('See what the converter decided.'), `${page.status}`);

    const nui = await fetch(`${base}/nconvert/nui/nui.js`);
    check('the NUI runtime is served beside the page', nui.status === 200, `${nui.status}`);

    const upload = await fetch(`${base}/nconvert/upload?filename=${encodeURIComponent('grüße.txt')}&depth=mechanical&keepOriginal=false`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('A small uploaded document.\n\nIt proves the raw upload route reaches the service.', 'utf8')
    });
    const uploaded = await upload.json();
    // Fixed body → the first run converts and the next reuses the same item, so
    // either an inline job or the reuse flag proves the upload reached the engine.
    check(
        'raw upload reaches the service inline',
        upload.status === 200 && uploaded.result?.format === 'txt' && (uploaded.job?.state === 'done' || uploaded.reused === true),
        JSON.stringify(uploaded).slice(0, 400)
    );
    check('upload keeps the Unicode filename as provenance', uploaded.result?.source === 'grüße.txt', JSON.stringify(uploaded.result?.source));
    check(
        'upload staging is cleaned up',
        !fs.existsSync(uploadRoot) || fs.readdirSync(uploadRoot).length === 0,
        fs.existsSync(uploadRoot) ? fs.readdirSync(uploadRoot).join(', ') : ''
    );

    const itemId = uploaded.result.id;
    const itemResponse = await fetch(`${base}/nconvert/items/${itemId}`);
    const item = await itemResponse.json();
    check('item API returns the layered result', itemResponse.status === 200 && item.manifest?.id === itemId && item.document?.includes('A small uploaded document.'), JSON.stringify(item).slice(0, 400));
    check('the retrieval layer is declared absent, not faked', item.summary === null && item.manifest?.layers?.summary === null, JSON.stringify(item.manifest?.layers));

    const documentLink = item.result?.links?.document;
    check('layer links stay on this origin', typeof documentLink === 'string' && documentLink.startsWith('/files/'), documentLink);
    const document = await fetch(`${base}${documentLink}`);
    const text = await document.text();
    check('the /files proxy serves artefact bytes', document.status === 200 && text.includes('A small uploaded document.'), `${document.status} ${text.slice(0, 160)}`);
} finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await agent.shutdown();
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
// Natural exit: process.exit() while the proxied response is still flushing its
// socket trips a libuv UV_HANDLE_CLOSING assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
