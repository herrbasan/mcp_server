import '/nconvert/nui/nui.js';

const $ = (id) => document.getElementById(id);
const ui = {
    sourceView: $('source-view'), jobView: $('job-view'), newConversion: $('new-conversion'),
    activeContextPills: $('active-context-pills'), pillTarget: $('pill-target'), pillTier: $('pill-tier'), pillMode: $('pill-mode'),
    toggleStageBtn: $('toggle-stage-btn'),
    targetPreset: $('target-preset'), targetCustomWrap: $('target-custom-wrap'), targetInput: $('target-input'),
    workflowMode: $('workflow-mode'), privacyTier: $('privacy-tier'), autoPass2: $('auto-pass2'),
    dropzone: $('dropzone'), chooseFile: $('choose-file'), fileInput: $('file-input'), fileStatus: $('file-status'),
    pathForm: $('path-form'), sourcePath: $('source-path'), convertPath: $('convert-path'), sourceError: $('source-error'),
    depth: $('depth'), keepOriginal: $('keep-original'), extractAssets: $('extract-assets'), force: $('force-convert'),
    refreshJobs: $('refresh-jobs'), recentJobs: $('recent-jobs'),
    wizardStageProgress: $('wizard-stage-progress'), wizardDocThumb: $('wizard-doc-thumb'), wizardDocExt: $('wizard-doc-ext'),
    wizardProgressLabel: $('wizard-progress-label'), openWorkspaceBtn: $('open-workspace-btn'), peekTechnicalBtn: $('peek-technical-btn'),
    jobName: $('job-name'), jobState: $('job-state'), jobSource: $('job-source'), jobElapsed: $('job-elapsed'), cancelJob: $('cancel-job'),
    routeStats: $('route-stats'), jobColumns: $('job-columns'), connection: $('connection-state'), progress: $('job-progress'), steps: $('steps'),
    activity: $('activity'), activityFilter: $('activity-filter'), activityFilterSelect: $('activity-filter-select'),
    statMeasured: $('stat-measured'), statOcr: $('stat-ocr'), statVision: $('stat-vision'), statCalls: $('stat-calls'), statProblems: $('stat-problems'),
    resultPanel: $('result-panel'), workspaceTabs: $('workspace-tabs'),
    tabBtnDocument: $('tab-btn-document'), tabBtnFacts: $('tab-btn-facts'), tabBtnOriginal: $('tab-btn-original'), tabBtnTechnical: $('tab-btn-technical'),
    factsCountChip: $('facts-count-Chip'), pagesCountChip: $('pages-count-chip'),
    docViewTitle: $('doc-view-title'), resultProvenance: $('result-provenance'), resultLinks: $('result-links'),
    resultStats: $('result-stats'), resultWarnings: $('result-warnings'), resultSummary: $('result-summary'), resultDocument: $('result-document'),
    documentTruncated: $('document-truncated'),
    factsFilter: $('facts-filter'), addFactBtn: $('add-fact-btn'), rerunPass2Btn: $('rerun-pass2-btn'), commitFactsBtn: $('commit-facts-btn'),
    factsSubtitle: $('facts-subtitle'), factsList: $('facts-list'),
    originalSubtitle: $('original-subtitle'), prevPageBtn: $('prev-page-btn'), nextPageBtn: $('next-page-btn'),
    pageIndicator: $('page-indicator'), togglePageGridBtn: $('toggle-page-grid-btn'), originalDownloadSlot: $('original-download-slot'),
    originalViewer: $('original-viewer'),
    chatScopeBadge: $('chat-scope-badge'), chatQuickPrompts: $('chat-quick-prompts'), chatMessages: $('chat-messages'),
    chatForm: $('chat-form'), chatInput: $('chat-input'),
    notice: $('notice'), statusBar: $('status-bar')
};

const TARGET_DEFAULTS = {
    'study/gsb-11-handbuch': { tier: 'cloud', mode: 'assisted' },
    'case/miller-v-acme': { tier: 'local', mode: 'assisted' },
    'project/materna-bav': { tier: 'eu', mode: 'assisted' },
    'study/eu-ai-act': { tier: 'eu', mode: 'deep-auto' }
};

const TIER_LABELS = {
    local: '🔒 On-Prem Local',
    eu: '🇪🇺 EU Sovereign (Mistral)',
    cloud: '☁️ Cost-Optimized Cloud'
};

const MODE_LABELS = {
    assisted: 'Assisted Wizard',
    'deep-auto': 'Deep Auto',
    bulk: 'Fast Bulk'
};

const CONFIDENCE_THRESHOLD = 0.80;

const state = {
    job: null,
    item: null,
    activity: [],
    lastSeq: 0,
    events: null,
    busy: false,
    loadingResult: false,
    recent: [],
    facts: [],
    currentPage: 1,
    totalPages: 0,
    pageGridMode: false,
    showingProgressCard: true,
    activeTab: 'document',
    userActions: [],
    blingIdx: 0
};

function recordUserAction(action) {
    state.userActions.push({ at: clock(Date.now()), action });
    if (state.userActions.length > 12) state.userActions.shift();
}

function updateChatContextIndicator() {
    // Silent: screen state & user actions are sent in the chat request payload only, never rendered on screen.
}

function element(tag, options = {}) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.attrs) for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
    return node;
}

function icon(name) {
    return element('nui-icon', { attrs: { name } });
}

function button(label, onClick, variant = null) {
    const wrap = element('nui-button');
    if (variant) wrap.setAttribute('variant', variant);
    const control = element('button', { text: label, attrs: { type: 'button' } });
    control.addEventListener('click', onClick);
    wrap.append(control);
    return wrap;
}

function linkButton(label, url) {
    const wrap = element('nui-button');
    const link = element('a', { text: label, attrs: { href: url, target: '_blank', rel: 'noopener' } });
    wrap.append(link);
    return wrap;
}

function basename(value) {
    return String(value ?? '').replaceAll('\\', '/').split('/').pop() || 'Document';
}

function extname(value) {
    const name = basename(value);
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toUpperCase() : 'DOC';
}

function bytes(value) {
    if (!Number.isFinite(value)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    const minutes = Math.floor(ms / 60000);
    return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`;
}

function clock(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function notice(message, type = '') {
    ui.notice.textContent = message;
    ui.statusBar.className = `status-bar${type ? ` ${type}` : ''}`;
}

async function api(url, options = {}) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
}

function setBadge(el, text, variant = 'info', status = null) {
    if (!el) return;
    el.textContent = text;
    el.setAttribute('variant', variant);
    if (status) el.setAttribute('status', status);
    else el.removeAttribute('status');
}

function activeTarget() {
    const val = ui.targetPreset.value === 'custom' ? ui.targetInput.value.trim() : ui.targetPreset.value;
    return val || 'general/inbox';
}

function updateContextPills() {
    const target = activeTarget();
    const tier = ui.privacyTier.value;
    const mode = ui.workflowMode.value;
    ui.pillTarget.textContent = `🎯 ${target}`;
    ui.pillTier.textContent = TIER_LABELS[tier] ?? tier;
    ui.pillMode.textContent = MODE_LABELS[mode] ?? mode;
    if (ui.chatScopeBadge) ui.chatScopeBadge.textContent = target;
}

function switchTab(tabButtonId) {
    const map = {
        'tab-btn-document': ['tab-panel-document', 'document'],
        'tab-btn-facts': ['tab-panel-facts', 'facts'],
        'tab-btn-original': ['tab-panel-original', 'original'],
        'tab-btn-problems': ['tab-panel-problems', 'problems'],
        'tab-btn-technical': ['tab-panel-technical', 'technical']
    };
    for (const [btnId, [panelId, name]] of Object.entries(map)) {
        const btn = $(btnId);
        const panel = $(panelId);
        const active = btnId === tabButtonId;
        if (btn) btn.classList.toggle('active', active);
        if (panel) panel.hidden = !active;
        if (active) state.activeTab = name;
    }
    recordUserAction(`opened ${state.activeTab} tab`);
    setDefaultContextBar();
}

function setDefaultContextBar() {
    const bar = $('context-bar');
    if (bar) bar.replaceChildren();
}

function showFactContextBar(fact) {
    const bar = $('context-bar');
    if (!bar) return;
    bar.replaceChildren();
    const srcRef = fact.refs?.find((r) => r.kind === 'source');
    const crossRef = fact.refs?.find((r) => r.kind === 'crossref');
    const parts = [];
    if (srcRef) parts.push(`Source: Page ${srcRef.page ?? 1} (${srcRef.section ?? 'Document'})`);
    if (crossRef) parts.push(crossRef.label);
    bar.append(element('span', { text: parts.join('   ·   ') || fact.key }));

    const actions = element('div', { className: 'context-bar-actions' });
    if (srcRef) {
        const jumpBtn = element('button', { className: 'ctx-btn', text: `Go to page ${srcRef.page ?? 1}`, attrs: { type: 'button' } });
        jumpBtn.addEventListener('click', () => jumpToSourceRef(srcRef));
        actions.append(jumpBtn);
    }
    const delBtn = element('button', { className: 'ctx-btn', text: 'Delete', attrs: { type: 'button' } });
    delBtn.addEventListener('click', () => {
        state.facts = state.facts.filter((f) => f.id !== fact.id);
        saveFactsForItem();
        renderFacts();
        setDefaultContextBar();
    });
    actions.append(delBtn);
    bar.append(actions);
}

function setStageView(showProgressCard) {
    state.showingProgressCard = showProgressCard;
    ui.wizardStageProgress.hidden = !showProgressCard;
    ui.resultPanel.hidden = showProgressCard;
    if (ui.toggleStageBtn) {
        ui.toggleStageBtn.textContent = showProgressCard ? 'Workspace' : 'Steps';
    }
}

function resetWizardThumb(sourceName) {
    const lines = element('div', { className: 'sheet-lines' });
    lines.append(element('span'), element('span'), element('span'), element('span'));
    ui.wizardDocThumb.replaceChildren(
        lines,
        element('span', { className: 'doc-ext', text: extname(sourceName) })
    );
    const submeta = $('wizard-doc-stats');
    if (submeta) {
        if (state.item?.manifest) {
            const m = state.item.manifest;
            submeta.textContent = `${m.layers?.sections?.count ?? 1} sections · ${m.stats?.words?.toLocaleString() ?? 0} words · ${activeTarget()}`;
        } else {
            submeta.textContent = `Target · ${activeTarget()}`;
        }
    }
}

function setBusy(busy, message = '') {
    state.busy = busy;
    ui.dropzone.classList.toggle('busy', busy);
    ui.convertPath.disabled = busy;
    ui.chooseFile.disabled = busy;
    ui.sourcePath.disabled = busy;
    if (message) ui.fileStatus.textContent = message;
}

function closeEvents() {
    if (state.events) state.events.close();
    state.events = null;
}

function updateUrl(query, replace = false) {
    const url = query ? `/nconvert?${query}` : '/nconvert';
    if (replace) history.replaceState({}, '', url);
    else history.pushState({}, '', url);
}

function conversionOptions() {
    return {
        depth: ui.depth.value,
        keepOriginal: ui.keepOriginal.checked,
        assets: ui.extractAssets.checked,
        force: ui.force.checked
    };
}

async function loadRecent() {
    try {
        const payload = await api('/nconvert/jobs?limit=30');
        state.recent = payload.jobs;
        renderRecent();
    } catch (error) {
        ui.recentJobs.replaceChildren(element('p', { className: 'source-error', text: error.message }));
    }
}

function renderRecent() {
    ui.recentJobs.replaceChildren();
    if (!state.recent.length) {
        ui.recentJobs.append(element('p', { className: 'muted', text: 'No conversions yet.' }));
        return;
    }
    for (const job of state.recent) {
        const control = button('', () => openJob(job.id));
        const row = element('span', { className: 'recent-job' });
        row.append(
            element('span', { className: 'name', text: basename(job.source) }),
            element('span', { className: 'state', text: job.state }),
            element('span', { className: 'meta', text: `${job.args?.depth ?? 'mechanical'} · ${clock(job.createdAt)} · ${job.activityCount ?? 0} events` })
        );
        control.querySelector('button').append(row);
        ui.recentJobs.append(control);
    }
}

function showSource({ navigate = true } = {}) {
    closeEvents();
    state.job = null;
    state.item = null;
    state.activity = [];
    state.lastSeq = 0;
    state.loadingResult = false;
    ui.sourceView.hidden = false;
    ui.jobView.hidden = true;
    ui.newConversion.hidden = true;
    ui.activeContextPills.hidden = true;
    ui.resultPanel.hidden = true;
    ui.sourceError.textContent = '';
    setBusy(false, '');
    notice('Ready.');
    if (navigate) updateUrl('');
    loadRecent();
}

async function submitPath(event) {
    event.preventDefault();
    const source = ui.sourcePath.value.trim();
    if (!source) {
        ui.sourceError.textContent = 'Enter a document path or choose a file.';
        return;
    }
    setBusy(true, 'Submitting…');
    ui.sourceError.textContent = '';
    try {
        const payload = await api('/nconvert/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: source, ...conversionOptions() })
        });
        await handleSubmission(payload);
    } catch (error) {
        ui.sourceError.textContent = error.message;
        notice(error.message, 'error');
    } finally {
        setBusy(false);
    }
}

async function submitFile(file) {
    if (!file) return;
    const options = conversionOptions();
    const query = new URLSearchParams({ filename: file.name, ...options });
    setBusy(true, `${file.name} · ${bytes(file.size)} · uploading…`);
    ui.sourceError.textContent = '';
    try {
        const payload = await api(`/nconvert/upload?${query}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: file
        });
        await handleSubmission(payload);
    } catch (error) {
        ui.sourceError.textContent = error.message;
        notice(error.message, 'error');
    } finally {
        setBusy(false);
        ui.fileInput.value = '';
    }
}

async function handleSubmission(payload) {
    if (payload.job?.id) {
        await openJob(payload.job.id);
        return;
    }
    const id = payload.result?.id ?? payload.manifest?.id;
    if (id) {
        await openItem(id);
        return;
    }
    throw new Error('submission returned neither a job nor an item');
}

async function openJob(id, { navigate = true } = {}) {
    closeEvents();
    state.job = null;
    state.item = null;
    state.activity = [];
    state.lastSeq = 0;
    state.loadingResult = false;
    updateContextPills();
    ui.sourceView.hidden = true;
    ui.jobView.hidden = false;
    ui.newConversion.hidden = false;
    ui.activeContextPills.hidden = false;
    ui.jobColumns.hidden = false;
    ui.routeStats.hidden = false;
    ui.cancelJob.hidden = false;
    ui.openWorkspaceBtn.hidden = true;
    setStageView(true);
    if (navigate) updateUrl(`job=${encodeURIComponent(id)}`);
    notice('Loading conversion…');
    try {
        const payload = await api(`/nconvert/jobs/${encodeURIComponent(id)}`);
        applyJob(payload.job, payload.job.activity ?? []);
        connectEvents();
    } catch (error) {
        notice(error.message, 'error');
        ui.steps.replaceChildren(element('p', { className: 'source-error', text: error.message }));
    }
}

function resultId(job) {
    return job?.result?.id ?? (job?.result?.item ? basename(job.result.item) : null);
}

function applyJob(job, activity = []) {
    state.job = { ...(state.job?.id === job.id ? state.job : {}), ...job };
    const known = new Set(state.activity.map((entry) => entry.seq));
    for (const entry of activity) if (!known.has(entry.seq)) state.activity.push(entry);
    state.activity.sort((a, b) => a.seq - b.seq);
    state.lastSeq = Math.max(state.lastSeq, job.lastActivitySeq ?? 0, ...state.activity.map((entry) => entry.seq));
    renderJob();
    if (state.job.state === 'done' && resultId(state.job)) loadJobResult();
}

async function refreshJob() {
    if (!state.job) return;
    const id = state.job.id;
    const suffix = state.lastSeq > 0 ? `?since=${state.lastSeq}` : '';
    try {
        const payload = await api(`/nconvert/jobs/${encodeURIComponent(id)}${suffix}`);
        applyJob(payload.job, payload.activity?.items ?? payload.job.activity ?? []);
    } catch (error) {
        setBadge(ui.connection, 'retrying', 'warning', 'retrying');
    }
}

function connectEvents() {
    closeEvents();
    if (!state.job || ['done', 'failed', 'cancelled'].includes(state.job.state)) {
        setBadge(ui.connection, state.job?.state ?? 'offline', state.job?.state === 'done' ? 'success' : 'info', 'offline');
        return;
    }
    const source = new EventSource('/nconvert/events');
    state.events = source;
    source.onopen = () => {
        setBadge(ui.connection, 'live', 'success', 'online');
        refreshJob();
    };
    source.onerror = () => setBadge(ui.connection, 'retrying', 'warning', 'retrying');
    for (const type of ['job.queued', 'job.started', 'job.update', 'job.done', 'job.failed', 'job.cancelled']) {
        source.addEventListener(type, (event) => {
            const payload = JSON.parse(event.data);
            if (payload.job.id !== state.job?.id) return;
            applyJob(payload.job);
        });
    }
    source.addEventListener('job.activity', (event) => {
        const payload = JSON.parse(event.data);
        if (payload.job.id !== state.job?.id) return;
        applyJob(payload.job, [payload.activity]);
    });
}

function pageCount(range) {
    const match = /^(\d+)-(\d+)$/.exec(range ?? '');
    return match ? Number(match[2]) - Number(match[1]) + 1 : 0;
}

function routeTotals() {
    const totals = { measured: 0, ocr: 0, vision: 0, calls: 0, problems: 0 };
    for (const entry of state.activity) {
        if (entry.code === 'route.measured') totals.measured += pageCount(entry.pages);
        if (entry.code === 'route.ocr') totals.ocr += pageCount(entry.pages);
        if (entry.code === 'route.vision') totals.vision += pageCount(entry.pages);
        if (entry.code === 'vision.completed') totals.calls++;
        if (entry.level === 'warn' || entry.level === 'error') totals.problems++;
    }
    return totals;
}

function renderJob() {
    const job = state.job;
    if (!job) return;
    const name = basename(job.source);
    ui.jobName.textContent = name;
    if (!state.item) resetWizardThumb(name);
    ui.jobSource.textContent = job.args?.upload ? `Uploaded file · ${job.args.originalName ?? name}` : job.source;
    ui.jobSource.title = job.args?.upload ? job.args.originalName ?? job.source : job.source;
    const variants = { done: 'success', failed: 'danger', cancelled: 'warning', running: 'info', queued: 'info' };
    setBadge(ui.jobState, job.cancelRequested && job.state === 'running' ? 'cancelling' : job.state, variants[job.state] ?? 'info');
    const end = job.finishedAt ?? Date.now();
    ui.jobElapsed.textContent = duration(end - (job.startedAt ?? job.createdAt));
    ui.cancelJob.disabled = !['queued', 'running'].includes(job.state) || job.cancelRequested;
    ui.cancelJob.hidden = !['queued', 'running'].includes(job.state);
    ui.openWorkspaceBtn.hidden = !state.item;

    const totals = routeTotals();
    ui.statMeasured.textContent = totals.measured;
    ui.statOcr.textContent = totals.ocr;
    ui.statVision.textContent = totals.vision;
    ui.statCalls.textContent = totals.calls;
    ui.statProblems.textContent = totals.problems;

    const steps = [...(job.steps ?? [])];
    if (ui.autoPass2.checked && !steps.some((s) => s.key === 'pass2')) {
        steps.push({
            key: 'pass2',
            label: 'Extracting facts',
            status: job.state === 'done' ? 'done' : 'pending',
            detail: job.state === 'done' ? `${state.facts.length || ''} facts` : '',
            durationMs: job.state === 'done' ? 420 : 0
        });
    }
    const done = steps.filter((step) => step.status === 'done').length;
    const pct = steps.length ? Math.round(done / steps.length * 100) : 0;
    ui.progress.setAttribute('value', pct);
    const fill = $('job-progress-fill');
    if (fill) fill.style.width = `${pct}%`;
    ui.wizardProgressLabel.textContent = job.state === 'done'
        ? `Ingest complete (${steps.length}/${steps.length} steps)`
        : `Step ${Math.min(done + 1, steps.length)} of ${steps.length} · ${pct}%`;
    renderSteps(steps);
    renderBlingTicker();
    renderActivity();
    notice(job.error ?? (job.state === 'done' ? 'Conversion complete — Review Workspace ready.' : job.state === 'failed' ? 'Conversion failed.' : 'Conversion in progress.'), job.state === 'failed' ? 'error' : '');
}

function renderBlingTicker() {
    const ticker = $('bling-ticker');
    if (!ticker) return;
    ticker.replaceChildren();
    const lines = [];
    for (const entry of state.activity) {
        const extra = dataSummary(entry);
        lines.push(`${entry.code}${entry.pages ? `[${entry.pages}]` : ''} · ${entry.message}${extra ? ` · ${extra}` : ''}`);
    }
    if (state.item?.manifest) {
        const m = state.item.manifest;
        lines.push(`nconvert::${m.format} · ${m.layers?.sections?.count ?? 1} sections · ${m.stats?.words?.toLocaleString() ?? 0} words · ${m.stats?.figures ?? 0} figures`);
    }
    if (!lines.length) return;
    const current = lines[state.blingIdx % lines.length];
    state.blingIdx++;
    ticker.append(
        element('span', { className: 'bling-dot' }),
        element('span', { text: current })
    );
}

function renderSteps(steps) {
    ui.steps.replaceChildren();
    const totalMs = Math.max(1, steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0));
    steps.forEach((step, idx) => {
        const row = element('div', { className: `step ${step.status}` });
        const node = element('div', { className: 'step-node' });
        if (step.status === 'done') node.append(icon('done'));
        else if (step.status === 'active') node.append(icon('progress_activity'));
        else node.textContent = String(idx + 1);
        row.append(node);

        const body = element('div', { className: 'step-body' });
        body.append(element('div', { className: 'step-label', text: step.label || `Step ${idx + 1}` }));
        if (step.detail) body.append(element('div', { className: 'step-detail', text: step.detail }));
        row.append(body);

        const elapsed = (step.durationMs ?? 0) + (step.status === 'active' ? Date.now() - (step.startedAt ?? Date.now()) : 0);
        row.append(element('span', { className: 'step-time', text: duration(elapsed) }));

        if (step.status === 'done' && elapsed > 0) {
            const bar = element('div', { className: 'step-bar' });
            bar.style.width = `${Math.max(12, Math.min(100, Math.round((elapsed / totalMs) * 100)))}%`;
            row.append(bar);
        }
        ui.steps.append(row);
    });
}

function dataSummary(entry) {
    const data = entry.data;
    if (!data) return '';
    const parts = [];
    if (data.pathSegments !== undefined) parts.push(`${data.pathSegments} path segments`);
    if (data.model) parts.push(data.model);
    if (data.coverage !== undefined && data.coverage !== null) parts.push(`coverage ${(data.coverage * 100).toFixed(1)}%`);
    if (data.lines !== undefined) parts.push(`${data.lines} lines`);
    if (data.regions !== undefined) parts.push(`${data.regions} regions`);
    if (data.providerCalls === 0) parts.push('no provider call');
    if (Array.isArray(data.triggers)) parts.push(data.triggers.map((trigger) => `${trigger.page}:${trigger.reason}`).join(', '));
    return parts.join(' · ');
}

function renderActivity() {
    const filter = ui.activityFilter.value;
    const entries = state.activity.filter((entry) => filter === 'all' || entry.kind === filter);
    const nearBottom = ui.activity.scrollHeight - ui.activity.scrollTop - ui.activity.clientHeight < 60;
    ui.activity.replaceChildren();
    if (!entries.length) {
        ui.activity.append(element('p', { className: 'activity-empty', text: state.activity.length ? 'No activity in this filter.' : 'Waiting for conversion decisions…' }));
        return;
    }
    const visible = entries.slice(-250);
    if (entries.length > visible.length) {
        ui.activity.append(element('p', { className: 'activity-empty', text: `${entries.length - visible.length} earlier entries omitted from this view.` }));
    }
    for (const entry of visible) {
        const kind = entry.kind === 'problem' ? 'problem' : entry.kind;
        const row = element('div', { className: `activity-row ${kind}` });
        row.append(element('span', { className: 'activity-time', text: clock(entry.at) }));
        row.append(element('span', { className: 'activity-kind', text: entry.level === 'warn' || entry.level === 'error' ? entry.level : entry.kind }));
        const body = element('div', { className: 'activity-message' });
        body.append(element('span', { className: 'activity-code', text: `#${entry.seq} ${entry.code}${entry.pages ? ` · ${entry.pages}` : ''}` }));
        body.append(document.createTextNode(entry.message));
        const details = dataSummary(entry);
        if (details) body.append(element('span', { className: 'activity-data', text: details }));
        row.append(body);
        ui.activity.append(row);
    }
    if (nearBottom) ui.activity.scrollTop = ui.activity.scrollHeight;
}

async function loadJobResult() {
    const id = resultId(state.job);
    if (state.loadingResult || !id) return;
    state.loadingResult = true;
    try {
        await openItem(id, { preserveJob: true, navigate: false });
    } catch (error) {
        notice(error.message, 'error');
    }
}

async function openItem(id, { preserveJob = false, navigate = true } = {}) {
    if (!preserveJob) {
        closeEvents();
        state.job = null;
        state.activity = [];
        state.lastSeq = 0;
        ui.jobColumns.hidden = true;
        ui.routeStats.hidden = true;
        ui.cancelJob.hidden = true;
        ui.jobElapsed.textContent = '';
        setBadge(ui.jobState, 'done', 'success');
    }
    updateContextPills();
    ui.sourceView.hidden = true;
    ui.jobView.hidden = false;
    ui.newConversion.hidden = false;
    ui.activeContextPills.hidden = false;
    if (navigate) updateUrl(`item=${encodeURIComponent(id)}`);
    notice('Loading artefact…');
    try {
        const payload = await api(`/nconvert/items/${encodeURIComponent(id)}`);
        state.item = payload;
        renderResult(payload);
        closeEvents();
    } catch (error) {
        notice(error.message, 'error');
        setStageView(false);
        ui.resultSummary.replaceChildren(element('p', { className: 'source-error', text: error.message }));
        ui.resultDocument.replaceChildren();
    }
}

function markdown(target, source, base = null) {
    target.replaceChildren();
    const view = element('nui-markdown');
    if (base) {
        try {
            view.base = new URL(base, location.origin).href;
        } catch {
            view.base = base;
        }
    }
    view.textContent = source || '';
    target.append(view);
}

// ─── Categories & Pass 2 Standalone Fact Extraction ──────────────────────
const DEFAULT_CATEGORY_REGISTRY = [
    'GSB 11', 'TYPO3', 'EBA Website', 'Materna', 'ITZBund',
    'Technical Architecture', 'Information Architecture', 'Multilingualism',
    'Corporate Design', 'Slide Master', 'Project Governance',
    'Content Migration', 'Security & Classification', 'EU AI Act',
    'Legal Case File', 'Contract & SLA'
];
state.categoryRegistry = [...DEFAULT_CATEGORY_REGISTRY];
state.categories = [];

async function loadCategoryRegistry() {
    try {
        const res = await callWorkshopTool('storage_read', { path: 'nTeligence/categories.json' });
        const parsed = typeof res === 'string' ? JSON.parse(res) : res;
        if (Array.isArray(parsed?.categories)) {
            state.categoryRegistry = [...new Set([...DEFAULT_CATEGORY_REGISTRY, ...parsed.categories])];
        }
    } catch { /* use default registry */ }
}

async function persistCategoryRegistry() {
    try {
        await callWorkshopTool('storage_write', {
            path: 'nTeligence/categories.json',
            content: JSON.stringify({
                version: 1,
                updatedAt: new Date().toISOString(),
                categories: state.categoryRegistry
            }, null, 2)
        });
    } catch { /* non-fatal */ }
}

function renderCategories() {
    const list = $('doc-categories-list');
    if (!list) return;
    list.replaceChildren();
    for (const cat of state.categories) {
        const chip = element('span', { className: 'category-chip' });
        chip.append(element('span', { text: cat }));
        const rm = element('button', {
            className: 'category-remove',
            text: '×',
            attrs: { type: 'button', 'aria-label': `Remove category ${cat}` }
        });
        rm.addEventListener('click', () => {
            state.categories = state.categories.filter((c) => c !== cat);
            saveFactsForItem();
            renderCategories();
            recordUserAction(`removed category "${cat}"`);
        });
        chip.append(rm);
        list.append(chip);
    }
}

function addDocumentCategory(rawName) {
    const clean = String(rawName || '').trim();
    if (!clean) return;
    // Match case-insensitively against canonical registry first to prevent drift
    const canonical = state.categoryRegistry.find((c) => c.toLowerCase() === clean.toLowerCase()) || clean;
    if (!state.categoryRegistry.includes(canonical)) {
        state.categoryRegistry.push(canonical);
        persistCategoryRegistry();
    }
    if (!state.categories.includes(canonical)) {
        state.categories.push(canonical);
        saveFactsForItem();
        renderCategories();
        recordUserAction(`added category "${canonical}"`);
    }
}

function factStorageKey(itemId) {
    return `nteligence.facts.v8.${itemId}`;
}

const FACT_EXTRACTION_SYSTEM_PROMPT = `You classify documents into canonical categories and extract standalone, atomic factual propositions for a long-term knowledge database (nDB + nVDB).

CRITICAL RULES:
1. Categories ('categories'): Pick 3 to 6 broad categories/entities for this document, reusing existing canonical categories whenever they fit so categories do not drift. These categories serve as the tags for all facts in the document.
2. Pure Concept Descriptor ('key'): Because the categories are already listed at the top, NEVER repeat the document or entity name in 'key' and NEVER use internal slide jargon ("Elementkatalog A/B/C"). Use a clean, universal concept descriptor (e.g. "Levels of Implementation", "Project Roles & Responsibilities", "Multi-Site Codebase Sharing", "Multilingual Site Architecture", "Page Type Model").
3. Atomic One-Sentence Proposition ('value'): 1 crisp, context-free factual sentence (8 to 22 words) that stands on its own a year later without the document. Never output table-of-contents descriptions ("An overview of...").
4. Score 'confidence' by NOTABILITY & LONG-TERM REUSABILITY (0.82–0.98 for core product/architecture/decision facts -> pre-checked; 0.55–0.78 for local layout/template details -> unchecked).

Return ONLY valid JSON:
{
  "categories": ["GSB 11", "TYPO3", "EBA Website", "Technical Architecture"],
  "facts": [
    {
      "key": "Universal concept descriptor (e.g. Levels of Implementation)",
      "value": "Single crisp factual proposition (1 sentence, 8-22 words).",
      "confidence": 0.92,
      "page": 1,
      "section": "Section or slide name"
    }
  ]
}`;

async function extractFactsViaLlm(payload) {
    await loadCategoryRegistry();
    const { manifest, document: docText = '', summary = '' } = payload;
    const target = activeTarget();
    const prompt = [
        `Document: "${manifest.source}" (Format: ${manifest.format}, Target: "${target}")`,
        `Existing Canonical Categories (reuse where applicable): ${state.categoryRegistry.join(', ')}`,
        summary ? `\nL0 Summary:\n${summary}` : '',
        `\nDocument Content Excerpt:\n${docText.slice(0, 18000)}`,
        `\nSelect 3-6 categories and extract 7 to 9 notable standalone facts with pure concept descriptors (no entity prefix, no raw jargon). Return ONLY valid JSON.`
    ].join('\n');

    const raw = await callWorkshopTool('query_model', {
        prompt,
        systemPrompt: FACT_EXTRACTION_SYSTEM_PROMPT
    });
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) throw new Error('Pass 2 did not return JSON facts');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.facts) || !parsed.facts.length) throw new Error('Pass 2 returned empty facts array');

    const rawCats = Array.isArray(parsed.categories) ? parsed.categories : (Array.isArray(parsed.documentTags) ? parsed.documentTags : []);
    state.categories = rawCats.map((c) => {
        const clean = String(c).trim();
        return state.categoryRegistry.find((reg) => reg.toLowerCase() === clean.toLowerCase()) || clean;
    }).filter(Boolean);

    return parsed.facts.map((f, idx) => {
        const conf = Number(f.confidence) || 0.85;
        const cleanKey = String(f.key || 'Fact').replace(/^[^·]+·\s*/, '').trim();
        return {
            id: `${manifest.id}_f${idx + 1}`,
            target,
            key: cleanKey,
            value: String(f.value || '').trim(),
            confidence: conf,
            approved: conf >= CONFIDENCE_THRESHOLD,
            refs: [
                { kind: 'source', page: Number(f.page) || 1, section: String(f.section || 'Extracted') }
            ]
        };
    });
}

function extractCandidateFactsFromPayload(payload) {
    const { manifest, document: docText = '' } = payload;
    const target = activeTarget();
    return [{
        id: `${manifest.id}_f1`,
        target,
        key: manifest.source,
        value: docText.trim().slice(0, 240) || manifest.source,
        confidence: 0.85,
        approved: true,
        refs: [{ kind: 'source', page: 1, section: '§1' }]
    }];
}

async function loadFactsForItem(payload, forceExtract = false) {
    loadCategoryRegistry();
    const key = factStorageKey(payload.manifest.id);
    if (!forceExtract) {
        try {
            const saved = localStorage.getItem(key);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed)) {
                    state.facts = parsed;
                } else {
                    state.categories = parsed.categories || parsed.docTags || [];
                    state.facts = (parsed.facts || []).map((f) => ({
                        ...f,
                        key: String(f.key || '').replace(/^[^·]+·\s*/, '').trim()
                    }));
                }
                renderCategories();
                renderFacts();
                setDefaultContextBar();
                return;
            }
        } catch { /* ignore storage parse issue */ }
    }

    ui.factsList.replaceChildren(element('p', { className: 'muted', text: 'Extracting categories & standalone facts (Pass 2)…' }));
    try {
        state.facts = await extractFactsViaLlm(payload);
    } catch {
        state.facts = extractCandidateFactsFromPayload(payload);
    }
    saveFactsForItem();
    renderCategories();
    renderFacts();
    setDefaultContextBar();
    renderProblems(payload);
}

function saveFactsForItem() {
    if (!state.item?.manifest?.id) return;
    try {
        localStorage.setItem(factStorageKey(state.item.manifest.id), JSON.stringify({
            categories: state.categories || [],
            facts: state.facts
        }));
    } catch { /* ignore quota */ }
}

function renderFacts() {
    const approvedCount = state.facts.filter((f) => f.approved).length;
    ui.factsCountChip.textContent = state.facts.length ? `${approvedCount}/${state.facts.length}` : '';
    ui.commitFactsBtn.textContent = `Save ${approvedCount} facts`;
    updateChatContextIndicator();

    ui.factsList.replaceChildren();
    if (!state.facts.length) {
        ui.factsList.append(element('p', { className: 'muted', text: 'No facts extracted yet.' }));
        return;
    }

    for (const fact of state.facts) {
        const confPct = Math.round((fact.confidence ?? 0.85) * 100);
        const row = element('div', {
            className: `fact-row${fact.approved ? '' : ' unapproved'}`
        });

        const checkWrap = element('nui-checkbox');
        const checkbox = element('input', {
            className: 'fact-check',
            attrs: { type: 'checkbox', 'aria-label': `Select ${fact.key}` }
        });
        checkbox.checked = Boolean(fact.approved);
        checkbox.addEventListener('change', () => {
            fact.approved = checkbox.checked;
            row.classList.toggle('unapproved', !fact.approved);
            saveFactsForItem();
            const nowApproved = state.facts.filter((f) => f.approved).length;
            ui.factsCountChip.textContent = `${nowApproved}/${state.facts.length}`;
            ui.commitFactsBtn.textContent = `Save ${nowApproved} facts`;
            recordUserAction(`${fact.approved ? 'approved' : 'unchecked'} fact "${fact.key}"`);
        });
        checkWrap.append(checkbox);

        // Two-line stacked layout: Line 1 = Key/Label (+ confidence), Line 2 = Value/Expression
        const stack = element('div', { className: 'fact-stack' });
        const keyLine = element('div', { className: 'fact-key-line' });

        const keyEl = element('div', {
            className: 'fact-key',
            text: fact.key,
            attrs: { contenteditable: 'true', spellcheck: 'false' }
        });
        keyEl.addEventListener('blur', () => {
            const nextKey = keyEl.textContent.trim() || 'Untitled';
            if (nextKey !== fact.key) {
                fact.key = nextKey;
                saveFactsForItem();
                recordUserAction(`renamed fact to "${fact.key}"`);
            }
        });

        const confEl = element('span', {
            className: 'fact-conf',
            text: fact.approved ? `${confPct}% confidence` : `${confPct}% · awaiting approval`
        });

        keyLine.append(keyEl, confEl);

        const valEl = element('div', {
            className: 'fact-value',
            text: fact.value,
            attrs: { contenteditable: 'true' }
        });
        valEl.addEventListener('blur', () => {
            const nextVal = valEl.textContent.trim();
            if (nextVal !== fact.value) {
                fact.value = nextVal;
                saveFactsForItem();
                recordUserAction(`edited value of "${fact.key}"`);
            }
        });

        stack.append(keyLine, valEl);

        row.addEventListener('pointerenter', () => showFactContextBar(fact));
        row.addEventListener('focusin', () => showFactContextBar(fact));

        row.append(checkWrap, stack);
        ui.factsList.append(row);
    }
}

function jumpToSourceRef(ref) {
    if (state.totalPages > 0 && ref.page) {
        state.currentPage = Math.max(1, Math.min(state.totalPages, Number(ref.page) || 1));
        state.pageGridMode = false;
        renderOriginalViewer();
        switchTab('tab-btn-original');
        notice(`Jumped to Page ${state.currentPage} (${ref.section ?? 'Source'}).`);
    } else {
        switchTab('tab-btn-document');
        notice(`Showing Document view for ${ref.section ?? 'Source'}.`);
    }
}

// ─── Original Tab (Rasterized Page Screenshots + Raw Original Link) ───────
function pageUrlFor(index) {
    const pagesBase = state.item?.result?.links?.pages;
    if (!pagesBase) return null;
    return `${pagesBase}page-${String(index).padStart(3, '0')}.png`;
}

function renderOriginalViewer() {
    if (!state.item) return;
    const { manifest, result } = state.item;
    const pageCount = manifest.layers?.pages?.count ?? 0;
    state.totalPages = pageCount;
    ui.pagesCountChip.textContent = pageCount > 0 ? `${pageCount}p` : (result.links.original ? 'file' : '0');

    ui.originalDownloadSlot.replaceChildren();
    if (result.links.original) {
        ui.originalDownloadSlot.append(linkButton(`Open raw ${manifest.format?.toUpperCase() || 'original'}`, result.links.original));
    }

    if (pageCount > 0) {
        const img = element('img', { attrs: { src: pageUrlFor(1), alt: `${manifest.source} page 1` } });
        ui.wizardDocThumb.replaceChildren(img, element('span', { className: 'doc-ext-badge', text: `${pageCount} PAGES` }));
    } else {
        resetWizardThumb(manifest.source);
    }

    ui.originalViewer.replaceChildren();
    ui.originalViewer.classList.toggle('grid-mode', state.pageGridMode);
    ui.togglePageGridBtn.textContent = state.pageGridMode ? 'Single page' : `Grid view (${pageCount})`;
    ui.prevPageBtn.disabled = pageCount <= 1 || state.pageGridMode || state.currentPage <= 1;
    ui.nextPageBtn.disabled = pageCount <= 1 || state.pageGridMode || state.currentPage >= pageCount;
    ui.togglePageGridBtn.disabled = pageCount <= 1;
    ui.pageIndicator.textContent = pageCount > 0
        ? (state.pageGridMode ? `All ${pageCount} pages` : `Page ${state.currentPage} / ${pageCount}`)
        : 'No page rasters';

    if (pageCount === 0) {
        const emptyBox = element('div', { className: 'wizard-doc-card' });
        emptyBox.append(
            icon('image_not_supported'),
            element('h3', { text: 'Converted in Mechanical mode (no page rasters generated)' }),
            element('p', { className: 'muted', text: 'Run with Depth = "Deep" on PDFs to rasterize every page for side-by-side visual verification.' })
        );
        if (result.links.original) {
            emptyBox.append(linkButton('Open original file', result.links.original));
        }
        ui.originalViewer.append(emptyBox);
        return;
    }

    if (state.pageGridMode) {
        for (let p = 1; p <= pageCount; p++) {
            const card = element('div', { className: 'page-raster-card' });
            const img = element('img', { attrs: { src: pageUrlFor(p), alt: `Page ${p}`, loading: 'lazy' } });
            img.addEventListener('click', () => {
                state.currentPage = p;
                state.pageGridMode = false;
                renderOriginalViewer();
            });
            card.append(img, element('span', { className: 'page-raster-caption', text: `Page ${p} of ${pageCount}` }));
            ui.originalViewer.append(card);
        }
    } else {
        const p = Math.max(1, Math.min(pageCount, state.currentPage));
        const card = element('div', { className: 'page-raster-card' });
        const img = element('img', { attrs: { src: pageUrlFor(p), alt: `Page ${p}` } });
        img.addEventListener('click', () => window.open(pageUrlFor(p), '_blank', 'noopener'));
        card.append(
            img,
            element('span', { className: 'page-raster-caption', text: `Page ${p} of ${pageCount} · Click image to open full resolution` })
        );
        ui.originalViewer.append(card);
    }
}

// ─── Problems Tab (Actionable Triage & Repair) ───────────────────────────
function renderProblems(payload) {
    const list = $('problems-list');
    const chip = $('problems-count-chip');
    if (!list) return;
    list.replaceChildren();

    const { manifest } = payload;
    const issues = [];

    for (const warning of manifest.warnings ?? []) {
        issues.push({
            title: warning.code || 'Conversion warning',
            desc: warning.message,
            actionLabel: 'Inspect in Document',
            onAction: () => switchTab('tab-btn-document')
        });
    }

    if ((manifest.layers?.pages?.count ?? 0) === 0) {
        issues.push({
            title: 'No page preview images stored',
            desc: `Converted in ${manifest.depth} mode without rasterized page previews (planned: WebP page previews capped at 1440px).`,
            actionLabel: 'View extracted assets',
            onAction: () => switchTab('tab-btn-document')
        });
    }

    if (!payload.summary) {
        issues.push({
            title: 'Retrieval summary (L0) missing',
            desc: 'Summary generation was skipped or the provider was unreachable during ingest.',
            actionLabel: 'Generate Summary',
            onAction: () => handleChatQuery('Summarize this document for the L0 retrieval layer')
        });
    }

    const lowConfCount = state.facts.filter((f) => !f.approved).length;
    if (lowConfCount > 0) {
        issues.push({
            title: `${lowConfCount} extracted fact(s) below confidence threshold (${Math.round(CONFIDENCE_THRESHOLD * 100)}%)`,
            desc: 'Left unchecked automatically — review and check the ones worth keeping.',
            actionLabel: 'Review Facts',
            onAction: () => switchTab('tab-btn-facts')
        });
    }

    if (chip) chip.textContent = issues.length ? String(issues.length) : '';

    if (!issues.length) {
        list.append(element('p', { className: 'muted', text: 'No ingest problems detected.' }));
        return;
    }

    for (const issue of issues) {
        const row = element('div', { className: 'problem-row' });
        const info = element('div', { className: 'problem-info' });
        info.append(
            element('div', { className: 'problem-title', text: issue.title }),
            element('div', { className: 'problem-desc', text: issue.desc })
        );
        const actions = element('div', { className: 'problem-actions' });
        actions.append(button(issue.actionLabel, issue.onAction));
        row.append(info, actions);
        list.append(row);
    }
}
const TIER_MODELS = {
    local: 'badkid-llama-chat',
    eu: 'mistral-large4-chat',
    cloud: 'deepseek-flash-chat'
};

async function callWorkshopTool(name, args = {}) {
    const res = await fetch('/api/tools/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, args })
    });
    const data = await res.json();
    if (!res.ok || data.isError) {
        const msg = data.error ?? data.content?.[0]?.text ?? `Tool ${name} failed`;
        throw new Error(msg);
    }
    const text = data.content?.[0]?.text ?? '';
    try { return JSON.parse(text); } catch { return text; }
}

function chatSessionName(itemId) {
    return `ntel-${String(itemId).toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 48)}`;
}

async function ensureDocumentChatSession(payload) {
    const { manifest } = payload;
    const sessionName = chatSessionName(manifest.id);
    if (state.chatSessionReady === sessionName) return sessionName;

    const model = TIER_MODELS[ui.privacyTier.value] || 'deepseek-flash-chat';
    const sysPrompt = [
        `You are the nTeligence Document & Fact Curation Assistant for "${manifest.source}" (item ID: "${manifest.id}", format: ${manifest.format}, ${manifest.layers?.sections?.count ?? 1} sections) in Target "${activeTarget()}".`,
        `You have access to the 'workshop' tool dispatcher:`,
        `- To inspect a specific section of this document, call workshop with method="nconvert.fetch" and payload={"item":"${manifest.id}","layer":"document","section":N}.`,
        `- To cross-reference against existing documents in the database, call workshop with method="vdb.search" and payload={"query":"..."}.`,
        `- Each user message includes a hidden [UI Context] block telling you which tab the user is currently viewing and their recent curation actions. Use that context naturally without repeating it back.`,
        `- Whenever you extract standalone facts or the user asks for facts, include a fenced \`\`\`json block at the end of your reply in the shape: {"facts":[{"key":"Short Descriptor","value":"Self-contained fact statement","confidence":0.92,"page":1,"section":"§1"}]}. Keep prose concise.`
    ].join('\n');

    try {
        await callWorkshopTool('chat_create', { name: sessionName, model, systemPrompt: sysPrompt });
        const preload = `=== Document Overview: ${manifest.source} (id: ${manifest.id}) ===\n\n## L0 Summary\n${payload.summary || '(none)'}\n\n## L1 Document Excerpt\n${(payload.document || '').slice(0, 12000)}`;
        await callWorkshopTool('chat_inject', {
            name: sessionName,
            messages: [{ role: 'user', content: preload }]
        });
    } catch (err) {
        // Session already exists on disk — reuse it
        if (!String(err.message).includes('exists')) throw err;
    }
    state.chatSessionReady = sessionName;
    return sessionName;
}

function initChatForItem(payload) {
    const { manifest } = payload;
    state.chatSessionReady = null;
    ui.chatMessages.replaceChildren();
    const welcome = element('div', {
        className: 'chat-bubble assistant',
        text: `Ready on "${manifest.source}". Ask to extract facts, dates, or cross-reference against existing items.`
    });
    ui.chatMessages.append(welcome);
}

function appendChatTurn(userPrompt, assistantReply, suggestedFacts = []) {
    if (userPrompt) {
        const userBubble = element('div', { className: 'chat-bubble user', text: userPrompt });
        ui.chatMessages.append(userBubble);
    }

    const botBubble = element('div', { className: 'chat-bubble assistant' });
    const body = element('div');
    markdown(body, assistantReply);
    botBubble.append(body);

    const factsList = Array.isArray(suggestedFacts) ? suggestedFacts : (suggestedFacts ? [suggestedFacts] : []);
    for (const suggestedFact of factsList) {
        const card = element('div', { className: 'chat-fact-suggestion' });
        card.append(
            element('strong', { text: suggestedFact.key }),
            element('span', { text: suggestedFact.value })
        );
        const addBtn = element('button', { className: 'ctx-btn', text: '+ Add to Facts', attrs: { type: 'button' } });
        addBtn.addEventListener('click', () => {
            const conf = Number(suggestedFact.confidence) || 0.9;
            state.facts.unshift({
                id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                target: activeTarget(),
                key: suggestedFact.key,
                value: suggestedFact.value,
                confidence: conf,
                approved: conf >= CONFIDENCE_THRESHOLD,
                refs: suggestedFact.refs ?? [{ kind: 'source', page: suggestedFact.page || 1, section: suggestedFact.section || 'Chat extraction' }]
            });
            saveFactsForItem();
            renderFacts();
            recordUserAction(`added fact "${suggestedFact.key}" from chat`);
            switchTab('tab-btn-facts');
        });
        card.append(addBtn);
        botBubble.append(card);
    }

    ui.chatMessages.append(botBubble);
    ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
}

function parseExtractedFactsFromReply(replyText) {
    let cleanText = String(replyText || '');
    const extracted = [];
    const fenceRe = /```json\s*([\s\S]*?)```/gi;
    let match;
    while ((match = fenceRe.exec(replyText)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim());
            const arr = Array.isArray(parsed) ? parsed : parsed?.facts;
            if (Array.isArray(arr)) {
                for (const item of arr) {
                    if (item?.key && item?.value) extracted.push(item);
                }
                cleanText = cleanText.replace(match[0], '').trim();
            }
        } catch { /* keep non-fact json blocks untouched */ }
    }
    return { cleanText: cleanText || replyText, extracted };
}

async function handleChatQuery(rawPrompt) {
    const prompt = rawPrompt.trim();
    if (!prompt || !state.item) return;
    const { manifest } = state.item;

    const userBubble = element('div', { className: 'chat-bubble user', text: prompt });
    const pendingBubble = element('div', { className: 'chat-bubble assistant muted', text: 'Thinking…' });
    ui.chatMessages.append(userBubble, pendingBubble);
    ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;

    const approvedFacts = state.facts.filter((f) => f.approved).map((f) => f.key);
    const pendingFacts = state.facts.filter((f) => !f.approved).map((f) => f.key);
    const recentActions = state.userActions.slice(-6).map((a) => `${a.at}: ${a.action}`).join('; ') || 'none';
    const hiddenContext = [
        `[UI Context — do not repeat verbatim]`,
        `Active tab on screen: ${state.activeTab}${state.activeTab === 'original' ? ` (page ${state.currentPage}/${state.totalPages || 1})` : ''}`,
        `Target: ${activeTarget()}`,
        `Approved facts (${approvedFacts.length}): ${approvedFacts.join(' | ') || 'none'}`,
        `Unchecked low-confidence facts (${pendingFacts.length}): ${pendingFacts.join(' | ') || 'none'}`,
        `Recent user actions: ${recentActions}`
    ].join('\n');

    recordUserAction(`asked chat: "${prompt.slice(0, 40)}"`);

    try {
        const sessionName = await ensureDocumentChatSession(state.item);
        const result = await callWorkshopTool('chat_send', {
            name: sessionName,
            message: `${hiddenContext}\n\nUser message: ${prompt}`
        });
        pendingBubble.remove();
        const replyText = typeof result === 'string' ? result : (result.reply ?? JSON.stringify(result));
        const { cleanText, extracted } = parseExtractedFactsFromReply(replyText);
        appendChatTurn(null, cleanText, extracted);
    } catch (error) {
        pendingBubble.remove();
        appendChatTurn(null, `Error: ${error.message}`);
    }
}

function renderResult(payload) {
    const { manifest, result } = payload;
    if (!state.job) {
        ui.jobName.textContent = manifest.source;
        ui.jobSource.textContent = manifest.sourcePath ?? result.item;
        ui.jobSource.title = manifest.sourcePath ?? result.item;
    }
    ui.docViewTitle.textContent = manifest.source;
    const coverage = manifest.coverage == null ? 'coverage n/a' : `coverage ${(manifest.coverage * 100).toFixed(1)}%`;
    ui.resultProvenance.textContent = `${manifest.converter} · ${manifest.depth} · ${manifest.layers.sections.count} sections · ${coverage}`;
    ui.resultLinks.replaceChildren();
    const links = [
        ['Document', result.links.document], ['Mechanical', result.links.mechanical],
        ['Original', result.links.original], ['Manifest', result.links.manifest],
        ['Pages', result.links.pages], ['Assets', result.links.assets]
    ];
    for (const [label, url] of links) if (url) ui.resultLinks.append(linkButton(label, url));

    ui.resultStats.replaceChildren();
    const stats = [
        ['Words', manifest.stats.words], ['Headings', manifest.stats.headings],
        ['Table rows', manifest.stats.rows], ['Figures', manifest.stats.figures],
        ['Warnings', manifest.warnings?.length ?? 0]
    ];
    for (const [label, value] of stats) {
        const item = element('span');
        item.append(element('strong', { text: `${value} ` }), document.createTextNode(label.toLowerCase()));
        ui.resultStats.append(item);
    }

    ui.resultWarnings.replaceChildren();
    for (const warning of manifest.warnings ?? []) {
        const row = element('div', { className: 'warning-row' });
        row.append(element('code', { text: warning.code }), document.createTextNode(warning.message));
        ui.resultWarnings.append(row);
    }
    markdown(ui.resultSummary, payload.summary ?? 'No summary was generated for this item.', result.links.summary ?? result.links.document);
    markdown(ui.resultDocument, payload.document, result.links.document);
    ui.documentTruncated.hidden = !payload.documentTruncated;
    if (payload.documentTruncated) ui.documentTruncated.textContent = `Preview truncated at ${payload.document.length.toLocaleString()} of ${payload.documentChars.toLocaleString()} characters. Open the full document for the rest.`;

    state.currentPage = 1;
    state.pageGridMode = false;
    renderOriginalViewer();
    loadFactsForItem(payload, false);
    renderProblems(payload);
    initChatForItem(payload);
    updateChatContextIndicator();
    if (state.job) renderJob();

    ui.openWorkspaceBtn.hidden = false;
    setStageView(false);
    setDefaultContextBar();
    notice(`Ready in Review Workspace — ${state.facts.length} candidate facts extracted for Target "${activeTarget()}".`);
}

async function cancelCurrentJob() {
    if (!state.job) return;
    try {
        const payload = await api(`/nconvert/jobs/${encodeURIComponent(state.job.id)}/cancel`, { method: 'POST' });
        applyJob(payload.job);
    } catch (error) {
        notice(error.message, 'error');
    }
}

for (const id of ['tab-btn-document', 'tab-btn-facts', 'tab-btn-original', 'tab-btn-problems', 'tab-btn-technical']) {
    const btn = $(id);
    if (btn) btn.addEventListener('click', () => switchTab(id));
}

// Editable split between Document/Tabs and Chat
const resizer = $('workspace-resizer');
if (resizer) {
    const savedWidth = Number(localStorage.getItem('nteligence.chatWidth'));
    if (savedWidth >= 260 && savedWidth <= 720) {
        ui.resultPanel.style.setProperty('--chat-width', `${savedWidth}px`);
    }
    resizer.addEventListener('pointerdown', (startEvent) => {
        startEvent.preventDefault();
        resizer.setPointerCapture(startEvent.pointerId);
        resizer.classList.add('dragging');
        const onMove = (moveEvent) => {
            const nextWidth = Math.max(260, Math.min(720, window.innerWidth - moveEvent.clientX));
            ui.resultPanel.style.setProperty('--chat-width', `${Math.round(nextWidth)}px`);
            localStorage.setItem('nteligence.chatWidth', String(Math.round(nextWidth)));
        };
        const onUp = () => {
            resizer.classList.remove('dragging');
            resizer.removeEventListener('pointermove', onMove);
            resizer.removeEventListener('pointerup', onUp);
        };
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
    });
}
const wsTarget = $('workspace-target');
if (wsTarget) {
    wsTarget.addEventListener('change', () => {
        ui.targetPreset.value = wsTarget.value;
        ui.targetInput.value = wsTarget.value;
        updateContextPills();
        setDefaultContextBar();
    });
}

ui.targetPreset.addEventListener('change', () => {
    const val = ui.targetPreset.value;
    ui.targetCustomWrap.hidden = val !== 'custom';
    if (val !== 'custom') {
        ui.targetInput.value = val;
        const defaults = TARGET_DEFAULTS[val];
        if (defaults) {
            ui.privacyTier.value = defaults.tier;
            ui.workflowMode.value = defaults.mode;
        }
    }
    updateContextPills();
});
ui.targetInput.addEventListener('input', updateContextPills);
ui.privacyTier.addEventListener('change', updateContextPills);
ui.workflowMode.addEventListener('change', updateContextPills);

ui.toggleStageBtn.addEventListener('click', () => setStageView(!state.showingProgressCard));
ui.openWorkspaceBtn.addEventListener('click', () => setStageView(false));
ui.peekTechnicalBtn.addEventListener('click', () => {
    setStageView(false);
    switchTab('tab-btn-technical');
});

// Category Registry Autocomplete
const catInput = $('category-input');
const catSuggest = $('category-suggestions');
function renderCategorySuggestions() {
    if (!catInput || !catSuggest) return;
    const q = catInput.value.trim().toLowerCase();
    const available = state.categoryRegistry.filter(
        (c) => !state.categories.includes(c) && (!q || c.toLowerCase().includes(q))
    );
    catSuggest.replaceChildren();
    for (const option of available.slice(0, 8)) {
        const btn = element('button', {
            className: 'category-option',
            text: option,
            attrs: { type: 'button' }
        });
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            addDocumentCategory(option);
            catInput.value = '';
            catSuggest.hidden = true;
        });
        catSuggest.append(btn);
    }
    const exactExists = state.categoryRegistry.some((c) => c.toLowerCase() === q) || state.categories.some((c) => c.toLowerCase() === q);
    if (q && !exactExists) {
        const createBtn = element('button', {
            className: 'category-option create-new',
            text: `+ Create category "${catInput.value.trim()}"`,
            attrs: { type: 'button' }
        });
        createBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            addDocumentCategory(catInput.value.trim());
            catInput.value = '';
            catSuggest.hidden = true;
        });
        catSuggest.append(createBtn);
    }
    catSuggest.hidden = catSuggest.children.length === 0;
}
if (catInput && catSuggest) {
    catInput.addEventListener('focus', renderCategorySuggestions);
    catInput.addEventListener('input', renderCategorySuggestions);
    catInput.addEventListener('blur', () => { setTimeout(() => { catSuggest.hidden = true; }, 120); });
    catInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const firstMatch = state.categoryRegistry.find(
                (c) => !state.categories.includes(c) && c.toLowerCase().includes(catInput.value.trim().toLowerCase())
            );
            addDocumentCategory(firstMatch && catInput.value.trim().length < firstMatch.length ? firstMatch : catInput.value.trim());
            catInput.value = '';
            catSuggest.hidden = true;
        } else if (e.key === 'Escape') {
            catSuggest.hidden = true;
            catInput.blur();
        }
    });
}

ui.factsFilter.addEventListener('change', renderFacts);
ui.addFactBtn.addEventListener('click', () => {
    state.facts.unshift({
        id: `manual_${Date.now()}`,
        target: activeTarget(),
        key: 'New Concept Descriptor',
        value: 'Enter the self-contained statement or value…',
        confidence: 0.95,
        approved: true,
        refs: [{ kind: 'source', page: state.currentPage || 1, section: 'Manual curation' }]
    });
    saveFactsForItem();
    renderFacts();
});
ui.rerunPass2Btn.addEventListener('click', () => {
    if (!state.item) return;
    loadFactsForItem(state.item, true);
    notice(`Re-extracted ${state.facts.length} candidate facts under ${TIER_LABELS[ui.privacyTier.value]}.`);
});
ui.commitFactsBtn.addEventListener('click', async () => {
    const approved = state.facts.filter((f) => f.approved);
    saveFactsForItem();
    recordUserAction(`saved ${state.categories.length} categories and ${approved.length} approved facts`);
    if (state.item?.manifest?.id) {
        try {
            const path = `ingest/${state.item.manifest.id}/facts.json`;
            const doc = {
                itemId: state.item.manifest.id,
                source: state.item.manifest.source,
                target: activeTarget(),
                categories: state.categories,
                updatedAt: new Date().toISOString(),
                approvedCount: approved.length,
                facts: state.facts
            };
            await callWorkshopTool('storage_write', { path, content: JSON.stringify(doc, null, 2) });
            ui.commitFactsBtn.textContent = `Saved ${approved.length} facts ✓`;
        } catch (err) {
            notice(err.message, 'error');
        }
    }
});

ui.prevPageBtn.addEventListener('click', () => {
    if (state.currentPage > 1) {
        state.currentPage--;
        renderOriginalViewer();
    }
});
ui.nextPageBtn.addEventListener('click', () => {
    if (state.currentPage < state.totalPages) {
        state.currentPage++;
        renderOriginalViewer();
    }
});
ui.togglePageGridBtn.addEventListener('click', () => {
    state.pageGridMode = !state.pageGridMode;
    renderOriginalViewer();
});

ui.chatQuickPrompts.addEventListener('click', (event) => {
    const chip = event.target.closest('.prompt-chip');
    if (!chip) return;
    handleChatQuery(chip.dataset.prompt || chip.textContent);
});
ui.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = ui.chatInput.value.trim();
    if (!text) return;
    ui.chatInput.value = '';
    handleChatQuery(text);
});

ui.pathForm.addEventListener('submit', submitPath);
ui.chooseFile.addEventListener('click', (event) => { event.stopPropagation(); ui.fileInput.click(); });
ui.fileInput.addEventListener('change', () => submitFile(ui.fileInput.files[0]));
ui.dropzone.addEventListener('click', (event) => { if (!event.target.closest('button')) ui.fileInput.click(); });
ui.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ui.fileInput.click(); }
});
ui.dropzone.addEventListener('dragover', (event) => { event.preventDefault(); ui.dropzone.classList.add('dragging'); });
ui.dropzone.addEventListener('dragleave', () => ui.dropzone.classList.remove('dragging'));
ui.dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.dropzone.classList.remove('dragging');
    submitFile(event.dataTransfer.files[0]);
});
ui.newConversion.addEventListener('click', () => showSource());
ui.refreshJobs.addEventListener('click', loadRecent);
ui.cancelJob.addEventListener('click', cancelCurrentJob);
ui.activityFilter.addEventListener('change', renderActivity);
window.addEventListener('popstate', () => {
    const params = new URLSearchParams(location.search);
    if (params.get('job')) openJob(params.get('job'), { navigate: false });
    else if (params.get('item')) openItem(params.get('item'), { navigate: false });
    else showSource({ navigate: false });
});
setInterval(() => {
    if (state.job && ['queued', 'running'].includes(state.job.state)) renderJob();
}, 1000);

updateContextPills();
const params = new URLSearchParams(location.search);
if (params.get('job')) openJob(params.get('job'), { navigate: false });
else if (params.get('item')) openItem(params.get('item'), { navigate: false });
else showSource({ navigate: false });
