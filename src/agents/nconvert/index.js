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
import { getLogger } from '../../utils/logger.js';
import { IngestQueue } from './queue.js';
import { NativeProcessPool } from './native-process-pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = getLogger();

let storageRoot;
let storagePublicUrl;
let ingestDir;
let conf;
let gateway;
let nativePool;
let queue;
let engineVersion;

export async function init(context) {
    storageRoot = context.config.agents?.storage?.root;
    if (!storageRoot) throw new Error('[nconvert] config agents.storage.root is required');
    storagePublicUrl = (context.config.agents?.storage?.publicUrl || '').replace(/\/+$/, '');
    gateway = context.gateway;
    summaryActive = 0;
    summaryWaiters.length = 0;

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
        // P0 (2026-11-07): guards are diagnostics, not gates. A chunk below the
        // threshold ships with the gap recorded; it is never replaced by the
        // mechanical text, and no corrective retry runs by default — the retry
        // doubled work on chunks that had lost nothing and could erase an
        // attempt that had already measured.
        coverageRetry: false,
        maxDeepPages: 200,
        summary: true,
        // Native work runs in a bounded process pool. Small mechanical jobs
        // scale across cores; deep/large jobs stay limited independently.
        heavyMb: 25,
        nativeProcesses: 16,
        maxConcurrentJobs: 16,
        maxHeavyJobs: 1,
        maxSummaryJobs: 4,
        summaryModels: ['deepseek-flash-chat', 'minimax-m31-flash-chat'],
        // Measured 2026-11-07: a vision call whose max_tokens sits below the
        // model's reasoning length returns "streamed reasoning but never
        // produced an answer" — silently, in ~5 s, and looking like a broken
        // model. 800 and 8000 both starved it; 32000 answered the same page
        // correctly. The budget is a ceiling, not a reservation, so it must
        // clear the thinking, not the expected answer.
        visionModel: 'deepseek-flash-chat',
        visionFallbackModels: ['minimax-m31-flash-chat'],
        visionMaxTokens: 32000,
        // The audit is genuinely useful but costs one large-model call per
        // document, so it runs on demand (nconvert.verify) rather than after
        // every ingest.
        verify: false,
        verifyModel: 'kimi-k31-chat',
        verifyFallbackModels: ['deepseek-chat'],
        queueMaxHistory: 200,
        ...(context.config.agents?.nconvert ?? {})
    };

    ingestDir = path.join(storageRoot, conf.folder);
    fs.mkdirSync(ingestDir, { recursive: true });

    // The staged binary is named from this same field (napi/setup.js), so it is
    // the version actually loaded — never hardcode it here.
    const enginePkgPath = path.join(__dirname, '..', '..', '..', 'nConvert', 'package.json');
    engineVersion = JSON.parse(fs.readFileSync(enginePkgPath, 'utf8')).version;
    if (typeof engineVersion !== 'string' || !engineVersion) {
        throw new Error(`[nconvert] ${enginePkgPath} carries no version`);
    }

    if (!Number.isInteger(conf.maxSummaryJobs) || conf.maxSummaryJobs < 1) {
        throw new Error('[nconvert] config agents.nconvert.maxSummaryJobs must be a positive integer');
    }
    if (!Array.isArray(conf.summaryModels) || conf.summaryModels.length === 0 || conf.summaryModels.some((model) => typeof model !== 'string' || !model)) {
        throw new Error('[nconvert] config agents.nconvert.summaryModels must be a non-empty string array');
    }
    if (typeof conf.visionModel !== 'string' || !conf.visionModel) {
        throw new Error('[nconvert] config agents.nconvert.visionModel must be a non-empty string');
    }
    if (!Array.isArray(conf.visionFallbackModels) || conf.visionFallbackModels.some((model) => typeof model !== 'string' || !model)) {
        throw new Error('[nconvert] config agents.nconvert.visionFallbackModels must be a string array');
    }
    if (!Number.isInteger(conf.visionMaxTokens) || conf.visionMaxTokens < 1) {
        throw new Error('[nconvert] config agents.nconvert.visionMaxTokens must be a positive integer — a budget below the model\'s reasoning length silently produces no answer');
    }
    if (typeof conf.verifyModel !== 'string' || !conf.verifyModel) {
        throw new Error('[nconvert] config agents.nconvert.verifyModel must be a non-empty string');
    }
    if (!Array.isArray(conf.verifyFallbackModels) || conf.verifyFallbackModels.some((model) => typeof model !== 'string' || !model)) {
        throw new Error('[nconvert] config agents.nconvert.verifyFallbackModels must be a string array');
    }

    nativePool = new NativeProcessPool({
        size: conf.nativeProcesses,
        workerFile: path.join(__dirname, 'native-worker.js'),
        tmpDir: path.resolve(__dirname, '..', '..', '..', 'data', 'nconvert', 'native-results')
    });

    const queueFile = path.resolve(__dirname, '..', '..', '..', 'data', 'nconvert', 'jobs.json');
    queue = new IngestQueue({
        file: queueFile,
        executor: runIngestion,
        maxHistory: conf.queueMaxHistory,
        concurrency: conf.maxConcurrentJobs,
        heavyConcurrency: conf.maxHeavyJobs
    });

    return { status: 'initialized', folder: conf.folder };
}

// Exposed for the REST/SSE routes in server.js.
export function getQueue() {
    if (!queue) throw new Error('[nconvert] agent not initialized');
    return queue;
}

export async function shutdown() {
    if (nativePool) await nativePool.close();
    nativePool = null;
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

async function renderPages(source, onlyPages, folder) {
    // A chunk fans out by page. Each worker owns an independent PDFium
    // instance; the global pool bounds how many parse/render operations run.
    const groups = onlyPages.length > 0 ? onlyPages.map((page) => [page]) : [[]];
    const results = await Promise.all(groups.map((pages) => nativePool.run({
        op: 'render',
        source,
        dllDir: pdfiumDir(),
        targetWidth: conf.pageWidth,
        maxPages: conf.maxDeepPages,
        onlyPages: pages,
        folder
    })));
    return results.flatMap((result) => result.pages).sort((a, b) => a.index - b.index);
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

// Numbers, amounts, dates and identifiers are what "facts" means in practice,
// and the word vocabulary above measures none of them — a reconstruction can
// drop every amount and still score 100 %. Compare digit runs with the
// separators a text layer and a model's retyping disagree about removed.
function factTokens(text) {
    const found = new Map();
    for (const m of String(text).matchAll(/\d(?:[\d.,:/\\-]*\d)?/g)) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length >= 3 && !found.has(digits)) found.set(digits, m[0]);
    }
    return found;
}

function factCoverage(pageTexts, outputText, pageNumbers = new Set()) {
    const isPageNumber = (digits, form) => !/[.,:/\\-]/.test(form) && pageNumbers.has(Number(digits));
    const source = new Map();
    for (const t of pageTexts) {
        for (const [digits, form] of factTokens(t)) {
            // A page number is furniture, not a fact — a model that emits
            // figures without restating "074" has dropped nothing.
            if (isPageNumber(digits, form) || source.has(digits)) continue;
            source.set(digits, form);
        }
    }
    if (source.size === 0) return { ratio: 1, missing: [], judged: 0 };
    const haystack = factTokens(outputText);
    const missing = [];
    for (const [digits, form] of source) if (!haystack.has(digits)) missing.push(form);
    return { ratio: 1 - missing.length / source.size, missing, judged: source.size };
}

// Page number from any figure reference the model might invent:
// page-074.png, page-74, pages/page_074.png, p. 74, 74.
function pageNumberFrom(reference) {
    const m = String(reference).match(/(\d{1,4})/);
    return m ? Number(m[1]) : null;
}

function chunkPrompt(fromPage, toPage, authoritativeText, missingWords = null) {
    const correction = missingWords && missingWords.length
        ? [
            '',
            'CORRECTION — your previous attempt omitted material that IS in the authoritative text.',
            'Include this material verbatim, without dropping anything:',
            missingWords.slice(0, 40).join(', '),
            'Reproduce the complete authoritative text for these pages, every word and every figure.'
        ].join('\n')
        : '';

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
        correction,
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
    ].filter((line) => line !== undefined).join('\n');
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

async function requestVision(content, { rotate = 0 } = {}) {
    // Rotate the chain on a retry: a model that returned nothing once will very
    // likely do it again, so the second attempt starts at the next provider.
    const chain = [conf.visionModel, ...conf.visionFallbackModels];
    const start = chain.length ? rotate % chain.length : 0;
    const ordered = [...chain.slice(start), ...chain.slice(0, start)];
    const failures = [];
    for (const model of ordered) {
        try {
            const response = await gateway.chat({
                model,
                messages: [{ role: 'user', content }],
                systemPrompt: 'You reconstruct documents faithfully. You never invent content.',
                maxTokens: conf.visionMaxTokens
            });
            const text = String(response.content || '').trim();
            if (!text) throw new Error('model returned no content');
            return { content: text, model };
        } catch (error) {
            failures.push(`${model}: ${error.message}`);
        }
    }
    throw new Error(failures.join(' | '));
}

async function deepConvert({ source, env, folder, progress = null }) {
    const step = async (id, opts) => { if (progress) await progress.step(id, opts); };
    const finishStep = (id, opts) => { if (progress) progress.finishStep(id, opts); };
    const checkCancelled = () => { if (progress) progress.checkCancelled(); };

    const texts = env.page_texts || [];
    const totalPages = Math.min(texts.length, conf.maxDeepPages);
    if (totalPages === 0) throw new Error('deep conversion: mechanical pass reported no pages');
    fs.mkdirSync(path.join(folder, 'pages'), { recursive: true });
    const renderedIndices = new Set();

    const chunkSize = Math.max(1, conf.chunkPages);
    const chunks = [];
    for (let start = 0; start < totalPages; start += chunkSize) {
        chunks.push({ start, end: Math.min(start + chunkSize - 1, totalPages - 1) });
    }

    const warnings = [];
    const parts = [];
    const chunkReports = [];

    for (let ci = 0; ci < chunks.length; ci++) {
        checkCancelled();
        const chunk = chunks[ci];
        const from = chunk.start + 1;
        const to = chunk.end + 1;
        const chunkPageTexts = texts.slice(chunk.start, chunk.end + 1);
        const chunkText = chunkPageTexts.join('\n\n');

        // Render only this chunk, then let the native call return before the
        // provider call. Memory stays O(chunkPages), cancellation checkpoints
        // are real, and the event loop breathes between native operations.
        await step('rendering', {
            i: ci + 1,
            n: chunks.length,
            detail: `pages ${from}-${to} at ${conf.pageWidth}px`
        });
        const onlyPages = Array.from({ length: to - from + 1 }, (_, i) => chunk.start + i);
        const pages = await renderPages(source, onlyPages, path.join(folder, 'pages'));
        if (pages.length !== onlyPages.length) {
            throw new Error(`deep conversion: renderer returned ${pages.length}/${onlyPages.length} pages for ${from}-${to}`);
        }
        for (const p of pages) renderedIndices.add(p.index + 1);
        finishStep('rendering', { detail: `pages ${from}-${to} rendered` });
        checkCancelled();
        await step('vision', { i: ci + 1, n: chunks.length });

        const content = await Promise.all(pages.map(async (p) => ({
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${(await fs.promises.readFile(p.file)).toString('base64')}` }
        })));
        content.push({ type: 'text', text: chunkPrompt(from, to, chunkText) });

        let markdown;
        let provider = null;
        try {
            // One corrective retry when the model drops text: list the missing
            // vocabulary back to it rather than lowering the guard. A failed
            // retry must not discard an attempt that already measured — the
            // page was read; only the second call died.
            let coverage = null;
            let factRatio = null;
            let missing = [];
            let missingFacts = [];
            let attempt = 0;
            const maxAttempts = conf.coverageRetry === false ? 1 : 2;
            let retryError = null;

            while (attempt < maxAttempts) {
                if (attempt > 0) {
                    await step('retry', {
                        i: ci + 1,
                        n: chunks.length,
                        detail: `${missing.length} word(s) missing — corrective retry`
                    });
                }
                let response;
                try {
                    response = await requestVision([
                        ...content.slice(0, -1),
                        { type: 'text', text: chunkPrompt(from, to, chunkText, attempt === 0 ? null : [...missingFacts, ...missing]) }
                    ], { rotate: attempt });
                } catch (error) {
                    if (attempt === 0) throw error;
                    retryError = error;
                    break;
                }
                provider = response.model;
                const candidate = stripDirectiveSyntax(response.content);
                if (!candidate) throw new Error('model returned no content');

                const measured = textCoverage(chunkPageTexts, candidate);
                const facts = factCoverage(chunkPageTexts, candidate, new Set(onlyPages.map((i) => i + 1)));
                coverage = measured.ratio;
                factRatio = facts.ratio;
                missing = measured.missing;
                missingFacts = facts.missing;
                markdown = candidate;
                attempt++;
                await step('vision', {
                    i: ci + 1,
                    n: chunks.length,
                    detail: `coverage ${(coverage * 100).toFixed(1)}%${facts.judged ? `, figures ${(factRatio * 100).toFixed(1)}%` : ''}${attempt > 1 ? ' (after retry)' : ''}`
                });
                if (coverage >= conf.coverageThreshold && factRatio >= conf.coverageThreshold) break;
            }

            if (retryError) {
                warnings.push({
                    code: 'deep-retry-failed',
                    message: `pages ${from}-${to}: corrective retry failed (${retryError.message}) — kept attempt ${attempt} at ${(coverage * 100).toFixed(1)}%`
                });
            }

            // A page that carries its own image was never rendered from text —
            // the layer is an older OCR of the same pixels, so it cannot be the
            // oracle. It only changes which warning names the gap.
            const scanLike = (env.assets ?? []).some((asset) => {
                const m = /page-(\d+)-img-/.exec(asset?.name ?? '');
                return m && Number(m[1]) >= from && Number(m[1]) <= to;
            });

            // P0 (2026-11-07): the guard is a diagnostic, not a gate. The model
            // did read the page, so refusing its structure and shipping the
            // mechanical text instead threw away real structure and every figure
            // it had kept. A chunk that measures below the threshold now ships
            // as-is with the gap recorded; document.mechanical.md stays beside
            // it for comparison.
            if (coverage < conf.coverageThreshold || factRatio < conf.coverageThreshold) {
                const gap = coverage < conf.coverageThreshold
                    ? `vocabulary ${(coverage * 100).toFixed(1)}%${factRatio == null ? '' : `, figures ${(factRatio * 100).toFixed(1)}%`}`
                    : `figures ${(factRatio * 100).toFixed(1)}% (vocabulary ${(coverage * 100).toFixed(1)}%)`;
                warnings.push(scanLike ? {
                    code: 'deep-untrusted-text-layer',
                    message: `pages ${from}-${to}: the text layer is OCR of the page image and disagrees with the vision read (${gap}) — kept the vision structure. The mechanical text stays in document.mechanical.md for comparison.`
                } : {
                    code: 'deep-low-coverage',
                    message: `pages ${from}-${to}: model measured ${gap} against the authoritative text after ${attempt} attempt(s) (threshold ${(conf.coverageThreshold * 100).toFixed(0)}%) — kept the vision structure; compare document.mechanical.md if the gap looks wrong`
                });
                const applied = applyFigureMarkers(markdown, renderedIndices);
                markdown = applied.markdown;
                if (applied.rejected > 0) {
                    warnings.push({
                        code: 'deep-figure-rejected',
                        message: `pages ${from}-${to}: ${applied.rejected} figure marker(s) referenced pages that were not rendered`
                    });
                }
                chunkReports.push({
                    pages: `${from}-${to}`,
                    verdict: scanLike ? 'structured-over-untrusted-layer' : 'kept-low-coverage',
                    model: provider,
                    coverage: Number(coverage.toFixed(4)),
                    facts: factRatio == null ? null : Number(factRatio.toFixed(4)),
                    attempts: attempt
                });
            } else {
                const applied = applyFigureMarkers(markdown, renderedIndices);
                markdown = applied.markdown;
                if (applied.rejected > 0) {
                    warnings.push({
                        code: 'deep-figure-rejected',
                        message: `pages ${from}-${to}: ${applied.rejected} figure marker(s) referenced pages that were not rendered`
                    });
                }
                chunkReports.push({
                    pages: `${from}-${to}`,
                    verdict: attempt > 1 ? 'structured-after-retry' : 'structured',
                    model: provider,
                    coverage: Number(coverage.toFixed(4)),
                    facts: factRatio == null ? null : Number(factRatio.toFixed(4)),
                    attempts: attempt
                });
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
        pages: totalPages,
        chunkReports,
        warnings
    };
}

// ─── the artefact: manifest, summary, layered retrieval ──────────────────

async function sha256File(file) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
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
// Summary generation tries cloud models in configured order. Task routing is
// deliberately bypassed: an explicit model keeps this background load off the
// local provider and makes fallback behavior deterministic.
let summaryActive = 0;
const summaryWaiters = [];

async function generateSummary(documentMd, filename) {
    if (!gateway) return { text: null, reason: 'no gateway available' };
    const body = documentMd.replace(/^---\n[\s\S]*?\n---\n/, '');
    const prompt = [
        'Summarise this document for a retrieval index, in 150-250 words.',
        'Say what it is, who it is for, what it covers (the main sections), and any specifics a searcher would want to match on.',
        'Base it ONLY on the text below. No marketing language. No speculation about content that is not there.',
        '',
        `--- DOCUMENT: ${filename} ---`,
        body.slice(0, 60000)
    ].join('\n');

    const failures = [];
    for (const model of conf.summaryModels) {
        try {
            const response = await gateway.chat({
                model,
                messages: [{ role: 'user', content: prompt }],
                systemPrompt: 'You write precise retrieval summaries. You never invent content.',
                maxTokens: 700,
                enableThinking: false
            });
            const text = String(response.content || '').trim();
            if (!text) {
                failures.push(`${model}: empty response`);
                continue;
            }
            return { text, model: response.model ?? model };
        } catch (e) {
            failures.push(`${model}: ${e.message}`);
        }
    }
    return { text: null, reason: failures.join(' | ') };
}

async function makeSummary(documentMd, filename) {
    if (summaryActive >= conf.maxSummaryJobs) {
        await new Promise((resolve) => summaryWaiters.push(resolve));
    }
    summaryActive++;
    try {
        return await generateSummary(documentMd, filename);
    } finally {
        summaryActive--;
        const next = summaryWaiters.shift();
        if (next) next();
    }
}

// ─── verification: an independent model audits what survived ──────────────
// The deterministic guard can only compare the document against the text layer.
// Where that layer is damaged the comparison is blind, and nothing in the
// artefact said how far to trust the result. A large-context model reads both
// readings plus any refused candidates, then states retention, gaps and — the
// part that keeps it honest — what it could NOT check from text alone.

async function generateVerification({ manifest, documentMd, mechanicalMd, rejectedMd, preferredModel = null }) {
    if (!gateway) return { text: null, reason: 'no gateway available' };

    const truncate = (label, text, cap) => {
        if (!text) return '';
        const clipped = text.length > cap ? `${text.slice(0, cap)}\n\n[TRUNCATED at ${cap} of ${text.length} chars — say so in your report]` : text;
        return `--- ${label} ---\n${clipped}\n`;
    };

    const prompt = [
        'You are auditing a document conversion. You did not produce it, and your job is to say honestly what survived.',
        '',
        'The SHIPPED DOCUMENT is the readable text we delivered. Any TEXT LAYER or REFUSED READING below is evidence, not truth:',
        'on a scanned file the text layer is itself an older OCR, so it can be wrong, incomplete, or mangled. Never assume the layer is right.',
        '',
        'Answer in exactly this structure:',
        '',
        '## Verdict',
        'confidence: high | medium | low',
        'One sentence: can this document be used as the record of the file, and how much checking stands behind that?',
        '',
        '## Facts present',
        '| fact | value | where it appears |',
        'Every amount, date, identifier, name and quantity you can confirm in the shipped document. Skip page numbers unless they carry meaning.',
        '',
        '## Facts at risk',
        '| fact | evidence says | document says | problem |',
        'Everything missing, altered, duplicated, or attached to the wrong row/column. Say which reading you trust and why.',
        '',
        '## Internal consistency',
        'Do the numbers agree with each other and with the document\'s own arithmetic (sums, subtotals, periods)? Name contradictions.',
        '',
        '## What this audit could not check',
        'Anything that would need the page image or the original layout, and therefore stays unverified. Be specific.',
        '',
        'Rules:',
        '- Quote values exactly as they appear; never reformat or translate them.',
        '- Never invent a fact to fill a table. An empty row is a lie.',
        '- If the document is fine, say so plainly and keep the report short.',
        '- Confidence reflects how far the evidence let you verify — not the document\'s length or your own fluency.',
        '',
        truncate('SHIPPED DOCUMENT (document.md)', documentMd, 60000),
        truncate('TEXT LAYER (document.mechanical.md — deterministic extraction)', mechanicalMd, 60000),
        truncate('REFUSED READINGS (vision reconstructions the coverage guard rejected)', rejectedMd, 30000)
    ].join('\n');

    const failures = [];
    for (const model of [preferredModel ?? conf.verifyModel, ...conf.verifyFallbackModels]) {
        try {
            const response = await gateway.chat({
                model,
                messages: [{ role: 'user', content: prompt }],
                systemPrompt: 'You audit conversions. You never invent content, and you never claim to have checked what you were not shown.',
                maxTokens: 4000,
                enableThinking: false
            });
            const text = String(response.content || '').trim();
            if (!text) {
                failures.push(`${model}: empty response`);
                continue;
            }
            const confidence = (text.match(/confidence:\s*(high|medium|low)/i) || [, null])[1];
            return { text, model: response.model ?? model, confidence: confidence ? confidence.toLowerCase() : null };
        } catch (error) {
            failures.push(`${model}: ${error.message}`);
        }
    }
    return { text: null, reason: failures.join(' | ') };
}

async function makeVerification(input, { preferredModel = null } = {}) {
    if (summaryActive >= conf.maxSummaryJobs) {
        await new Promise((resolve) => summaryWaiters.push(resolve));
    }
    summaryActive++;
    try {
        return await generateVerification({ ...input, preferredModel });
    } finally {
        summaryActive--;
        const next = summaryWaiters.shift();
        if (next) next();
    }
}

// Writes verification.md and records the verdict in the manifest. Returns the
// report so the caller can surface the confidence without re-reading disk.
async function verifyItem(itemDir, { model = null } = {}) {
    const manifest = readManifest(itemDir);
    const read = (layer) => (layer && fs.existsSync(path.join(itemDir, layer)) ? fs.readFileSync(path.join(itemDir, layer), 'utf8') : '');
    const rejectedDir = path.join(itemDir, 'rejected');
    const rejectedMd = fs.existsSync(rejectedDir)
        ? fs.readdirSync(rejectedDir).filter((f) => f.endsWith('.md')).sort()
            .map((f) => `### ${f}\n${fs.readFileSync(path.join(rejectedDir, f), 'utf8')}`).join('\n\n')
        : '';

    const result = await makeVerification({
        manifest,
        documentMd: read(manifest.layers.document),
        mechanicalMd: read(manifest.layers.mechanical),
        rejectedMd
    }, { preferredModel: model });

    if (!result.text) throw new Error(`verification failed: ${result.reason}`);

    const header = [
        '---',
        `item: ${JSON.stringify(manifest.id)}`,
        `model: ${JSON.stringify(result.model)}`,
        `generated: ${new Date().toISOString()}`,
        `confidence: ${result.confidence ?? 'unstated'}`,
        '---',
        ''
    ].join('\n');
    fs.writeFileSync(path.join(itemDir, 'verification.md'), header + result.text + '\n', 'utf8');

    manifest.layers.verification = 'verification.md';
    manifest.verification = {
        file: 'verification.md',
        model: result.model,
        generated: new Date().toISOString(),
        confidence: result.confidence ?? null
    };
    fs.writeFileSync(path.join(itemDir, 'item.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { ...result, manifest };
}

async function writeManifest({ folder, absolute, filename, env, depth, deep, keepOriginal, sourceSha, reuseKey }) {
    const documentMd = fs.readFileSync(path.join(folder, 'document.md'), 'utf8');
    const sections = sectionsOf(documentMd);
    const metaOnDisk = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
    const rejectedCount = Array.isArray(deep?.rejected) ? deep.rejected.length : 0;

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
        reuseKey,
        layers: {
            summary: summary?.file ?? null,
            document: 'document.md',
            mechanical: depth === 'deep' ? 'document.mechanical.md' : null,
            rejected: rejectedCount > 0 ? { count: rejectedCount, dir: 'rejected' } : null,
            sections: { count: sections.length },
            pages: pageCount > 0 ? { count: pageCount, pattern: 'pages/page-NNN.png' } : null,
            assets: assetCount > 0 ? { count: assetCount, dir: 'assets' } : null,
            original: keepOriginal ? `original${path.extname(filename) || '.' + env.format}` : null
        },
        stats: {
            // Measured from the document that ships, not inherited from the
            // mechanical envelope — a deep run writes different text.
            words: (documentMd.match(/\S+/g) || []).length,
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

// Repair path: an item ingested while the summary provider was unavailable
// gains its L0 layer without re-converting the document.
export async function regenerateSummary(itemId) {
    const itemDir = path.join(ingestDir, path.basename(String(itemId)));
    if (!fs.existsSync(itemDir)) throw new Error(`no such item: ${itemId}`);
    const manifest = readManifest(itemDir);
    const documentMd = fs.readFileSync(path.join(itemDir, manifest.layers.document), 'utf8');
    const result = await makeSummary(documentMd, manifest.source);
    if (!result.text) throw new Error(`summary generation failed: ${result.reason}`);

    const header = `> Retrieval summary of **${manifest.source}** (nconvert ${manifest.depth} conversion).\n\n`;
    fs.writeFileSync(path.join(itemDir, 'summary.md'), header + result.text + '\n', 'utf8');

    manifest.layers.summary = 'summary.md';
    manifest.summary = { model: result.model ?? null, generated: new Date().toISOString() };
    fs.writeFileSync(path.join(itemDir, 'item.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return { content: [{ type: 'text', text: `summary.md written for ${manifest.id} (${result.text.length} chars, model ${result.model})` }], isError: false };
}

// ─── content-addressed reuse ──────────────────────────────────────────────
// An ingest is a pure function of (source bytes, engine version, the options
// that change the output). Re-running one costs a full mechanical pass, PDFium
// renders and vision calls for bytes that were already converted, so a repeat
// submit returns the existing artefact. `force: true` reconverts.
function reuseKeyFor({ depth, keepOriginal, assets, args }) {
    const material = JSON.stringify({
        engine: engineVersion,
        depth,
        keepOriginal,
        assets,
        ocr: args?.ocr ?? null,
        vision: depth === 'deep' ? {
            model: conf.visionModel,
            fallbacks: conf.visionFallbackModels,
            maxTokens: conf.visionMaxTokens,
            pageWidth: conf.pageWidth,
            chunkPages: conf.chunkPages,
            coverageThreshold: conf.coverageThreshold,
            coverageRetry: conf.coverageRetry !== false,
            maxDeepPages: conf.maxDeepPages
        } : null
    });
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function findReusable(sha, reuseKey) {
    const entries = fs.readdirSync(ingestDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
        const manifestPath = path.join(ingestDir, entry.name, 'item.json');
        if (!fs.existsSync(manifestPath)) continue;
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (error) {
            // Artefacts are written by us but edited by humans — a broken
            // manifest must not take every future ingest down with it.
            logger.warn(`nconvert: unreadable manifest ${manifestPath}: ${error.message} — skipped for reuse`, null, 'nconvert');
            continue;
        }
        if (manifest.sha256 === sha && manifest.reuseKey === reuseKey) return manifest;
    }
    return null;
}

function reuseText(manifest) {
    const layers = Object.entries(manifest.layers ?? {}).filter(([, v]) => v).map(([k]) => k);
    return [
        `Already ingested — reusing ${manifest.id} instead of reconverting ${manifest.source}.`,
        `  item: ${relToStorage(path.join(ingestDir, manifest.id))}/`,
        `  ${manifest.depth} · ${manifest.format} · converter ${manifest.converter}`,
        `  sha256 ${String(manifest.sha256).slice(0, 12)}… · ingested ${manifest.ingestedAt}`,
        `  layers: ${layers.join(', ')}`,
        '  Same bytes, same engine, same settings — no compute spent. Pass force:true to reconvert.'
    ].join('\n');
}

// ─── handlers ────────────────────────────────────────────────────────────

// Small mechanical jobs share a bounded concurrent lane; deep and oversized
// inputs use the independently bounded heavy lane.
function isHeavy(depth, size) {
    return depth === 'deep' || size > conf.heavyMb * 1024 * 1024;
}

function stepsFor(depth) {
    return depth === 'deep'
        ? ['converting', 'rendering', 'vision', 'summarizing', 'verifying']
        : ['converting', 'summarizing'];
}

function queueText(job, { deduped = false } = {}) {
    const queued = job.state === 'queued'
        ? queue.list({ state: 'queued' }).find((j) => j.id === job.id)
        : null;
    const pos = queued ? `position ${queued.position} in queue` : job.state;
    const head = deduped
        ? `Already queued: ${path.basename(job.source)} (job ${job.id}, ${pos}) — same file, deduplicated.`
        : `Queued ${path.basename(job.source)} (${job.args?.depth ?? 'mechanical'}) → job ${job.id} (${pos}).`;
    return [
        head,
        '  Track: nconvert.job { id } · list: nconvert.jobs · events: GET /nconvert/events (SSE)',
        '  Cancel: nconvert.cancel { id }'
    ].join('\n');
}

// The single ingestion pipeline, executed through the bounded scheduler.
// progress is null-safe (tests call it directly).
async function runIngestion(job, progress = null) {
    const step = async (id, opts) => { if (progress) await progress.step(id, opts); };
    const finishStep = (id, opts) => { if (progress) progress.finishStep(id, opts); };
    const args = job.args ?? {};
    const absolute = job.source;
    const size = fs.statSync(absolute).size;
    const maxInputBytes = conf.maxInputMb * 1024 * 1024;
    if (size > maxInputBytes) {
        throw new Error(`input too large: ${toMb(size)} exceeds maxInputMb=${conf.maxInputMb}`);
    }

    await step('converting');
    const filename = path.basename(absolute);
    const optionsJson = JSON.stringify({
        max_input_bytes: maxInputBytes,
        max_output_bytes: conf.maxOutputMb * 1024 * 1024,
        max_expanded_bytes: conf.maxExpandedMb * 1024 * 1024,
        max_table_rows: conf.maxTableRows,
        max_cells: 1000000,
        // Born-digital PDF structure is measured from glyph geometry with
        // PDFium (reassessment §5 Tier 1) — not guessed from plain text.
        pdfium_path: pdfiumDir(),
        max_layout_pages: conf.maxLayoutPages ?? 0
    });

    const envelope = await nativePool.run({ op: 'convert', source: absolute, filename, optionsJson });
    const env = JSON.parse(envelope);

    if (env.status === 'needs_ocr') {
        throw new Error(
            `'${filename}' detected as ${env.format} and needs OCR — the provider hand-off lands in M5 (spec §9). ${env.pages.length} page image(s) prepared.`
        );
    }

    const depth = args.depth ?? 'mechanical';
    if (depth !== 'mechanical' && depth !== 'deep') {
        throw new Error(`depth must be "mechanical" or "deep", got "${depth}"`);
    }
    if (depth === 'deep' && env.format !== 'pdf') {
        throw new Error(`deep conversion is PDF-only for now (got ${env.format}) — the rasterizer is the gate (spec §2.5)`);
    }

    const keepOriginal = args.keepOriginal ?? conf.keepOriginal;
    const extractAssets = args.assets ?? conf.assets;
    const reuseKey = reuseKeyFor({ depth, keepOriginal, assets: extractAssets, args });

    const slug = slugify(args.name || path.basename(filename, path.extname(filename)));
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
    finishStep('converting', { detail: `${env.format}, ${env.stats.blocks} blocks` });

    const meta = JSON.parse(env.meta_json);
    let documentBytes = env.document_md.length;
    let deepResult = null;
    let lines;

    if (depth === 'deep') {
        // Never-destroy rule (§2.5): the mechanical result is kept beside the
        // deep one, so a bad model run is inspectable and re-runnable.
        fs.writeFileSync(path.join(folder, 'document.mechanical.md'), env.document_md, 'utf8');

        const deep = await deepConvert({ source: absolute, env, folder, progress });
        for (const w of deep.warnings) meta.warnings.push(w);

        const coverageValues = deep.chunkReports.filter((c) => c.coverage != null).map((c) => c.coverage);
        const structuredChunks = coverageValues.length;
        // No measured chunk means the vision pass was discarded for every
        // chunk — reporting 100% there was a lie in the shipped frontmatter.
        const meanCoverage = structuredChunks > 0
            ? coverageValues.reduce((a, b) => a + b, 0) / structuredChunks
            : null;

        const front = [
            '---',
            `title: ${JSON.stringify(filename)}`,
            `source: ${JSON.stringify(filename)}`,
            'format: pdf',
            'depth: deep',
            `pages: ${deep.pages}`,
            `coverage: ${meanCoverage == null ? 'n/a' : `${(meanCoverage * 100).toFixed(1)}%`}`,
            `chunks: ${structuredChunks}/${deep.chunkReports.length} structured`,
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
            meanCoverage: meanCoverage == null ? null : Number(meanCoverage.toFixed(4)),
            mechanicalDocument: 'document.mechanical.md'
        };
        meta.stats.warnings = meta.warnings.length;
        fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

        lines = [
            `Ingested ${filename} (${env.format}, DEEP) → ${relToStorage(folder)}/`,
            `  document.md — structured by vision over ${deep.pages} rendered page(s), coverage ${meanCoverage == null ? 'n/a (no chunk structured — mechanical text shipped)' : `${(meanCoverage * 100).toFixed(1)}% of ${structuredChunks}/${deep.chunkReports.length} chunk(s)`}`,
            '  document.mechanical.md — the deterministic result, kept for comparison',
            `  pages/ — ${deep.pages} page image(s) at ${conf.pageWidth}px`,
            `  chunks: ${deep.chunkReports.map((c) => `${c.pages}:${c.verdict}`).join(', ')}`,
            `  assets: ${assetsWritten}, original: ${keepOriginal ? 'kept' : 'not kept'}`
        ];
        deepResult = { meanCoverage, rejected: deep.rejected };
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
    await step('summarizing');
    const sourceSha = await sha256File(absolute);
    const { manifest, summaryReason } = await writeManifest({
        folder, absolute, filename, env, depth, deep: deepResult, keepOriginal, sourceSha, reuseKey
    });
    finishStep('summarizing');
    lines.push(`  manifest: item.json · sha256 ${sourceSha.slice(0, 12)}…`);
    if (manifest.layers.summary) {
        lines.push('  summary.md — L0 retrieval summary; dig deeper with nconvert.fetch');
    } else if (summaryReason) {
        lines.push(`  summary: not generated (${summaryReason})`);
    }

    // Deep runs end with an independent audit: the deterministic guard says how
    // much text survived, only a model can say what is missing and why.
    if (depth === 'deep' && conf.verify && args.verify !== false) {
        await step('verifying');
        try {
            const verification = await verifyItem(folder);
            finishStep('verifying', { detail: `confidence ${verification.confidence ?? 'unstated'}` });
            lines.push(`  verification.md — independent audit by ${verification.model} (confidence ${verification.confidence ?? 'unstated'}); read the "what this audit could not check" section`);
        } catch (error) {
            finishStep('verifying', { detail: 'unavailable' });
            lines.push(`  verification: not generated (${error.message})`);
            logger.warn(`nconvert: verification failed for ${filename}: ${error.message}`, null, 'nconvert');
        }
    }

    logger.info(`nconvert: ${filename} (${env.format}${depth === 'deep' ? ', deep' : ''}) → ${relToStorage(folder)}`, null, 'nconvert');
    return {
        responseText: lines.join('\n'),
        item: relToStorage(folder),
        format: env.format,
        depth,
        words: manifest.stats?.words ?? env.stats?.words ?? null,
        warnings: meta.warnings?.length ?? 0
    };
}

// ── tool surface ──────────────────────────────────────────────────────────
// convert and enqueue share one implementation: mechanical callers await the
// scheduled result; deep (or oversized) input returns a job handle instead of
// blocking for minutes.

async function convertImpl(args, { toolName = 'nconvert.convert' } = {}) {
    const { absolute, size } = resolveInput(args?.path);
    const depth = args?.depth ?? 'mechanical';
    if (depth !== 'mechanical' && depth !== 'deep') {
        throw new Error(`${toolName}: depth must be "mechanical" or "deep", got "${depth}"`);
    }

    const heavy = isHeavy(depth, size);
    const sha = await sha256File(absolute);

    const reuseKey = reuseKeyFor({
        depth,
        keepOriginal: args?.keepOriginal ?? conf.keepOriginal,
        assets: args?.assets ?? conf.assets,
        args
    });
    if (args?.force !== true) {
        const manifest = findReusable(sha, reuseKey);
        if (manifest) return { content: [{ type: 'text', text: reuseText(manifest) }], isError: false };
    }

    if (!heavy) {
        const job = await queue.runInline({
            source: absolute,
            args,
            sha,
            steps: stepsFor(depth)
        });
        if (job.state === 'failed') throw new Error(job.error);
        return { content: [{ type: 'text', text: job.result.responseText }], isError: false };
    }

    const { job, deduped } = queue.enqueue({
        source: absolute,
        args,
        sha,
        heavy: true,
        steps: stepsFor(depth)
    });
    return { content: [{ type: 'text', text: queueText(job, { deduped }) }], isError: false };
}

// JSON-shaped submit for the REST surface (dashboard) — same routing.
export async function submitIngest(args) {
    const { absolute, size } = resolveInput(args?.path);
    const depth = args?.depth ?? 'mechanical';
    if (depth !== 'mechanical' && depth !== 'deep') {
        throw new Error(`depth must be "mechanical" or "deep", got "${depth}"`);
    }
    const heavy = isHeavy(depth, size);
    const sha = await sha256File(absolute);
    const reuseKey = reuseKeyFor({
        depth,
        keepOriginal: args?.keepOriginal ?? conf.keepOriginal,
        assets: args?.assets ?? conf.assets,
        args
    });
    if (args?.force !== true) {
        const manifest = findReusable(sha, reuseKey);
        if (manifest) return { queued: false, reused: true, item: relToStorage(path.join(ingestDir, manifest.id)), manifest };
    }
    if (!heavy) {
        const job = await queue.runInline({ source: absolute, args, sha, steps: stepsFor(depth) });
        return { queued: false, job: queue.publicJob(job) };
    }
    const { job, deduped } = queue.enqueue({ source: absolute, args, sha, heavy: true, steps: stepsFor(depth) });
    return { queued: true, deduped, job: queue.list().find((j) => j.id === job.id) ?? queue.publicJob(job) };
}

export async function nconvert_convert(args) {
    return convertImpl(args);
}

export async function nconvert_enqueue(args) {
    return convertImpl(args, { toolName: 'nconvert.enqueue' });
}

export async function nconvert_jobs(args) {
    const state = args?.state ?? null;
    const limit = Math.min(Number(args?.limit ?? 20), 100);
    const jobs = queue.list({ state, limit });
    if (jobs.length === 0) {
        return { content: [{ type: 'text', text: 'No jobs.' }], isError: false };
    }
    const lines = jobs.map((j) => {
        const active = j.steps.find((s) => s.status === 'active');
        const where = active
            ? `${active.label}${active.n ? ` ${active.i ?? '?'}/${active.n}` : ''}${active.detail ? ` — ${active.detail}` : ''}`
            : j.state;
        const pos = j.state === 'queued' ? ` · position ${j.position}` : '';
        return `${j.id}  ${j.state.toUpperCase().padEnd(9)} ${path.basename(j.source)}  ${where}${pos}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
}

export async function nconvert_job(args) {
    if (!args?.id) throw new Error('nconvert.job: "id" is required');
    const job = queue.get(args.id);
    if (!job) throw new Error(`nconvert.job: no such job: ${args.id}`);
    const j = queue.publicJob(job);
    const lines = [
        `${j.id} — ${j.state}${j.heavy ? ' (queued work)' : ' (inline)'} — ${j.source}`,
        `  submitted ${new Date(j.createdAt).toISOString()}${j.startedAt ? `, started ${new Date(j.startedAt).toISOString()}` : ''}${j.finishedAt ? `, finished ${new Date(j.finishedAt).toISOString()}` : ''}`
    ];
    for (const s of j.steps) {
        const n = s.n ? ` ${s.i ?? '—'}/${s.n}` : '';
        lines.push(`  ${s.status.padEnd(7)} ${s.label}${n}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    if (j.result) {
        lines.push(`  result: ${j.result.item} (${j.result.format}${j.result.depth === 'deep' ? ', deep' : ''}, ${j.result.words} words)`);
    }
    if (j.error) lines.push(`  error: ${j.error}`);
    if (j.cancelRequested) lines.push('  cancellation requested — stops at the next checkpoint');
    if (j.requeued) lines.push('  re-queued after server restart');
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
}

export async function nconvert_cancel(args) {
    if (!args?.id) throw new Error('nconvert.cancel: "id" is required');
    const job = queue.cancel(args.id);
    const text = job.state === 'cancelled'
        ? `Cancelled ${job.id} (${path.basename(job.source)}).`
        : `Cancellation requested for running job ${job.id} — it stops at the next checkpoint (between steps or page chunks).`;
    return { content: [{ type: 'text', text }], isError: false };
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
// Independent audit of an existing item — the repair path when verification was
// skipped, failed, or must be re-run against a different model.
export async function nconvert_verify(args) {
    const item = args?.item;
    if (!item) throw new Error('nconvert.verify: "item" is required (see nconvert.items)');
    const itemDir = path.join(ingestDir, path.basename(String(item)));
    if (!fs.existsSync(itemDir)) throw new Error(`nconvert.verify: no such item: ${item}`);
    const manifest = readManifest(itemDir);

    if (manifest.verification?.file && args?.force !== true) {
        return {
            content: [{ type: 'text', text: fs.readFileSync(path.join(itemDir, manifest.verification.file), 'utf8') }],
            isError: false
        };
    }

    const result = await verifyItem(itemDir, { model: args?.model ?? null });
    return {
        content: [{ type: 'text', text: fs.readFileSync(path.join(itemDir, 'verification.md'), 'utf8') }],
        isError: false
    };
}

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
        case 'verification': {
            if (!manifest.layers.verification) throw new Error('nconvert.fetch: this item has no audit — run nconvert.verify { item }');
            return { content: [{ type: 'text', text: fs.readFileSync(path.join(itemDir, manifest.layers.verification), 'utf8') }], isError: false };
        }
        case 'rejected': {
            if (!manifest.layers.rejected) throw new Error('nconvert.fetch: this item has no rejected candidates — since 2026-11-07 the coverage guard is a diagnostic, so a low-coverage chunk ships with a warning instead of being replaced. Only items ingested before that change can carry rejected/');
            const dir = path.join(itemDir, manifest.layers.rejected.dir);
            const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
            const chosen = args?.section != null
                ? files[Number(args.section)]
                : files.length === 1 ? files[0] : null;
            if (!chosen) {
                throw new Error(`nconvert.fetch: ${files.length} rejected chunk(s) — pick one with section: 0-${files.length - 1} (${files.join(', ')})`);
            }
            return { content: [{ type: 'text', text: fs.readFileSync(path.join(dir, chosen), 'utf8') }], isError: false };
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
            throw new Error(`nconvert.fetch: unknown layer "${layer}" — one of: summary, document, mechanical, rejected, page, asset, original`);
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
    { format: 'docx', phase: 'M3 · live', note: 'styles → headings, numPr → nested lists, gridSpan/vMerge tables, images → assets, footnotes → GFM; expansion budget enforced; charts as data tables pending' },
    { format: 'pptx', phase: 'M3 · live', note: 'one section per slide (sldIdLst order via rels); title/body placeholders → headings/paragraphs; buChar/buAutoNum + lvl → nested lists; DrawingML tables onto the span grid; media → assets (SVG preferred over PNG fallback); speaker notes → narration blocks; charts/SmartArt warned pending' },
    { format: 'xlsx', phase: 'M3 · live', note: 'sheet per section, first row as header; merged cells fill their rectangle from the origin; dates render ISO (serial + style format); integral floats without .0; row cap + maxCells; expansion budget pre-charged from the ZIP directory' },
    { format: 'xlsb', phase: 'M3 · live', note: 'binary OOXML workbook via calamine; unsupported BrtBundleSh variants refuse loudly (calamine panic boundary)' },
    { format: 'ods', phase: 'M3 · live', note: 'ODF spreadsheet via calamine; sheet per section, first row header' },
    { format: 'odt', phase: 'M3 · live', note: 'ODF text: headings, styled spans, lists, repeated/covered table cells, Pictures → assets, footnotes; encrypted packages refused' },
    { format: 'odp', phase: 'M3 · live', note: 'ODF presentation: section per draw:page, title placeholders → H2, speaker notes → narration' },
    { format: 'epub', phase: 'M3 · live', note: 'OPF metadata → frontmatter; spine order sections; scoped XHTML headings/lists/tables/links/images' },
    { format: 'eml', phase: 'M3 · live', note: 'mail-parser 0.11; MIME + encoded headers, plain/HTML body, attachments as assets with inventory' },
    { format: 'mbox', phase: 'M3 · live', note: 'mbox message splitting via mail-parser; section per message, attachments as assets' },
    { format: 'pdf', phase: 'M4 · live', note: 'per-page text + embedded images as assets (JPX→PNG, DCT→jpg, flate→PNG); AES-256/R6 auto-decrypts; PDFium rasterization for deep conversion' },
    { format: 'image', phase: 'M5', note: 'OCR provider hand-off (multi-page); needs_ocr returned today' },
    { format: 'rtf', phase: 'M6', note: 'hand parser for supported control words' },
    { format: 'doc', phase: 'M6 · live (pulled forward)', note: 'Word 97-2003 binary: piece-table text (cp1252 + UTF-16 pieces), fields → result text, page breaks → ***, photos carved from the Data stream (JPEG/PNG); tables/footnotes/headers warned not converted; Word 6/95 + encrypted refused loudly' },
    { format: 'xls', phase: 'M6 · live (pulled forward)', note: 'Excel 97-2003 BIFF via calamine; sheet per section, merges and ISO dates' },
    { format: 'cfb', phase: 'M6', note: 'other CFB containers (Outlook .msg via __substg streams)' }
]

export async function nconvert_capabilities() {
    const payload = {
        converter: `nconvert ${engineVersion}`,
        spec: 'nConvert/docs/SPEC.md v2.5',
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
            visionModel: conf.visionModel,
            visionFallbackModels: conf.visionFallbackModels,
            maxTokens: conf.visionMaxTokens,
            pageWidth: conf.pageWidth,
            chunkPages: conf.chunkPages,
            coverageThreshold: conf.coverageThreshold,
            maxDeepPages: conf.maxDeepPages,
            note: 'depth:"deep" renders pages and has a vision model reconstruct structure over the mechanically extracted text; document.mechanical.md is always kept'
        },
        execution: {
            nativeProcesses: conf.nativeProcesses,
            maxConcurrentJobs: conf.maxConcurrentJobs,
            maxHeavyJobs: conf.maxHeavyJobs,
            maxSummaryJobs: conf.maxSummaryJobs
        },
        summary: { enabled: Boolean(conf.summary), layer: 'summary.md', models: conf.summaryModels },
        formats: FORMAT_MATRIX
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false };
}
