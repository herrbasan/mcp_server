import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Browser state tracking
let browser = null;
let browserIdleTimer = null;
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
let activePages = new Set();
let isShuttingDown = false;

function log(message) {
    console.log(`[Browser] ${message}`);
}

async function getBrowser() {
    if (isShuttingDown) {
        throw new Error('Browser is shutting down');
    }
    
    if (!browser) {
        log('Launching Puppeteer...');
        try {
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
            
            // Listen for disconnect events
            browser.on('disconnected', () => {
                log('Browser disconnected event received');
                browser = null;
                activePages.clear();
            });
            
            // Listen for target created/destroyed to track pages
            browser.on('targetcreated', (target) => {
                if (target.type() === 'page') {
                    log(`Page created: ${target.url()}`);
                }
            });
            
            browser.on('targetdestroyed', (target) => {
                if (target.type() === 'page') {
                    log(`Page destroyed: ${target.url()}`);
                    activePages.delete(target);
                }
            });
            
            log(`Browser launched successfully (PID: ${browser.process()?.pid})`);
        } catch (err) {
            log(`Failed to launch browser: ${err.message}`);
            throw err;
        }
    }

    // Reset idle timer
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = null;
    }
    
    browserIdleTimer = setTimeout(async () => {
        if (browser && !isShuttingDown) {
            log(`Idle timeout (${BROWSER_IDLE_TIMEOUT}ms) reached, closing browser`);
            try {
                await browser.close();
                log('Browser closed due to idle timeout');
            } catch (err) {
                log(`Error closing idle browser: ${err.message}`);
            }
            browser = null;
            activePages.clear();
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
            const pageId = Math.random().toString(36).substring(2, 8);
            
            // Track the page
            activePages.add(page);
            log(`New page opened [${pageId}], total active: ${activePages.size}`);
            
            // Stealth evasion basics
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9'
            });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            let isClosed = false;
            
            return {
                page,
                pageId,
                markUsed() {
                    if (isShuttingDown) return;
                    // Reset idle timer
                    if (browserIdleTimer) clearTimeout(browserIdleTimer);
                    browserIdleTimer = setTimeout(async () => {
                        if (browser && !isShuttingDown) {
                            log('Idle timeout reached, closing browser');
                            await browser.close();
                            browser = null;
                            activePages.clear();
                        }
                    }, BROWSER_IDLE_TIMEOUT);
                },
                async close(delay = 0) {
                    if (isClosed) {
                        log(`Page [${pageId}] already closed, skipping`);
                        return;
                    }
                    isClosed = true;
                    
                    const doClose = async () => {
                        try {
                            if (page.isClosed()) {
                                log(`Page [${pageId}] was already closed`);
                            } else {
                                await page.close();
                                log(`Page [${pageId}] closed, remaining active: ${activePages.size - 1}`);
                            }
                            activePages.delete(page);
                        } catch (err) {
                            log(`Error closing page [${pageId}]: ${err.message}`);
                            activePages.delete(page);
                        }
                    };
                    
                    if (delay > 0) {
                        log(`Page [${pageId}] scheduled to close in ${delay}ms`);
                        setTimeout(doClose, delay);
                    } else {
                        await doClose();
                    }
                }
            };
        },
        async fetch(url, options = {}) {
            // Internal wrapper used by research
            const { page, markUsed, close, pageId } = await this.getPage();
            try {
                log(`[${pageId}] Fetching: ${url}`);
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                const html = await page.content();
                log(`[${pageId}] Fetched ${html.length} bytes`);
                return html;
            } finally {
                markUsed();
                await close(15000); // Linger for 15s
            }
        }
    };
}

export async function shutdown() {
    if (isShuttingDown) {
        log('Shutdown already in progress, waiting...');
        return;
    }
    
    isShuttingDown = true;
    log('Shutdown initiated');
    
    // Clear idle timer
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = null;
        log('Idle timer cleared');
    }
    
    if (!browser) {
        log('No browser instance to shut down');
        isShuttingDown = false;
        return;
    }
    
    const pid = browser.process()?.pid;
    log(`Closing browser (PID: ${pid}, active pages: ${activePages.size})...`);
    
    try {
        // First, try to close all active pages gracefully
        if (activePages.size > 0) {
            log(`Closing ${activePages.size} active pages...`);
            const closePromises = [];
            for (const page of activePages) {
                if (!page.isClosed()) {
                    closePromises.push(
                        page.close().catch(err => {
                            log(`Error closing page during shutdown: ${err.message}`);
                        })
                    );
                }
            }
            await Promise.all(closePromises);
            log('All pages closed');
        }
        
        // Then close the browser
        log('Closing browser process...');
        await browser.close();
        log(`Browser (PID: ${pid}) closed successfully`);
        
    } catch (err) {
        log(`Error during shutdown: ${err.message}`);
        
        // Force kill if needed
        try {
            const proc = browser?.process();
            if (proc) {
                log(`Force killing browser process ${proc.pid}...`);
                proc.kill('SIGTERM');
                
                // Give it a moment, then SIGKILL if needed
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (!proc.killed) {
                    proc.kill('SIGKILL');
                    log('Process force killed');
                } else {
                    log('Process terminated gracefully');
                }
            }
        } catch (killErr) {
            log(`Error killing process: ${killErr.message}`);
        }
    }
    
    browser = null;
    activePages.clear();
    isShuttingDown = false;
    log('Shutdown complete');
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
    const { page, markUsed, close, pageId } = await bridge.getPage();
    try {
        log(`[${pageId}] browser_fetch: ${url}`);
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
    const { page, markUsed, close, pageId } = await bridge.getPage();
    try {
        log(`[${pageId}] browser_click: ${url}, selector: ${selector}`);
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
    const { page, markUsed, close, pageId } = await bridge.getPage();
    try {
        log(`[${pageId}] browser_fill: ${url}, fields: ${fields.map(f => f.selector).join(', ')}`);
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
    const { page, markUsed, close, pageId } = await bridge.getPage();
    try {
        log(`[${pageId}] browser_evaluate: ${url}`);
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
    const { page, markUsed, close, pageId } = await bridge.getPage();
    try {
        log(`[${pageId}] browser_pdf: ${url}`);
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
