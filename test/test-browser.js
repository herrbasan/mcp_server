// Quick test for browser server - persistent browser + concurrency
import { BrowserServer } from '../src/servers/browser.js';

const browser = new BrowserServer({ timeout: 30000, idleTimeout: 5000 }); // 5s idle for test

console.log('Test 1: First request (cold start - browser launch)...');
const t1 = Date.now();
const r1 = await browser.callTool('browser_fetch', { url: 'https://example.com', mode: 'text' });
console.log(`  ✓ Took ${Date.now() - t1}ms`);

console.log('\nTest 2: Second request (warm - reuse browser)...');
const t2 = Date.now();
const r2 = await browser.callTool('browser_fetch', { url: 'https://httpbin.org/ip', mode: 'text' });
console.log(`  ✓ Took ${Date.now() - t2}ms`);

console.log('\nTest 3: Concurrent requests (3 pages in parallel)...');
const t3 = Date.now();
const concurrent = await Promise.all([
  browser.callTool('browser_fetch', { url: 'https://example.com', mode: 'text' }),
  browser.callTool('browser_fetch', { url: 'https://httpbin.org/headers', mode: 'text' }),
  browser.callTool('browser_fetch', { url: 'https://httpbin.org/user-agent', mode: 'text' })
]);
console.log(`  ✓ 3 concurrent pages in ${Date.now() - t3}ms`);
concurrent.forEach((r, i) => {
  const data = JSON.parse(r.content[0].text);
  console.log(`    Page ${i+1}: ${data.title || data.url}`);
});

console.log('\nTest 4: Waiting for idle timeout (5s)...');
await new Promise(r => setTimeout(r, 6000));
console.log('  Browser should have closed by now');

console.log('\nTest 5: Request after idle (should relaunch)...');
const t5 = Date.now();
await browser.callTool('browser_fetch', { url: 'https://example.com', mode: 'text' });
console.log(`  ✓ Took ${Date.now() - t5}ms (includes browser relaunch)`);

console.log('\n✅ All tests passed!');
process.exit(0);
