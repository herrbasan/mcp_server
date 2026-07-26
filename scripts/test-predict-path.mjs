// Live test: does gateway.predict() (the VDB context enhancer path) work over SSE?
// Usage: node scripts/test-predict-path.mjs
import { readFileSync } from 'node:fs';
import { createGatewayClient } from '../src/gateway-client.js';

const env = readFileSync('D:/DEV/LLM Gateway/.env', 'utf8');
const key = env.split('\n').find(l => l.trim().startsWith('GATEWAY_ACCESS_KEY='))
    ?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
if (!key) { console.error('GATEWAY_ACCESS_KEY not found'); process.exit(1); }

const c = createGatewayClient('ws://ignored', 'http://localhost:3400', key);

// 1. predict() without responseFormat (plain text)
const text = await c.predict({ model: 'badkid-llama-chat', prompt: 'Reply with exactly: PREDICT_OK', maxTokens: 50 });
console.log('predict text OK:', JSON.stringify(text));

// 2. predict() with json_object format (exactly what the VDB context enhancer sends)
const meta = await c.predict({
    model: 'badkid-llama-chat',
    prompt: 'Produce JSON: {"summary": "a test file", "keywords": ["test", "predict"], "docType": "test"}',
    maxTokens: 200,
    responseFormat: { type: 'json_object' }
});
console.log('predict json_object type:', typeof meta);
console.log('predict json_object OK:', JSON.stringify(meta));
if (typeof meta !== 'object' || meta === null || !meta.summary) {
    console.error('FAIL: expected parsed object with summary field, got', typeof meta);
    process.exit(1);
}

console.log('PREDICT_PATH_PASS');
process.exit(0);
