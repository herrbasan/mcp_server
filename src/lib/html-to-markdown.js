// ============================================
// html-to-markdown — HTML → CommonMark serialization
// ============================================
//
// The workshop has had a hole here for a while. `extractContent()` (research
// scrapers) runs Readability and hands back `article.textContent`; the browser
// agent's `mode: 'markdown'` is that same plain text with '# Title' glued on
// top. Both flatten <pre><code> and <table> into prose — the two structures
// documentation is mostly made of. A harvested API reference arrived as porridge.
//
// This module is the missing half. Readability (or the raw document) selects
// what the content IS; a DOM walker then serializes it to CommonMark with code
// fences, GFM tables (colspan/rowspan resolved), nested lists, blockquotes and
// resolved absolute links intact.
//
// Contract: returns Markdown, or throws. It never returns a degraded empty
// string — a silently empty page is indistinguishable from a failed extraction,
// and a caller that harvests 50 pages must be able to tell which source it lost.
//
// Callers:
//   - src/agents/browser/index.js  (mode: 'markdown')
//   - docs-harvest (planned)       — one call per discovered page
//   - anything else that has HTML and needs structure

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

// Elements that never contribute content, in any scope.
const HARD_SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'canvas',
    'head', 'meta', 'link', 'title', 'base', 'object', 'embed'
]);

// Chrome removed only in document scope. Readability already drops these when
// it works; this is what keeps the document fallback from being pure nav.
const CHROME_SELECTOR = [
    'nav', 'aside', 'header', 'footer', 'form', 'dialog', 'menu',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '[aria-hidden="true"]', '[hidden]',
    '.skip-link', '.skip-to-content'
].join(',');

// Class/id tokens that name site furniture rather than content. Readability
// works this way too (its "unlikely candidates" regex); document scope has no
// other judgement to lean on, and without this a docs page arrives wrapped in
// its own table of contents and nav lists.
//
// Matched per hyphen/underscore-delimited token, not as a substring: a naive
// regex for `toc` also hits `stock`, and `nav` hits `navigation` but would also
// hit anything with those three letters in a row.
//
// `fixed` and `overlay` are here because a position:fixed element is not part of
// the document flow by construction — on Tailwind-based docs that is how the
// floating chat/help widgets are marked.
const UNLIKELY_TOKENS = new Set([
    'ad', 'ads', 'advert', 'advertisement', 'banner', 'breadcrumb', 'breadcrumbs',
    'cookie', 'cookies', 'combx', 'comment', 'comments', 'community', 'disqus',
    'extra', 'fixed', 'footer', 'gdpr', 'header', 'masthead', 'menu', 'modal',
    'nav', 'navbar', 'navigation', 'overlay', 'pager', 'pagination', 'popup',
    'related', 'remark', 'replies', 'rss', 'share', 'shoutbox', 'sidebar',
    'skyscraper', 'sponsor', 'toc', 'toolbar', 'widget'
]);

// Multi-word names that token splitting cannot catch ('table-of-contents'
// becomes table/of/contents, none of which is safe to match alone — 'contents'
// is as often the main content container as a table of contents).
const UNLIKELY_PHRASE = /table[-_\s]?of[-_\s]?contents/i;

// Never treat these as furniture, whatever their class says.
const KEEP_ALWAYS = new Set(['MAIN', 'ARTICLE', 'BODY', 'HTML']);

function isUnlikely(el) {
    if (KEEP_ALWAYS.has(el.nodeName)) return false;
    if (el.getAttribute('role') === 'main') return false;
    const tokens = [];
    const cls = el.getAttribute('class');
    if (cls) tokens.push(...cls.split(/\s+/));
    const id = el.getAttribute('id');
    if (id) tokens.push(id);
    if (UNLIKELY_PHRASE.test(cls || '') || UNLIKELY_PHRASE.test(id || '')) return true;
    return tokens.some(t => t.toLowerCase().split(/[-_]+/).some(p => UNLIKELY_TOKENS.has(p)));
}

// Remove site furniture from a body clone. Two passes: an explicit selector list
// for semantics the browser already knows, then token-based detection for the
// rest. Runs in document order, so an ancestor is usually gone before its
// descendants are considered — the getRootNode guard skips the orphans that
// leaves behind (they are checked against the clone root, which they no longer
// belong to).
function stripChrome(root) {
    let removed = 0;
    for (const el of Array.from(root.querySelectorAll(CHROME_SELECTOR))) {
        el.remove();
        removed++;
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.getRootNode() !== root) continue;
        if (isUnlikely(el)) {
            el.remove();
            removed++;
        }
    }
    return removed;
}

// Minimum length for Readability's output to be trusted over the raw document.
// Internal, and deliberately independent of the caller's `minChars` policy:
// this decides WHICH extraction to use, not whether the page is acceptable.
const MIN_READABILITY_CHARS = 200;
// ============================================
// Text escaping
// ============================================

// One pass, deliberately. Escaping in two passes double-escapes: the emphasis
// pass inserts a backslash that the hard-escape pass then escapes again, so
// `\*` becomes `\\*` and renders as a literal backslash.
const ESCAPE_TARGETS = /([\\`[\]<*_])/g;

function escapeText(s, atLineStart) {
    const escaped = s.replace(ESCAPE_TARGETS, (match, ch, off, str) => {
        // `*` and `_` only create emphasis at a word boundary. Escaping them
        // unconditionally turns every snake_case identifier into `option\_0` —
        // valid, but unreadable, and API documentation is full of them.
        if (ch === '*' || ch === '_') {
            const before = off > 0 ? str[off - 1] : '';
            const after = off + 1 < str.length ? str[off + 1] : '';
            if (/[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after)) return ch;
        }
        return '\\' + ch;
    });
    return atLineStart ? escapeBol(escaped) : escaped;
}

// Contextual escape for text that begins a line: a leading list marker, ATX
// heading or `>` would turn prose into structure. Applied only to text nodes
// that actually sit at the start of a line — generated constructs (a real list
// marker, a real heading) are emitted by the walker and must not be touched.
//
// Note the ordered-list case escapes the PERIOD, not the digits: a backslash
// only escapes ASCII punctuation, so `\1. text` is not an escape at all — it
// renders as a literal backslash. `1\. text` is the correct form.
function escapeBol(s) {
    return s
        .replace(/^(\s*)([-+*>])(?=\s)/, '$1\\$2')
        .replace(/^(\s*)(#{1,6})(?=\s)/, '$1\\$2')
        .replace(/^(\s*)(\d+)([.)])(?=\s)/, '$1$2\\$3');
}

// HTML semantics: whitespace runs collapse. Applied to non-<pre> text nodes,
// preserving one leading/trailing space so words at inline boundaries don't glue.
function collapseWs(s) {
    return s.replace(/[^\S\n]+/g, ' ');
}

// ============================================
// Inline serialization
// ============================================

// Longest run of `backticks` inside a string — used to size a fence that the
// content cannot close early.
function longestRun(s, ch) {
    let max = 0, run = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === ch) { run++; if (run > max) max = run; }
        else run = 0;
    }
    return max;
}

function inlineCodeSpan(text) {
    const body = collapseWs(text).replace(/^ | $/g, '');
    if (!body) return '';
    const fence = '`'.repeat(Math.max(1, longestRun(body, '`') + 1));
    // CommonMark: content that starts or ends with a backtick needs padding.
    const pad = (body.startsWith('`') || body.endsWith('`')) ? ' ' : '';
    return `${fence}${pad}${body}${pad}${fence}`;
}

function resolveUrl(raw, base) {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
    if (scheme) {
        const proto = scheme[1].toLowerCase();
        // Pure anchors stay anchors — resolving them against the page URL adds
        // noise that is wrong the moment the document leaves its host.
        if (proto === 'javascript' || proto === 'data' || proto === 'vbscript') return null;
        return trimmed;
    }
    if (trimmed.startsWith('#')) return trimmed;
    try {
        return new URL(trimmed, base).href;
    } catch {
        return trimmed;
    }
}

function isInsidePre(node) {
    for (let p = node.parentNode; p; p = p.parentNode) {
        if (p.nodeName === 'PRE') return true;
    }
    return false;
}

/**
 * Serialize an element's children as one inline string.
 * ctx: { base, keepLinks, keepImages, inTable, bol }
 *   bol — the first child begins a line, so its text needs BOL escaping.
 */
function inlineChildren(el, ctx) {
    let out = '';
    for (const child of el.childNodes) {
        const bol = ctx.bol && out === '';
        out += inlineNode(child, { ...ctx, bol });
    }
    return out;
}

function inlineNode(node, ctx) {
    if (node.nodeType === 3) {
        const raw = node.nodeValue;
        if (!raw) return '';
        const collapsed = isInsidePre(node) ? raw : collapseWs(raw);
        const atLineStart = ctx.bol === true && ctx.inTable !== true && collapsed.trim() !== '';
        return escapeText(collapsed, atLineStart);
    }
    if (node.nodeType !== 1) return '';

    const tag = node.nodeName.toLowerCase();
    if (HARD_SKIP.has(tag)) return '';

    switch (tag) {
        case 'br':
            // Hard break. `\` at end-of-line is CommonMark and survives editors
            // that strip trailing whitespace; inside a table cell it is illegal,
            // so the cell context asks for <br> instead.
            return ctx.inTable ? '<br>' : '\\\n';

        case 'wbr':
            return '';

        case 'code':
            return inlineCodeSpan(node.textContent || '');

        case 'strong':
        case 'b': {
            const inner = inlineChildren(node, ctx);
            return inner.trim() ? `**${inner}**` : '';
        }

        case 'em':
        case 'i': {
            const inner = inlineChildren(node, ctx);
            return inner.trim() ? `*${inner}*` : '';
        }

        case 'del':
        case 's':
        case 'strike': {
            const inner = inlineChildren(node, ctx);
            return inner.trim() ? `~~${inner}~~` : '';
        }

        case 'a': {
            const inner = inlineChildren(node, ctx);
            const text = inner.trim() ? inner : (node.textContent || '').trim();
            // An empty label is an icon-only anchor — a permalink glyph, a
            // sprite, a hidden heading link. Falling back to the href would
            // inject a bare URL into the prose for no reason.
            if (!text) return '';
            if (!ctx.keepLinks) return text;
            const href = resolveUrl(node.getAttribute('href'), ctx.base);
            if (!href) return text;
            // MediaWiki's per-section edit link points at the editor for the
            // page this came from, which is meaningless after harvesting.
            if (text.trim() === 'edit' && /action=edit/.test(href)) return '';
            // Permalink anchors: a lone section glyph pointing at a fragment of
            // the page it came from. Generators disagree on the glyph — '#',
            // '¶', '§', or none at all — and rustdoc puts its anchor in the
            // <summary> rather than in the heading, so this cannot be handled by
            // cleanHeadingText alone.
            if (href.startsWith('#') && /^[#¶§]$/.test(text.trim())) return '';
            // Autolink when the label is the URL itself — shorter and unambiguous.
            if (text === href) return `<${href}>`;
            return `[${text}](${href})`;
        }

        case 'img': {
            if (!ctx.keepImages) return '';
            const src = resolveUrl(node.getAttribute('src'), ctx.base);
            if (!src) return '';   // data: URIs and empty src carry nothing usable
            const alt = escapeText((node.getAttribute('alt') || '').trim(), false);
            const title = node.getAttribute('title');
            return title
                ? `![${alt}](${src} "${title.replace(/"/g, '\\"')}")`
                : `![${alt}](${src})`;
        }

        case 'kbd':
        case 'mark': {
            // No CommonMark equivalent, kept as raw HTML around the element's
            // literal text. Deliberately NOT inlineChildren(): markdown is not
            // parsed inside a raw HTML inline tag, so every escape we added
            // there would render as a literal backslash.
            const text = (node.textContent || '').trim();
            return text ? `<${tag}>${text}</${tag}>` : '';
        }

        case 'sup':
        case 'sub':
        case 'abbr':
        case 'time':
        case 'var':
        case 'samp':
            // Transparent, and NOT node.outerHTML. These carry arbitrary
            // attributes that mean nothing once the content leaves its page —
            // MediaWiki hangs a data-mw JSON blob off every citation <sup>,
            // which dumped hundreds of characters of markup into the document.
            return inlineChildren(node, ctx);

        case 'video':
        case 'audio': {
            if (!ctx.keepLinks) return '';
            const src = resolveUrl(node.getAttribute('src'), ctx.base)
                || resolveUrl(node.querySelector('source')?.getAttribute('src'), ctx.base);
            return src ? `<${src}>` : '';
        }

        case 'iframe': {
            if (!ctx.keepLinks) return '';
            const src = resolveUrl(node.getAttribute('src'), ctx.base);
            return src ? `<${src}>` : '';
        }

        case 'button':
        case 'input':
        case 'select':
        case 'textarea':
        case 'label':
            return '';

        default:
            // Unknown inline (span, font, small, ...) — transparent.
            return inlineChildren(node, ctx);
    }
}

// ============================================
// Block serialization
// ============================================

const HEADING_LEVELS = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

// Above this total column width, tables are emitted unpadded.
const TABLE_PAD_MAX = 160;

// <pre> class tokens that name a container or highlighter, never a language.
// Guessing a language from one of these would put ```highlight on half the web.
const GENERIC_PRE_CLASSES = new Set([
    'highlight', 'hljs', 'code', 'pre', 'codeblock', 'code-block', 'prism',
    'shiki', 'chroma', 'snippet', 'sample', 'example', 'linenums', 'monospace',
    'prettyprint', 'dark', 'light', 'notranslate', 'scroll', 'nowrap', 'wrap'
]);

function preBlock(node, ctx) {
    const codeEl = node.querySelector('code');
    const source = (codeEl || node).textContent || '';
    const code = source.replace(/\n+$/, '');
    if (!code.trim()) return null;

    // Explicit markers first, on either element — generators disagree about
    // whether the language goes on the <pre> or the <code>.
    let lang = '';
    for (const el of [codeEl, node]) {
        if (!el) continue;
        const m = /(?:language|lang|highlight-source)-([\w+#.]+)/i.exec(el.getAttribute('class') || '');
        if (m) { lang = m[1]; break; }
    }
    if (!lang) {
        for (const el of [codeEl, node]) {
            if (!el) continue;
            const dl = el.getAttribute('data-lang');
            if (dl) { lang = dl; break; }
        }
    }
    // Last resort: the <pre>'s own class is sometimes the language, as in
    // rustdoc's `<pre class="rust rust-example-rendered">`. Deliberately
    // narrow — single token, lowercase, no hyphen — so `item-decl` and
    // `line-numbers` cannot masquerade as one.
    if (!lang) {
        const tokens = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
        lang = tokens.find(t => !GENERIC_PRE_CLASSES.has(t.toLowerCase())
            && /^[a-z][a-z0-9+#]{1,13}$/.test(t)) || '';
    }

    const fence = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
    return `${fence}${lang}\n${code}\n${fence}`;
}

function listBlock(listEl, ctx) {
    const ordered = listEl.nodeName === 'OL';
    const start = ordered ? (parseInt(listEl.getAttribute('start') || '1', 10) || 1) : 1;

    const items = [];
    for (const child of listEl.children) {
        if (child.nodeName !== 'LI') continue;
        items.push(child);
    }
    if (!items.length) return null;

    // Pad ordered markers to equal width so every item in the list indents
    // identically — mixed 1./10. prefixes break CommonMark list continuity.
    const last = start + items.length - 1;
    const width = ordered ? String(last).length : 1;

    const lines = [];
    items.forEach((li, i) => {
        const marker = ordered
            ? String(start + i).padStart(width) + '.'
            : '-';
        // A checkbox item in a task list — GFM.
        const checked = li.getAttribute('data-checked');
        const box = checked === 'true' ? '[x] ' : (checked === 'false' ? '[ ] ' : '');

        // The li's own contents, as blocks. First block rides the marker line;
        // the rest are indented to the content column.
        const childBlocks = blocksFrom(li, { ...ctx, bol: false });
        const indent = ' '.repeat(marker.length + 1);

        const body = childBlocks.length ? childBlocks.join('\n\n') : '';
        const bodyLines = body.split('\n');
        const first = bodyLines[0] || '';
        lines.push(`${marker} ${box}${first}`);
        for (let k = 1; k < bodyLines.length; k++) {
            lines.push(bodyLines[k] ? indent + bodyLines[k] : '');
        }
        // A nested list is itself a child block and already carries indentation
        // relative to its own markers; it was rendered above with the indent.
        if (!bodyLines.length) lines.push('');
    });

    return lines.join('\n');
}

// Documentation generators bolt a permalink onto every heading: mkdocs wraps
// the whole heading in a self-link (`<h2><a href="#x">Title</a></h2>`), and
// Docusaurus glues an icon link to the front. Neither carries information in a
// harvested document — the anchor points back at the page it came from.
function cleanHeadingText(s) {
    return s
        // The lone glyph varies by generator: mkdocs uses none, Docusaurus '#',
        // Sphinx '¶', rustdoc '§'.
        .replace(/\[\s*[#¶§]?\s*\]\(#[^)]*\)/g, '')
        .replace(/^\[(.+)\]\(#[^)]*\)$/, '$1')
        .trim();
}

function blockquoteBlock(node, ctx) {    const inner = blocksFrom(node, { ...ctx, bol: true });
    if (!inner.length) return null;
    const text = inner.join('\n\n');
    return text.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');
}

function cellsOf(row) {
    return Array.from(row.children).filter(
        c => c.nodeName === 'TH' || c.nodeName === 'TD'
    );
}

function directRows(table) {
    const out = [];
    for (const child of table.children) {
        if (child.nodeName === 'TR') out.push(child);
        else if (child.nodeName === 'THEAD' || child.nodeName === 'TBODY' || child.nodeName === 'TFOOT') {
            for (const tr of child.children) {
                if (tr.nodeName === 'TR') out.push(tr);
            }
        }
    }
    return out;
}

function cellAlign(cell) {
    // data-align first: Readability deletes the presentational attributes
    // (align, style) during cleaning, and readabilityPass copies them here so
    // GFM column alignment survives the trip.
    const data = (cell.getAttribute('data-align') || '').toLowerCase();
    if (data === 'center' || data === 'right' || data === 'left') return data;

    const attr = (cell.getAttribute('align') || '').toLowerCase();
    if (attr === 'center' || attr === 'right' || attr === 'left') return attr;
    const style = (cell.getAttribute('style') || '').toLowerCase();
    const m = /text-align\s*:\s*(left|center|right)/.exec(style);
    return m ? m[1] : null;
}

function hasBlockChild(el) {
    return Array.from(el.children).some(c =>
        c.nodeName === 'P' || c.nodeName === 'UL' || c.nodeName === 'OL' ||
        c.nodeName === 'PRE' || c.nodeName === 'DIV' || c.nodeName === 'TABLE' ||
        c.nodeName === 'BLOCKQUOTE'
    );
}

function cellText(cell, ctx) {
    const cellCtx = { ...ctx, bol: true, inTable: true };
    let text;
    if (hasBlockChild(cell)) {
        const parts = blocksFrom(cell, cellCtx);
        text = parts.join('<br>');
    } else {
        text = inlineChildren(cell, cellCtx);
    }
    return text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function tableBlock(table, ctx) {
    const rows = directRows(table);
    if (!rows.length) return null;

    // Resolve colspan/rowspan into a rectangular grid. Carried (rowspan) cells
    // are re-materialised on each row they span so the pipes line up.
    const grid = [];
    const carry = new Map(); // column -> { text, align, isHeader, left }
    let width = 0;

    rows.forEach((tr, r) => {
        const cells = cellsOf(tr);
        const row = [];
        let ci = 0;
        let col = 0;

        while (ci < cells.length || carry.has(col)) {
            if (carry.has(col)) {
                const c = carry.get(col);
                row[col] = { text: c.text, align: c.align, isHeader: c.isHeader };
                c.left--;
                if (c.left <= 0) carry.delete(col);
                col++;
                continue;
            }

            const cell = cells[ci++];
            const text = cellText(cell, ctx);
            const align = cellAlign(cell);
            const isHeader = cell.nodeName === 'TH';
            const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
            const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);

            for (let i = 0; i < colspan; i++) {
                const value = i === 0 ? text : '';
                row[col] = { text: value, align, isHeader };
                if (rowspan > 1) {
                    carry.set(col, { text: value, align, isHeader, left: rowspan - 1 });
                }
                col++;
            }
        }

        for (let i = 0; i < row.length; i++) {
            if (!row[i]) row[i] = { text: '', align: null, isHeader: false };
        }
        width = Math.max(width, row.length);
        grid.push(row);
    });

    for (const row of grid) {
        for (let i = 0; i < width; i++) {
            if (!row[i]) row[i] = { text: '', align: null, isHeader: false };
        }
    }

    const header = grid[0];
    const body = grid.slice(1);

    const widths = [];
    for (let i = 0; i < width; i++) {
        let w = 3;
        for (const row of grid) w = Math.max(w, row[i].text.length);
        widths[i] = w;
    }

    const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
    // Padding makes small tables readable but inflates large ones badly (a
    // 40-row table grows by ~60%). Past the threshold, emit compact GFM — it
    // renders identically.
    const wideTable = widths.reduce((a, b) => a + b, 0) > TABLE_PAD_MAX;
    const formatRow = (row) => '| ' + row.map((c, i) =>
        wideTable ? c.text : pad(c.text, widths[i])
    ).join(' | ') + ' |';

    const delim = header.map((c, i) => {
        const dashes = '-'.repeat(widths[i]);
        if (c.align === 'left') return ':' + dashes.slice(1);
        if (c.align === 'right') return dashes.slice(0, -1) + ':';
        if (c.align === 'center') return ':' + dashes.slice(2) + ':';
        return dashes;
    });

    const lines = [formatRow(header), '| ' + delim.join(' | ') + ' |'];
    for (const row of body) lines.push(formatRow(row));
    return lines.join('\n');
}

function dlBlock(node, ctx) {
    const parts = [];
    for (const child of node.children) {
        if (child.nodeName === 'DT') {
            const t = inlineChildren(child, { ...ctx, bol: true });
            if (t.trim()) parts.push(`**${t.trim()}**`);
        } else if (child.nodeName === 'DD') {
            const inner = blocksFrom(child, { ...ctx, bol: true });
            if (inner.length) parts.push(inner.join('\n\n'));
        }
    }
    return parts.length ? parts.join('\n\n') : null;
}

function detailsBlock(node, ctx) {
    const summaryEl = node.querySelector('summary');
    const parts = [];
    if (summaryEl) {
        const t = inlineChildren(summaryEl, { ...ctx, bol: true });
        if (t.trim()) parts.push(`**${t.trim()}**`);
    }
    // blocksFrom() sees the <summary> too and skips it — without that skip the
    // summary is emitted twice, once bolded here and once inline below. That
    // doubled every method signature on a rustdoc page.
    const rest = blocksFrom(node, { ...ctx, bol: true }).filter(Boolean);
    if (rest.length) parts.push(rest.join('\n\n'));
    return parts.length ? parts.join('\n\n') : null;
}

function figureBlock(node, ctx) {
    const caption = node.querySelector('figcaption');
    const parts = [];
    if (caption) caption.remove();
    parts.push(...blocksFrom(node, ctx));
    if (caption) {
        const t = inlineChildren(caption, { ...ctx, bol: true });
        if (t.trim()) parts.push(`*${t.trim()}*`);
    }
    return parts.length ? parts.join('\n\n') : null;
}

// ============================================
// Block walker
// ============================================

const TRANSPARENT = new Set([
    'div', 'section', 'article', 'main', 'body', 'html', 'center',
    'address', 'fieldset', 'picture', 'slot'
]);

/**
 * Serialize an element's children as an array of block strings.
 * Joining with '\n\n' yields one blank line between blocks.
 */
function blocksFrom(el, ctx) {
    const out = [];
    let pendingInline = '';

    const flushInline = () => {
        const t = pendingInline.replace(/[^\S\n]+$/, '');
        if (t.trim()) out.push(t);
        pendingInline = '';
    };

    for (const child of el.childNodes) {
        if (child.nodeType === 3) {
            const collapsed = collapseWs(child.nodeValue);
            if (!collapsed.trim()) {
                // Whitespace between blocks is layout, but it also separates
                // inline runs — keep a single space mid-paragraph.
                if (pendingInline) pendingInline += ' ';
                continue;
            }
            pendingInline += escapeText(collapsed, pendingInline === '');
            continue;
        }
        if (child.nodeType !== 1) continue;

        const tag = child.nodeName.toLowerCase();

        if (HARD_SKIP.has(tag)) {
            flushInline();
            continue;
        }

        // Chrome that must not appear in the document fallback.
        if (ctx.scope === 'document' && typeof child.matches === 'function'
            && child.matches(CHROME_SELECTOR)) {
            flushInline();
            continue;
        }

        if (tag === 'br') {
            pendingInline += '\\\n';
            continue;
        }

        if (HEADING_LEVELS[tag]) {
            flushInline();
            const text = cleanHeadingText(inlineChildren(child, { ...ctx, bol: false }));
            if (text) out.push(`${'#'.repeat(HEADING_LEVELS[tag])} ${text}`);
            continue;
        }

        // Everything below is block-level: close any open inline run first.
        switch (tag) {
            case 'p': {
                flushInline();
                const text = inlineChildren(child, { ...ctx, bol: true }).trim();
                if (text) out.push(text);
                continue;
            }

            case 'pre': {
                flushInline();
                const b = preBlock(child, ctx);
                if (b) out.push(b);
                continue;
            }

            case 'ul':
            case 'ol': {
                flushInline();
                const b = listBlock(child, ctx);
                if (b) out.push(b);
                continue;
            }

            case 'blockquote':
            case 'q': {
                flushInline();
                const b = blockquoteBlock(child, ctx);
                if (b) out.push(b);
                continue;
            }

            case 'table': {
                flushInline();
                const b = tableBlock(child, ctx);
                if (b) out.push(b);
                continue;
            }

            case 'hr': {
                flushInline();
                // `***` rather than `---`: at root level in MD-Blocks a `---`
                // is a section separator, which would silently repaginate any
                // document this output is pasted into.
                out.push('***');
                continue;
            }

            case 'dl': {
                flushInline();
                const b = dlBlock(child, ctx);
                if (b) out.push(b);
                continue;
            }

            case 'details': {
                flushInline();
                const b = detailsBlock(child, ctx);
                if (b) out.push(b);
                continue;
            }

            case 'figure': {
                flushInline();
                const b = figureBlock(child, ctx);
                if (b) out.push(b);
                continue;
            }

            case 'li':
            case 'dt':
            case 'dd':
            case 'tr':
            case 'thead':
            case 'tbody':
            case 'tfoot':
            case 'td':
            case 'th':
            case 'caption':
            case 'figcaption': {
                // Handled by their parents; if orphaned, fall through to the
                // transparent path so nothing silently vanishes.
                break;
            }

            case 'summary': {
                flushInline();
                // Inside <details> the summary is rendered by detailsBlock();
                // emitting it here as well duplicated every rustdoc method
                // signature. An orphaned summary is still rendered.
                if (child.parentNode && child.parentNode.nodeName === 'DETAILS') continue;
                const text = inlineChildren(child, { ...ctx, bol: true }).trim();
                if (text) out.push(text);
                continue;
            }

            default:
                break;
        }

        if (TRANSPARENT.has(tag)) {
            flushInline();
            const inner = blocksFrom(child, ctx);
            if (inner.length) out.push(...inner);
            continue;
        }

        // Unknown element — treat as inline content rather than dropping it.
        pendingInline += inlineNode(child, { ...ctx, bol: pendingInline === '' });
    }

    flushInline();
    return out.filter(s => s && s.trim());
}

// ============================================
// Root selection
// ============================================

function readabilityPass(html, url) {
    // A separate parse on purpose. Readability mutates the document it is given
    // (it deletes everything that is not the article), and the document scope
    // needs that same tree intact. A clone is cheaper than a parse but its
    // baseURI is unreliable in jsdom — not worth the class of bug.
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    // Readability drops `align` and `style` while cleaning, which would silently
    // take GFM column alignment with it. Move the intent to data-align first —
    // data- attributes survive.
    for (const cell of doc.querySelectorAll('th[align],td[align],th[style],td[style]')) {
        const attr = (cell.getAttribute('align') || '').toLowerCase();
        const styleAlign = /text-align\s*:\s*(left|center|right)/i.exec(cell.getAttribute('style') || '');
        const align = ['left', 'center', 'right'].includes(attr) ? attr : (styleAlign ? styleAlign[1].toLowerCase() : null);
        if (align) cell.setAttribute('data-align', align);
    }

    // keepClasses must stay true: Readability strips class attributes when it
    // is false, taking `language-js` off every <code> with it.
    const reader = new Readability(doc, {
        charThreshold: 200,
        keepClasses: true
    });
    const article = reader.parse();
    if (!article || !article.content) return null;
    return {
        fragment: JSDOM.fragment(article.content),
        title: article.title || null,
        byline: article.byline || null,
        siteName: article.siteName || null,
        excerpt: article.excerpt || null,
        language: article.lang || null
    };
}

// ============================================
// Public API
// ============================================

/**
 * Serialize a DOM element (or DocumentFragment) to CommonMark.
 * No selection, no Readability — pure serialization.
 */
export function elementToMarkdown(root, options = {}) {
    if (!root || typeof root.childNodes === 'undefined') {
        throw new TypeError('elementToMarkdown: root must be a DOM element or fragment');
    }
    const ctx = {
        base: options.url || 'https://example.invalid/',
        keepLinks: options.keepLinks !== false,
        keepImages: options.keepImages !== false,
        inTable: false,
        bol: true,
        scope: options.scope === 'document' ? 'document' : 'article'
    };
    const blocks = blocksFrom(root, ctx);
    return blocks.join('\n\n');
}

function countStructures(markdown) {
    const lines = markdown.split('\n');
    let codeBlocks = 0, tables = 0, tableRows = 0;
    let inFence = false;

    for (const raw of lines) {
        // Trimmed: a fenced block inside a list item is indented, and counting
        // only column-zero fences under-reported codeBlocks badly (Docker's
        // install page showed 3 where the document held 18).
        const line = raw.trim();
        if (/^`{3,}/.test(line)) {
            inFence = !inFence;
            if (inFence) codeBlocks++;
            continue;
        }
        if (inFence) continue;
        if (!line.startsWith('|')) continue;
        // A delimiter row (|---|---|) is the signature of one table.
        if (/^\|[\s:|-]+\|$/.test(line)) tables++;
        else tableRows++;
    }

    return { codeBlocks, tables, tableRows };
}

// A structural count of what the page promised versus what the article kept.
// Returns a description of the loss, or null when the article is faithful.
function structuralLoss(articleFragment, docRoot) {
    if (!docRoot) return null;
    const count = (root, sel) => root.querySelectorAll(sel).length;
    for (const [sel, floor] of [['pre', 3], ['table', 2]]) {
        const inDoc = count(docRoot, sel);
        if (inDoc < floor) continue;
        const inArticle = count(articleFragment, sel);
        if (inArticle < inDoc * 0.5) return `${sel} ${inArticle}/${inDoc}`;
    }
    return null;
}

/**
 * Convert an HTML document to Markdown.
 *
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.url]        Base URL for resolving relative links.
 * @param {'auto'|'article'|'document'} [options.scope='auto']
 *   article  — Readability's content selection (docs pages, blog posts)
 *   document — the whole <body> minus chrome (reference pages Readability mangles)
 *   auto     — article, unless it looks like Readability ate the content
 * @param {number} [options.minChars=0] Reject an extraction shorter than this.
 *   Default 0 means only an EMPTY result is an error — a legitimately short
 *   page is the page's content, not a failure. Callers with a policy (a docs
 *   harvester that does not want stub pages) raise it deliberately.
 * @param {number} [options.maxLength=0]  Truncate at a block boundary. 0 = off.
 * @param {boolean} [options.keepLinks=true]
 * @param {boolean} [options.keepImages=true]
 * @returns {{markdown:string,title:string|null,byline:string|null,siteName:string|null,
 *            excerpt:string|null,language:string|null,strategy:string,
 *            stats:object}}
 * @throws {TypeError} input is not a non-empty string
 * @throws {Error} no extractable content
 */
export function htmlToMarkdown(html, options = {}) {
    if (typeof html !== 'string' || !html.trim()) {
        throw new TypeError('htmlToMarkdown: html must be a non-empty string');
    }
    const {
        url = null,
        scope = 'auto',
        minChars = 0,
        maxLength = 0
    } = options;

    if (!['auto', 'article', 'document'].includes(scope)) {
        throw new Error(`htmlToMarkdown: scope must be auto|article|document, got '${scope}'`);
    }

    const base = url || 'https://example.invalid/';
    const htmlLength = html.length;

    let dom;
    try {
        dom = new JSDOM(html, { url: base });
    } catch (e) {
        throw new Error(`htmlToMarkdown: HTML could not be parsed (${e.message})`);
    }

    const doc = dom.window.document;
    const docTitle = (doc.title || '').trim() || null;

    const serializeFragment = (fragment, scopeName) => {
        const ctx = {
            base,
            keepLinks: options.keepLinks !== false,
            keepImages: options.keepImages !== false,
            inTable: false,
            bol: true,
            scope: scopeName
        };
        return blocksFrom(fragment, ctx).join('\n\n');
    };

    const serializeDocument = () => {
        const body = doc.body;
        if (!body) return { markdown: '', clone: null };
        // Clone before stripping chrome so the live document stays whole.
        const clone = body.cloneNode(true);
        stripChrome(clone);
        return { markdown: serializeFragment(clone, 'document'), clone };
    };

    let article = null;
    if (scope !== 'document') {
        try {
            article = readabilityPass(html, base);
        } catch (e) {
            article = null; // Readability is a heuristic; a throw just means no article
        }
    }

    let chosen = null;

    if (scope === 'article') {
        if (!article) {
            throw new Error('htmlToMarkdown: Readability found no article content');
        }
        chosen = {
            markdown: serializeFragment(article.fragment, 'article'),
            strategy: 'readability',
            title: article.title || docTitle
        };
    } else if (scope === 'document') {
        chosen = {
            markdown: serializeDocument().markdown,
            strategy: 'document',
            title: docTitle
        };
    } else {
        const articleMd = article ? serializeFragment(article.fragment, 'article') : '';
        const docResult = serializeDocument();

        // Readability is a readability heuristic, not a fidelity guarantee. Its
        // conditional cleaning discards whole subtrees that score poorly, and a
        // div holding a page's code blocks is exactly the kind of node it throws
        // away — on docs.docker.com all 18 fenced blocks vanished from an
        // otherwise perfect article. So the article is only accepted if it kept
        // the page's STRUCTURE, not merely its prose.
        const loss = article ? structuralLoss(article.fragment, docResult.clone) : 'no article';

        // Fall back to the raw body when Readability came back with almost
        // nothing. An earlier rule also fell back whenever the body was merely
        // LONGER — that was wrong: Readability deletes "unlikely candidates"
        // (sidebar, comments, menu), and measuring by length made the fallback
        // resurrect exactly the junk it had correctly discarded.
        if (articleMd.trim().length >= MIN_READABILITY_CHARS && !loss) {
            chosen = {
                markdown: articleMd,
                strategy: 'readability',
                title: article.title || docTitle
            };
        } else {
            chosen = { markdown: docResult.markdown, strategy: 'document', title: docTitle };
        }
    }

    let markdown = normalizeBlocks(chosen.markdown);
    let truncated = false;

    if (maxLength > 0 && markdown.length > maxLength) {
        markdown = truncateAtBlock(markdown, maxLength);
        truncated = true;
    }

    if (markdown.trim().length <= minChars) {
        throw new Error(
            `htmlToMarkdown: no extractable content (${markdown.trim().length} chars from ` +
            `${htmlLength} of HTML, strategy '${chosen.strategy}', minChars ${minChars})`
        );
    }

    const stats = {
        htmlLength,
        markdownLength: markdown.length,
        reduction: Number((100 * (1 - markdown.length / htmlLength)).toFixed(1)),
        truncated,
        ...countStructures(markdown)
    };

    return {
        markdown,
        title: chosen.title,
        byline: article?.byline ?? null,
        siteName: article?.siteName ?? null,
        excerpt: article?.excerpt ?? null,
        language: article?.language ?? null,
        strategy: chosen.strategy,
        stats
    };
}

// Join is already blank-line separated; this just trims stray runs that nested
// constructs can leave behind, without touching whitespace inside code fences.
function normalizeBlocks(markdown) {
    if (!markdown) return '';
    const lines = markdown.split('\n');
    const out = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;

    for (const line of lines) {
        const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
        if (!inFence && fenceMatch) {
            inFence = true;
            fenceChar = fenceMatch[1][0];
            fenceLen = fenceMatch[1].length;
            out.push(line);
            continue;
        }
        if (inFence) {
            out.push(line);
            if (fenceMatch && fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen) {
                inFence = false;
            }
            continue;
        }
        // Outside fences: no runs of blank lines, no trailing spaces, and no
        // doubled interior spaces. The last one is what dropping an icon-only
        // link leaves behind ("before  after"). Table rows are exempt — their
        // padding IS runs of spaces between non-space characters.
        if (!line.trim()) {
            if (out.length && out[out.length - 1] !== '') out.push('');
            continue;
        }
        const trimmed = line.replace(/[^\S\n]+$/, '');
        out.push(line.startsWith('|')
            ? trimmed
            : trimmed.replace(/(\S)[^\S\n]{2,}(?=\S)/g, '$1 '));
    }

    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
}

function truncateAtBlock(markdown, maxLength) {
    const cut = markdown.slice(0, maxLength);
    const lastBreak = cut.lastIndexOf('\n\n');
    const body = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
    return `${body}\n\n*[truncated at ${maxLength} characters]*`;
}

export default htmlToMarkdown;
