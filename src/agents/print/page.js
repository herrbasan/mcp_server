import '/nui/nui.js';

const job = JSON.parse(document.getElementById('print-job').textContent);
const output = document.getElementById('output');

const FORMATS = new Set(['A4', 'A5', 'Letter', 'Legal']);
const STYLES = new Set(['editorial', 'minimal', 'classic']);
const ORIENTATIONS = new Set(['portrait', 'landscape']);
const LENGTH = /^\d+(?:\.\d+)?(?:mm|cm|in|px)$/;

function resolveBreakIds(value, name) {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim())) {
        throw new Error(`print.render: ${name} must be an array of non-empty MD-Blocks IDs`);
    }
    if (new Set(value).size !== value.length) throw new Error(`print.render: ${name} contains duplicate IDs`);
    return value;
}

function resolveOptions(frontmatter) {
    const authored = frontmatter?.print && typeof frontmatter.print === 'object' ? frontmatter.print : {};
    const requested = job.options;
    const format = String(requested.format ?? authored.format ?? 'A4');
    const normalizedFormat = format.length === 2 ? format.toUpperCase() : format[0].toUpperCase() + format.slice(1).toLowerCase();
    if (!FORMATS.has(normalizedFormat)) throw new Error(`print.render: unsupported page format "${format}"`);

    const orientation = String(requested.orientation ?? authored.orientation ?? 'portrait').toLowerCase();
    if (!ORIENTATIONS.has(orientation)) throw new Error(`print.render: orientation must be portrait or landscape`);

    const marginInput = requested.margin ?? authored.margin ?? { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' };
    if (typeof marginInput !== 'string' && (!marginInput || typeof marginInput !== 'object' || Array.isArray(marginInput))) {
        throw new Error('print.render: margin must be a CSS length or an object with page sides');
    }
    const margin = typeof marginInput === 'string'
        ? { top: marginInput, right: marginInput, bottom: marginInput, left: marginInput }
        : {
            top: marginInput.top ?? '18mm',
            right: marginInput.right ?? '16mm',
            bottom: marginInput.bottom ?? '18mm',
            left: marginInput.left ?? '16mm'
        };
    for (const [side, value] of Object.entries(margin)) {
        if (typeof value !== 'string' || !LENGTH.test(value)) {
            throw new Error(`print.render: margin.${side} must be a non-negative mm/cm/in/px value`);
        }
    }

    const style = String(requested.style ?? authored.style ?? 'editorial').toLowerCase();
    if (!STYLES.has(style)) throw new Error(`print.render: style must be editorial, minimal, or classic`);

    return {
        style,
        format: normalizedFormat,
        orientation,
        margin,
        sectionPages: Boolean(requested.sectionPages ?? authored.sectionPages ?? false),
        breakBefore: resolveBreakIds(requested.breakBefore ?? authored.breakBefore ?? [], 'breakBefore'),
        breakAfter: resolveBreakIds(requested.breakAfter ?? authored.breakAfter ?? [], 'breakAfter')
    };
}

function applyBreaks(ids, className) {
    for (const id of ids) {
        const matches = [...output.querySelectorAll('[id]')].filter((el) => el.id === id);
        if (matches.length !== 1) {
            throw new Error(`print.render: break target "${id}" resolves to ${matches.length} elements; expected exactly one element`);
        }
        matches[0].classList.add(className);
    }
}

// Paragraphs can be broken at, but only where a break would not tear a box
// apart: skip anything inside a container the stylesheet marks unbreakable
// (break-inside: avoid) or that is visibly boxed (border on both edges or a
// fill). That keeps presets like band/card whole without a hard-coded list.
function insideUnbreakableBox(element) {
    for (let node = element.parentElement; node && node !== output; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.breakInside === 'avoid' || style.breakInside === 'avoid-page') return true;
        const borderTop = parseFloat(style.borderTopWidth) || 0;
        const borderBottom = parseFloat(style.borderBottomWidth) || 0;
        if (borderTop > 0 && borderBottom > 0) return true;
        if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') return true;
    }
    return false;
}

// Content-addressed anchor: stable when other paragraphs move, and changed (so
// the break is reported missing rather than silently landing elsewhere) when
// the paragraph's own text is edited.
function paragraphAnchor(text, taken, prefix = 'p') {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const base = `${prefix}-${hash.toString(16).padStart(8, '0')}`;
    if (!taken.has(base)) {
        taken.add(base);
        return base;
    }
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    const unique = `${base}-${suffix}`;
    taken.add(unique);
    return unique;
}

// nui emits a bare text node, not a <p>, when text sits tight against the
// preceding block (no blank line). A text node cannot carry break-before or an
// id, so promote it to a paragraph with a zero margin — the printed result is
// unchanged, but the line becomes a break target like any other paragraph.
function wrapLooseText() {
    const containers = output.querySelectorAll('.nui-blocks-section, .nui-blocks-block, .nui-blocks-columns, .nui-blocks-main');
    for (const container of containers) {
        for (const node of [...container.childNodes]) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
            const paragraph = document.createElement('p');
            paragraph.className = 'nui-print-loose';
            node.replaceWith(paragraph);
            paragraph.appendChild(node);
        }
    }
}

// Where a page break is *reasonable*: at the start of a self-contained flow
// unit, never inside one.
//
//   good   section, authored block/columns, heading, paragraph, quote box,
//          table, code block, figure, list - each can move to the next page
//          whole
//   bad    inside any of those (a split box, a torn table row),
//          between a heading and the content it introduces (orphaned heading),
//          directly after an explicit page-break (already broken),
//          before the very first thing on page 1 (nothing to push down)
// Candidates: anything that may start a page. Atomic structures (a quote, a
// table, a code block, a figure) also forbid candidates *inside* them -
// breaking there tears the structure. A list is different: its items are
// independent units, so `li` is a candidate too. A plain MD-Blocks block is
// only a candidate, never a barrier - text inside it stays ordinary flow unless
// the block is visibly boxed (see insideUnbreakableBox).
const STRUCTURED_UNITS = 'blockquote, pre, table, figure';
const BREAKABLE_ALL = `p, h1, h2, h3, h4, h5, h6, li, .nui-blocks-block, blockquote, pre, table, ul, ol, figure`;
const HEADINGS = 'h1, h2, h3, h4, h5, h6';

function startsCleanly(element) {
    let previous = element.previousElementSibling;
    while (previous && !previous.textContent.trim() && !previous.matches('img, hr, .nui-preset-page-break')) {
        previous = previous.previousElementSibling;
    }
    if (!previous) return true;
    // A break here would leave the heading alone at the bottom of the page.
    if (previous.matches(HEADINGS)) return false;
    // The source already forces a break at this point.
    if (previous.classList.contains('nui-preset-page-break')) return false;
    return true;
}

function labelOf(element) {
    // innerText keeps line breaks between list items; textContent glues them
    // together into an unreadable run.
    const raw = (element.innerText ?? element.textContent) ?? '';
    return raw.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function anchorBreakables() {
    const taken = new Set([...output.querySelectorAll('[id]')].map((element) => element.id));
    for (const element of output.querySelectorAll(BREAKABLE_ALL)) {
        if (element.id) continue;
        const box = element.closest(STRUCTURED_UNITS);
        if (box && box !== element) continue;
        const text = element.textContent.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (insideUnbreakableBox(element)) continue;
        if (!startsCleanly(element)) continue;
        const kind = element.matches(HEADINGS) ? 'heading'
            : element.tagName === 'P' ? 'paragraph'
                : element.tagName === 'LI' ? 'item' : 'unit';
        element.dataset.breakAnchor = kind;
        element.id = paragraphAnchor(text, taken, kind === 'heading' ? 'h' : kind === 'paragraph' ? 'p' : kind === 'item' ? 'i' : 'u');
    }
}

function extractChrome() {    const chrome = { header: '', footer: '' };
    for (const slot of Object.keys(chrome)) {
        const elements = [...output.querySelectorAll(`.nui-blocks-chrome-${slot}`)];
        const variants = [...new Set(elements.map((el) => el.innerHTML.trim()).filter(Boolean))];
        if (variants.length > 1) {
            throw new Error(`print.render: multiple different ${slot} chrome scopes cannot be represented in one Chromium PDF`);
        }
        chrome[slot] = variants[0] ?? '';
        for (const el of elements) el.remove();
    }
    return chrome;
}

async function main() {
    const frontmatter = window.nui.util.parseFrontmatter(job.source)?.data ?? {};
    const options = resolveOptions(frontmatter);
    document.getElementById('print-page-options').textContent =
        `@page { size: ${options.format} ${options.orientation}; margin: ${options.margin.top} ${options.margin.right} ${options.margin.bottom} ${options.margin.left}; }`;
    document.body.classList.add(`print-style-${options.style}`);
    document.body.classList.toggle('print-section-pages', options.sectionPages);
    document.title = String(frontmatter.title ?? 'MD-Blocks print');

    output.innerHTML = window.nui.util.markdownToHtml(job.source, {
        frontmatter: 'strip',
        base: `${location.origin}/source/${job.token}/`
    });

    const refused = [...output.querySelectorAll('[data-refused-destination]')];
    if (refused.length) {
        throw new Error(`print.render: refused media destination: ${refused.map((el) =>
            `${el.dataset.refusedDestination} (${el.dataset.refusedReason})`).join(', ')}`);
    }

    const chrome = extractChrome();
    wrapLooseText();
    anchorBreakables();
    applyBreaks(options.breakBefore, 'nui-print-break-before');
    applyBreaks(options.breakAfter, 'nui-print-break-after');

    for (const image of output.querySelectorAll('img')) image.loading = 'eager';
    await document.fonts.ready;
    const images = [...output.querySelectorAll('img')];
    await Promise.all(images.map((image) => image.complete
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', () => reject(new Error(`print.render: image failed: ${image.src}`)), { once: true });
        })));
    const broken = images.filter((image) => image.naturalWidth === 0);
    if (broken.length) throw new Error(`print.render: image failed: ${broken.map((image) => image.src).join(', ')}`);

    const targetElements = [...output.querySelectorAll('[id]')];
    const targets = targetElements.map((el) => ({
        id: el.id,
        kind: el.dataset.breakAnchor
            ?? (el.classList.contains('nui-blocks-section') ? 'section'
                : el.classList.contains('nui-blocks-block') ? 'block'
                    : el.classList.contains('nui-blocks-columns') ? 'columns'
                        : el.classList.contains('nui-blocks-main') ? 'main' : 'element'),
        preset: [...el.classList].find((name) => name.startsWith('nui-preset-'))?.slice('nui-preset-'.length) ?? null,
        heading: el.querySelector(':is(h1,h2,h3)')?.textContent.trim() ?? null,
        text: el.dataset.breakAnchor ? labelOf(el) : undefined
    }));
    if (job.options.mapTargets) {
        // One marker per position. Two markers a few pixels apart end up in the
        // same text run in the PDF, interleaved, and no contiguous match can
        // find either of them. Co-located targets share the first one's marker
        // and inherit its measured geometry afterwards.
        const marked = [];
        targets.forEach((target, index) => {
            if (!['section', 'block', 'columns', 'heading', 'paragraph', 'item', 'unit'].includes(target.kind) || target.preset === 'page-break') return;
            const element = targetElements[index];
            const rect = element.getBoundingClientRect();
            // Two markers within a line of each other are merged into one text
            // run by the PDF text layer, and the merged run loses characters -
            // no query can match it. Anything inside one line therefore shares
            // the first marker and inherits its measured geometry; they would
            // collapse into a single break spot anyway.
            const owner = marked.find((entry) => Math.abs(entry.x - rect.x) < 40 && Math.abs(entry.y - rect.y) < 24);
            if (owner) {
                target.owner = owner.index;
                return;
            }
            marked.push({ index, x: rect.x, y: rect.y });
            target.marker = `MBTARGET_${job.token}_${index}`;
            const marker = document.createElement('span');
            marker.className = 'nui-print-target-marker';
            marker.textContent = target.marker;
            // Inside the element, so it travels with it when a break pushes the
            // element to another page. Inserting it before the element would
            // leave the marker behind on the old page.
            element.prepend(marker);
        });
    }

    window.__PRINT_RESULT__ = { options, chrome, targets };
}

main().catch((error) => {
    window.__PRINT_ERROR__ = error.stack || error.message;
});
