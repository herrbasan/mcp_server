// Smoke test for the media agent (media.process). Requires nMedia on
// localhost:3500 (config.nMediaUrl) and the storage root from config.json.
// Run: node tests/smoke-media-process.mjs
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { init, media_process } from '../src/agents/media/index.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE_ROOT = 'D:\\MCP_Storage';
const TEMP = path.join(STORAGE_ROOT, 'temp');

await init({
    config: {
        nMediaUrl: 'http://localhost:3500',
        agents: { storage: { root: STORAGE_ROOT }, media: {} }
    }
});

let failures = 0;
const check = (name, cond) => {
    if (cond) console.log(`ok   ${name}`);
    else { failures++; console.error(`FAIL ${name}`); }
};
const cleanup = [];
const writeTemp = (name, data) => {
    const p = path.join(TEMP, name);
    fs.writeFileSync(p, data);
    cleanup.push(p);
    return p;
};

// ---------- hand-built PNGs for the uniformity probe ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
});
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}
// Build an RGBA PNG with a per-row filter sequence, so the probe's unfilter
// paths (Sub/Up/Average/Paeth) all get exercised.
function buildPng(width, height, pixelFn) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = y % 4; // filters 0,1,2,3 cycle (Paeth left to 4)
        for (let x = 0; x < width; x++) {
            const [r, g, b, a] = pixelFn(x, y);
            const o = y * (stride + 1) + 1 + x * 4;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
        }
    }
    // Encode each row from the PRISTINE originals (PNG predictors read the
    // previous row's reconstructed values, which equal the originals — never
    // the already-filtered bytes).
    const orig = Buffer.from(raw);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const rowOff = y * (stride + 1) + 1;
        const prevOff = y > 0 ? (y - 1) * (stride + 1) + 1 : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= 4 ? orig[rowOff + x - 4] : 0;
            const b = prevOff !== null ? orig[prevOff + x] : 0;
            const c = (prevOff !== null && x >= 4) ? orig[prevOff + x - 4] : 0;
            let pred = 0;
            if (filter === 1) pred = a;
            else if (filter === 2) pred = b;
            else if (filter === 3) pred = (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            raw[rowOff + x] = (orig[rowOff + x] - pred) & 0xff;
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

const mediaModule = await import('../src/agents/media/index.js');
check('module exports init + media_process', typeof mediaModule.init === 'function' && typeof mediaModule.media_process === 'function');
const pngUniformity = mediaModule.__test.pngUniformity;

// ---------- 0. uniformity probe on hand-built PNGs ----------
const solidPng = buildPng(64, 48, () => [200, 30, 90, 255]);
check('probe: solid PNG is uniform', pngUniformity(solidPng).uniform === true);
const variedPng = buildPng(64, 48, (x, y) => (x === 40 && y === 20) ? [0, 0, 0, 255] : [200, 30, 90, 255]);
check('probe: one differing pixel breaks uniformity', pngUniformity(variedPng).uniform === false);
const transparentPng = buildPng(64, 48, () => [200, 30, 90, 0]);
check('probe: fully transparent PNG is uniform (invisible raster)', pngUniformity(transparentPng).uniform === true);
check('probe: truncated PNG skipped, not an error', typeof pngUniformity(solidPng.subarray(0, 40)).skipped === 'string');
check('probe: non-PNG bytes skipped', typeof pngUniformity(Buffer.from('<svg/>')).skipped === 'string');

// ---------- 1. real render: machine-overview.svg → PNG ----------
const out1 = 'temp/media-test-overview.png';
cleanup.push(path.join(STORAGE_ROOT, out1));
try {
    fs.rmSync(path.join(STORAGE_ROOT, out1), { force: true });
    const r = await media_process({ in: 'blog/machine/images/machine-overview.svg', out: out1 });
    const data = JSON.parse(r.content[0].text);
    check('svg→png: isError false', r.isError === false);
    check('svg→png: out path reported', data.out === out1);
    check('svg→png: file written and size matches bytes',
        fs.existsSync(path.join(STORAGE_ROOT, out1)) && fs.statSync(path.join(STORAGE_ROOT, out1)).size === data.bytes);
    check('svg→png: dimensions present', data.width > 0 && data.height > 0);
    check('svg→png: non-trivial raster written (guard passed ⇒ non-uniform)', data.bytes > 1000);
} catch (e) {
    check(`svg→png render (${e.message.slice(0, 120)})`, false);
}

// ---------- 2. blank-render refusal: uniform raster ----------
// The guard refuses rasters where EVERY pixel is identical (the fully-blank
// signature). Partial invisibility (some elements vanish, others survive)
// is NOT uniform and passes by design — the fix for that is raster-safe
// styling (explicit presentation attributes), not detection.
const uniformSvg = path.join(TEMP, 'media-test-uniform.svg');
fs.writeFileSync(uniformSvg,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200" width="1200" height="300">\n' +
    '<rect x="0" y="0" width="800" height="200" fill="#111111"/>\n' +
    '<text x="45" y="110" font-size="22" fill="#111111">INVISIBLE ON SAME-COLOUR FIELD</text>\n</svg>\n');
cleanup.push(uniformSvg);
const out2 = 'temp/media-test-blank.png';
cleanup.push(path.join(STORAGE_ROOT, out2));
fs.rmSync(path.join(STORAGE_ROOT, out2), { force: true });
try {
    await media_process({ in: 'temp/media-test-uniform.svg', out: out2 });
    check('uniform raster refused (expected throw, got success)', false);
} catch (e) {
    check('uniform raster refused with explanation', String(e.message).includes('refusing to write') && String(e.message).includes('uniform colour'));
}
check('uniform raster: no file written', !fs.existsSync(path.join(STORAGE_ROOT, out2)));

// ---------- 3. loud failures ----------
try {
    await media_process({ in: 'temp/definitely-not-there.png' });
    check('missing input fails loud', false);
} catch (e) {
    check('missing input fails loud', String(e.message).includes('not found'));
}
try {
    await media_process({ in: 'temp/raster-test.svg', out: 'temp/media-test.txt' });
    check('bad out extension fails loud', false);
} catch (e) {
    check('bad out extension fails loud', String(e.message).includes('not a image output format') || String(e.message).includes('output format'));
}
try {
    await media_process({ in: 'temp/raster-test.svg', out: 'temp/media-test.png', options: { format: 'jpeg' } });
    check('options.format mismatch fails loud', false);
} catch (e) {
    check('options.format mismatch fails loud', String(e.message).includes('align them'));
}
try {
    await media_process({ in: 'temp/raster-test.svg', out: '../outside.png' });
    check('path escape fails loud', false);
} catch (e) {
    check('path escape fails loud', String(e.message).includes('escapes storage root'));
}

// ---------- cleanup + summary ----------
for (const p of cleanup) fs.rmSync(p, { force: true });
if (failures) {
    console.error(`\n${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nall checks passed');
