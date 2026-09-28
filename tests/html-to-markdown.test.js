import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, elementToMarkdown } from '../src/lib/html-to-markdown.js';
import { JSDOM } from 'jsdom';

// ============================================
// Fail loud
// ============================================

test('throws on non-string input', () => {
    assert.throws(() => htmlToMarkdown(null), /must be a non-empty string/);
    assert.throws(() => htmlToMarkdown(42), /must be a non-empty string/);
    assert.throws(() => htmlToMarkdown('   '), /must be a non-empty string/);
});

test('throws when there is nothing to extract', () => {
    assert.throws(
        () => htmlToMarkdown('<html><body></body></html>'),
        /no extractable content/
    );
});

test('throws on an unknown scope', () => {
    assert.throws(
        () => htmlToMarkdown('<p>hi</p>', { scope: 'sidebar' }),
        /scope must be auto\|article\|document/
    );
});

test('throws when the caller sets a minChars policy it cannot meet', () => {
    assert.throws(
        () => htmlToMarkdown('<html><body><p>tiny</p></body></html>', { scope: 'document', minChars: 500 }),
        /no extractable content.*minChars 500/s
    );
});

// ============================================
// Code blocks — the reason this module exists
// ============================================

test('fenced code keeps its language and its exact body', () => {
    const html = `<html><body><article>
        <p>Install it:</p>
        <pre><code class="language-bash">npm install foo
npm run build</code></pre>
    </article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /```bash\nnpm install foo\nnpm run build\n```/);
});

test('code fence grows past backticks inside the code', () => {
    const html = `<html><body><article><pre><code class="language-js">const fence = \`\`\`js;\n</code></pre></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /````js\nconst fence = ```js;/);
    assert.match(markdown, /```\n?$/m);
});

test('code indentation and blank lines survive', () => {
    const body = 'def f():\n    x = 1\n\n    return x';
    const html = `<html><body><article><pre><code class="language-python">${body}</code></pre></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.ok(markdown.includes('    x = 1'));
    assert.ok(markdown.includes('def f():\n    x = 1\n\n    return x'));
});

test('inline code with backticks is fenced safely', () => {
    const html = '<html><body><article><p>Use <code>a`b</code> now.</p></article></body></html>';
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /Use ``a`b`` now\./);
});

// ============================================
// Tables
// ============================================

test('GFM table with alignment', () => {
    const html = `<html><body><article><table>
        <thead><tr><th align="left">Name</th><th align="center">Type</th><th align="right">Default</th></tr></thead>
        <tbody><tr><td>timeout</td><td>number</td><td>30000</td></tr></tbody>
    </table></article></body></html>`;
    const { markdown, stats } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^\| Name +\| Type +\| Default \|$/m);
    assert.match(markdown, /^\| :-+ \| :-+: \| -+: \|$/m);
    assert.match(markdown, /^\| timeout \| number \| 30000 +\|$/m);
    assert.equal(stats.tables, 1);
    assert.equal(stats.tableRows, 2);
});

test('table pipes inside cells are escaped', () => {
    const html = `<html><body><article><table><tr><th>A</th></tr><tr><td>a | b</td></tr></table></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /a \\\| b/);
});

test('colspan pads the row so pipes stay aligned', () => {
    const html = `<html><body><article><table>
        <tr><th>A</th><th>B</th><th>C</th></tr>
        <tr><td colspan="2">wide</td><td>c</td></tr>
    </table></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    const rows = markdown.split('\n').filter(l => l.startsWith('|'));
    const widths = rows.map(r => r.length);
    assert.equal(new Set(widths).size, 1, `all rows same width, got ${JSON.stringify(widths)}`);
});

test('rowspan re-materialises the carried cell', () => {
    const html = `<html><body><article><table>
        <tr><th>A</th><th>B</th></tr>
        <tr><td rowspan="2">shared</td><td>x</td></tr>
        <tr><td>y</td></tr>
    </table></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /\| shared \| x\s+\|/);
    assert.match(markdown, /\| shared \| y\s+\|/);
});

// ============================================
// Lists
// ============================================

test('nested lists indent correctly', () => {
    const html = `<html><body><article><ul>
        <li>one</li>
        <li>two<ul><li>two-a</li><li>two-b</li></ul></li>
    </ul></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^- one$/m);
    assert.match(markdown, /^ {2}- two-a$/m);
});

test('ordered lists past 9 pad the marker width', () => {
    const items = Array.from({ length: 11 }, (_, i) => `<li>item ${i + 1}</li>`).join('');
    const html = `<html><body><article><ol>${items}</ol></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^ 1\. item 1$/m);
    assert.match(markdown, /^11\. item 11$/m);
});

test('ol start attribute is honoured', () => {
    const html = `<html><body><article><ol start="5"><li>five</li><li>six</li></ol></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^5\. five$/m);
    assert.match(markdown, /^6\. six$/m);
});

test('multi-paragraph list items keep the content column', () => {
    const html = `<html><body><article><ul><li><p>first</p><p>second</p></li></ul></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^- first\n\n {2}second$/m);
});

// ============================================
// Inline + links
// ============================================

test('relative links and images resolve against the page URL', () => {
    const html = `<html><body><article>
        <p>See <a href="/guide/intro">the intro</a>.</p>
        <p><img src="img/diagram.png" alt="Diagram"></p>
    </article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://docs.example.com/api/v2', scope: 'article' });
    assert.match(markdown, /\[the intro\]\(https:\/\/docs\.example\.com\/guide\/intro\)/);
    assert.match(markdown, /!\[Diagram\]\(https:\/\/docs\.example\.com\/api\/img\/diagram\.png\)/);
});

test('pure anchors are left alone, javascript: links degrade to text', () => {
    const html = `<html><body><article>
        <p><a href="#section">jump</a></p>
        <p><a href="javascript:void(0)">clicky</a></p>
    </article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://docs.example.com/', scope: 'article' });
    assert.match(markdown, /\[jump\]\(#section\)/);
    assert.match(markdown, /^clicky$/m);
});

test('link whose label is the href becomes an autolink', () => {
    const html = `<html><body><article><p><a href="https://x.dev/a">https://x.dev/a</a></p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://x.dev/', scope: 'article' });
    assert.match(markdown, /<https:\/\/x\.dev\/a>/);
});

test('emphasis and strikethrough', () => {
    const html = `<html><body><article><p><strong>bold</strong> and <em>it</em> and <del>gone</del></p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /\*\*bold\*\* and \*it\* and ~~gone~~/);
});

// ============================================
// Escaping — prose must not become structure
// ============================================

test('prose that looks like markdown is escaped', () => {
    const html = `<html><body><article>
        <p>Use the * wildcard and the _ underscore.</p>
        <p>1. This is not a list item.</p>
        <p>- nor is this.</p>
        <p># nor this heading.</p>
    </article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /Use the \\\* wildcard and the \\_ underscore\./);
    assert.match(markdown, /^1\\\. This is not a list item\.$/m);
    assert.match(markdown, /^\\- nor is this\.$/m);
    assert.match(markdown, /^\\# nor this heading\.$/m);
});

test('generated list markers and headings are not escaped', () => {
    const html = `<html><body><article><h2>Title</h2><ul><li>alpha</li></ul></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^## Title$/m);
    assert.match(markdown, /^- alpha$/m);
    assert.doesNotMatch(markdown, /\\-/);
    assert.doesNotMatch(markdown, /\\#/);
});

test('a literal < is escaped so it cannot look like HTML', () => {
    const html = `<html><body><article><p>the &lt;div&gt; element</p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /the \\<div> element/);
});

test('snake_case identifiers are not mangled into option\\_0', () => {
    const html = `<html><body><article><p>Set <code>max_tokens</code> and the <var>batch_size</var> option.</p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /max_tokens/);
    assert.doesNotMatch(markdown, /max\\_tokens/);
    assert.doesNotMatch(markdown, /batch\\_size/);
});

// ============================================
// Structure handling
// ============================================

test('blockquote nests', () => {
    const html = `<html><body><article><blockquote><p>quoted</p><blockquote><p>deeper</p></blockquote></blockquote></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^> quoted$/m);
    assert.match(markdown, /^> > deeper$/m);
});

test('hr becomes *** not ---, to survive MD-Blocks', () => {
    const html = `<html><body><article><p>a</p><hr><p>b</p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^a\n\n\*\*\*\n\nb$/m);
    assert.doesNotMatch(markdown, /^---$/m);
});

test('script, style and svg contribute nothing', () => {
    const html = `<html><head><style>.x{color:red}</style></head><body><article>
        <p>real</p>
        <script>alert('no')</script>
        <svg><circle r="1"/></svg>
    </article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.doesNotMatch(markdown, /alert|color:red|circle/);
    assert.match(markdown, /real/);
});

test('task list checkboxes are preserved', () => {
    const html = `<html><body><article><ul>
        <li data-checked="true">done</li><li data-checked="false">todo</li>
    </ul></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /^- \[x\] done$/m);
    assert.match(markdown, /^- \[ \] todo$/m);
});

test('figure caption becomes emphasis under the image', () => {
    const html = `<html><body><article><figure>
        <img src="/a.png" alt="A"><figcaption>The caption</figcaption>
    </figure></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://x.dev/', scope: 'article' });
    assert.match(markdown, /!\[A\]\(https:\/\/x\.dev\/a\.png\)/);
    assert.match(markdown, /\*The caption\*/);
});

test('definition lists render as bold terms', () => {
    const html = `<html><body><article><dl><dt>term</dt><dd>definition</dd></dl></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /\*\*term\*\*\n\ndefinition/);
});

test('a details summary is emitted once, not twice', () => {
    // rustdoc wraps every method in <details><summary>; emitting the summary
    // both bolded and inline doubled every signature on the page.
    const html = `<html><body><article><details class="toggle">
        <summary><section class="method"><h4>fn len(&amp;self) -&gt; usize</h4></section></summary>
        <div class="docblock"><p>Returns the number of elements.</p></div>
    </details></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    const occurrences = markdown.split('fn len').length - 1;
    assert.equal(occurrences, 1, `expected the signature once, got:\n${markdown}`);
    assert.match(markdown, /Returns the number of elements\./);
});

test('rustdoc section-mark permalinks are stripped from headings', () => {
    const html = `<html><body><article><h5><a href="#examples-123">§</a>Examples</h5></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://doc.rust-lang.org/std/vec/struct.Vec.html', scope: 'article' });
    assert.equal(markdown, '##### Examples');
});

test('a standalone permalink glyph is dropped outside headings too', () => {
    // rustdoc puts its anchor in the <details> summary, not in the heading.
    const html = `<html><body><article><details><summary><code>fn len()</code> <a href="#method.len" class="anchor">§</a></summary><p>Body.</p></details></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://doc.rust-lang.org/std/vec/struct.Vec.html', scope: 'article' });
    assert.doesNotMatch(markdown, /§/);
    assert.match(markdown, /fn len\(\)/);
});

test('code language falls back to the pre element class', () => {
    const html = `<html><body><article><pre class="rust rust-example-rendered"><code>let v = [1];</code></pre></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /```rust\nlet v = \[1\];\n```/);
});

test('a generic pre class is not mistaken for a language', () => {
    for (const cls of ['highlight', 'hljs', 'code-block', 'line-numbers', 'item-decl']) {
        const html = `<html><body><article><pre class="${cls}"><code>plain</code></pre></article></body></html>`;
        const { markdown } = htmlToMarkdown(html, { scope: 'article' });
        assert.match(markdown, /```\nplain\n```/, `class '${cls}' should not become a language`);
    }
});

test('a language marker on the pre element is honoured', () => {
    const html = `<html><body><article><pre class="language-yaml"><code>a: 1</code></pre></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.match(markdown, /```yaml\na: 1\n```/);
});

test('mkdocs-style permalink heading unwraps to plain text', () => {
    const html = `<html><body><article><h2><a href="#highlights">Highlights</a></h2></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://docs.astral.sh/uv/', scope: 'article' });
    assert.equal(markdown, '## Highlights');
});

test('docusaurus-style icon anchor is dropped from the heading', () => {
    const html = `<html><body><article><h2><a href="#x" aria-hidden="true">#</a>Installation</h2></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://x.dev/', scope: 'article' });
    assert.equal(markdown, '## Installation');
});

test('an icon-only link does not inject a bare URL into the prose', () => {
    const html = `<html><body><article><p>before <a href="https://x.dev/icon.png"></a> after</p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://x.dev/', scope: 'article' });
    assert.equal(markdown, 'before after');
});

// ============================================
// Document scope
// ============================================

test('document scope drops nav/header/footer chrome', () => {
    const html = `<html><body>
        <header><h1>Site name</h1></header>
        <nav><a href="/a">Home</a><a href="/b">Docs</a></nav>
        <main><p>The actual content, long enough to matter.</p></main>
        <footer>© 2026</footer>
    </body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://x.dev/', scope: 'document' });
    assert.match(markdown, /actual content/);
    assert.doesNotMatch(markdown, /Site name|Home|Docs|2026/);
});

test('document scope drops token-named furniture, not just semantic tags', () => {
    const html = `<html><body>
        <div class="table-of-contents"><a href="#a">A</a><a href="#b">B</a></div>
        <div class="sidebar">Sidebar junk</div>
        <div id="comments"><p>comment junk</p></div>
        <div class="breadcrumbs"><a href="/">Root</a></div>
        <main><p>The real content, which must survive all of this.</p></main>
    </body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://x.dev/', scope: 'document' });
    assert.match(markdown, /The real content/);
    assert.doesNotMatch(markdown, /Sidebar junk|comment junk|Root|table-of-contents/i);
});

test('token matching does not fire on innocent words containing toc/nav', () => {
    // 'stock', 'canvas' and 'governance' must not read as furniture.
    const html = `<html><body><main>
        <p class="stock-note">Stock levels and canvas sizes are fine, as is governance.</p>
    </main></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'document' });
    assert.match(markdown, /Stock levels and canvas sizes/);
});

test('a <sup> carries its text but not its attributes', () => {
    // MediaWiki hangs a data-mw JSON blob off every citation marker; emitting
    // outerHTML dumped hundreds of characters of markup into the document.
    const html = `<html><body><article><p>JSON was specified in the 2000s<sup class="mw-ref" id="cite_ref-1" data-mw="{&quot;name&quot;:&quot;ref&quot;,&quot;body&quot;:{&quot;id&quot;:&quot;cite_note-1&quot;}}"><a href="#cite_note-1">[1]</a></sup> by someone.</p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://en.wikipedia.org/wiki/JSON', scope: 'article' });
    assert.doesNotMatch(markdown, /data-mw|mw-ref|<sup/);
    // The citation anchor is a pure fragment, so it stays a fragment rather than
    // being rewritten to an absolute URL that only works on the source host.
    assert.equal(markdown, 'JSON was specified in the 2000s[\\[1\\]](#cite_note-1) by someone.');
});

test('MediaWiki section edit links are dropped', () => {
    const html = `<html><body><article><h2>Naming <a href="https://en.wikipedia.org/w/index.php?title=JSON&amp;action=edit&amp;section=1">edit</a></h2><p>Body text.</p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { url: 'https://en.wikipedia.org/wiki/JSON', scope: 'article' });
    assert.match(markdown, /^## Naming$/m);
    assert.doesNotMatch(markdown, /action=edit/);
});

test('code blocks inside list items are counted', () => {
    // The stat used to count only column-zero fences and under-reported badly.
    const html = `<html><body><article><p>Steps:</p><ol>
        <li>First, run it:
            <pre><code class="language-bash">apt remove docker.io</code></pre>
        </li>
    </ol></article></body></html>`;
    const { markdown, stats } = htmlToMarkdown(html, { scope: 'article' });
    assert.equal(stats.codeBlocks, 1);
    // Indented three spaces: the content column of an `1. ` list marker.
    assert.match(markdown, /\n {3}```bash\n {3}apt remove docker\.io\n {3}```/);
});

test('auto falls back to document when Readability finds almost nothing', () => {
    // Readability returns the short <main> here, which is under the internal
    // adequacy threshold — so the whole body is serialized instead, chrome gone.
    const html = `<html><body>
        <header><h1>Site name</h1></header>
        <nav><a href="/a">Home</a><a href="/b">Docs</a></nav>
        <main><p>Short content.</p></main>
        <footer>© 2026</footer>
    </body></html>`;
    const { markdown, strategy } = htmlToMarkdown(html, { url: 'https://x.dev/', scope: 'auto' });
    assert.equal(strategy, 'document');
    assert.match(markdown, /Short content\./);
    assert.doesNotMatch(markdown, /Site name|Home|2026/);
});

test('auto prefers Readability on a normal article', () => {
    const paras = Array.from({ length: 30 }, (_, i) =>
        `<p>Paragraph ${i} with enough prose to satisfy the extractor's threshold comfortably.</p>`
    ).join('');
    const html = `<html><head><title>Doc</title></head><body>
        <nav><a href="/a">Home</a></nav>
        <article>${paras}</article>
    </body></html>`;
    const { markdown, strategy, title } = htmlToMarkdown(html, { url: 'https://x.dev/', scope: 'auto' });
    assert.equal(strategy, 'readability');
    assert.equal(title, 'Doc');
    assert.doesNotMatch(markdown, /Home/);
});

// ============================================
// Options + stats
// ============================================

test('maxLength truncates at a block boundary and reports it', () => {
    const paras = Array.from({ length: 20 }, (_, i) => `<p>${'x'.repeat(80)} ${i}</p>`).join('');
    const html = `<html><body><article>${paras}</article></body></html>`;
    const { markdown, stats } = htmlToMarkdown(html, { scope: 'article', maxLength: 300 });
    assert.ok(markdown.length < 400);
    assert.equal(stats.truncated, true);
    assert.match(markdown, /\[truncated at 300 characters\]/);
});

test('no truncation by default, and stats are honest', () => {
    const paras = Array.from({ length: 20 }, (_, i) => `<p>${'x'.repeat(80)} ${i}</p>`).join('');
    const html = `<html><body><article>${paras}</article></body></html>`;
    const { markdown, stats } = htmlToMarkdown(html, { scope: 'article' });
    assert.equal(stats.truncated, false);
    assert.equal(stats.markdownLength, markdown.length);
    assert.equal(stats.htmlLength, html.length);
    assert.ok(stats.reduction > 0);
});

test('keepLinks:false drops hrefs but keeps the text', () => {
    const html = `<html><body><article><p><a href="https://x.dev/a">label</a></p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article', keepLinks: false });
    assert.match(markdown, /^label$/m);
    assert.doesNotMatch(markdown, /x\.dev/);
});

test('no triple blank lines outside code', () => {
    const html = `<html><body><article><div></div><p>a</p><section><div/><hr/></section><p>b</p></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.doesNotMatch(markdown, /\n{3,}/);
});

test('trailing newlines are trimmed, no trailing spaces anywhere', () => {
    const html = `<html><body><article><h1>T</h1><p>a</p><ul><li>x</li></ul></article></body></html>`;
    const { markdown } = htmlToMarkdown(html, { scope: 'article' });
    assert.equal(markdown, markdown.replace(/\s+$/, ''));
    for (const line of markdown.split('\n')) {
        assert.equal(line, line.replace(/[^\S\n]+$/, ''), `trailing space in: "${line}"`);
    }
});

// ============================================
// elementToMarkdown — no selection, pure serialize
// ============================================

test('elementToMarkdown serializes a fragment directly', () => {
    const dom = new JSDOM('<div id="x"><h2>H</h2><pre><code class="language-js">let a = 1;</code></pre></div>');
    const el = dom.window.document.getElementById('x');
    const md = elementToMarkdown(el, { url: 'https://x.dev/' });
    assert.match(md, /^## H\n\n```js\nlet a = 1;\n```$/);
});

test('elementToMarkdown rejects a non-element', () => {
    assert.throws(() => elementToMarkdown(null), /must be a DOM element or fragment/);
    assert.throws(() => elementToMarkdown('nope'), /must be a DOM element or fragment/);
});
