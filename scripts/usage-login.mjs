// Renew the usage monitor's provider sessions in ONE visible window on its own
// Chrome profile (data/chrome-profile-usage, port 9223), then VERIFY each one
// before closing. A human at the keyboard is the only path that always works —
// provider logins hit 2FA, captchas and bot checks.
//
// This is the agent-side half of data/usage-login.html: that page tells Dave to
// leave the window open until the agent verifies; this script does the
// verifying, so the window no longer depends on a human remembering to say
// "done" (closing it early is what lost the 2026-11-02 attempt).
//
// One tab per provider, navigated once and never again — a script that
// navigates mid-sign-in yanks the page out from under the sign-in.
//
//   node scripts/usage-login.mjs                 # kimi gemini anthropic
//   node scripts/usage-login.mjs kimi openai     # any subset of PROVIDERS names
//
// USAGE_LOGIN_TIMEOUT_MIN (default 10) bounds the wait. Exit code 0 only when
// every requested provider verified.
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROFILES } from '../src/agents/usage-monitor/profiles.js';
import { ANTHROPIC_ORG } from '../src/agents/usage-monitor/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const geminiAccount = config.agents?.['usage-monitor']?.geminiAccount || process.env.USAGE_MONITOR_GEMINI_ACCOUNT;
if (!geminiAccount) throw new Error('no geminiAccount: set agents.usage-monitor.geminiAccount in config.json');

const { dir: PROFILE, port: PORT, chromeProfile } = PROFILES.usage;
const POLL_MS = 2500;
const DEADLINE_MS = (Number(process.env.USAGE_LOGIN_TIMEOUT_MIN) || 10) * 60 * 1000;

// `check` runs in the provider's own origin with its cookies and storage, so it
// answers the question the extractor will ask on the next cycle — not a proxy
// for it (token presence is not a session; the RPC is).
const PROVIDERS = [
    {
        name: 'gemini',
        url: 'https://aistudio.google.com/u/0/rate-limit',
        hint: `sign in as ${geminiAccount} — the account that owns the AI Studio project`,
        async check({ account }) {
            if (location.hostname !== 'aistudio.google.com') return { ok: false, note: `Google sign-in (${location.hostname})` };
            const accounts = [...new Set(document.body.innerText.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [])];
            if (!accounts.includes(account)) return { ok: false, note: `signed in as ${accounts.join(', ') || 'nobody'} — need ${account}` };
            const rows = document.querySelectorAll('table tbody tr').length;
            if (!rows) return { ok: false, note: `${account} signed in, rate-limit table not rendered yet` };
            return { ok: true, note: `${account}, ${rows} model rows` };
        }
    },
    {
        name: 'kimi',
        url: 'https://www.kimi.ai/code/console',
        hint: 'sign in',
        async check() {
            if (!/(^|\.)kimi\.ai$/.test(location.hostname)) return { ok: false, note: `on ${location.hostname}` };
            const tok = localStorage.getItem('access_token');
            if (!tok) return { ok: false, note: 'no access_token yet — signed out' };
            const r = await fetch('https://www.kimi.ai/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}'
            });
            return { ok: r.status === 200, note: `GetSubscriptionStats HTTP ${r.status}` };
        }
    },
    {
        name: 'anthropic',
        url: 'https://platform.claude.com/dashboard',
        hint: 'sign in',
        async check({ org }) {
            if (location.hostname !== 'platform.claude.com') return { ok: false, note: `on ${location.hostname}` };
            const r = await fetch(`https://platform.claude.com/api/organizations/${org}/current_spend`, { credentials: 'include' });
            if (r.status === 200) return { ok: true, note: 'current_spend HTTP 200' };
            const text = await r.text().catch(() => '');
            return { ok: false, note: `current_spend HTTP ${r.status} — ${text.slice(0, 80)}` };
        }
    },
    {
        name: 'minimax',
        url: 'https://platform.minimax.io/console/usage',
        hint: 'sign in',
        async check() {
            if (!/(^|\.)minimax\.io$/.test(location.hostname)) return { ok: false, note: `on ${location.hostname}` };
            return { ok: document.body.innerText.includes('%'), note: 'usage percentages on page' };
        }
    },
    {
        name: 'openai',
        url: 'https://platform.openai.com/usage',
        hint: 'sign in',
        async check() {
            if (!/(^|\.)openai\.com$/.test(location.hostname)) return { ok: false, note: `on ${location.hostname}` };
            const spend = /\$[\d,.]+\s*\/\s*\$[\d,.]+/.test(document.body.innerText);
            return { ok: spend, note: spend ? 'spend figure on page' : 'no "$X / $Y" spend figure yet' };
        }
    }
];

const wanted = process.argv.slice(2);
const selected = wanted.length ? wanted : ['gemini', 'kimi', 'anthropic'];
for (const name of selected) {
    if (!PROVIDERS.some(p => p.name === name)) {
        throw new Error(`unknown provider "${name}" — use ${PROVIDERS.map(p => p.name).join(' | ')}`);
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`Opening the monitor's usage Chrome profile (${PROFILE}, port ${PORT}) for: ${selected.join(', ')}`);
console.log('In each tab: sign in. The window closes itself once every tab verifies.\n');

let browser;
// A cycle may hold the profile for ~2 minutes — losing that race is normal.
for (let attempt = 1; ; attempt++) {
    try {
        browser = await puppeteer.launch({
            headless: false,
            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
                   `--profile-directory=${chromeProfile}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`]
        });
        break;
    } catch (err) {
        if (attempt >= 6) throw new Error(`could not open Chrome on the usage profile after ${attempt} attempts (${err.message})`);
        console.log(`  … profile busy (the usage-monitor's cycle holds it for ~2 min) — retrying in 20s (${attempt}/6)`);
        await sleep(20000);
    }
}

let disconnected = false;
browser.on('disconnected', () => { disconnected = true; });

try {
    // Chrome restores the profile's tabs on launch; blank ones are never a live
    // scraper page, so sweep them and leave one tab to think about.
    const first = await browser.newPage();
    await first.setViewport({ width: 1280, height: 900 });
    let swept = 0;
    for (const other of await browser.pages()) {
        if (other === first || other.url() !== 'about:blank') continue;
        if (await other.close().then(() => true).catch(() => false)) swept++;
    }
    if (swept) console.log(`Closed ${swept} leftover blank tab(s) restored on this profile.\n`);

    const targets = [];
    for (const [i, name] of selected.entries()) {
        const def = PROVIDERS.find(p => p.name === name);
        const page = i === 0 ? first : await browser.newPage();
        if (i > 0) await page.setViewport({ width: 1280, height: 900 });
        console.log(`  tab ${i + 1}: ${name} — ${def.hint}`);
        // Never re-navigate: the human is about to type into this page.
        await page.goto(def.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => {
            console.log(`    (${name}: initial load did not finish — ${err.message.split('\n')[0]}; reload the tab yourself)`);
        });
        targets.push({ ...def, page, lastNote: null, ok: false });
    }
    console.log('');

    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline && !disconnected) {
        await sleep(POLL_MS);
        for (const t of targets) {
            if (t.ok) continue;
            let state;
            try {
                state = await t.page.evaluate(t.check, { account: geminiAccount, org: ANTHROPIC_ORG });
            } catch {
                continue; // mid-navigation or a tab that is gone
            }
            if (state.ok) {
                t.ok = true;
                console.log(`✓ ${t.name}: ${state.note}`);
            } else if (state.note !== t.lastNote) {
                console.log(`  … ${t.name}: ${state.note}`);
                t.lastNote = state.note;
            }
        }
        if (targets.every(t => t.ok)) break;
    }

    const failed = targets.filter(t => !t.ok);
    if (disconnected) {
        console.log('\n✗ the window was closed before verification finished');
        process.exitCode = 1;
    } else if (failed.length) {
        console.log(`\n✗ timed out after ${Math.round(DEADLINE_MS / 60000)} min — still unverified: ${failed.map(t => t.name).join(', ')}`);
        console.log(`  last state: ${failed.map(t => `${t.name} (${t.lastNote || 'never probed'})`).join('; ')}`);
        process.exitCode = 1;
    } else {
        console.log('\n✓ every requested session verified — the usage-monitor picks them up on its next cycle.');
    }
} finally {
    if (!disconnected) await browser.close().catch(() => {});
}
