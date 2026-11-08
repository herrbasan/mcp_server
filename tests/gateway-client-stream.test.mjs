import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayClient } from '../src/gateway-client.js';

function sseResponse(chunks) {
    const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
        }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('streaming chat assembles tool-call fragments and preserves upstream usage', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'workshop', arguments: '' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"method"' } }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"memory.recall"}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 0, total_tokens: 120 } }
    ]);
    try {
        const client = createGatewayClient(null, 'http://gateway.invalid', 'test-key', {});
        const result = await client.chat({
            model: 'grok-chat',
            messages: [{ role: 'user', content: 'call the tool' }],
            stream: true,
            tools: [{ type: 'function', function: { name: 'workshop', parameters: { type: 'object' } } }]
        });
        assert.equal(result.finish_reason, 'tool_calls');
        assert.deepEqual(result.tool_calls, [{
            id: 'call_1',
            type: 'function',
            function: { name: 'workshop', arguments: '{"method":"memory.recall"}' }
        }]);
        assert.equal(result.usage.completion_tokens, 20);
    } finally {
        globalThis.fetch = realFetch;
    }
});
