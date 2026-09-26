// Probe: does HEADED (off-screen) Chrome pass OpenAI's Cloudflare?
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
const page = await browser.newPage();
await page.goto('https://platform.openai.com/usage', { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 20000));
const info = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    bodyLen: (document.body?.innerText || '').length,
    bodyHead: (document.body?.innerText || '').slice(0, 300),
    iframes: [...document.querySelectorAll('iframe')].map(f => (f.src || '').slice(0, 100))
}));
console.log(JSON.stringify(info, null, 2));
await page.close();
await browser.close();
