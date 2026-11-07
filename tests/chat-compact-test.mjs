// Regression for #63: chat.compact strategy "clear" (default keep 0) returned
// ok with the old counts and left every message in place. Cause: slice(-0) is
// slice(0), so "keep the last 0" kept everything. truncate shared the bug.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { init, chat_create, chat_inject, chat_compact, chat_list } from '../src/agents/chat/index.js';

const TEST_DIR = 'data/_test/chat-compact-test';
const read = (response) => JSON.parse(response.content[0].text);
const onDisk = (name) => JSON.parse(fs.readFileSync(path.join(TEST_DIR, `${name}.json`), 'utf8'));

await init({
    config: { agents: { chat: { dir: TEST_DIR } } },
    gateway: {
        listModels: async () => [{ id: 'test-model' }],
        chat: async () => ({ content: 'ok' })
    },
    toolRouter: {
        methods: [],
        description: '',
        call: async () => ({ content: [{ type: 'text', text: '{}' }], isError: false })
    }
});

const fill = async (name) => {
    await chat_create({ name, model: 'test-model' });
    await chat_inject({ name, messages: [
        { role: 'user', content: 'frage eins' },
        { role: 'assistant', content: 'antwort eins' },
        { role: 'user', content: 'frage zwei' },
        { role: 'assistant', content: 'antwort zwei' }
    ] });
};

try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });

    await fill('clear-default');
    assert.strictEqual(onDisk('clear-default').messages.length, 4, 'four messages before clear');
    const cleared = read(await chat_compact({ name: 'clear-default', strategy: 'clear' }));
    assert.strictEqual(cleared.messageCount, 0, 'clear (default keep 0) reports an empty history');
    assert.strictEqual(onDisk('clear-default').messages.length, 0, 'clear persists the empty history');
    assert.strictEqual(cleared.historyBytes, Buffer.byteLength('[]', 'utf8'), 'clear reports the real byte size');

    await fill('clear-keep');
    const kept = read(await chat_compact({ name: 'clear-keep', strategy: 'clear', keep: 2 }));
    assert.strictEqual(kept.messageCount, 2, 'clear keep:2 leaves two messages');
    assert.deepStrictEqual(onDisk('clear-keep').messages.map((m) => m.content), ['frage zwei', 'antwort zwei'], 'clear keep:2 keeps the newest messages');

    await fill('truncate-zero');
    const truncated = read(await chat_compact({ name: 'truncate-zero', strategy: 'truncate', keep: 0 }));
    assert.strictEqual(truncated.messageCount, 0, 'truncate keep:0 empties the history too');

    await fill('truncate-one');
    assert.strictEqual(read(await chat_compact({ name: 'truncate-one', strategy: 'truncate', keep: 1 })).messageCount, 1, 'truncate keep:1 leaves one message');

    await chat_create({ name: 'clear-empty', model: 'test-model' });
    assert.strictEqual(read(await chat_compact({ name: 'clear-empty', strategy: 'clear' })).messageCount, 0, 'clear on an empty session is a no-op, not an error');

    const list = read(await chat_list());
    const counts = Object.fromEntries(list.sessions.map((session) => [session.name, session.messageCount]));
    assert.deepStrictEqual(counts, { 'clear-default': 0, 'clear-keep': 2, 'truncate-zero': 0, 'truncate-one': 1, 'clear-empty': 0 }, 'chat.list agrees with the cleared state');

    console.log('ALL CHAT-COMPACT TESTS PASSED');
} finally {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
}
