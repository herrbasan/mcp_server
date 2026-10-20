// Line styles on a locked hand-drawn base.
// Locked: one strong pass at 2.8, one faint retrace at 1.0 / opacity 0.3, both
// The wobble is in the wire's geometry; a scale-2 field adds to it where filters
// run (two seeds, or the copies stack).
// Open question: solid, dashed, dotted — and how to keep a dashed line from
// looking mechanical while the solid one looks drawn.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TONES, HUE_NAMES } from '../../src/nCharts/src/tokens.js';

const OUT = 'D:\\MCP_Storage\\temp\\sketch-lab';

const LOCK = {
  // One weight for everything, so a card edge and a wire are the same mark.
  // `weights.strong` exists for emphasis only; nothing uses it by default.
  strong: 1.8,
  faint: 0.65,
  faintOpacity: 0.3,
  displacement: 4,
  lineDisplacement: 2,
  widgetWobble: { amp: 1.5, seg: 36 },
  weights: { normal: 1.8, strong: 2.8 },
  // fill: a solid tone fill, a border-coloured ghost behind it, and a tint of the
  // border over the fill. The tint must stay well below the stroke or the box loses
  // its edge — that is the whole point of the pair.
  tint: { light: 0.3, dark: 0.24 },
  ghost: 0.16,
  ghostOffset: { dx: 7, dy: 5 },
  dash: { dashed: '16 5', dotted: '0 4' },
};

const DUAL = {
  light: { bg: 'rgb(251,248,241)', ink: 'rgb(46,43,39)', dim: 'rgb(122,115,105)', tint: 'rgb(232,240,251)' },
  dark: { bg: 'rgb(26,24,22)', ink: 'rgb(232,226,216)', dim: 'rgb(150,142,132)', tint: 'rgb(38,46,62)' },
};

const dualCss = () => `.s-ink{stroke:${DUAL.light.ink};fill:none}
.f-tint{fill:${DUAL.light.tint}}
.t-ink{fill:${DUAL.light.ink}}
.t-dim{fill:${DUAL.light.dim}}
.bg{fill:${DUAL.light.bg}}
@media (prefers-color-scheme: dark){
.s-ink{stroke:${DUAL.dark.ink};fill:none}
.f-tint{fill:${DUAL.dark.tint}}
.t-ink{fill:${DUAL.dark.ink}}
.t-dim{fill:${DUAL.dark.dim}}
.bg{fill:${DUAL.dark.bg}}
}`;

const n = (v) => String(Math.round(v * 100) / 100);

const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const rnd = (key) => {
  let a = hash32(key);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const doc = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${body}
</svg>`;

// filterUnits=userSpaceOnUse: a straight line has a zero-height bbox, and an
// objectBoundingBox filter region would then be zero-high and clip the stroke.
// Quadratic-through-midpoints, so the wobble reads as a pen rather than a polyline.
const smoothPath = (pts) => {
  if (pts.length < 3) return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ');
  let out = `M${n(pts[0][0])} ${n(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    out += ` Q${n(pts[i][0])} ${n(pts[i][1])} ${n(mx)} ${n(my)}`;
  }
  const last = pts[pts.length - 1];
  return `${out} L${n(last[0])} ${n(last[1])}`;
};

// The wire's own geometry carries the hand, so a renderer that drops the filter
// still draws a wobbled line. The filter is the bonus, not the mechanism.
const roughLine = (x1, y1, x2, y2, key, { amp = 1.5, seg = 36 } = {}) => {
  const r = rnd(key);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const steps = Math.max(2, Math.round(len / seg));
  const pts = [[x1, y1]];
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const off = (r() - 0.5) * 2 * amp;
    pts.push([x1 + ux * len * t - uy * off, y1 + uy * len * t + ux * off]);
  }
  pts.push([x2, y2]);
  return smoothPath(pts);
};

const filters = (w, h) => `<defs>
${[
  ['ink', 3, LOCK.displacement],
  ['ink2', 11, LOCK.displacement],
  ['ln', 3, LOCK.lineDisplacement],
  ['lnf', 11, LOCK.lineDisplacement],
]
  .map(
    ([id, seed, scale]) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.01 0.012" numOctaves="3" seed="${seed}" result="t"/>
<feDisplacementMap in="SourceGraphic" in2="t" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
</filter>`,
  )
  .join('\n')}
</defs>`;

// Dashes drawn as separate strokes: lengths and gaps vary, and each dash sits a
// little off the axis. A uniform stroke-dasharray cannot do either.
const drawnDashes = (x1, y1, x2, y2, key) => {
  const r = rnd(key);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const out = [];
  let t = 0;
  while (t < len - 4) {
    const dash = 10 + r() * 12;
    const gap = 5 + r() * 6;
    const a = t;
    const b = Math.min(t + dash, len);
    const off = (r() - 0.5) * 1.8;
    out.push(
      `M${n(x1 + ux * a - uy * off)} ${n(y1 + uy * a + ux * off)} L${n(x1 + ux * b - uy * off)} ${n(y1 + uy * b + ux * off)}`,
    );
    t = b + gap;
  }
  return out.join(' ');
};

const STYLES = {
  solid: { label: 'solid · locked' },
  dashed: { label: `dashed · locked, ${LOCK.dash.dashed.split(' ').join(' / ')}`, dash: LOCK.dash.dashed },
  dotted: { label: `dotted · locked, round caps, ${LOCK.dash.dotted.split(' ').join(' / ')}`, dash: LOCK.dash.dotted, cap: 'round' },
};

const dashAttr = (s) =>
  `${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}${s.cap ? ` stroke-linecap="${s.cap}"` : ''}`;

// One pass of a styled line. The faint pass is drawn first so the strong one lands
// on top; both carry the same dash pattern, or the retrace would fill the gaps.
const pass = (x1, y1, x2, y2, style, key, faint) => {
  const w = faint ? LOCK.faint : LOCK.strong;
  const o = faint ? LOCK.faintOpacity : 1;
  const f = faint ? 'lnf' : 'ln';
  const d = roughLine(x1, y1, x2, y2, `${key}:${faint ? 'f' : 's'}`, {
    amp: faint ? 1.1 : LOCK.widgetWobble.amp,
    seg: LOCK.widgetWobble.seg,
  });
  return `<path class="s-ink" d="${d}" stroke-width="${w}" opacity="${o}"${dashAttr(style)} filter="url(#${f})"/>`;
};

const line = (x1, y1, x2, y2, style, key) =>
  `${pass(x1, y1, x2, y2, style, key, true)}\n${pass(x1, y1, x2, y2, style, key, false)}`;

const label = (x, y, txt) => `<text x="${x}" y="${y}" class="t-dim" font-size="13">${txt}</text>`;

// ------------------------------------------------------------------------- sheet
mkdirSync(OUT, { recursive: true });

{
  const W = 760;
  const H = 410;
  const keys = Object.keys(STYLES);
  const rows = keys
    .map((k, i) => {
      const y = 92 + i * 62;
      return `${label(40, y - 16, STYLES[k].label)}
${line(40, y, 720, y, STYLES[k], k)}`;
    })
    .join('\n');

  const box = `
${label(40, 300, 'in context: a dashed box, a dotted arrow, a solid frame')}
<rect class="s-ink" fill="none" x="40" y="316" width="220" height="56" rx="3" stroke-width="${LOCK.faint}" opacity="${LOCK.faintOpacity}" stroke-dasharray="${STYLES.dashed.dash}" filter="url(#ink2)"/>
<rect class="s-ink f-tint" fill="none" x="40" y="316" width="220" height="56" rx="3" stroke-width="${LOCK.strong}" stroke-dasharray="${STYLES.dashed.dash}" filter="url(#ink)"/>
<text x="150" y="350" text-anchor="middle" class="t-ink" font-size="15">dashed box</text>
${line(292, 344, 600, 344, STYLES.dotted, 'ctx-dot')}
<path class="s-ink" fill="none" d="M588 336 L600 344 L588 352" stroke-width="${LOCK.strong}" filter="url(#ink)"/>
<path class="s-ink" fill="none" d="M589 337 L599 344 L589 351" stroke-width="${LOCK.faint}" opacity="${LOCK.faintOpacity}" filter="url(#ink2)"/>
<rect class="s-ink" fill="none" x="620" y="316" width="100" height="56" rx="3" stroke-width="${LOCK.strong}" filter="url(#ink)"/>`;

  writeFileSync(
    join(OUT, '11-line-styles.svg'),
    doc(
      W,
      H,
      `${filters(W, H)}
<style>${dualCss()}
text{font-family:Inter,"Segoe UI",sans-serif}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text x="40" y="40" class="t-ink" font-size="16">11 · the locked set — solid, dashed ${LOCK.dash.dashed.split(' ').join(' / ')}, dotted ${LOCK.dash.dotted.split(' ').join(' / ')}</text>
${rows}
${box}`,
    ),
    'utf8',
  );
}

// ------------------------------------------------------------------ 12 · fills
// Watercolour instead of a flat tint: two rough shapes that only approximate the
// box, each semi-transparent, offset from each other. Where they cross, multiply
// darkens the pigment. The soft edge is a blur inside the same filter that
// displaces the outline, so the wash bleeds rather than sits on a vector edge.
const WASH = {
  light: { blue: 'rgb(96,141,203)', green: 'rgb(104,160,116)', amber: 'rgb(203,159,74)' },
  dark: { blue: 'rgb(138,174,232)', green: 'rgb(136,190,148)', amber: 'rgb(226,186,110)' },
};

const washCss = () => `${Object.entries(WASH.light)
  .map(([k, v]) => `.wc-${k}{fill:${v}}`)
  .join('\n')}
${Object.entries(WASH.light)
  .map(([k, v]) => `.wc-${k}-s{stroke:${v};fill:none}`)
  .join('\n')}
.blend{mix-blend-mode:multiply}
.wash{opacity:0.32}
.wash-2{opacity:0.1}
@media (prefers-color-scheme: dark){
${Object.entries(WASH.dark)
  .map(([k, v]) => `.wc-${k}{fill:${v}}`)
  .join('\n')}
${Object.entries(WASH.dark)
  .map(([k, v]) => `.wc-${k}-s{stroke:${v};fill:none}`)
  .join('\n')}
.blend{mix-blend-mode:screen}
.wash{opacity:0.18}
.wash-2{opacity:0.06}
}`;

const smooth = (pts, closed = false) => {
  if (pts.length < 3) return '';
  let out = `M${n(pts[0][0])} ${n(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    out += ` Q${n(pts[i][0])} ${n(pts[i][1])} ${n(mx)} ${n(my)}`;
  }
  const last = pts[pts.length - 1];
  out += ` L${n(last[0])} ${n(last[1])}`;
  return closed ? `${out} Z` : out;
};

// The shape only has to be recognised, not matched — that is what makes it a wash
// rather than a fill with a wobbly border. Points are walked along each edge and
// joined with straight segments: smoothing a four-point quad turns the corners
// into a pillow, which reads as a blob rather than a block.
const blob = (x, y, w, h, key, { amp = 2.4, dx = 0, dy = 0, inset = 0, per = 5 } = {}) => {
  const r = rnd(key);
  const j = () => (r() - 0.5) * amp * 2;
  const x0 = x + inset + dx;
  const y0 = y + inset + dy;
  const x1 = x + w - inset + dx;
  const y1 = y + h - inset + dy;
  const pts = [];
  const edge = (ax, ay, bx, by) => {
    for (let i = 0; i < per; i += 1) {
      const t = i / per;
      pts.push([ax + (bx - ax) * t + j(), ay + (by - ay) * t + j()]);
    }
  };
  edge(x0, y0, x1, y0);
  edge(x1, y0, x1, y1);
  edge(x1, y1, x0, y1);
  edge(x0, y1, x0, y0);
  return `${pts.map(([px, py], i) => `${i ? 'L' : 'M'}${n(px)} ${n(py)}`).join(' ')} Z`;
};

const washFilters = (w, h) => `<defs>
${[
  ['wc1', 5, 0.011],
  ['wc2', 17, 0.014],
  ['wc3', 31, 0.008],
  ['wc4', 43, 0.018],
]
  .map(
    ([id, seed, freq]) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="2" seed="${seed}" result="t"/>
<feDisplacementMap in="SourceGraphic" in2="t" scale="6" xChannelSelector="R" yChannelSelector="G"/>
<feGaussianBlur stdDeviation="1.1"/>
</filter>`,
  )
  .join('\n')}
${[
  ['ink', 3],
  ['ink2', 11],
]
  .map(
    ([id, seed]) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.01 0.012" numOctaves="3" seed="${seed}" result="t"/>
<feDisplacementMap in="SourceGraphic" in2="t" scale="${LOCK.displacement}" xChannelSelector="R" yChannelSelector="G"/>
</filter>`,
  )
  .join('\n')}
</defs>`;

// Two washes plus an optional pigment rim. `spread` is how far the second shape
// departs from the first: 0 would stack them, 10 starts reading as two strokes.
const wash = (x, y, w, h, key, tone, { spread = 6, rim = false } = {}) => `
<g class="blend"><path class="wc-${tone} wash" d="${blob(x, y, w, h, `${key}:a`, { amp: 2.4 })}" filter="url(#wc1)"/></g>
<g class="blend"><path class="wc-${tone} wash-2" d="${blob(x, y, w, h, `${key}:b`, { amp: 3, dx: spread, dy: spread * 0.6 })}" filter="url(#wc2)"/></g>
${
  rim
    ? `<path class="wc-${tone}-s" d="${blob(x, y, w, h, `${key}:r`, { amp: 2.4, inset: 1 })}" stroke-width="2.4" opacity="0.22" filter="url(#wc3)"/>`
    : ''
}`;

{
  const W = 760;
  const H = 400;
  const cells = [
    ['flat tint · the control', `<rect class="f-tint" x="40" y="84" width="160" height="94" rx="3"/>`],
    ['two washes · spread 4', wash(220, 84, 160, 94, 's4', 'blue', { spread: 4 })],
    ['two washes · spread 9', wash(400, 84, 160, 94, 's9', 'blue', { spread: 9 })],
    ['+ pigment rim · spread 9', wash(580, 84, 160, 94, 's9r', 'blue', { spread: 9, rim: true })],
  ];
  const row = cells
    .map(
      ([txt, body], i) => `${label(40 + i * 180, 72, txt)}
${body}`,
    )
    .join('\n');

  const context = `
${label(40, 232, 'in context — the wash has to sit behind type without fighting it')}
${wash(40, 250, 320, 110, 'c1', 'blue', { spread: 7 })}
<text x="200" y="300" text-anchor="middle" class="t-ink" font-size="17">Chat app</text>
<text x="200" y="322" text-anchor="middle" class="t-dim" font-size="12">routes the request</text>
${wash(400, 250, 320, 110, 'c2', 'green', { spread: 9, rim: true })}
<text x="560" y="300" text-anchor="middle" class="t-ink" font-size="17">Gateway</text>
<text x="560" y="322" text-anchor="middle" class="t-dim" font-size="12">normalises the protocol</text>`;

  writeFileSync(
    join(OUT, '12-fills.svg'),
    doc(
      W,
      H,
      `${washFilters(W, H)}
<style>${dualCss()}
${washCss()}
text{font-family:Inter,"Segoe UI",sans-serif}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text x="40" y="40" class="t-ink" font-size="16">12 · watercolour fill — two loose shapes, multiplied where they cross</text>
${row}
${context}`,
    ),
    'utf8',
  );
}

// --------------------------------------------------------------- 13 · the palette
// The tool's own tones, one swatch each: the fill solid (a faint wash reads badly
// on the dark ground), the border colour as the ghost displaced behind it.
const toneCss = () => `${HUE_NAMES.map((t) => `.t-${t}{fill:${TONES.light[t].fill}}`).join('\n')}
${HUE_NAMES.map((t) => `.b-${t}{fill:${TONES.light[t].border}}`).join('\n')}
${HUE_NAMES.map((t) => `.o-${t}{stroke:${TONES.light[t].border};fill:none}`).join('\n')}
.strength{opacity:${LOCK.tint.light}}
@media (prefers-color-scheme: dark){
${HUE_NAMES.map((t) => `.t-${t}{fill:${TONES.dark[t].fill}}`).join('\n')}
${HUE_NAMES.map((t) => `.b-${t}{fill:${TONES.dark[t].border}}`).join('\n')}
${HUE_NAMES.map((t) => `.o-${t}{stroke:${TONES.dark[t].border};fill:none}`).join('\n')}
.strength{opacity:${LOCK.tint.dark}}
}`;

{
  const W = 760;
  const H = 546;
  const CW = 128;
  const CH = 76;
  const GAP = 16;
  // Two variants of the same ten tones: the stroke is either the ink or the tone's
  // own border. Nothing else changes, so the comparison is only the stroke colour.
  const strokeOf = (tone, mode) => (mode === 'ink' ? 's-ink' : `o-${tone}`);
  const grid = (mode, y0) =>
    HUE_NAMES.map((tone, i) => {
      const x = 40 + (i % 5) * (CW + GAP);
      const y = y0 + Math.floor(i / 5) * (CH + 30);
      return `
<path class="b-${tone}" d="${blob(x, y, CW, CH, `sw:${tone}`, { dx: LOCK.ghostOffset.dx, dy: LOCK.ghostOffset.dy, amp: 3 })}" opacity="${LOCK.ghost}" filter="url(#wc2)"/>
<path class="t-${tone}" d="${blob(x, y, CW, CH, `sw2:${tone}`, { amp: 1.2 })}" filter="url(#wc1)"/>
<path class="b-${tone} strength" d="${blob(x, y, CW, CH, `str:${tone}`, { amp: 1.6, dx: 2, dy: 1.5 })}" filter="url(#wc2)"/>
<path class="${strokeOf(tone, mode)}" d="${blob(x, y, CW, CH, `out:${mode}:${tone}`, { amp: 0.6 })}" stroke-width="${LOCK.strong}" filter="url(#ink)"/>
<path class="${strokeOf(tone, mode)}" d="${blob(x, y, CW, CH, `out2:${mode}:${tone}`, { amp: 1.0 })}" stroke-width="${LOCK.faint}" opacity="${LOCK.faintOpacity}" filter="url(#ink2)"/>
${label(x, y + CH + 16, tone)}`;
    }).join('\n');

  writeFileSync(
    join(OUT, '13-palette.svg'),
    doc(
      W,
      H,
      `${washFilters(W, H)}
<style>${dualCss()}
${toneCss()}
text{font-family:Inter,"Segoe UI",sans-serif}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text x="40" y="40" class="t-ink" font-size="16">13 · the ten tones — outline in ink, or in the tone's own colour</text>
${label(40, 76, 'outline: ink')}
${grid('ink', 90)}
${label(40, 312, 'outline: the tone’s border colour')}
${grid('tone', 326)}`,
    ),
    'utf8',
  );
}

// ------------------------------------------------- 14 · the shapes, in three strokes
// Same fill recipe, three outlines. Dotted at 2.8 gives round dots of 2.8 diameter;
// the retrace carries the same pattern, or it would fill the gaps of the strong pass.
const dashOf = (style) =>
  style === 'dashed'
    ? ` stroke-dasharray="${LOCK.dash.dashed}"`
    : style === 'dotted'
      ? ` stroke-dasharray="${LOCK.dash.dotted}" stroke-linecap="round"`
      : '';

{
  const W = 760;
  const H = 552;
  const CW = 128;
  const CH = 56;
  const GAP = 16;

  // `on: false` keeps every path and seed identical and only drops the filters, so
  // the comparison is exactly what the filter contributes.
  const sheet = (file, title, on) => {
    const F = (id) => (on ? ` filter="url(#${id})"` : '');
    const cell = (x, y, tone, style) => {
      const d = dashOf(style);
      return `
<path class="b-${tone}" d="${blob(x, y, CW, CH, `g:${tone}:${style}`, { dx: LOCK.ghostOffset.dx, dy: LOCK.ghostOffset.dy, amp: 3 })}" opacity="${LOCK.ghost}"${F('wc2')}/>
<path class="t-${tone}" d="${blob(x, y, CW, CH, `f:${tone}:${style}`, { amp: 1.2 })}"${F('wc1')}/>
<path class="b-${tone} strength" d="${blob(x, y, CW, CH, `s:${tone}:${style}`, { amp: 1.6, dx: 2, dy: 1.5 })}"${F('wc2')}/>
<path class="o-${tone}" d="${blob(x, y, CW, CH, `o:${tone}:${style}`, { amp: 0.6 })}" stroke-width="${LOCK.strong}"${d}${F('ink')}/>
<path class="o-${tone}" d="${blob(x, y, CW, CH, `r:${tone}:${style}`, { amp: 1.0 })}" stroke-width="${LOCK.faint}" opacity="${LOCK.faintOpacity}"${d}${F('ink2')}/>
<text x="${x + CW / 2}" y="${y + CH / 2 + 4}" text-anchor="middle" class="t-ink" font-size="11">${tone}</text>`;
    };

    const group = (style, labelText, y0) =>
      `${label(40, y0 - 10, labelText)}
${HUE_NAMES.map((tone, i) => {
  const x = 40 + (i % 5) * (CW + GAP);
  const y = y0 + Math.floor(i / 5) * (CH + 10);
  return cell(x, y, tone, style);
}).join('\n')}`;

    writeFileSync(
      join(OUT, file),
      doc(
        W,
        H,
        `${washFilters(W, H)}
<style>${dualCss()}
${toneCss()}
text{font-family:Inter,"Segoe UI",sans-serif}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text x="40" y="40" class="t-ink" font-size="16">${title}</text>
${group('solid', 'solid', 82)}
${group('dashed', `dashed · ${LOCK.dash.dashed.split(' ').join(' / ')}`, 234)}
${group('dotted', `dotted · ${LOCK.dash.dotted.split(' ').join(' / ')}, round caps`, 386)}`,
      ),
      'utf8',
    );
  };

  sheet('14-shape-strokes.svg', '14 · the shapes with solid, dashed and dotted outlines', true);
}

// ------------------------------------------- 16 · what a filter failure looks like
// Three treatments of the same wire: the filter alone, geometry plus a gentler
// filter, and the same geometry with the filter removed.
{
  const W = 760;
  const H = 496;
  const defs = `<defs>
${[
  ['fx4', 3, 4],
  ['fx2', 3, 2],
]
  .map(
    ([id, seed, scale]) => `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.01 0.012" numOctaves="3" seed="${seed}" result="t"/>
<feDisplacementMap in="SourceGraphic" in2="t" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
</filter>`,
  )
  .join('\n')}
</defs>`;

  const wire = (x1, y1, x2, y2, mode, key, dash = '') => {
    const geo = mode === 'filter' ? null : roughLine(x1, y1, x2, y2, `${key}:${mode}`, { amp: 1.5, seg: 36 });
    const strong = geo
      ? `<path class="s-ink" d="${geo}" stroke-width="${LOCK.strong}"${dash}${mode === 'both' ? ' filter="url(#fx2)"' : ''}/>`
      : `<line class="s-ink" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${LOCK.strong}"${dash} filter="url(#fx4)"/>`;
    const faintGeo = mode === 'filter' ? null : roughLine(x1, y1, x2, y2, `${key}:${mode}:f`, { amp: 1.1, seg: 36 });
    const faint = faintGeo
      ? `<path class="s-ink" d="${faintGeo}" stroke-width="${LOCK.faint}" opacity="${LOCK.faintOpacity}"${dash}${mode === 'both' ? ' filter="url(#fx2)"' : ''}/>`
      : `<line class="s-ink" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${LOCK.faint}" opacity="${LOCK.faintOpacity}"${dash} filter="url(#fx4)"/>`;
    return `${faint}\n${strong}`;
  };

  const dashDashed = ` stroke-dasharray="${LOCK.dash.dashed}"`;
  const ROWS = [
    ['A · filter only — what ships today', 'filter'],
    ['B · geometry + a gentler filter', 'both'],
    ['B · the same wire with the filter removed', 'geo'],
  ];
  const group = (y0, dash, labelText) =>
    `${label(40, y0 - 30, labelText)}
${ROWS.map(([txt, mode], i) => {
  const y = y0 + i * 64;
  return `${label(40, y - 10, txt)}
${wire(40, y, 720, y, mode, `${y0}:${mode}`, dash)}`;
}).join('\n')}`;

  writeFileSync(
    join(OUT, '16-filter-fallback.svg'),
    doc(
      W,
      H,
      `${defs}
<style>${dualCss()}
text{font-family:Inter,"Segoe UI",sans-serif}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text x="40" y="40" class="t-ink" font-size="16">16 · what happens to a wire when the filter is dropped</text>
${group(112, '', 'solid')}
${group(342, dashDashed, 'dashed · ' + LOCK.dash.dashed.split(' ').join(' / '))}`,
    ),
    'utf8',
  );
}

// ------------------------------------------------------- 17 · the weight question
// One weight for both, or two named weights. Rows alternate wire/shape at normal
// and strong so the pairing can be judged rather than argued.
{
  const W = 760;
  const H = 448;
  const W_N = LOCK.weights.normal;
  const W_S = LOCK.weights.strong;
  const retrace = (w) => Math.round(w * 0.36 * 100) / 100;

  const wire = (y, w) => `
<path class="s-ink" d="${roughLine(40, y, 720, y, `w:${w}`, { amp: 1.5, seg: 36 })}" stroke-width="${w}" filter="url(#ln)"/>
<path class="s-ink" d="${roughLine(40, y, 720, y, `wf:${w}`, { amp: 1.1, seg: 36 })}" stroke-width="${retrace(w)}" opacity="${LOCK.faintOpacity}" filter="url(#lnf)"/>`;

  const card = (y, w, tone) => `
<path class="o-${tone}" d="${blob(40, y, 300, 58, `c:${w}:${tone}`, { amp: 0.6 })}" stroke-width="${w}" filter="url(#ink)"/>
<path class="o-${tone}" d="${blob(40, y, 300, 58, `cf:${w}:${tone}`, { amp: 1.0 })}" stroke-width="${retrace(w)}" opacity="${LOCK.faintOpacity}" filter="url(#ink2)"/>`;

  const row = (y, txt, body) => `${label(40, y - 12, txt)}
${body}`;

  writeFileSync(
    join(OUT, '17-weights.svg'),
    doc(
      W,
      H,
      `${filters(W, H)}
<style>${dualCss()}
${toneCss()}
text{font-family:Inter,"Segoe UI",sans-serif}
</style>
<rect class="bg" width="${W}" height="${H}"/>
<text x="40" y="40" class="t-ink" font-size="16">17 · one weight or two — normal ${W_N}, strong ${W_S}</text>
${row(84, `wire · normal ${W_N}`, wire(96, W_N))}
${row(146, `wire · strong ${W_S}`, wire(158, W_S))}
${row(210, `card · normal ${W_N}`, card(222, W_N, 'blue'))}
${row(306, `card · strong ${W_S}`, card(318, W_S, 'blue'))}`,
    ),
    'utf8',
  );
}

// ------------------------------------------------------------------- the page
// A sheet may carry more than one dark block (the base colours and the palette both
// emit one), so every block is resolved, not just the first.
const resolveScheme = (svg, mode) => {
  let out = svg;
  for (;;) {
    const start = out.indexOf('@media (prefers-color-scheme: dark){');
    if (start < 0) return out;
    let depth = 0;
    let end = -1;
    for (let i = out.indexOf('{', start); i < out.length; i += 1) {
      if (out[i] === '{') depth += 1;
      else if (out[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) return out;
    const inner = out.slice(out.indexOf('{', start) + 1, end - 1);
    out = mode === 'light' ? out.slice(0, start) + out.slice(end) : out.slice(0, start) + inner + out.slice(end);
  }
};

// An inline SVG's stylesheet is document-global; the two copies need their own scope.
const scopeStyle = (svg, key) =>
  svg
    .replace(/^(\.[a-zA-Z0-9_-]+)\{/gm, `[data-k="${key}"] $1{`)
    .replace(/^text\{/gm, `[data-k="${key}"] text{`)
    .replace(/<svg /, `<svg data-k="${key}" `);

// Inline copies share one document id namespace, so an un-prefixed `url(#ink)`
// resolves to whichever copy came first — and a filter's userSpaceOnUse region is
// sized per sheet, so a shorter sheet silently clips a taller one.
const ns = (svg, i) =>
  svg
    .replace(/\sid="([^"]+)"/g, (m, id) => ` id="e${i}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (m, id) => `url(#e${i}-${id})`);

const pair = (file, idx) => {
  const svg = readFileSync(join(OUT, file), 'utf8');
  return `<section>
    <h2>Light <span>${file}</span></h2>
    <div class="card">${scopeStyle(ns(resolveScheme(svg, 'light'), idx * 2), `L${idx}`)}</div>
  </section>
  <section>
    <h2>Dark <span>${file}</span></h2>
    <div class="card">${scopeStyle(ns(resolveScheme(svg, 'dark'), idx * 2 + 1), `D${idx}`)}</div>
  </section>`;
};

const light = pair('11-line-styles.svg', 1) + pair('12-fills.svg', 2) + pair('13-palette.svg', 3) + pair('14-shape-strokes.svg', 4) + pair('16-filter-fallback.svg', 6) + pair('17-weights.svg', 7);

writeFileSync(
  join(OUT, 'index.html'),
  `<!doctype html>
<meta charset="utf-8">
<title>Line styles — locked hand-drawn base</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:44px 0 96px; background:#1b1917; color:#e9e4dc;
         font:15px/1.55 Inter,"Segoe UI",sans-serif; }
  main { width:100%; margin:0 auto; padding:0 clamp(12px, 2.2vw, 48px); box-sizing:border-box; }
  h1 { font-size:30px; font-weight:600; letter-spacing:-.02em; margin:0 0 10px; }
  header p { margin:0; max-width:70ch; color:#a9a29a; }
  section { margin:44px 0 0; }
  h2 { font-size:13px; font-weight:600; letter-spacing:.11em; text-transform:uppercase;
       color:#c9c2b9; margin:0 0 14px; }
  h2 span { font-weight:400; letter-spacing:0; text-transform:none; color:#6f6862; margin-left:8px; }
  .card { border-radius:10px; overflow:hidden; box-shadow:0 18px 44px rgba(0,0,0,.42); }
  .card svg { display:block; width:100%; height:auto; }
  figcaption { margin-top:8px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#6f6862; }
  p { margin:16px 0 0; color:#8f8880; max-width:78ch; }
  code { font-family:"Cascadia Mono",Consolas,monospace; color:#cfc7bd; }
</style>
<main>
  <header>
    <h1>Lines &amp; fills</h1>
    <p>The base is locked: one pass at ${LOCK.strong} and a retrace at ${LOCK.faint} (${LOCK.faintOpacity * 100}% opacity) —
       the same number for wires and card edges. Geometry carries the wobble, a scale-${LOCK.lineDisplacement} field adds to it,
       so a renderer without filters still draws a drawn line. Line styles change only the dash pattern.</p>
       the second sheet is the fill question.</p>
  </header>
${light}
  <section>
    <p>Locked lines: <strong>solid</strong>, <strong>dashed ${LOCK.dash.dashed.split(' ').join(' / ')}</strong>,
       <strong>dotted ${LOCK.dash.dotted.split(' ').join(' / ')} with round caps</strong> —
       same two passes, same field, so a dotted arrow and a solid frame belong to the same drawing.</p>
    <p>Fills: two rough shapes per block. The first carries the colour (32% light, 18% dark); the second is
       near a ghost (10% / 6%) and sits offset from it, so the overlap only just deepens. They blend with
       <code>multiply</code> on paper and <code>screen</code> on the dark ground — the same alpha cannot serve
       both. The shape only has to be recognised, not matched; the rim is the same outline stroked at 22% with
       its own displacement, which is where pigment pools in real watercolour.</p>
    <p>Generated by <code>docs/sketch-proto/lab.mjs</code>.</p>
  </section>
</main>
`,
  'utf8',
);
process.stdout.write('index.html\n');


