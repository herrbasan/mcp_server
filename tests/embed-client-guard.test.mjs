import assert from 'node:assert/strict';
import { createEmbedClient } from '../src/embed-client.js';

// Mock the transport. No network: every call is answered from a scripted
// response object ({ status?, body }), and the request is recorded for
// assertions about url/headers/body/signal.
let scripted = null;
const requests = [];
globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    if (scripted instanceof Error) throw scripted;
    const { status = 200, body = null } = scripted;
    return {
        ok: status < 400,
        status,
        statusText: '',
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    };
};

function answer(body, status = 200) {
    scripted = { status, body };
}
function answerError(err) {
    scripted = err;
}
function reset() {
    scripted = null;
    requests.length = 0;
}

let passed = 0;
function ok(condition, label) {
    assert.ok(condition, label);
    passed++;
    console.log(`  ok  ${label}`);
}

async function rejects(fn, pattern, label) {
    let err;
    try {
        await fn();
    } catch (e) {
        err = e;
    }
    assert.ok(err, `${label} — expected a throw, none happened`);
    assert.match(err.message, pattern, `${label} — message was: ${err.message}`);
    passed++;
    console.log(`  ok  ${label}`);
    return err;
}

const V = {
    alpha: [0.11, 0.12, 0.13, 0.14],
    beta: [0.21, 0.22, 0.23, 0.24],
    gamma: [1.1, 1.2, 1.3, 1.4],
    e1: [2.1, 2.2, 2.3, 2.4],
    e2: [2.5, 2.6, 2.7, 2.8],
    e4: [2.9, 2.95, 2.99, 2.999],
    shared: [3.1, 3.2, 3.3, 3.4],
    r0: [4.1, 4.2, 4.3, 4.4],
    r1: [4.5, 4.6, 4.7, 4.8],
    i1: [5.1, 5.2, 5.3, 5.4],
    i2: [5.5, 5.6, 5.7, 5.8],
    wire: [6.1, 6.2, 6.3, 6.4]
};

const client = createEmbedClient('http://embed.test:8080/');

// ── 1. normal single embed ───────────────────────────────────────────────
{
    reset();
    answer({ data: [{ index: 0, embedding: V.alpha }] });
    const vector = await client.embed('alpha-text');
    ok(Array.isArray(vector) && vector.length === 4 && vector[0] === V.alpha[0], 'single embed returns the provider vector');
    ok(requests.length === 1 && requests[0].url === 'http://embed.test:8080/v1/embeddings', 'single embed posts to /v1/embeddings');
    ok(JSON.parse(requests[0].init.body).input === 'alpha-text', 'single embed body is { input: text }');
}

// Typed arrays are a valid vector shape.
{
    reset();
    const typed = Float32Array.from([0.5, 0.25, 0.125, 0.0625]);
    answer({ data: [{ embedding: typed }] });
    const vector = await client.embed('typed-text');
    ok(vector === typed, 'typed-array embedding is accepted and returned unchanged');
}

// ── 2. same text + same vector across separate calls is allowed ──────────
{
    reset();
    answer({ data: [{ index: 0, embedding: V.beta }] });
    const first = await client.embed('beta-text');
    answer({ data: [{ index: 0, embedding: V.beta }] });
    const second = await client.embed('beta-text');
    ok(first === V.beta && second === V.beta, 'identical vector for the identical input is allowed across calls');
}

// ── 3. different text, same vector, separate single calls → throws ───────
{
    reset();
    answer({ data: [{ index: 0, embedding: V.gamma }] });
    await client.embed('gamma-text');
    answer({ data: [{ index: 0, embedding: V.gamma }] });
    const err = await rejects(() => client.embed('delta-text'), /byte-identical embedding for a different input/, 'identical vector for a different input throws across single calls');
    ok(err.name === 'EmbeddingIntegrityError', 'duplicate-vector error carries the EmbeddingIntegrityError name');
    // VDB classifies retryable failures by name/message — this must not look like a network fault.
    ok(err.name !== 'TypeError' && err.name !== 'AbortError' && err.name !== 'TimeoutError', 'duplicate-vector error is not classified as a network error');
    ok(!/timed out|fetch failed|ECONNRESET|ECONNREFUSED/i.test(err.message), 'duplicate-vector message avoids network-retry keywords');
    ok(!err.message.includes('delta-text') && !err.message.includes('gamma-text'), 'duplicate-vector error never names input content');
    // The rejected mapping must not become the owner of that vector.
    answer({ data: [{ index: 0, embedding: V.gamma }] });
    await rejects(() => client.embed('delta-text'), /byte-identical embedding for a different input/, 'rejected input is not recorded as a valid vector owner');
    answer({ data: [{ index: 0, embedding: V.gamma }] });
    const stillOwner = await client.embed('gamma-text');
    ok(stillOwner === V.gamma, 'original input still owns its vector after a rejection');
}

// ── 4. duplicate across separate embedBatch calls → throws ───────────────
{
    reset();
    answer({ data: [{ index: 0, embedding: V.e1 }, { index: 1, embedding: V.e2 }] });
    const first = await client.embedBatch(['e1-text', 'e2-text']);
    ok(first.length === 2 && first[0] === V.e1, 'first batch returns its vectors');
    answer({ data: [{ index: 0, embedding: V.e1 }, { index: 1, embedding: V.e4 }] });
    await rejects(() => client.embedBatch(['e3-text', 'e4-text']), /embedBatch \(input 0 of 2\).*byte-identical embedding/, 'duplicate across separate embedBatch calls throws and names the input index');
}

// ── 5. within-batch duplicate → throws ───────────────────────────────────
{
    reset();
    answer({ data: [{ index: 0, embedding: V.shared }, { index: 1, embedding: V.shared }] });
    await rejects(() => client.embedBatch(['f1-text', 'f2-text']), /embedBatch \(input 1 of 2\).*byte-identical embedding/, 'within-batch duplicate throws');
}

// ── 6. degenerate vectors rejected ──────────────────────────────────────
{
    reset();
    answer({ data: [{ index: 0, embedding: [0, 0, 0, 0] }] });
    await rejects(() => client.embed('g1-text'), /zero norm/, 'zero-norm embedding rejected');

    answer({ data: [{ index: 0, embedding: [1, NaN, 1, 1] }] });
    await rejects(() => client.embed('g2-text'), /not a finite number/, 'NaN embedding rejected');

    answer({ data: [{ index: 0, embedding: [] }] });
    await rejects(() => client.embed('g3-text'), /embedding is empty/, 'empty embedding rejected');

    answer({ data: [{ index: 0, embedding: 'not-a-vector' }] });
    await rejects(() => client.embed('g4-text'), /not an array or typed array/, 'non-array embedding rejected');

    answer({ data: [{ index: 0, embedding: [1, 'x', 1, 1] }] });
    await rejects(() => client.embed('g5-text'), /not a finite number/, 'non-numeric embedding value rejected');

    answer({ data: [{ index: 0, embedding: [Infinity, 1, 1, 1] }] });
    await rejects(() => client.embed('g6-text'), /not a finite number/, 'infinite embedding value rejected');

    answer({ data: [{ index: 0, embedding: [Number.MAX_VALUE, Number.MAX_VALUE] }] });
    await rejects(() => client.embed('g7-text'), /non-finite norm/, 'finite dimensions with overflowing norm rejected');
}

// ── 7. wrong response count / shape rejected ─────────────────────────────
{
    reset();
    answer({ data: [{ index: 0, embedding: V.i1 }, { index: 1, embedding: V.i2 }] });
    await rejects(() => client.embed('c1-text'), /returned 2 items for a single input/, 'single embed rejects a multi-item response');

    answer({ data: [] });
    await rejects(() => client.embed('c2-text'), /returned 0 items for a single input/, 'single embed rejects an empty response');

    answer({});
    await rejects(() => client.embed('c3-text'), /no data array/, 'single embed rejects a body without data');

    answer({ data: [{ index: 0, embedding: V.i1 }] });
    await rejects(() => client.embedBatch(['c4-text', 'c5-text']), /expected 2 embeddings, got 1/, 'batch rejects a response with the wrong item count');

    answer({ data: 'nope' });
    await rejects(() => client.embedBatch(['c6-text', 'c7-text']), /no data array/, 'batch rejects a non-array data field');
}

// ── 8. responses are placed by index, not position ───────────────────────
{
    reset();
    answer({ data: [{ index: 1, embedding: V.r1 }, { index: 0, embedding: V.r0 }] });
    const out = await client.embedBatch(['r1-text', 'r2-text']);
    ok(out.length === 2, 'reversed response returns every vector');
    ok(out[0] === V.r0, 'reversed response: index 0 receives the index-0 vector');
    ok(out[1] === V.r1, 'reversed response: index 1 receives the index-1 vector');
}

// ── 9. bad indices rejected ─────────────────────────────────────────────
{
    reset();
    answer({ data: [{ index: 1, embedding: V.i1 }, { embedding: V.i2 }] });
    await rejects(() => client.embedBatch(['i1-text', 'i2-text']), /has no integer index/, 'missing index rejected');

    answer({ data: [{ index: 0, embedding: V.i1 }, { index: 0, embedding: V.i2 }] });
    await rejects(() => client.embedBatch(['i3-text', 'i4-text']), /repeats index 0/, 'duplicate index rejected');

    answer({ data: [{ index: 0, embedding: V.i1 }, { index: 2, embedding: V.i2 }] });
    await rejects(() => client.embedBatch(['i5-text', 'i6-text']), /out of range 0\.\.1/, 'out-of-range index rejected');

    answer({ data: [{ index: 0, embedding: V.i1 }, { index: 0.5, embedding: V.i2 }] });
    await rejects(() => client.embedBatch(['i7-text', 'i8-text']), /has no integer index/, 'non-integer index rejected');

    answer({ data: [{ index: 0, embedding: V.i1 }, { index: '1', embedding: V.i2 }] });
    await rejects(() => client.embedBatch(['i9-text', 'i10-text']), /has no integer index/, 'string index rejected');

    answer({ data: [{ index: 1, embedding: V.i1 }] });
    await rejects(() => client.embed('i11-text'), /expected 0/, 'single embed rejects a non-zero index');
}

// ── 10. transport path unchanged (url, headers, body, signal, HTTP errors) ──
{
    reset();
    const authorized = createEmbedClient('http://embed.test:8080///', 'secret-key');
    answer({ data: [{ index: 0, embedding: V.wire }] });
    await authorized.embed('wire-text');
    const req = requests[0];
    ok(req.url === 'http://embed.test:8080/v1/embeddings', 'trailing slashes are stripped from the base url');
    ok(req.init.method === 'POST', 'request uses POST');
    ok(req.init.headers['Content-Type'] === 'application/json', 'request keeps the JSON content type');
    ok(req.init.headers['Authorization'] === 'Bearer secret-key', 'access key becomes a bearer authorization header');
    ok(req.init.signal instanceof AbortSignal, 'request carries an abort signal (timeout path intact)');
    ok(req.init.signal.aborted === false, 'signal is not aborted before the response arrives');
    ok(JSON.parse(req.init.body).input === 'wire-text', 'request body stays { input: text }');

    reset();
    const anonymous = createEmbedClient('http://embed.test:8080');
    answer({ data: [{ index: 0, embedding: [7.1, 7.2, 7.3, 7.4] }] });
    await anonymous.embed('anonymous-text');
    ok(!('Authorization' in requests[0].init.headers), 'no authorization header without an access key');

    reset();
    answer('boom', 500);
    await rejects(() => anonymous.embed('http-error-text'), /HTTP 500: boom/, 'non-ok HTTP response fails loud');

    reset();
    answerError(Object.assign(new Error('fetch failed'), { name: 'TypeError' }));
    await rejects(() => anonymous.embed('network-error-text'), /fetch failed/, 'transport failures propagate unchanged');
}

// ── 11. bounded LRU history ─────────────────────────────────────────────
// 4097 distinct vector->input pairs push the very first mapping out of the
// 4096-entry window (earlier tests' entries are evicted first).
{
    const limitTexts = [];
    for (let i = 0; i <= 4096; i++) limitTexts.push(`lru-${i}`);
    const lruVector = (i) => [i + 0.5, 0.25, 0.5, 0.75];

    for (let i = 0; i <= 4096; i++) {
        reset();
        answer({ data: [{ index: 0, embedding: lruVector(i) }] });
        await client.embed(limitTexts[i]);
    }
    ok(true, '4097 distinct vector/input pairs accepted (history is bounded, not unbounded-failing)');

    reset();
    answer({ data: [{ index: 0, embedding: lruVector(4096) }] });
    await rejects(() => client.embed('lru-4096-alias'), /byte-identical embedding/, 'the newest mapping is still remembered');

    reset();
    answer({ data: [{ index: 0, embedding: lruVector(1) }] });
    await rejects(() => client.embed('lru-1-alias'), /byte-identical embedding/, 'a recent mapping inside the window is still remembered');

    reset();
    answer({ data: [{ index: 0, embedding: lruVector(0) }] });
    const evicted = await client.embed('lru-0-alias');
    ok(evicted[0] === 0.5, 'the oldest mapping was evicted, so its vector can be reused for another input');
}

console.log(`\n${passed} passed`);
