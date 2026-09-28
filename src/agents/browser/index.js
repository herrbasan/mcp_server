import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { htmlToMarkdown } from '../../lib/html-to-markdown.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, 'config.json');
const agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const defaultViewport = agentConfig.defaultViewport || { width: 1280, height: 1280 };

// Browser state tracking
let browser = null;
// True only when THIS process launched the browser. Connecting to a Chrome that
// was already running (another agent, or a previous run) must never close it:
// puppeteer's browser.close() on a connected browser kills the remote process.
let browserOwnedByUs = false;
let browserIdleTimer = null;
const BROWSER_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
let activePages = new Set();
let isShuttingDown = false;

// Session registry - maps sessionId -> Session object
const sessions = new Map();
const SESSION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes per session

// Visible browser instances - maps sessionId -> Browser instance (for headed sessions)
const visibleBrowsers = new Map();

// Populated by init(): the internal page API (for browser.fetch) and the storage
// coordinates it writes into.
let internalApi = null;
let fetchStorage = { root: null, uncShare: null, publicUrl: null };

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

// Serialised so concurrent callers cannot each launch a browser. The search
// adapters run in parallel and so do the first scraper pages, so several callers
// can see `browser === null` at once — and without this the loser of the race
// dies with Chrome's "the browser is already running for <profile>", failing the
// fetch it was serving for no real reason.
let browserInitPromise = null;

async function getBrowser() {
    if (isShuttingDown) {
        throw new Error('Browser is shutting down');
    }

    if (browser) {
        resetBrowserIdleTimer();
        return browser;
    }

    if (!browserInitPromise) {
        browserInitPromise = initBrowser().finally(() => { browserInitPromise = null; });
    }
    await browserInitPromise;
    return browser;
}

async function initBrowser() {
    if (!browser) {
        const debugUrl = `http://localhost:${DEBUGGING_PORT}`;

        // Try to connect to an already-running Chrome with debugging enabled.
        //
        // browserURL, NOT browserWSEndpoint: a bare `ws://localhost:9222` is not
        // a CDP endpoint and answers 404, so this branch never once succeeded —
        // every call launched a second Chrome, and a second Chrome cannot start
        // on the same profile ("the browser is already running for <profile>").
        // The http URL makes Puppeteer read /json/version and use the real
        // webSocketDebuggerUrl.
        try {
            log('Attempting to connect to existing Chrome via CDP...');
            browser = await puppeteer.connect({
                browserURL: debugUrl,
                timeout: 3000
            });
            browserOwnedByUs = false;

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
                browserOwnedByUs = true;
            } catch (launchErr) {
                log(`Failed to launch browser: ${launchErr.message}`);
                throw launchErr;
            }
        }
    }

    return browser;
}

// Kept separate from init so every caller — not just the one that happened to
// launch the browser — keeps the idle window open.
function resetBrowserIdleTimer() {
    if (browserIdleTimer) {
        clearTimeout(browserIdleTimer);
        browserIdleTimer = null;
    }

    browserIdleTimer = setTimeout(async () => {
        if (browser && !isShuttingDown && sessions.size === 0) {
            log(`Idle timeout (${BROWSER_IDLE_TIMEOUT}ms) reached, closing browser (no active sessions)`);
            try {
                if (browserOwnedByUs) {
                    await browser.close();
                    log('Browser closed due to idle timeout');
                } else {
                    // Attached to someone else's Chrome — drop the connection and
                    // leave their browser running.
                    browser.disconnect();
                    log('Dropped idle connection to a browser this process did not launch');
                }
            } catch (err) {
                log(`Error closing idle browser: ${err.message}`);
            }
            browser = null;
            browserOwnedByUs = false;
            activePages.clear();
        }
    }, BROWSER_IDLE_TIMEOUT);
}

export async function init(context) {
    // Storage coordinates for browser.fetch (it writes converted pages there
    // rather than returning bodies). Optional: the fetch tool throws a clear
    // error if they are missing, everything else in this agent is unaffected.
    const storageConfig = context?.config?.agents?.storage || {};
    fetchStorage = {
        root: storageConfig.root || null,
        uncShare: storageConfig.uncShare || null,
        publicUrl: storageConfig.publicUrl || null
    };

    // Export standard internal APIs for cross-agent use (like web research)
    const api = {
        async getPage() {
            const b = await getBrowser();
            const page = await b.newPage();
            const pageId = Math.random().toString(36).substring(2, 8);
            
            // Track the page
            activePages.add(page);
            log(`New page opened [${pageId}], total active: ${activePages.size}`);
            
            // Viewport only — no UA/Accept-Language spoofing. The stale
            // Chrome/120 claim under a newer engine was a stronger bot signal
            // than the untouched defaults (Cloudflare, DeepSeek 2026-09-26).
            await page.setViewport(defaultViewport);
            
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

    internalApi = api;
    return api;
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
        
        // Then close the browser — but only one we started. Closing a browser we
        // merely connected to would take down whatever process owns it.
        if (browserOwnedByUs) {
            log('Closing browser process...');
            await browser.close();
            log(`Browser (PID: ${pid}) closed successfully`);
        } else {
            log('Disconnecting from a browser this process did not launch...');
            browser.disconnect();
            log('Disconnected');
        }
        
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

async function formatResult(page, mode, url, options = {}) {
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

    // 'markdown' is a real conversion (headings, code fences, GFM tables).
    // It used to be Readability's textContent with '# Title' glued on top, which
    // flattened the two structures documentation is mostly made of. A page that
    // cannot be converted is an error, not an empty string — the caller needs to
    // know the extraction failed.
    if (mode === 'markdown') {
        try {
            const result = htmlToMarkdown(html, {
                url,
                scope: options.scope || 'auto',
                maxLength: options.maxLength || 0,
                minChars: options.minChars || 0
            });
            const header = result.title ? `# ${result.title}\n\n` : '';
            const note = result.stats.truncated ? `\n\n<!-- truncated at ${options.maxLength} chars -->` : '';
            return { content: [{ type: "text", text: `${header}${result.markdown}${note}`.substring(0, 200000) }] };
        } catch (e) {
            return { content: [{ type: "text", text: `Markdown conversion failed: ${e.message}` }], isError: true };
        }
    }

    try {
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();
        
        let text = article ? article.textContent : dom.window.document.body.textContent;
        // Clean excessive whitespace
        text = text.replace(/\n\s*\n/g, '\n\n').trim();

        return { content: [{ type: "text", text: text.substring(0, 50000) }] };
    } catch (e) {
        return { content: [{ type: "text", text: `Extraction error: ${e.message}\n\nRaw HTML prefix:\n${html.substring(0, 5000)}` }], isError: true };
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
    // No UA/Accept-Language overrides unless the caller passes one. A spoofed
    // stale UA (Chrome/120 under a 143+ engine) contradicts the TLS/JS
    // fingerprint and trips Cloudflare bot detection (seen on DeepSeek
    // 2026-09-26). The real engine UA is the only self-consistent claim.
    if (userAgent) {
        await page.setUserAgent(userAgent);
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
        content: [{ type: "text", text: JSON.stringify({ sessionId, visible, pageUrl: page.url() || 'about:blank' }) }]
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
    const { sessionId, mode = 'text', scope, maxLength, minChars } = args;

    if (!sessionId) {
        return { content: [{ type: "text", text: "sessionId is required" }], isError: true };
    }

    const session = sessions.get(sessionId);
    if (!session) {
        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
    }

    await ensurePageForSession(session);
    resetSessionIdleTimer(sessionId);

    return await formatResult(session.page, mode, session.page.url(), { scope, maxLength, minChars });
}

export async function browser_session_click(args, context) {
    const { sessionId, selector, waitAfter, mode = 'text', retries = 2 } = args;
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
            if (progress) progress(`Waiting for ${selector}...${attempt > 0 ? ` (retry ${attempt})` : ''}`, 30, 100);
            await session.page.waitForSelector(selector);
            if (progress) progress(`Clicking ${selector}...`, 60, 100);
            await session.page.click(selector);
            if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
            if (progress) progress('Click complete', 100, 100);
            return await formatResult(session.page, mode, session.page.url());
        }, {
            maxRetries: retries,
            baseDelay: 300,
            onRetry: (attempt, total, err, delay) => {
                if (progress) progress(`Retry ${attempt}/${total} after ${delay}ms: ${err.message}`, 30, 100);
            }
        });
    } catch (err) {
        return { content: [{ type: "text", text: `Click failed: ${err.message}` }], isError: true };
    }
}

export async function browser_session_fill(args, context) {
    const { sessionId, fields, submit, waitAfter, mode = 'text', retries = 2 } = args;
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
        if (!fields?.length) {
            return { content: [{ type: "text", text: "No fields to fill" }], isError: true };
        }
        for (const f of fields) {
            if (!f.selector?.trim()) {
                return { content: [{ type: "text", text: "Empty selector provided" }], isError: true };
            }
        }
        return await withRetry(async (attempt) => {
            for (let i = 0; i < fields.length; i++) {
                const f = fields[i];
                if (progress) progress(`Filling field ${i + 1}/${fields.length} (${f.selector})...${attempt > 0 ? ` (retry ${attempt})` : ''}`, 20 + Math.round((40 * i) / fields.length), 100);
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
                if (progress) progress('Submitting form...', 70, 100);
                await session.page.click(submit);
                await session.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
            }
            if (waitAfter) await new Promise(r => setTimeout(r, waitAfter));
            if (progress) progress('Fill complete', 100, 100);
            return await formatResult(session.page, mode, session.page.url());
        }, {
            maxRetries: retries,
            baseDelay: 500,
            onRetry: (attempt, total, err, delay) => {
                if (progress) progress(`Retry ${attempt}/${total} after ${delay}ms: ${err.message}`, 20, 100);
            }
        });
    } catch (err) {
        return { content: [{ type: "text", text: `Fill failed: ${err.message}` }], isError: true };
    }
}

export async function browser_session_evaluate(args, context) {
    const { sessionId, script, waitFor } = args;
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
        if (waitFor) {
            if (progress) progress(`Waiting for ${waitFor}...`, 30, 100);
            await session.page.waitForSelector(waitFor).catch(() => {});
        }

        if (progress) progress('Evaluating script...', 60, 100);
        // Pass script as a raw string so Puppeteer treats it as an expression
        // (it wraps strings with `return` automatically). If the script is a
        // statement rather than an expression, fall back to new Function for
        // statement-style evaluation (caller can use explicit `return`).
        let result;
        try {
            result = await session.page.evaluate(script);
        } catch (evalErr) {
            if (evalErr.message?.includes('SyntaxError')) {
                result = await session.page.evaluate(new Function(script));
            } else {
                throw evalErr;
            }
        }
        if (progress) progress('Evaluation complete', 100, 100);
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
            if (context.progress) context.progress('Selector matched', 100, 100);
            return { content: [{ type: "text", text: `Selector matched: ${result} after ${Date.now() - startTime}ms` }] };
        }

        // Text content waiting
        if (text) {
            if (context.progress) context.progress(`Waiting for text: "${text.substring(0, 50)}"`, 30, 100);
            await session.page.waitForFunction(
                (searchText) => document.body.innerText.includes(searchText),
                { timeout, arguments: [text] }
            );
            if (context.progress) context.progress('Text found', 100, 100);
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
            if (context.progress) context.progress('URL matched', 100, 100);
            return { content: [{ type: "text", text: `URL matched after ${Date.now() - startTime}ms` }] };
        }

        // Custom JS condition
        if (condition) {
            if (context.progress) context.progress(`Waiting for condition`, 30, 100);
            await session.page.waitForFunction(new Function('return ' + condition), { timeout });
            if (context.progress) context.progress('Condition met', 100, 100);
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

// ============================================
// browser.fetch — one URL in, Markdown in storage
// ============================================
//
// Takes a URL, renders it, converts with htmlToMarkdown, writes the result into
// storage and returns the COORDINATES — not the body. That is deliberate: a page
// must never arrive truncated, and a caller holding a path reads exactly the
// range it needs (storage.read takes offset+length windows) instead of losing a
// third of the document to a hidden cap.
//
// RENDERING IS THE DEFAULT, not the fallback. A plain HTTP fetch looks like the
// fast path and is not: measured 2026-09-28 against nine bot-protected sites,
// five refused it outright (StackOverflow 403, Glassdoor 403, and challenge pages
// from Zillow, Medium and TikTok), and Chrome gets past some of those. Trying HTTP
// first would mean a wasted request on every protected site and a Chrome render
// anyway — no time or CPU saved. `prefer: 'http'` survives for resources that are
// not pages (sitemap.xml, llms.txt, a JSON endpoint), where rendering is wrong
// rather than merely slower.
//
// The failure that still needs guarding runs the other way: a block page has HTTP
// 200, real English, and enough characters to pass any length check. Stored
// unexamined it is indistinguishable from a document — Glassdoor's Cloudflare
// interstitial was captured as content during testing.

// Only used by the opt-in HTTP path; a UA makes no measurable difference to
// whether a site blocks (Chrome/120, Chrome/141 and no UA all blocked the same
// five sites).
const FETCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 25000;

// Block pages are the failure that hides best: HTTP 200, a few hundred
// characters of English, and the tool stores a "Just a moment..." wall as if it
// were the document. Measured 2026-09-28: StackOverflow 403s a plain fetch,
// Medium and Glassdoor serve challenges, and headless Chrome does NOT always get
// through either (Glassdoor returned Cloudflare's interstitial to Chrome too).
//
// Matched against the CONVERTED TEXT — title plus the document body — because
// that is what a block page is almost entirely made of. A substring test for
// 'captcha' looked tempting and is wrong: Wikipedia's ordinary JSON article
// contains that word, and a false positive turns a good fetch into an error.
// These markers are all high-precision phrases with no other use.
const BLOCK_MARKERS = [
    'just a moment...',
    'checking your browser before accessing',
    'enable javascript and cookies to continue',
    'attention required!',
    'verifying you are human',
    'verify you are human',
    'request unsuccessful. incapsula',
    'vercel security checkpoint',
    'unusual traffic from your computer',
    'your request has been blocked'
];

export function detectBlockPage(result) {
    const text = `${result.title || ''}\n${result.markdown.slice(0, 4000)}`.toLowerCase();
    return BLOCK_MARKERS.find(m => text.includes(m)) || null;
}

function isHtmlLike(contentType) {
    return !contentType || contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

function isTextLike(contentType) {
    return contentType.startsWith('text/') || contentType === 'application/json' ||
        contentType === 'application/xml' || contentType.endsWith('+json') || contentType.endsWith('+xml');
}

async function fetchOverHttp(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const started = Date.now();
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': FETCH_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'follow',
            signal: controller.signal
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
        }
        const body = await res.text();
        const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        log(`fetch HTTP ${res.status}: ${body.length} bytes, type '${contentType || '(none)'}', ${Date.now() - started}ms`);
        return { body, contentType, finalUrl: res.url || url };
    } catch (e) {
        throw new Error(e.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS}ms` : e.message);
    } finally {
        clearTimeout(timer);
    }
}

// Convert, or return null. A page with nothing extractable is a signal to try the
// other transport, not an error yet — the caller decides once it has seen both.
function tryConvertToMarkdown(html, baseUrl, options) {
    try {
        return htmlToMarkdown(html, {
            url: baseUrl,
            scope: options.scope,
            maxLength: options.maxLength,
            minChars: options.minChars
        });
    } catch (e) {
        log(`conversion produced nothing: ${e.message}`);
        return null;
    }
}

async function fetchViaBrowser(url) {
    if (!internalApi) {
        throw new Error('browser: agent not initialised');
    }
    const { page, markUsed, close, pageId } = await internalApi.getPage();
    const started = Date.now();
    try {
        log(`[${pageId}] rendering ${url}`);
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        // Only 4xx/5xx are failures. A 304 Not Modified is a SUCCESS here: this
        // agent uses a persistent Chrome profile, so a second visit to a page
        // sends a conditional request and the server answers "not modified" —
        // Chrome then serves the cached body, which is exactly what we want. An
        // `!response.ok()` test rejected those and failed whole harvests on the
        // second run.
        if (response && response.status() >= 400) {
            throw new Error(`HTTP ${response.status()} ${response.statusText() || ''}`.trim());
        }
        const body = await page.content();
        // Read from the navigation response so a .txt or .json gets treated as
        // what it is, whichever transport brought it in.
        const contentType = (response?.headers()?.['content-type'] || '').split(';')[0].trim().toLowerCase();
        const finalUrl = page.url();
        log(`[${pageId}] rendered ${body.length} bytes, type '${contentType || '(none)'}', ${Date.now() - started}ms`);
        return { body, contentType, finalUrl };
    } finally {
        markUsed();
        await close(0);
    }
}

// One place decides what a fetched response becomes, so a .txt is stored verbatim
// whether it arrived over HTTP or through Chrome, and a challenge page is refused
// either way.
function storeFetched({ body, contentType, finalUrl, via, options, name, dir }) {
    if (!isHtmlLike(contentType) && !isTextLike(contentType)) {
        throw new Error(
            `browser_fetch: content-type '${contentType}' is not text — this tool converts ` +
            'HTML and text. Fetch binary files another way.'
        );
    }

    // Not a document — store it byte-for-byte rather than mangling it.
    if (!isHtmlLike(contentType)) {
        return writeFetchResult({
            result: {
                markdown: body,
                title: null,
                strategy: 'raw',
                stats: { markdownLength: body.length, codeBlocks: 0, tables: 0, tableRows: 0, truncated: false }
            },
            finalUrl,
            via: `${via} (raw ${contentType})`,
            relPath: fetchRawPath(finalUrl, name, dir),
            verbatim: true
        });
    }

    const result = tryConvertToMarkdown(body, finalUrl, options);
    if (!result) {
        throw new Error(`browser_fetch: no extractable content from ${finalUrl} (via ${via})`);
    }

    const block = detectBlockPage(result);
    if (block) {
        throw new Error(
            `browser_fetch: the site served a block page instead of content ` +
            `(matched "${block}", via ${via}). The page is probably behind bot protection — ` +
            'try a browser session with a visible window, or fetch it another way.'
        );
    }

    return writeFetchResult({
        result,
        finalUrl,
        via,
        relPath: fetchStoragePath(finalUrl, name, dir)
    });
}

function fetchSlug(s) {
    return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// Stable, human-readable, idempotent: re-fetching a URL overwrites the same file
// (storage snapshots the previous version).
function fetchStoragePath(finalUrl, name, dir) {
    const u = new URL(finalUrl);
    const host = fetchSlug(u.hostname) || 'unknown-host';
    const p = fetchSlug(u.pathname.replace(/\/+$/, '')) || 'index';
    return `${dir}/${host}/${name ? fetchSlug(name) : p}.md`;
}

// Verbatim text keeps its own extension — slugging the path turned
// `/raw.txt` into `raw-txt.txt` and `/data.json` into `data-json.txt`, so a
// caller could no longer see what the file was.
function fetchRawPath(finalUrl, name, dir) {
    const u = new URL(finalUrl);
    const host = fetchSlug(u.hostname) || 'unknown-host';
    const base = path.posix.basename(u.pathname);
    const ext = path.posix.extname(base).toLowerCase();
    const stem = ext ? base.slice(0, base.length - ext.length) : base;
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.txt';
    return `${dir}/${host}/${name ? fetchSlug(name) : (fetchSlug(stem) || 'index')}${safeExt}`;
}

// Writes the result and returns it in structured form. The tool wrapper turns
// this into the text summary a caller reads; other agents (harvest) call
// runBrowserFetch directly and use the fields, so the storage path is never
// recovered by parsing prose.
function writeFetchResult({ result, finalUrl, via, relPath, verbatim = false }) {
    const abs = path.join(fetchStorage.root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    // Provenance frontmatter belongs on converted Markdown, not on a verbatim
    // passthrough: prepending YAML to a .json response makes it unparseable.
    let content;
    if (verbatim) {
        content = result.markdown;
    } else {
        // JSON.stringify yields a valid double-quoted YAML scalar.
        const front = [
            '---',
            `source: ${JSON.stringify(finalUrl)}`,
            `fetched: ${new Date().toISOString()}`,
            result.title ? `title: ${JSON.stringify(result.title)}` : null,
            `via: ${via}`,
            '---',
            ''
        ].filter(l => l !== null).join('\n');
        content = `${front}\n${result.markdown}\n`;
    }

    fs.writeFileSync(abs, content, 'utf8');
    const stat = fs.statSync(abs);
    log(`wrote ${relPath} (${stat.size} bytes, via ${via}${verbatim ? ', verbatim' : ''})`);

    return {
        relPath,
        absPath: abs,
        finalUrl,
        via,
        verbatim,
        bytes: stat.size,
        title: result.title || null,
        strategy: result.strategy,
        stats: result.stats,
        url: fetchStorage.publicUrl ? `${fetchStorage.publicUrl.replace(/\/+$/, '')}/storage/${relPath}` : null,
        unc: fetchStorage.uncShare ? `${fetchStorage.uncShare.replace(/[\\/]+$/, '')}\\${relPath.replace(/\//g, '\\')}` : null
    };
}

function formatFetchSummary(r) {
    const lines = [
        `Fetched ${r.finalUrl}`,
        `  via        ${r.via}`,
        `  title      ${r.title || '(none)'}`,
        `  strategy   ${r.strategy}`,
        `  size       ${(r.bytes / 1024).toFixed(1)} KB  (${r.stats.markdownLength} chars of markdown)`,
        `  structure  ${r.stats.codeBlocks} code block(s), ${r.stats.tables} table(s), ${r.stats.tableRows} table row(s)`,
        `  storage    ${r.relPath}`,
        r.url ? `  url        ${r.url}` : null,
        r.unc ? `  unc        ${r.unc}` : null,
        '',
        r.verbatim
            ? 'Stored byte-for-byte: not a document, so it was not converted and nothing was added to it.'
            : 'Read it with storage.read (offset + length for partial reads), or hand the path to a smarter model. Nothing was truncated.'
    ].filter(l => l !== null);
    return lines.join('\n');
}

// Structured core — the tool below is a text presenter over this. Exported so
// sibling agents (harvest) reuse the whole retrieve/convert/store path without
// parsing a human-readable summary to find out where the file went.
export async function runBrowserFetch(args) {
    const {
        url,
        scope = 'auto',
        maxLength = 0,
        minChars = 0,
        name,
        dir = 'fetch',
        prefer = 'browser'
    } = args;

    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('browser_fetch: url is required');
    }
    let target;
    try {
        target = new URL(url.trim());
    } catch {
        throw new Error(`browser_fetch: not a valid absolute URL: ${url}`);
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error(`browser_fetch: only http and https URLs are supported, got '${target.protocol}'`);
    }
    if (!['browser', 'http'].includes(prefer)) {
        throw new Error(`browser_fetch: prefer must be browser|http, got '${prefer}'`);
    }
    if (!fetchStorage.root) {
        throw new Error('browser_fetch: config agents.storage.root is required to write the result');
    }
    if (path.isAbsolute(dir) || dir.includes('..')) {
        throw new Error(`browser_fetch: dir must be a relative path inside storage, got '${dir}'`);
    }

    const options = { scope, maxLength, minChars };

    // Opt-in, and only for things that are not pages: sitemap.xml, llms.txt, a
    // raw JSON endpoint. Rendering those in Chrome is wrong, not just slower —
    // it would wrap them in a viewer page.
    if (prefer === 'http') {
        const res = await fetchOverHttp(url.trim());
        return storeFetched({ ...res, via: 'http', options, name, dir });
    }

    // Default: render. See the section comment for why HTTP-first was abandoned.
    const res = await fetchViaBrowser(url.trim());

    // The render told us this is not a page (text/plain, JSON, XML). Chrome wraps
    // those in a viewer document, so page.content() is the wrapper, not the
    // resource — fetch the actual bytes before storing them verbatim.
    if (!isHtmlLike(res.contentType)) {
        const raw = await fetchOverHttp(res.finalUrl);
        return storeFetched({ ...raw, via: 'http (non-HTML resource)', options, name, dir });
    }

    return storeFetched({ ...res, via: 'browser', options, name, dir });
}

export async function browser_fetch(args, _context) {
    const result = await runBrowserFetch(args);
    return { content: [{ type: 'text', text: formatFetchSummary(result) }], isError: false };
}
