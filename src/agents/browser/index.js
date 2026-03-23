import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');
const agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const defaultViewport = agentConfig.defaultViewport || { width: 1280, height: 1280 };

// Browser state tracking
let browser = null;
let browserIdleTimer = null;
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
let activePages = new Set();
let isShuttingDown = false;

// Session registry - maps sessionId -> Session object
const sessions = new Map();
const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes per session

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
        if (browser && !isShuttingDown && sessions.size === 0) {
            log(`Idle timeout (${BROWSER_IDLE_TIMEOUT}ms) reached, closing browser (no active sessions)`);
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
            
            // Stealth evasion basics & default viewport
            await page.setViewport(defaultViewport);
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

    // Close all active sessions first
    if (sessions.size > 0) {
        log(`Closing ${sessions.size} active sessions...`);
        for (const sessionId of sessions.keys()) {
            await closeSession(sessionId);
        }
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

// Session management helpers
function resetSessionIdleTimer(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.lastActivity = new Date();

    if (session.idleTimer) {
        clearTimeout(session.idleTimer);
    }

    session.idleTimer = setTimeout(async () => {
        log(`Session ${sessionId} idle timeout (${SESSION_IDLE_TIMEOUT}ms) reached`);
        await closeSession(sessionId);
    }, SESSION_IDLE_TIMEOUT);
}

async function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    if (session.idleTimer) {
        clearTimeout(session.idleTimer);
    }

    try {
        if (!session.page.isClosed()) {
            await session.page.close();
        }
    } catch (err) {
        log(`Error closing session ${sessionId} page: ${err.message}`);
    }

    activePages.delete(session.page);
    sessions.delete(sessionId);
    log(`Session ${sessionId} closed, remaining: ${sessions.size}`);
}

async function ensurePageForSession(session) {
    if (session.page.isClosed()) {
        log(`Session ${session.sessionId}: page was closed, recreating`);
        const b = await getBrowser();
        session.page = await b.newPage();
        await session.page.setViewport(session.viewport || defaultViewport);
        activePages.add(session.page);
    }
}

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

// Session management tools
export async function browser_session_create(args, context) {
    const { viewport = defaultViewport, userAgent } = args;

    const b = await getBrowser();
    const page = await b.newPage();
    const sessionId = randomUUID();

    await page.setViewport(viewport);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    if (userAgent) {
        await page.setUserAgent(userAgent);
    } else {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }

    const session = {
        sessionId,
        page,
        createdAt: new Date().toISOString(),
        lastActivity: new Date(),
        viewport,
        idleTimer: null
    };
    sessions.set(sessionId, session);
    activePages.add(page);
    resetSessionIdleTimer(sessionId);

    log(`Session created: ${sessionId}, total sessions: ${sessions.size}`);

    return {
        content: [{ type: "text", text: `Session created: ${sessionId}\nPage ready at: ${page.url() || 'about:blank'}` }]
    };
}

export async function browser_session_list(args, context) {
    if (sessions.size === 0) {
        return { content: [{ type: "text", text: "No active sessions" }] };
    }

    const lines = [];
    const now = new Date();
    for (const [sessionId, session] of sessions) {
        const age = Math.round((now - new Date(session.createdAt)) / 1000);
        const ageStr = age < 60 ? `${age}s` : `${Math.floor(age / 60)}m ${age % 60}s`;
        try {
            const url = session.page.isClosed() ? '(closed)' : (session.page.url() || 'about:blank');
            lines.push(`[${sessionId.substring(0, 8)}] ${url} (${ageStr} old)`);
        } catch {
            lines.push(`[${sessionId.substring(0, 8)}] (error reading page)`);
        }
    }

    return { content: [{ type: "text", text: `Active sessions: ${sessions.size}\n\n${lines.join('\n')}` }] };
}

export async function browser_session_close(args, context) {
    const { sessionId } = args;
    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    if (!sessions.has(sessionId)) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await closeSession(sessionId);
    return { content: [{ type: "text", text: `Session closed: ${sessionId}` }] };
}

export async function browser_session_goto(args, context) {
    const { sessionId, url, waitFor, timeout = 30000 } = args;
    const { progress } = context;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    if (progress) progress(`Navigating to ${url}...`, 20, 100);

    try {
        await session.page.goto(url, { waitUntil: 'networkidle2', timeout });

        if (waitFor) {
            if (progress) progress(`Waiting for ${waitFor}...`, 50, 100);
            await session.page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
        }

        if (progress) progress('Navigation complete', 100, 100);

        return { content: [{ type: "text", text: `Navigated to: ${url}` }] };
    } catch (err) {
        return { content: [{ type: "text", text: `Navigation failed: ${err.message}` }], isError: true };
    }
}

export async function browser_session_content(args, context) {
    const { sessionId, mode = 'text' } = args;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    return await formatResult(session.page, mode, session.page.url());
}

export async function browser_session_click(args, context) {
    const { sessionId, selector, waitAfter, mode = 'text' } = args;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    try {
        await session.page.waitForSelector(selector);
        await session.page.click(selector);
        if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
        return await formatResult(session.page, mode, session.page.url());
    } catch (err) {
        return { content: [{ type: "text", text: `Click failed: ${err.message}` }], isError: true };
    }
}

export async function browser_session_fill(args, context) {
    const { sessionId, fields, submit, waitAfter, mode = 'text' } = args;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    try {
        for (const f of fields) {
            await session.page.waitForSelector(f.selector);
            await session.page.type(f.selector, f.value || '');
        }
        if (submit) {
            await session.page.click(submit);
            await session.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        }
        if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
        return await formatResult(session.page, mode, session.page.url());
    } catch (err) {
        return { content: [{ type: "text", text: `Fill failed: ${err.message}` }], isError: true };
    }
}

export async function browser_session_evaluate(args, context) {
    const { sessionId, script, waitFor } = args;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    try {
        if (waitFor) await session.page.waitForSelector(waitFor).catch(() => {});

        const result = await session.page.evaluate(new Function(script));
        return {
            content: [{ type: "text", text: typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result) }]
        };
    } catch (err) {
        return { content: [{ type: "text", text: `JS Error: ${err.message}` }], isError: true };
    }
}

export async function browser_session_scroll(args, context) {
    const { sessionId, direction = 'down', amount = 500 } = args;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    const scrollY = direction === 'up' ? -amount : amount;
    await session.page.evaluate((y) => window.scrollBy(0, y), scrollY);

    return { content: [{ type: "text", text: `Scrolled ${direction} ${amount}px` }] };
}

export async function browser_session_metadata(args, context) {
    const { sessionId } = args;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    const url = session.page.url();
    const title = await session.page.title();
    const viewport = session.viewport || defaultViewport;

    return {
        content: [{
            type: "text",
            text: `URL: ${url}\nTitle: ${title}\nViewport: ${viewport.width}x${viewport.height}`
        }]
    };
}
