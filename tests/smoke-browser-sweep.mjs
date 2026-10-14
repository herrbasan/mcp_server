// Smoke: a fresh launch must sweep the tab pile the profile hands back.
//
// The pile is real, not hypothetical: Chrome records its open tabs as the last
// session when it is killed (exit_type Crashed) and restores them on the next
// launch. On 2026-10-14 a visible window came up with ~50 restored tabs, several
// of them search pages leaked by earlier research runs.
//
// This drives the real browser agent â€” the same init/getPage path the server
// uses â€” so it exercises the sweep inside src/agents/browser/index.js rather
// than a copy of it.
//
//   node tests/smoke-browser-sweep.mjs [--visible]
//
// --visible also exercises the headed launch path (pops a window on this
// machine) â€” that is the path that handed David ~50 restored tabs.
//
// Precondition: nothing listening on 9222. Init is connect-first, so a live
// instance is attached to instead of launched â€” and the sweep deliberately does
// not run on the connect path (those pages belong to whoever is running them).
import { init, shutdown, browser_session_create, browser_session_close } from '../src/agents/browser/index.js';

const CDP = 'http://localhost:9222';

async function pageUrls() {
    const list = await fetch(`${CDP}/json/list`).then(r => r.json());
    return list.filter(t => t.type === 'page').map(t => t.url);
}

// The usage monitor takes the shared profile for ~2 min every 10, so a launch
// test has to wait its cycle out rather than race it.
async function waitForFree(maxMs) {
    const deadline = Date.now() + maxMs;
    for (;;) {
        try {
            const busy = await pageUrls();
            if (Date.now() > deadline) {
                console.error(`FAIL: 9222 stayed busy (${busy.length} page targets) â€” a live Chrome holds the profile, and the sweep only runs on launch.`);
                process.exit(2);
            }
            await new Promise(r => setTimeout(r, 10000));
        } catch {
            return; // nothing listening: the launch path is armed
        }
    }
}

function assertSwept(urls, phase) {
    console.log(`page targets after ${phase}: ${urls.length}`);
    for (const url of urls) console.log(`  ${url.slice(0, 90)}`);
    // The keeper tab always survives (closing the last tab would quit a headed
    // Chrome), plus the page just opened.
    if (urls.length > 2) {
        console.error(`FAIL: ${phase} left ${urls.length} tabs, expected at most 2`);
        process.exit(1);
    }
    console.log(`OK: ${phase} left no leftovers beyond the keeper tab and ours\n`);
}

await waitForFree(4 * 60 * 1000);
console.log('9222 free â€” the launch path is armed\n');

const api = await init({ config: { agents: { storage: {} } } });
const { close } = await api.getPage();
assertSwept(await pageUrls(), 'headless launch');

await close();
await shutdown().catch(() => {});

if (process.argv.includes('--visible')) {
    console.log('--- visible (headed) launch ---');
    await waitForFree(4 * 60 * 1000);
    const session = await browser_session_create({ visible: true }, {});
    const { sessionId } = JSON.parse(session.content[0].text);
    assertSwept(await pageUrls(), 'visible launch');
    await browser_session_close({ sessionId }, {});
    console.log('visible session closed\n');
}

if (process.argv.includes('--idle')) {
    // The idle path sweeps before browser.close() so the tab pile is not
    // recorded as the profile's last session. Reaching it costs the real
    // BROWSER_IDLE_TIMEOUT (5 min) â€” this phase waits it out.
    console.log('--- idle-timeout sweep (waits out BROWSER_IDLE_TIMEOUT) ---');
    await waitForFree(4 * 60 * 1000);
    const idleApi = await init({ config: { agents: { storage: {} } } });
    const handle = await idleApi.getPage();
    await handle.close();
    // A fresh launch never arms the idle timer â€” resetBrowserIdleTimer() is only
    // reached from getBrowser()'s `if (browser)` branch â€” so real usage arms it
    // through markUsed(). Without this the timer never fires and the phase would
    // "fail" on nothing.
    handle.markUsed();
    // Opened over CDP directly, so the agent has never seen it â€” the same blind
    // spot a second connection in this process (the usage monitor) creates.
    await fetch(`${CDP}/json/new?https://example.com`, { method: 'PUT' }).then(r => r.json());
    console.log(`before idle: ${(await pageUrls()).length} page targets`);

    const deadline = Date.now() + 6 * 60 * 1000;
    let verdict = 'FAIL: browser still up and the foreign tab still open after 6 min';
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 15000));
        let urls;
        try { urls = await pageUrls(); } catch { verdict = 'OK: idle timeout closed the browser'; break; }
        if (!urls.includes('https://example.com/')) { verdict = 'OK: foreign tab swept at idle'; break; }
    }
    console.log(verdict);
    process.exit(verdict.startsWith('OK') ? 0 : 1);
}
