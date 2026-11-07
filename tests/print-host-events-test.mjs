import assert from 'node:assert/strict';
import { resolveHostedParent } from '../src/agents/print/host-events.js';

const allowed = ['http://localhost:8080', 'http://192.168.0.100:8080'];
const valid = 'hostInstanceId=app_12345678-1234-1234-1234-123456789abc&parentOrigin=http%3A%2F%2Flocalhost%3A8080';

assert.deepEqual(resolveHostedParent(valid, allowed), {
    instance: 'app_12345678-1234-1234-1234-123456789abc',
    parentOrigin: 'http://localhost:8080'
});
assert.equal(resolveHostedParent('', allowed), null);
assert.equal(resolveHostedParent('hostInstanceId=short&parentOrigin=http%3A%2F%2Flocalhost%3A8080', allowed), null);
assert.equal(resolveHostedParent(valid.replace('localhost%3A8080', 'example.com'), allowed), null);
assert.equal(resolveHostedParent(valid.replace('http%3A%2F%2Flocalhost%3A8080', 'https%3A%2F%2Flocalhost%3A8080%2Fpath'), allowed), null);
assert.equal(resolveHostedParent(valid.replace('http%3A%2F%2Flocalhost%3A8080', 'javascript%3Aalert(1)'), allowed), null);
assert.equal(resolveHostedParent(valid, []), null);

console.log('print host-event origin checks passed');
