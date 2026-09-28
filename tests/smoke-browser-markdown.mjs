// Smoke: the browser agent's markdown mode is a real conversion end to end.
// Launches a headless browser against a local fixture — no network, no server.
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'node:assert/strict';
import {
    init,
    browser_session_create,
    browser_session_goto,
    browser_session_content,
    browser_session_close,
    shutdown
} from '../src/agents/browser/index.js';

const FIXTURE = `<!doctype html>
<html><head><title>Fixture API</title></head>
<body>
  <header><h1>Site name</h1></header>
  <nav><a href="/other">Other page</a></nav>
  <main>
    <h2>Options</h2>
    <p>Set <code>max_tokens</code> to limit output.</p>
    <pre><code class="language-js">const client = new Client({\n  max_tokens: 128\n});</code></pre>
    <table>
      <thead><tr><th align="left">Name</th><th align="right">Default</th></tr></thead>
      <tbody><tr><td>timeout</td><td>30000</td></tr></tbody>
    </table>
  </main>
  <footer>© 2026 Fixture Inc</footer>
</body></html>`;

const file = path.join(os.tmpdir(), `browser-md-fixture-${Date.now()}.html`);
fs.writeFileSync(file, FIXTURE, 'utf8');

const text = (res) => res.content[0].text;

try {
    await init();
    const created = await browser_session_create({});
    const sessionId = /sessionId[":\s]+([a-f0-9-]{8,})/i.exec(text(created))?.[1]
        || /([0-9a-f]{8}-[0-9a-f-]{20,})/i.exec(text(created))?.[1];
    assert.ok(sessionId, `could not read sessionId from: ${text(created)}`);

    await browser_session_goto({ sessionId, url: `file:///${file.replace(/\\/g, '/')}` }, {});

    const md = text(await browser_session_content({ sessionId, mode: 'markdown' }));
    console.log('--- markdown output ---');
    console.log(md);
    console.log('--- end ---');

    assert.match(md, /```js\nconst client = new Client\(\{\n {2}max_tokens: 128\n\}\);\n```/, 'code fence + language + body');
    assert.match(md, /^\| :-+ \| -+: \|$/m, 'GFM alignment row');

    const scopeDoc = text(await browser_session_content({ sessionId, mode: 'markdown', scope: 'document' }));
    assert.doesNotMatch(scopeDoc, /Site name|Other page|Fixture Inc/, 'document scope drops chrome');

    const rejected = await browser_session_content({ sessionId, mode: 'markdown', minChars: 100000 });
    assert.equal(rejected.isError, true, 'minChars rejection surfaces as an error');

    await browser_session_close({ sessionId });
    console.log('\nOK — browser markdown mode verified end to end');
} finally {
    fs.unlinkSync(file);
    await shutdown().catch(() => {});
}
