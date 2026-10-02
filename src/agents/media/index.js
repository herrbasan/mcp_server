import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

let nMediaUrl;
let storageRoot;
let timeoutMs;
let pollIntervalMs;

const IMAGE_IN_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.tif', '.tiff', '.ico', '.heic', '.heif'];
const AUDIO_IN_EXT = ['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.oga', '.aac', '.opus', '.wma'];
const VIDEO_IN_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.wmv', '.flv', '.ts', '.mpg', '.mpeg'];
const VIDEO_MODES = ['extract_audio', 'extract_keyframes', 'transcode'];
const OUT_FORMATS = {
    image: { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.avif': 'avif', '.gif': 'gif' },
    audio: { '.mp3': 'mp3', '.m4a': 'm4a', '.wav': 'wav', '.flac': 'flac', '.ogg': 'ogg', '.opus': 'opus' },
    video: { '.mp4': 'mp4', '.webm': 'webm', '.mkv': 'mkv' }
};
const DEFAULT_OUT_EXT = { image: '.png', audio: '.mp3', video: '.mp4' };

export async function init(context) {
    nMediaUrl = context.config.nMediaUrl ?? 'http://localhost:3500';
    storageRoot = context.config.agents?.storage?.root;
    if (!storageRoot) throw new Error('[media] config agents.storage.root is required');
    const conf = context.config.agents?.media ?? {};
    timeoutMs = conf.timeoutMs ?? 120000;
    pollIntervalMs = conf.pollIntervalMs ?? 400;
    return { status: 'initialized', nMediaUrl, timeoutMs };
}

function resolveInStorage(userPath, label) {
    if (typeof userPath !== 'string' || !userPath.trim()) {
        throw new Error(`media_process: "${label}" (storage path) is required`);
    }
    const abs = path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(storageRoot, userPath);
    if (!abs.startsWith(path.resolve(storageRoot))) {
        throw new Error(`media_process: ${label} escapes storage root: ${userPath}`);
    }
    return abs;
}

function toStorageRel(abs) {
    return path.relative(path.resolve(storageRoot), abs).split(path.sep).join('/');
}

function inferProcessor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_IN_EXT.includes(ext)) return 'image';
    if (AUDIO_IN_EXT.includes(ext)) return 'audio';
    if (VIDEO_IN_EXT.includes(ext)) return 'video';
    throw new Error(`media_process: cannot infer processor from extension "${ext}" — pass processor explicitly ("image" | "audio" | "video")`);
}

async function postJob(body) {
    const res = await fetch(`${nMediaUrl}/v1/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`media_process: nMedia rejected the job (${res.status}): ${text}`);
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`media_process: nMedia returned non-JSON: ${text.slice(0, 200)}`);
    }
    if (!data.jobId || !data.poll_url) {
        throw new Error(`media_process: nMedia response missing jobId/poll_url: ${text.slice(0, 200)}`);
    }
    return data;
}

async function pollJob(pollUrl, deadline) {
    for (;;) {
        const res = await fetch(`${nMediaUrl}${pollUrl}`);
        if (!res.ok) throw new Error(`media_process: job poll failed (${res.status}): ${await res.text()}`);
        const job = await res.json();
        if (job.status === 'completed') {
            if (!job.assetId) throw new Error('media_process: job completed but produced no assetId');
            return job;
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
            throw new Error(`media_process: nMedia job ${job.jobId} ${job.status}: ${job.error || 'no error text'}`);
        }
        if (Date.now() > deadline) {
            throw new Error(`media_process: job ${job.jobId} did not finish within ${timeoutMs} ms (still ${job.status}). ` +
                `Poll GET ${nMediaUrl}/v1/jobs/${job.jobId} — jobs and assets persist ~1 h.`);
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
    }
}

async function fetchAssetBytes(assetId) {
    const res = await fetch(`${nMediaUrl}/v1/assets/${assetId}`);
    if (!res.ok) throw new Error(`media_process: asset fetch failed (${res.status}) for ${assetId}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || 'application/octet-stream' };
}

async function fetchAssetMeta(assetId) {
    const res = await fetch(`${nMediaUrl}/v1/assets/${assetId}/metadata`);
    if (!res.ok) return null;
    try {
        return await res.json();
    } catch {
        return null;
    }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Decode a PNG far enough to decide whether every pixel is the same colour.
// The blank-render guard must never fail a valid render, so variants the probe
// does not parse return { skipped, reason } instead of an error.
function pngUniformity(buf) {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return { skipped: 'not a PNG' };
    let pos = 8;
    let ihdr = null;
    let plte = null;
    const idat = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            ihdr = {
                width: data.readUInt32BE(0), height: data.readUInt32BE(4),
                depth: data[8], colorType: data[9], interlace: data[12]
            };
        } else if (type === 'PLTE') {
            plte = data;
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        pos += 12 + len;
    }
    if (!ihdr) return { skipped: 'missing IHDR' };
    if (ihdr.interlace !== 0) return { skipped: 'interlaced PNG' };
    if (ihdr.depth !== 8 && ihdr.colorType !== 3) return { skipped: `bit depth ${ihdr.depth}` };
    if (ihdr.width === 0 || ihdr.height === 0) return { skipped: 'empty raster' };
    if (ihdr.width * ihdr.height > 64e6) return { skipped: 'raster too large to probe' };
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.colorType];
    if (!channels) return { skipped: `color type ${ihdr.colorType}` };

    let raw;
    try {
        raw = zlib.inflateSync(Buffer.concat(idat));
    } catch {
        return { skipped: 'IDAT will not inflate' };
    }
    const stride = Math.ceil(ihdr.width * channels * ihdr.depth / 8);
    if (raw.length < (stride + 1) * ihdr.height) return { skipped: 'IDAT truncated' };

    // Unfilter all scanlines (RFC 2083 filters 0-4).
    const bpp = Math.max(1, Math.floor(channels * ihdr.depth / 8));
    const rows = Buffer.alloc(stride * ihdr.height);
    for (let y = 0; y < ihdr.height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const out = rows.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? out[x - bpp] : 0;
            const b = prev ? prev[x] : 0;
            const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
            let v = src[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            }
            out[x] = v & 0xff;
        }
    }

    // Compare every pixel against the first; bail out on the first difference,
    // so non-uniform renders stop almost immediately.
    const first = {};
    for (let y = 0; y < ihdr.height; y++) {
        const row = rows.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < ihdr.width; x++) {
            let r, g, b, a = 255;
            if (ihdr.colorType === 3) {
                let idx;
                if (ihdr.depth === 8) {
                    idx = row[x];
                } else {
                    const perByte = 8 / ihdr.depth;
                    idx = (row[Math.floor(x / perByte)] >> (8 - ihdr.depth * ((x % perByte) + 1))) & ((1 << ihdr.depth) - 1);
                }
                if (!plte || (idx + 1) * 3 > plte.length) return { skipped: 'palette index out of range' };
                r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2];
            } else if (ihdr.colorType === 0) {
                r = g = b = row[x];
            } else if (ihdr.colorType === 4) {
                r = g = b = row[x * 2]; a = row[x * 2 + 1];
            } else if (ihdr.colorType === 2) {
                r = row[x * 3]; g = row[x * 3 + 1]; b = row[x * 3 + 2];
            } else {
                r = row[x * 4]; g = row[x * 4 + 1]; b = row[x * 4 + 2]; a = row[x * 4 + 3];
            }
            if (first.r === undefined) {
                first.r = r; first.g = g; first.b = b; first.a = a;
            } else if (r !== first.r || g !== first.g || b !== first.b || a !== first.a) {
                return { uniform: false };
            }
        }
    }
    return { uniform: true };
}

function blankImageCheck(bytes, mime) {
    if (!bytes.length) return { blank: true, why: 'raster is 0 bytes' };
    if (!/png/i.test(mime)) return { skipped: `no pixel probe for ${mime}` };
    const probe = pngUniformity(bytes);
    if (probe.skipped) return { skipped: probe.skipped };
    if (probe.uniform) return { blank: true, why: 'raster is a single uniform colour' };
    return { passed: true };
}

export async function media_process(args) {
    const t0 = Date.now();
    const inAbs = resolveInStorage(args?.in, 'in');
    if (!fs.existsSync(inAbs)) throw new Error(`media_process: input not found in storage: ${args.in}`);
    if (!fs.statSync(inAbs).isFile()) throw new Error(`media_process: input is not a file: ${args.in}`);

    const processor = args.processor || inferProcessor(inAbs);
    if (!['image', 'audio', 'video'].includes(processor)) {
        throw new Error(`media_process: processor must be image|audio|video, got: ${processor}`);
    }

    let mode;
    if (processor === 'video') {
        mode = args.mode || 'extract_keyframes';
        if (!VIDEO_MODES.includes(mode)) {
            throw new Error(`media_process: mode must be one of ${VIDEO_MODES.join('|')}, got: ${mode}`);
        }
    } else if (args.mode) {
        throw new Error(`media_process: mode applies to the video processor only (got "${args.mode}" for ${processor})`);
    }

    // The out extension selects the nMedia output format, so the two must agree.
    const outRel = args.out || path.join('temp', path.basename(inAbs, path.extname(inAbs)) + DEFAULT_OUT_EXT[processor]);
    const outExt = path.extname(outRel).toLowerCase();
    const formats = OUT_FORMATS[processor];
    const format = formats[outExt];
    if (!format) {
        throw new Error(`media_process: out extension "${outExt || '(none)'}" is not a ${processor} output format (${Object.keys(formats).join(' ')})`);
    }
    const options = { ...(args.options || {}) };
    if (options.format && options.format !== format) {
        throw new Error(`media_process: options.format "${options.format}" does not match the out extension "${outExt}" — align them`);
    }
    options.format = format;
    if (processor === 'image' && !options.max_dimension) options.max_dimension = 2000;

    const outAbs = resolveInStorage(outRel, 'out');
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });

    const body = { input_path: inAbs, processor, options };
    if (mode) body.mode = mode;
    const submitted = await postJob(body);
    const job = await pollJob(submitted.poll_url, Date.now() + timeoutMs);

    const meta = await fetchAssetMeta(job.assetId);
    const { buffer, mime } = await fetchAssetBytes(job.assetId);

    const result = {
        out: toStorageRel(outAbs),
        bytes: buffer.length,
        assetId: job.assetId,
        ms: Date.now() - t0
    };
    if (meta?.metadata?.width) result.width = meta.metadata.width;
    if (meta?.metadata?.height) result.height = meta.metadata.height;

    if (processor === 'image') {
        const check = blankImageCheck(buffer, mime);
        if (check.blank) {
            throw new Error(`media_process: refusing to write "${result.out}" — ${check.why}. ` +
                'This is the raster-unsafe styling failure: SVGs themed via @media (prefers-color-scheme) rasterize to solid fills with invisible text. ' +
                'Style with explicit presentation attributes (CSS may override them for the browser only) and re-render.');
        }
        if (check.skipped) {
            logger.warn(`[Media] blank-render guard skipped: ${check.skipped}`, { out: result.out }, 'Media');
        }
    }

    fs.writeFileSync(outAbs, buffer);
    const written = fs.statSync(outAbs);
    if (written.size !== buffer.length) {
        throw new Error(`media_process: verify failed — wrote ${buffer.length} bytes, disk has ${written.size}`);
    }

    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
}

// Test seam — pngUniformity is exercised directly by tests/smoke-media-process.mjs
// with hand-built PNGs (all four filter types). Not part of the tool contract.
export const __test = { pngUniformity };
