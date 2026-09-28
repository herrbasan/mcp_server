// Run research.topic against the real world: browser for search + scraping, the
// gateway for synthesis.
//
//   node tests/research-run.mjs "your query" [maxPages]
import dotenv from 'dotenv';
import { init as initBrowser, shutdown } from '../src/agents/browser/index.js';
import { research_topic } from '../src/agents/research/index.js';
import { createGatewayClient } from '../src/gateway-client.js';
import { createEmbedClient } from '../src/embed-client.js';

dotenv.config();

const [query, maxPagesArg] = process.argv.slice(2);
if (!query) {
    console.error('usage: node tests/research-run.mjs "query" [maxPages]');
    process.exit(2);
}
const maxPages = Number(maxPagesArg) || 5;

const accessKey = process.env.GATEWAY_ACCESS_KEY || null;
const gateway = createGatewayClient(
    process.env.GATEWAY_URL || 'ws://localhost:3400/v1/realtime',
    process.env.GATEWAY_HTTP_URL || 'http://localhost:3400',
    accessKey,
    createEmbedClient(process.env.EMBED_URL || 'http://localhost:3400', accessKey)
);

const browserApi = await initBrowser({ config: { agents: { storage: {} } } });

const context = {
    agents: new Map([['browser', browserApi]]),
    gateway,
    prompts: {},
    progress: (msg, pct) => console.log(`  [${String(pct).padStart(3)}%] ${msg}`)
};

const started = Date.now();
try {
    const r = await research_topic({ query, max_pages: maxPages }, context);
    console.log(`\n${'='.repeat(70)}\n`);
    console.log(r.content[0].text);
    if (r.isError) process.exitCode = 1;
} catch (e) {
    console.log(`FAILED: ${e.message}`);
    process.exitCode = 1;
} finally {
    console.log(`\nelapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
    await shutdown().catch(() => {});
}
