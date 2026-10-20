// A sketch pass over nCharts output.
//
// nCharts positions everything; this file only redraws. Every shape it emits is a
// single self-closing tag on its own line, which is the same property compositeSvg()
// relies on — so a regex pass can rewrite geometry without touching layout or type.
//
// What it does NOT do: change fills. The tone classes already carry the fill and the
// border, so a rough outline plus a ghost of the same class is enough — the ghost
// picks up the fill, which is exactly what a watercolour underlayer is.

import { createHash } from 'node:crypto';

const n = (v) => String(Math.round(v * 100) / 100);

const seedOf = (s) => {
  const h = createHash('sha1').update(s).digest();
  let a = h.readUInt32BE(0);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const smoothPath = (pts, closed = false) => {
  if (pts.length < 3) return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join('') + (closed ? ' Z' : '');
  let out = `M${n(pts[0][0])} ${n(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    out += ` Q${n(pts[i][0])} ${n(pts[i][1])} ${n(mx)} ${n(my)}`;
  }
  const last = pts[pts.length - 1];
  out += ` L${n(last[0])} ${n(last[1])}`;
  return out + (closed ? ' Z' : '');
};

// Walk the ring, jittering each point. `per` points per edge keeps a box looking
// like a box: fewer and the corners round over into a blob.
const roughQuad = (x, y, w, h, key, { amp = 0.8, per = 5 } = {}) => {
  const r = seedOf(key);
  const pts = [];
  const edge = (ax, ay, bx, by) => {
    for (let i = 0; i < per; i += 1) {
      const t = i / per;
      pts.push([ax + (bx - ax) * t + (r() - 0.5) * 2 * amp, ay + (by - ay) * t + (r() - 0.5) * 2 * amp]);
    }
  };
  edge(x, y, x + w, y);
  edge(x + w, y, x + w, y + h);
  edge(x + w, y + h, x, y + h);
  edge(x, y + h, x, y);
  return smoothPath(pts, true);
};

// Wires are joined with straight segments on purpose: smoothing runs the 90° elbows
// of a routed wire into arcs, which reads as spaghetti rather than a drawn line.
const roughPolyline = (pts, key, { amp = 1.0, seg = 30, closed = false } = {}) => {
  const r = seedOf(key);
  const list = closed ? [...pts, pts[0]] : pts;
  const out = [[list[0][0], list[0][1]]];
  for (let i = 0; i < list.length - 1; i += 1) {
    const [x1, y1] = list[i];
    const [x2, y2] = list[i + 1];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const steps = Math.max(1, Math.round(len / seg));
    const ux = (x2 - x1) / len;
    const uy = (y2 - y1) / len;
    for (let s = 1; s < steps; s += 1) {
      const t = s / steps;
      const off = (r() - 0.5) * 2 * amp;
      out.push([x1 + ux * len * t - uy * off, y1 + uy * len * t + ux * off]);
    }
    out.push([x2, y2]);
  }
  return `${out.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ')}${closed ? ' Z' : ''}`;
};

const attr = (s, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(s);
  return m ? m[1] : undefined;
};

const M = /^[ \t]*<(rect|line|path|polygon)\b([^>]*?)\/>[ \t]*$/gm;

export function sketchify(svg, { amp = 0.8, lineAmp = 1.0, seg = 30, displacement = 2, ghost = 0.16 } = {}) {
  const size = /<svg[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/.exec(svg);
  if (!size) throw new Error('sketchify: no canvas size in the SVG');
  const [, W, H] = size.map(Number);

  const filters = `<filter id="sk-ink" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.01 0.012" numOctaves="3" seed="3" result="t"/>
<feDisplacementMap in="SourceGraphic" in2="t" scale="${displacement}" xChannelSelector="R" yChannelSelector="G"/>
</filter>
<filter id="sk-ink2" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.013 0.009" numOctaves="3" seed="11" result="t"/>
<feDisplacementMap in="SourceGraphic" in2="t" scale="${displacement}" xChannelSelector="R" yChannelSelector="G"/>
</filter>`;

  const body = svg.replace(M, (tag, kind, attrs) => {
    const cls = attr(tag, 'class') ?? '';
    // A drop shadow belongs to the flat style; a drawing on paper does not float.
    const clean = cls.replace(/\s*nc-shadow\b/, '').trim();
    const dead = cls.includes('nc-bg');
    if (dead) return tag;

    const key = `${kind}:${attrs}`;
    const faint = (d) => `<path class="${clean}" d="${d}" filter="url(#sk-ink2)" opacity="${ghost}"/>`;
    const strong = (d) => `<path class="${clean}" d="${d}" filter="url(#sk-ink)"/>`;

    if (kind === 'rect') {
      const w = +attr(tag, 'width');
      const h = +attr(tag, 'height');
      const x = +attr(tag, 'x');
      const y = +attr(tag, 'y');
      // Chips and badges are too small for the full wobble — it eats them.
      const a = Math.min(amp, Math.min(w, h) * 0.06);
      return `${faint(roughQuad(x, y, w, h, `${key}:g`, { amp: a * 1.6 }))}
${strong(roughQuad(x, y, w, h, `${key}:s`, { amp: a }))}`;
    }

    if (kind === 'line') {
      const pts = [
        [+attr(tag, 'x1'), +attr(tag, 'y1')],
        [+attr(tag, 'x2'), +attr(tag, 'y2')],
      ];
      return `${faint(roughPolyline(pts, `${key}:g`, { amp: lineAmp * 1.3, seg }))}
${strong(roughPolyline(pts, `${key}:s`, { amp: lineAmp, seg }))}`;
    }

    if (kind === 'path') {
      const d = attr(tag, 'd') ?? '';
      // A rounded, filled card is emitted as a Q path. In this style a precise
      // corner radius is noise, so it becomes a rough quad of its own bounding box.
      if (/[CQ]/.test(d)) {
        if (!/nc-box/.test(clean)) return tag;
        const nums = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
        if (nums.length < 4) return tag;
        const xs = nums.filter((_, i) => i % 2 === 0);
        const ys = nums.filter((_, i) => i % 2 === 1);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const w = Math.max(...xs) - x;
        const h = Math.max(...ys) - y;
        const a = Math.min(amp, Math.min(w, h) * 0.06);
        return `${faint(roughQuad(x, y, w, h, `${key}:g`, { amp: a * 1.6 }))}
${strong(roughQuad(x, y, w, h, `${key}:s`, { amp: a }))}`;
      }
      const pts = d
        .trim()
        .split(/\s*[ML]\s*/)
        .filter(Boolean)
        .map((p) => p.split(/[\s,]+/).map(Number));
      if (pts.length < 2 || pts.some((p) => p.length !== 2 || p.some(Number.isNaN))) return tag;
      const closed = /z$/i.test(d.trim());
      return `${faint(roughPolyline(pts, `${key}:g`, { amp: lineAmp * 1.3, seg, closed }))}
${strong(roughPolyline(pts, `${key}:s`, { amp: lineAmp, seg, closed }))}`;
    }

    if (kind === 'polygon') {
      // Arrowheads are small and dense; a light jitter is all they tolerate.
      const raw = attr(tag, 'points') ?? '';
      const pts = raw.trim().split(/\s+/).map((p) => p.split(',').map(Number));
      if (pts.length < 2 || pts.some((p) => p.length !== 2 || p.some(Number.isNaN))) return tag;
      const r = seedOf(`${key}:poly`);
      const j = pts.map(([x, y]) => [x + (r() - 0.5) * 0.9, y + (r() - 0.5) * 0.9]);
      return `<path class="${clean}" d="${j.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ')} Z" filter="url(#sk-ink)"/>`;
    }

    return tag;
  });
  // The theme's own CSS, appended after nCharts' sheet so the weights win without
  // !important. Placed outside the dark block: weight and dash are scheme-agnostic.
  const css = `.nc rect,.nc path,.nc line,.nc polygon{stroke-width:1.8}
.nc .nc-wire-d,.nc .nc-group{stroke-dasharray:16 5}`;

  return body
    .replace('</defs>', `${filters}\n</defs>`)
    .replace('</style>', `${css}\n</style>`);
}
