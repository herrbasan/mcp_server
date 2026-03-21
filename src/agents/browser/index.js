import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let browser = null;
let browserIdleTimer = null;
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

async function getBrowser() {
    if (!browser) {
        console.log('[Browser] Launching Puppeteer');
        // Basic anti-bot settings
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-notifications',
                '--window-size=1920,1080'
            ],
            userDataDir: path.join(__dirname, '..', '..', '..', 'data', 'chrome-profile')
        });
    }

    if (browserIdleTimer) clearTimeout(browserIdleTimer);
    browserIdleTimer = setTimeout(async () => {
        if (browser) {
            console.log('[Browser] Idle timeout reached, closing.');
            await browser.close();
            browser = null;
        }
    }, BROWSER_IDLE_TIMEOUT);

    return browser;
}

export async function init() {
    // Export standard internal APIs for cross-agent use (like web research)
    return {
        async getPage() {
            const b = await getBrowser();
            const page = await b.newPage();
            // Stealth evasion basics
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9'
            });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            let isClosed = false;
            return {
                page,
                markUsed() {
                    // Reset idle
                    if (browserIdleTimer) clearTimeout(browserIdleTimer);
                    browserIdleTimer = setTimeout(async () => {
                        if (browser) await browser.close();
                        browser = null;
                    }, BROWSER_IDLE_TIMEOUT);
                },
                async close(delay = 0) {
                    if (isClosed) return;
                    isClosed = true;
                    if (delay > 0) {
                        setTimeout(() => page.close().catch(() => {}), delay);
                    } else {
                        await page.close().catch(() => {});
                    }
                }
            };
        },
        async fetch(url, options = {}) {
            // Internal wrapper used by research
            const { page, markUsed, close } = await this.getPage();
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                const html = await page.content();
                return html;
            } finally {
                markUsed();
                await close(15000); // Linger for 15s
            }
        }
    };
}

export async function shutdown() {
    if (browserIdleTimer) clearTimeout(browserIdleTimer);
    if (browser) {
        console.log('[Browser] Shutting down');
        await browser.close().catch(() => {});
        browser = null;
    }
}

// Result formatting utils
async function formatResult(page, mode, url) {
    if (mode === 'screenshot') {
        const screenshot = await page.screenshot({ encoding: 'base64', fullPage: true });
        return {
            content: [{ type: "image", data: screenshot, mimeType: "image/png" }]
        };
    }
    
    if (mode === 'html') {
        return { content: [{ type: "text", text: (await page.content()).substring(0, 100000) }] };
    }

    const html = await page.content();
    
    try {
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        
        let text = article ? article.textContent : dom.window.document.body.textContent;
        // Clean excessive whitespace
        text = text.replace(/\n\s*\n/g, '\n\n').trim();

        if (mode === 'markdown') {
            text = `# ${article?.title || 'Page'}\n\n${text}`;
        }
        
        return { content: [{ type: "text", text: text.substring(0, 50000) }] };
    } catch (e) {
        return { content: [{ type: "text", text: `Extraction error: ${e.message}\n\nRaw HTML prefix:\n${html.substring(0, 5000)}` }] };
    }
}

// Tools
export async function browser_fetch(args, context) {
    const { url, mode = 'text', waitFor, viewport } = args;
    const bridge = await init();
    const { page, markUsed, close } = await bridge.getPage();
    try {
        if (viewport) await page.setViewport(viewport);
        
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        if (waitFor) {
            await page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
        }
        return await formatResult(page, mode, url);
    } finally {
        markUsed();
        await close(5000);
    }
}

export async function browser_click(args, context) {
    const { url, selector, waitAfter, mode = 'text' } = args;
    const bridge = await init();
    const { page, markUsed, close } = await bridge.getPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(selector);
        await page.click(selector);
        if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
        return await formatResult(page, mode, url);
    } finally {
        markUsed();
        await close(5000);
    }
}

export async function browser_fill(args, context) {
    const { url, fields, submit, waitAfter, mode = 'text' } = args;
    const bridge = await init();
    const { page, markUsed, close } = await bridge.getPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        for (const f of fields) {
            await page.waitForSelector(f.selector);
            await page.type(f.selector, f.value || '');
        }
        if (submit) {
            await page.click(submit);
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        }
        if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
        return await formatResult(page, mode, url);
    } finally {
        markUsed();
        await close(5000);
    }
}

export async function browser_evaluate(args, context) {
    const { url, script, waitFor } = args;
    const bridge = await init();
    const { page, markUsed, close } = await bridge.getPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        if (waitFor) await page.waitForSelector(waitFor).catch(()=>{});
        
        // page.evaluate requires a serializable function, not a string
        const result = await page.evaluate(new Function(script));
        return {
            content: [{ type: "text", text: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result) }]
        };
    } catch (e) {
        return { content: [{ type: "text", text: `JS Error: ${e.message}` }], isError: true };
    } finally {
        markUsed();
        await close(5000);
    }
}

export async function browser_pdf(args, context) {
    const { url, format = 'A4', landscape = false, printBackground = true } = args;
    const bridge = await init();
    const { page, markUsed, close } = await bridge.getPage();
    try {
        await page.goto(url, { waitUntil: 'networkidle2' });
        const pdfFile = await page.pdf({ format, landscape, printBackground });
        return {
            content: [{ type: "text", text: `PDF generated successfully (${pdfFile.length} bytes). (Binary output not directly supported via text schema yet, but creation succeeded.)` }]
        };
    } finally {
        markUsed();
        await close(5000);
    }
}
