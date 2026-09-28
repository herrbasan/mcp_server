// ============================================
// harvest — collect a documentation section, then write it up
// ============================================
//
// Two tools, two passes.
//
// `harvest.collect` is pass 1: given a seed URL, find the pages around it, choose
// which to fetch, render each into storage, and write a manifest. It is
// mechanical apart from ONE model call — ranking the link list against an intent
// when there is more to fetch than the budget allows.
//
// `harvest.compose` is pass 2: read the manifest, read the pages it names, ask
// for any abandoned links worth going back for, and write one document. This is
// where the writing model lives.
//
// Three things are deliberate throughout:
//
// 1. RECALL OVER PRECISION. Pass 1 selects by scope and budget, never by
//    relevance, and a page wrongly dropped there is invisible to everything
//    downstream. So nothing is dropped silently: every discovered link appears in
//    the manifest — fetched, failed, not selected, or filtered out — with its
//    reason, and compose can reach the ones pass 1 left behind.
//
// 2. PASS 2 RESTRUCTURES, IT DOES NOT SUMMARISE. The material has to survive
//    into the document: code verbatim, tables intact, specific values kept. An
//    organiser that compresses is just a worse research.topic.
//
// 3. RETRIEVAL IS SHARED. Every page comes through browser.fetch, so rendering,
//    conversion, block-page detection and the storage layout are the same code
//    as the single-URL tool.

import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { runBrowserFetch } from '../browser/index.js';

const DEFAULT_MAX_PAGES = 30;
const DEFAULT_CONCURRENCY = 4;
const DISCOVERY_TIMEOUT_MS = 15000;

// Never worth fetching as a document.
const SKIP_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif',
    'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
    'mp4', 'webm', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'flac',
    'css', 'js', 'mjs', 'map', 'woff', 'woff2', 'ttf', 'eot', 'otf',
    'exe', 'dmg', 'deb', 'rpm', 'apk', 'whl'
]);

// Containers that hold a documentation site's navigation. Tried first because a
// nav gives a curated, complete page list — far better than crawling.
const NAV_SELECTORS = [
    'nav a[href]',
    'aside a[href]',
    '[class*="sidebar" i] a[href]',
    '[class*="menu" i] a[href]',
    '[class*="toc" i] a[href]',
    '[role="navigation"] a[href]'
];
const CONTENT_SELECTORS = ['main a[href]', 'article a[href]', '[role="main"] a[href]'];

// Overridable via config (agents.harvest.selectModel) or per call. The local
// model is the default ON PURPOSE: selection is a small judgement on a bounded
// list, it costs nothing locally, and its 256k context means the whole candidate
// list fits — no reason to reach for a cloud model, or to grind the list down to
// something a smaller window could hold.
let configuredSelectModel = null;

let storageRoot = null;
let siteBaseUrl = null;

export async function init(context) {
    storageRoot = context?.config?.agents?.storage?.root || null;
    siteBaseUrl = context?.config?.agents?.storage?.publicUrl || null;
    // Optional override, e.g. agents.harvest.selectModel in config.json.
    const configured = context?.config?.agents?.harvest?.selectModel;
    if (configured) configuredSelectModel = configured;
}

function log(msg) {
    console.log(`[Harvest] ${msg}`);
}

// ============================================
// URL handling
// ============================================

// Keeps the path EXACTLY as given. An earlier version stripped a trailing slash
// so /uv/ and /uv compared equal — which also meant fetching /uv, and on a server
// that does not redirect that is a 404. The seed is the user's URL; it gets
// fetched as written. Canonicalisation happens in urlKey(), for dedupe only.
function normalizeUrl(raw, base) {
    let u;
    try {
        u = new URL(raw, base);
    } catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u;
}

// Dedupe key: /docs/ and /docs are the same page, even though the URLs are not.
function urlKey(u) {
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${path}${u.search}`;
}

// Same rule browser.fetch uses for its storage folders, so the manifest lands
// beside the pages it describes rather than in a sibling directory that differs
// only in punctuation (127.0.0.1 vs 127-0-0-1).
function hostSlug(hostname) {
    return hostname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-host';
}

function extensionOf(u) {
    const last = u.pathname.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
}

// The seed's own directory is the section: /3/library/json.html -> /3/library/.
// Widening to the whole origin is opt-in because on a large site it turns a
// focused harvest into a crawl.
//
// Taken from the ORIGINAL pathname, not the normalized one: normalization strips
// a trailing slash to make /uv/ and /uv the same page, which would erase the only
// signal that the seed was a directory. Seed with https://docs.x.dev/uv/ and the
// section is /uv/, not the whole site.
function sectionPrefix(seedPathname, wholeSite) {
    if (wholeSite) return '/';
    const dir = seedPathname.endsWith('/')
        ? seedPathname
        : seedPathname.replace(/\/[^/]*$/, '/');
    return dir || '/';
}

function isInSection(u, prefix) {
    return u.pathname === prefix.replace(/\/$/, '') || u.pathname.startsWith(prefix);
}

function depthOf(u) {
    return u.pathname.split('/').filter(Boolean).length;
}

// ============================================
// Discovery sources
// ============================================

// sitemap.xml and llms.txt are not pages — rendering them in Chrome would wrap
// them in a viewer document. This is the sanctioned non-page case, and failure
// is not an error: it just means the next discovery source is tried.
async function fetchTextResource(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'mcp-server-harvest/1.0', 'Accept': 'text/plain,application/xml,text/xml,*/*' },
            redirect: 'follow',
            signal: controller.signal
        });
        if (!res.ok) return null;
        const text = await res.text();
        return text;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function parseSitemap(xml) {
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
    const isIndex = /<sitemapindex/i.test(xml);
    return { locs, isIndex };
}

async function discoverFromSitemap(origin) {
    const root = await fetchTextResource(new URL('/sitemap.xml', origin).href);
    if (!root) return null;

    const parsed = parseSitemap(root);
    if (!parsed.locs.length) return null;

    // A sitemap index points at child sitemaps; one level is enough for the
    // shapes documentation sites actually use.
    if (parsed.isIndex) {
        const children = parsed.locs.slice(0, 20);
        const nested = await Promise.all(children.map(fetchTextResource));
        const urls = [];
        for (const xml of nested) {
            if (xml) urls.push(...parseSitemap(xml).locs.map(href => ({ href, label: '' })));
        }
        return urls.length ? urls : null;
    }
    return parsed.locs.map(href => ({ href, label: '' }));
}

async function discoverFromLlmsTxt(origin, seedPath) {
    // llms.txt is often the thing you actually want: a curated index written for
    // exactly this purpose. Check the site root and the seed's own directory.
    const candidates = [
        new URL('/llms.txt', origin).href,
        new URL(`${seedPath.replace(/\/[^/]*$/, '/')}llms.txt`, origin).href
    ];
    for (const url of candidates) {
        const text = await fetchTextResource(url);
        if (!text) continue;
        // [label](url) — the label is a real title, worth keeping for selection.
        const links = [...text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)]
            .map(m => ({ href: m[2], label: m[1].replace(/\s+/g, ' ').trim().slice(0, 100) }));
        if (links.length) return links;
    }
    return null;
}

function discoverFromNav(html, baseUrl) {    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;

    const collect = (selectors) => {
        const out = [];
        for (const sel of selectors) {
            for (const a of doc.querySelectorAll(sel)) {
                const href = a.getAttribute('href');
                if (!href) continue;
                // The anchor text is a real label — it is what the site itself
                // calls the page, and the only signal a selector has short of
                // fetching it.
                const label = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
                out.push({ href, label });
            }
        }
        return out;
    };

    const nav = collect(NAV_SELECTORS);
    // Very short nav lists usually mean the site builds navigation in JavaScript
    // or the markup is not described by any of these names — fall back to links
    // in the content area rather than returning almost nothing.
    if (new Set(nav.map(l => l.href)).size >= 5) return nav;
    return [...nav, ...collect(CONTENT_SELECTORS)];
}

// The seed is usually a leaf, and on Sphinx-style sites the sidebar only links UP
// and WITHIN the page — the complete list of sibling pages lives on the section's
// own landing page. Without this, harvesting one page of the Python library docs
// finds the page plus a handful of ancestors. One extra render buys the whole
// chapter list.
async function discoverFromSectionIndex(browser, origin, prefix, seedHref) {
    const indexUrl = new URL(prefix, origin).href;
    if (urlKey(new URL(indexUrl)) === urlKey(new URL(seedHref))) return null;
    const html = await renderHtml(browser, indexUrl);
    if (!html) return null;
    return discoverFromNav(html, indexUrl);
}

// ============================================
// Candidate assembly
// ============================================

function buildCandidates({ seed, discovered, sameOrigin, prefix, include, exclude }) {
    const seedUrl = normalizeUrl(seed, seed);
    const origin = seedUrl.origin;
    const seedKey = urlKey(seedUrl);
    const seen = new Set();
    const byKey = new Map();
    const kept = [];
    const dropped = [];
    const droppedKeys = new Set();

    // Deduped by URL: the same link is often discovered by several sources (nav,
    // llms.txt, sitemap), and a manifest that lists github.com/astral-sh/uv three
    // times as "different origin" misrepresents how much was actually set aside.
    const drop = (raw, reason) => {
        if (droppedKeys.has(raw)) return;
        droppedKeys.add(raw);
        dropped.push({ url: raw, reason });
    };

    for (const item of discovered) {
        const raw = item.href;
        const u = normalizeUrl(raw, seedUrl.href);
        if (!u) { drop(raw, 'not a valid http(s) URL'); continue; }
        if (sameOrigin && u.origin !== origin) { drop(u.href, 'different origin'); continue; }
        if (!isInSection(u, prefix)) { drop(u.href, 'outside the seed section'); continue; }
        const ext = extensionOf(u);
        if (ext && SKIP_EXTENSIONS.has(ext)) { drop(u.href, `not a document (.${ext})`); continue; }
        if (include.length && !include.some(s => u.href.includes(s))) { drop(u.href, 'not matched by include'); continue; }
        if (exclude.some(s => u.href.includes(s))) { drop(u.href, 'matched by exclude'); continue; }
        const key = urlKey(u);
        if (seen.has(key)) {
            // First source to mention a URL wins the dedupe, but not necessarily
            // the label: sitemaps carry none and nav links do, so a page can
            // arrive unlabelled before its real title shows up. Enrich rather
            // than leaving the selector with a bare URL.
            const existing = byKey.get(key);
            if (existing && !existing.label && item.label) existing.label = item.label;
            continue;
        }
        seen.add(key);
        const entry = { url: u, href: u.href, label: item.label || '', isSeed: key === seedKey };
        byKey.set(key, entry);
        kept.push(entry);
    }

    // The seed first, then shallowest-path-first: section indexes and overviews
    // before deep leaves. Ties break alphabetically so a harvest is
    // reproducible.
    kept.sort((a, b) =>
        Number(b.isSeed) - Number(a.isSeed) ||
        depthOf(a.url) - depthOf(b.url) ||
        a.href.localeCompare(b.href));

    return { candidates: kept, dropped, inSection: kept.length };
}

// One structured call, never an agent. Selection is a judgement over a list of
// labels, which a small model does well — measured 2026-09-28: asked for "dates,
// times and timezones" over the 264-page Python library index it returned
// datetime, time, zoneinfo, calendar, sched, timeit. Driving the fetch loop is a
// different job it does badly (one tool call at a time would serialise the whole
// pipeline behind the slowest component available).
const DEFAULT_SELECT_MODEL = 'badkid-llama-chat';

// The local model's context is 262144 tokens and its output cap is 8192, so the
// candidate list does not need to be artificially small — only bounded. Each
// line runs ~90 chars, roughly 25 tokens, so 2000 links is about 50k tokens of a
// 256k window: room to spare, and still a ceiling, because a crawler that finds
// tens of thousands of links should not be able to build an unbounded prompt.
const MAX_LINKS_TO_MODEL = 2000;

// Equal to the local model's max_output_tokens. Sized for the REASONING case as
// well: with 1024 or 4096 an earlier run against the gateway's task routing came
// back an empty string with finish_reason=max_tokens — reasoning counted against
// the same budget, so the answer never began. A failure with no visible cause,
// which is why finish_reason is logged whenever a reply is unusable.
const SELECT_MAX_TOKENS = 8192;

// --- deep selection ------------------------------------------------------
//
// Batching exists because one call over hundreds of items asks the model to do a
// GLOBAL RANKING — compare every candidate against every other — and a small
// model skims that. Scoring ~45 items at a time turns it into a series of
// independent little judgements, which it does consistently.
//
// Measured 2026-09-28 over the same 264-candidate list and question:
//   one call         0.7-2.4s   top-4 correct 3/4 then 4/4  (variable)
//   batched scoring  9-10s      top-4 correct 4/4 both runs
// So this buys stability, not peak quality, and costs about four times the
// selection time. It is opt-in for that reason.
const DEEP_BATCH_SIZE = 45;
const DEEP_CONCURRENCY = 4;
// Bounds the number of calls: 20 batches x 45 is 900 candidates scored. A crawler
// can discover far more than that, and an unbounded number of local calls is not
// a thing to discover in production.
const MAX_DEEP_BATCHES = 20;

// Local models wrap JSON in prose and code fences however they like. Take the
// first bracketed run, accept numbers or numeric strings, and ignore anything
// out of range rather than failing the harvest over formatting.
function parseIndexList(text, max, budget) {    if (typeof text !== 'string') return [];
    const match = /\[[\s\S]*?\]/.exec(text);
    if (!match) return [];
    let arr;
    try {
        arr = JSON.parse(match[0]);
    } catch {
        return [];
    }
    if (!Array.isArray(arr)) return [];

    const seen = new Set();
    const out = [];
    for (const value of arr) {
        const n = typeof value === 'number'
            ? value
            : (/^\s*\d+\s*$/.test(String(value)) ? Number(value) : NaN);
        if (!Number.isInteger(n) || n < 1 || n > max) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(n - 1);
        if (out.length >= budget) break;
    }
    return out;
}

async function selectWithModel({ gateway, choosable, seed, intent, budget, selectModel }) {
    const model = selectModel || configuredSelectModel || DEFAULT_SELECT_MODEL;
    const considered = choosable.slice(0, MAX_LINKS_TO_MODEL);
    const goal = intent
        ? `What the caller wants from these docs: ${intent}`
        : 'No specific goal was given, so choose the pages that best represent the subject ' +
          'matter of the seed: overviews, references and core concepts ahead of changelogs, ' +
          'licensing, contributing guides or unrelated chapters.';

    const prompt = [
        'You are choosing which pages to fetch from a documentation site.',
        '',
        `Seed page: ${seed}`,
        goal,
        '',
        `Pick the ${budget} pages most worth having. Judge by the label and the URL.`,
        'Answer with ONLY a JSON array of line numbers, most important first.',
        'For example: [3, 17, 2]',
        '',
        'Candidates:',
        ...considered.map((c, i) => `${i + 1}. ${c.label ? c.label + ' — ' : ''}${c.href}`)
    ].join('\n');

    // Always an explicit model rather than gateway task routing: the routing is
    // configured for general queries, and this call wants the local model by
    // name. A pinned model and `task` must not both be sent — the gateway
    // prefers `task` and would route somewhere else entirely.
    const res = await gateway.chat({
        model,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: 'You select documentation pages. You reply with a JSON array of numbers and nothing else.',
        enableThinking: false,
        maxTokens: SELECT_MAX_TOKENS,
        // Non-streaming: this is a one-shot structured call. The streaming path
        // sets strip_thinking, so a reply that went entirely into reasoning
        // arrives as an empty string with no clue why — this mode returns
        // finish_reason and usage alongside the content.
        stream: false
    });

    const picks = parseIndexList(res.content, considered.length, budget);
    if (!picks.length) {
        // Worth keeping: a silent "nothing usable" is impossible to diagnose from
        // the manifest alone, and the reply is the only evidence.
        const snippet = String(res.content ?? '').replace(/\s+/g, ' ').slice(0, 300);
        log(`selection: could not read a selection from the model reply ` +
            `(finish=${res.finish_reason || '?'}, chars=${String(res.content ?? '').length}, ` +
            `reply=${snippet || '(empty)'})`);
        return null;
    }

    return {
        chosen: picks.map(i => considered[i]),
        considered: considered.length,
        // The gateway does not echo the model back on this path, so record what
        // was ASKED for rather than leaving the manifest silent about it.
        requested: model
    };
}

// {number: score} -> array indexed from 0. A number the model omitted comes back
// as null, NOT as zero: an unrated page is unknown, and treating unknown as
// "irrelevant" is how a harvester loses a page without saying so.
function parseScoreObject(text, count) {
    const scores = new Array(count).fill(null);
    if (typeof text !== 'string') return scores;
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return scores;
    let obj;
    try {
        obj = JSON.parse(match[0]);
    } catch {
        return scores;
    }
    if (!obj || typeof obj !== 'object') return scores;
    for (const [key, value] of Object.entries(obj)) {
        const n = Number(key);
        const score = typeof value === 'number' ? value : Number(value);
        if (!Number.isInteger(n) || n < 1 || n > count) continue;
        if (!Number.isFinite(score)) continue;
        scores[n - 1] = Math.max(0, Math.min(3, Math.round(score)));
    }
    return scores;
}

async function selectWithModelDeep({ gateway, model, choosable, seed, intent, budget }) {
    const considered = choosable.slice(0, MAX_LINKS_TO_MODEL);
    const batches = [];
    for (let i = 0; i < considered.length; i += DEEP_BATCH_SIZE) {
        batches.push(considered.slice(i, i + DEEP_BATCH_SIZE));
    }

    const overflow = batches.length > MAX_DEEP_BATCHES ? batches.splice(MAX_DEEP_BATCHES) : [];
    const overflowItems = overflow.flat();

    const goal = intent
        ? `How relevant is each page to: ${intent}`
        : `How well does each page represent the subject matter of ${seed}`;

    const scoredBatches = await mapLimit(batches, DEEP_CONCURRENCY, async (items) => {
        const prompt = [
            goal,
            '',
            'Rate every page: 0 (irrelevant), 1 (marginal), 2 (relevant), 3 (core).',
            'Answer with ONLY a JSON object mapping each number to its score, e.g. {"1":0,"2":3}.',
            'Include every number.',
            '',
            'Pages:',
            ...items.map((c, i) => `${i + 1}. ${c.label ? c.label + ' — ' : ''}${c.href}`)
        ].join('\n');

        const res = await gateway.chat({
            model,
            messages: [{ role: 'user', content: prompt }],
            systemPrompt: 'You rate documentation pages by relevance. You reply with JSON and nothing else.',
            enableThinking: false,
            maxTokens: SELECT_MAX_TOKENS,
            stream: false
        });
        const scores = parseScoreObject(res.content, items.length);
        return items.map((item, i) => ({ item, score: scores[i] }));
    });

    const rated = scoredBatches.flat();
    // `scored` counts what the model actually rated, not what it was sent: an
    // omitted index is unknown, and reporting it as scored would hide that.
    const ratedCount = rated.filter(r => r.score != null).length;

    // Nothing rated means there is no ranking at all — the order below would be
    // the input order dressed up as the model's. Say so instead, so the caller
    // falls back and the manifest names the real reason.
    if (!ratedCount) {
        log(`selection: deep, the model rated none of ${considered.length} candidates`);
        return null;
    }
    // Unrated (or overflow) items rank below anything the model actually scored,
    // so they are the first candidates for the top-up rather than silent losers.
    const ranked = rated
        .map((r, index) => ({ ...r, index }))
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.index - b.index);

    const chosen = ranked.slice(0, budget).map(r => r.item);
    const cutoff = ranked.length > budget ? (ranked[budget - 1].score ?? -1) : -1;

    const histogram = { 0: 0, 1: 0, 2: 0, 3: 0, unrated: 0 };
    for (const r of ranked) {
        if (r.score == null) histogram.unrated++;
        else histogram[r.score]++;
    }

    return {
        chosen,
        considered: considered.length,
        scored: ratedCount,
        requested: model,
        batches: batches.length,
        // What the budget left behind, which a pick-N answer cannot express:
        // items that scored as well as the weakest page that was taken.
        leftAtCutoff: cutoff >= 0
            ? ranked.slice(budget).filter(r => (r.score ?? -1) >= cutoff).length
            : 0,
        histogram,
        overflowed: overflowItems.length
    };
}

// ============================================
// Collection
// ============================================

// One page, rendered, as HTML. Used for discovery passes — the seed and the
// section index. Real retrieval goes through browser.fetch.
async function renderHtml(browser, url) {
    const { page, markUsed, close } = await browser.getPage();
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        return await page.content();
    } catch (e) {
        log(`discovery render failed for ${url}: ${e.message}`);
        return null;
    } finally {
        markUsed();
        await close(0);
    }
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

// ============================================
// Tool
// ============================================

export async function harvest_collect(args, context) {
    const {
        url,
        intent,
        max_pages = DEFAULT_MAX_PAGES,
        whole_site = false,
        include = [],
        exclude = [],
        dir = 'harvest',
        concurrency = DEFAULT_CONCURRENCY,
        select = 'auto',
        select_model
    } = args;

    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('harvest_collect: url is required');
    }
    // seedHref is the URL as the caller wrote it (fetched as-is); seed is the
    // parsed form used for comparisons.
    const seedHref = url.trim();
    const seed = normalizeUrl(seedHref, seedHref);
    if (!seed) {
        throw new Error(`harvest_collect: not a usable absolute http(s) URL: ${url}`);
    }
    if (!storageRoot) {
        throw new Error('harvest_collect: config agents.storage.root is required');
    }
    if (path.isAbsolute(dir) || dir.includes('..')) {
        throw new Error(`harvest_collect: dir must be a relative path inside storage, got '${dir}'`);
    }
    if (!Number.isFinite(max_pages) || max_pages < 1) {
        throw new Error(`harvest_collect: max_pages must be >= 1, got ${max_pages}`);
    }
    if (!['auto', 'llm', 'deep', 'heuristic'].includes(select)) {
        throw new Error(`harvest_collect: select must be auto|llm|deep|heuristic, got '${select}'`);
    }

    const browser = context?.agents?.get('browser');
    if (!browser?.getPage) {
        throw new Error('harvest_collect: the browser agent is not available (needs dependsOn: ["browser"])');
    }

    const prefix = sectionPrefix(new URL(seedHref).pathname, whole_site);
    log(`seed ${seed.href} | section '${prefix}' | budget ${max_pages}`);

    // ---- 1. Render the seed once, for discovery only --------------------
    const seedHtml = await renderHtml(browser, seedHref);
    if (!seedHtml) {
        throw new Error(`harvest_collect: could not render the seed ${seedHref}`);
    }
    log(`seed rendered: ${seedHtml.length} bytes`);

    // ---- 2. Discover, from the cheapest complete source first -----------
    const sources = [];
    const sitemapUrls = await discoverFromSitemap(seed.origin);
    if (sitemapUrls) sources.push({ name: 'sitemap.xml', urls: sitemapUrls });
    const llmsUrls = await discoverFromLlmsTxt(seed.origin, new URL(seedHref).pathname);
    if (llmsUrls) sources.push({ name: 'llms.txt', urls: llmsUrls });
    sources.push({ name: 'nav links', urls: discoverFromNav(seedHtml, seedHref) });
    const sectionUrls = await discoverFromSectionIndex(browser, seed.origin, prefix, seedHref);
    if (sectionUrls) sources.push({ name: 'section index', urls: sectionUrls });

    // Union of every source: sitemap is complete, llms.txt is curated, the nav
    // reflects what the seed page itself considers adjacent. The seed comes first
    // so that its exact form wins the dedupe against a normalized variant.
    const discovered = [{ href: seedHref, label: 'the seed page' }];
    for (const s of sources) discovered.push(...s.urls);
    log(`discovered ${discovered.length} raw links from [${sources.map(s => s.name).join(', ')}]`);

    // ---- 3. Narrow to the section ---------------------------------------
    const { candidates, dropped, inSection } = buildCandidates({
        seed: seedHref,
        discovered,
        sameOrigin: true,
        prefix,
        include,
        exclude
    });
    log(`${inSection} unique page(s) in section`);

    // ---- 4. Choose what to fetch ----------------------------------------
    const guaranteed = candidates.filter(c => c.isSeed);
    const choosable = candidates.filter(c => !c.isSeed);
    const budgetForChoices = Math.max(0, max_pages - guaranteed.length);

    let selected;
    let selectionInfo = { mode: 'all', intent: intent || null };

    if (choosable.length <= budgetForChoices) {
        selected = choosable;
    } else if (select === 'heuristic' || !context?.gateway) {
        selected = choosable.slice(0, budgetForChoices);
        selectionInfo = {
            mode: 'heuristic',
            intent: intent || null,
            reason: select === 'heuristic' ? 'selection disabled' : 'no gateway available'
        };
    } else {
        const deep = select === 'deep';
        try {
            const picked = deep
                ? await selectWithModelDeep({
                    gateway: context.gateway,
                    model: select_model || configuredSelectModel || DEFAULT_SELECT_MODEL,
                    choosable,
                    seed: seedHref,
                    intent,
                    budget: budgetForChoices
                })
                : await selectWithModel({
                    gateway: context.gateway,
                    choosable,
                    seed: seedHref,
                    intent,
                    budget: budgetForChoices,
                    selectModel: select_model
                });
            if (picked) {
                selected = picked.chosen;
                if (deep) {
                    selectionInfo = {
                        mode: 'deep',
                        intent: intent || null,
                        requested: picked.requested,
                        considered: picked.considered,
                        scored: picked.scored,
                        batches: picked.batches,
                        scores: picked.histogram,
                        left_at_cutoff: picked.leftAtCutoff,
                        model_picks: picked.chosen.length
                    };
                    log(`selection: deep, ${picked.batches} batch(es), ${picked.scored}/${picked.considered} scored, ` +
                        `histogram ${JSON.stringify(picked.histogram)}, took ${picked.chosen.length}, ` +
                        `left ${picked.leftAtCutoff} at or above the cutoff`);
                } else {
                    // Top up if the model named fewer pages than the budget. The
                    // ranking is the model's; the unused slots are not — a harvester
                    // should not return less than it was allowed to, and pass 2 can
                    // discard surplus but cannot recover an omission.
                    // Deep mode needs no top-up: ranking always fills the budget.
                    const taken = new Set(picked.chosen);
                    const topUp = choosable
                        .filter(c => !taken.has(c))
                        .slice(0, Math.max(0, budgetForChoices - picked.chosen.length));
                    selected = [...picked.chosen, ...topUp];
                    selectionInfo = {
                        mode: 'llm',
                        intent: intent || null,
                        requested: picked.requested,
                        considered: picked.considered,
                        model_picks: picked.chosen.length,
                        topped_up: topUp.length
                    };
                    log(`selection: ${picked.requested} picked ${picked.chosen.length}, topped up ${topUp.length}, of ${picked.considered} considered`);
                }
            } else {
                selected = choosable.slice(0, budgetForChoices);
                selectionInfo = { mode: 'heuristic', intent: intent || null, reason: 'model returned nothing usable' };
                log('selection: model returned nothing usable, using heuristic order');
            }
        } catch (e) {
            selected = choosable.slice(0, budgetForChoices);
            selectionInfo = { mode: 'heuristic', intent: intent || null, reason: `model call failed: ${e.message}` };
            log(`selection: model call failed (${e.message}), using heuristic order`);
        }
    }

    const chosenSet = new Set([...guaranteed, ...selected]);
    for (const c of choosable) {
        if (!chosenSet.has(c)) {
            dropped.push({
                url: c.href,
                reason: selectionInfo.mode === 'heuristic'
                    ? `over the ${max_pages}-page budget (discovered, not fetched)`
                    : 'not selected (discovered, not fetched)'
            });
        }
    }
    const toFetch = [...guaranteed, ...selected];
    log(`${toFetch.length} to fetch (${selectionInfo.mode}), ${dropped.length} left out`);

    // ---- 5. Retrieve each page through browser.fetch --------------------
    const results = await mapLimit(toFetch, Math.max(1, Math.floor(concurrency)), async (u) => {
        try {
            const r = await runBrowserFetch({ url: u.href, dir });
            return {
                url: u.href,
                ok: true,
                storage: r.relPath,
                title: r.title,
                bytes: r.bytes,
                strategy: r.strategy,
                codeBlocks: r.stats.codeBlocks,
                tables: r.stats.tables,
                finalUrl: r.finalUrl !== u.href ? r.finalUrl : undefined
            };
        } catch (e) {
            // Tolerated at the boundary, recorded in the manifest — a page that
            // vanished without a trace is the one failure this pass must not make.
            return { url: u.href, ok: false, error: e.message };
        }
    });

    const fetched = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);

    if (!fetched.length) {
        throw new Error(
            `harvest_collect: every one of ${toFetch.length} page(s) failed\n` +
            failed.map(f => `  ${f.url}: ${f.error}`).join('\n')
        );
    }

    // ---- 6. Manifest ----------------------------------------------------
    const host = hostSlug(seed.hostname);
    const manifestRel = `${dir}/${host}/_manifest.json`;
    const manifest = {
        seed: seedHref,
        collected: new Date().toISOString(),
        section: prefix,
        whole_site: Boolean(whole_site),
        sources: sources.map(s => ({ name: s.name, links: s.urls.length })),
        budget: max_pages,
        selection: selectionInfo,
        pages: fetched,
        failed,
        not_fetched: dropped,
        links: {
            discovered: discovered.length,
            unique_in_section: inSection,
            fetched: fetched.length
        }
    };

    const manifestAbs = path.join(storageRoot, manifestRel);
    fs.mkdirSync(path.dirname(manifestAbs), { recursive: true });
    fs.writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2), 'utf8');

    // A readable index beside the JSON — the same information, without needing
    // to open a 40 KB blob.
    const indexRel = `${dir}/${host}/_index.md`;
    const indexLines = [
        `# Harvest: ${seedHref}`,
        '',
        `Collected ${manifest.collected} · section \`${prefix}\` · discovery from ${sources.map(s => s.name).join(', ')}`,
        '',
        `- discovered links: ${discovered.length}`,
        `- fetched: ${fetched.length}`,
        `- failed: ${failed.length}`,
        `- not fetched: ${dropped.length}`,
        '',
        '## Pages',
        '',
        '| page | title | code | tables | KB | storage |',
        '| --- | --- | --- | --- | --- | --- |'
    ];
    for (const p of fetched) {
        indexLines.push(`| ${p.url} | ${(p.title || '').replace(/\|/g, '\\|')} | ${p.codeBlocks} | ${p.tables} | ${(p.bytes / 1024).toFixed(1)} | ${p.storage} |`);
    }
    if (failed.length) {
        indexLines.push('', '## Failed', '');
        for (const f of failed) indexLines.push(`- ${f.url} — ${f.error}`);
    }
    if (dropped.length) {
        indexLines.push('', '## Discovered but not fetched', '');
        for (const d of dropped) indexLines.push(`- ${d.url} — ${d.reason}`);
    }
    fs.writeFileSync(path.join(storageRoot, indexRel), indexLines.join('\n') + '\n', 'utf8');

    const totalBytes = fetched.reduce((n, p) => n + p.bytes, 0);
    const lines = [
        `Harvested ${fetched.length} page(s) from ${seedHref}`,
        `  section    ${prefix}${whole_site ? ' (whole site)' : ''}`,
        `  discovery  ${sources.map(s => `${s.name} (${s.urls.length})`).join(', ')}`,
        `  selection  ${selectionInfo.mode}` +
            (selectionInfo.intent ? ` — "${selectionInfo.intent}"` : '') +
            (selectionInfo.model_picks != null ? ` (model picked ${selectionInfo.model_picks}${selectionInfo.topped_up ? `, topped up ${selectionInfo.topped_up}` : ''} of ${selectionInfo.considered} considered)` : '') +
            (selectionInfo.reason ? ` — ${selectionInfo.reason}` : ''),
        `  fetched    ${fetched.length}  ·  failed ${failed.length}  ·  not fetched ${dropped.length}`,
        `  corpus     ${(totalBytes / 1024).toFixed(1)} KB across ${fetched.length} file(s)`,
        `  manifest   ${manifestRel}`,
        `  index      ${indexRel}`,
        siteBaseUrl ? `  url        ${siteBaseUrl.replace(/\/+$/, '')}/storage/${manifestRel}` : null,
        '',
        'The manifest lists every discovered link, including the ones not fetched and why. Read the pages with storage.read — pass 2 decides what belongs in the final document.'
    ].filter(l => l !== null);

    log(`done: ${fetched.length} fetched, ${failed.length} failed, ${dropped.length} not fetched`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ============================================
// harvest.compose — pass 2
// ============================================
//
// Read the manifest, read the pages it names, optionally go back for the links
// pass 1 left behind, and write one Markdown document.
//
// This is the pass that needs a model, and it has NO FALLBACK: there is no
// mechanical substitute for writing a document, so if the model is unreachable
// the tool fails rather than emitting something plausible.

// Composition wants a large window and good writing; the local 12B is fine at
// ranking links and not at this.
const DEFAULT_COMPOSE_MODEL = 'deepseek-flash-chat';
// A document, not a paragraph. Well under the model's own output cap.
const COMPOSE_MAX_TOKENS = 32000;
const DEFAULT_EXTRA_PAGES = 10;
// Used only when the gateway will not tell us the model's context window.
const FALLBACK_CONTEXT_BUDGET_CHARS = 900000;
const CHARS_PER_TOKEN = 4;
// Half the window, leaving room for the prompt, the instructions and the output.
const CONTEXT_INPUT_FRACTION = 0.5;

// Reasons a link was left behind that pass 2 could actually want. Scope filters
// are NOT offered: `include`/`exclude` are the caller's explicit boundaries, and
// "not a document" / "different origin" cannot be fetched into this corpus.
const REACHABLE_REASONS = [/^not selected/, /budget \(discovered/];

function loadManifest(manifestRel) {
    const abs = path.join(storageRoot, manifestRel);
    if (!fs.existsSync(abs)) {
        throw new Error(`harvest_compose: manifest not found in storage: ${manifestRel}`);
    }
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (e) {
        throw new Error(`harvest_compose: manifest is not valid JSON (${manifestRel}): ${e.message}`);
    }
    if (!Array.isArray(manifest.pages)) {
        throw new Error(`harvest_compose: manifest has no pages array: ${manifestRel}`);
    }
    return { manifest, abs };
}

function readSources(manifest) {
    return manifest.pages.map((p) => {
        const abs = path.join(storageRoot, p.storage);
        if (!fs.existsSync(abs)) {
            // The manifest asserts this page exists. If it does not, the harvest
            // is broken and composing over the remainder would silently produce a
            // document missing a section it claims to cover.
            throw new Error(
                `harvest_compose: manifest lists ${p.storage} but it is not in storage — ` +
                'the harvest is incomplete; re-run harvest.collect'
            );
        }
        return {
            url: p.url,
            title: p.title || p.url,
            storage: p.storage,
            text: fs.readFileSync(abs, 'utf8')
        };
    });
}

// How much source text the model can take, from its declared context window
// rather than a guess, with a conservative fallback.
async function contextBudgetChars(gateway, model) {
    try {
        const models = await gateway.listModels('chat');
        const list = Array.isArray(models) ? models : (models?.data || models?.models || []);
        const entry = list.find(m => (m.id || m.name) === model);
        const ctx = entry?.context_length || entry?.limit?.context;
        if (Number.isFinite(ctx) && ctx > 0) {
            return Math.floor(ctx * CONTEXT_INPUT_FRACTION * CHARS_PER_TOKEN);
        }
    } catch {
        // Unknown is not fatal — fall through to the conservative default.
    }
    return FALLBACK_CONTEXT_BUDGET_CHARS;
}

// One call over the links pass 1 abandoned, asking which are worth going back
// for. Bounded by maxExtra, so this cannot become a crawl, and its failures are
// non-fatal: a document from what we already have beats no document.
async function fetchAbandonedLinks({ gateway, model, manifest, intent, maxExtra, dir }) {
    const reachable = (manifest.not_fetched || [])
        .filter(d => REACHABLE_REASONS.some(re => re.test(d.reason)));
    if (!reachable.length || maxExtra < 1) return { fetched: [], offered: 0 };

    const offered = reachable.slice(0, MAX_LINKS_TO_MODEL);
    const prompt = [
        'A reference document is being assembled from a set of pages.',
        '',
        `Subject: ${intent || manifest.seed}`,
        '',
        'These links were found but not fetched. Pick the ones worth fetching to fill gaps,',
        `at most ${maxExtra}. If none would help, answer with an empty array.`,
        'Answer with ONLY a JSON array of line numbers, e.g. [3, 7]',
        '',
        'Links:',
        ...offered.map((d, i) => `${i + 1}. ${d.url}`)
    ].join('\n');

    let picks;
    try {
        const res = await gateway.chat({
            model,
            messages: [{ role: 'user', content: prompt }],
            systemPrompt: 'You choose pages to fetch. You reply with a JSON array of numbers and nothing else.',
            enableThinking: false,
            maxTokens: SELECT_MAX_TOKENS,
            stream: false
        });
        picks = parseIndexList(res.content, offered.length, maxExtra).map(i => offered[i]);
    } catch (e) {
        log(`compose: could not ask for extra pages (${e.message}); composing from what was collected`);
        return { fetched: [], offered: offered.length, error: e.message };
    }

    if (!picks.length) {
        log('compose: the model asked for none of the abandoned links');
        return { fetched: [], offered: offered.length, chose: 0 };
    }

    const fetched = [];
    for (const pick of picks) {
        try {
            const r = await runBrowserFetch({ url: pick.url, dir });
            fetched.push({
                url: pick.url,
                title: r.title || pick.url,
                storage: r.relPath,
                text: fs.readFileSync(path.join(storageRoot, r.relPath), 'utf8')
            });
        } catch (e) {
            // Recorded, not swallowed: the document should say a gap stayed a gap.
            fetched.push({ url: pick.url, error: e.message });
        }
    }
    const ok = fetched.filter(f => !f.error);
    log(`compose: went back for ${ok.length}/${picks.length} abandoned link(s)`);
    return { fetched: ok, failed: fetched.filter(f => f.error), offered: offered.length, chose: picks.length };
}

const COMPOSE_SYSTEM_PROMPT = [
    'You write reference documentation from source material.',
    '',
    'You are REORGANISING the sources into one coherent document, not summarising',
    'them. The material must survive: keep code blocks verbatim and in order, keep',
    'tables, keep specific names, parameters, defaults and version numbers.',
    'Compressing the detail away is a failure.',
    '',
    'Remove navigation, breadcrumbs, "edit this page", related-links blocks and',
    'other page furniture. Merge material that is duplicated across sources. Order',
    'it the way a reader would want it: overview first, then the detail, then edge',
    'cases.',
    '',
    'Write CommonMark. Use ATX headings, fenced code blocks with a language, and',
    'pipe tables. Do not add a preamble about what you were given, and do not add a',
    'sources section — that is appended separately.'
].join('\n');

export async function harvest_compose(args, context) {
    const {
        manifest: manifestRel,
        intent,
        title,
        model = DEFAULT_COMPOSE_MODEL,
        fetch_missing = true,
        max_extra_pages = DEFAULT_EXTRA_PAGES,
        out
    } = args;

    if (typeof manifestRel !== 'string' || !manifestRel.trim()) {
        throw new Error('harvest_compose: manifest is required (a storage path to a harvest _manifest.json)');
    }
    if (!storageRoot) {
        throw new Error('harvest_compose: config agents.storage.root is required');
    }
    // No fallback exists for this pass, so an unreachable model is a hard error
    // rather than a degraded run.
    if (!context?.gateway) {
        throw new Error('harvest_compose: a gateway is required — this pass has no model-free fallback');
    }
    if (out !== undefined && (path.isAbsolute(out) || out.includes('..'))) {
        throw new Error(`harvest_compose: out must be a relative path inside storage, got '${out}'`);
    }

    const { manifest, abs: manifestAbs } = loadManifest(manifestRel.trim());
    const subject = intent || manifest.selection?.intent || manifest.seed;

    // Storage paths are forward-slash everywhere else in this system (the
    // manifest's own `storage` fields, browser.fetch's relPath), so both outputs
    // keep that shape rather than picking up Windows separators from path.join
    // and reporting paths that do not match the others.
    const manifestDir = manifestRel.trim().replace(/\/[^/]*$/, '');
    const docRel = out || `${manifestDir}/_document.md`;

    log(`compose from ${manifestRel} (${manifest.pages.length} page(s), model ${model})`);

    const collected = readSources(manifest);

    // ---- go back for what pass 1 left behind ----------------------------
    let extra = { fetched: [] };
    if (fetch_missing) {
        extra = await fetchAbandonedLinks({
            gateway: context.gateway,
            model,
            manifest,
            intent: subject,
            maxExtra: Math.max(0, Math.floor(max_extra_pages)),
            dir: manifestDir
        });
    }

    const sources = [...collected, ...(extra.fetched || [])];

    // ---- can the model hold it? -----------------------------------------
    const totalChars = sources.reduce((n, s) => n + s.text.length, 0);
    const budget = await contextBudgetChars(context.gateway, model);
    if (totalChars > budget) {
        throw new Error(
            `harvest_compose: ${sources.length} sources total ${totalChars.toLocaleString()} characters, ` +
            `over the ~${budget.toLocaleString()} this model can take. Nothing was truncated — ` +
            'use a larger-context model, or collect fewer pages (lower max_pages and re-collect).'
        );
    }

    // ---- write the document ---------------------------------------------
    const contextBlock = sources.map((s, i) =>
        `[Source ${i + 1}: ${s.url}]\nTitle: ${s.title}\n\n${s.text}`
    ).join('\n\n---\n\n');

    log(`compose: sending ${sources.length} source(s), ${(totalChars / 1024).toFixed(0)} KB, to ${model}`);
    const res = await context.gateway.chat({
        model,
        messages: [{
            role: 'user',
            content: `Write one reference document${title ? ` titled "${title}"` : ''} covering:\n` +
                `${subject}\n\n` +
                'Reorganise the following sources into it. Keep the detail; drop the furniture.\n\n' +
                `SOURCES:\n\n${contextBlock}`
        }],
        systemPrompt: COMPOSE_SYSTEM_PROMPT,
        enableThinking: false,
        maxTokens: COMPOSE_MAX_TOKENS,
        stream: false
    });

    const body = String(res.content ?? '').trim();
    if (!body) {
        throw new Error(
            `harvest_compose: ${model} returned an empty document ` +
            `(finish=${res.finish_reason || '?'}). Nothing was written.`
        );
    }

    const heading = title ? `# ${title}\n\n` : '';
    const front = [
        '---',
        `title: ${JSON.stringify(title || subject)}`,
        `source: ${JSON.stringify(manifest.seed)}`,
        `manifest: ${JSON.stringify(manifestRel)}`,
        `composed: ${new Date().toISOString()}`,
        `model: ${JSON.stringify(model)}`,
        `pages: ${sources.length}`,
        '---',
        ''
    ].join('\n');

    // Appended here rather than asked of the model: source URLs are provenance,
    // and a model writing them out is a chance to invent one.
    const sourcesSection = [
        '',
        '## Sources',
        '',
        ...sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})${s.storage ? ` — \`${s.storage}\`` : ''}`),
        '',
        ...(extra.failed?.length
            ? ['*Requested for this document but not retrieved:*', '', ...extra.failed.map(f => `- ${f.url} — ${f.error}`), '']
            : [])
    ].join('\n');

    const docAbs = path.join(storageRoot, docRel);
    fs.mkdirSync(path.dirname(docAbs), { recursive: true });
    fs.writeFileSync(docAbs, `${front}${heading}${body}\n${sourcesSection}`, 'utf8');

    const stat = fs.statSync(docAbs);
    const lines = [
        `Composed ${docRel}`,
        `  subject    ${subject}`,
        `  model      ${model}`,
        `  sources    ${collected.length} collected` +
            (extra.fetched?.length ? ` + ${extra.fetched.length} fetched on request` : '') +
            (extra.offered ? ` (${extra.offered} abandoned link(s) offered)` : ''),
        `  size       ${(stat.size / 1024).toFixed(1)} KB  (${body.length} chars of document)`,
        `  storage    ${docRel}`,
        siteBaseUrl ? `  url        ${siteBaseUrl.replace(/\/+$/, '')}/storage/${docRel}` : null,
        '',
        'Every source is listed in the document. Read it with storage.read; the per-page Markdown is still alongside it if the document needs work.'
    ].filter(l => l !== null);

    log(`composed ${docRel} (${stat.size} bytes from ${sources.length} source(s))`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
}
