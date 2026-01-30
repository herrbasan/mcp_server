// Browser Server - Direct Puppeteer access for LLMs
// No LLM involvement - raw browser automation
// Persistent browser with idle timeout for performance

import puppeteer from 'puppeteer';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export class BrowserServer {
  constructor(config = {}) {
    this.timeout = config.timeout || 30000;
    this.maxContentSize = config.maxContentSize || 2 * 1024 * 1024; // 2MB default
    this.defaultViewport = config.viewport || { width: 1280, height: 800 };
    this.userAgent = config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    
    // Persistent browser state
    this.browser = null;
    this.browserLock = null; // Promise lock for initialization
    this.idleTimeout = config.idleTimeout || 300000; // 5 min idle = close browser
    this.idleTimer = null;
    this.activePages = 0;
  }

  async getBrowser() {
    // Reset idle timer on each use
    this.resetIdleTimer();
    
    // If browser exists and connected, return it
    if (this.browser?.isConnected?.()) {
      return this.browser;
    }
    
    // Use lock to prevent concurrent initialization
    if (this.browserLock) {
      await this.browserLock;
      if (this.browser?.isConnected?.()) return this.browser;
    }
    
    // Launch new browser
    this.browserLock = (async () => {
      console.error('[Browser] Launching persistent browser...');
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--ignore-certificate-errors',
          '--ignore-certificate-errors-spki-list',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
      console.error('[Browser] Browser ready');
    })();
    
    await this.browserLock;
    this.browserLock = null;
    return this.browser;
  }

  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeIfIdle(), this.idleTimeout);
  }

  async closeIfIdle() {
    if (this.activePages > 0) {
      this.resetIdleTimer(); // Still in use, reschedule
      return;
    }
    if (this.browser) {
      console.error('[Browser] Closing idle browser');
      await this.closeBrowser();
    }
  }

  async closeBrowser() {
    if (!this.browser) return;
    const b = this.browser;
    this.browser = null;
    try {
      await Promise.race([b.close(), new Promise(r => setTimeout(r, 2000))]);
    } catch {}
    // Force kill if needed
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

  getTools() {
    return [
      {
        name: 'browser_fetch',
        description: `Fetch a URL using a real browser. Returns content in the requested format.

Modes:
- "text" (default): Clean extracted text + links using Readability. Best for articles, docs, reading content. ~5-50KB output.
- "html": Raw HTML source. Use when you need DOM structure, tables, forms. ~50-500KB output.
- "screenshot": Base64 PNG screenshot. Use for visual content, charts, layouts. ~100-500KB output.
- "markdown": Text converted to markdown with preserved structure.

Use "text" for 90% of cases - it's token-efficient and LLM-friendly.`,
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to fetch' },
            mode: { 
              type: 'string', 
              enum: ['text', 'html', 'screenshot', 'markdown'],
              description: 'Output format (default: text)' 
            },
            waitFor: { 
              type: 'string', 
              description: 'CSS selector to wait for before extracting content (optional)' 
            },
            fullPage: { 
              type: 'boolean', 
              description: 'For screenshot mode: capture full page vs viewport (default: false)' 
            },
            viewport: {
              type: 'object',
              properties: {
                width: { type: 'number' },
                height: { type: 'number' }
              },
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
            mode: { 
              type: 'string', 
              enum: ['text', 'html', 'screenshot'],
              description: 'Output format after click (default: text)' 
            }
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
            mode: { 
              type: 'string', 
              enum: ['text', 'html', 'screenshot'],
              description: 'Output format after action (default: text)' 
            }
          },
          required: ['url', 'fields']
        }
      },
      {
        name: 'browser_evaluate',
        description: 'Execute JavaScript in the page context and return the result. Powerful for extracting structured data.',
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
            format: { 
              type: 'string', 
              enum: ['A4', 'Letter', 'Legal', 'Tabloid'],
              description: 'Page format (default: A4)' 
            },
            landscape: { type: 'boolean', description: 'Landscape orientation (default: false)' },
            printBackground: { type: 'boolean', description: 'Print background graphics (default: true)' }
          },
          required: ['url']
        }
      }
    ];
  }

  handlesTool(name) {
    return ['browser_fetch', 'browser_click', 'browser_fill', 'browser_evaluate', 'browser_pdf'].includes(name);
  }

  async callTool(name, args) {
    const handlers = {
      browser_fetch: (a) => this.fetch(a),
      browser_click: (a) => this.click(a),
      browser_fill: (a) => this.fill(a),
      browser_evaluate: (a) => this.evaluate(a),
      browser_pdf: (a) => this.pdf(a)
    };
    return handlers[name](args);
  }

  async withPage(fn, viewport) {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    this.activePages++;
    
    try {
      await this.configurePage(page, viewport);
      return await fn(page);
    } finally {
      this.activePages--;
      await page.close().catch(() => {});
    }
  }

  async configurePage(page, viewport) {
    await page.setViewport(viewport || this.defaultViewport);
    await page.setUserAgent(this.userAgent);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });
  }

  async fetch(args) {
    const { url, mode = 'text', waitFor, fullPage = false, viewport } = args;
    
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      
      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: this.timeout });
      }
      
      // Small delay for dynamic content
      await new Promise(r => setTimeout(r, 500));
      
      return await this.extractContent(page, url, mode, { fullPage });
    }, viewport);
  }

  async click(args) {
    const { url, selector, waitAfter = 1000, mode = 'text' } = args;
    
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      await page.waitForSelector(selector, { timeout: this.timeout });
      await page.click(selector);
      await new Promise(r => setTimeout(r, waitAfter));
      
      return await this.extractContent(page, url, mode);
    });
  }

  async fill(args) {
    const { url, fields, submit, waitAfter = 2000, mode = 'text' } = args;
    
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      
      for (const { selector, value } of fields) {
        await page.waitForSelector(selector, { timeout: this.timeout });
        await page.type(selector, value, { delay: 50 });
      }
      
      if (submit) {
        await page.click(submit);
        await new Promise(r => setTimeout(r, waitAfter));
      }
      
      return await this.extractContent(page, url, mode);
    });
  }

  async evaluate(args) {
    const { url, script, waitFor } = args;
    
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeout });
      
      if (waitFor) {
        await page.waitForSelector(waitFor, { timeout: this.timeout });
      }
      
      const result = await page.evaluate(script);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    });
  }

  async pdf(args) {
    const { url, format = 'A4', landscape = false, printBackground = true } = args;
    
    return this.withPage(async (page) => {
      await page.goto(url, { waitUntil: 'networkidle0', timeout: this.timeout });
      
      const pdfBuffer = await page.pdf({
        format,
        landscape,
        printBackground,
        margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }
      });
      
      return {
        content: [{
          type: 'text',
          text: `data:application/pdf;base64,${pdfBuffer.toString('base64')}`
        }]
      };
    });
  }

  async extractContent(page, url, mode, options = {}) {
    switch (mode) {
      case 'html':
        return this.extractHtml(page);
      case 'screenshot':
        return this.extractScreenshot(page, options);
      case 'markdown':
        return this.extractMarkdown(page, url);
      case 'text':
      default:
        return this.extractText(page, url);
    }
  }

  async extractHtml(page) {
    const html = await page.content();
    const truncated = html.substring(0, this.maxContentSize);
    
    return {
      content: [{
        type: 'text',
        text: truncated + (html.length > this.maxContentSize ? '\n\n[TRUNCATED]' : '')
      }]
    };
  }

  async extractScreenshot(page, options = {}) {
    const screenshot = await page.screenshot({
      fullPage: options.fullPage || false,
      type: 'png',
      encoding: 'base64'
    });
    
    return {
      content: [{
        type: 'image',
        data: screenshot,
        mimeType: 'image/png'
      }]
    };
  }

  async extractText(page, url) {
    const html = await page.content();
    
    try {
      const dom = new JSDOM(html, { url });
      const doc = dom.window.document;
      
      // Extract all links before Readability
      const links = [];
      doc.querySelectorAll('a[href]').forEach(a => {
        const href = a.href;
        const text = a.textContent.trim();
        if (href && text && !href.startsWith('javascript:') && !href.startsWith('#')) {
          links.push({ text: text.substring(0, 100), url: href });
        }
      });
      
      // Use Readability for main content
      const reader = new Readability(doc, {
        charThreshold: 200,
        nbTopCandidates: 5
      });
      const article = reader.parse();
      
      if (!article) {
        // Fallback: extract body text
        const bodyText = doc.body?.textContent?.replace(/\s+/g, ' ').trim() || '';
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              url,
              title: doc.title || null,
              description: doc.querySelector('meta[name="description"]')?.content || null,
              content: bodyText.substring(0, this.maxContentSize),
              links: links.slice(0, 50)
            }, null, 2)
          }]
        };
      }
      
      // Clean text content
      const contentDom = new JSDOM(article.content);
      const textContent = contentDom.window.document.body.textContent
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, this.maxContentSize);
      
      // Extract headings for structure
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
      return {
        content: [{
          type: 'text',
          text: `Error extracting content: ${err.message}`
        }],
        isError: true
      };
    }
  }

  async extractMarkdown(page, url) {
    const html = await page.content();
    
    try {
      const dom = new JSDOM(html, { url });
      const doc = dom.window.document;
      
      const reader = new Readability(doc, {
        charThreshold: 200,
        nbTopCandidates: 5
      });
      const article = reader.parse();
      
      if (!article) {
        return {
          content: [{
            type: 'text',
            text: `# ${doc.title || 'Untitled'}\n\n*Could not extract readable content from this page.*`
          }]
        };
      }
      
      // Convert article HTML to markdown
      const markdown = this.htmlToMarkdown(article.content, article.title);
      
      return {
        content: [{
          type: 'text',
          text: markdown.substring(0, this.maxContentSize)
        }]
      };
      
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `Error converting to markdown: ${err.message}`
        }],
        isError: true
      };
    }
  }

  htmlToMarkdown(html, title) {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    
    let md = title ? `# ${title}\n\n` : '';
    
    const convert = (node) => {
      if (node.nodeType === 3) { // Text node
        return node.textContent;
      }
      
      if (node.nodeType !== 1) return ''; // Not element
      
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
        case 'strong':
        case 'b': return `**${children}**`;
        case 'em':
        case 'i': return `*${children}*`;
        case 'code': return `\`${children}\``;
        case 'pre': return `\n\`\`\`\n${children.trim()}\n\`\`\`\n\n`;
        case 'a': 
          const href = node.getAttribute('href');
          return href ? `[${children}](${href})` : children;
        case 'img':
          const src = node.getAttribute('src');
          const alt = node.getAttribute('alt') || 'image';
          return src ? `![${alt}](${src})` : '';
        case 'ul':
          return `\n${children}\n`;
        case 'ol':
          return `\n${children}\n`;
        case 'li':
          const parent = node.parentNode?.tagName?.toLowerCase();
          const prefix = parent === 'ol' ? '1. ' : '- ';
          return `${prefix}${children.trim()}\n`;
        case 'blockquote':
          return children.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
        case 'hr': return '\n---\n\n';
        case 'table': return `\n${children}\n`;
        case 'tr': return `|${children}\n`;
        case 'th':
        case 'td': return ` ${children.trim()} |`;
        default:
          return children;
      }
    };
    
    md += convert(doc.body);
    
    // Clean up excessive newlines
    return md.replace(/\n{3,}/g, '\n\n').trim();
  }
}
