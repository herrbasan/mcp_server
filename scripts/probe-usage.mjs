// Run usage providers outside the scheduler — the gate before a restart that
// loads new monitor code, and the fastest way to see the real error when one
// provider goes stale. Reads the usage profile only; writes nothing.
//
//   node scripts/probe-usage.mjs            # every provider
//   node scripts/probe-usage.mjs gemini     # just gemini
//   node scripts/probe-usage.mjs kimi zai   # several
//
// If the visible login window holds the usage profile, this attaches to it and
// opens its own tabs; otherwise it launches headless.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { PROFILES } from '../src/agents/usage-monitor/profiles.js';
import { init, shutdown, PROVIDERS } from '../src/agents/usage-monitor/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));

// --profile-dir overrides which Chrome profile inside the usage user-data-dir
// is read; the default is the one the monitor uses.
const dirFlag = process.argv.find(a => a.startsWith('--profile-dir='));
const chromeProfile = dirFlag ? dirFlag.slice('--profile-dir='.length) : PROFILES.usage.chromeProfile;

const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
const unknown = wanted.filter(n => !PROVIDERS.some(p => p.name === n));
if (unknown.length) throw new Error(`unknown provider(s): ${unknown.join(', ')} — known: ${PROVIDERS.map(p => p.name).join(', ')}`);
const list = wanted.length ? PROVIDERS.filter(p => wanted.includes(p.name)) : PROVIDERS;

// No scheduler — only the config the extractors read (geminiAccount).
await init({ config: { ...config, agents: { ...config.agents, 'usage-monitor': { ...config.agents['usage-monitor'], autoStart: false } } } });

let browser;
let owned = false;
try {
    for (const p of list) {
        try {
            let result;
            if (p.browser) {
                if (!browser) {
                    // Attach when a visible window holds the profile, so a probe
                    // never fights it for the lock.
                    try {
                        browser = await puppeteer.connect({ browserURL: `http://localhost:${PROFILES.usage.port}`, timeout: 3000 });
                    } catch {
                        browser = await puppeteer.launch({
                            headless: true,
                            args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
                                   `--profile-directory=${chromeProfile}`,
                                   `--remote-debugging-port=${PROFILES.usage.port}`, `--user-data-dir=${PROFILES.usage.dir}`]
                        });
                        owned = true;
                    }
                }
                const page = await browser.newPage();
                await page.setUserAgent((await browser.userAgent()).replace('Headless', ''));
                try { result = await p.fn(page); } finally { await page.close().catch(() => {}); }
            } else {
                result = await p.fn();
            }
            console.log(`OK   ${p.name}: ${JSON.stringify(result.windows)}`);
        } catch (err) {
            console.log(`FAIL ${p.name}: ${err.message}`);
            process.exitCode = 1;
        }
    }
} finally {
    if (browser) await (owned ? browser.close() : browser.disconnect()).catch(() => {});
    await shutdown();
}
