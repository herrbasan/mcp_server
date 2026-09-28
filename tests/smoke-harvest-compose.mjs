// Smoke: harvest.compose against a fixture manifest and a stub model.
//
// The interesting behaviour is not the writing — that is the model's job — but
// the contract around it: sources read from the manifest, abandoned links
// fetched on request, sources appended rather than generated, and hard failure
// (writing nothing) when there is no model, no source, or not enough context.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'node:assert/strict';
import { init as initBrowser, shutdown } from '../src/agents/browser/index.js';
import { init as initHarvest, harvest_collect, harvest_compose } from '../src/agents/harvest/index.js';

const PROSE = 'This page documents the behaviour in enough detail to be worth keeping. '.repeat(10);

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`;

const ROUTES = {
    '/docs/': ['text/html', page('Docs Home', `<p>${PROSE}</p><p><a href="/docs/a">A</a> <a href="/docs/b">B</a> <a href="/docs/c">C</a></p>`)],
    '/docs/a': ['text/html', page('Page A', `<p>${PROSE}</p><pre><code class="language-js">const a = 1;</code></pre>`)],
    '/docs/b': ['text/html', page('Page B', `<p>${PROSE}</p>`)],
    '/docs/c': ['text/html', page('Page C', `<p>${PROSE}</p><table><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2</td></tr></table>`)]
};

const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = ROUTES[pathname];
    if (!route) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': route[0] });
    res.end(route[1]);
});

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-smoke-'));
const text = (r) => r.content[0].text;
const manifestRel = 'harvest/127-0-0-1/_manifest.json';
const docAbs = () => path.join(storageRoot, 'harvest', '127-0-0-1', '_document.md');
const readDoc = () => fs.readFileSync(docAbs(), 'utf8');

// A gateway whose two calls are distinguishable by their prompt, and which
// records what it was asked so the prompts themselves can be asserted on.
function stubGateway({ doc = '## Written\n\nBody text from the model.\n', extraPicks = '[1]', fail = null, context_length = 1000000 } = {}) {
    const calls = [];
    return {
        calls,
        listModels: async () => [
            { id: 'stub-writer', context_length },
            { id: 'tiny-model', context_length }
        ],
        chat: async (req) => {
            const prompt = req.messages[0].content;
            calls.push({ model: req.model, prompt, maxTokens: req.maxTokens, stream: req.stream });
            if (fail) throw new Error(fail);
            if (/links were found but not fetched/.test(prompt)) {
                return { content: extraPicks, finish_reason: 'stop' };
            }
            return { content: doc, finish_reason: 'stop' };
        }
    };
}

let failures = 0;
async function step(name, fn) {
    try {
        await fn();
        console.log(`  OK   ${name}`);
    } catch (e) {
        failures++;
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const ctx = { config: { agents: { storage: { root: storageRoot, publicUrl: 'http://127.0.0.1:3100' } } } };
await initBrowser(ctx);
await initHarvest(ctx);
const BROWSER = await import('../src/agents/browser/index.js');
const withGateway = (gateway) => ({ gateway, agents: new Map([['browser', browserApi]]) });
const browserApi = await BROWSER.init(ctx);

console.log('\nharvest.compose smoke\n');

// Collect first so the fixture manifest is a real one.
await harvest_collect({ url: `${base}/docs/`, max_pages: 3, select: 'heuristic' }, withGateway(stubGateway()));

await step('composes a document from the manifest, with sources appended', async () => {
    const gw = stubGateway({ doc: '## Written\n\nBody text from the model.\n' });
    const r = await harvest_compose({ manifest: manifestRel, model: 'stub-writer', fetch_missing: false }, withGateway(gw));

    assert.match(text(r), /Composed harvest\/127-0-0-1\/_document\.md/);
    const doc = readDoc();
    assert.match(doc, /^---\ntitle: /, 'frontmatter');
    assert.match(doc, /manifest: "harvest\/127-0-0-1\/_manifest\.json"/, 'provenance names the manifest');
    assert.match(doc, /model: "stub-writer"/, 'model recorded');
    assert.match(doc, /## Written\n\nBody text from the model\./, 'the model body is in the document');

    // Sources come from the manifest, not from the model.
    assert.match(doc, /## Sources\n/, 'sources section appended');
    assert.match(doc, /\[Page A\]\(http:\/\/127\.0\.0\.1:\d+\/docs\/a\)/, 'source URL listed');
    assert.equal(gw.calls.length, 1, 'fetch_missing false means one call');
});

await step('the sources section is built from the manifest, never the model', async () => {
    // A model that tries to invent provenance must not be able to get it in.
    const gw = stubGateway({ doc: '## Written\n\nSee [invented](https://not-real.example/x) for details.\n' });
    await harvest_compose({ manifest: manifestRel, model: 'stub-writer', fetch_missing: false }, withGateway(gw));
    const doc = readDoc();
    assert.match(doc, /## Sources/, 'real sources still appended');
    assert.doesNotMatch(doc, /^1\. \[invented\]/m, 'invented URL did not become a source entry');
    // The real list is authoritative and numbered from the manifest.
    assert.match(doc, /^1\. \[/m);
});

await step('the compose prompt says restructure, not summarise', async () => {
    const gw = stubGateway();
    await harvest_compose({ manifest: manifestRel, model: 'stub-writer', intent: 'the a and c pages', fetch_missing: false }, withGateway(gw));
    const req = gw.calls.at(-1);
    assert.match(req.prompt, /the a and c pages/, 'intent reaches the prompt');
    assert.match(req.prompt, /\[Source 1: /, 'sources are numbered in the prompt');
    assert.equal(req.stream, false, 'one-shot call is non-streaming');
    assert.ok(req.maxTokens >= 8000, `expected a document-sized budget, got ${req.maxTokens}`);
});

await step('skips the abandoned-links round when asked', async () => {
    const gw = stubGateway();
    await harvest_compose({ manifest: manifestRel, model: 'stub-writer', fetch_missing: false }, withGateway(gw));
    assert.equal(gw.calls.length, 1, 'no extra call');
});

await step('goes back for abandoned links when asked', async () => {
    // max_pages 1 leaves /docs/b and /docs/c abandoned by budget.
    await harvest_collect({ url: `${base}/docs/`, max_pages: 1, select: 'heuristic' }, withGateway(stubGateway()));
    const manifest = JSON.parse(fs.readFileSync(path.join(storageRoot, manifestRel), 'utf8'));
    assert.ok(manifest.not_fetched.length >= 2, `expected abandoned links, got ${manifest.not_fetched.length}`);

    const gw = stubGateway({ extraPicks: '[1, 2]' });
    const r = await harvest_compose({ manifest: manifestRel, model: 'stub-writer', max_extra_pages: 2 }, withGateway(gw));

    assert.equal(gw.calls.length, 2, 'a selection call then the compose call');
    assert.match(gw.calls[0].prompt, /links were found but not fetched/, 'first call offers the abandoned links');
    assert.match(gw.calls[0].prompt, /at most 2/);
    assert.match(text(r), /fetched on request/, 'reports the extra fetching');
    // The extra pages are now sources in the document.
    const doc = readDoc();
    assert.ok((doc.match(/^1\. \[|^2\. \[|^3\. \[/gm) || []).length >= 2, 'extra sources appended');
});

await step('a failed extra fetch is recorded in the document, not hidden', async () => {
    const gw = stubGateway({ extraPicks: '[1]' });
    // Point the abandoned link at a dead port by rewriting the manifest.
    const abs = path.join(storageRoot, manifestRel);
    const manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
    manifest.not_fetched[0].url = 'http://127.0.0.1:1/dead';
    fs.writeFileSync(abs, JSON.stringify(manifest, null, 2), 'utf8');

    await harvest_compose({ manifest: manifestRel, model: 'stub-writer', max_extra_pages: 1 }, withGateway(gw));
    const doc = readDoc();
    assert.match(doc, /Requested for this document but not retrieved/, 'the gap is named');
    assert.match(doc, /127\.0\.0\.1:1\/dead/, 'which link failed is named');
});

await step('no gateway fails loudly and writes nothing', async () => {
    fs.rmSync(docAbs(), { force: true });
    await assert.rejects(
        () => harvest_compose({ manifest: manifestRel, model: 'stub-writer' }, { agents: new Map([['browser', browserApi]]) }),
        /no model-free fallback/
    );
    assert.equal(fs.existsSync(docAbs()), false, 'nothing written');
});

await step('an empty model reply fails loudly and writes nothing', async () => {
    fs.rmSync(docAbs(), { force: true });
    await assert.rejects(
        () => harvest_compose({ manifest: manifestRel, model: 'stub-writer', fetch_missing: false }, withGateway(stubGateway({ doc: '' }))),
        /returned an empty document/
    );
    assert.equal(fs.existsSync(docAbs()), false, 'nothing written');
});

await step('a page the manifest names but storage lacks fails loudly', async () => {
    fs.rmSync(docAbs(), { force: true });
    // Delete a page the CURRENT manifest actually names — an earlier step
    // re-collected with a smaller budget, so the page list is not what it was.
    const manifest = JSON.parse(fs.readFileSync(path.join(storageRoot, manifestRel), 'utf8'));
    const victim = path.join(storageRoot, manifest.pages[0].storage);
    const saved = fs.readFileSync(victim, 'utf8');
    fs.rmSync(victim);
    try {
        await assert.rejects(
            () => harvest_compose({ manifest: manifestRel, model: 'stub-writer', fetch_missing: false }, withGateway(stubGateway())),
            /the harvest is incomplete/
        );
        assert.equal(fs.existsSync(docAbs()), false, 'nothing written');
    } finally {
        fs.writeFileSync(victim, saved, 'utf8');
    }
});

await step('sources too large for the model fail loudly rather than truncate', async () => {
    fs.rmSync(docAbs(), { force: true });
    await assert.rejects(
        () => harvest_compose(
            { manifest: manifestRel, model: 'tiny-model', fetch_missing: false },
            withGateway(stubGateway({ context_length: 100 }))
        ),
        /Nothing was truncated/
    );
    assert.equal(fs.existsSync(docAbs()), false, 'nothing written');
});

await step('validation rejects bad input', async () => {
    const gw = stubGateway();
    await assert.rejects(() => harvest_compose({}, withGateway(gw)), /manifest is required/);
    await assert.rejects(() => harvest_compose({ manifest: 'nope/_manifest.json' }, withGateway(gw)), /manifest not found/);
    await assert.rejects(
        () => harvest_compose({ manifest: manifestRel, out: '../escape.md' }, withGateway(gw)),
        /relative path inside storage/
    );
});

server.close();
fs.rmSync(storageRoot, { recursive: true, force: true });
await shutdown().catch(() => {});

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
