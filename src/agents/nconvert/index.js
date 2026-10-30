// nConvert agent — thin JS wrapper around the Rust core (nConvert/napi).
// Owns everything the core must not: storage I/O, the artefact folder on disk,
// config, the vision/OCR hand-off, and the layered reader. Content logic lives
// in Rust; this file moves bytes, calls providers, and reports loudly.
//
// Artefact model (spec §2.6) — nothing lost, layers added for discovery:
//   L0 summary.md · L1 document.md (+ mechanical) · L2 assets/, pages/
//   L3 original · item.json manifest

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { getLogger } from '../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const logger = getLogger();

let storageRoot;
let storagePublicUrl;
let ingestDir;
let conf;
let native;
let gateway;

export async function init(context) {
    storageRoot = context.config.agents?.storage?.root;
    if (!storageRoot) throw new Error('[nconvert] config agents.storage.root is required');
    storagePublicUrl = (context.config.agents?.storage?.publicUrl || '').replace(/\/+$/, '');
    gateway = context.gateway;

    conf = {
        folder: 'ingest',
        maxInputMb: 100,
        maxExpandedMb: 500,
        maxOutputMb: 64,
        maxTableRows: 10000,
        assets: true,
        keepOriginal: true,
        pdfiumPath: 'nConvert/napi/pdfium/bin',
        pageWidth: 1240,
        chunkPages: 8,
        coverageThreshold: 0.98,
        maxDeepPages: 200,
        summary: true,
        ...(context.config.agents?.nconvert ?? {})
    };

    ingestDir = path.join(storageRoot, conf.folder);
    fs.mkdirSync(ingestDir, { recursive: true });

    native = require('../../../nConvert/napi/index.js');

    return { status: 'initialized', folder: conf.folder };
}

// ─── small helpers ───────────────────────────────────────────────────────

function toMb(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function slugify(text) {
    return String(text).toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim().split(/\s+/).slice(0, 6).join('-')
        .replace(/-+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'document';
}

function localTimestamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function uniqueFolder(base) {
    let candidate = path.join(ingestDir, base);
    let i = 2;
    while (fs.existsSync(candidate)) candidate = path.join(ingestDir, `${base}-${i++}`);
    return candidate;
}

function resolveInput(inputPath) {
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
        throw new Error('nconvert.convert: "path" is required');
    }
    const absolute = path.isAbsolute(inputPath) ? inputPath : path.join(storageRoot, inputPath);
    if (!fs.existsSync(absolute)) {
        throw new Error(`nconvert.convert: file not found: ${inputPath} (resolved: ${absolute})`);
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error(`nconvert.convert: not a file: ${inputPath}`);
    return { absolute, size: stat.size };
}

// Asset names from containers are data, not paths — basename + strip before
// they ever touch the filesystem (zip-slip guard, spec §2.3).
function sanitizeBasename(name) {
    const base = path.basename(String(name)).replace(/[^a-zA-Z0-9._ -]/g, '_');
    return base === '' || base === '.' || base === '..' ? 'asset' : base;
}

function relToStorage(p) {
    return path.relative(storageRoot, p).replaceAll('\\', '/');
}

// ─── deep conversion (spec §2.5) ─────────────────────────────────────────
// Mechanical text is the CONTENT AUTHORITY: the model decides structure only
// and emits [[FIGURE:page|caption]] markers — never MD-Blocks directives. We
// translate the markers, so untrusted model output cannot inject syntax.

function pdfiumDir() {
    return path.isAbsolute(conf.pdfiumPath)
        ? conf.pdfiumPath
        : path.resolve(__dirname, '..', '..', '..', conf.pdfiumPath);
}

async function renderPages(bytes) {
    const envelope = await native.renderPages(bytes, pdfiumDir(), conf.pageWidth, conf.maxDeepPages, []);
    return JSON.parse(envelope).pages;
}

// Mechanical PDF text concatenates adjacent runs ("installationchapter") where
// the model correctly writes two words. Such a token is covered when it can be
// rebuilt from output words.
function isCoveredByParts(word, outputSet, depth = 0) {
    if (outputSet.has(word)) return true;
    if (depth > 3 || word.length < 8) return false;
    for (let i = 5; i <= word.length - 5; i++) {
        const head = word.slice(0, i);
        const tail = word.slice(i);
        if (outputSet.has(head) && isCoveredByParts(tail, outputSet, depth + 1)) return true;
    }
    return false;
}

// Fraction of the AUTHORITATIVE vocabulary present in the model output.
// Measures information loss, not repetition: unique words only, hyphenated
// line-breaks joined, page furniture (running headers) excluded — omitting
// those is correct behaviour, not loss.
function textCoverage(pageTexts, outputText) {
    const normalize = (t) => t
        .replace(/-\s*\n\s*/g, '')
        .toLowerCase()
        .match(/[\p{L}]{4,}/gu) || [];

    const perPage = pageTexts.map((t) => new Set(normalize(t)));
    const source = new Set(perPage.flatMap((s) => [...s]));
    if (source.size === 0) return { ratio: 1, missing: [] };

    const counts = new Map();
    for (const set of perPage) for (const w of set) counts.set(w, (counts.get(w) || 0) + 1);
    const furnitureHalf = Math.max(2, Math.ceil(perPage.length / 2));
    const furniture = new Set();
    for (const [w, c] of counts) if (c >= furnitureHalf) furniture.add(w);

    const haystack = new Set(normalize(outputText));
    const missing = [];
    let judged = 0;
    for (const w of source) {
        if (furniture.has(w)) continue;
        judged++;
        if (!isCoveredByParts(w, haystack)) missing.push(w);
    }
    if (judged === 0) return { ratio: 1, missing: [] };
    return { ratio: 1 - missing.length / judged, missing };
}

// Page number from any figure reference the model might invent:
// page-074.png, page-74, pages/page_074.png, p. 74, 74.
function pageNumberFrom(reference) {
    const m = String(reference).match(/(\d{1,4})/);
    return m ? Number(m[1]) : null;
}

function chunkPrompt(fromPage, toPage, authoritativeText) {
    return [
        `You are reconstructing pages ${fromPage}-${toPage} of a document as Markdown.`,
        '',
        'You are given (a) IMAGES of those pages and (b) the page text extracted',
        'mechanically from the file. The text is AUTHORITATIVE.',
        '',
        'AUTHORITATIVE TEXT (reproduce verbatim — do not retype, summarise, translate,',
        'reorder within a paragraph, or omit anything):',
        '<<<TEXT',
        authoritativeText,
        'TEXT>>>',
        '',
        'Use the IMAGES only to judge STRUCTURE: what is a heading (and its level),',
        'where tables begin and end, which blocks belong together, and where figures',
        'sit in the reading order.',
        '',
        'Output rules:',
        '- Plain Markdown paragraphs for body text, verbatim from the authoritative text.',
        '- One heading per logical title. A title stacked across several lines is ONE heading, not several.',
        '- `#`/`##`/`###` headings where the image shows hierarchy; do not invent deeper levels.',
        '- GFM pipe tables for tables (real cell contents from the text).',
        '- For every figure/diagram/photo, emit a marker on its own line:',
        '  [[FIGURE:page-NNN.png|caption text]]  — page-NNN is the page the figure is on.',
        '- Do not emit HTML comments, mb: directives, frontmatter, or commentary.',
        '- Do not invent content that is not in the text or clearly visible in the image.'
    ].join('\n');
}

// Translate [[FIGURE:page-NNN.png|caption]] into a proper MD-Blocks image block.
// The model's page reference is matched by NUMBER — it may write page-74,
// page-074.png or pages/page_074.png; all mean the same page.
function applyFigureMarkers(markdown, renderedIndices) {
    let rejected = 0;
    const out = markdown.replace(/\[\[FIGURE:([^|\]]+)\|([^\]]*)\]\]/g, (_m, file, caption) => {
        const num = pageNumberFrom(file);
        if (num == null || !renderedIndices.has(num)) {
            rejected++;
            return `*(figure ${String(file).trim()} — page image unavailable)*`;
        }
        const name = `page-${String(num).padStart(3, '0')}.png`;
        return [
            '<!-- mb:block preset=image -->',
            `![${String(caption || '').replace(/[\[\]]/g, '').trim() || name}](pages/${name})`,
            String(caption || '').trim(),
            '<!-- mb:/block -->'
        ].filter(Boolean).join('\n');
    });
    return { markdown: out, rejected };
}

// Strip anything directive-shaped a model might still emit, so only our own
// translated blocks carry structure (untrusted-output rule, spec §2.2).
function stripDirectiveSyntax(markdown) {
    return markdown
        .replace(/<!--\s*mb:.*?-->/g, '')
        .replace(/^\s*---\s*$/gm, '');
}

async function deepConvert({ bytes, env, folder }) {
    const pages = await renderPages(bytes);
    if (pages.length === 0) throw new Error('deep conversion: renderer returned no pages');

    fs.mkdirSync(path.join(folder, 'pages'), { recursive: true });
    for (const p of pages) {
        fs.writeFileSync(
            path.join(folder, 'pages', `page-${String(p.index + 1).padStart(3, '0')}.png`),
            Buffer.from(p.pngBase64, 'base64')
        );
    }
    const renderedIndices = new Set(pages.map((p) => p.index + 1));

    const texts = env.page_texts || [];
    const chunkSize = Math.max(1, conf.chunkPages);
    const chunks = [];
    for (let start = 0; start < pages.length; start += chunkSize) {
        chunks.push({ start, end: Math.min(start + chunkSize - 1, pages.length - 1) });
    }

    const warnings = [];
    const parts = [];
    const chunkReports = [];

    for (const chunk of chunks) {
        const from = chunk.start + 1;
        const to = chunk.end + 1;
        const chunkPageTexts = texts.slice(chunk.start, chunk.end + 1);
        const chunkText = chunkPageTexts.join('\n\n');

        const content = pages
            .slice(chunk.start, chunk.end + 1)
            .map((p) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${p.pngBase64}` } }));
        content.push({ type: 'text', text: chunkPrompt(from, to, chunkText) });

        let markdown;
        try {
            const response = await gateway.chat({
                task: 'vision',
                messages: [{ role: 'user', content }],
                systemPrompt: 'You reconstruct documents faithfully. You never invent content.',
                maxTokens: 8000
            });
            markdown = stripDirectiveSyntax(String(response.content || '').trim());
            if (!markdown) throw new Error('model returned no content');

            const { ratio: coverage, missing } = textCoverage(chunkPageTexts, markdown);
            if (coverage < conf.coverageThreshold) {
                const sample = missing.slice(0, 8).join(', ');
                warnings.push({
                    code: 'deep-low-coverage',
                    message: `pages ${from}-${to}: model covered ${(coverage * 100).toFixed(1)}% of the authoritative vocabulary (threshold ${(conf.coverageThreshold * 100).toFixed(0)}%) — mechanical text used instead. Missing e.g.: ${sample}${missing.length > 8 ? ` (+${missing.length - 8} more)` : ''}`
                });
                markdown = chunkText;
                chunkReports.push({ pages: `${from}-${to}`, verdict: 'fallback-low-coverage' });
            } else {
                const applied = applyFigureMarkers(markdown, renderedIndices);
                markdown = applied.markdown;
                if (applied.rejected > 0) {
                    warnings.push({
                        code: 'deep-figure-rejected',
                        message: `pages ${from}-${to}: ${applied.rejected} figure marker(s) referenced pages that were not rendered`
                    });
                }
                chunkReports.push({ pages: `${from}-${to}`, verdict: 'structured', coverage: Number(coverage.toFixed(4)) });
            }
        } catch (e) {
            warnings.push({
                code: 'deep-chunk-failed',
                message: `pages ${from}-${to}: vision pass failed (${e.message}) — mechanical text used instead`
            });
            markdown = chunkText;
            chunkReports.push({ pages: `${from}-${to}`, verdict: 'fallback-error' });
        }

        if (chunk.start > 0) parts.push('---');
        if (markdown.trim()) parts.push(markdown.trim());
    }

    return {
        markdown: parts.join('\n\n') + '\n',
        pages: pages.length,
        chunkReports,
        warnings
    };
}

// ─── the artefact: manifest, summary, layered retrieval ──────────────────

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function countIn(text, re) {
    return (text.match(re) || []).length;
}

// Split our own emitted document into MD-Blocks sections (root-level ---).
function sectionsOf(markdown) {
    const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
    return body.split(/^\s*---\s*$/m).map((s) => s.trim()).filter((s) => s.length > 0);
}

// L0: the layer that answers "what is this?" without reading the document.
async function makeSummary(documentMd, filename) {
    if (!gateway) return { text: null, reason: 'no gateway available' };
    try {
        const body = documentMd.replace(/^---\n[\s\S]*?\n---\n/, '');
        const response = await gateway.chat({
            task: 'query',
            messages: [{
                role: 'user',
                content: [
                    'Summarise this document for a retrieval index, in 150-250 words.',
                    'Say what it is, who it is for, what it covers (the main sections), and any specifics a searcher would want to match on.',
                    'Base it ONLY on the text below. No marketing language. No speculation about content that is not there.',
                    '',
                    `--- DOCUMENT: ${filename} ---`,
                    body.slice(0, 60000)
                ].join('\n')
            }],
            systemPrompt: 'You write precise retrieval summaries. You never invent content.',
            maxTokens: 700
        });
        const text = String(response.content || '').trim();
        if (!text) return { text: null, reason: 'model returned no content' };
        return { text, model: response.model ?? null };
    } catch (e) {
        return { text: null, reason: e.message };
    }
}

async function writeManifest({ folder, absolute, filename, env, depth, deep, keepOriginal, sourceSha }) {
    const documentMd = fs.readFileSync(path.join(folder, 'document.md'), 'utf8');
    const sections = sectionsOf(documentMd);
    const metaOnDisk = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));

    let summary = null;
    let summaryReason = null;
    if (conf.summary) {
        const result = await makeSummary(documentMd, filename);
        if (result.text) {
            const header = `> Retrieval summary of **${filename}** (nconvert ${depth === 'deep' ? 'deep' : 'mechanical'} conversion).\n\n`;
            fs.writeFileSync(path.join(folder, 'summary.md'), header + result.text + '\n', 'utf8');
            summary = { file: 'summary.md', model: result.model ?? null, generated: new Date().toISOString() };
        } else {
            summary = { file: null, reason: result.reason };
            summaryReason = result.reason;
        }
    }

    const pagesDir = path.join(folder, 'pages');
    const assetsDir = path.join(folder, 'assets');
    const pageCount = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir).filter((f) => f.endsWith('.png')).length : 0;
    const assetCount = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).length : 0;

    const manifest = {
        id: path.basename(folder),
        schema: 'nconvert-item/1',
        sha256: sourceSha,
        source: filename,
        sourcePath: absolute,
        ingestedAt: new Date().toISOString(),
        format: env.format,
        depth,
        converter: metaOnDisk.converter ?? `nconvert ${env.format}`,
        layers: {
            summary: summary?.file ?? null,
            document: 'document.md',
            mechanical: depth === 'deep' ? 'document.mechanical.md' : null,
            sections: { count: sections.length },
            pages: pageCount > 0 ? { count: pageCount, pattern: 'pages/page-NNN.png' } : null,
            assets: assetCount > 0 ? { count: assetCount, dir: 'assets' } : null,
            original: keepOriginal ? `original${path.extname(filename) || '.' + env.format}` : null
        },
        stats: {
            words: env.stats?.words ?? null,
            headings: countIn(documentMd, /^#{1,6} /gm),
            rows: countIn(documentMd, /^\|.*\|$/gm),
            figures: countIn(documentMd, /mb:block preset=image/g)
        },
        coverage: deep ? deep.meanCoverage : null,
        warnings: metaOnDisk.warnings ?? [],
        privacy: 'unset'
    };

    fs.writeFileSync(path.join(folder, 'item.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { manifest, sections, summaryReason };
}

function readManifest(itemDir) {
    const file = path.join(itemDir, 'item.json');
    if (!fs.existsSync(file)) throw new Error(`not an nconvert item: ${file} missing`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ─── handlers ────────────────────────────────────────────────────────────

export async function nconvert_convert(args) {
    const { absolute, size } = resolveInput(args?.path);
    const maxInputBytes = conf.maxInputMb * 1024 * 1024;
    if (size > maxInputBytes) {
        throw new Error(`nconvert.convert: input too large: ${toMb(size)} exceeds maxInputMb=${conf.maxInputMb}`);
    }

    const bytes = fs.readFileSync(absolute);
    const filename = path.basename(absolute);
    const optionsJson = JSON.stringify({
        max_input_bytes: maxInputBytes,
        max_output_bytes: conf.maxOutputMb * 1024 * 1024,
        max_table_rows: conf.maxTableRows,
        max_cells: 1000000
    });

    const env = JSON.parse(await native.convert(bytes, filename, optionsJson));

    if (env.status === 'needs_ocr') {
        throw new Error(
            `nconvert.convert: '${filename}' detected as ${env.format} and needs OCR — the provider hand-off lands in M5 (spec §9). ${env.pages.length} page image(s) prepared.`
        );
    }

    const depth = args?.depth ?? 'mechanical';
    if (depth !== 'mechanical' && depth !== 'deep') {
        throw new Error(`nconvert.convert: depth must be "mechanical" or "deep", got "${depth}"`);
    }
    if (depth === 'deep' && env.format !== 'pdf') {
        throw new Error(`nconvert.convert: deep conversion is PDF-only for now (got ${env.format}) — the rasterizer is the gate (spec §2.5)`);
    }

    const keepOriginal = args?.keepOriginal ?? conf.keepOriginal;
    const extractAssets = args?.assets ?? conf.assets;

    const slug = slugify(args?.name || path.basename(filename, path.extname(filename)));
    const folder = uniqueFolder(`${localTimestamp()}_${slug}`);
    fs.mkdirSync(folder, { recursive: true });

    if (keepOriginal) {
        const ext = path.extname(filename) || `.${env.format}`;
        fs.copyFileSync(absolute, path.join(folder, `original${ext}`));
    }

    fs.writeFileSync(path.join(folder, 'document.md'), env.document_md, 'utf8');
    fs.writeFileSync(path.join(folder, 'meta.json'), env.meta_json, 'utf8');

    let assetsWritten = 0;
    if (extractAssets && Array.isArray(env.assets) && env.assets.length > 0) {
        fs.mkdirSync(path.join(folder, 'assets'), { recursive: true });
        for (const asset of env.assets) {
            fs.writeFileSync(path.join(folder, 'assets', sanitizeBasename(asset.name)), Buffer.from(asset.data, 'base64'));
            assetsWritten++;
        }
    }

    const meta = JSON.parse(env.meta_json);
    let documentBytes = env.document_md.length;
    let deepResult = null;
    let lines;

    if (depth === 'deep') {
        // Never-destroy rule (§2.5): the mechanical result is kept beside the
        // deep one, so a bad model run is inspectable and re-runnable.
        fs.writeFileSync(path.join(folder, 'document.mechanical.md'), env.document_md, 'utf8');

        const deep = await deepConvert({ bytes, env, folder });
        for (const w of deep.warnings) meta.warnings.push(w);

        const coverageValues = deep.chunkReports.filter((c) => c.coverage != null).map((c) => c.coverage);
        const meanCoverage = coverageValues.length
            ? coverageValues.reduce((a, b) => a + b, 0) / coverageValues.length
            : 1;

        const front = [
            '---',
            `title: ${JSON.stringify(filename)}`,
            `source: ${JSON.stringify(filename)}`,
            'format: pdf',
            'depth: deep',
            `pages: ${deep.pages}`,
            `coverage: ${(meanCoverage * 100).toFixed(1)}%`,
            `converted: ${new Date().toISOString()}`,
            'converter: nconvert deep',
            `warnings-count: ${meta.warnings.length}`,
            `assets-count: ${assetsWritten}`,
            '---',
            ''
        ].join('\n');

        const documentMd = front + deep.markdown;
        fs.writeFileSync(path.join(folder, 'document.md'), documentMd, 'utf8');
        documentBytes = documentMd.length;

        meta.depth = 'deep';
        meta.deep = {
            pagesRendered: deep.pages,
            chunks: deep.chunkReports,
            meanCoverage: Number(meanCoverage.toFixed(4)),
            mechanicalDocument: 'document.mechanical.md'
        };
        meta.stats.warnings = meta.warnings.length;
        fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

        lines = [
            `Ingested ${filename} (${env.format}, DEEP) → ${relToStorage(folder)}/`,
            `  document.md — structured by vision over ${deep.pages} rendered page(s), coverage ${(meanCoverage * 100).toFixed(1)}%`,
            '  document.mechanical.md — the deterministic result, kept for comparison',
            `  pages/ — ${deep.pages} page image(s) at ${conf.pageWidth}px`,
            `  chunks: ${deep.chunkReports.map((c) => `${c.pages}:${c.verdict}`).join(', ')}`,
            `  assets: ${assetsWritten}, original: ${keepOriginal ? 'kept' : 'not kept'}`
        ];
        deepResult = { meanCoverage };
    } else {
        lines = [
            `Ingested ${filename} (${env.format}) → ${relToStorage(folder)}/`,
            `  document.md — ${env.stats.blocks} blocks, ${env.stats.words} words, ${toMb(documentBytes)} Markdown`,
            `  detection: ${env.detection}`,
            `  assets: ${assetsWritten}${extractAssets ? '' : ' (extraction disabled by request)'}`,
            `  original: ${keepOriginal ? `kept (${toMb(size)})` : 'not kept (by request)'}`
        ];
    }

    if (meta.warnings?.length) {
        lines.push(`  warnings (${meta.warnings.length}):`);
        for (const w of meta.warnings) lines.push(`    [${w.code}] ${w.message}`);
    } else {
        lines.push('  warnings: none');
    }

    // The artefact becomes a layered object: manifest + summary make it
    // discoverable and navigable.
    const sourceSha = sha256File(absolute);
    const { manifest, summaryReason } = await writeManifest({
        folder, absolute, filename, env, depth, deep: deepResult, keepOriginal, sourceSha
    });
    lines.push(`  manifest: item.json · sha256 ${sourceSha.slice(0, 12)}…`);
    if (manifest.layers.summary) {
        lines.push('  summary.md — L0 retrieval summary; dig deeper with nconvert.fetch');
    } else if (summaryReason) {
        lines.push(`  summary: not generated (${summaryReason})`);
    }

    logger.info(`nconvert: ${filename} (${env.format}${depth === 'deep' ? ', deep' : ''}) → ${relToStorage(folder)}`, null, 'nconvert');
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
}

export async function nconvert_items(args) {
    const limit = Math.min(Number(args?.limit ?? 20), 100);
    const entries = fs.existsSync(ingestDir)
        ? fs.readdirSync(ingestDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
            .map((e) => path.join(ingestDir, e.name))
            .filter((dir) => fs.existsSync(path.join(dir, 'item.json')))
            .sort()
            .reverse()
            .slice(0, limit)
        : [];

    if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No ingested items yet. Use nconvert.convert first.' }], isError: false };
    }

    const lines = [`${entries.length} ingested item(s), newest first:`, ''];
    for (const dir of entries) {
        const m = readManifest(dir);
        const bits = [
            m.id,
            `  source: ${m.source}`,
            `  format: ${m.format}${m.depth === 'deep' ? ' · deep' : ''}${m.layers.pages ? ` · ${m.layers.pages.count} pages` : ''} · ${m.layers.sections.count} sections`,
            `  layers: ${['summary', 'document', 'mechanical', 'pages', 'assets', 'original'].filter((l) => m.layers[l]).join(', ')}`
        ];
        if (m.stats.words) bits.push(`  ~${m.stats.words} words · ${m.stats.headings} headings · ${m.stats.figures} figures`);
        lines.push(bits.join('\n'));
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
}

// The layer reader: a caller names the layer it needs and gets exactly that.
// Text layers return content; binary layers return a path + URL, because the
// caller fetches bytes with its own tool (and can attach images directly).
export async function nconvert_fetch(args) {
    const item = args?.item;
    if (!item) throw new Error('nconvert.fetch: "item" is required (see nconvert.items)');
    const itemDir = path.join(ingestDir, path.basename(String(item)));
    if (!fs.existsSync(itemDir)) throw new Error(`nconvert.fetch: no such item: ${item}`);
    const manifest = readManifest(itemDir);
    const layer = args?.layer ?? 'summary';

    const describe = (p, extra = '') => {
        const stat = fs.statSync(p);
        const rel = relToStorage(p);
        return `${layer} layer of ${manifest.id}\n  path: ${rel}\n  url: ${storagePublicUrl ? `${storagePublicUrl}/storage/${rel}` : '(no publicUrl configured)'}\n  size: ${stat.size} bytes${extra}`;
    };

    switch (layer) {
        case 'summary': {
            if (!manifest.layers.summary) {
                throw new Error('nconvert.fetch: this item has no summary (generation unavailable or disabled) — use layer "document"');
            }
            return { content: [{ type: 'text', text: fs.readFileSync(path.join(itemDir, manifest.layers.summary), 'utf8') }], isError: false };
        }
        case 'document': {
            const file = path.join(itemDir, manifest.layers.document);
            const md = fs.readFileSync(file, 'utf8');
            if (args?.section != null) {
                const sections = sectionsOf(md);
                const idx = Number(args.section);
                if (!Number.isInteger(idx) || idx < 0 || idx >= sections.length) {
                    throw new Error(`nconvert.fetch: section ${args.section} out of range (0-${sections.length - 1})`);
                }
                return { content: [{ type: 'text', text: `section ${idx} of ${sections.length} in ${manifest.id}:\n\n${sections[idx]}` }], isError: false };
            }
            if (args?.maxChars && md.length > args.maxChars) {
                return {
                    content: [{ type: 'text', text: `${md.slice(0, args.maxChars)}\n\n[truncated at ${args.maxChars} of ${md.length} chars — use section: N for a specific part]\n  path: ${relToStorage(file)}` }],
                    isError: false
                };
            }
            return { content: [{ type: 'text', text: md }], isError: false };
        }
        case 'mechanical': {
            if (!manifest.layers.mechanical) throw new Error('nconvert.fetch: no mechanical document for this item (mechanical depth only)');
            return { content: [{ type: 'text', text: fs.readFileSync(path.join(itemDir, manifest.layers.mechanical), 'utf8') }], isError: false };
        }
        case 'page': {
            if (!manifest.layers.pages) throw new Error('nconvert.fetch: this item has no rasterized pages (convert with depth "deep")');
            const page = Number(args?.page);
            if (!Number.isInteger(page) || page < 1 || page > manifest.layers.pages.count) {
                throw new Error(`nconvert.fetch: page ${args?.page} out of range (1-${manifest.layers.pages.count})`);
            }
            const file = path.join(itemDir, 'pages', `page-${String(page).padStart(3, '0')}.png`);
            if (!fs.existsSync(file)) throw new Error(`nconvert.fetch: page ${page} file missing: ${relToStorage(file)}`);
            return { content: [{ type: 'text', text: describe(file) }], isError: false };
        }
        case 'asset': {
            const name = path.basename(String(args?.asset ?? ''));
            const file = path.join(itemDir, 'assets', name);
            if (!name || !fs.existsSync(file)) {
                throw new Error(`nconvert.fetch: no asset "${args?.asset}" (dir: ${relToStorage(path.join(itemDir, 'assets'))})`);
            }
            return { content: [{ type: 'text', text: describe(file) }], isError: false };
        }
        case 'original': {
            if (!manifest.layers.original) throw new Error('nconvert.fetch: original was not kept for this item (keepOriginal: false)');
            return { content: [{ type: 'text', text: describe(path.join(itemDir, manifest.layers.original)) }], isError: false };
        }
        default:
            throw new Error(`nconvert.fetch: unknown layer "${layer}" — one of: summary, document, mechanical, page, asset, original`);
    }
}

const FORMAT_MATRIX = [
    { format: 'txt', phase: 'M1', note: 'encoding sniff incl. UTF-16; paragraphs' },
    { format: 'csv', phase: 'M1', note: 'RFC4180, delimiter sniff (, ; tab) → GFM table' },
    { format: 'tsv', phase: 'M1', note: 'tab variant of the csv route' },
    { format: 'md', phase: 'M1', note: 'validated passthrough — no IR round-trip, MD-Blocks directives survive' },
    { format: 'json', phase: 'M1', note: 'validity-checked, canonical pretty-print in a fenced block' },
    { format: 'yaml', phase: 'M1', note: 'fenced verbatim, syntax unchecked' },
    { format: 'toml', phase: 'M1', note: 'fenced verbatim, syntax unchecked' },
    { format: 'xml', phase: 'M1', note: 'fenced verbatim, syntax unchecked' },
    { format: 'html', phase: 'M2', note: 'html5ever port of the JS serialization mapping' },
    { format: 'docx', phase: 'M3', note: 'OOXML walk; charts as data tables' },
    { format: 'pptx', phase: 'M3', note: 'one section per slide; speaker notes → narration blocks' },
    { format: 'xlsx', phase: 'M3', note: 'calamine; sheet per section' },
    { format: 'ods', phase: 'M3', note: 'ODF spreadsheet' },
    { format: 'odt', phase: 'M3', note: 'ODF text' },
    { format: 'epub', phase: 'M3', note: 'spine order, one section per chapter' },
    { format: 'eml', phase: 'M3', note: 'mail-parser; MIME trees, attachments as assets' },
    { format: 'pdf', phase: 'M4 · live', note: 'per-page text + embedded images as assets (JPX→PNG, DCT→jpg, flate→PNG); AES-256/R6 auto-decrypts; PDFium rasterization for deep conversion' },
    { format: 'image', phase: 'M5', note: 'OCR provider hand-off (multi-page); needs_ocr returned today' },
    { format: 'rtf', phase: 'M6', note: 'hand parser for supported control words' },
    { format: 'cfb', phase: 'M6', note: 'legacy .doc/.msg container' }
];

export async function nconvert_capabilities() {
    const payload = {
        converter: 'nconvert 0.4.1',
        spec: 'docs/nconvert-spec.md v2.1',
        artefact: 'layered item under storage ingest/: L0 summary.md · L1 document.md (+mechanical) · L2 assets/, pages/ · L3 original · item.json manifest',
        limits: {
            maxInputMb: conf.maxInputMb,
            maxExpandedMb: conf.maxExpandedMb,
            maxOutputMb: conf.maxOutputMb,
            maxTableRows: conf.maxTableRows
        },
        deep: {
            available: true,
            scope: 'pdf',
            renderer: `PDFium @ ${conf.pdfiumPath}`,
            pageWidth: conf.pageWidth,
            chunkPages: conf.chunkPages,
            coverageThreshold: conf.coverageThreshold,
            maxDeepPages: conf.maxDeepPages,
            note: 'depth:"deep" renders pages and has a vision model reconstruct structure over the mechanically extracted text; document.mechanical.md is always kept'
        },
        summary: { enabled: Boolean(conf.summary), layer: 'summary.md' },
        formats: FORMAT_MATRIX
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false };
}
