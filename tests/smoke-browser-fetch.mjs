// Smoke: browser.fetch end to end against a local server.
//
// Covers every transport the tool can take:
//   /static      → rendered (the default)
//   /shell       → rendered; HTTP alone would have yielded only a shell
//   /raw.txt     → verbatim, whichever transport brought it
//   /data.json   → verbatim, and still valid JSON (no frontmatter added)
//   /binary      → rejected, not mangled
//   /empty       → nothing to store, loud error
//   /challenge   → a block page is refused, never stored as content
//   prefer:'http' → still available for sitemaps and raw endpoints
//
// No network access; everything is served from this process.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'node:assert/strict';
import { init, browser_fetch, shutdown } from '../src/agents/browser/index.js';

const PROSE = 'The client library exposes a small surface. '.repeat(12);

const STATIC_PAGE = `<!doctype html><html><head><title>Fixture API</title></head>
<body>
  <nav><a href="/other">Other</a></nav>
  <main>
    <h2>Options</h2>
    <p>${PROSE}</p>
    <pre><code class="language-js">const c = new Client({ max_tokens: 128 });</code></pre>
    <table><thead><tr><th align="left">Name</th><th align="right">Default</th></tr></thead>
    <tbody><tr><td>timeout</td><td>30000</td></tr></tbody></table>
    <p>${PROSE}</p>
  </main>
  <footer>© 2026</footer>
</body></html>`;

// Deliberately tiny: an empty root div plus a script. This is the shape a
// payload-size heuristic would have missed, and the reason detection is based on
// a thin conversion instead.
const SHELL_PAGE = `<!doctype html><html><head><title>Shell App</title></head>
<body><div id="app"></div>
<script>
  document.getElementById('app').innerHTML =
    '<h1>Rendered Content</h1><p>${PROSE}</p>' +
    '<pre><code class="language-python">def f():\\n    return 1</code></pre>';
</script></body></html>`;

const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    // Cloudflare's interstitial, which Chrome does not necessarily get past
    // either — Glassdoor served exactly this to headless Chrome on 2026-09-28.
    const CLOUDFLARE_WALL = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><h1>Just a moment...</h1>
<p>Verify you are human by completing the action below.</p>
<p>www.glassdoor.com needs to review the security of your connection before proceeding.</p>
</body></html>`;
    const routes = {
        '/static': ['text/html; charset=utf-8', STATIC_PAGE],
        '/shell': ['text/html; charset=utf-8', SHELL_PAGE],
        '/raw.txt': ['text/plain', 'plain text body, not a document'],
        '/data.json': ['application/json', '{"ok":true}'],
        '/binary': ['application/pdf', Buffer.from('%PDF-1.4 not really')],
        '/empty': ['text/html', '<!doctype html><html><body></body></html>'],
        // A block page is the failure that hides best: 200, real English, and
        // enough characters to pass any length check.
        '/challenge': ['text/html', CLOUDFLARE_WALL],
        '/challenge-then-content': ['text/html', CLOUDFLARE_WALL]
    };
    const route = routes[pathname];
    if (!route) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': route[0] });
    res.end(route[1]);
});

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-smoke-'));
const text = (r) => r.content[0].text;
const fileAt = (...segs) => path.join(storageRoot, 'fetch', '127-0-0-1', ...segs);
const read = (...segs) => fs.readFileSync(fileAt(...segs), 'utf8');

async function expectThrow(promise, pattern, label) {
    try {
        await promise;
    } catch (e) {
        assert.match(e.message, pattern, `${label}: wrong error`);
        return e.message;
    }
    throw new Error(`${label}: expected a throw matching ${pattern}`);
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

await init({ config: { agents: { storage: {
    root: storageRoot,
    uncShare: '\\\\FAKE\\storage',
    publicUrl: 'http://127.0.0.1:3100'
} } } });

console.log('\nbrowser.fetch smoke\n');

// ---- 1. the default path renders --------------------------------------
await step('default transport renders, and reports the rendering path', async () => {
    const r = await browser_fetch({ url: `${base}/static` });
    console.log(text(r).split('\n').map(l => '       ' + l).join('\n'));
    assert.equal(r.isError, false);
    assert.match(text(r), /via\s+browser$/m, 'rendering is the default');
    assert.match(text(r), /1 code block\(s\), 1 table\(s\)/, 'structure summary');
    assert.match(text(r), /fetch\/127-0-0-1\/static\.md/, 'storage path reported');
    assert.match(text(r), /unc\s+\\\\FAKE\\storage/, 'UNC coordinate reported');

    const md = read('static.md');
    assert.match(md, /^---\nsource: "http:\/\/127\.0\.0\.1:\d+\/static"\nfetched: \d{4}-/, 'provenance frontmatter');
    assert.match(md, /title: "Fixture API"/, 'title in frontmatter');
    assert.match(md, /```js\nconst c = new Client/, 'code fence survived');
    assert.match(md, /\| :-+ \| -+: \|/, 'GFM alignment survived');
    assert.doesNotMatch(md, /Other|© 2026/, 'chrome dropped');
    assert.doesNotMatch(md, /truncated/, 'nothing truncated');
});

// ---- 1b. prefer:'http' remains, for things that are not pages ----------
await step("prefer:'http' fetches without rendering", async () => {
    const r = await browser_fetch({ url: `${base}/static`, prefer: 'http', name: 'via-http' });
    assert.match(text(r), /via\s+http$/m);
    assert.match(read('via-http.md'), /```js\nconst c = new Client/, 'same conversion over HTTP');
});

// ---- 2. a JS shell is just a page, and renders -------------------------
await step('a JavaScript shell renders to its real content', async () => {
    const r = await browser_fetch({ url: `${base}/shell` });
    console.log(text(r).split('\n').map(l => '       ' + l).join('\n'));
    assert.match(text(r), /via\s+browser$/m);
    const md = read('shell.md');
    assert.match(md, /Rendered Content/, 'rendered content captured');
    assert.match(md, /```python\ndef f\(\):/, 'language + body from the rendered DOM');
});

// ---- 3. prefer:'http' never launches Chrome ----------------------------
await step("prefer:'http' never launches Chrome, and fails loudly if that is not enough", async () => {
    const msg = await expectThrow(
        browser_fetch({ url: `${base}/shell`, prefer: 'http', minChars: 400 }),
        /no extractable content/,
        'prefer:http on a shell'
    );
    assert.match(msg, /via http/, 'should say which transport produced nothing');
});

// ---- 4. non-page resources keep their bytes ----------------------------
await step('plain text is stored verbatim, whichever transport found it', async () => {
    const viaHttp = await browser_fetch({ url: `${base}/raw.txt`, prefer: 'http' });
    assert.match(text(viaHttp), /raw text\/plain/, 'reports the raw path');
    assert.equal(read('raw.txt'), 'plain text body, not a document');

    // The default transport renders it first and Chrome wraps text/plain in a
    // viewer document — storing page.content() there would persist the wrapper,
    // not the resource, so the bytes are re-fetched instead.
    const viaBrowser = await browser_fetch({ url: `${base}/raw.txt`, name: 'raw-rendered' });
    assert.match(text(viaBrowser), /raw text\/plain/, 'rendered transport still stores it raw');
    assert.equal(read('raw-rendered.txt'), 'plain text body, not a document', 'must not be a Chrome wrapper');
});

await step('json is stored verbatim, untouched, and still parses', async () => {
    const r = await browser_fetch({ url: `${base}/data.json` });
    assert.match(text(r), /raw application\/json/);
    const stored = read('data.json');
    assert.equal(stored, '{"ok":true}');
    assert.deepEqual(JSON.parse(stored), { ok: true }, 'must not have been given frontmatter');
});

// ---- 5. binary rejected -------------------------------------------------
await step('binary content-type is rejected, not mangled', async () => {
    const msg = await expectThrow(
        browser_fetch({ url: `${base}/binary`, prefer: 'http' }),
        /is not text/,
        'binary'
    );
    assert.match(msg, /application\/pdf/);
});

// ---- 6. nothing at all --------------------------------------------------
await step('a page with no content fails loudly', async () => {
    const msg = await expectThrow(
        browser_fetch({ url: `${base}/empty` }),
        /no extractable content/,
        'empty page'
    );
    assert.match(msg, /via browser/, 'should say which transport produced nothing');
});

// ---- 7. block pages are never stored as content ------------------------
await step('a Cloudflare challenge page is rejected, not stored', async () => {
    const msg = await expectThrow(
        browser_fetch({ url: `${base}/challenge` }),
        /block page/,
        'challenge page'
    );
    assert.match(msg, /bot protection/, 'should explain what happened');
    assert.ok(!fs.existsSync(fileAt('challenge.md')), 'must not have been written to storage');
    assert.ok(!fs.existsSync(fileAt('index.md')), 'must not have been written to storage');
});

// ---- 8. validation ------------------------------------------------------
await step('input validation rejects bad calls', async () => {
    await expectThrow(browser_fetch({}), /url is required/, 'missing url');
    await expectThrow(browser_fetch({ url: 'not a url' }), /not a valid absolute URL/, 'bad url');
    await expectThrow(browser_fetch({ url: 'ftp://x.dev/a' }), /only http and https/, 'scheme');
    await expectThrow(browser_fetch({ url: `${base}/static`, prefer: 'maybe' }), /prefer must be/, 'prefer');
    await expectThrow(browser_fetch({ url: `${base}/static`, dir: '../escape' }), /relative path inside storage/, 'dir escape');
    await expectThrow(browser_fetch({ url: `${base}/static`, dir: 'C:\\abs' }), /relative path inside storage/, 'absolute dir');
});

// ---- 9. re-fetch is idempotent -----------------------------------------
await step('re-fetching the same URL overwrites the same file', async () => {
    const before = fs.statSync(fileAt('static.md')).mtimeMs;
    await browser_fetch({ url: `${base}/static` });
    const after = fs.statSync(fileAt('static.md')).mtimeMs;
    assert.ok(after >= before, 'file rewritten in place');
    assert.equal(fs.readdirSync(fileAt()).filter(f => f.startsWith('static')).length, 1, 'no duplicate files');
});
server.close();
fs.rmSync(storageRoot, { recursive: true, force: true });
await shutdown().catch(() => {});

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
