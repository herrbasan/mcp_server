// Self-contained contact-sheet generator for the chart agent. Every combination
// (chart type x visual style x light/dark) is rendered through the real renderer
// and audited; a broken style on any type fails loudly rather than shipping a
// silent black box. Returns { svg, pngBase64?, file?, preview?, combinations, failures }.

import fs from 'node:fs';
import path from 'node:path';
import { render, audit, check, variantSvg } from '../../nCharts/src/index.js';

const STYLES = ['instrument', 'print', 'neo', 'card', 'minimal'];

// One small but representative spec per chart type. Deliberately short — this
// sheet exists to show the *look*, not to stress-test layout. Chromeless by
// design; the sheet adds its own labels.
const CASES = [
  ['flow', {
    type: 'flow',
    nodes: [
      { id: 'a', label: 'Client', kind: 'start' },
      { id: 'b', label: 'Gateway', metric: '12ms', accent: true },
      { id: 'c', label: 'Provider', metric: '240ms' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  }],
  ['sequence', {
    type: 'sequence',
    actors: [{ id: 'c', label: 'Client' }, { id: 'g', label: 'Gateway', accent: true }, { id: 'u', label: 'Upstream' }],
    messages: [
      { from: 'c', to: 'g', label: 'POST /chat', number: 1 },
      { from: 'g', to: 'u', label: 'forward', number: 2 },
      { on: 'g', callout: 'headers withheld', tone: 'amber' },
      { from: 'g', to: 'c', label: '502 error', style: 'return', accent: true },
    ],
  }],
  ['waffle', {
    type: 'waffle',
    series: [
      { label: 'Cached', value: 78, detail: '19% bill', tone: 'green' },
      { label: 'Fresh', value: 14, detail: '28% bill', tone: 'amber' },
      { label: 'Output', value: 8, detail: '53% bill', tone: 'blue' },
    ],
  }],
  ['dumbbell', {
    type: 'dumbbell',
    unit: 'credits',
    fromLabel: 'No cache',
    toLabel: '95% hit',
    series: [
      { label: 'GLM-5.3', from: 6.9, to: 1.96, delta: '-72%', accent: true },
      { label: 'Argon', from: 4.5, to: 1.1, delta: '-76%' },
      { label: 'DeepSeek', from: 3.4, to: 1.4, delta: '-59%' },
    ],
  }],
  ['waterfall', {
    type: 'waterfall',
    unit: 'K',
    steps: [
      { label: 'Window', kind: 'total', value: 1000 },
      { label: 'System', value: -120 },
      { label: 'History', value: -480 },
      { label: 'Headroom', kind: 'total' },
    ],
  }],
  ['scatter', {
    type: 'scatter',
    x: { label: 'Cost ($)', min: 0, max: 20 },
    y: { label: 'Score', min: 60, max: 100 },
    zone: { quadrant: 'top-left', label: 'Sweet spot', tone: 'blue' },
    points: [
      { label: 'Argon', x: 4, y: 89, size: 1000, accent: true, invert: true },
      { label: 'DeepSeek', x: 1.5, y: 84, size: 1000, accent: true },
      { label: 'Local', x: 0.5, y: 66, tone: 'green' },
      { label: 'Neon', x: 15, y: 93, size: 1000 },
      { label: 'Opus', x: 18.5, y: 96 },
    ],
  }],
  ['bump', {
    type: 'bump',
    stages: ['V3', 'V3.5', 'V4'],
    series: [
      { label: 'Opus', ranks: [1, 2, 2] },
      { label: 'Sonnet', ranks: [2, 3, 3] },
      { label: 'Argon', ranks: [3, 1, 1], accent: true },
    ],
  }],
  ['slope', {
    type: 'slope',
    columns: ['No cache', '95% hit'],
    series: [
      { label: 'GLM-5.3', from: 6.9, to: 1.96, delta: '-72%', accent: true },
      { label: 'Argon', from: 4.5, to: 1.1 },
      { label: 'DeepSeek', from: 3.4, to: 1.4 },
      { label: 'Flash', from: 2.3, to: 0.65 },
    ],
  }],
  ['sankey', {
    type: 'sankey',
    nodes: [
      { id: 'in', label: 'Input', detail: '92%' },
      { id: 'out', label: 'Output', detail: '8%', accent: true },
      { id: 'c', label: 'Cached', tone: 'green' },
      { id: 'f', label: 'Fresh', tone: 'amber' },
      { id: 'g', label: 'Thinking', accent: true },
    ],
    flows: [
      { from: 'in', to: 'c', value: 78 },
      { from: 'in', to: 'f', value: 14 },
      { from: 'out', to: 'g', value: 8 },
    ],
  }],
  ['spectrum', {
    type: 'spectrum',
    ends: ['Human decides', 'Agent autonomous'],
    markers: [
      { at: 0.12, label: 'Money & Prod' },
      { at: 0.38, label: 'Architecture' },
      { at: 0.66, label: 'First E2E', accent: true },
      { at: 0.88, label: 'Refactors' },
    ],
  }],
  ['venn', {
    type: 'venn',
    overlap: 'Shared',
    overlapDetail: 'Files & Git',
    sets: [
      { label: 'Workshop', detail: 'Memory', tone: 'blue' },
      { label: 'VS Code', detail: 'Editor', tone: 'green' },
    ],
  }],
  ['concentric', {
    type: 'concentric',
    rings: [
      { label: 'External APIs' },
      { label: 'Adapters', tone: 'blue' },
      { label: 'Pure Core', tone: 'blue', invert: true },
    ],
  }],
  ['bars', {
    type: 'bars',
    unit: '%',
    max: 100,
    series: [
      { label: 'Cached', value: 78, tone: 'green' },
      { label: 'Fresh', value: 14, tone: 'amber' },
      { label: 'Output', value: 8, tone: 'blue' },
    ],
  }],
  ['steps', {
    type: 'steps',
    ramp: 'cool',
    shape: 'slant',
    nodes: [
      { label: 'Ingest' }, { label: 'Layout' }, { label: 'Audit' }, { label: 'Emit' },
    ],
  }],
  ['cycle', {
    type: 'cycle',
    centre: 'Feedback',
    ramp: 'cool',
    nodes: [{ label: 'Inspect' }, { label: 'Edit' }, { label: 'Verify' }, { label: 'Store' }],
  }],
  ['stack', {
    type: 'stack',
    taper: 'narrow',
    nodes: [
      { label: '200 Candidates' },
      { label: '12 Shortlist', tone: 'blue' },
      { label: '3 Answers', tone: 'green', invert: true },
    ],
  }],
  ['timeline', {
    type: 'timeline',
    nodes: [
      { id: 'a', when: 'Oct 19', label: 'v0.1' },
      { id: 'b', when: 'Oct 21', label: 'Sketch' },
      { id: 'c', when: 'Nov 12', label: 'Board' },
      { id: 'd', when: 'Nov 26', label: '23 types', accent: true },
    ],
  }],
  ['tree', {
    type: 'tree',
    nodes: [
      { id: 'r', label: 'Gateway', accent: true },
      { id: 'a', label: 'OpenAI' },
      { id: 'b', label: 'Anthropic' },
      { id: 'c', label: 'Gemini' },
    ],
    edges: [{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }, { from: 'r', to: 'c' }],
  }],
  ['list', {
    type: 'list',
    columns: 2,
    nodes: [
      { label: 'Zero coordinates', detail: 'Meaning in, geometry out' },
      { label: 'Dual-theme SVG', detail: 'Light + dark in one file' },
      { label: 'Deterministic audit', detail: 'Overlaps fail loudly' },
      { label: 'Zero dependencies', detail: 'Pure Node ESM' },
    ],
  }],
  ['table', {
    type: 'table',
    header: ['Style', 'Look', 'Best for'],
    rows: [
      ['instrument', 'Hardware panel', 'Systems'],
      ['print', 'Serif + hatch', 'Editorial'],
      ['neo', 'Bold + shadow', 'Slides & video'],
      ['card', 'Rounded cards', 'General'],
      ['minimal', 'Text only', 'Inline prose'],
    ],
    emphasise: [[0, 0]],
  }],
  ['matrix', {
    type: 'matrix',
    x: ['Low effort', 'High effort'],
    y: ['Low impact', 'High impact'],
    quadrants: [
      { label: 'Quick Wins', tone: 'green', invert: true },
      { label: 'Big Bets', tone: 'blue' },
      { label: 'Fill-ins' },
      { label: 'Avoid', tone: 'red' },
    ],
  }],
  ['board', {
    type: 'board',
    nodes: [
      { id: 'ui', label: 'Client', detail: 'Browser' },
      { id: 'gw', label: 'Gateway', accent: true },
    ],
    layout: {
      kind: 'row', gap: 64, align: 'center',
      children: [
        { kind: 'node', id: 'ui' },
        { kind: 'group', id: 'mcp', label: 'MCP', tone: 'blue', style: 'panel', items: ['Memory', 'nCharts', 'Forge'], children: [] },
        { kind: 'node', id: 'gw' },
      ],
    },
    edges: [{ from: 'ui', to: 'mcp' }, { from: 'mcp', to: 'gw' }],
  }],
  ['custom', {
    type: 'custom',
    nodes: [
      { id: 'r', label: 'Router', accent: true },
      { id: 'p', label: 'Primary', tone: 'green' },
      { id: 'f', label: 'Fallback' },
    ],
    layout: {
      kind: 'row', gap: 56, align: 'center',
      children: [
        { kind: 'node', id: 'r' },
        { kind: 'column', gap: 16, children: [{ kind: 'node', id: 'p' }, { kind: 'node', id: 'f' }] },
      ],
    },
    edges: [{ from: 'r', to: 'p', label: 'default' }, { from: 'r', to: 'f', label: 'on fail', style: 'dashed' }],
  }],
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Compose the 23 mini-SVGs into one big sheet SVG using nested <svg viewBox> tiles.
// No rasterization of children — the whole sheet stays a single crisp vector file.
function composeSheet(tiles, { cols, tileW, tileH, pad, headerH, labelH, title, subtitle, theme }) {
  const rows = Math.ceil(tiles.length / cols);
  const W = pad * 2 + cols * tileW + (cols - 1) * pad;
  const H = headerH + rows * (tileH + labelH + pad) + pad;
  const dark = theme === 'dark';
  const bg = dark ? '#0f1115' : '#f4f5f7';
  const cardBg = dark ? '#17191e' : '#ffffff';
  const line = dark ? '#2b2f38' : '#dde1e8';
  const fg = dark ? '#e8eaed' : '#20242b';
  const muted = dark ? '#98a0ad' : '#5c6470';

  const parts = [];
  parts.push(`<rect width="${W}" height="${H}" fill="${bg}"/>`);
  parts.push(`<text x="${pad}" y="${pad + 14}" font-family="Inter,'Segoe UI',sans-serif" font-size="22" font-weight="700" fill="${fg}">${esc(title)}</text>`);
  parts.push(`<text x="${pad}" y="${pad + 36}" font-family="Inter,'Segoe UI',sans-serif" font-size="12.5" fill="${muted}">${esc(subtitle)}</text>`);

  tiles.forEach((t, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (tileW + pad);
    const y = headerH + row * (tileH + labelH + pad);

    parts.push(`<rect x="${x}" y="${y}" width="${tileW}" height="${tileH + labelH}" rx="6" fill="${cardBg}" stroke="${line}" stroke-width="1"/>`);
    parts.push(`<text x="${x + 12}" y="${y + tileH + 16}" font-family="Consolas,monospace" font-size="12" font-weight="700" fill="${fg}">${esc(t.type)}</text>`);
    parts.push(`<text x="${x + tileW - 12}" y="${y + tileH + 16}" text-anchor="end" font-family="Inter,sans-serif" font-size="11" fill="${muted}">${esc(t.style)}</text>`);
    // Nested SVG: child keeps its own viewBox and scales to fit the tile.
    parts.push(`<svg x="${x + 8}" y="${y + 6}" width="${tileW - 16}" height="${tileH - 12}" viewBox="0 0 ${t.width} ${t.height}" preserveAspectRatio="xMidYMid meet">${t.inner}</svg>`);
  });

  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('\n')}</svg>`, width: W, height: H };
}

export function buildShowcase({ style, theme = 'dark', types } = {}) {
  const wanted = types?.length ? types : CASES.map(([t]) => t);
  const byType = new Map(CASES);
  const selected = wanted.map((t) => {
    if (!byType.has(t)) throw new Error(`chart_showcase: unknown type "${t}" (use ${CASES.map(([k]) => k).join(', ')})`);
    return [t, byType.get(t)];
  });
  const styles = style ? [style] : STYLES;
  if (style && !STYLES.includes(style)) {
    throw new Error(`chart_showcase: style must be one of ${STYLES.join(', ')}`);
  }

  const tiles = [];
  const failures = [];
  for (const [type, baseSpec] of selected) {
    for (const st of styles) {
      const spec = { ...baseSpec, style: st };
      const a = audit(spec);
      const svg = render(spec);
      const c = check(svg);
      if (!a.ok || !c.ok) {
        failures.push(`${type}[${st}]: ${[...a.errors, ...c.errors].join('; ')}`);
        continue;
      }
      const themed = variantSvg(svg, theme);
      const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(themed);
      const inner = themed.slice(themed.indexOf('>') + 1, themed.lastIndexOf('</svg>'));
      tiles.push({ type, style: st, width: Number(m[1]), height: Number(m[2]), inner });
    }
  }
  if (failures.length) throw new Error(`chart_showcase: renderer failures — ${failures.join(' | ')}`);

  const tileW = 360;
  const tileH = 230;
  const sheet = composeSheet(tiles, {
    cols: Math.min(4, Math.max(2, Math.ceil(Math.sqrt(tiles.length)))),
    tileW,
    tileH,
    pad: 18,
    headerH: 64,
    labelH: 26,
    title: style ? `nCharts — ${selected.length} type${selected.length > 1 ? 's' : ''} · style: ${style} · ${theme}` : `nCharts — ${selected.length} types × ${styles.length} styles · ${theme}`,
    subtitle: 'Live renderer output · audit + static check passed on every tile · light and dark in each SVG',
    theme,
  });

  return { ...sheet, combinations: tiles.length, tiles };
}

export async function chart_showcase(args, { storageRoot, chartDir, nmediaProcess, previewSize }) {
  const theme = args?.theme === 'light' ? 'light' : 'dark';
  const { svg, width, height, combinations } = buildShowcase({
    style: args?.style,
    theme,
    types: args?.types,
  });

  const stamp = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `showcase_${stamp.getFullYear()}${p(stamp.getMonth() + 1)}${p(stamp.getDate())}_${p(stamp.getHours())}${p(stamp.getMinutes())}_${args?.style ?? 'all'}`;
  const svgPath = path.join(storageRoot, chartDir, `${base}.svg`);
  fs.writeFileSync(svgPath, svg, 'utf8');
  const rel = (f) => path.relative(storageRoot, f).split(path.sep).join('/');

  const lines = [
    `${base}`,
    `  svg      ${rel(svgPath)}`,
    `  canvas   ${width}x${height}`,
    `  tiles    ${combinations} live combinations (all audit + static checked)`,
  ];

  let png = null;
  if (args?.preview !== false) {
    try {
      const raster = await nmediaProcess(Buffer.from(svg, 'utf8').toString('base64'), {
        format: 'png',
        maxDimension: Math.max(previewSize * 2, width),
      });
      png = raster.buf;
      const previewPath = path.join(storageRoot, chartDir, `${base}_preview.png`);
      fs.writeFileSync(previewPath, png);
      lines.push(`  preview  ${rel(previewPath)}`);
    } catch (err) {
      lines.push(`  preview  FAILED — ${err.message}`);
    }
  }

  lines.push('', 'Open the .svg in a browser or share it — every tile is real renderer output, not a mockup.');
  const content = [{ type: 'text', text: lines.join('\n') }];
  if (png) content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  return { content, isError: false };
}
