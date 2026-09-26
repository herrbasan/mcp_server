// Verify: (1) window is moved off-screen via CDP after launch, (2) OpenAI still loads.
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.resolve(__dirname, '..', 'data', 'chrome-profile');

const browser = await puppeteer.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
           '--window-position=-32000,-32000', '--window-size=1280,900',
           `--user-data-dir=${PROFILE}`]
});

// same hide call the agent now uses
const target = (await browser.targets()).find(t => t.type() === 'page');
const cdp = await target.createCDPSession();
const { windowId } = await cdp.send('Browser.getWindowForTarget');
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000 } });
const { bounds } = await cdp.send('Browser.getWindowForTarget', { windowId });
await cdp.detach();

const page = await browser.newPage();
await page.goto('https://platform.openai.com/usage', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 15000));
const info = await page.evaluate(() => ({
    title: document.title,
    span: [...document.querySelectorAll('span')].some(s => /^\$[\d.]+ \/ \$[\d.]+$/.test((s.textContent || '').trim()))
}));
console.log(JSON.stringify({ windowBounds: { left: bounds.left, top: bounds.top }, ...info }, null, 2));
await browser.close();
