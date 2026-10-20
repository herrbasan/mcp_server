import fs from 'fs';
import path from 'path';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

let gatewayHttp;
let gatewayAccessKey;
let nMediaUrl;
let storageRoot;
let imageDir;
let sizes;      // [{ name, maxDimension }] — first entry is always the "full" transcode
let quality;
let timeoutMs;
let defaultSize;
let ingestAllowedRoots = [];
let ingestMaxSourceBytes = 24 * 1048576;
let ingestMaxBlockBytes = 4 * 1048576;

export async function init(context) {
    gatewayHttp = context.config.gateway?.httpUrl ?? 'http://localhost:3400';
    gatewayAccessKey = context.config.gateway?.accessKey ?? null;
    nMediaUrl = context.config.nMediaUrl ?? 'http://localhost:3500';
    storageRoot = context.config.agents?.storage?.root;
    if (!storageRoot) throw new Error('[image] config agents.storage.root is required');

    const conf = context.config.agents?.image ?? {};
    imageDir = conf.folder ?? 'images';
    quality = conf.quality ?? 85;
    timeoutMs = conf.timeoutMs ?? 300000;
    defaultSize = conf.defaultSize ?? '1920x1440'; // 4:3 at 2K — works cropped to 16:9 or 1:1
    ingestAllowedRoots = conf.ingestRoots ?? [];
    ingestMaxSourceBytes = conf.ingestMaxSourceBytes ?? 24 * 1048576;
    ingestMaxBlockBytes = conf.ingestMaxBlockBytes ?? 4 * 1048576;
    sizes = [
        { name: 'full', maxDimension: 10000 }, // shrink-only → transcode at source resolution
        ...(conf.sizes ?? [1920, 1280, 720, 180]).map(s => ({ name: String(s), maxDimension: s }))
    ];

    fs.mkdirSync(path.join(storageRoot, imageDir), { recursive: true });
    return { status: 'initialized', imageDir, sizes: sizes.map(s => s.name) };
}

function slugify(text) {
    const slug = text.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 6)
        .join('-')
        .replace(/-+/g, '-')
        .slice(0, 60)
        .replace(/^-+|-+$/g, '');
    return slug || 'image';
}

function localTimestamp(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function uniqueBase(slug) {
    const dir = path.join(storageRoot, imageDir);
    const stamp = localTimestamp();
    let candidate = `${stamp}_${slug}`;
    let i = 2;
    while (fs.existsSync(path.join(dir, `${candidate}.json`))) {
        candidate = `${stamp}_${slug}-${i++}`;
    }
    return candidate;
}

function mimeFromExt(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };
    return map[ext] ?? 'application/octet-stream';
}

function resolveReference(ref) {
    if (/^https?:\/\//i.test(ref)) return ref; // remote URL — gateway fetches it
    const abs = path.join(storageRoot, ref);
    if (!abs.startsWith(path.resolve(storageRoot))) throw new Error(`image_generate: reference escapes storage root: ${ref}`);
    if (!fs.existsSync(abs)) throw new Error(`image_generate: reference not found in storage: ${ref}`);
    const b64 = fs.readFileSync(abs).toString('base64');
    return `data:${mimeFromExt(ref)};base64,${b64}`;
}

function stripDataUri(b64) {
    const m = b64.match(/^data:[^;]+;base64,(.+)$/s);
    return m ? m[1] : b64;
}

async function renderVariant(rawBase64, maxDimension) {
    const res = await fetch(`${nMediaUrl}/v1/process/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: rawBase64, max_dimension: maxDimension, quality, format: 'webp', response_type: 'base64' })
    });
    if (!res.ok) throw new Error(`nMedia render failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { base64: stripDataUri(data.base64), width: data.width, height: data.height };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SVG_SNIFF_LEN = 512;
function isSvgPayload(mediaType, rawB64) {
    if (typeof mediaType === 'string' && /svg/i.test(mediaType)) return true;
    const head = Buffer.from(rawB64, 'base64').subarray(0, SVG_SNIFF_LEN).toString('utf8');
    return /<svg[\s>]/i.test(head);
}

// Vector intrinsic size — the SVG's own width/height attrs, falling back to the
// viewBox. A preview raster reports the nMedia cap, not the vector's size.
function svgIntrinsicSize(buf) {
    const root = buf.subarray(0, SVG_SNIFF_LEN).toString('utf8').match(/<svg[^>]*>/i)?.[0] ?? '';
    const attr = name => root.match(new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)`, 'i'))?.[1];
    const w = Number(attr('width'));
    const h = Number(attr('height'));
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
    const vb = root.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1]?.trim().split(/[\s,]+/).map(Number);
    if (vb?.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
    return null;
}

// The lossless PNG original (#58): platforms with format allowlists (YouTube et al.) reject webp.
// Providers normally return PNG — those bytes are written untouched (dimensions read from IHDR).
// Any other source format gets one nMedia re-encode to PNG under the same shrink-only cap as full.
async function renderOriginal(rawBase64) {
    const buf = Buffer.from(rawBase64, 'base64');
    if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
        if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) throw new Error('image_generate: gateway PNG is malformed (no IHDR at offset 12)');
        return { buf, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    const res = await fetch(`${nMediaUrl}/v1/process/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64: rawBase64, max_dimension: sizes[0].maxDimension, format: 'png', response_type: 'base64' })
    });
    if (!res.ok) throw new Error(`nMedia PNG render failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { buf: Buffer.from(stripDataUri(data.base64), 'base64'), width: data.width, height: data.height };
}

export async function image_generate(args) {
    if (typeof args?.prompt !== 'string' || args.prompt.length === 0) {
        throw new Error('image_generate: "prompt" (non-empty string) is required');
    }

    // 1. Generate via gateway
    const body = { prompt: args.prompt };
    if (args.model) body.model = args.model;
    if (args.size) body.size = args.size;
    if (args.aspect_ratio) body.aspect_ratio = args.aspect_ratio;
    if (!args.size && !args.aspect_ratio) body.size = defaultSize;
    if (args.seed != null) body.seed = args.seed;
    if (args.extra_body) body.extra_body = args.extra_body;
    if (Array.isArray(args.references) && args.references.length > 0) {
        body.input_references = args.references.map(resolveReference);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (gatewayAccessKey) headers['Authorization'] = `Bearer ${gatewayAccessKey}`;

    logger.info(`[image] Generating: "${args.prompt.slice(0, 80)}"${body.input_references ? ` (${body.input_references.length} refs)` : ''}`, null, 'Image');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let gen;
    try {
        const res = await fetch(`${gatewayHttp}/v1/images/generations`, {
            method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Gateway image generation failed: ${res.status} ${text}`);
        }
        gen = await res.json();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`image_generate: gateway did not respond within ${timeoutMs / 1000}s`);
        throw err;
    } finally {
        clearTimeout(timer);
    }

    const images = gen?.data;
    if (!Array.isArray(images) || images.length === 0 || !images[0].b64_json) {
        throw new Error('image_generate: gateway returned no images');
    }

    // 2. Render variants + persist, one output set per returned image
    const slug = slugify(args.name ?? args.prompt);
    const outputs = [];

    for (let idx = 0; idx < images.length; idx++) {
        const img = images[idx];
        if (!img.b64_json) throw new Error(`image_generate: image ${idx + 1} of ${images.length} has no b64_json`);
        const raw = stripDataUri(img.b64_json);
        const base = uniqueBase(images.length > 1 ? `${slug}-${idx + 1}` : slug);
        const dir = path.join(storageRoot, imageDir);
        const files = {};
        let thumb = null;
                let vector = false;

        if (isSvgPayload(img.media_type, raw)) {
            // Vector output: the SVG source IS the deliverable — the size-variant
            // set is meaningless (unbounded rescaling) and the PNG re-encode would
            // replace the vector original with a raster copy. Persist the source
            // verbatim plus two raster derivatives for inline display.
            const svgBuf = Buffer.from(raw, 'base64');
            const preview = await renderVariant(raw, 1280); // shrink-only → intrinsic size when smaller
            const thumbRender = await renderVariant(raw, 180);
            const previewName = `${base}_preview.webp`;
            const thumbName = `${base}_thumb.webp`;
            fs.writeFileSync(path.join(dir, `${base}.svg`), svgBuf);
            fs.writeFileSync(path.join(dir, previewName), Buffer.from(preview.base64, 'base64'));
            fs.writeFileSync(path.join(dir, thumbName), Buffer.from(thumbRender.base64, 'base64'));
            const intrinsic = svgIntrinsicSize(svgBuf);
                        files.svg = { path: `${imageDir}/${base}.svg`, width: intrinsic?.width ?? preview.width, height: intrinsic?.height ?? preview.height, bytes: svgBuf.length };
                        files.preview = { path: `${imageDir}/${previewName}`, width: preview.width, height: preview.height, bytes: Buffer.from(preview.base64, 'base64').length };
                        files.thumb = { path: `${imageDir}/${thumbName}`, width: thumbRender.width, height: thumbRender.height, bytes: Buffer.from(thumbRender.base64, 'base64').length };
                        thumb = preview.base64;
                        vector = true;
        } else {
            const variants = await Promise.all(sizes.map(s => renderVariant(raw, s.maxDimension)));
            const original = await renderOriginal(raw);

            for (let v = 0; v < sizes.length; v++) {
                const fileName = `${base}_${sizes[v].name}.webp`;
                const buf = Buffer.from(variants[v].base64, 'base64');
                fs.writeFileSync(path.join(dir, fileName), buf);
                const relPath = `${imageDir}/${fileName}`;
                files[sizes[v].name] = { path: relPath, width: variants[v].width, height: variants[v].height, bytes: buf.length };
                if (sizes[v].name === '1280') thumb = variants[v].base64; // largest derived variant — inline preview keeps the detail
            }

            // PNG original — last entry in files so the text table lists it after the sizes
            const pngName = `${base}_full.png`;
            fs.writeFileSync(path.join(dir, pngName), original.buf);
            files.png = { path: `${imageDir}/${pngName}`, width: original.width, height: original.height, bytes: original.buf.length };
        }

        const sidecar = {
            name: base,
            created: new Date().toISOString(),
            prompt: args.prompt,
            model: gen.model ?? args.model ?? null,
            request: {
                size: args.size ?? null,
                aspect_ratio: args.aspect_ratio ?? null,
                seed: args.seed ?? null,
                extra_body: args.extra_body ?? null
            },
            references: args.references ?? [],
            lineage: (args.references ?? []).filter(r => !/^https?:\/\//i.test(r)),
            source: { media_type: img.media_type ?? null, revised_prompt: img.revised_prompt ?? null },
            usage: gen.usage ?? null,
            cost: gen.usage?.cost ?? null,
            files
        };
        const sidecarName = `${base}.json`;
        fs.writeFileSync(path.join(dir, sidecarName), JSON.stringify(sidecar, null, 2));

        outputs.push({ base, sidecar: `${imageDir}/${sidecarName}`, files, thumb, vector });
                logger.info(`[image] Wrote ${base} (${vector ? 'svg source + preview/thumb raster' : `${sizes.length} webp sizes + png original`} + sidecar)`, null, 'Image');
    }

    // 3. Result: text file list + inline thumbnail of the first image
    const lines = outputs.map(o => {
        const fileLines = Object.entries(o.files)
            .map(([size, f]) => `  ${size.padEnd(5)} ${f.width}x${f.height}  ${(f.bytes / 1024).toFixed(0).padStart(5)} KB  ${f.path}`)
            .join('\n');
        return `${o.base}\n${fileLines}\n  meta  ${o.sidecar}`;
    });
    const model = gen.model ?? args.model ?? '(gateway default)';
    const cost = gen.usage?.cost != null ? ` · cost ${gen.usage.cost}` : '';
    const vectors = outputs.filter(o => o.vector).length;
        const guidance = vectors === outputs.length
        ? 'The .svg is the source of truth — it scales to any size losslessly, so use it wherever the target accepts vectors. The _preview/_thumb webp files are rasters of it for display only (regenerate them at any size with nMedia instead of rescaling these).'
            : vectors === 0
                ? 'Copy whichever sizes you need from storage (images/) — use the _full.png original for platforms that reject webp (YouTube et al.).'
                : `Mixed output: ${vectors} vector and ${outputs.length - vectors} raster image${outputs.length - vectors > 1 ? 's' : ''}. The .svg files are losslessly scalable sources; the raster sets carry the webp sizes plus a _full.png original (for platforms that reject webp, e.g. YouTube).`;
    const text = `Generated ${outputs.length} image${outputs.length > 1 ? 's' : ''} · model ${model}${cost}\n\n${lines.join('\n\n')}\n\n${guidance} Full prompt, parameters, usage and lineage are in the .json sidecar.`;

    const content = [{ type: 'text', text }];
    if (outputs[0].thumb) {
        content.push({ type: 'image', data: outputs[0].thumb, mimeType: 'image/webp' });
    }
    return { content, isError: false };
}

// ── image.ingest ────────────────────────────────────────────────────────────
// Hand an existing image to the calling model as an MCP image block. The point is
// perception, not conversion: resizing exists only to keep the block cheap.
// Everything is bounded — count, source bytes, block bytes — because the output
// goes straight into a context window and an unbounded tool is a denial of service
// against the caller.

const INGEST_MAX_SOURCES = 4;

function imageSize(buf) {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
    }
    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mime: 'image/gif' };
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
        for (let i = 2; i + 9 < buf.length;) {
            if (buf[i] !== 0xff) { i += 1; continue; }
            const marker = buf[i + 1];
            if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            const len = buf.readUInt16BE(i + 2);
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), mime: 'image/jpeg' };
            }
            i += 2 + len;
        }
        return { width: null, height: null, mime: 'image/jpeg' };
    }
    const head = buf.subarray(0, 1024).toString('utf8');
    if (/<svg[\s>]/i.test(head)) {
        const w = /<svg[^>]*\bwidth="([\d.]+)/i.exec(head);
        const h = /<svg[^>]*\bheight="([\d.]+)/i.exec(head);
        if (w && h) return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])), mime: 'image/svg+xml' };
        const vb = /viewBox="([\d.\s,-]+)"/i.exec(head);
        if (vb) {
            const p = vb[1].trim().split(/[\s,]+/).map(Number);
            if (p.length === 4) return { width: Math.round(p[2]), height: Math.round(p[3]), mime: 'image/svg+xml' };
        }
    }
    return { width: null, height: null, mime: null };
}

function ingestRoots() {
    return [path.resolve(storageRoot), ...(ingestAllowedRoots ?? []).map((r) => path.resolve(r))];
}

function resolveIngestSource(source) {
    if (/^https?:\/\//i.test(source)) return { kind: 'url', url: source };
    if (/^data:/i.test(source)) return { kind: 'data', uri: source };
    const abs = path.isAbsolute(source) ? path.resolve(source) : path.resolve(storageRoot, source);
    const roots = ingestRoots();
    const allowed = roots.some((root) => abs === root || abs.startsWith(root + path.sep));
    if (!allowed) {
        throw new Error(`image_ingest: "${source}" resolves to ${abs}, outside the allowed roots (${roots.join(', ')}). Add a root to agents.image.ingestRoots.`);
    }
    if (!fs.existsSync(abs)) throw new Error(`image_ingest: no such file: ${source}`);
    return { kind: 'file', path: abs };
}

async function nmediaCrop(base64, region, sourceSize, format, qualityValue) {
    const [sourceWidth, sourceHeight] = sourceSize;
    if (!sourceWidth || !sourceHeight) {
        throw new Error('cannot crop: the source dimensions could not be read from its header');
    }
    // nMedia's region takes FRACTIONS of the raster (left * width), not pixels.
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const crop = {
        type: 'region',
        left: clamp(region.x / sourceWidth),
        top: clamp(region.y / sourceHeight),
        right: clamp((region.x + region.w) / sourceWidth),
        bottom: clamp((region.y + region.h) / sourceHeight)
    };
    if (crop.right <= crop.left || crop.bottom <= crop.top) {
        throw new Error(`cannot crop: region ${JSON.stringify(region)} falls outside the ${sourceWidth}x${sourceHeight} source`);
    }

    const res = await fetch(`${nMediaUrl}/v1/process/image/crop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, crop, quality: qualityValue, format })
    });
    if (!res.ok) throw new Error(`nMedia crop ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const first = (json.crops ?? json.data?.crops ?? [])[0];
    if (!first?.base64) throw new Error('nMedia crop returned no image');
    return {
        base64: stripDataUri(first.base64),
        width: first.width ?? region.w,
        height: first.height ?? region.h
    };
}

async function nmediaFit(base64, { format, maxDimension, qualityValue }) {
    const res = await fetch(`${nMediaUrl}/v1/process/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            base64,
            format,
            max_dimension: maxDimension,
            quality: qualityValue,
            response_type: 'base64'
        })
    });
    if (!res.ok) throw new Error(`nMedia ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const payload = json.data ?? json;
    if (!payload.base64) throw new Error('nMedia returned no image');
    return { base64: stripDataUri(payload.base64), width: payload.width, height: payload.height };
}

export async function image_ingest(args) {
    const sources = Array.isArray(args?.sources) ? args.sources : [args?.source];
    if (sources.length === 0 || sources.some((s) => typeof s !== 'string' || !s.trim())) {
        throw new Error('image_ingest: "source" (string) or "sources" (array of strings) is required');
    }
    if (sources.length > INGEST_MAX_SOURCES) {
        throw new Error(`image_ingest: at most ${INGEST_MAX_SOURCES} images per call (${sources.length} given). A contact sheet is the caller's job.`);
    }

    const maxDimension = args?.max_dimension ?? 1600;
    const format = ['webp', 'jpeg', 'png'].includes(args?.format) ? args.format : 'png';
    const qualityValue = Math.min(100, Math.max(1, args?.quality ?? 82));
    const region = args?.region ?? null;
    const upscale = Math.min(3, Math.max(1, args?.upscale ?? 1));

    if (region && !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(region[k]))) {
        throw new Error('image_ingest: region needs numeric x, y, w, h in source pixels');
    }

    const images = [];
    const metas = [];

    for (const source of sources) {
        const resolved = resolveIngestSource(source);
        let buf;
        let mime = null;

        if (resolved.kind === 'url') {
            const res = await fetch(resolved.url, { signal: AbortSignal.timeout(30000) });
            if (!res.ok) throw new Error(`image_ingest: ${resolved.url} → ${res.status}`);
            buf = Buffer.from(await res.arrayBuffer());
            mime = res.headers.get('content-type');
        } else if (resolved.kind === 'data') {
            const m = /^data:([^;]+);base64,(.*)$/s.exec(resolved.uri);
            if (!m) throw new Error('image_ingest: malformed data URI');
            mime = m[1];
            buf = Buffer.from(m[2], 'base64');
        } else {
            buf = fs.readFileSync(resolved.path);
        }

        if (buf.length > ingestMaxSourceBytes) {
            throw new Error(`image_ingest: ${source} is ${(buf.length / 1048576).toFixed(1)} MB — over the ${Math.round(ingestMaxSourceBytes / 1048576)} MB source limit`);
        }

        const probed = imageSize(buf);
        const originalSize = [probed.width, probed.height];
        let current = {
            base64: buf.toString('base64'),
            width: probed.width,
            height: probed.height,
            mime: probed.mime ?? mime ?? mimeFromExt(source)
        };
        let resizedBy = 'passthrough';
        let cropApplied = null;
        let upscaled = false;
        const isSvg = /<svg[\s>]/i.test(buf.subarray(0, 1024).toString('utf8'));
        const longest = Math.max(current.width ?? 0, current.height ?? 0);
        const cap = maxDimension > 0 ? maxDimension : 0;
        const wantLongest = upscale > 1 && longest > 0 ? Math.round(longest * upscale) : null;

        // Order matters, and nMedia's limits dictate it: max_dimension is a TARGET
        // for an SVG (it rasterizes bigger) but a cap for a raster (it never
        // enlarges), and crop and resize do not combine in one call. So an SVG is
        // rendered at the working size first, the region is cut from that raster,
        // and a bitmap is only ever shrunk afterwards.
        if (isSvg) {
            const renderTarget = wantLongest ?? (cap && (longest === 0 || longest > cap) ? cap : null);
            if (renderTarget && renderTarget !== longest) {
                try {
                    const fitted = await nmediaFit(current.base64, { format, maxDimension: renderTarget, qualityValue });
                    current = { ...fitted, mime: `image/${format}` };
                    resizedBy = 'nmedia';
                    upscaled = renderTarget > longest;
                } catch (err) {
                    logger.warn(`[image] ingest rasterize failed for ${source}: ${err.message}`, null, 'Image');
                }
            }
        }

        // A requested format is a promise. Without this, asking for png on an image
        // that needs no resize returned the original webp bytes labelled webp —
        // which is how a host that rejects webp rejected a call that asked for png.
        if (current.mime !== `image/${format}`) {
            try {
                const native = Math.max(current.width ?? 0, current.height ?? 0) || cap || 1024;
                const fitted = await nmediaFit(current.base64, { format, maxDimension: Math.round(native), qualityValue });
                current = { ...fitted, mime: `image/${format}` };
                resizedBy = 'nmedia';
            } catch (err) {
                logger.warn(`[image] ingest format conversion failed for ${source}: ${err.message}`, null, 'Image');
            }
        }

        if (region) {
            try {
                // The region is in SOURCE pixels, so the fractions are computed from
                // the source size — not from the working raster, which may already
                // have been rendered larger.
                const sourceDims = [probed.width ?? current.width, probed.height ?? current.height];
                const cropped = await nmediaCrop(current.base64, region, sourceDims, format, qualityValue);
                current = { ...cropped, mime: `image/${format}` };
                cropApplied = region;
                resizedBy = 'nmedia';
                if (upscale > 1) upscaled = true;
            } catch (err) {
                logger.warn(`[image] ingest crop failed for ${source}: ${err.message}`, null, 'Image');
            }
        }

        // A bitmap is only ever shrunk, and only after cropping.
        if (!isSvg && cap) {
            const l = Math.max(current.width ?? 0, current.height ?? 0);
            if (l > cap) {
                try {
                    const fitted = await nmediaFit(current.base64, { format, maxDimension: cap, qualityValue });
                    current = { ...fitted, mime: `image/${format}` };
                    resizedBy = 'nmedia';
                } catch (err) {
                    logger.warn(`[image] ingest resize failed for ${source}: ${err.message}`, null, 'Image');
                }
            }
        }

        // A block over the ceiling is worse than a smaller picture: halve until it
        // fits rather than truncating, which would corrupt it.
        let guard = 0;
        while (current.base64.length > ingestMaxBlockBytes && guard < 3) {
            const next = Math.max(320, Math.round((current.width || cap) * 0.6));
            const fitted = await nmediaFit(current.base64, { format, maxDimension: next, qualityValue });
            current = { ...fitted, mime: `image/${format}` };
            resizedBy = 'nmedia';
            guard += 1;
        }
        if (current.base64.length > ingestMaxBlockBytes) {
            throw new Error(`image_ingest: ${source} still returns ${(current.base64.length / 1048576).toFixed(1)} MB of base64 after three downscales — reduce max_dimension or crop a region`);
        }

        images.push({ type: 'image', data: current.base64, mimeType: current.mime });
        metas.push({
            source,
            resolved: resolved.path ?? resolved.url ?? '(data uri)',
            originalBytes: buf.length,
            returnedBytes: Buffer.from(current.base64, 'base64').length,
            originalSize,
            returnedSize: [current.width, current.height],
            crop: cropApplied,
            upscale: upscale > 1 ? (upscaled ? upscale : 'refused: nMedia cannot enlarge a bitmap — pass an SVG or a larger source') : null,
            format,
            quality: qualityValue,
            resizedBy
        });
    }

    const label = typeof args?.label === 'string' && args.label.trim() ? `${args.label.trim()}\n\n` : '';
    const text = `${label}${JSON.stringify({ images: metas, count: metas.length }, null, 2)}\n\n` +
        'if you cannot see an image above, this client or model did not accept the image block — say so rather than guessing what it contained.';

    return { content: [...images, { type: 'text', text }], isError: false };
}
