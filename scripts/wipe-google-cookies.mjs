// Wipe Google-domain cookies from a workshop Chrome profile. Fixes the
// accounts.google.com ERR_TOO_MANY_REDIRECTS loop that has broken the gemini
// usage scrape twice (2026-10-10 and 2026-10-28). Non-Google sessions (kimi,
// z.ai, minimax, openai) in the same profile are preserved.
//
// NOTE: Chrome's own Google sign-in can re-mirror account cookies into the
// website store after a wipe, so this is a treatment, not a cure — and never a
// substitute for signing in on the right profile.
//
// Usage: node scripts/wipe-google-cookies.mjs [--profile=shared|gemini]
import puppeteer from 'puppeteer';
import { profileFromArgv } from '../src/agents/usage-monitor/profiles.js';

const { name: PROFILE_NAME, dir: PROFILE, chromeProfile } = profileFromArgv(process.argv);
console.log(`profile: ${PROFILE_NAME} (${PROFILE}, ${chromeProfile})`);

const GOOGLE_RE = /(^|\.)google\.[a-z.]+$|(^|\.)googleusercontent\.com$|(^|\.)gstatic\.com$|(^|\.)googleapis\.com$/i;

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', `--profile-directory=${chromeProfile}`, `--user-data-dir=${PROFILE}`],
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
            // Partitioned (CHIPS) cookies are keyed by partitionKey; a delete
            // that omits it leaves them behind (measured 2026-11-02: 14 of 58
            // survived the first pass).
            const params = { name: c.name, domain: c.domain, path: c.path };
            if (c.partitionKey) params.partitionKey = c.partitionKey;
            await client.send('Network.deleteCookies', params);
            deleted++;
        } catch (e) {
            console.warn(`delete failed for ${c.name}@${c.domain}: ${e.message}`);
        }
    }
    console.log(`deleted ${deleted}/${doomed.length} Google cookies`);

    // Verify by re-reading; anything left is cleared per-origin as a second
    // pass, then per-URL as a third, and whatever still survives is named
    // rather than counted — a mystery survivor is what makes the next wipe a
    // guess. Session cookies re-set by a live Google tab are NOT the target
    // here: only the cookie store this launch owns is touched.
    let left = (await client.send('Network.getAllCookies')).cookies.filter(c => GOOGLE_RE.test(c.domain));
    if (left.length) {
        for (const origin of ['https://accounts.google.com', 'https://aistudio.google.com',
                              'https://myaccount.google.com', 'https://www.google.com',
                              'https://www.google.de', 'https://google.com', 'https://google.de']) {
            await client.send('Storage.clearDataForOrigin', { origin, storageTypes: 'cookies' }).catch(() => {});
        }
        left = (await client.send('Network.getAllCookies')).cookies.filter(c => GOOGLE_RE.test(c.domain));
    }
    if (left.length) {
        // deleteCookies also accepts a URL in place of domain+path; it resolves
        // the cookie through the URL's host, which is what reaches cookies the
        // domain+path form leaves behind (measured: .google.de/.google.com SID).
        for (const c of left) {
            try {
                await client.send('Network.deleteCookies', { name: c.name, url: `https://${c.domain.replace(/^\./, '')}` });
            } catch { /* reported below */ }
        }
        left = (await client.send('Network.getAllCookies')).cookies.filter(c => GOOGLE_RE.test(c.domain));
    }
    if (left.length > 0) {
        const named = left.map(c => `${c.name}@${c.domain}${c.partitionKey ? `[${c.partitionKey.topLevelSite}]` : ''}`);
        throw new Error(`${left.length} Google cookies survived the wipe: ${named.join(', ')}`);
    }
    console.log('verified: 0 Google cookies remain');
} finally {
    await browser.close();
}
