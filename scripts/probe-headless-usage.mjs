// Probe: does HEADLESS (new) Chrome on the shared profile pass where the
// headed off-screen launch was used? Tests the three risky providers:
//   zai    — login token in localStorage + quota API
//   openai — Cloudflare-protected (reason headed mode exists)
//   gemini — Google login + rate-limit table
import puppeteer from 'puppeteer';

const CHROME_PROFILE_DIR = 'd:\\DEV\\mcp_server\\data\\chrome-profile';

const results = {};
const browser = await puppeteer.launch({
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        `--user-data-dir=${CHROME_PROFILE_DIR}`
    ]
});
try {
    const page = await browser.newPage();
    // Strip the HeadlessChrome marker from the UA (new headless still sends it)
    const ua = await browser.userAgent();
    await page.setUserAgent(ua.replace('Headless', ''));
    console.log('[probe] UA:', await page.evaluate(() => navigator.userAgent));

    // zai
    try {
        await page.goto('https://z.ai/manage-apikey/coding-plan/personal/usage', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 3000));
        const zai = await page.evaluate(`(async () => {
            const tok = localStorage.getItem('z-ai-open-platform-token-production');
            if (!tok) return { ok: false, why: 'no token — logged out' };
            const r = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', { headers: { Authorization: 'Bearer ' + tok } });
            const j = await r.json();
            const limits = (j.data && j.data.limits || []).filter(l => l.type === 'TOKENS_LIMIT');
            return { ok: j.code === 200 && limits.length >= 2, why: 'code=' + j.code + ' tokenWindows=' + limits.length };
        })()`);
        results.zai = zai;
    } catch (e) { results.zai = { ok: false, why: e.message }; }

    // openai (Cloudflare)
    try {
        await page.goto('https://platform.openai.com/usage', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));
        const openai = await page.evaluate(`(() => {
            const body = document.body ? document.body.innerText : '';
            const challenge = /Just a moment|Verify you are human|Checking your browser/i.test(body);
            const span = [...document.querySelectorAll('span')].find(s => /^\\$[\\d.]+ \\/ \\$[\\d.]+$/.test((s.textContent || '').trim()));
            return { challenge, spanFound: !!span, spanText: span ? span.textContent.trim() : null, url: location.href, title: document.title };
        })()`);
        results.openai = openai;
    } catch (e) { results.openai = { ok: false, why: e.message }; }

    // gemini (Google login)
    try {
        await page.goto('https://aistudio.google.com/u/1/rate-limit', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('table', { timeout: 20000 });
        const gemini = await page.evaluate(`(() => {
            const rows = document.querySelectorAll('table tbody tr').length;
            return { ok: rows > 0, rows, title: document.title };
        })()`);
        results.gemini = gemini;
    } catch (e) { results.gemini = { ok: false, why: e.message }; }
} finally {
    await browser.close();
}
console.log(JSON.stringify(results, null, 2));
