// Real nCharts diagrams, plain and sketchified, side by side.
//   node docs/sketch-proto/preview.mjs

import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '../../src/nCharts/src/index.js';
import { sketchify } from '../../src/agents/chart/sketch.js';

const OUT = 'D:\\MCP_Storage\\temp\\sketch-lab';
const EXAMPLES = new URL('../../src/nCharts/examples/', import.meta.url);
const SPECS = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''))
  .sort();

mkdirSync(OUT, { recursive: true });

for (const name of SPECS) {
  const spec = JSON.parse(readFileSync(new URL(`${name}.json`, EXAMPLES), 'utf8'));
  const plain = render({ ...spec, background: true });
  writeFileSync(join(OUT, `ncharts-${name}--plain.svg`), plain, 'utf8');
  writeFileSync(join(OUT, `ncharts-${name}--sketch.svg`), sketchify(plain), 'utf8');
}
process.stdout.write(`${SPECS.length} specs rendered\n`);

// Dual-scheme resolution: nCharts emits its own media block, so the page shows both.
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

// Inline copies share one id namespace; prefix per copy or url(#sk-ink) resolves to
// another copy's userSpaceOnUse region and clips the drawing.
let seq = 0;
const inline = (file, mode) => {
  const key = `n${(seq += 1)}`;
  const svg = resolveScheme(readFileSync(join(OUT, file), 'utf8'), mode);
  return svg
    .replace(/\sid="([^"]+)"/g, (m, id) => ` id="${key}-${id}"`)
    .replace(/url\(#([^\s)]+)\)/g, (m, id) => `url(#${key}-${id})`)
    .replace(/<svg /, `<svg data-k="${key}" `)
    .replace(/^(\.[a-zA-Z0-9_-]+)\{/gm, `[data-k="${key}"] $1{`)
    .replace(/^text\{/gm, `[data-k="${key}"] text{`);
};

const sections = SPECS.map(
  (name) => `
  <section>
    <h2>${name}</h2>
    <div class="pair">
      <figure><div class="card plain">${inline(`ncharts-${name}--plain.svg`, 'dark')}</div><figcaption>as shipped</figcaption></figure>
      <figure><div class="card">${inline(`ncharts-${name}--sketch.svg`, 'dark')}</div><figcaption>sketch</figcaption></figure>
    </div>
  </section>`,
).join('\n');

writeFileSync(
  join(OUT, 'ncharts.html'),
  `<!doctype html>
<meta charset="utf-8">
<title>nCharts through the sketch pass</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:44px 0 96px; background:#1b1917; color:#e9e4dc;
         font:15px/1.55 Inter,"Segoe UI",sans-serif; }
  main { padding:0 clamp(12px,2.2vw,48px); }
  h1 { font-size:30px; font-weight:600; margin:0 0 10px; letter-spacing:-.02em; }
  header p { margin:0; max-width:70ch; color:#a9a29a; }
  section { margin:44px 0 0; }
  h2 { font-size:13px; font-weight:600; letter-spacing:.11em; text-transform:uppercase; color:#c9c2b9; margin:0 0 14px; }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
  @media (max-width:980px) { .pair { grid-template-columns:1fr; } }
  figure { margin:0; }
  figcaption { margin-top:8px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#6f6862; }
  .card { border-radius:10px; overflow:hidden; box-shadow:0 18px 44px rgba(0,0,0,.42); }
  .card svg { display:block; width:100%; height:auto; }
  p { color:#8f8880; max-width:78ch; }
</style>
<main>
  <header>
    <h1>nCharts through the sketch pass</h1>
    <p>Left: the renderer as it ships. Right: the same spec after <code>sketchify()</code> —
       geometry rewritten, weights and dashes overridden, two filters injected.
       No layout code touched, no spec changed.</p>
  </header>
${sections}
</main>
`,
  'utf8',
);
process.stdout.write('ncharts.html\n');
