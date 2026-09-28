// Sweep real documentation pages through the converter and report quality.
//
// Not part of the test suite — it hits the network. Run it by hand after
// touching src/lib/html-to-markdown.js, especially after changing escaping,
// tables or chrome handling.
//
//   node tests/page-sweep.mjs                     → the built-in URL list
//   node tests/page-sweep.mjs <url> [url ...]     → your own list
//   node tests/page-sweep.mjs --scope document    → force a scope
//
// Outputs land in <tmp>/html-to-markdown-sweep/<slug>.md for eyeballing.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { htmlToMarkdown } from '../src/lib/html-to-markdown.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// A spread of doc generators, each with a different idea of what a page is.
const DEFAULT_URLS = [
    'https://docs.python.org/3/library/json.html',            // Sphinx
    'https://docs.astral.sh/uv/',                             // mkdocs-material
    'https://doc.rust-lang.org/std/vec/struct.Vec.html',      // rustdoc, huge API tables
    'https://fastapi.tiangolo.com/tutorial/body/',            // mkdocs-material, tabs
    'https://vite.dev/guide/',                                // vitepress
    'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch', // MDN
    'https://kubernetes.io/docs/concepts/configuration/configmap/',           // Hugo
    'https://www.postgresql.org/docs/current/sql-select.html',                // DocBook
    'https://docs.docker.com/engine/install/ubuntu/',                         // Docker
    'https://docs.pydantic.dev/latest/',                      // mkdocs
    'https://react.dev/reference/react/useState',             // react.dev
    'https://en.wikipedia.org/wiki/JSON'                      // heavy-chrome adversarial case
];

// Words and phrases that only ever appear in site chrome. Their presence in the
// output is a signal that content selection let the frame through.
// Deliberately specific: bare 'cookie' fires on any page that legitimately
// documents cookies, which is a large slice of the Web platform docs.
const CHROME_SIGNALS = [
    'skip to main content', 'skip to content', 'we use cookies', 'accept cookies',
    'on this page', 'table of contents', 'was this page helpful',
    'edit this page', 'all rights reserved', 'toggle navigation',
    'breadcrumb', 'search the docs', 'additional resources'
];

const args = process.argv.slice(2);
let scope = 'auto';
let diagnose = false;
let useFetchTool = false;
const urls = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scope') scope = args[++i];
    else if (args[i] === '--diagnose') diagnose = true;
    else if (args[i] === '--fetch') useFetchTool = true;
    else urls.push(args[i]);
}
const targets = urls.length ? urls : DEFAULT_URLS;

// --fetch runs the real browser.fetch tool (init + HTTP + storage write) instead
// of the converter directly, so the whole path is exercised against live sites.
if (useFetchTool) {
    const os = await import('node:os');
    const { init, browser_fetch, shutdown } = await import('../src/agents/browser/index.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-sweep-'));
    await init({ config: { agents: { storage: { root, publicUrl: 'http://127.0.0.1:3100' } } } });
    console.log(`\nbrowser.fetch sweep — storage root ${root}\n`);
    for (const url of targets) {
        try {
            const r = await browser_fetch({ url, scope });
            const lines = r.content[0].text.split('\n');
            console.log(lines.map(l => '  ' + l).join('\n'));
        } catch (e) {
            console.log(`  FAILED ${url}\n         ${e.message}`);
        }
        console.log('');
    }
    await shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
}

const outDir = path.join(os.tmpdir(), 'html-to-markdown-sweep');
if (!diagnose) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
}

const slug = (u) => u.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90);

// Where did the structure go? Compares the raw page against what each
// extraction strategy actually produced, so a missing code block or table can
// be traced to selection rather than to serialization.
async function diagnoseUrl(url) {
    const html = await fetchHtml(url);
    const count = (s, re) => (s.match(re) || []).length;

    console.log(`\n=== ${url}`);
    console.log(`raw HTML          : ${html.length} chars, <pre> ${count(html, /<pre[\s>]/gi)}, ` +
        `<table> ${count(html, /<table[\s>]/gi)}, <code ${count(html, /<code[\s>]/gi)}`);

    for (const s of ['article', 'document']) {
        try {
            const r = htmlToMarkdown(html, { url, scope: s });
            console.log(`${s.padEnd(18)}: ${String(r.stats.markdownLength).padStart(7)} chars, ` +
                `codeBlocks ${String(r.stats.codeBlocks).padStart(3)}, tables ${r.stats.tables}, ` +
                `tableRows ${String(r.stats.tableRows).padStart(3)} | ${r.title || '(no title)'}`);
        } catch (e) {
            console.log(`${s.padEnd(18)}: THREW ${e.message}`);
        }
    }

    const auto = htmlToMarkdown(html, { url, scope });
    const lower = auto.markdown.toLowerCase();
    const hits = CHROME_SIGNALS.filter(x => lower.includes(x));
    console.log(`chrome signals    : ${hits.length ? hits.join(', ') : 'none'}`);
}

if (diagnose) {
    for (const url of targets) {
        try { await diagnoseUrl(url); } catch (e) { console.log(`\n=== ${url}\nFETCH FAILED: ${e.message}`); }
    }
    process.exit(0);
}

async function fetchHtml(url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
            redirect: 'follow',
            signal: ac.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

const rows = [];

for (const url of targets) {
    const name = slug(url);
    let line = { url, name };
    try {
        const html = await fetchHtml(url);
        const r = htmlToMarkdown(html, { url, scope });

        const md = r.markdown;
        const lower = md.toLowerCase();
        const hits = CHROME_SIGNALS.filter(s => lower.includes(s));
        const headings = (md.match(/^#{1,6} /gm) || []).length;
        const fences = (md.match(/^`{3,}/gm) || []).length / 2;
        const tableRows = (md.match(/^\|/gm) || []).length;

        fs.writeFileSync(path.join(outDir, `${name}.md`), md, 'utf8');

        line = {
            ...line,
            ok: true,
            title: r.title,
            strategy: r.strategy,
            htmlLen: r.stats.htmlLength,
            mdLen: r.stats.markdownLength,
            reduction: r.stats.reduction,
            code: r.stats.codeBlocks,
            tables: r.stats.tables,
            headings,
            fences,
            tableRows,
            warnings: hits
        };
    } catch (e) {
        line = { ...line, ok: false, error: e.message };
    }
    rows.push(line);
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

console.log(`\nscope=${scope}   ${targets.length} pages   output: ${outDir}\n`);
console.log(
    pad('page', 34) + pad('strategy', 12) + pad('html kB', 9) + pad('md kB', 8) +
    pad('red %', 7) + pad('code', 6) + pad('tbl', 5) + pad('h', 5) + 'warnings'
);
console.log('-'.repeat(120));

let failures = 0;
for (const r of rows) {
    const label = r.name.length > 32 ? r.name.slice(0, 31) + '…' : r.name;
    if (!r.ok) {
        failures++;
        console.log(pad(label, 34) + pad('FAILED', 12) + r.error);
        continue;
    }
    console.log(
        pad(label, 34) +
        pad(r.strategy, 12) +
        pad((r.htmlLen / 1000).toFixed(0), 9) +
        pad((r.mdLen / 1000).toFixed(1), 8) +
        pad(r.reduction, 7) +
        pad(r.code, 6) +
        pad(r.tables, 5) +
        pad(r.headings, 5) +
        (r.warnings.length ? r.warnings.join(', ') : '—')
    );
}

const ok = rows.filter(r => r.ok);
const empty = ok.filter(r => r.mdLen < 500);
console.log('-'.repeat(120));
console.log(
    `${ok.length}/${rows.length} converted, ${failures} failed, ${empty.length} suspiciously short` +
    (empty.length ? ` (${empty.map(r => r.name).join(', ')})` : '')
);
console.log(`\nEyeball the output: Get-Content "${outDir}\<page>.md"`);
