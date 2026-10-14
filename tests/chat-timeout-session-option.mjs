// Scratch verification: session-scoped timeoutMs for chat.create/chat.update.
// Fake gateway records the timeoutMs each send passes to GATEWAY.chat.
import assert from 'assert';
import fs from 'fs';
import { init, chat_create, chat_send, chat_update, chat_list } from '../src/agents/chat/index.js';

const TEST_DIR = 'data/_test/chat-timeout-test';
const gatewayCalls = [];
const gateway = {
    listModels: async () => [{ id: 'test-model' }],
    chat: async (opts) => {
        gatewayCalls.push(opts.timeoutMs);
        return { finish_reason: 'stop', content: 'ok' };
    }
};

await init({
    config: { agents: { chat: { dir: TEST_DIR } } },
    gateway,
    toolRouter: {
        methods: ['memory.recall'],
        description: '  memory.recall — { query* }',
        call: async (method, payload) => ({ content: [{ type: 'text', text: '{}' }], isError: false })
    }
});

try {
    // 1. create with timeoutMs → stored, echoed in return
    let r = await chat_create({ name: 'timeout-t1', model: 'test-model', timeoutMs: 600000 });
    assert.strictEqual(r.content[0] ? JSON.parse(r.content[0].text).timeoutMs : null, 600000, 'create returns timeoutMs');

    // 2. send uses the session timeout
    await chat_send({ name: 'timeout-t1', message: 'hi' });
    assert.strictEqual(gatewayCalls.at(-1), 600000, 'send passes session timeoutMs');

    // 3. update to a new value → next send uses it
    await chat_update({ name: 'timeout-t1', timeoutMs: 300000 });
    await chat_send({ name: 'timeout-t1', message: 'hi' });
    assert.strictEqual(gatewayCalls.at(-1), 300000, 'send passes updated timeoutMs');

    // 4. update null → reset to config default (120000)
    await chat_update({ name: 'timeout-t1', timeoutMs: null });
    await chat_send({ name: 'timeout-t1', message: 'hi' });
    assert.strictEqual(gatewayCalls.at(-1), 120000, 'null resets to config default');

    // 5. create without timeoutMs → config default
    await chat_create({ name: 'timeout-t2', model: 'test-model' });
    await chat_send({ name: 'timeout-t2', message: 'hi' });
    assert.strictEqual(gatewayCalls.at(-1), 120000, 'default send uses config 120000');

    // 6. validation: bad values throw
    for (const bad of ['600', -1, 0, Infinity]) {
        await assert.rejects(
            () => chat_create({ name: 'timeout-bad', model: 'test-model', timeoutMs: bad }),
            /timeoutMs must be a positive number/,
            `create rejects ${String(bad)}`
        );
        await assert.rejects(() => chat_update({ name: 'timeout-t2', timeoutMs: bad }), /timeoutMs must be a positive number/, `update rejects ${String(bad)}`);
    }

    // 7. update with no fields still throws
    await assert.rejects(() => chat_update({ name: 'timeout-t2' }), /at least one of systemPrompt, model, or timeoutMs/);

    // 8. legacy session without timeoutMs field → config default, chat.list shows null
    const legacyPath = `${TEST_DIR}/timeout-legacy.json`;
    fs.writeFileSync(legacyPath, JSON.stringify({
        name: 'timeout-legacy', model: 'test-model', systemPrompt: null,
        createdAt: 't', updatedAt: 't', messages: []
    }));
    await chat_send({ name: 'timeout-legacy', message: 'hi' });
    assert.strictEqual(gatewayCalls.at(-1), 120000, 'legacy session (no field) uses config default');
    const list = JSON.parse((await chat_list()).content[0].text);
    const byName = Object.fromEntries(list.sessions.map(s => [s.name, s.timeoutMs]));
    assert.deepStrictEqual(byName, { 'timeout-t1': null, 'timeout-t2': null, 'timeout-legacy': null }, 'chat.list exposes timeoutMs');

    console.log('ALL CHAT-TIMEOUT TESTS PASSED');
} finally {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
