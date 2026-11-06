import '/print/nui/nui.js';

const $ = (id) => document.getElementById(id);
const ui = {
    form: $('open-form'), path: $('source-path'), bar: $('document-bar'), workspace: $('workspace'), empty: $('empty-state'),
    name: $('document-name'), pathLabel: $('document-path'), style: $('style'), format: $('format'), orientation: $('orientation'),
    styleSelect: $('style-select'), formatSelect: $('format-select'), orientationSelect: $('orientation-select'),
    sectionPages: $('section-pages'), save: $('save'), dirty: $('dirty-state'), pdf: $('download-pdf'), notice: $('notice'),
    thumbnails: $('thumbnails'), pages: $('pages'),     zoom: $('zoom'), zoomSelect: $('zoom-select'), showAll: $('show-all')
};

const state = {
    token: null,
    source: '',
    sourceSha256: null,
    options: null,
    savedOptions: null,
    targets: [],
    pages: [],
    pdfUrl: '#',
    revision: 0,
    busy: false,
    externallyChanged: false
};

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function api(action, body) {
    const response = await fetch(`/print/api/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
}

function editableOptions(options = state.options) {
    return {
        style: options.style,
        format: options.format,
        orientation: options.orientation,
        sectionPages: options.sectionPages,
        breakBefore: [...options.breakBefore],
        breakAfter: [...options.breakAfter]
    };
}

function isDirty() {
    return state.options && state.savedOptions && JSON.stringify(editableOptions()) !== JSON.stringify(state.savedOptions);
}

function showNotice(message, type = '') {
    ui.notice.textContent = message;
    ui.notice.className = `notice${type ? ` ${type}` : ''}`;
    ui.notice.hidden = !message;
}

function updateActions() {
    const dirty = isDirty();
    ui.dirty.textContent = state.externallyChanged ? 'File changed on disk' : dirty ? 'Unsaved changes' : '';
    ui.save.disabled = state.busy || !dirty || state.externallyChanged;
    for (const control of [ui.style, ui.format, ui.orientation, ui.sectionPages, ui.path]) control.disabled = state.busy;
    // nui-select renders its own control button and ignores the inner select's
    // disabled state, so the host carries it too.
    for (const host of [ui.styleSelect, ui.formatSelect, ui.orientationSelect, ui.zoomSelect]) {
        host.toggleAttribute('disabled', state.busy);
    }
    for (const button of ui.pages.querySelectorAll('button')) button.disabled = state.busy;
}

function setBusy(busy, message = '') {
    state.busy = busy;
    updateActions();
    if (message) showNotice(message);
}

function syncOptionControls() {
    const assign = (host, select, value) => {
        select.value = value;
        // The visible control is NUI's; it only learns about a value change
        // through its own setter.
        host.setValue?.(value);
    };
    assign(ui.styleSelect, ui.style, state.options.style);
    assign(ui.formatSelect, ui.format, state.options.format);
    assign(ui.orientationSelect, ui.orientation, state.options.orientation);
    ui.sectionPages.checked = state.options.sectionPages;
}

function applyRender(result, { initial = false } = {}) {
    state.token = result.token;
    state.revision = result.revision;
    state.options = result.options;
    state.targets = result.targets;
    state.pages = result.pages;
    state.pdfUrl = result.pdfUrl;
    state.externallyChanged = result.externallyChanged;
    state.sourceSha256 = result.sourceSha256;
    if (initial) {
        state.source = result.source;
        state.savedOptions = editableOptions(result.options);
    }
    syncOptionControls();
    buildPreview();
    updateActions();
}

function targetName(target) {
    return target.heading || target.text || target.id;
}

// Phase marks are cumulative, so the largest is the server-side total.
function timingLabel(result) {
    const marks = Object.values(result.timings ?? {}).filter((value) => typeof value === 'number');
    if (!marks.length) return '';
    return ` in ${(Math.max(...marks) / 1000).toFixed(1)} s`;
}

// A break is a position on the paper, expressed in page-height units so that
// "start a new page at this target" and "page break after the target above it"
// are the same number instead of two different vocabularies.
const SAME_SPOT = 0.015;
// Paragraph spots sit close together, so the "close proximity" window that a
// click clears is measured in paragraph steps (~7 mm on A4), not in the roughly
// 17 mm that suited a section-only list.
const BREAK_MARGIN = 0.025;

function orderedTargets() {
    return [...state.targets].sort((a, b) => a.page - b.page || a.y - b.y);
}

function rulePositions() {
    const ordered = orderedTargets();
    const rules = [];
    ordered.forEach((target, index) => {
        if (state.options.breakBefore.includes(target.id)) {
            rules.push({ key: `breakBefore:${target.id}`, id: target.id, pos: target.page + target.y });
        }
        if (state.options.breakAfter.includes(target.id)) {
            const next = ordered[index + 1];
            if (next) rules.push({ key: `breakAfter:${target.id}`, id: target.id, pos: next.page + next.y });
        }
    });
    return rules;
}

function spotsFor(pageNumber, rules) {
    const ordered = orderedTargets();
    const spots = [];
    // Nothing precedes the document's first target, so a break at that position
    // only produces an empty page. Skip the position, not just that one target:
    // its heading (and anything else co-located) sits at the same y.
    const firstPos = ordered.length ? ordered[0].page + ordered[0].y : null;
    for (const target of ordered) {
        if (target.page !== pageNumber) continue;
        const pos = pageNumber + target.y;
        if (firstPos !== null && Math.abs(pos - firstPos) < SAME_SPOT) continue;
        const twin = spots.find((spot) => Math.abs(spot.pos - pos) < SAME_SPOT);
        if (twin) {
            if (twin.kind !== 'section' && target.kind === 'section') Object.assign(twin, { id: target.id, kind: target.kind, heading: target.heading, text: target.text });
            continue;
        }
        spots.push({ id: target.id, kind: target.kind, heading: target.heading, text: target.text, page: pageNumber, y: target.y, pos });
    }
    for (const spot of spots) spot.rules = rules.filter((rule) => Math.abs(rule.pos - spot.pos) < SAME_SPOT);
    return spots;
}

function breakSpot(spot) {
    const active = spot.rules.length > 0;
    const control = element('button', `break-spot${active ? ' active' : ''}`);
    control.type = 'button';
    control.style.setProperty('--y', String(spot.y));
    control.dataset.kind = spot.kind;
    control.title = `${active ? 'Remove this page break' : 'Start a new page here'} — ${spot.kind}: ${targetName(spot)}`;
    control.setAttribute('aria-label', control.title);
    control.setAttribute('aria-pressed', String(active));
    const handle = element('span', 'break-handle');
    handle.append(
        element('span', 'break-arrow'),
        element('span', 'break-kind', spot.kind),
        element('span', 'break-label', active ? 'Page break' : 'Break here')
    );
    control.append(element('span', 'break-rule'), handle);
    control.addEventListener('click', () => clickSpot(spot));
    return control;
}

function buildPreview() {
    const scrollTop = ui.pages.scrollTop;
    const activePage = Number(ui.thumbnails.querySelector('.thumbnail.active')?.dataset.page ?? 1);
    ui.thumbnails.replaceChildren();
    ui.pages.replaceChildren();
    ui.pdf.disabled = !state.token;
    ui.pdf.dataset.href = `${state.pdfUrl}?v=${state.revision}`;

    const rules = rulePositions();
    const spots = new Map(state.pages.map((page) => [page.page, spotsFor(page.page, rules)]));

    for (const page of state.pages) {
        const thumb = element('button', 'thumbnail');
        thumb.type = 'button';
        thumb.dataset.page = page.page;
        const image = element('img');
        image.src = `${page.url}?v=${state.revision}`;
        image.alt = '';
        thumb.append(image, element('span', '', `Page ${page.page}`));
        thumb.addEventListener('click', () => {
            document.querySelector(`.print-page[data-page="${page.page}"]`)?.scrollIntoView({ block: 'start' });
            setActiveThumbnail(page.page);
        });
        ui.thumbnails.append(thumb);

        const article = element('article', 'print-page');
        article.dataset.page = page.page;
        const pageSpots = spots.get(page.page);
        const heading = element('div', 'page-heading');
        heading.append(
            element('strong', '', `Page ${page.page}`),
            element('span', '', pageSpots.length ? `${pageSpots.length} spot${pageSpots.length === 1 ? '' : 's'} to break at` : 'no break spots on this page')
        );

        const stage = element('div', 'page-stage');
        const paper = element('div', 'paper');
        const pageImage = element('img');
        pageImage.src = `${page.url}?v=${state.revision}`;
        pageImage.alt = `Printed page ${page.page}`;
        const layer = element('div', 'break-layer');
        for (const spot of pageSpots) layer.append(breakSpot(spot));
        paper.append(pageImage, layer);
        stage.append(paper);
        article.append(heading, stage);
        ui.pages.append(article);
    }
    setActiveThumbnail(Math.min(activePage, state.pages.length));
    ui.pages.scrollTop = scrollTop;
}

function setActiveThumbnail(pageNumber) {
    for (const thumb of ui.thumbnails.children) thumb.classList.toggle('active', Number(thumb.dataset.page) === Number(pageNumber));
}

async function render() {
    if (!state.token || state.busy) return;
    setBusy(true, 'Rendering the changed pages…');
    try {
        const result = await api('render', { token: state.token, ...editableOptions() });
        applyRender(result);
        showNotice(state.externallyChanged ? 'The source changed on disk. Reopen before saving.' : `Rendered ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}${timingLabel(result)}.`, state.externallyChanged ? 'warning' : '');
    } catch (error) {
        showNotice(error.message, 'error');
    } finally {
        setBusy(false);
    }
}

// Clicking a spot that already carries a break removes it; clicking an empty
// spot makes it the break and clears any other break close enough that the two
// would fight over the same stretch of paper.
async function clickSpot(spot) {
    if (state.busy) return;
    const rules = rulePositions();
    const here = rules.filter((rule) => Math.abs(rule.pos - spot.pos) < SAME_SPOT);
    const near = rules.filter((rule) => Math.abs(rule.pos - spot.pos) < BREAK_MARGIN);
    const dropped = new Set((here.length ? here : near).map((rule) => rule.key));
    const kept = (id, kind) => !dropped.has(`${kind}:${id}`);
    const breakBefore = state.options.breakBefore.filter((id) => kept(id, 'breakBefore'));
    state.options = {
        ...state.options,
        breakBefore: here.length ? breakBefore : [...breakBefore, spot.id],
        breakAfter: state.options.breakAfter.filter((id) => kept(id, 'breakAfter'))
    };
    buildPreview();
    updateActions();
    await render();
}

async function openDocument(path) {
    if (state.busy) return;
    setBusy(true, 'Rendering the document…');
    try {
        if (state.token) {
            try { await api('close', { token: state.token }); } catch (error) { console.warn(error.message); }
        }
        const result = await api('open', { path });
        applyRender(result, { initial: true });
        ui.bar.hidden = false;
        ui.workspace.hidden = false;
        ui.empty.hidden = true;
        ui.name.textContent = path.split(/[\\/]/).pop();
        ui.pathLabel.textContent = path;
        ui.pathLabel.title = path;
        history.replaceState(null, '', `/print?path=${encodeURIComponent(path)}`);
        showNotice(`Rendered ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}${timingLabel(result)}. Hover a page and click a spot to place a break.`);
    } catch (error) {
        showNotice(error.message, 'error');
    } finally {
        setBusy(false);
    }
}

function markdownWithPrintOptions() {
    const frontmatter = window.nui.util.parseFrontmatter(state.source);
    if (frontmatter?.data != null && (typeof frontmatter.data !== 'object' || Array.isArray(frontmatter.data))) {
        throw new Error('print.editor: document frontmatter must be a map before print settings can be saved');
    }
    const data = frontmatter?.data ? structuredClone(frontmatter.data) : {};
    if (data.print != null && (typeof data.print !== 'object' || Array.isArray(data.print))) {
        throw new Error('print.editor: frontmatter "print" must be a map before print settings can be saved');
    }
    const authoredPrint = data.print ?? {};
    const options = editableOptions();
    data.print = { ...authoredPrint, ...options };
    const eol = state.source.includes('\r\n') ? '\r\n' : '\n';
    const yaml = window.nui.util.serializeYaml(data).replaceAll('\n', eol);
    const bom = state.source.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = frontmatter ? frontmatter.content : state.source.replace(/^\uFEFF/, '');
    return `${bom}---${eol}${yaml}${eol}---${eol}${body}`;
}

async function save() {
    if (state.busy || !isDirty()) return;
    setBusy(true, 'Saving print settings to the document…');
    try {
        const markdown = markdownWithPrintOptions();
        const result = await api('save', { token: state.token, markdown, baseSha256: state.sourceSha256 });
        state.source = result.source;
        state.sourceSha256 = result.sourceSha256;
        state.savedOptions = editableOptions();
        const rendered = await api('render', { token: state.token, ...editableOptions() });
        applyRender(rendered);
        showNotice('Saved print settings to the document and verified the rendered pages.');
    } catch (error) {
        showNotice(error.message, 'error');
    } finally {
        setBusy(false);
    }
}

ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    openDocument(ui.path.value.trim());
});
for (const control of [ui.style, ui.format, ui.orientation]) {
    control.addEventListener('change', () => {
        state.options = { ...state.options, ...editableOptions(), [control.id]: control.value };
        updateActions();
        render();
    });
}
ui.sectionPages.addEventListener('change', () => {
    state.options.sectionPages = ui.sectionPages.checked;
    updateActions();
    render();
});
ui.zoom.addEventListener('change', () => ui.pages.style.setProperty('--paper-width', `${ui.zoom.value}px`));
ui.showAll.addEventListener('change', () => ui.pages.classList.toggle('show-all', ui.showAll.checked));
// Off on load. Chromium restores form-control state across reloads, so the
// markup default alone is not enough for a review-only toggle.
ui.showAll.checked = false;
ui.pages.classList.remove('show-all');
ui.pdf.addEventListener('click', () => {
    const href = ui.pdf.dataset.href;
    if (href) window.open(href, '_blank', 'noopener');
});
ui.save.addEventListener('click', save);
window.addEventListener('pagehide', () => {
    if (!state.token) return;
    navigator.sendBeacon('/print/api/close', new Blob([JSON.stringify({ token: state.token })], { type: 'application/json' }));
});
window.addEventListener('beforeunload', (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
});

const initialPath = new URLSearchParams(location.search).get('path');
if (initialPath) {
    ui.path.value = initialPath;
    openDocument(initialPath);
}
