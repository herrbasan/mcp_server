import assert from 'node:assert/strict';
import { embedGroupWithPersistence } from '../src/agents/vdb/embedding-persistence.js';

const group = [
    { docBaseId: 'storage:a.md', relPath: 'a.md', chunks: [{ text: 'a1' }, { text: 'a2' }] },
    { docBaseId: 'storage:b.md', relPath: 'b.md', chunks: [{ text: 'b1' }] },
    { docBaseId: 'storage:c.md', relPath: 'c.md', chunks: [{ text: 'c1' }] }
];
const vector = (n) => [n, n + 0.1];
let passed = 0;
function ok(condition, label) {
    assert.ok(condition, label);
    passed++;
    console.log(`  ok  ${label}`);
}

{
    const inserted = [];
    const embeddings = [vector(1), vector(2), vector(3), vector(4)];
    const result = await embedGroupWithPersistence(
        group,
        async (_texts, onBatch) => {
            onBatch(embeddings.slice(0, 2));
            onBatch(embeddings.slice(0, 3));
            return embeddings;
        },
        (prepared, vectors) => inserted.push({ id: prepared.docBaseId, vectors })
    );
    ok(inserted.map((x) => x.id).join(',') === 'storage:a.md,storage:b.md,storage:c.md', 'successful batches persist each file as soon as its chunks complete');
    ok(inserted[0].vectors.length === 2 && inserted[1].vectors.length === 1, 'per-file embedding slices retain chunk boundaries');
    ok(result.inserted.size === 3, 'successful group reports every file persisted');
}

{
    const inserted = [];
    const networkError = Object.assign(new Error('fetch failed'), { name: 'TypeError' });
    let caught;
    try {
        await embedGroupWithPersistence(
            group,
            async (_texts, onBatch) => {
                onBatch([vector(1), vector(2), vector(3)]);
                throw networkError;
            },
            (prepared) => inserted.push(prepared.docBaseId)
        );
    } catch (err) {
        caught = err;
    }
    ok(caught === networkError, 'late provider failure remains loud');
    ok(inserted.join(',') === 'storage:a.md,storage:b.md', 'late failure does not discard earlier completed files');
    ok(caught.persistedFiles.join(',') === 'storage:a.md,storage:b.md', 'failure reports exact persisted set for pending counts');
    ok(!inserted.includes('storage:c.md'), 'uncompleted file stays pending');
}

console.log(`\n${passed} passed`);
