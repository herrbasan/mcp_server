import assert from 'node:assert/strict';
import {
    llm_session_close,
    llm_session_create,
    llm_session_query,
    timeoutToMs
} from '../src/agents/llm/index.js';

let passed = 0;
function ok(condition, label) {
    assert.ok(condition, label);
    passed++;
    console.log(`  ok  ${label}`);
}

ok(timeoutToMs(300) === 300000 && timeoutToMs(0.5) === 500, 'timeout seconds convert to milliseconds');
ok(timeoutToMs(undefined) === null, 'omitted timeout preserves gateway default');
for (const invalid of [0, -1, 601, '300', Number.NaN]) {
    assert.throws(() => timeoutToMs(invalid), /timeout must be/);
}
ok(true, 'invalid, zero, negative, and over-600-second timeouts fail loudly');

const calls = [];
const context = {
    gateway: {
        listModels: async () => [{ id: 'fixture-chat' }],
        chat: async (args) => {
            calls.push(args);
            if (args.messages.at(-1).content === 'fail once') throw new Error('fixture timeout');
            return { content: 'fixture answer' };
        }
    }
};

const created = await llm_session_create({ model: 'fixture-chat', timeout: 300 }, context);
const sessionId = JSON.parse(created.content[0].text).sessionId;
await llm_session_query({ sessionId, prompt: 'session default' }, context);
ok(calls.at(-1).timeoutMs === 300000, 'session query uses session default timeout');
await llm_session_query({ sessionId, prompt: 'per call', timeout: 600 }, context);
ok(calls.at(-1).timeoutMs === 600000, 'per-call timeout overrides session default');

await assert.rejects(() => llm_session_query({ sessionId, prompt: 'must not run', timeout: 601 }, context), /timeout must be/);
ok(!calls.some((call) => call.messages.at(-1).content === 'must not run'), 'invalid timeout is rejected before model call or history mutation');

await assert.rejects(() => llm_session_query({ sessionId, prompt: 'fail once' }, context), /fixture timeout/);
await llm_session_query({ sessionId, prompt: 'after failure' }, context);
const replayed = calls.at(-1).messages.map((message) => message.content);
ok(!replayed.includes('fail once'), 'failed query is removed from replayed session history');
ok(replayed.includes('session default') && replayed.includes('per call') && replayed.includes('after failure'), 'successful turns remain in session history');
await llm_session_close({ sessionId }, context);

console.log(`\n${passed} passed`);
