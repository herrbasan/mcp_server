// Read-only probe: watch the MiniMax console/usage page's own XHR/fetch calls
// and dump every backend API response. Purpose: find which endpoint the NEW
// subscription dashboard uses (old token_plan/remains_percent now 1016s).
import puppeteer from 'puppeteer';

let browser, launched = false;
try {
    const ver = await (await fetch('http://localhost:9222/json/version')).json();
    browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, timeout: 5000 });
} catch {
    launched = true;
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--remote-debugging-port=9222',
            '--user-data-dir=data/chrome-profile']
    });
}
const page = await browser.newPage();
const seen = [];
page.on('response', async (r) => {
    const url = r.url();
    if (!/minimax\.io\/backend\//.test(url)) return;
    let body = '';
    try { body = (await r.text()).slice(0, 4000); } catch { body = '<body unreadable>'; }
    seen.push({ url, status: r.status(), body });
});
try {
    await page.goto('https://platform.minimax.io/console/usage', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 8000)); // let SPA settle
    console.log('final url:', page.url());
    console.log('backend calls seen:', seen.length);
    for (const s of seen) {
        console.log('\n=== ' + s.status + ' ' + s.url + '\n' + s.body);
    }
    // also: what does the visible page say (login wall? usage table?)
    const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000));
    console.log('\n--- visible text ---\n' + text);
} finally {
    await page.close().catch(() => {});
    if (launched) await browser.close().catch(() => {});
    else await browser.disconnect();
}
