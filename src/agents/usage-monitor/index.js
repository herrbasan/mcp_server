// usage-monitor — LLM subscription usage collector.
//
// Consolidates per-provider usage/limits into ONE normalized JSON on a timer:
//   { updatedAt, providers: { <name>: { windows: [...] } }, stale: [...] }
// Window kinds: "5h" | "weekly" | "tpm-day" | "monthly" | "pool".
//
// Extraction routes (all verified 2026-09-26, see docs/usage-monitor.md):
//   z.ai      page-context fetch, Bearer from localStorage
//   gemini    DOM scrape (rate-limit table w/ range forced to 1 Day + spend page)
//   kimi      page-context RPC, Bearer from localStorage
//   minimax   page-context fetch, cookies
//   openai    DOM scrape (span matching "$X / $Y")
//   anthropic page-context fetch (cookies) + DOM scrape for the spend line
//   deepseek  direct API with gateway-config key
//   openrouter direct API with gateway-config key
//
// Browser work reuses the shared workshop Chrome profile (data/chrome-profile)
// via CDP attach-or-launch, exactly like the browser agent, so the logins
// Dave established in the visible session persist.

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const DEBUGGING_PORT = 9222;
const CHROME_PROFILE_DIR = path.join(PROJECT_ROOT, 'data', 'chrome-profile');
const OUT_PATH = path.join(PROJECT_ROOT, 'data', 'usage-limits.json');

const DEFAULT_INTERVAL_MIN = 10;
const GATEWAY_CONFIG = 'D:\\DEV\\LLM Gateway\\config.json';

let scheduler = null;
let browser = null;
let running = false;
let lastRun = null;
let lastDurationMs = null;
let nextRunAt = null;
const providerHealth = new Map(); // name -> { lastOk, lastError, okCount, errCount }

// ── shared browser ──────────────────────────────────────────────────────

let launchedByUs = false;

async function getBrowser() {
    if (browser) return browser;
    try {
        // browserURL, NOT browserWSEndpoint: a bare `ws://localhost:9222` is
        // not a CDP endpoint (answers 404), so that branch never succeeded —
        // every cycle fell through to launch and died on the profile lock
        // whenever the workshop Chrome already held data/chrome-profile
        // (same bug the browser agent fixed; see its initBrowser comment).
        browser = await puppeteer.connect({ browserURL: `http://localhost:${DEBUGGING_PORT}`, timeout: 3000 });
        launchedByUs = false;
        logger.info('[UsageMonitor] Attached to running Chrome via CDP', null, 'Usage');
        return browser;
    } catch {
        // fall through to launch
    }
    // HEADLESS. All extraction routes verified working headless 2026-09-27;
    // openai's Cloudflare passes once the UA override in runCycle strips the
    // 'Headless' marker. The old headed off-screen launch was dropped because
    // Chrome clamps restored window bounds back on-screen before the CDP move
    // lands — a visible window flash every cycle.
    browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            `--remote-debugging-port=${DEBUGGING_PORT}`,
            `--user-data-dir=${CHROME_PROFILE_DIR}`
        ]
    });
    launchedByUs = true;
    browser.on('disconnected', () => { browser = null; launchedByUs = false; });
    logger.info('[UsageMonitor] Launched headless Chrome on shared profile', null, 'Usage');
    return browser;
}

async function releaseBrowser() {
    if (!browser) return;
    try {
        // Only a browser WE launched may be closed. An attached one (e.g.
        // Dave's visible session, or the browser agent's shared instance)
        // must keep running — disconnect leaves it untouched.
        if (launchedByUs) await browser.close();
        else await browser.disconnect();
    } catch { /* already gone */ }
    browser = null;
    launchedByUs = false;
}

// page.evaluate treats a string as an expression; our extractors are async
// function bodies, so we wrap them in `(async () => { ... })()` strings.
async function evalOn(page, script) {
    return await page.evaluate(`(async () => { ${script} })()`);
}

// On failure, capture URL + body text + screenshot so the broken selector or
// login state is visible instead of guessable.
async function debugCapture(page, name, err) {
    try {
        const dir = path.join(PROJECT_ROOT, 'data', 'usage-monitor-debug');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        let url = 'unknown', text = '';
        try { url = page.url(); text = (await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000))) || ''; } catch { /* page gone */ }
        fs.writeFileSync(path.join(dir, `${name}-${stamp}.txt`), `url: ${url}\nerror: ${err.message}\n\n${text}`, 'utf8');
        await page.screenshot({ path: path.join(dir, `${name}-${stamp}.png`) }).catch(() => {});
    } catch { /* never mask the real error */ }
}

// ── per-provider extractors ─────────────────────────────────────────────
// Each returns { windows: [...] }. Windows: { kind, usedPct?, used?, limit?, unit?, resetAt?, extra? }
// Every extractor throws on missing data — never fabricates values.

// z.ai omits nextResetTime on unused windows (proto3 JSON drops zero
// values — verified 2026-09-27: a 0% window ships no reset time in API
// and DOM). The window itself is still valid; carry the absence as a note.
const zaiReset = (l) => l.nextResetTime
    ? { resetAt: new Date(l.nextResetTime).toISOString() }
    : { note: 'no reset time — window unused' };

async function extractZai(page) {
    await page.goto('https://z.ai/manage-apikey/coding-plan/personal/usage', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('text/Quota', { timeout: 20000 }).catch(() => {});
    const res = await evalOn(page, `
        const tok = localStorage.getItem('z-ai-open-platform-token-production');
        if (!tok) throw new Error('z.ai: no token in localStorage — logged out');
        const r = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', { headers: { Authorization: 'Bearer ' + tok } });
        const j = await r.json();
        if (j.code !== 200) throw new Error('z.ai API code ' + j.code);
        const win = {};
        for (const l of j.data.limits || []) {
            if (l.type === 'TOKENS_LIMIT' && l.unit === 3) win.fiveHour = l;
            if (l.type === 'TOKENS_LIMIT' && l.unit === 6) win.weekly = l;
        }
        if (!win.fiveHour || !win.weekly) throw new Error('z.ai: expected windows missing');
        return win;
    `);
    return { windows: [
        { kind: '5h', usedPct: res.fiveHour.percentage, ...zaiReset(res.fiveHour), primary: true },
        { kind: 'weekly', usedPct: res.weekly.percentage, ...zaiReset(res.weekly), primary: true }
    ] };
}

const K_M = { K: 1e3, M: 1e6, B: 1e9 };
function parseNum(s) {
    const m = String(s).trim().match(/^([\d,.]+)\s*([KMB])?$/i);
    if (!m) throw new Error(`parseNum: cannot parse "${s}"`);
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isNaN(n)) throw new Error(`parseNum: NaN from "${s}"`);
    return m[2] ? n * K_M[m[2].toUpperCase()] : n;
}

async function extractGemini(page) {
    // 1) rate-limit table with range forced to "1 Day"
    await page.goto('https://aistudio.google.com/u/1/rate-limit', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('table', { timeout: 25000 });
    // force the time range (default 28 Days shows 28-day peaks — misleading)
    const switched = await evalOn(page, `
        const sel = [...document.querySelectorAll('mat-select')].find(s => /Last Hour|1 Day|7 Days|28 Days/i.test(s.textContent || ''));
        if (!sel) return 'no-select';
        sel.click();
        await new Promise(r => setTimeout(r, 900));
        const opt = [...document.querySelectorAll('mat-option')].find(o => (o.textContent || '').trim() === '1 Day');
        if (!opt) return 'no-option';
        opt.click();
        return 'ok';
    `).catch(() => 'error');
    if (switched !== 'ok') throw new Error('gemini: could not set 1 Day range (' + switched + ')');
    await new Promise(r => setTimeout(r, 2500));
    const tpmRows = await evalOn(page, `
        const t = document.querySelector('table');
        if (!t) throw new Error('gemini: no rate table');
        const rows = [...t.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim()));
        if (!rows.length) throw new Error('gemini: empty rate table');
        return rows.map(r => ({ status: r[0], model: r[1], rpm: r[3], tpm: r[4], rpd: r[5] }));
    `);
    const tpmWindows = [];
    for (const row of tpmRows) {
        const m = row.tpm.match(/^([\d.,]+\s*[KMB]?)\s*\/\s*([\d.,]+\s*[KMB]?)$/i);
        if (!m) throw new Error(`gemini: TPM cell unparseable: "${row.tpm}"`);
        const used = parseNum(m[1]);
        const limit = parseNum(m[2]);
        tpmWindows.push({
            kind: 'tpm-day', model: row.model, status: row.status,
            used, limit, usedPct: Math.round((used / limit) * 100)
        });
    }
    if (!tpmWindows.length) throw new Error('gemini: no TPM rows after parse');
    // primary chip = the model closest to its TPM limit today (what Dave trips);
    // full per-model detail rides along in `models`
    const top = tpmWindows.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
    // 2) spend cap
    await page.goto('https://aistudio.google.com/u/1/spend', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('span.usage', { timeout: 25000 });
    const spend = await evalOn(page, `
        const u = document.querySelector('span.usage');
        const l = document.querySelector('span.limit');
        if (!u || !l) throw new Error('gemini: spend spans missing');
        return { used: u.textContent.trim(), limit: l.textContent.trim() };
    `);
    // Throws on unparseable text: a NaN here would serialize as null and
    // look like a successful 0-info window instead of a broken scrape
    // (observed 2026-09-30 — spend spans rendered a placeholder mid-load).
    const eur = (s) => {
        const n = Number(String(s).replace(/[€\s]/g, ''));
        if (!Number.isFinite(n)) throw new Error(`gemini: spend span unparseable: "${s}"`);
        return n;
    };
    const usedEur = eur(spend.used), limitEur = eur(spend.limit);
    if (limitEur <= 0) throw new Error(`gemini: spend limit not positive: "${spend.limit}"`);
    return { windows: [
        { kind: 'tpm-day', model: top.model, used: top.used, limit: top.limit, usedPct: top.usedPct, primary: true, models: tpmWindows },
        { kind: 'monthly', used: usedEur, limit: limitEur, unit: 'EUR', usedPct: Math.round((usedEur / limitEur) * 100), primary: true }
    ] };
}

async function extractKimi(page) {
    await page.goto('https://www.kimi.ai/code/console', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The SPA refreshes the short-lived access_token on load. Give it time,
    // then re-read the token fresh right before the call.
    await page.waitForSelector('text/Console', { timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));
    const res = await evalOn(page, `
        const call = async () => {
            const tok = localStorage.getItem('access_token');
            if (!tok) throw new Error('kimi: no access_token — logged out');
            const r = await fetch('https://www.kimi.ai/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}'
            });
            if (r.status === 401) return { retry: true };
            if (r.status !== 200) throw new Error('kimi RPC HTTP ' + r.status);
            return await r.json();
        };
        let res = await call();
        if (res.retry) {
            // token stale — let the app rotate it, then re-read and retry once
            await new Promise(r => setTimeout(r, 5000));
            res = await call();
            if (res.retry) throw new Error('kimi: token stale after retry — session expired, needs login');
        }
        return res;
    `);
    const w5 = res.ratelimitCode5h, w7 = res.ratelimitCode7d, sub = res.subscriptionBalance, booster = (res.boosterWallets || [])[0];
    if (!w5 || !w7 || !sub) throw new Error('kimi: expected fields missing');
    // proto3 JSON omits zero-valued fields: an absent ratio IS 0% used
    // (verified 2026-09-27 — the 5h window at zero usage ships
    // {enabled, resetTime} with no ratio, while the weekly window has one).
    const pct = (r) => Math.round((r ?? 0) * 100);
    const windows = [
        { kind: '5h', usedPct: pct(w5.ratio), resetAt: w5.resetTime, primary: true },
        { kind: 'weekly', usedPct: pct(w7.ratio), resetAt: w7.resetTime, primary: true },
        { kind: 'monthly', usedPct: pct(sub.amountUsedRatio), resetAt: sub.expireTime, note: 'subscription credits' }
    ];
    if (booster) {
        windows.push({
            kind: 'pool', unit: 'USD',
            remaining: booster.moneyLeft.priceInCents / 100,
            used: booster.monthlyUsed.priceInCents / 100,
            limit: booster.monthlyChargeLimit.priceInCents / 100,
            usedPct: Math.round((booster.monthlyUsed.priceInCents / booster.monthlyChargeLimit.priceInCents) * 100),
            note: 'Extra Usage wallet'
        });
    }
    return { windows };
}

async function extractMinimax(page) {
    await page.goto('https://platform.minimax.io/console/usage', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const res = await evalOn(page, `
        const r = await fetch('https://platform.minimax.io/backend/account/token_plan/remains_percent', { credentials: 'include' });
        if (r.status !== 200) throw new Error('minimax HTTP ' + r.status);
        return await r.json();
    `);
    if (res.base_resp && res.base_resp.status_code !== 0) {
        throw new Error('minimax API: ' + (res.base_resp.status_msg || res.base_resp.status_code));
    }
    const m = (res.model_remains || []).find(x => x.model_name === 'general') || (res.model_remains || [])[0];
    if (!m) throw new Error('minimax: no model_remains');
    // The response carries explicit per-window USED-percent fields. The sibling
    // *_total_percent field is a fixed "100%" label, NOT a remaining figure —
    // computing used as (100 - total_percent) pinned every window to 0% used
    // (bug fixed 2026-09-28). The *_count fields are -1 on credit/PAYG accounts
    // and are unusable; upstream *also* mislabels *_usage_count as "used" when
    // it actually returns REMAINING (MiniMax-AI/MiniMax-M2#99). The percent
    // fields are the authoritative source.
    const pct = (s) => {
        const n = Number(String(s).replace('%', ''));
        if (Number.isNaN(n)) throw new Error(`minimax: unparseable percent "${s}"`);
        return n;
    };
    const windows = [
        { kind: '5h', usedPct: pct(m.current_interval_used_percent), resetAt: new Date(m.end_time).toISOString(), primary: true }
    ];
    // Window status: 1 = enforced, 3 = unlimited / not enforced
    // (community-documented signature: total=0, remaining=100%, status=3).
    // Under the Token Plan weekly was status 3 and stayed out; the M Plan
    // (2026-09-30) enforces it — a genuine 7-day second limit — so it emits.
    // The API names it "weekly" even though the plan bills monthly; the
    // reset timestamp (weekly_end_time, exactly +7d) is the truth.
    if (m.current_weekly_status !== 3) {
        windows.push({ kind: 'weekly', usedPct: pct(m.current_weekly_used_percent), resetAt: new Date(m.weekly_end_time).toISOString(), primary: true });
    }
    // M Plan credit balance — consumed automatically once plan quota is
    // exhausted ("Credit balance" card on the usage console).
    const cred = await evalOn(page, `
        const r = await fetch('https://platform.minimax.io/backend/account/token_plan_credit', { credentials: 'include' });
        if (r.status !== 200) throw new Error('minimax HTTP ' + r.status);
        return await r.json();
    `);
    if (cred.base_resp && cred.base_resp.status_code !== 0) {
        throw new Error('minimax credits: ' + (cred.base_resp.status_msg || cred.base_resp.status_code));
    }
    if (typeof cred.total_credits !== 'number' || typeof cred.used_credits !== 'number' || typeof cred.remaining_credits !== 'number') {
        throw new Error('minimax credits: fields missing');
    }
    if (cred.total_credits > 0) {
        windows.push({
            kind: 'pool', unit: 'credits',
            used: cred.used_credits, limit: cred.total_credits, remaining: cred.remaining_credits,
            usedPct: Math.round((cred.used_credits / cred.total_credits) * 100)
        });
    }
    return { windows };
}

async function extractOpenai(page) {
    await page.goto('https://platform.openai.com/usage', { waitUntil: 'networkidle2', timeout: 60000 });
    // SPA renders late; poll for the spend span instead of a fixed wait
    const res = await evalOn(page, `
        for (let i = 0; i < 30; i++) {
            const span = [...document.querySelectorAll('span')].find(s => /^\\$[\\d.]+ \\/ \\$[\\d.]+$/.test((s.textContent || '').trim()));
            if (span) return span.textContent.trim();
            await new Promise(r => setTimeout(r, 1000));
        }
        throw new Error('openai: spend span not found after 30s (url: ' + location.pathname + ')');
    `);
    const m = res.match(/^\$([\d.]+) \/ \$([\d.]+)$/);
    const used = Number(m[1]), limit = Number(m[2]);
    return { windows: [
        { kind: 'monthly', used, limit, unit: 'USD', usedPct: Math.round((used / limit) * 100), note: 'calendar-month budget', primary: true }
    ] };
}

const ANTHROPIC_ORG = '1880fff6-d300-41e2-b981-7d13e4869b58';
async function extractAnthropic(page) {
    await page.goto('https://platform.claude.com/dashboard', { waitUntil: 'networkidle2', timeout: 60000 });
    const res = await evalOn(page, `
        // wait for the spend widget to hydrate
        for (let i = 0; i < 30; i++) {
            const el = document.querySelector('span.text-primary.text-3xl');
            if (el && /^\\$[\\d.]+$/.test(el.textContent.trim())) break;
            await new Promise(r => setTimeout(r, 1000));
        }
        const base = 'https://platform.claude.com/api/organizations/${ANTHROPIC_ORG}';
        const credits = await (await fetch(base + '/prepaid/credits', { credentials: 'include' })).json();
        const limits = await (await fetch(base + '/spend_limits', { credentials: 'include' })).json();
        const spendEl = document.querySelector('span.text-primary.text-3xl');
        const limitEl = document.querySelector('span.text-muted.text-body');
        if (!spendEl || !limitEl) throw new Error('anthropic: dashboard spans missing after 30s (url: ' + location.pathname + ')');
        const mSpend = spendEl.textContent.trim().match(/^\\$([\\d.]+)$/);
        const mLimit = limitEl.textContent.trim().match(/of \\$([\\d.]+) limit \\u00b7 resets (\\w+ \\d+)/);
        if (!mSpend) throw new Error('anthropic: spend unparseable: "' + spendEl.textContent.trim() + '"');
        if (!mLimit) throw new Error('anthropic: limit line unparseable: "' + limitEl.textContent.trim() + '"');
        return { credits, limits, spend: Number(mSpend[1]), limit: Number(mLimit[1]), resets: mLimit[2] };
    `);
    const pause = (res.limits.spend_limits || []).find(l => l.limit_action === 'notify_and_pause');
    const windows = [
        { kind: 'monthly', used: res.spend, limit: res.limit, unit: 'USD', usedPct: Math.round((res.spend / res.limit) * 100), resetAt: res.resets, note: 'spend this month', primary: true },
        { kind: 'pool', remaining: res.credits.amount / 100, unit: 'USD', note: 'prepaid credits' }
    ];
    if (pause) windows[0].hardLimit = pause.limit_usd / 100;
    return { windows };
}

// ── direct-API providers (no browser) ───────────────────────────────────

function gatewayModel(matchRe) {
    const cfgPath = GATEWAY_CONFIG;
    if (!fs.existsSync(cfgPath)) throw new Error(`usage-monitor: gateway config not found at ${cfgPath}`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const entry = Object.entries(cfg.models || {}).find(([, m]) => matchRe.test(m.endpoint || ''));
    if (!entry) throw new Error('usage-monitor: no matching gateway model for direct API provider');
    return entry[1];
}

async function extractDeepseek() {
    const m = gatewayModel(/api\.deepseek\.com/);
    const res = await fetch(new URL(m.endpoint).origin + '/user/balance', {
        headers: { Authorization: `Bearer ${m.apiKey}` }, signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`deepseek HTTP ${res.status}`);
    const j = await res.json();
    const b = (j.balance_infos || []).find(x => x.currency === 'USD') || (j.balance_infos || [])[0];
    if (!b) throw new Error('deepseek: no balance_infos');
    return { windows: [
        { kind: 'pool', remaining: Number(b.total_balance), unit: 'USD', note: 'topped-up balance', primary: true }
    ] };
}

async function extractOpenrouter() {
    const m = gatewayModel(/openrouter\.ai/);
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${m.apiKey}` }, signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`openrouter HTTP ${res.status}`);
    const j = await res.json();
    const d = j.data;
    if (d.limit == null) throw new Error('openrouter: no limit in response');
    return { windows: [
        { kind: 'monthly', used: d.usage, limit: d.limit, unit: 'USD', usedPct: Math.round((d.usage / d.limit) * 100), note: `resets ${d.limit_reset}`, primary: true }
    ] };
}

// ── orchestration ───────────────────────────────────────────────────────

// Array order = listing order in usage-limits.json (Dave's priority,
// 2026-09-30): kimi, z.ai, minimax, deepseek, gemini, openrouter, openai,
// anthropic. Key insertion order follows this loop, so reordering here
// reorders the dashboard. Execution order follows too — providers are
// independent, interleaving browser/direct is harmless.
const PROVIDERS = [
    { name: 'kimi', browser: true, fn: extractKimi },
    { name: 'zai', browser: true, fn: extractZai },
    { name: 'minimax', browser: true, fn: extractMinimax },
    { name: 'deepseek', browser: false, fn: extractDeepseek },
    { name: 'gemini', browser: true, fn: extractGemini },
    { name: 'openrouter', browser: false, fn: extractOpenrouter },
    { name: 'openai', browser: true, fn: extractOpenai },
    { name: 'anthropic', browser: true, fn: extractAnthropic }
];

async function runCycle() {
    if (running) return { skipped: true, reason: 'already running' };
    running = true;
    const started = Date.now();
    const previous = readState();
    const providers = {};
    const stale = [];
    // Escalation threshold: log at ERROR (nPM's LLM monitor surfaces mcp_server
    // ERROR lines in localweb2's health view) once per breakage episode.
    const ESCALATE_AFTER = 3;

    let page = null;
    try {
        for (const p of PROVIDERS) {
            try {
                let result;
                if (p.browser) {
                    if (!page) {
                        const b = await getBrowser();
                        page = await b.newPage();
                        // New headless still advertises 'HeadlessChrome' in the
                        // UA — OpenAI's Cloudflare gates on it. Stripping the
                        // marker passes (verified 2026-09-27). On a normal UA
                        // the replace is a no-op, so attach mode is unaffected.
                        await page.setUserAgent((await b.userAgent()).replace('Headless', ''));
                    }
                    result = await p.fn(page);
                } else {
                    result = await p.fn();
                }
                providers[p.name] = result;
                providerHealth.set(p.name, { lastOk: new Date().toISOString(), lastError: null, consecutiveFailures: 0,
                    okCount: ((providerHealth.get(p.name) || {}).okCount || 0) + 1, errCount: (providerHealth.get(p.name) || {}).errCount || 0 });
                logger.info(`[UsageMonitor] ${p.name}: ok (${result.windows.length} windows)`, null, 'Usage');
            } catch (err) {
                stale.push(p.name);
                const prevHealth = providerHealth.get(p.name) || {};
                const consecutive = (prevHealth.consecutiveFailures || 0) + 1;
                providerHealth.set(p.name, { lastOk: prevHealth.lastOk || null, lastError: err.message, consecutiveFailures: consecutive,
                    okCount: prevHealth.okCount || 0, errCount: (prevHealth.errCount || 0) + 1 });
                logger.warn(`[UsageMonitor] ${p.name}: FAILED (${consecutive}x consecutive) — ${err.message} (keeping last-good)`, null, 'Usage');
                if (p.browser && page) await debugCapture(page, p.name, err);
                if (consecutive === ESCALATE_AFTER) {
                    // Once per episode (exactly on the 3rd), not every cycle.
                    // Debug captures for every failure sit in data/usage-monitor-debug/.
                    logger.error(`[UsageMonitor] ${p.name}: extraction broken for ${consecutive} consecutive cycles — ${err.message}. Selectors may have drifted; debug captures in data/usage-monitor-debug/`, null, 'Usage');
                }
                // keep last-good values, marked stale, WITH the reason so the
                // dashboard can show what broke and since when
                const prev = previous?.providers?.[p.name];
                const staleSince = prev?.staleSince || new Date().toISOString();
                if (prev) providers[p.name] = { ...prev, stale: true, staleError: err.message, staleSince };
                else providers[p.name] = { windows: [], stale: true, staleError: err.message, staleSince };
            }
        }
    } finally {
        if (page) { try { await page.close(); } catch { /* closed */ } }
        await releaseBrowser();
    }

    const state = { updatedAt: new Date().toISOString(), providers, stale };
    writeState(state);
    lastRun = state.updatedAt;
    lastDurationMs = Date.now() - started;
    running = false;
    return state;
}

function readState() {
    try { return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch { return null; }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── agent interface ─────────────────────────────────────────────────────

export async function init(context) {
    const conf = context.config?.agents?.['usage-monitor'] || {};
    const intervalMin = conf.intervalMinutes ?? DEFAULT_INTERVAL_MIN;
    const autoStart = conf.autoStart !== false;

    if (autoStart) {
        // first run shortly after boot, then on the timer
        setTimeout(() => { runCycle().catch(e => logger.error('[UsageMonitor] initial cycle failed', e, null, 'Usage')); }, 15000);
        scheduler = setInterval(() => { runCycle().catch(e => logger.error('[UsageMonitor] cycle failed', e, null, 'Usage')); }, intervalMin * 60 * 1000);
        nextRunAt = new Date(Date.now() + intervalMin * 60 * 1000).toISOString();
        logger.info(`[UsageMonitor] started — every ${intervalMin} min, output ${OUT_PATH}`, null, 'Usage');
    }
    return {};
}

export async function shutdown() {
    if (scheduler) clearInterval(scheduler);
    await releaseBrowser();
}

export async function usage_scan(args, context) {
    const state = await runCycle();
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
}

export async function usage_status(args, context) {
    const health = {};
    for (const p of PROVIDERS) {
        const h = providerHealth.get(p.name);
        health[p.name] = h ? { lastOk: h.lastOk, lastError: h.lastError, consecutiveFailures: h.consecutiveFailures || 0, okCount: h.okCount, errCount: h.errCount } : { lastOk: null, lastError: null, consecutiveFailures: 0, okCount: 0, errCount: 0 };
    }
    return { content: [{ type: 'text', text: JSON.stringify({
        lastRun, lastDurationMs, nextRunAt, running,
        output: OUT_PATH, health
    }, null, 2) }] };
}
