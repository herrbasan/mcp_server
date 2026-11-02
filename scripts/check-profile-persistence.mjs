// Does this Chrome profile actually persist state across browser processes?
// Writes a marker cookie + localStorage entry in one launch, closes normally,
// relaunches, and reads them back. Proves the profile plumbing (same user-data-
// dir, same profile directory, cookie/localStorage written to disk) without
// needing anyone's credentials.
//
//   node scripts/check-profile-persistence.mjs [--profile=usage|shared]
import puppeteer from 'puppeteer';
import { profileFromArgv } from '../src/agents/usage-monitor/profiles.js';

const { name, dir, chromeProfile } = profileFromArgv(process.argv);
const MARK = `dsh-persist-${Date.now()}`;
// --headful writes the marker from a VISIBLE window, then reads it back in a
// headless launch — the exact path a manual login takes to the monitor.
const headfulWrite = process.argv.includes('--headful');
const args = ['--no-sandbox', '--disable-blink-features=AutomationControlled',
              `--profile-directory=${chromeProfile}`, `--user-data-dir=${dir}`];

async function visit(fn, { headless = true } = {}) {
    const browser = await puppeteer.launch({ headless, args });
    try {
        const page = await browser.newPage();
        await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
        return await fn(page);
    } finally {
        // Normal close — this is what flushes the cookie store.
        await browser.close();
    }
}

console.log(`profile: ${name} (${dir}, ${chromeProfile})`);
const written = await visit(page => page.evaluate((mark) => {
    document.cookie = `dsh_persist_test=${mark}; path=/; max-age=86400; SameSite=Lax`;
    localStorage.setItem('dsh_persist_test', mark);
    return mark;
}, MARK), { headless: !headfulWrite });
console.log(`wrote marker ${written} (${headfulWrite ? 'visible' : 'headless'} browser)`);

const read = await visit(page => page.evaluate(() => ({
    cookie: (document.cookie.match(/dsh_persist_test=([^;]+)/) || [])[1] || null,
    localStorage: localStorage.getItem('dsh_persist_test'),
})));

console.log(`read back: cookie=${read.cookie} localStorage=${read.localStorage}`);
const ok = read.cookie === MARK && read.localStorage === MARK;
console.log(ok
    ? 'PASS — cookie and localStorage survived a full browser restart'
    : `FAIL — expected ${MARK}; the profile did not persist (cookie=${read.cookie}, localStorage=${read.localStorage})`);
process.exitCode = ok ? 0 : 1;
