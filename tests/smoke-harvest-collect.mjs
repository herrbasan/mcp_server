// Smoke: harvest.collect against a local multi-page site.
//
// The site is built to exercise every path the collector has to take:
//   /docs/                     seed, nav links to the pages below
//   /docs/a, /docs/b           ordinary pages
//   /docs/missing              linked, 404s → recorded as failed
//   /docs/blocked              linked, serves a Cloudflare wall → failed
//   /docs/deep/c, /docs/deep/d extra pages for the budget test
//   /docs/logo.png             linked, not a document → dropped
//   /blog/post                 linked, outside the section → dropped
//   https://example.invalid/x  linked, different origin → dropped
//   /sitemap.xml               lists /docs/a and /docs/b
//   /llms.txt                  lists /docs/e
//
// No network access; everything is served from this process.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'node:assert/strict';
import { init as initBrowser, shutdown } from '../src/agents/browser/index.js';
import { init as initHarvest, harvest_collect } from '../src/agents/harvest/index.js';

const PROSE = 'This section documents the behaviour in enough detail to be worth extracting. '.repeat(8);

const page = (title, body) => `<!doctype html><html><head><title>${title}</title></head>
<body><nav><a href="/docs/">Docs home</a><a href="/docs/a">A</a><a href="/docs/b">B</a></nav>
<main><h1>${title}</h1>${body}</main></body></html>`;

const WALL = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><h1>Just a moment...</h1><p>Verify you are human by completing the action below.</p></body></html>`;

const ROUTES = {
    '/docs/': [
        'text/html',
        page('Docs Home', `<p>${PROSE}</p>
            <p><a href="/docs/a">A</a> <a href="/docs/b">B</a> <a href="/docs/missing">Missing</a>
               <a href="/docs/blocked">Blocked</a> <a href="/docs/deep/c">Deep C</a>
               <a href="/docs/deep/d">Deep D</a> <a href="/docs/e">E</a>
               <a href="/docs/logo.png">Logo</a> <a href="/blog/post">Blog</a>
               <a href="https://example.invalid/x">Elsewhere</a></p>`)
    ],
    '/docs/a': ['text/html', page('Page A', `<p>${PROSE}</p><pre><code class="language-js">const a = 1;</code></pre>`)],
    '/docs/b': ['text/html', page('Page B', `<p>${PROSE}</p><table><tr><th>x</th><th>y</th></tr><tr><td>1</td><td>2</td></tr></table>`)],
    '/docs/e': ['text/html', page('Page E', `<p>${PROSE}</p>`)],
    '/docs/deep/c': ['text/html', page('Deep C', `<p>${PROSE}</p>`)],
    '/docs/deep/d': ['text/html', page('Deep D', `<p>${PROSE}</p>`)],
    '/docs/blocked': ['text/html', WALL],
    '/blog/post': ['text/html', page('Blog Post', `<p>${PROSE}</p>`)],
    '/sitemap.xml': ['application/xml', `<?xml version="1.0"?>
        <urlset><url><loc>http://127.0.0.1:PORT/docs/a</loc></url>
        <url><loc>http://127.0.0.1:PORT/docs/b</loc></url>
        <url><loc>http://127.0.0.1:PORT/blog/post</loc></url></urlset>`],
    '/llms.txt': ['text/plain', '# Docs\n\n- [Page E](http://127.0.0.1:PORT/docs/e)\n- [Elsewhere](https://example.invalid/x)\n']
};

const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const port = server.address().port;
    const route = ROUTES[pathname];
    if (!route) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': route[0] });
    res.end(route[1].replace(/PORT/g, String(port)));
});

const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-smoke-'));
const text = (r) => r.content[0].text;
const manifestPath = () => path.join(storageRoot, 'harvest', '127-0-0-1', '_manifest.json');
const indexPath = () => path.join(storageRoot, 'harvest', '127-0-0-1', '_index.md');
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));

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

// Both agents get the same storage config, exactly as the loader would.
const ctx = { config: { agents: { storage: { root: storageRoot, publicUrl: 'http://127.0.0.1:3100' } } } };
await initBrowser(ctx);
await initHarvest(ctx);

// The tool handler needs the browser agent, which the loader would have supplied.
const BROWSER = await import('../src/agents/browser/index.js');
const toolContext = { agents: new Map([['browser', await BROWSER.init(ctx)]]) };

console.log('\nharvest.collect smoke\n');

let result;
await step('collects the section and reports the manifest', async () => {
    result = await harvest_collect({ url: `${base}/docs/`, max_pages: 10 }, toolContext);
    console.log(text(result).split('\n').map(l => '       ' + l).join('\n'));
    assert.match(text(result), /^Harvested \d+ page\(s\) from/m);
    assert.match(text(result), /manifest\s+harvest\/127-0-0-1\/_manifest\.json/);
    assert.ok(fs.existsSync(manifestPath()), 'manifest written');
    assert.ok(fs.existsSync(indexPath()), 'readable index written');
});

await step('page files landed, with frontmatter, code and tables intact', async () => {
    const a = fs.readFileSync(path.join(storageRoot, 'harvest', '127-0-0-1', 'docs-a.md'), 'utf8');
    assert.match(a, /^---\nsource: /, 'provenance');
    assert.match(a, /```js\nconst a = 1;/, 'code fence');

    const b = fs.readFileSync(path.join(storageRoot, 'harvest', '127-0-0-1', 'docs-b.md'), 'utf8');
    assert.match(b, /\| x\s+\| y\s+\|/, 'table survived');
});

await step('the seed itself is collected, as the caller wrote it', async () => {
    const m = readManifest();
    assert.ok(
        m.pages.some(p => p.url === `${base}/docs/`),
        `seed missing from pages: ${m.pages.map(p => p.url).join(', ')}`
    );
});

await step('a page linked but not fetched is recorded, not lost', async () => {
    const m = readManifest();
    const reasons = m.not_fetched.map(d => `${d.url} :: ${d.reason}`);
    const has = (fragment) => reasons.some(r => r.includes(fragment));
    assert.ok(has('logo.png') && has('not a document'), `expected a "not a document" drop, got:\n${reasons.join('\n')}`);
    assert.ok(has('/blog/post') && has('outside the seed section'), `expected an out-of-section drop`);
    assert.ok(has('example.invalid') && has('different origin'), `expected a cross-origin drop`);
});

await step('failed pages are recorded with their error and the run continues', async () => {
    const m = readManifest();
    const failed = m.failed.map(f => `${f.url} :: ${f.error}`);
    assert.ok(failed.some(f => f.includes('/docs/missing')), `404 not recorded:\n${failed.join('\n')}`);
    assert.ok(failed.some(f => f.includes('/docs/blocked') && /block page/i.test(f)), `wall not recorded:\n${failed.join('\n')}`);
    assert.ok(m.pages.length >= 5, 'the rest still collected');
});

await step('discovery merges sitemap, llms.txt and nav', async () => {
    const m = readManifest();
    const names = m.sources.map(s => s.name);
    assert.ok(names.includes('sitemap.xml') && names.includes('llms.txt') && names.includes('nav links'), names.join(','));
    const urls = m.pages.map(p => p.url);
    assert.ok(urls.some(u => u.endsWith('/docs/e')), 'llms.txt-only page was not found');
});

await step('scope stays inside the section', async () => {
    const m = readManifest();
    assert.equal(m.section, '/docs/');
    assert.ok(!m.pages.some(p => p.url.includes('/blog/')), 'blog page leaked into the section');
});

await step('the budget is respected and the overspill is listed', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    const r = await harvest_collect({ url: `${base}/docs/`, max_pages: 3, select: 'heuristic' }, toolContext);
    const m = readManifest();
    assert.equal(m.pages.length, 3, `budget ignored: ${m.pages.length} pages`);
    const over = m.not_fetched.filter(d => d.reason.includes('budget'));
    assert.ok(over.length > 0, 'overspill not listed in the manifest');
    assert.match(text(r), /not fetched [1-9]/);
    assert.equal(m.selection.mode, 'heuristic');
});

// ---- the selecting model ------------------------------------------------
// A stub gateway: the point is the contract around the model, not the model.
function stubGateway(content, { fail = null } = {}) {
    return {
        chat: async (req) => {
            stubGateway.lastRequest = req;
            if (fail) throw new Error(fail);
            return { content, model: 'stub-local', finish_reason: 'stop' };
        }
    };
}

async function collectWith(gateway, args) {
    // A fresh browser API object per call, exactly as the loader supplies it.
    const browserApi = await BROWSER.init(ctx);
    return harvest_collect(args, { gateway, agents: new Map([['browser', browserApi]]) });
}

await step('selection sends the link list, labelled, and honours the model choice', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    // Candidates are numbered from 1 and exclude the seed; 1 and 2 are the two
    // shallowest pages, which the stub is told to pick.
    const gw = stubGateway('Sure! Here you go:\n```json\n[1, 2]\n```');
    const r = await collectWith(gw, { url: `${base}/docs/`, max_pages: 3, intent: 'the deep pages' });

    const req = stubGateway.lastRequest;
    assert.equal(req.model, 'badkid-llama-chat', 'the always-available local model is the default');
    assert.equal(req.task, undefined, 'task routing must not be sent alongside a model');
    assert.equal(req.stream, false, 'one-shot structured call: no streaming');
    assert.match(req.messages[0].content, /the deep pages/, 'intent reaches the prompt');
    assert.match(req.messages[0].content, /^1\. .+ — http/m, 'candidates are numbered and labelled');

    const m = readManifest();
    assert.equal(m.selection.mode, 'llm');
    assert.equal(m.selection.requested, 'badkid-llama-chat');
    assert.equal(m.selection.intent, 'the deep pages');
    assert.equal(m.selection.model_picks, 2);
    assert.equal(m.selection.topped_up, 0);
    assert.equal(m.pages.length + m.failed.length, 3, 'seed plus the two the model picked');
    assert.ok(m.not_fetched.some(d => /not selected \(discovered/.test(d.reason)), 'rejected links recorded');
    assert.match(r.content[0].text, /selection\s+llm/);
});

await step('the pages fetched are the ones the model named', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    // Line 4 of the candidate list, whatever it is: prove the mapping by reading
    // the prompt the tool actually sent, then checking the result against it.
    const gw = stubGateway('[4]');
    await collectWith(gw, { url: `${base}/docs/`, max_pages: 2 });

    const prompt = stubGateway.lastRequest.messages[0].content;
    const line4 = /^4\. (?:.*— )?(\S+)$/m.exec(prompt)?.[1];
    assert.ok(line4, 'could not read line 4 out of the prompt');

    const m = readManifest();
    assert.equal(m.selection.model_picks, 1);
    assert.ok(m.pages.some(p => p.url === line4) || m.failed.some(f => f.url === line4),
        `line 4 (${line4}) was neither fetched nor recorded as failed: ${JSON.stringify(m.pages.map(p => p.url))}`);
});

await step('deep mode scores every candidate in batches and ranks by score', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    // Score everything, giving the candidates descending scores so the intended
    // order is unambiguous.
    let call = 0;
    const gw = {
        chat: async (req) => {
            call++;
            const nums = [...req.messages[0].content.matchAll(/^(\d+)\. /gm)].map(m => Number(m[1]));
            const obj = {};
            for (const n of nums) obj[n] = Math.min(3, nums.length - n);
            return { content: JSON.stringify(obj), finish_reason: 'stop' };
        }
    };
    await collectWith(gw, { url: `${base}/docs/`, max_pages: 3, select: 'deep', intent: 'the deep pages' });

    const m = readManifest();
    assert.equal(m.selection.mode, 'deep');
    assert.ok(m.selection.batches >= 1, 'batches recorded');
    assert.equal(m.selection.scored, m.selection.considered, 'every candidate scored');
    assert.equal(
        m.selection.scores[0] + m.selection.scores[1] + m.selection.scores[2] + m.selection.scores[3],
        m.selection.scored,
        'histogram accounts for every scored candidate'
    );
    // max_pages 3 minus the guaranteed seed leaves two slots.
    assert.equal(m.selection.model_picks, 2, 'ranked selection fills the budget');
    assert.equal(m.pages.length + m.failed.length, 3, 'seed plus both picks');
    // The pages taken are the highest-scoring ones, i.e. the first in the list.
    const takenLabels = m.pages.filter(p => p.url !== `${base}/docs/`).map(p => p.title);
    assert.ok(takenLabels.includes('Page A'), `expected the top-scored candidates, got ${takenLabels}`);
});

await step('deep mode reports what the budget left at the cutoff', async () => {
    // Candidates outnumber the budget, and the scores are flat enough that more
    // than the budget sit at the cutoff — the signal a pick-N answer cannot give.
    const gw = { chat: async () => ({ content: '{"1":3,"2":3,"3":3,"4":3,"5":3}', finish_reason: 'stop' }) };
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await collectWith(gw, { url: `${base}/docs/`, max_pages: 3, select: 'deep' });

    const m = readManifest();
    assert.equal(m.selection.model_picks, 2);
    assert.ok(m.selection.left_at_cutoff > 0, `expected a non-zero cutoff count, got ${m.selection.left_at_cutoff}`);
    assert.equal(m.selection.scores[3] >= 3, true, 'all five scored as core');
});

await step('an unrated candidate is unknown, not irrelevant', async () => {
    // The model answers for only two of the candidates. The rest must not be
    // silently treated as score 0 — they rank below what was scored and stay
    // listed in the manifest.
    const gw = { chat: async () => ({ content: '{"1":3,"2":2}', finish_reason: 'stop' }) };
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await collectWith(gw, { url: `${base}/docs/`, max_pages: 2, select: 'deep' });

    const m = readManifest();
    assert.equal(m.selection.scored, 2);
    assert.equal(m.selection.scores.unrated, m.selection.considered - 2);
    assert.equal(m.selection.model_picks, 1, 'max_pages 2 minus the seed leaves one slot');
    // Nothing vanished: everything not fetched is listed with a reason.
    assert.equal(m.pages.length + m.failed.length + m.not_fetched.length >= m.selection.considered, true);
});

await step('deep mode that rates nothing falls back rather than dressing up list order', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await collectWith(stubGateway('no idea'), { url: `${base}/docs/`, max_pages: 3, select: 'deep' });
    const m = readManifest();
    assert.equal(m.selection.mode, 'heuristic', 'a model that rated nothing did not select anything');
    assert.match(m.selection.reason, /nothing usable/);
    assert.equal(m.pages.length, 3, 'still collected');
});

await step('a pinned model overrides the default', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    const gw = stubGateway('[1]');
    await collectWith(gw, { url: `${base}/docs/`, max_pages: 2, select_model: 'kimi-chat' });

    const req = stubGateway.lastRequest;
    assert.equal(req.model, 'kimi-chat');
    assert.equal(req.task, undefined, 'task must not be sent alongside a pinned model');
    assert.equal(readManifest().selection.requested, 'kimi-chat');
});

await step('the seed is always fetched, whatever the model picks', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await collectWith(stubGateway('[1]'), { url: `${base}/docs/`, max_pages: 3 });
    const m = readManifest();
    assert.ok(m.pages.some(p => p.url === `${base}/docs/`), `seed dropped: ${m.pages.map(p => p.url)}`);
    assert.ok(m.selection.considered > 0, 'no candidates were ever considered');
});

await step('a short model answer is topped up to the budget, and counted', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    const gw = stubGateway('[1]');
    await collectWith(gw, { url: `${base}/docs/`, max_pages: 4 });
    const m = readManifest();
    assert.equal(m.selection.mode, 'llm');
    assert.equal(m.selection.model_picks, 1);
    // Budget 4 minus the guaranteed seed leaves 3 slots; the model filled one.
    assert.equal(m.selection.topped_up, 2, `expected 2 topped up, got ${m.selection.topped_up}`);
    // Counted as fetched + failed: the budget was spent either way, and the
    // fixture deliberately contains a 404 and a block page.
    assert.equal(m.pages.length + m.failed.length, 4, 'budget not filled');
});

await step('model output full of prose and fences is still parsed', async () => {
    for (const [reply, expect] of [
        ['I think [2, 1] are best', 2],
        ['```json\n[1]\n```', 1],
        ['The answer is:\n[1, 2, 3, 99, 0, "2"]', 3],   // out-of-range and duplicate ignored
        ['[1]', 1]
    ]) {
        fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
        await collectWith(stubGateway(reply), { url: `${base}/docs/`, max_pages: 6 });
        const m = readManifest();
        assert.equal(m.selection.model_picks, expect, `reply ${JSON.stringify(reply)}`);
    }
});

await step('unusable model output falls back to heuristic and says so', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await collectWith(stubGateway('I am afraid I cannot help with that.'), { url: `${base}/docs/`, max_pages: 3 });
    const m = readManifest();
    assert.equal(m.selection.mode, 'heuristic');
    assert.match(m.selection.reason, /nothing usable/);
    assert.equal(m.pages.length, 3, 'still collected');
});
await step('a gateway failure falls back to heuristic and says why', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await collectWith(stubGateway('', { fail: 'gateway refused the connection' }), { url: `${base}/docs/`, max_pages: 3 });
    const m = readManifest();
    assert.equal(m.selection.mode, 'heuristic');
    assert.match(m.selection.reason, /gateway refused the connection/);
    assert.equal(m.pages.length, 3);
});

await step('select:heuristic never calls a model', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    const gw = stubGateway('[1]');
    stubGateway.lastRequest = undefined;
    await collectWith(gw, { url: `${base}/docs/`, max_pages: 3, select: 'heuristic' });
    assert.equal(stubGateway.lastRequest, undefined, 'the gateway was called');
    assert.equal(readManifest().selection.mode, 'heuristic');
});

await step('no gateway at all still harvests, and records why', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await harvest_collect({ url: `${base}/docs/`, max_pages: 3 }, toolContext);
    const m = readManifest();
    assert.equal(m.selection.mode, 'heuristic');
    assert.match(m.selection.reason, /no gateway available/);
});

await step('nothing to choose between means no model call and no budget reason', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    const gw = stubGateway('[1]');
    stubGateway.lastRequest = undefined;
    await collectWith(gw, { url: `${base}/docs/`, max_pages: 50 });
    const m = readManifest();
    assert.equal(m.selection.mode, 'all', 'everything fitted, so selection is not a decision');
    assert.equal(stubGateway.lastRequest, undefined, 'the gateway was called needlessly');
    assert.equal(m.not_fetched.filter(d => /budget|not selected/.test(d.reason)).length, 0);
});

await step('include/exclude narrow the scope further', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await harvest_collect({ url: `${base}/docs/`, max_pages: 20, include: ['/docs/deep/'] }, toolContext);
    const m = readManifest();
    assert.ok(m.pages.length > 0, 'nothing collected');
    assert.ok(m.pages.every(p => p.url.includes('/docs/deep/')), `include leaked: ${m.pages.map(p => p.url)}`);
    assert.ok(m.not_fetched.some(d => d.reason === 'not matched by include'), 'included-out links not recorded');
});

await step('whole_site widens the scope', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await harvest_collect({ url: `${base}/docs/`, max_pages: 20, whole_site: true }, toolContext);
    const m = readManifest();
    assert.equal(m.section, '/');
    assert.ok(m.pages.some(p => p.url.includes('/blog/post')), 'whole_site did not reach the blog');
});

await step('validation rejects bad input', async () => {
    const expect = async (args, pattern, label) => {
        try { await harvest_collect(args, toolContext); }
        catch (e) { assert.match(e.message, pattern, `${label}: wrong error`); return; }
        throw new Error(`${label}: expected a throw`);
    };
    await expect({}, /url is required/, 'missing url');
    await expect({ url: 'nonsense' }, /not a usable absolute/, 'bad url');
    await expect({ url: `${base}/docs/`, max_pages: 0 }, /max_pages must be/, 'zero budget');
    await expect({ url: `${base}/docs/`, dir: '../escape' }, /relative path inside storage/, 'dir escape');
});

await step('a harvest where every page fails throws', async () => {
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    try {
        // /blog/post links nowhere in section, so only the seed is a candidate —
        // and it 404s under this prefix-free scope.
        await harvest_collect({ url: `${base}/blog/post`, max_pages: 5, include: ['/definitely-not-there'] }, toolContext);
    } catch (e) {
        assert.match(e.message, /every one of|no extractable content|Failed/i, e.message);
        return;
    }
    throw new Error('expected a throw when nothing can be collected');
});

await step('manifest and index are self-consistent', async () => {
    // Runs on its own harvest: an earlier step deliberately wipes storage.
    fs.rmSync(path.join(storageRoot, 'harvest'), { recursive: true, force: true });
    await harvest_collect({ url: `${base}/docs/`, max_pages: 10 }, toolContext);

    const m = readManifest();
    const index = fs.readFileSync(indexPath(), 'utf8');
    for (const p of m.pages) {
        assert.ok(index.includes(p.url), `index missing ${p.url}`);
        assert.ok(fs.existsSync(path.join(storageRoot, p.storage)), `file missing for ${p.url}`);
    }
    assert.equal(m.links.fetched, m.pages.length);
    assert.equal(m.failed.length + m.pages.length, m.links.unique_in_section - m.not_fetched.filter(d => d.reason.includes('budget')).length);
});

server.close();
fs.rmSync(storageRoot, { recursive: true, force: true });
await shutdown().catch(() => {});

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
