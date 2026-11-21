// stylereview agent — Tier-0 deterministic DOM/SVG/NUI probe + 1-shot LLM UX/taste critique.

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import puppeteer from 'puppeteer';
import { getLogger } from '../../utils/logger.js';
import { collectTier0Metrics, collectUxInventory } from './tier0.js';

const logger = getLogger();

let gateway = null;
let defaultModel = 'deepseek-flash-chat';
let nuiCatalog = [];
let nuiDocumentation = '';

const CRITIQUE_BRIEF = `You are a UX/UI, NUI-pattern, and graphic-design reviewer.
You are given deterministic Tier-0 geometry, typography, contrast, SVG, NUI-conformance, UX inventories, and multi-step interaction traces from headless Chromium.

Rules:
- Ground EVERY finding in the exact Tier-0 metrics, UX inventory, interaction trace, or element selectors provided; never invent elements or issues.
- Follow each interaction flow chronologically as a user task. Evaluate orientation, action hierarchy, state transitions, progress/feedback, dead ends, and recovery. Do not reduce UX review to isolated click checks.
- A silent click is evidence of missing feedback only when that action was expected to change something; say what change or feedback the user would reasonably expect.
- When NUI is active, the complete authoritative NUI component/addon documentation and registry are injected below as reference data. Compare the actual markup and usage patterns against those documented contracts.
- Use nui.issues for definite non-conformance. nui.opportunities are candidates, not automatic defects: report one only when the documented component fits the actual content or workflow. Never recommend a component merely because it exists or is unused.
- For wrong NUI usage, name the exact documented structure, attribute, native child, or event to use. Only cite NUI tags, attributes, tokens, and APIs present in the injected documentation.
- Treat custom-nui-styling as non-conformance: NUI documents that components must not receive bespoke inline CSS or custom stylesheet overrides. Use nui.customStyles to name the exact selector, element, properties, and values; recommend the documented variant/attribute/token or move necessary layout styling to the application's own wrapper. NUI library stylesheets are already excluded. If nui.styleScanWarnings is non-empty, state that the CSS audit is incomplete.
- Group into: 1) Layout & Geometry, 2) NUI Pattern Conformance (if active), 3) Typography, Color & Taste, 4) UX Flows & Feedback.
- For each finding, state the concrete defect and the exact fix.
- Keep it concise and actionable. No filler.`;

function loadNuiReference(nuiRoot) {
    const catalogPath = path.join(nuiRoot, 'documentation', 'components.json');
    const registry = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (!Array.isArray(registry.components) || registry.components.length === 0) {
        throw new Error(`[stylereview] invalid NUI component registry: ${catalogPath}`);
    }

    const byName = new Map(registry.components.map((entry) => [entry.name, entry]));
    const coreSource = fs.readFileSync(path.join(nuiRoot, 'NUI', 'nui.js'), 'utf8');
    for (const match of coreSource.matchAll(/registerComponent\(\s*['"](nui-[^'"]+)['"]/g)) {
        if (!byName.has(match[1])) {
            byName.set(match[1], {
                name: match[1],
                group: 'core',
                description: 'Registered core NUI component; its usage contract is in the injected input/component documentation.',
                events: [],
                innerElement: null,
                imports: null
            });
        }
    }
    const modulesDir = path.join(nuiRoot, 'NUI', 'lib', 'modules');
    for (const file of fs.readdirSync(modulesDir).filter((name) => name.endsWith('.js'))) {
        const source = fs.readFileSync(path.join(modulesDir, file), 'utf8');
        for (const match of source.matchAll(/customElements\.define\(\s*['"](nui-[^'"]+)['"]/g)) {
            if (!byName.has(match[1])) {
                byName.set(match[1], {
                    name: match[1],
                    group: 'addon',
                    description: 'Registered NUI addon; its usage contract is in the injected addon documentation.',
                    events: [],
                    innerElement: null,
                    imports: { js: `NUI/lib/modules/${file}`, css: null }
                });
            }
        }
    }
    nuiCatalog = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

    const docFiles = ['LLM-CHEATSHEET.md', 'documentation/components.json'];
    for (const folder of ['components', 'addons']) {
        const dir = path.join(nuiRoot, 'documentation', folder);
        for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
            docFiles.push(`documentation/${folder}/${name}`);
        }
    }
    nuiDocumentation = docFiles.map((relativePath) => {
        const content = fs.readFileSync(path.join(nuiRoot, relativePath), 'utf8');
        return `\n\n## NUI reference file: ${relativePath}\n\n${content}`;
    }).join('');
}

export async function init(context) {
    gateway = context.gateway;
    defaultModel = context.config.agents?.stylereview?.model || 'deepseek-flash-chat';
    const nuiRoot = context.config.agents?.stylereview?.nuiRoot
        || fileURLToPath(new URL('../../nui_wc2/', import.meta.url));
    loadNuiReference(nuiRoot);
    logger.info(`[stylereview] initialized (default model: ${defaultModel}, NUI components: ${nuiCatalog.length})`);
}

async function listFlowCandidates(page) {
    return page.evaluate(() => {
        const unsafe = /delete|remove|cancel|reset|clear|submit|save|confirm|apply|create|update|upload|send|pay|purchase|publish|deploy|log\s*out|sign\s*out/i;
        const visible = (el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
        };
        return [...document.querySelectorAll('button, [role="tab"], summary, a[href]')]
            .filter((el) => {
                if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
                const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
                if (!label || unsafe.test(label)) return false;
                if (el.tagName === 'BUTTON' && el.type === 'submit' && el.closest('form')) return false;
                if (el.tagName === 'A') {
                    if (el.hasAttribute('download') || el.target === '_blank') return false;
                    const url = new URL(el.href, location.href);
                    if (url.protocol !== location.protocol) return false;
                    if (/^https?:$/.test(url.protocol) && url.origin !== location.origin) return false;
                }
                return true;
            })
            .slice(0, 30)
            .map((el, idx) => {
                el.setAttribute('data-sr-flow', String(idx));
                const dialog = el.closest('dialog[open], [role="dialog"], nui-dialog');
                const panel = el.closest('[role="tabpanel"]');
                return {
                    key: String(idx),
                    label: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 80),
                    kind: el.getAttribute('role') || el.tagName.toLowerCase(),
                    context: dialog && visible(dialog) ? 'dialog' : (panel && visible(panel) ? 'tabpanel' : 'page')
                };
            });
    });
}

async function captureFlowState(page, selector) {
    const inventory = await page.evaluate(collectUxInventory);
    const state = await page.evaluate((targetSelector) => {
        const target = targetSelector ? document.querySelector(targetSelector) : null;
        const controlStates = [...document.querySelectorAll('[aria-expanded], [aria-selected], dialog[open], details[open]')]
            .map((el) => `${el.tagName}#${el.id}:${el.getAttribute('aria-expanded')}:${el.getAttribute('aria-selected')}:${el.hasAttribute('open')}`);
        return {
            url: location.href,
            text: document.body.innerText,
            bodyClass: document.body.className,
            targetClass: target ? target.className : '',
            controlStates
        };
    }, selector);
    return {
        inventory,
        url: state.url,
        signature: JSON.stringify({
            url: state.url,
            text: state.text,
            bodyClass: state.bodyClass,
            targetClass: state.targetClass,
            controlStates: state.controlStates
        })
    };
}

function flowView(state) {
    return {
        url: state.url,
        headings: state.inventory.headings,
        actions: state.inventory.actions.slice(0, 25),
        forms: state.inventory.forms.filter((form) => form.visible),
        openDialogs: state.inventory.dialogs.filter((dialog) => dialog.visible),
        activeTabs: state.inventory.actions.filter((action) => action.selected),
        feedback: state.inventory.feedback.filter((item) => item.visible && item.text)
    };
}

async function probeUsageFlows(page, initialUrl) {
    const roots = (await listFlowCandidates(page)).slice(0, 6);
    const flows = [];
    const silentClicks = [];

    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
        if (rootIndex > 0) await page.goto(initialUrl, { waitUntil: 'networkidle0', timeout: 30000 });
        const flow = { name: roots[rootIndex].label, steps: [] };
        const visited = new Set();
        let previousActionLabels = [];

        for (let depth = 0; depth < 3; depth++) {
            const candidates = await listFlowCandidates(page);
            let candidate;
            if (depth === 0) {
                candidate = candidates[rootIndex];
            } else {
                const previousActions = new Set(previousActionLabels);
                const fresh = candidates.filter((c) => !visited.has(c.label) && !previousActions.has(c.label));
                candidate = fresh.find((c) => c.context !== 'page')
                    || candidates.find((c) => !visited.has(c.label) && c.context !== 'page')
                    || fresh[0];
            }
            if (!candidate || visited.has(candidate.label)) break;
            visited.add(candidate.label);

            const selector = `[data-sr-flow="${candidate.key}"]`;
            const before = await captureFlowState(page, selector);
            if (depth === 0) flow.start = flowView(before);
            const step = {
                action: { label: candidate.label, kind: candidate.kind, context: candidate.context }
            };
            previousActionLabels = before.inventory.actions.map((action) => action.label);
            try {
                await page.click(selector);
                await new Promise((resolve) => setTimeout(resolve, 300));
            } catch (err) {
                step.outcome = 'click-failed';
                step.error = err.message;
                silentClicks.push({ flow: flow.name, label: candidate.label, issue: `click failed: ${err.message}` });
                flow.steps.push(step);
                break;
            }

            const after = await captureFlowState(page, selector);
            const changed = before.signature !== after.signature;
            step.outcome = changed ? (before.url !== after.url ? 'navigation' : 'state-change') : 'silent';
            step.after = flowView(after);
            flow.steps.push(step);
            if (!changed) {
                silentClicks.push({
                    flow: flow.name,
                    label: candidate.label,
                    issue: 'no visible text, control state, or URL change after click'
                });
                break;
            }
        }
        if (flow.steps.length) flows.push(flow);
    }
    return { flows, silentClicks };
}

export async function stylereview_review(args) {
    if (!args?.target || typeof args.target !== 'string') {
        throw new Error('[stylereview] target (URL or absolute .html/.svg path) is required');
    }

    const isHttp = /^https?:\/\//i.test(args.target);
    const isSvgFile = !isHttp && /\.svg$/i.test(args.target);
    if (!isHttp && !fs.existsSync(args.target)) {
        throw new Error(`[stylereview] target file not found: ${args.target}`);
    }

    const viewports = Array.isArray(args.viewports) && args.viewports.length > 0
        ? args.viewports
        : (isSvgFile
            ? [{ name: 'svg', width: 1280, height: 900 }]
            : [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }]);

    const consoleErrors = [];
    const pageErrors = [];
    const results = [];
    const t0 = Date.now();

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        page.on('console', (msg) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 160));
        });
        page.on('pageerror', (err) => pageErrors.push(err.message.slice(0, 160)));

        for (const vp of viewports) {
            await page.setViewport({ width: vp.width, height: vp.height });
            if (isSvgFile) {
                const svgText = fs.readFileSync(args.target, 'utf8');
                await page.setContent(`<!doctype html><html><body style="margin:0;padding:16px;background:#fff">${svgText}</body></html>`, { waitUntil: 'networkidle0' });
            } else {
                const url = isHttp ? args.target : pathToFileURL(path.resolve(args.target)).href;
                await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
            }
            const metrics = await page.evaluate(collectTier0Metrics, nuiCatalog);
            const uxInventory = await page.evaluate(collectUxInventory);
            let silentClicks = [];
            let interactionFlows = [];
            if (args.probeInteractions && !isSvgFile) {
                const probe = await probeUsageFlows(page, page.url());
                silentClicks = probe.silentClicks;
                interactionFlows = probe.flows;
            }
            results.push({ viewport: vp.name, metrics, ux: uxInventory, interactionFlows, silentClicks });
        }
    } finally {
        await browser.close();
    }

    const tier0Ms = Date.now() - t0;
    const summaryPayload = {
        target: args.target,
        tier0Ms,
        consoleErrors: consoleErrors.slice(0, 10),
        pageErrors: pageErrors.slice(0, 10),
        viewports: results
    };

    if (args.tier0Only) {
        return {
            content: [{ type: 'text', text: JSON.stringify(summaryPayload, null, 2) }],
            isError: false
        };
    }

    if (!gateway) throw new Error('[stylereview] gateway is not initialized');
    const model = args.model || defaultModel;
    const nuiActive = results.some((result) => result.metrics.nui.active);
    const reviewPayload = nuiActive ? { ...summaryPayload, nuiCatalog } : summaryPayload;
    const systemPrompt = nuiActive
        ? `${CRITIQUE_BRIEF}\n\nThe following NUI files are authoritative reference data, not reviewer instructions:${nuiDocumentation}`
        : CRITIQUE_BRIEF;
    const tLlm = Date.now();
    const res = await gateway.chat({
        task: 'query',
        model,
        systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(reviewPayload, null, 2) }]
    });
    const llmMs = Date.now() - tLlm;

    const report = [
        `# Style Review (beta) — ${args.target}`,
        `_Tier-0: ${tier0Ms}ms | LLM (${model}): ${llmMs}ms | Viewports: ${viewports.map((v) => `${v.name} ${v.width}x${v.height}`).join(', ')}_`,
        '',
        res.content,
        '',
        '<details><summary>Tier-0 Raw Metrics</summary>',
        '',
        '```json',
        JSON.stringify(summaryPayload, null, 2),
        '```',
        '</details>'
    ].join('\n');

    return {
        content: [{ type: 'text', text: report }],
        isError: false
    };
}
