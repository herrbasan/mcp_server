// Persistent browser pool with lingering tabs for realistic search behavior
import puppeteer from 'puppeteer';

const MIN_LINGER_MS = 10000;  // 10 seconds
const MAX_LINGER_MS = 30000;  // 30 seconds
const CLEANUP_INTERVAL_MS = 5000; // Check every 5 seconds

export class BrowserPool {
  constructor(options = {}) {
    this.browser = null;
    this.pages = []; // { page, usedAt, closing }
    this.userDataDir = options.userDataDir || null;
    this.headless = options.headless !== false; // Default true
    this.devtools = options.devtools || false;
    this.cleanupTimer = null;
  }

  async initialize() {
    if (this.browser) return; // Already initialized
    
    const launchOptions = {
      headless: this.headless,
      devtools: this.devtools,
      slowMo: 20,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null
    };

    if (this.userDataDir) {
      launchOptions.userDataDir = this.userDataDir;
    }

    this.browser = await puppeteer.launch(launchOptions);
    
    // Don't close default page - causes "Target closed" error
    // Just let it stay open or will be replaced by first search
    
    // Start cleanup task
    this.startCleanupTask();
  }

  async createPage() {
    if (!this.browser) await this.initialize();
    
    const page = await this.browser.newPage();
    
    // Random viewport
    await page.setViewport({
      width: 1280 + Math.floor(Math.random() * 200),
      height: 800 + Math.floor(Math.random() * 200)
    });
    
    // Realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const pageInfo = { page, usedAt: null, closing: false };
    this.pages.push(pageInfo);
    
    return pageInfo;
  }

  markUsed(pageInfo) {
    pageInfo.usedAt = Date.now();
  }

  startCleanupTask() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      
      for (const pageInfo of this.pages) {
        if (pageInfo.usedAt && !pageInfo.closing) {
          const age = now - pageInfo.usedAt;
          const lingerMs = MIN_LINGER_MS + Math.random() * (MAX_LINGER_MS - MIN_LINGER_MS);
          
          if (age > lingerMs) {
            pageInfo.closing = true;
            this.closePage(pageInfo);
          }
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  async closePage(pageInfo) {
    try {
      await pageInfo.page.close();
      this.pages = this.pages.filter(p => p !== pageInfo);
    } catch (e) {
      // Already closed
    }
  }

  async close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    if (this.browser) {
      // Give Chrome time to save session/cookies
      await new Promise(r => setTimeout(r, 3000));
      await this.browser.close();
      this.browser = null;
      this.pages = [];
    }
  }
}

// Singleton pool for shared use across search engines
let sharedPool = null;

export function getSharedPool(options = {}) {
  if (!sharedPool) {
    sharedPool = new BrowserPool(options);
  }
  return sharedPool;
}

export async function closeSharedPool() {
  if (sharedPool) {
    await sharedPool.close();
    sharedPool = null;
  }
}
