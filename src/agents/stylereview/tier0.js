// Tier-0 deterministic DOM, SVG, NUI-conformance, and taste-proxy extractor.
// Runs inside page.evaluate() in headless Chromium; returns structured facts only.

export function collectUxInventory() {
    const visible = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const labelOf = (el) => `${el.tagName.toLowerCase()}${el.getAttribute('id') ? `#${el.getAttribute('id')}` : ''}`;
    const nameOf = (el) => {
        const labelledBy = el.getAttribute('aria-labelledby');
        const labelledText = labelledBy
            ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
            : '';
        const labels = el.labels ? [...el.labels].map((label) => label.textContent).join(' ') : '';
        return (el.getAttribute('aria-label') || labelledText || labels || el.textContent
            || el.getAttribute('placeholder') || el.getAttribute('title') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    };

    const actions = [...document.querySelectorAll('button, a[href], summary, [role="button"], [role="tab"], input[type="button"], input[type="submit"]')]
        .filter(visible)
        .slice(0, 50)
        .map((el) => ({
            el: labelOf(el),
            label: nameOf(el),
            kind: el.getAttribute('role') || el.tagName.toLowerCase(),
            disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
            selected: el.getAttribute('aria-selected') === 'true' || Boolean(el.getAttribute('aria-current')),
            expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : null
        }));

    const forms = [...document.querySelectorAll('form')].slice(0, 12).map((form) => ({
        el: labelOf(form),
        visible: visible(form),
        label: nameOf(form),
        controls: [...form.querySelectorAll('input:not([type="hidden"]), select, textarea')].slice(0, 30).map((control) => ({
            el: labelOf(control),
            label: nameOf(control),
            type: control.type || control.tagName.toLowerCase(),
            name: control.getAttribute('name'),
            required: control.required,
            disabled: control.disabled
        })),
        submitActions: [...form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])')]
            .map((control) => nameOf(control)).filter(Boolean).slice(0, 10)
    }));

    return {
        headings: [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible).slice(0, 25)
            .map((el) => ({ level: Number(el.tagName[1]), text: nameOf(el) })),
        actions,
        forms,
        dialogs: [...document.querySelectorAll('nui-dialog, dialog, [role="dialog"]')].slice(0, 20).map((el) => ({
            el: labelOf(el),
            label: nameOf(el),
            visible: visible(el),
            modal: el.tagName === 'DIALOG' ? el.open : null
        })),
        feedback: [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live], output')].slice(0, 20).map((el) => ({
            el: labelOf(el),
            visible: visible(el),
            live: el.getAttribute('aria-live') || el.getAttribute('role'),
            text: nameOf(el)
        }))
    };
}

export function collectTier0Metrics(nuiCatalog = []) {
    const vis = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
    };

    const labelOf = (el) => {
        const id = el.getAttribute('id') ? `#${el.getAttribute('id')}` : '';
        const cls = typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
            : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
    };

    const parseRgba = (str) => {
        const m = str && str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return null;
        return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    };

    const relLum = ({ r, g, b }) => {
        const lin = [r, g, b].map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };

    const contrastRatio = (fg, bg) => {
        const l1 = relLum(fg);
        const l2 = relLum(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const resolvedBg = (el) => {
        let cur = el;
        while (cur && cur.nodeType === 1) {
            const bg = parseRgba(getComputedStyle(cur).backgroundColor);
            if (bg && bg.a >= 0.85) return bg;
            cur = cur.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
    };

    const domAll = [...document.querySelectorAll('*')];
    const all = domAll.filter(vis);
    const fontSizes = new Map();
    const colors = new Set();
    const bgs = new Set();
    const tinyText = [];
    const clipped = [];
    const lowContrast = [];
    const badInteractive = [];
    const missingCursor = [];

    for (const el of all) {
        const cs = getComputedStyle(el);
        const fsPx = parseFloat(cs.fontSize);
        const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);

        if (hasOwnText) {
            fontSizes.set(cs.fontSize, (fontSizes.get(cs.fontSize) || 0) + 1);
            colors.add(cs.color);
            if (fsPx < 12 && !el.closest('svg')) {
                tinyText.push({ el: labelOf(el), fontSize: cs.fontSize, text: el.textContent.trim().slice(0, 40) });
            }
            const fg = parseRgba(cs.color);
            if (fg && fg.a >= 0.85) {
                const bg = resolvedBg(el);
                const ratio = contrastRatio(fg, bg);
                const isLarge = fsPx >= 24 || (fsPx >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
                const minRatio = isLarge ? 3.0 : 4.5;
                if (ratio < minRatio) {
                    lowContrast.push({
                        el: labelOf(el),
                        ratio: Number(ratio.toFixed(2)),
                        required: minRatio,
                        text: el.textContent.trim().slice(0, 35)
                    });
                }
            }
        }
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bgs.add(cs.backgroundColor);

        if (
            !el.matches('select, input, textarea, svg, svg *') &&
            el.clientWidth > 0 &&
            el.scrollWidth > el.clientWidth + 2 &&
            cs.overflowX !== 'auto' &&
            cs.overflowX !== 'scroll'
        ) {
            clipped.push({
                el: labelOf(el),
                scrollW: Math.round(el.scrollWidth),
                clientW: Math.round(el.clientWidth),
                text: el.textContent.trim().slice(0, 35)
            });
        }

        if (el.matches('button, a[href], [role="button"], input:not([type="hidden"]), select, textarea')) {
            const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder');
            const text = el.textContent.trim();
            if (!aria && !text) badInteractive.push({ el: labelOf(el), reason: 'missing accessible label' });
            if (el.matches('button, a[href], [role="button"]') && cs.cursor !== 'pointer' && !el.disabled) {
                missingCursor.push({ el: labelOf(el), cursor: cs.cursor });
            }
        }
    }

    // Skip inline elements and intentional absolute/fixed overlays to avoid false positives.
    const overlaps = [];
    for (const parent of all) {
        if (parent.closest('svg')) continue;
        const kids = [...parent.children].filter((k) => {
            if (!vis(k)) return false;
            const cs = getComputedStyle(k);
            return cs.display !== 'inline' && cs.position !== 'absolute' && cs.position !== 'fixed';
        });
        if (kids.length < 2 || kids.length > 40) continue;
        for (let i = 0; i < kids.length; i++) {
            const a = kids[i].getBoundingClientRect();
            for (let j = i + 1; j < kids.length; j++) {
                const b = kids[j].getBoundingClientRect();
                const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
                const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
                if (ix > 2 && iy > 2) {
                    overlaps.push({
                        parent: labelOf(parent),
                        a: labelOf(kids[i]),
                        b: labelOf(kids[j]),
                        ix: Math.round(ix),
                        iy: Math.round(iy)
                    });
                }
            }
        }
    }

    const rowMismatches = [];
    for (const parent of all) {
        const cs = getComputedStyle(parent);
        if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
        if (cs.flexDirection.startsWith('column')) continue;
        const kids = [...parent.children].filter(vis);
        if (kids.length < 2 || kids.length > 12) continue;
        const rects = kids.map((k) => ({ el: labelOf(k), r: k.getBoundingClientRect() }));
        const tops = new Set(rects.map((x) => Math.round(x.r.top / 4) * 4));
        const heights = rects.map((x) => Math.round(x.r.height));
        const minH = Math.min(...heights);
        const maxH = Math.max(...heights);
        if (tops.size > 1 && cs.flexWrap === 'wrap') {
            rowMismatches.push({ parent: labelOf(parent), issue: 'wrapped-controls', rows: tops.size, items: rects.map((x) => `${x.el}(${Math.round(x.r.height)}px)`) });
        } else if (maxH - minH >= 6 && rects.length <= 6) {
            rowMismatches.push({ parent: labelOf(parent), issue: 'height-mismatch', minH, maxH, items: rects.map((x) => `${x.el}(${Math.round(x.r.height)}px)`) });
        }
    }

    const emptyFlowBoxes = [];
    for (const el of all) {
        if (el.matches('[role="alert"], .error, .status, .banner') && !el.textContent.trim() && el.children.length === 0) {
            const cs = getComputedStyle(el);
            if (parseFloat(cs.marginTop) > 0 || parseFloat(cs.marginBottom) > 0 || el.getBoundingClientRect().height > 0) {
                emptyFlowBoxes.push({ el: labelOf(el), marginTop: cs.marginTop, marginBottom: cs.marginBottom });
            }
        }
    }

    const virtualRowIssues = [];
    for (const row of document.querySelectorAll('.nui-list-item')) {
        if (!vis(row)) continue;
        const rowRect = row.getBoundingClientRect();
        for (const child of row.querySelectorAll('*')) {
            if (!vis(child)) continue;
            const cs = getComputedStyle(child);
            if (cs.position === 'absolute' || cs.position === 'fixed') continue;
            const rect = child.getBoundingClientRect();
            const overflowPx = Math.max(rowRect.top - rect.top, rect.bottom - rowRect.bottom);
            if (overflowPx > 1) {
                virtualRowIssues.push({
                    row: labelOf(row),
                    content: labelOf(child),
                    overflowPx: Math.round(overflowPx),
                    text: child.textContent.trim().slice(0, 35)
                });
            }
        }
    }

    const sortedSizes = [...fontSizes.keys()].map((s) => parseFloat(s)).sort((a, b) => a - b);
    const microSteps = [];
    for (let i = 1; i < sortedSizes.length; i++) {
        const diff = Number((sortedSizes[i] - sortedSizes[i - 1]).toFixed(2));
        if (diff > 0 && diff <= 1.5) microSteps.push(`${sortedSizes[i - 1]}px→${sortedSizes[i]}px`);
    }
    const h1 = document.querySelector('h1');
    const h2 = document.querySelector('h2');
    const p = document.querySelector('p');
    const bodySize = p && vis(p) ? parseFloat(getComputedStyle(p).fontSize) : parseFloat(getComputedStyle(document.body).fontSize);
    const headingSize = h1 && vis(h1) ? parseFloat(getComputedStyle(h1).fontSize) : (h2 && vis(h2) ? parseFloat(getComputedStyle(h2).fontSize) : null);
    const headingRatio = headingSize && bodySize ? Number((headingSize / bodySize).toFixed(2)) : null;

    const hasNuiCss = [...document.styleSheets].some((s) => s.href && s.href.includes('nui-theme.css'));
    const nuiTagsUsed = [...new Set(domAll.map((e) => e.tagName.toLowerCase()).filter((t) => t.startsWith('nui-')))];
    const nuiByName = new Map(nuiCatalog.map((entry) => [entry.name, entry]));
    const nuiIssues = [];
    const nuiOpportunities = [];
    const nuiCustomStyles = [];
    const nuiStyleScanWarnings = [];
    if (hasNuiCss || nuiTagsUsed.length > 0) {
        const issue = (rule, elements) => {
            if (!elements.length) return;
            nuiIssues.push({
                rule,
                count: elements.length,
                hiddenCount: elements.filter((e) => !vis(e)).length,
                samples: elements.slice(0, 5).map((e) => `${labelOf(e)}${vis(e) ? '' : ' (hidden)'}`)
            });
        };
        const opportunity = (component, rule, elements, reason) => {
            if (!nuiByName.has(component) || !elements.length) return;
            nuiOpportunities.push({
                component,
                rule,
                reason,
                count: elements.length,
                hiddenCount: elements.filter((e) => !vis(e)).length,
                samples: elements.slice(0, 5).map((e) => `${labelOf(e)}${vis(e) ? '' : ' (hidden)'}`)
            });
        };
        const bareButtons = domAll.filter((e) => e.tagName === 'BUTTON' && !e.closest('nui-button, nui-tabs, nui-list, nui-input, nui-select, nui-code, nui-app-header, nui-dialog'));
        issue('bare-button', bareButtons);
        const bareSelects = domAll.filter((e) => e.tagName === 'SELECT' && !e.closest('nui-select'));
        issue('bare-select', bareSelects);
        const bareTextareas = domAll.filter((e) => e.tagName === 'TEXTAREA' && !e.closest('nui-textarea'));
        issue('bare-textarea', bareTextareas);
        const inputs = domAll.filter((e) => e.tagName === 'INPUT' && e.type !== 'hidden');
        issue('bare-input', inputs.filter((e) => !['checkbox', 'radio', 'range'].includes(e.type) && !e.closest('nui-input')));
        issue('bare-checkbox', inputs.filter((e) => e.type === 'checkbox' && !e.closest('nui-checkbox, nui-input')));
        issue('bare-radio', inputs.filter((e) => e.type === 'radio' && !e.closest('nui-radio, nui-input')));
        issue('bare-range', inputs.filter((e) => e.type === 'range' && !e.closest('nui-slider')));

        const wrongInner = [];
        for (const el of domAll.filter((e) => e.tagName.toLowerCase().startsWith('nui-'))) {
            const entry = nuiByName.get(el.tagName.toLowerCase());
            if (!entry?.innerElement || (el.tagName === 'NUI-DIALOG' && el.getAttribute('mode') === 'page')) continue;
            if (el.tagName === 'NUI-MARKDOWN' && !el.querySelector('script[type="text/markdown"]') && el.children.length) continue;
            const expected = [...entry.innerElement.matchAll(/<([a-z][\w-]*)\b/gi)].map((match) => match[1].toLowerCase());
            if (expected.length && !expected.some((tag) => el.querySelector(tag))) {
                wrongInner.push({ el, expected: [...new Set(expected)] });
            }
        }
        if (wrongInner.length) {
            nuiIssues.push({
                rule: 'invalid-inner-element',
                count: wrongInner.length,
                hiddenCount: wrongInner.filter(({ el }) => !vis(el)).length,
                samples: wrongInner.slice(0, 5).map(({ el, expected }) => `${labelOf(el)} expects ${expected.map((tag) => `<${tag}>`).join(' or ')}`)
            });
        }
        issue('checkable-missing-label', domAll.filter((e) => ['NUI-CHECKBOX', 'NUI-RADIO'].includes(e.tagName) && !e.querySelector(':scope > label')));
        issue('native-attribute-on-wrapper', domAll.filter((e) => ['NUI-INPUT', 'NUI-TEXTAREA', 'NUI-CHECKBOX', 'NUI-RADIO'].includes(e.tagName)
            && ['required', 'name', 'value', 'minlength', 'pattern'].some((attr) => e.hasAttribute(attr))));
        issue('dialog-page-mode-native-dialog', domAll.filter((e) => e.tagName === 'NUI-DIALOG' && e.getAttribute('mode') === 'page' && e.querySelector('dialog')));
        issue('tabs-structure', domAll.filter((e) => e.tagName === 'NUI-TABS'
            && (!e.querySelector('nav') || !e.querySelector('nav button, nav a') || !e.querySelector('section, div, [role="tabpanel"]'))));
        issue('table-structure', domAll.filter((e) => e.tagName === 'NUI-TABLE'
            && e.querySelector('table') && (!e.querySelector('thead') || !e.querySelector('tbody'))));
        issue('main-outside-content', domAll.filter((e) => e.tagName === 'NUI-MAIN' && !e.closest('nui-content')));

        const nuiStyleTargets = new Set();
        const knownInner = {
            'nui-textarea': ['textarea'],
            'nui-checkbox': ['input'],
            'nui-radio': ['input'],
            'nui-input-group': ['input', 'select', 'textarea'],
            'nui-button-container': ['button', 'a']
        };
        for (const wrapper of domAll.filter((e) => e.tagName.toLowerCase().startsWith('nui-'))) {
            nuiStyleTargets.add(wrapper);
            const entry = nuiByName.get(wrapper.tagName.toLowerCase());
            const expected = entry?.innerElement
                ? [...entry.innerElement.matchAll(/<([a-z][\w-]*)\b/gi)].map((match) => match[1].toLowerCase())
                : (knownInner[wrapper.tagName.toLowerCase()] || []);
            for (const tag of new Set(expected)) {
                for (const inner of wrapper.querySelectorAll(tag)) nuiStyleTargets.add(inner);
            }
        }
        const recordCustomStyle = (source, el, selector, style, sheet = null) => {
            const properties = [];
            for (let i = 0; i < style.length; i++) {
                const property = style[i];
                if (property.startsWith('--')) continue;
                properties.push(`${property}: ${style.getPropertyValue(property)}${style.getPropertyPriority(property) ? ' !important' : ''}`);
            }
            if (!properties.length) return;
            nuiCustomStyles.push({
                source,
                el: labelOf(el),
                selector: selector || null,
                sheet,
                properties
            });
        };
        for (const el of nuiStyleTargets) {
            if (el.hasAttribute('style')) recordCustomStyle('inline', el, null, el.style);
        }
        const isNuiStylesheet = (href) => href && (/[\\/]nui-theme\.css(?:[?#]|$)/i.test(href) || /[\\/]nui[\\/]css[\\/]/i.test(href) || /[\\/]nui_wc2[\\/]/i.test(href));
        const scanCssRules = (rules, sheet) => {
            for (const rule of rules) {
                if (rule.href && isNuiStylesheet(rule.href)) continue;
                if (rule.selectorText && rule.style) {
                    let matches;
                    try {
                        matches = document.querySelectorAll(rule.selectorText);
                    } catch (err) {
                        nuiStyleScanWarnings.push({ selector: rule.selectorText, error: err.message });
                        continue;
                    }
                    for (const el of matches) {
                        if (nuiStyleTargets.has(el)) recordCustomStyle('stylesheet', el, rule.selectorText, rule.style, sheet);
                    }
                } else if (rule.cssRules) {
                    scanCssRules(rule.cssRules, sheet);
                }
            }
        };
        for (const sheet of document.styleSheets) {
            if (isNuiStylesheet(sheet.href)) continue;
            const sheetName = sheet.href || 'inline <style>';
            try {
                scanCssRules(sheet.cssRules, sheetName);
            } catch (err) {
                nuiStyleScanWarnings.push({ sheet: sheetName, error: err.message });
            }
        }
        if (nuiCustomStyles.length) {
            nuiIssues.push({
                rule: 'custom-nui-styling',
                count: nuiCustomStyles.length,
                samples: nuiCustomStyles.slice(0, 5).map((item) => `${item.el} (${item.source}: ${item.properties.join('; ')})`)
            });
        }

        opportunity('nui-dialog', 'native-dialog', domAll.filter((e) => e.tagName === 'DIALOG' && !e.closest('nui-dialog, nui-overlay')),
            'A native dialog can use the documented NUI dialog wrapper for animation and consistent overlay behavior.');
        opportunity('nui-details', 'native-details', domAll.filter((e) => e.tagName === 'DETAILS' && !e.closest('nui-details, nui-accordion')),
            'A native disclosure can use NUI details; related disclosures may instead belong in NUI accordion.');
        opportunity('nui-code', 'native-code', domAll.filter((e) => e.tagName === 'PRE' && e.querySelector('code') && !e.closest('nui-code, nui-markdown')),
            'A native code block can use NUI code for documented highlighting and presentation.');
        opportunity('nui-tabs', 'native-tablist', domAll.filter((e) => e.getAttribute('role') === 'tablist' && !e.closest('nui-tabs')),
            'An ARIA tablist can use the documented NUI tabs structure and keyboard behavior.');
        opportunity('nui-table', 'native-table', domAll.filter((e) => e.tagName === 'TABLE' && !e.closest('nui-table, nui-markdown, nui-code')),
            'A data table can use NUI table for its documented responsive layout.');
        opportunity('nui-progress', 'native-progress', domAll.filter((e) => e.tagName === 'PROGRESS'),
            'A native progress element can use NUI progress for consistent status feedback.');
        opportunity('nui-media-player', 'native-media', domAll.filter((e) => ['VIDEO', 'AUDIO'].includes(e.tagName) && !e.closest('nui-media-player')),
            'Native media can use the NUI media player when the documented controls fit the workflow.');

        if (hasNuiCss && !document.querySelector('nui-app, nui-main, nui-page')) {
            nuiIssues.push({ rule: 'missing-nui-shell', count: 1, samples: ['no <nui-app>, <nui-main>, or <nui-page> found'] });
        }
    }

    const svgIssues = [];
    for (const svg of document.querySelectorAll('svg')) {
        if (!vis(svg)) continue;
        const sr = svg.getBoundingClientRect();
        if (sr.width < 24 && sr.height < 24) continue;
        const texts = [...svg.querySelectorAll('text')].filter(vis);
        const textOverlaps = [];
        const clippedTexts = [];
        const tinySvgText = [];

        for (let i = 0; i < texts.length; i++) {
            const tr = texts[i].getBoundingClientRect();
            const fs = parseFloat(getComputedStyle(texts[i]).fontSize);
            if (fs < 9) tinySvgText.push({ text: texts[i].textContent.trim().slice(0, 25), fontSize: `${fs}px` });
            if (tr.left < sr.left - 1 || tr.right > sr.right + 1 || tr.top < sr.top - 1 || tr.bottom > sr.bottom + 1) {
                clippedTexts.push({ text: texts[i].textContent.trim().slice(0, 25) });
            }
            for (let j = i + 1; j < texts.length; j++) {
                const tr2 = texts[j].getBoundingClientRect();
                const ix = Math.max(0, Math.min(tr.right, tr2.right) - Math.max(tr.left, tr2.left));
                const iy = Math.max(0, Math.min(tr.bottom, tr2.bottom) - Math.max(tr.top, tr2.top));
                if (ix > 1 && iy > 1) {
                    textOverlaps.push({
                        a: texts[i].textContent.trim().slice(0, 20),
                        b: texts[j].textContent.trim().slice(0, 20),
                        ix: Math.round(ix),
                        iy: Math.round(iy)
                    });
                }
            }
        }
        if (textOverlaps.length || clippedTexts.length || tinySvgText.length) {
            svgIssues.push({
                svg: labelOf(svg),
                size: `${Math.round(sr.width)}x${Math.round(sr.height)}`,
                textCount: texts.length,
                textOverlaps: textOverlaps.slice(0, 8),
                clippedTexts: clippedTexts.slice(0, 8),
                tinySvgText: tinySvgText.slice(0, 8)
            });
        }
    }

    return {
        viewport: {
            w: window.innerWidth,
            h: window.innerHeight,
            scrollW: document.documentElement.scrollWidth,
            scrollH: document.documentElement.scrollHeight,
            horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1
        },
        typography: {
            distinctSizes: sortedSizes.map((s) => `${s}px`),
            microSteps,
            headingRatio,
            tinyText: tinyText.slice(0, 8)
        },
        color: {
            uniqueTextColors: colors.size,
            uniqueBgColors: bgs.size,
            lowContrast: lowContrast.slice(0, 8)
        },
        layout: {
            clipped: clipped.slice(0, 8),
            overlaps: overlaps.slice(0, 8),
            rowMismatches: rowMismatches.slice(0, 8),
            emptyFlowBoxes: emptyFlowBoxes.slice(0, 5),
            virtualRowIssues: virtualRowIssues.slice(0, 8)
        },
        ux: {
            badInteractive: badInteractive.slice(0, 8),
            missingCursor: missingCursor.slice(0, 8)
        },
        nui: {
            active: hasNuiCss || nuiTagsUsed.length > 0,
            catalogCount: nuiCatalog.length,
            tagsUsed: nuiTagsUsed,
            unknownTags: nuiTagsUsed.filter((tag) => !nuiByName.has(tag)),
            issues: nuiIssues,
            opportunities: nuiOpportunities,
            customStyles: nuiCustomStyles.slice(0, 20),
            styleScanWarnings: nuiStyleScanWarnings.slice(0, 10)
        },
        svg: svgIssues.slice(0, 5)
    };
}
