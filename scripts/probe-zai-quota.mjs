// Probe: dump the RAW z.ai quota API response to see the nextResetTime shape
// when the 5h window is unused (monitor fails with 'Invalid time value' there).
// Same browser strategy as the agent: CDP attach-or-launch, off-screen, shared profile.
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
    await page.goto('https://z.ai/manage-apikey/coding-plan/personal/usage', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 4000));
    const raw = await page.evaluate(`(async () => {
        const tok = localStorage.getItem('z-ai-open-platform-token-production');
        if (!tok) return { error: 'no token in localStorage — logged out' };
        const r = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', { headers: { Authorization: 'Bearer ' + tok } });
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
