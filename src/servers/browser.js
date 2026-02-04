// Browser Server - Direct Puppeteer access for LLMs
// Persistent browser with idle timeout for performance

import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const TOOL_NAMES = new Set(['browser_fetch', 'browser_click', 'browser_fill', 'browser_evaluate', 'browser_pdf', 'browser_login']);

const TOOLS = [
  {
    name: 'browser_fetch',
    description: `Fetch URL using a REAL HEADLESS BROWSER (Puppeteer/Chrome) - not HTTP fetch. Executes JavaScript, handles SPA/React apps, waits for dynamic content. Use when simple HTTP fails or need rendered content.

Modes:
- "text" (default): Clean extracted article text via Readability (removes nav/ads/clutter). Best for reading content. ~5-50KB.
- "html": Raw DOM after JS execution. Use for tables, forms, structured data extraction. ~50-500KB.
- "screenshot": Base64 PNG image. Use for visual verification, charts, layouts. ~100-500KB.
- "markdown": Structured markdown conversion.

Use "text" for 90% of cases - token-efficient and LLM-friendly.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        mode: { type: 'string', enum: ['text', 'html', 'screenshot', 'markdown'], description: 'Output format (default: text)' },
        waitFor: { type: 'string', description: 'CSS selector to wait for before extracting content (optional)' },
        fullPage: { type: 'boolean', description: 'For screenshot mode: capture full page vs viewport (default: false)' },
        viewport: {
          type: 'object',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
          description: 'Custom viewport size (default: 1280x800)'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_click',
    description: 'Navigate to URL, click an element, and return the resulting page content. Useful for buttons, links, interactive elements.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        selector: { type: 'string', description: 'CSS selector of element to click' },
        waitAfter: { type: 'number', description: 'Milliseconds to wait after click (default: 1000)' },
        mode: { type: 'string', enum: ['text', 'html', 'screenshot'], description: 'Output format after click (default: text)' }
      },
      required: ['url', 'selector']
    }
  },
  {
    name: 'browser_fill',
    description: 'Fill form fields and optionally submit. Returns page content after action.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of input field' },
              value: { type: 'string', description: 'Value to fill' }
            },
            required: ['selector', 'value']
          },
          description: 'Array of {selector, value} pairs to fill'
        },
        submit: { type: 'string', description: 'CSS selector of submit button to click (optional)' },
        waitAfter: { type: 'number', description: 'Milliseconds to wait after submit (default: 2000)' },
        mode: { type: 'string', enum: ['text', 'html', 'screenshot'], description: 'Output format after action (default: text)' }
      },
      required: ['url', 'fields']
    }
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript IN THE PAGE CONTEXT (like browser devtools console) and return the result. Your JS runs inside the loaded page and can access DOM, window, any page variables. Use for: extracting specific data, interacting with page APIs, scraping structured content.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        script: { type: 'string', description: 'JavaScript code to execute (must return a value)' },
        waitFor: { type: 'string', description: 'CSS selector to wait for before executing (optional)' }
      },
      required: ['url', 'script']
    }
  },
  {
    name: 'browser_pdf',
    description: 'Generate a PDF of the page. Returns base64-encoded PDF.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to capture as PDF' },
        format: { type: 'string', enum: ['A4', 'Letter', 'Legal', 'Tabloid'], description: 'Page format (default: A4)' },
        landscape: { type: 'boolean', description: 'Landscape orientation (default: false)' },
        printBackground: { type: 'boolean', description: 'Print background graphics (default: true)' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_login',
    description: 'Open a browser window to a login page so user can manually authenticate. Browser will stay open with saved session. Use when search engines or sites require login.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open for login (default: https://www.google.com)' },
        message: { type: 'string', description: 'Message to display to user' }
      },
      required: []
    }
  }
];

// --- Content extraction (pure functions) ---

function extractHtml(html, maxSize) {
  const truncated = html.substring(0, maxSize);
  return {
    content: [{ type: 'text', text: truncated + (html.length > maxSize ? '\n\n[TRUNCATED]' : '') }]
  };
}

function extractText(html, url, maxSize) {
  try {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    const links = [];
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      const text = a.textContent.trim();
      if (href && text && !href.startsWith('javascript:') && !href.startsWith('#')) {
        links.push({ text: text.substring(0, 100), url: href });
      }
    });

    const reader = new Readability(doc, { charThreshold: 200, nbTopCandidates: 5 });
    const article = reader.parse();

    if (!article) {
      const bodyText = doc.body?.textContent?.replace(/\s+/g, ' ').trim() || '';
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            url,
            title: doc.title || null,
            description: doc.querySelector('meta[name="description"]')?.content || null,
            content: bodyText.substring(0, maxSize),
            links: links.slice(0, 50)
          }, null, 2)
        }]
      };
    }

    const contentDom = new JSDOM(article.content);
    const textContent = contentDom.window.document.body.textContent
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, maxSize);

    const headings = [];
    contentDom.window.document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
      const text = h.textContent.trim();
      if (text) headings.push({ level: parseInt(h.tagName[1]), text });
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          url,
          title: article.title,
          description: article.excerpt || null,
          content: textContent,
          headings: headings.slice(0, 30),
          links: links.slice(0, 50)
        }, null, 2)
      }]
    };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error extracting content: ${err.message}` }], isError: true };
  }
}

function extractMarkdown(html, url, maxSize) {
  try {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    const reader = new Readability(doc, { charThreshold: 200, nbTopCandidates: 5 });
    const article = reader.parse();

    if (!article) {
      return { content: [{ type: 'text', text: `# ${doc.title || 'Untitled'}\n\n*Could not extract readable content.*` }] };
    }

    const markdown = htmlToMarkdown(article.content, article.title);
    return { content: [{ type: 'text', text: markdown.substring(0, maxSize) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error converting to markdown: ${err.message}` }], isError: true };
  }
}

function htmlToMarkdown(html, title) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  let md = title ? `# ${title}\n\n` : '';

  const convert = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();
    const children = Array.from(node.childNodes).map(convert).join('');

    switch (tag) {
      case 'h1': return `\n# ${children.trim()}\n\n`;
      case 'h2': return `\n## ${children.trim()}\n\n`;
      case 'h3': return `\n### ${children.trim()}\n\n`;
      case 'h4': return `\n#### ${children.trim()}\n\n`;
      case 'h5': return `\n##### ${children.trim()}\n\n`;
      case 'h6': return `\n###### ${children.trim()}\n\n`;
      case 'p': return `${children.trim()}\n\n`;
      case 'br': return '\n';
      case 'strong': case 'b': return `**${children}**`;
      case 'em': case 'i': return `*${children}*`;
      case 'code': return `\`${children}\``;
      case 'pre': return `\n\`\`\`\n${children.trim()}\n\`\`\`\n\n`;
      case 'a': const href = node.getAttribute('href'); return href ? `[${children}](${href})` : children;
      case 'img': const src = node.getAttribute('src'); return src ? `![${node.getAttribute('alt') || 'image'}](${src})` : '';
      case 'ul': case 'ol': return `\n${children}\n`;
      case 'li': return `${node.parentNode?.tagName?.toLowerCase() === 'ol' ? '1. ' : '- '}${children.trim()}\n`;
      case 'blockquote': return children.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
      case 'hr': return '\n---\n\n';
      case 'table': return `\n${children}\n`;
      case 'tr': return `|${children}\n`;
      case 'th': case 'td': return ` ${children.trim()} |`;
      default: return children;
    }
  };

  md += convert(doc.body);
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

// --- Browser server factory ---

export function createBrowserServer(config = {}) {
  const timeout = config.timeout || 30000;
  const maxContentSize = config.maxContentSize || 2 * 1024 * 1024;
  const defaultViewport = config.viewport || { width: 1280, height: 800 };
  const userAgent = config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const idleTimeout = config.idleTimeout || 300000;
  const userDataDir = config.userDataDir || null;

  // Browser state in closure
  let browser = null;
  let browserLock = null;
  let idleTimer = null;
  let activePages = 0;
  let lingeringPages = []; // { page, usedAt, closing }
  let cleanupInterval = null;

  const MIN_LINGER_MS = 10000;  // 10 seconds
  const MAX_LINGER_MS = 30000;  // 30 seconds
  const CLEANUP_INTERVAL_MS = 5000; // Check every 5 seconds

  function startCleanupTask() {
    if (cleanupInterval) return; // Already running
    
    cleanupInterval = setInterval(() => {
      const now = Date.now();
      
      for (const pageInfo of lingeringPages) {
        if (pageInfo.usedAt && !pageInfo.closing) {
          const age = now - pageInfo.usedAt;
          const lingerMs = MIN_LINGER_MS + Math.random() * (MAX_LINGER_MS - MIN_LINGER_MS);
          
          if (age > lingerMs) {
            pageInfo.closing = true;
            closePage(pageInfo);
          }
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  async function closePage(pageInfo) {
    try {
      await pageInfo.page.close();
      lingeringPages = lingeringPages.filter(p => p !== pageInfo);
      activePages--;
    } catch {
      // Already closed
    }
  }

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(closeIfIdle, idleTimeout);
  }

  async function closeIfIdle() {
    if (activePages > 0) {
      resetIdleTimer();
      return;
    }
    if (browser) {
      console.error('[Browser] Closing idle browser');
      await closeBrowser();
    }
  }

  async function closeBrowser() {
    if (!browser) return;
    
    // Stop cleanup task
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
    
    const b = browser;
    browser = null;
    lingeringPages = [];
    activePages = 0;
    
    try {
      await Promise.race([b.close(), new Promise(r => setTimeout(r, 2000))]);
    } catch {}
    if (b.process() && !b.process().killed) {
      try {
        if (process.platform === 'win32') {
          const { execSync } = await import('child_process');
          execSync(`taskkill /pid ${b.process().pid} /T /F`, { stdio: 'ignore' });
        } else {
          b.process().kill('SIGKILL');
        }
      } catch {}
    }
  }

  async function getBrowser() {
    resetIdleTimer();
    if (browser?.isConnected?.()) return browser;

    if (browserLock) {
      await browserLock;
      if (browser?.isConnected?.()) return browser;
    }

    browserLock = (async () => {
      console.error('[Browser] Launching persistent browser...');
      const launchOptions = {
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--ignore-certificate-errors',
          '--ignore-certificate-errors-spki-list',
          '--disable-dev-shm-usage'
        ]
      };
      
      if (userDataDir) {
        launchOptions.userDataDir = userDataDir;
        console.error(`[Browser] Using profile: ${userDataDir}`);
      }
      
      browser = await puppeteer.launch(launchOptions);
      console.error('[Browser] Browser ready');
      startCleanupTask(); // Start cleanup for lingering pages
    })();

    await browserLock;
    browserLock = null;
    return browser;
  }

  async function withPage(fn, viewport) {
    const b = await getBrowser();
    const page = await b.newPage();
    activePages++;

    try {
      await page.setViewport(viewport || defaultViewport);
      await page.setUserAgent(userAgent);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      return await fn(page);
    } finally {
      activePages--;
      await page.close().catch(() => {});
    }
  }

  async function extractContent(page, url, mode, options = {}) {
    const html = await page.content();
    switch (mode) {
      case 'html': return extractHtml(html, maxContentSize);
      case 'screenshot': return { content: [{ type: 'image', data: await page.screenshot({ fullPage: options.fullPage || false, type: 'png', encoding: 'base64' }), mimeType: 'image/png' }] };
      case 'markdown': return extractMarkdown(html, url, maxContentSize);
      default: return extractText(html, url, maxContentSize);
    }
  }

  // --- Tool handlers ---

  async function fetchPage({ url, mode = 'text', waitFor, fullPage = false, viewport }) {
    return withPage(async (page) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout });
      if (waitFor) await page.waitForSelector(waitFor, { timeout });
      await new Promise(r => setTimeout(r, 2000));
      return extractContent(page, url, mode, { fullPage });
    }, viewport);
  }

  async function clickElement({ url, selector, waitAfter = 1000, mode = 'text' }) {
    return withPage(async (page) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout });
      await page.waitForSelector(selector, { timeout });
      await page.click(selector);
      await new Promise(r => setTimeout(r, waitAfter));
      return extractContent(page, url, mode);
    });
  }

  async function fillForm({ url, fields, submit, waitAfter = 2000, mode = 'text' }) {
    return withPage(async (page) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout });
      for (const { selector, value } of fields) {
        await page.waitForSelector(selector, { timeout });
        await page.type(selector, value, { delay: 50 });
      }
      if (submit) {
        await page.click(submit);
        await new Promise(r => setTimeout(r, waitAfter));
      }
      return extractContent(page, url, mode);
    });
  }

  async function evaluateScript({ url, script, waitFor }) {
    return withPage(async (page) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout });
      if (waitFor) await page.waitForSelector(waitFor, { timeout });
      const result = await page.evaluate(script);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
  }

  async function generatePdf({ url, format = 'A4', landscape = false, printBackground = true }) {
    return withPage(async (page) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout });
      const pdfBuffer = await page.pdf({
        format,
        landscape,
        printBackground,
        margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
      });
      return { content: [{ type: 'text', text: `data:application/pdf;base64,${pdfBuffer.toString('base64')}` }] };
    });
  }

  async function loginSession({ url = 'https://www.google.com', message }) {
    const b = await getBrowser();
    const page = await b.newPage();
    activePages++;
    
    try {
      await page.setViewport(defaultViewport);
      await page.setUserAgent(userAgent);
      await page.goto(url, { waitUntil: 'networkidle2', timeout });
      
      const displayMessage = message || `Browser opened to ${url}. Please log in and close the tab when done. Session will be saved.`;
      
      return {
        content: [{
          type: 'text',
          text: `🔐 ${displayMessage}\n\nBrowser window is open and waiting for you to log in.\nThe session will be automatically saved to the profile.\n\nClose the browser tab when finished.`
        }]
      };
    } finally {
      // Don't close page - let user do it manually
      // Page will linger and close naturally
    }
  }

  return {
    getTools: () => TOOLS,
    handlesTool: (name) => TOOL_NAMES.has(name),
    async callTool(name, args) {
      switch (name) {
        case 'browser_fetch': return fetchPage(args);
        case 'browser_click': return clickElement(args);
        case 'browser_fill': return fillForm(args);
        case 'browser_evaluate': return evaluateScript(args);
        case 'browser_pdf': return generatePdf(args);
        case 'browser_login': return loginSession(args);
        default: throw new Error(`Unknown tool: ${name}`);
      }
    },
    
    // Public API for custom automation (search adapters, web-research)
    async getPage() {
      const b = await getBrowser();
      const page = await b.newPage();
      activePages++;
      
      await page.setViewport(defaultViewport);
      await page.setUserAgent(userAgent);
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
      
      const pageInfo = { page, usedAt: null, closing: false };
      lingeringPages.push(pageInfo);
      
      return {
        page,
        markUsed() {
          pageInfo.usedAt = Date.now(); // Mark for lingering cleanup
        },
        close() {
          return closePage(pageInfo);
        }
      };
    },
    
    // Simplified fetch for web-research scraping
    async fetch(url, options = {}) {
      return withPage(async (page) => {
        await page.goto(url, { 
          waitUntil: options.waitUntil || 'networkidle2', 
          timeout: options.timeout || timeout 
        });
        if (options.waitFor) await page.waitForSelector(options.waitFor, { timeout });
        if (options.delay) await new Promise(r => setTimeout(r, options.delay));
        
        const html = await page.content();
        return {
          url,
          html,
          title: await page.title(),
          content: html
        };
      }, options.viewport);
    },
    
    close: closeBrowser
  };
}
