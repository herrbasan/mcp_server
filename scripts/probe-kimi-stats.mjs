// Probe: dump the RAW kimi GetSubscriptionStats RPC to see the 5h window shape
// (monitor currently produces usedPct: null for the 5h window).
import puppeteer from 'puppeteer';

const DEBUGGING_PORT = 9222;
const CHROME_PROFILE_DIR = 'd:\\DEV\\mcp_server\\data\\chrome-profile';

let browser = null;
let launchedByUs = false;
try {
    try {
        browser = await puppeteer.connect({ browserWSEndpoint: `ws://localhost:${DEBUGGING_PORT}`, timeout: 3000 });
        console.log('[probe] attached to running Chrome');
    } catch {
        browser = await puppeteer.launch({
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--window-position=-32000,-32000',
                '--window-size=1280,900',
                `--remote-debugging-port=${DEBUGGING_PORT}`,
                `--user-data-dir=${CHROME_PROFILE_DIR}`
            ]
        });
        launchedByUs = true;
        console.log('[probe] launched Chrome off-screen');
    }
    const page = await browser.newPage();
    await page.goto('https://www.kimi.ai/code/console', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 5000));
    const raw = await page.evaluate(`(async () => {
        const tok = localStorage.getItem('access_token');
        if (!tok) return { error: 'no access_token — logged out' };
        const r = await fetch('https://www.kimi.ai/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}'
        });
        return { status: r.status, body: await r.text() };
    })()`);
    console.log(JSON.stringify(raw, null, 2));
    await page.close();
} finally {
    if (browser) {
        if (launchedByUs) await browser.close();
        else await browser.disconnect();
    }
}
