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
            throw new Error(`print.render: break target "${id}" resolves to ${matches.length} elements; expected exactly one MD-Blocks ID`);
        }
        matches[0].classList.add(className);
    }
}

function extractChrome() {
    const chrome = { header: '', footer: '' };
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
        kind: el.classList.contains('nui-blocks-section') ? 'section'
            : el.classList.contains('nui-blocks-block') ? 'block'
                : el.classList.contains('nui-blocks-columns') ? 'columns'
                    : el.classList.contains('nui-blocks-main') ? 'main' : 'element',
        preset: [...el.classList].find((name) => name.startsWith('nui-preset-'))?.slice('nui-preset-'.length) ?? null,
        heading: el.querySelector(':is(h1,h2,h3)')?.textContent.trim() ?? null
    }));
    if (job.options.mapTargets) {
        const origins = new Map();
        targets.forEach((target, index) => {
            if (!['section', 'block', 'columns'].includes(target.kind) || target.preset === 'page-break') return;
            const element = targetElements[index];
            const rect = element.getBoundingClientRect();
            const origin = `${Math.round(rect.x)}:${Math.round(rect.y)}`;
            const overlap = origins.get(origin) ?? 0;
            origins.set(origin, overlap + 1);
            target.marker = `MBTARGET_${job.token}_${index}`;
            const marker = document.createElement('span');
            marker.className = 'nui-print-target-marker';
            marker.style.marginTop = `${(overlap + 1) * 2}px`;
            marker.textContent = target.marker;
            element.prepend(marker);
        });
    }

    window.__PRINT_RESULT__ = { options, chrome, targets };
}

main().catch((error) => {
    window.__PRINT_ERROR__ = error.stack || error.message;
});
