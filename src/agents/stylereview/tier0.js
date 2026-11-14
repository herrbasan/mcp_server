// Tier-0 deterministic DOM, SVG, NUI-conformance, and taste-proxy extractor.
// Runs inside page.evaluate() in headless Chromium; returns structured facts only.

export function collectTier0Metrics() {
    const vis = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
    };

    const labelOf = (el) => {
        const id = el.id ? `#${el.id}` : '';
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

    const all = [...document.querySelectorAll('*')].filter(vis);
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
    const nuiTagsUsed = [...new Set(all.map((e) => e.tagName.toLowerCase()).filter((t) => t.startsWith('nui-')))];
    const nuiIssues = [];
    if (hasNuiCss || nuiTagsUsed.length > 0) {
        const bareButtons = all.filter((e) => e.tagName === 'BUTTON' && !e.closest('nui-button, nui-select, nui-code, nui-app-header, nui-dialog'));
        if (bareButtons.length) {
            nuiIssues.push({ rule: 'bare-button', count: bareButtons.length, samples: bareButtons.slice(0, 5).map(labelOf) });
        }
        const bareSelects = all.filter((e) => e.tagName === 'SELECT' && !e.closest('nui-select'));
        if (bareSelects.length) {
            nuiIssues.push({ rule: 'bare-select', count: bareSelects.length, samples: bareSelects.slice(0, 5).map(labelOf) });
        }
        const bareInputs = all.filter((e) => e.tagName === 'INPUT' && !e.closest('nui-input, nui-checkbox, nui-radio, nui-slider'));
        if (bareInputs.length) {
            nuiIssues.push({ rule: 'bare-input', count: bareInputs.length, samples: bareInputs.slice(0, 5).map(labelOf) });
        }
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
            emptyFlowBoxes: emptyFlowBoxes.slice(0, 5)
        },
        ux: {
            badInteractive: badInteractive.slice(0, 8),
            missingCursor: missingCursor.slice(0, 8)
        },
        nui: {
            active: hasNuiCss || nuiTagsUsed.length > 0,
            tagsUsed: nuiTagsUsed,
            issues: nuiIssues
        },
        svg: svgIssues.slice(0, 5)
    };
}
