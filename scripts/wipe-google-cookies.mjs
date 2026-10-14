// One-off: wipe Google-domain cookies from the shared workshop Chrome profile.
// Fixes the accounts.google.com ERR_TOO_MANY_REDIRECTS loop that has broken
// the gemini usage scrape since 2026-10-10. Non-Google sessions (kimi, z.ai,
// minimax, openai) in the same profile are preserved. Full profile backup was
// taken at data/chrome-profile-backup-20261013-234000 before this ran.
//
// Usage: node scripts/wipe-google-cookies.mjs
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.resolve(__dirname, '..', 'data', 'chrome-profile');

const GOOGLE_RE = /(^|\.)google\.[a-z.]+$|(^|\.)googleusercontent\.com$|(^|\.)gstatic\.com$|(^|\.)googleapis\.com$/i;

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', `--user-data-dir=${PROFILE}`],
});
try {
    const page = await browser.newPage();
    const client = await page.createCDPSession();

    // getAllCookies (deprecated but unambiguous) returns every cookie in the
    // profile regardless of current URL.
    let cookies = [];
    try {
        ({ cookies } = await client.send('Network.getAllCookies'));
    } catch {
        ({ cookies } = await client.send('Storage.getCookies'));
    }

    const doomed = cookies.filter(c => GOOGLE_RE.test(c.domain));
    console.log(`profile has ${cookies.length} cookies, ${doomed.length} on Google domains`);

    let deleted = 0;
    for (const c of doomed) {
        try {
            await client.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
            deleted++;
        } catch (e) {
            console.warn(`delete failed for ${c.name}@${c.domain}: ${e.message}`);
        }
    }
    console.log(`deleted ${deleted}/${doomed.length} Google cookies`);

    // Verify by re-reading.
    const { cookies: after } = await client.send('Network.getAllCookies');
    const left = after.filter(c => GOOGLE_RE.test(c.domain));
    if (left.length > 0) throw new Error(`${left.length} Google cookies survived the wipe`);
    console.log('verified: 0 Google cookies remain');
} finally {
    await browser.close();
}
