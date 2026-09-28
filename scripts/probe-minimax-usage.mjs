// Read-only probe: dump the raw MiniMax token_plan remains_percent response
// AND the windows the fixed extractor would produce. Via shared CDP Chrome.
import puppeteer from 'puppeteer';

const ver = await (await fetch('http://localhost:9222/json/version')).json();
const browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, timeout: 5000 });
const page = await browser.newPage();
try {
    await page.goto('https://platform.minimax.io/console/usage', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const res = await page.evaluate(`(async () => {
        const r = await fetch('https://platform.minimax.io/backend/account/token_plan/remains_percent', { credentials: 'include' });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        return await r.json();
    })()`);
    const m = (res.model_remains || []).find(x => x.model_name === 'general') || (res.model_remains || [])[0];
    const pct = (s) => Number(String(s).replace('%', ''));
    console.log('raw general:', JSON.stringify({
        interval_used_percent: m.current_interval_used_percent,
        interval_total_percent: m.current_interval_total_percent,
        interval_status: m.current_interval_status,
        end_time: new Date(m.end_time).toISOString(),
        weekly_used_percent: m.current_weekly_used_percent,
        weekly_status: m.current_weekly_status,
        weekly_end_time: new Date(m.weekly_end_time).toISOString(),
    }, null, 2));
    const windows = [
        { kind: '5h', usedPct: pct(m.current_interval_used_percent), resetAt: new Date(m.end_time).toISOString() }
    ];
    if (m.current_weekly_status !== 3) {
        windows.push({ kind: 'weekly', usedPct: pct(m.current_weekly_used_percent), resetAt: new Date(m.weekly_end_time).toISOString() });
    }
    console.log('fixed extractor windows:', JSON.stringify(windows, null, 2));
    console.log('OLD (buggy) usedPct would be:', 100 - pct(m.current_interval_total_percent));
} finally {
    await page.close().catch(() => {});
    await browser.disconnect();
}
