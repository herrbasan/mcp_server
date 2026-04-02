import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import os from 'os';
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

// Visible browser instances - maps sessionId -> Browser instance (for headed sessions)
const visibleBrowsers = new Map();

function log(message) {
    console.log(`[Browser] ${message}`);
}

// Retry helper with exponential backoff
async function withRetry(fn, options = {}) {
    const { maxRetries = 3, baseDelay = 500, onRetry } = options;
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastError = err;

            // Don't retry on hard errors
            if (err.message.includes('Session not found') ||
                err.message.includes('sessionId is required') ||
                err.message.includes('Navigation failed') && attempt === 0) {
                throw err;
            }

            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt);
                if (onRetry) onRetry(attempt + 1, maxRetries + 1, err.message, delay);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    throw lastError;
}

const DEBUGGING_PORT = 9222;
const CHROME_PROFILE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'chrome-profile');

async function getBrowser() {
    if (isShuttingDown) {
        throw new Error('Browser is shutting down');
    }
    
    if (!browser) {
        const wsUrl = `ws://localhost:${DEBUGGING_PORT}`;

        // Try to connect to existing Chrome with debugging enabled
        try {
            log('Attempting to connect to existing Chrome via CDP...');
            browser = await puppeteer.connect({
                browserWSEndpoint: wsUrl,
                timeout: 3000
            });

            // Verify it's still responsive
            const version = await browser.version();
            log(`Connected to existing Chrome (version: ${version})`);

            browser.on('disconnected', () => {
                log('Chrome disconnected via CDP');
                browser = null;
                activePages.clear();
            });

        } catch (err) {
            // No existing Chrome found, launch new one with debugging enabled
            log('No existing Chrome found, launching new instance...');
            try {
                browser = await puppeteer.launch({
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-blink-features=AutomationControlled',
                        '--disable-notifications',
                        '--window-size=1920,1080',
                        `--remote-debugging-port=${DEBUGGING_PORT}`,
                        `--user-data-dir=${CHROME_PROFILE_DIR}`
                    ]
                });

                browser.on('disconnected', () => {
                    log('Browser disconnected event received');
                    browser = null;
                    activePages.clear();
                });

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
            } catch (launchErr) {
                log(`Failed to launch browser: ${launchErr.message}`);
                throw launchErr;
            }
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

    // Handle visible browser sessions
    const visibleBrowser = visibleBrowsers.get(sessionId);
    if (visibleBrowser) {
        try {
            log(`Closing visible browser for session ${sessionId}...`);
            await visibleBrowser.close();
            visibleBrowsers.delete(sessionId);
            log(`Visible browser for session ${sessionId} closed`);
        } catch (err) {
            log(`Error closing visible browser for session ${sessionId}: ${err.message}`);
        }
    } else {
        // Handle regular headless sessions
        try {
            if (!session.page.isClosed()) {
                await session.page.close();
            }
        } catch (err) {
            log(`Error closing session ${sessionId} page: ${err.message}`);
        }
        activePages.delete(session.page);
    }

    sessions.delete(sessionId);
    log(`Session ${sessionId} closed, remaining: ${sessions.size}`);
}

async function ensurePageForSession(session) {
    if (session.page.isClosed()) {
        log(`Session ${session.sessionId}: page was closed, recreating`);
        
        if (session.visible) {
            // For visible sessions, create a new page from the visible browser instance
            const visibleBrowser = visibleBrowsers.get(session.sessionId);
            if (visibleBrowser) {
                session.page = await visibleBrowser.newPage();
            } else {
                throw new Error(`Visible browser instance not found for session ${session.sessionId}`);
            }
        } else {
            // For headless sessions, use the shared browser
            const b = await getBrowser();
            session.page = await b.newPage();
            activePages.add(session.page);
        }
        
        await session.page.setViewport(session.viewport || defaultViewport);
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

// Session management tools
export async function browser_session_create(args, context) {
    const { viewport = defaultViewport, userAgent, visible = false } = args;

    let page;
    let sessionBrowser = null;

    if (visible) {
        const wsUrl = `ws://localhost:${DEBUGGING_PORT}`;

        // For visible sessions, try to connect to existing Chrome first
        try {
            log('Attempting to connect to existing Chrome for visible session...');
            sessionBrowser = await puppeteer.connect({
                browserWSEndpoint: wsUrl,
                timeout: 3000
            });
            const version = await sessionBrowser.version();
            log(`Connected to existing Chrome for visible session (version: ${version})`);
        } catch (err) {
            // Launch new headed browser if no existing Chrome
            log('No existing Chrome for visible session, launching new instance...');
            sessionBrowser = await puppeteer.launch({
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=1280,900',
                    `--remote-debugging-port=${DEBUGGING_PORT}`,
                    `--user-data-dir=${CHROME_PROFILE_DIR}`
                ]
            });
            log('Visible browser launched successfully');
        }

        page = await sessionBrowser.newPage();
    } else {
        // Use the shared headless browser
        const b = await getBrowser();
        page = await b.newPage();
    }

    const sessionId = randomUUID();

    await page.setViewport(viewport);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    if (userAgent) {
        await page.setUserAgent(userAgent);
    } else {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    }

    // Set up console message capture for this session
    const consoleBuffer = [];
    page.on('console', msg => {
        consoleBuffer.push({
            type: msg.type(),
            text: msg.text(),
            location: msg.location()
        });
    });
    page.on('pageerror', err => {
        consoleBuffer.push({ type: 'error', text: err.message });
    });

    const session = {
        sessionId,
        page,
        createdAt: new Date().toISOString(),
        lastActivity: new Date(),
        viewport,
        idleTimer: null,
        consoleBuffer,
        visible
    };
    sessions.set(sessionId, session);
    
    // Track visible browser instance separately so we can close it with the session
    if (sessionBrowser) {
        visibleBrowsers.set(sessionId, sessionBrowser);
    } else {
        activePages.add(page);
    }
    
    resetSessionIdleTimer(sessionId);

    log(`Session created: ${sessionId}, total sessions: ${sessions.size}, visible: ${visible}`);

    return {
        content: [{ type: "text", text: `Session created: ${sessionId}\nVisible: ${visible}\nPage ready at: ${page.url() || 'about:blank'}` }]
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
        const visibleFlag = session.visible ? ' [VISIBLE]' : '';
        try {
            const url = session.page.isClosed() ? '(closed)' : (session.page.url() || 'about:blank');
            lines.push(`[${sessionId.substring(0, 8)}]${visibleFlag} ${url} (${ageStr} old)`);
        } catch {
            lines.push(`[${sessionId.substring(0, 8)}]${visibleFlag} (error reading page)`);
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
    const { sessionId, url, waitFor, timeout = 30000, retries = 2 } = args;
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

    try {
        return await withRetry(async (attempt) => {
            if (progress) progress(`Navigating to ${url}...${attempt > 0 ? ` (retry ${attempt})` : ''}`, 20, 100);

            await session.page.goto(url, { waitUntil: 'load', timeout });

            if (waitFor) {
                if (progress) progress(`Waiting for ${waitFor}...`, 50, 100);
                await session.page.waitForSelector(waitFor, { timeout: 15000 }).catch(() => {});
            }

            if (progress) progress('Navigation complete', 100, 100);
            return { content: [{ type: "text", text: `Navigated to: ${url}` }] };
        }, {
            maxRetries: retries,
            baseDelay: 1000,
            onRetry: (attempt, total, err, delay) => {
                if (progress) progress(`Retry ${attempt}/${total} after ${delay}ms: ${err.message}`, 20, 100);
            }
        });
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
    const { sessionId, selector, waitAfter, mode = 'text', retries = 2 } = args;

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
        return await withRetry(async (_attempt) => {
            await session.page.waitForSelector(selector);
            await session.page.click(selector);
            if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
            return await formatResult(session.page, mode, session.page.url());
        }, { maxRetries: retries, baseDelay: 300 });
    } catch (err) {
        return { content: [{ type: "text", text: `Click failed: ${err.message}` }], isError: true };
    }
}

export async function browser_session_fill(args, context) {
    const { sessionId, fields, submit, waitAfter, mode = 'text', retries = 2 } = args;

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
        if (!fields?.length) {
            return { content: [{ type: "text", text: "No fields to fill" }], isError: true };
        }
        for (const f of fields) {
            if (!f.selector?.trim()) {
                return { content: [{ type: "text", text: "Empty selector provided" }], isError: true };
            }
        }
        return await withRetry(async (attempt) => {
            for (const f of fields) {
                await session.page.waitForSelector(f.selector);
                await session.page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) {
                        el.value = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, f.selector);
                await session.page.type(f.selector, f.value || '');
            }
            if (submit) {
                await session.page.click(submit);
                await session.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            }
            if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
            return await formatResult(session.page, mode, session.page.url());
        }, { maxRetries: retries, baseDelay: 500 });
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

export async function browser_session_type(args, context) {
    const { sessionId, selector, text, delay = 0, keystrokes } = args;

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
        if (selector) {
            await session.page.waitForSelector(selector);
            await session.page.focus(selector);
        }

        if (text) {
            await session.page.keyboard.type(text, { delay });
        }

        if (keystrokes && keystrokes.length > 0) {
            for (const key of keystrokes) {
                await session.page.keyboard.press(key);
            }
        }

        return { content: [{ type: "text", text: `Typed${selector ? ` into ${selector}` : ''}: ${text || keystrokes.join(', ')}` }] };
    } catch (err) {
        return { content: [{ type: "text", text: `Type failed: ${err.message}` }], isError: true };
    }
}

export async function browser_session_inspect(args, context) {
    const { sessionId, selector, screenshot = false } = args;

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
        await session.page.waitForSelector(selector, { timeout: 5000 });
    } catch {
        return { content: [{ type: "text", text: `Selector not found: ${selector}` }], isError: true };
    }

    try {
        const info = await session.page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return { error: 'Element not found' };

            const rect = el.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0;

            return {
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                classes: el.className ? Array.from(el.classList) : [],
                attributes: Array.from(el.attributes).reduce((acc, attr) => {
                    acc[attr.name] = attr.value;
                    return acc;
                }, {}),
                text: el.innerText || el.textContent || '',
                innerHTML: el.innerHTML.substring(0, 500),
                position: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                visible,
                disabled: el.disabled || el.getAttribute('aria-disabled') === 'true'
            };
        }, selector);

        let result = `Element: <${info.tag}>${info.id ? `#${info.id}` : ''}\n`;
        result += `Classes: ${info.classes.join('.') || '(none)'}\n`;
        result += `Visible: ${info.visible}, Disabled: ${info.disabled}\n`;
        result += `Position: {x:${info.position.x}, y:${info.position.y}, w:${info.position.width}, h:${info.position.height}}\n`;
        result += `Attributes: ${JSON.stringify(info.attributes)}\n`;
        result += `Text: "${info.text.substring(0, 200)}"\n`;
        result += `InnerHTML: ${info.innerHTML.substring(0, 200)}...`;

        const content = [{ type: "text", text: result }];

        if (screenshot) {
            const screenshot_ = await session.page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            }, selector);

            if (screenshot_) {
                const img = await session.page.screenshot({
                    encoding: 'base64',
                    clip: screenshot_
                });
                content.push({ type: "image", data: img, mimeType: "image/png" });
            }
        }

        return { content };
    } catch (err) {
        return { content: [{ type: "text", text: `Inspect failed: ${err.message}` }], isError: true };
    }
}

export async function browser_session_console(args, _context) {
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

    const messages = session.consoleBuffer.splice(0); // Drain and return

    if (messages.length === 0) {
        return { content: [{ type: "text", text: "No console messages captured" }] };
    }

    const lines = messages.map(m => `[${m.type}] ${m.text}`);
    return { content: [{ type: "text", text: `Console messages (${messages.length}):\n\n${lines.join('\n')}` }] };
}

export async function browser_session_wait(args, context) {
    const { sessionId, selectors, text, urlPattern, condition, timeout = 15000 } = args;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    const startTime = Date.now();

    try {
        // Selector OR logic
        if (selectors && selectors.length > 0) {
            const msg = selectors.length === 1
                ? `Waiting for: ${selectors[0]}`
                : `Waiting for any: ${selectors.join(' | ')}`;
            if (context.progress) context.progress(msg, 30, 100);

            // Wait for first selector to match
            const promises = selectors.map(sel =>
                session.page.waitForSelector(sel, { timeout, hidden: false })
                    .then(() => sel)
                    .catch(() => null)
            );
            const result = await Promise.race(promises);
            if (!result) {
                return { content: [{ type: "text", text: `Timeout waiting for selectors: ${selectors.join(', ')}` }], isError: true };
            }
            return { content: [{ type: "text", text: `Selector matched: ${result} after ${Date.now() - startTime}ms` }] };
        }

        // Text content waiting
        if (text) {
            if (context.progress) context.progress(`Waiting for text: "${text.substring(0, 50)}"`, 30, 100);
            await session.page.waitForFunction(
                (searchText) => document.body.innerText.includes(searchText),
                { timeout, arguments: [text] }
            );
            return { content: [{ type: "text", text: `Text found after ${Date.now() - startTime}ms` }] };
        }

        // URL pattern matching
        if (urlPattern) {
            if (context.progress) context.progress(`Waiting for URL: ${urlPattern}`, 30, 100);
            const regex = new RegExp(urlPattern);
            await session.page.waitForFunction(
                (_pat) => regex.test(window.location.href),
                { timeout, arguments: [urlPattern] }
            );
            return { content: [{ type: "text", text: `URL matched after ${Date.now() - startTime}ms` }] };
        }

        // Custom JS condition
        if (condition) {
            if (context.progress) context.progress(`Waiting for condition`, 30, 100);
            await session.page.waitForFunction(new Function('return ' + condition), { timeout });
            return { content: [{ type: "text", text: `Condition met after ${Date.now() - startTime}ms` }] };
        }

        return { content: [{ type: "text", text: "No wait condition specified" }], isError: true };
    } catch (err) {
        return { content: [{ type: "text", text: `Wait failed: ${err.message}` }], isError: true };
    }
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
