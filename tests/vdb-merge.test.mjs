import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeCollectionResults } from '../src/agents/vdb/merge.js';

const row = (id, extra = {}) => ({ id, path: `${id}.md`, rrfScore: 0.05, rerankScore: null, ...extra });

const coll = (collection, rows, { rejected = false, bestRerankScore = 1 } = {}) =>
    ({ collection, rows, rejected, bestRerankScore });

const order = rows => rows.map(r => r.id);

test('single collection is returned verbatim without re-sorting', () => {
    const rows = [
        row('a', { rerankScore: 0.42, rrfScore: 0.01 }),
        row('b', { rerankScore: 0.99, rrfScore: 0.09 }),
        row('c', { rerankScore: 0.10, rrfScore: 0.05 }),
    ];
    const out = mergeCollectionResults([coll('storage', rows)], { topK: 2, rerankActive: true });
    assert.deepEqual(order(out), ['a', 'b']);
    assert.equal(out[0], rows[0]);
});

test('multi-collection merge never breaks intra-collection rank order (Agents_Prime regression)', () => {
    const storage = [
        row('Agents_Prime.md', { rerankScore: 0.8384, rrfScore: 0.0476 }),
        row('weak-lexical-hit.md', { rerankScore: 0.9912, rrfScore: 0.0410 }),
        row('third.md', { rerankScore: 0.5000, rrfScore: 0.0300 }),
    ];
    const memory = [
        row('memory/1044', { rerankScore: 0.9995, rrfScore: 0.0500 }),
        row('memory/863', { rerankScore: 0.9991, rrfScore: 0.0480 }),
    ];
    const out = mergeCollectionResults([
        coll('storage', storage, { bestRerankScore: 0.9912 }),
        coll('memory', memory, { bestRerankScore: 0.9995 }),
    ], { topK: 5, rerankActive: true });

    const merged = order(out);
    const agentsAt = merged.indexOf('Agents_Prime.md');
    const weakAt = merged.indexOf('weak-lexical-hit.md');
    const thirdAt = merged.indexOf('third.md');
    assert.ok(agentsAt >= 0 && weakAt >= 0 && thirdAt >= 0, `all storage rows must survive: ${merged}`);
    assert.ok(agentsAt < weakAt, `storage rank 1 must stay above its rank 2 (${merged})`);
    assert.ok(weakAt < thirdAt, `storage rank 2 must stay above its rank 3 (${merged})`);
});

test('rejected collection is dropped when another collection has accepted hits', () => {
    const storage = [row('storage/noise-1'), row('storage/noise-2')];
    const memory = [row('memory/1681', { rerankScore: 0.1573 })];
    const out = mergeCollectionResults([
        coll('storage', storage, { rejected: true, bestRerankScore: 0.0078 }),
        coll('memory', memory, { bestRerankScore: 0.1573 }),
    ], { topK: 5, rerankActive: true });
    assert.deepEqual(order(out), ['memory/1681']);
});

test('rejected collections are preserved when ALL collections were rejected', () => {
    const storage = [row('storage/a'), row('storage/b')];
    const memory = [row('memory/c')];
    const out = mergeCollectionResults([
        coll('storage', storage, { rejected: true, bestRerankScore: 0.0006 }),
        coll('memory', memory, { rejected: true, bestRerankScore: 0.0001 }),
    ], { topK: 5, rerankActive: true });
    assert.equal(out.length, 3);
    assert.deepEqual([...order(out)].sort(), ['memory/c', 'storage/a', 'storage/b']);
});

test('strong collection outranks weak collection across multiple top slots', () => {
    const strong = Array.from({ length: 6 }, (_, i) => row(`strong-${i + 1}`, { rerankScore: 0.95 - i * 0.01 }));
    const weak = Array.from({ length: 6 }, (_, i) => row(`weak-${i + 1}`, { rerankScore: 0.10 - i * 0.01 }));
    const out = mergeCollectionResults([
        coll('strong', strong, { bestRerankScore: 0.95 }),
        coll('weak', weak, { bestRerankScore: 0.10 }),
    ], { topK: 5, rerankActive: true });
    assert.deepEqual(order(out), ['strong-1', 'strong-2', 'strong-3', 'strong-4', 'strong-5']);
});

test('two equally strong collections interleave instead of one dominating', () => {
    const a = [row('a1', { rerankScore: 0.90 }), row('a2', { rerankScore: 0.50 })];
    const b = [row('b1', { rerankScore: 0.80 }), row('b2', { rerankScore: 0.40 })];
    const out = mergeCollectionResults([
        coll('a', a, { bestRerankScore: 0.90 }),
        coll('b', b, { bestRerankScore: 0.90 }),
    ], { topK: 4, rerankActive: true });
    assert.deepEqual(order(out), ['a1', 'b1', 'a2', 'b2']);
});

test('rerankActive false preserves intra-collection order', () => {
    const a = [
        row('a1', { rrfScore: 0.010 }),
        row('a2', { rrfScore: 0.090 }),
        row('a3', { rrfScore: 0.005 }),
    ];
    const b = [row('b1', { rrfScore: 0.050 })];
    const out = mergeCollectionResults([
        coll('a', a, { bestRerankScore: null }),
        coll('b', b, { bestRerankScore: null }),
    ], { topK: 4, rerankActive: false });
    const merged = order(out);
    assert.ok(merged.indexOf('a1') < merged.indexOf('a2'));
    assert.ok(merged.indexOf('a2') < merged.indexOf('a3'));
    assert.equal(merged[0], 'b1');
});

test('validation is fail-fast', () => {
    assert.throws(() => mergeCollectionResults(null, { topK: 5, rerankActive: true }), /must be an array/);
    assert.throws(() => mergeCollectionResults([], { topK: 0, rerankActive: true }), /topK/);
    assert.throws(() => mergeCollectionResults([], { topK: 1.5, rerankActive: true }), /topK/);
    assert.throws(() => mergeCollectionResults([{ collection: 'x' }], { topK: 5, rerankActive: true }), /rows must be an array/);
    assert.throws(() => mergeCollectionResults([], { topK: 5 }), /rerankActive/);
    assert.deepEqual(mergeCollectionResults([], { topK: 5, rerankActive: true }), []);
});
