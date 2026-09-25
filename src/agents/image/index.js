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

        const variants = await Promise.all(sizes.map(s => renderVariant(raw, s.maxDimension)));

        const dir = path.join(storageRoot, imageDir);
        const files = {};
        let thumb = null;
        for (let v = 0; v < sizes.length; v++) {
            const fileName = `${base}_${sizes[v].name}.webp`;
            const buf = Buffer.from(variants[v].base64, 'base64');
            fs.writeFileSync(path.join(dir, fileName), buf);
            const relPath = `${imageDir}/${fileName}`;
            files[sizes[v].name] = { path: relPath, width: variants[v].width, height: variants[v].height, bytes: buf.length };
            if (sizes[v].name === '1280') thumb = variants[v].base64; // largest derived variant — inline preview keeps the detail
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

        outputs.push({ base, sidecar: `${imageDir}/${sidecarName}`, files, thumb });
        logger.info(`[image] Wrote ${base} (${Object.keys(files).length} sizes + sidecar)`, null, 'Image');
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
    const text = `Generated ${outputs.length} image${outputs.length > 1 ? 's' : ''} · model ${model}${cost}\n\n${lines.join('\n\n')}\n\nCopy whichever sizes you need from storage (images/). Full prompt, parameters, usage and lineage are in the .json sidecar.`;

    const content = [{ type: 'text', text }];
    if (outputs[0].thumb) {
        content.push({ type: 'image', data: outputs[0].thumb, mimeType: 'image/webp' });
    }
    return { content, isError: false };
}
