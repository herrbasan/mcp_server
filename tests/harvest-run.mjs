// Run harvest.collect against real URLs, with a throwaway storage root so a
// check never litters the real one.
//
//   node tests/harvest-run.mjs <url> [maxPages] [--intent "..."] [--deep] [--no-llm] [--keep]
//   node tests/harvest-run.mjs https://docs.astral.sh/uv/ 12 --intent "plugins and hooks"
//
// Uses the real LLM Gateway for the selecting model. --deep scores every
// candidate in batches instead of one call over the whole list. --no-llm forces
// heuristic selection. --keep leaves the storage root and prints its path.
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { init as initBrowser, shutdown } from '../src/agents/browser/index.js';
import { init as initHarvest, harvest_collect } from '../src/agents/harvest/index.js';
import { createGatewayClient } from '../src/gateway-client.js';
import { createEmbedClient } from '../src/embed-client.js';

// Same env the server uses — the gateway needs its access key.
dotenv.config();

const argv = process.argv.slice(2);
const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv.splice(i, 1)[0] && (argv.splice(i, 1)[0] ?? true);
};
const intent = flag('--intent');
const noLlm = argv.includes('--no-llm');
const deep = argv.includes('--deep');
const keep = argv.includes('--keep');
const rest = argv.filter(a => !a.startsWith('--'));
const [url, maxPagesArg] = rest;

if (!url) {
    console.error('usage: node tests/harvest-run.mjs <url> [maxPages] [--intent "..."] [--no-llm] [--keep]');
    process.exit(2);
}
const maxPages = Number(maxPagesArg) || 12;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-run-'));
const ctx = { config: { agents: { storage: { root, publicUrl: 'http://127.0.0.1:3100' } } } };

await initBrowser(ctx);
await initHarvest(ctx);
const BROWSER = await import('../src/agents/browser/index.js');

// Mirrors how the server builds it, so the task routing is the real one.
const accessKey = process.env.GATEWAY_ACCESS_KEY || null;
const gateway = noLlm ? null : createGatewayClient(
    process.env.GATEWAY_URL || 'ws://localhost:3400/v1/realtime',
    process.env.GATEWAY_HTTP_URL || 'http://localhost:3400',
    accessKey,
    // Required by the client even though harvesting never embeds.
    createEmbedClient(process.env.EMBED_URL || 'http://localhost:3400', accessKey)
);

const toolContext = { gateway, agents: new Map([['browser', await BROWSER.init(ctx)]]) };

console.log(`\nharvest ${url}  (max_pages ${maxPages}${intent ? `, intent "${intent}"` : ''}${noLlm ? ', selection heuristic' : deep ? ', selection deep' : ''})\n`);

const started = Date.now();
try {
    const r = await harvest_collect({
        url,
        max_pages: maxPages,
        intent: intent || undefined,
        select: noLlm ? 'heuristic' : deep ? 'deep' : 'auto'
    }, toolContext);
    console.log(r.content[0].text);
} catch (e) {
    console.log(`FAILED: ${e.message}`);
    process.exitCode = 1;
} finally {
    console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);

    const manifest = path.join(root, 'harvest');
    if (keep) {
        console.log(`storage kept at ${root}`);
    } else {
        // Show what was produced before discarding it — the shape is the point.
        const host = fs.existsSync(manifest) ? fs.readdirSync(manifest)[0] : null;
        if (host) {
            const files = fs.readdirSync(path.join(manifest, host)).filter(f => !f.startsWith('_'));
            console.log(`pages: ${files.length} file(s) under harvest/${host}/`);
            const idx = path.join(manifest, host, '_index.md');
            if (fs.existsSync(idx)) {
                const lines = fs.readFileSync(idx, 'utf8').split('\n');
                console.log('\n' + lines.slice(0, 12).join('\n'));
                const notFetched = lines.findIndex(l => l.startsWith('## Discovered but not fetched'));
                if (notFetched > 0) {
                    console.log(`\n... plus ${lines.length - notFetched} line(s) of not-fetched links:`);
                    console.log(lines.slice(notFetched, notFetched + 8).join('\n'));
                }
            }
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
    await shutdown().catch(() => {});
}
