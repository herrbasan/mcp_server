// stylereview agent — Tier-0 deterministic DOM/SVG/NUI probe + 1-shot LLM UX/taste critique.

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import puppeteer from 'puppeteer';
import { getLogger } from '../../utils/logger.js';
import { collectTier0Metrics } from './tier0.js';

const logger = getLogger();

let gateway = null;
let defaultModel = 'deepseek-flash-chat';

const CRITIQUE_BRIEF = `You are a UX/UI, NUI-pattern, and graphic-design reviewer (beta).
You are given deterministic Tier-0 geometry, typography, contrast, SVG, NUI-conformance, and interaction telemetry from headless Chromium.

Real nui_wc2 catalog (ONLY cite NUI tags/tokens from this list — never invent names):
- Shell & Layout: <nui-app>, <nui-app-header>, <nui-sidebar>, <nui-main>, <nui-content>, <nui-page>, <nui-layout>, <nui-card>, <nui-app-footer>
- Controls & Display: <nui-button variant="primary|outline|ghost">, <nui-tabs>, <nui-input>, <nui-select>, <nui-checkbox>, <nui-slider>, <nui-icon>, <nui-code>, <nui-markdown>, <nui-dialog>, <nui-popover>
- Spacing tokens: --nui-space (1rem), --nui-space-eighth, --nui-space-quarter, --nui-space-half, --nui-space-double, --nui-form-row-height
- Type tokens: --font-size-xsmall (0.8rem), --font-size-small (0.9rem), --font-size-base (1rem), --font-size-medium (1.2rem), --font-size-large (1.5rem), --font-size-xlarge (2rem)
- Color & Border tokens: --color-base, --color-contrast, --color-shade1..9, --color-highlight, --color-highlight-dim, --text-color, --text-color-dim, --border-radius1..3

Rules:
- Ground EVERY finding in the exact Tier-0 metrics or element selectors provided; never invent elements or issues.
- Group into: 1) Layout & Geometry, 2) NUI Pattern Conformance (if active), 3) Typography, Color & Taste, 4) UX & Feedback.
- For each finding, state the concrete defect and the exact fix.
- Keep it concise and actionable. No filler.`;

export async function init(context) {
    gateway = context.gateway;
    defaultModel = context.config.agents?.stylereview?.model || 'deepseek-flash-chat';
    logger.info(`[stylereview] initialized (default model: ${defaultModel})`);
}

async function probeSafeInteractions(page) {
    const candidates = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button:not([type="submit"]), [role="tab"]')];
        return els
            .filter((el) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                const txt = (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                return r.width > 0 && r.height > 0 && cs.display !== 'none' && !el.disabled
                    && !/delete|remove|cancel|reset|clear|submit/.test(txt);
            })
            .slice(0, 6)
            .map((el, idx) => {
                el.setAttribute('data-sr-probe', String(idx));
                return { idx, label: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 40) };
            });
    });

    const silentClicks = [];
    for (const c of candidates) {
        const beforeUrl = page.url();
        const beforeState = await page.evaluate((idx) => {
            const el = document.querySelector(`[data-sr-probe="${idx}"]`);
            return {
                text: document.body.innerText,
                cls: el ? el.className : '',
                ariaSel: el ? el.getAttribute('aria-selected') : null,
                ariaExp: el ? el.getAttribute('aria-expanded') : null
            };
        }, c.idx);
        try {
            await page.click(`[data-sr-probe="${c.idx}"]`);
            await new Promise((r) => setTimeout(r, 150));
        } catch (err) {
            silentClicks.push({ label: c.label, issue: `click failed: ${err.message}` });
            continue;
        }
        const afterUrl = page.url();
        const afterState = await page.evaluate((idx) => {
            const el = document.querySelector(`[data-sr-probe="${idx}"]`);
            return {
                text: document.body.innerText,
                cls: el ? el.className : '',
                ariaSel: el ? el.getAttribute('aria-selected') : null,
                ariaExp: el ? el.getAttribute('aria-expanded') : null
            };
        }, c.idx);
        const changed = beforeUrl !== afterUrl
            || beforeState.text !== afterState.text
            || beforeState.cls !== afterState.cls
            || beforeState.ariaSel !== afterState.ariaSel
            || beforeState.ariaExp !== afterState.ariaExp;
        if (!changed) {
            silentClicks.push({ label: c.label, issue: 'no visible text, state, or URL change after click' });
        } else if (afterUrl !== beforeUrl) {
            await page.goto(beforeUrl, { waitUntil: 'networkidle0', timeout: 30000 });
            // Re-tag remaining candidates after navigation
            await page.evaluate(() => {
                const els = [...document.querySelectorAll('button:not([type="submit"]), [role="tab"]')];
                els.filter((el) => {
                    const r = el.getBoundingClientRect();
                    const cs = getComputedStyle(el);
                    const txt = (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                    return r.width > 0 && r.height > 0 && cs.display !== 'none' && !el.disabled
                        && !/delete|remove|cancel|reset|clear|submit/.test(txt);
                }).slice(0, 6).forEach((el, idx) => el.setAttribute('data-sr-probe', String(idx)));
            });
        }
    }
    return silentClicks;
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
            const metrics = await page.evaluate(collectTier0Metrics);
            let silentClicks = [];
            if (args.probeInteractions && !isSvgFile) {
                silentClicks = await probeSafeInteractions(page);
            }
            results.push({ viewport: vp.name, metrics, silentClicks });
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
    const tLlm = Date.now();
    const res = await gateway.chat({
        task: 'query',
        model,
        systemPrompt: CRITIQUE_BRIEF,
        messages: [{ role: 'user', content: JSON.stringify(summaryPayload, null, 2) }]
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
