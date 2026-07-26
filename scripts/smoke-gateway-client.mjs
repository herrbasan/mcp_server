// Smoke test for the SSE-based gateway client against the running gateway.
// Usage: node scripts/smoke-gateway-client.mjs
import { readFileSync } from 'node:fs';
import { createGatewayClient } from '../src/gateway-client.js';

const env = readFileSync('D:/DEV/LLM Gateway/.env', 'utf8');
const key = env.split('\n').find(l => l.trim().startsWith('GATEWAY_ACCESS_KEY='))
    ?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
if (!key) { console.error('GATEWAY_ACCESS_KEY not found in gateway .env'); process.exit(1); }

const c = createGatewayClient('ws://ignored', 'http://localhost:3400', key);

const models = await c.listModels('chat');
console.log('listModels OK, count =', models.length);

const r = await c.chat({ model: 'badkid-llama-chat', messages: [{ role: 'user', content: 'Reply with exactly: PONG' }], maxTokens: 50 });
console.log('chat OK, cancelled =', r.cancelled, '| content =', JSON.stringify(r.content.slice(0, 60)));

let deltas = 0;
const r2 = await c.chat({ model: 'badkid-llama-chat', messages: [{ role: 'user', content: 'Count from 1 to 5, space separated.' }], maxTokens: 60, onDelta: () => deltas++ });
console.log('stream OK, deltas =', deltas, '| content =', JSON.stringify(r2.content.slice(0, 60)));

console.log('SMOKE_TEST_PASS');
process.exit(0);
