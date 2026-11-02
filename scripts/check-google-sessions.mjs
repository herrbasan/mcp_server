// Is the provider Google session still alive? Answers "will X log us out?"
// after running any browser-facing feature, and names which account is where.
//
//   node scripts/check-google-sessions.mjs [account] [--profile=shared|gemini]
//
// Reads Chrome's own account record plus each AI Studio index: the account the
// page shows and whether the rate-limit table renders. Account defaults to
// agents.usage-monitor.geminiAccount; profile defaults to shared.
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { profileFromArgv } from '../src/agents/usage-monitor/profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const { name: PROFILE_NAME, dir: PROFILE, port: PORT, chromeProfile } = profileFromArgv(process.argv);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'))[0];
const wanted = positional || config.agents?.['usage-monitor']?.geminiAccount || null;
console.log(`profile: ${PROFILE_NAME} (${PROFILE})`);

const prefs = path.join(PROFILE, 'Default', 'Preferences');
if (fs.existsSync(prefs)) {
    const p = JSON.parse(fs.readFileSync(prefs, 'utf8'));
    console.log('Chrome account_info: ' + JSON.stringify((p.account_info || []).map(a => a.email)));
}

let browser, owned = false;
try {
    browser = await puppeteer.connect({ browserURL: `http://localhost:${PORT}`, timeout: 3000 });
} catch {
    browser = await puppeteer.launch({ headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
               `--profile-directory=${chromeProfile}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`] });
    owned = true;
}
let found = false;
// Declared outside the try so the finally can close it: a page left open in an
// attached browser outlives this process, and that is how this profile's tab
// pile was built in the first place.
const page = await browser.newPage();
try {
    await page.setUserAgent((await browser.userAgent()).replace('Headless', ''));
    for (const i of [0, 1, 2]) {
        try {
            await page.goto(`https://aistudio.google.com/u/${i}/rate-limit`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (err) {
            // A broken index must not end the survey — the whole point is to
            // see which indices are usable (2026-11-02: /u/1 loops while /u/0
            // renders fine).
            console.log(`/u/${i} -> NAVIGATION FAILED: ${err.message.slice(0, 120)}`);
            continue;
        }
        await page.waitForFunction(() => /Time Range|No Cloud Projects Available/.test(document.body.innerText), { timeout: 20000 }).catch(() => {});
        // The table arrives after the shell (async fetch) — reading immediately
        // reports 0 rows for a healthy account.
        await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length > 0, { timeout: 12000 }).catch(() => {});
        const s = await page.evaluate(() => ({
            href: location.href.replace('https://aistudio.google.com', ''),
            account: (document.body.innerText.match(/[\w.+-]+@[\w.-]+\.\w+/) || [null])[0],
            rows: document.querySelectorAll('table tbody tr').length,
            noProject: /No Cloud Projects Available/i.test(document.body.innerText),
        }));
        if (wanted && s.account === wanted) found = true;
        console.log(`/u/${i} -> ${s.href}  account=${s.account}  tableRows=${s.rows}  noProject=${s.noProject}`);
    }
} finally {
    // A page in an attached browser outlives this process — the pile in this
    // profile was built exactly that way.
    await page.close().catch(() => {});
    if (owned) await browser.close(); else await browser.disconnect();
}
if (wanted) console.log(found ? `\nOK: ${wanted} is signed in with its AI Studio data reachable.` : `\nMISSING: ${wanted} is not signed in.`);
