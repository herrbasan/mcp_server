// One-off probe: where do the Google URLs actually land with the current profile?
// Tests /u/1 (hardcoded in the extractor) vs /u/0, plus the bare account
// chooser. Reports final URL + title per navigation. No mutations.
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.resolve(__dirname, '..', 'data', 'chrome-profile');

async function getBrowser() {
    try {
        const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', timeout: 3000 });
        console.log('(attached to running Chrome on 9222 — will disconnect, not close)');
        return { browser: b, owned: false };
    } catch { /* nothing on 9222 — launch */ }
    const b = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', `--user-data-dir=${PROFILE}`],
    });
    return { browser: b, owned: true };
}

const { browser, owned } = await getBrowser();
try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    for (const url of [
        'https://accounts.google.com/',
        'https://aistudio.google.com/u/1/rate-limit',
        'https://aistudio.google.com/u/0/rate-limit',
    ]) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000));
            const title = await page.title().catch(() => '?');
            console.log(`OK   ${url}\n  -> ${page.url()}\n  title: ${title}`);
        } catch (e) {
            console.log(`FAIL ${url}\n  -> ${page.url()}\n  ${e.message.slice(0, 120)}`);
        }
    }
    await page.screenshot({ path: 'data/usage-monitor-debug/probe-current.png' }).catch(() => {});
} finally {
    if (owned) await browser.close();
    else await browser.disconnect();
}
