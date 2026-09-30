// Read-only probe: dump the FULL raw MiniMax token_plan remains_percent
// response (all fields of every model entry) via shared CDP Chrome.
// Purpose: discover the field names of the new monthly rate-limit window
// after the 2026-09-30 subscription change.
import puppeteer from 'puppeteer';

let browser;
try {
    const ver = await (await fetch('http://localhost:9222/json/version')).json();
    browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, timeout: 5000 });
} catch {
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--remote-debugging-port=9222',
            '--user-data-dir=data/chrome-profile']
    });
}
const page = await browser.newPage();
try {
    await page.goto('https://platform.minimax.io/console/usage', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const res = await page.evaluate(`(async () => {
        const r = await fetch('https://platform.minimax.io/backend/account/token_plan/remains_percent', { credentials: 'include' });
        return { status: r.status, body: await r.json() };
    })()`);
    console.log('HTTP', res.status);
    console.log(JSON.stringify(res.body, null, 2));
} finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
}
