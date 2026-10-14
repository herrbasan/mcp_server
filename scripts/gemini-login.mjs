// Sign in to AI Studio as the account that owns the Gemini API project, in a
// VISIBLE Chrome window on the shared workshop profile. Google decides what it
// will accept from an automated session; a human at the keyboard is the only
// path that always works (2FA, device prompts, bot checks all stop there).
//
// Opens Google's AddSession entry on purpose: the plain sign-in URL redirects
// to myaccount.google.com when another account already holds the session, so
// there is nothing to type. AddSession shows the account chooser, which lists
// david@raum.com as remembered-but-signed-out — click it, enter the password,
// and Google continues to the AI Studio rate-limit page.
//
// The session lands in data/chrome-profile, so the usage-monitor picks it up on
// its next cycle with no further action. This script only WATCHES the window —
// it never navigates it, which would yank the page out from under a sign-in in
// progress — and closes it once AI Studio shows the account with a rate-limit
// table (or after 5 minutes).
//
//   node scripts/gemini-login.mjs [email]
//
// Email defaults to agents.usage-monitor.geminiAccount from config.json.
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PROFILE = path.join(root, 'data', 'chrome-profile');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const account = process.argv[2] || config.agents?.['usage-monitor']?.geminiAccount;
if (!account) throw new Error('no account: pass one as an argument or set agents.usage-monitor.geminiAccount in config.json');

const POLL_MS = 2000;
const DEADLINE_MS = 5 * 60 * 1000;
const AISTUDIO = 'https://aistudio.google.com/u/0/rate-limit';

console.log(`Opening Chrome to sign in as ${account}.`);
console.log('In the window: click that account, enter the password, let it reach AI Studio.');
console.log('This script watches (never navigates) and closes the window when done.\n');

let browser;
// The profile is shared with the usage-monitor, which launches its own Chrome
// for ~2 minutes every 10 — a launch that loses that race is normal, not an
// error worth handing to the user.
for (let attempt = 1; ; attempt++) {
    try {
        browser = await puppeteer.launch({
            headless: false,
            // Same debug port as the agent: the usage-monitor then attaches to
            // this window instead of launching a second Chrome on the same
            // profile and failing its cycle while you sign in.
            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--remote-debugging-port=9222', `--user-data-dir=${PROFILE}`],
        });
        break;
    } catch (err) {
        if (attempt >= 6) throw new Error(`could not open Chrome on the shared profile after ${attempt} attempts (${err.message})`);
        console.log(`  … profile busy (the usage-monitor's cycle holds it for ~2 min) — retrying in 20s (${attempt}/6)`);
        await new Promise(r => setTimeout(r, 20000));
    }
}

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // This window is the newest lease on a profile that every scraper and probe
    // has been leaving tabs in; Chrome restores them on launch. Close the blank
    // ones (they are never a live scraper page — the monitor navigates its page
    // as its first act) so there is one tab to think about.
    let swept = 0;
    for (const other of await browser.pages()) {
        if (other === page || other.url() !== 'about:blank') continue;
        if (await other.close().then(() => true).catch(() => false)) swept++;
    }
    if (swept) console.log(`Closed ${swept} leftover blank tab(s) restored on this profile.\n`);
    await page.goto('https://accounts.google.com/AddSession?hl=en&continue=' + encodeURIComponent(AISTUDIO), { waitUntil: 'domcontentloaded', timeout: 60000 });

    const deadline = Date.now() + DEADLINE_MS;
    let lastNote = '';
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_MS));
        let state;
        try {
            state = await page.evaluate(() => ({
                href: location.href,
                accounts: [...new Set((document.body.innerText.match(/[\w.+-]+@[\w.-]+\.\w+/g) || []))],
                table: !!document.querySelector('table'),
                rows: document.querySelectorAll('table tbody tr').length,
                noProject: /No Cloud Projects Available/i.test(document.body.innerText),
                blocked: /verify it.?s you|2-Step Verification|Couldn.t sign you in|may not be secure/i.test(document.body.innerText),
            }));
        } catch {
            continue; // mid-navigation
        }
        // Hostname, not href: Google's sign-in pages carry
        // continue=https://aistudio.google.com/… so a substring test calls them
        // "on AI Studio" and reports the account signed in while the window is
        // still asking for a password (measured 2026-10-14).
        let onAistudio = false;
        try { onAistudio = new URL(state.href).hostname === 'aistudio.google.com'; } catch { /* about:blank */ }
        if (onAistudio && state.accounts.includes(account) && state.table && state.rows) {
            console.log(`\n✓ signed in as ${account} — rate-limit table renders (${state.rows} models).`);
            console.log('  The usage-monitor will pick this session up on its next cycle.');
            break;
        }
        const note = !onAistudio
            ? `waiting in Google's sign-in flow (${state.href.replace(/^https:\/\//, '').slice(0, 70)})…`
            : state.accounts.includes(account)
                ? (state.noProject
                    ? `${account} is signed in, but AI Studio shows "No Cloud Projects Available" — this account has no Gemini project for the monitor to read.`
                    : `${account} is signed in; waiting for the rate-limit table…`)
                : `on AI Studio but signed in as ${state.accounts.join(', ') || 'no account'} — switch to ${account} in the account switcher`;
        if (note !== lastNote) { console.log(`  … ${note}`); lastNote = note; }
        if (state.blocked) console.log('  ! Google is asking for extra verification — finish it in the window.');
        if (Date.now() >= deadline - POLL_MS) {
            console.log(`\n✗ timed out before AI Studio showed the rate-limit table for ${account}`);
            process.exitCode = 1;
            break;
        }
    }
} finally {
    await browser.close();
}
