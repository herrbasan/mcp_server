// Stored-index embedding collision guards.
//
// The process-local guard in embed-client.js (tests/embed-client-guard.test.mjs)
// only knows vectors THIS process has seen. A fresh vector that is byte-identical
// to one an earlier process STORED for different text slips straight through it.
// These guards close that gap: vectorHash -> { docId -> inputHash } built from the
// live index, asserted before every insert.
//
// Fixtures are tiny and local: a fake nVDB collection, real nDB in a temp file,
// real temp source files for the chunk reconstruction. No live/lab databases.
//
// Run: node tests/stored-vector-guard.test.mjs

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createStoredVectorGuard, hashInput, hashVector, EmbeddingIntegrityError } from '../src/embed-client.js';
import { formatContextHeader } from '../src/agents/vdb/context-enhancer.js';
import {
    buildChunkVectorGuard,
    assertPreparedChunkVectors,
    insertPreparedVectors,
    releaseDocumentVectors,
    storedChunkInput
} from '../src/agents/vdb/index.js';
import {
    init as memoryInit,
    memory_forget,
    memory_store,
    buildMemoryVectorGuard,
    insertMemoryVector,
    memoryVectorInput
} from '../src/agents/memory/index.js';
import { loadNdb } from '../src/agents/memory/ndb-loader.js';

let passed = 0;
function ok(condition, label) {
    assert.ok(condition, label);
    passed++;
    console.log(`  ok  ${label}`);
}

function throws(fn, pattern, label, expectedName = 'EmbeddingIntegrityError') {
    let err;
    try {
        fn();
    } catch (e) {
        err = e;
    }
    assert.ok(err, `${label} — expected a throw, none happened`);
    assert.match(err.message, pattern, `${label} — message was: ${err.message}`);
    if (expectedName) assert.equal(err.name, expectedName, `${label} — error name was ${err.name}`);
    passed++;
    console.log(`  ok  ${label}`);
    return err;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-vector-guard-'));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Fake nVDB collection: only the four calls the guards touch.
function makeCollection(seed = []) {
    const docs = new Map();
    const inserted = [];
    const coll = {
        docs,
        inserted,
        get(id) { return docs.get(id) ?? null; },
        insert(id, vector, payload) {
            docs.set(id, { id, vector: Array.from(vector), payload });
            inserted.push(id);
        },
        delete(id) { const had = docs.delete(id); return had; },
        flush() {}
    };
    for (const [id, vector, payload] of seed) coll.insert(id, vector, payload);
    inserted.length = 0;
    return coll;
}

const V = {
    a: [0.11, 0.12, 0.13, 0.14],
    b: [0.21, 0.22, 0.23, 0.24],
    c: [0.31, 0.32, 0.33, 0.34],
    d: [0.41, 0.42, 0.43, 0.44],
    e: [0.51, 0.52, 0.53, 0.54],
    f: [0.61, 0.62, 0.63, 0.64]
};

// ── 1. guard core ────────────────────────────────────────────────────────
console.log('\nguard core');

{
    const guard = createStoredVectorGuard('core');
    // This is exactly what the OLD implementation did: nothing stored is known,
    // so a reused vector for new text is accepted.
    guard.assert('doc-new', V.a, 'entirely different text', 'old-equivalent');
    ok(true, 'a guard with no stored record accepts a fresh vector (old behaviour, reproduced)');
}

{
    const guard = createStoredVectorGuard('core');
    guard.register('doc-1', V.a, 'stored text A');

    const err = throws(
        () => guard.assert('doc-2', V.a, 'fresh text B'),
        /already stored for a different input \(doc doc-1\)/,
        'stored vector reused for a different input is rejected'
    );
    ok(!err.message.includes('stored text A') && !err.message.includes('fresh text B'), 'rejection names the owning doc, never the input text');
    ok(err instanceof EmbeddingIntegrityError, 'rejection is an EmbeddingIntegrityError');

    // Identical input — same doc, or a second doc with the same text (duplicate
    // memories, repeated chunk text) — is legitimate.
    guard.assert('doc-1', V.a, 'stored text A', 'same doc, same input');
    guard.assert('doc-dup', V.a, 'stored text A', 'other doc, same input');
    ok(true, 'identical input is allowed for the same and for another doc');
}

{
    // Same-id replacement through the ASSERT path (not just register): the
    // candidate's own record must not be treated as a collision.
    const guard = createStoredVectorGuard('core');
    guard.register('doc-1', V.a, 'text one');
    guard.assert('doc-1', V.a, 'text two — only changed past the embed cap', 'same id, changed input');
    ok(true, 'assert does not reject a candidate against its own stored record');
    throws(() => guard.assert('doc-2', V.a, 'text two — only changed past the embed cap'), /already stored for a different input \(doc doc-1\)/, 'another owner of the same vector is still rejected');
    throws(
        () => guard.assertMany([
            { id: 'doc-1', vector: V.b, input: 'batch one' },
            { id: 'doc-1', vector: V.b, input: 'batch two' }
        ]),
        /two different inputs in this batch embed to the same vector/,
        'staged batch duplicates are still rejected'
    );
}

{
    // Same-id replacement: an entity re-embedded with a new vector and new text.
    const guard = createStoredVectorGuard('core');
    guard.register('doc-1', V.a, 'text one');
    guard.register('doc-1', V.b, 'text two');
    guard.assert('doc-1', V.b, 'text two', 'replacement');
    ok(guard.size() === 1 && guard.vectorCount() === 1, 'replacing a doc detaches its previous vector record');

    guard.assert('doc-other', V.a, 'unrelated text', 'released vector');
    ok(true, 'the replaced (old) vector is free for another input — same-id replacement is allowed');
    throws(() => guard.assert('doc-other', V.b, 'unrelated text'), /already stored for a different input \(doc doc-1\)/, 'the new vector still belongs to its input');
}

{
    const guard = createStoredVectorGuard('core');
    guard.register('doc-1', V.a, 'text one');
    guard.remove('doc-1');
    ok(guard.size() === 0, 'remove drops the doc record');
    guard.assert('doc-2', V.a, 'different text', 'after remove');
    ok(true, 'a removed id releases its vector');
}

{
    // Lazy input hash: an explicit resolver must not run at build or on a
    // non-colliding candidate.
    let resolutions = 0;
    const guard = createStoredVectorGuard('core');
    guard.register('doc-1', V.a, () => { resolutions++; return 'lazy stored text'; });
    ok(resolutions === 0, 'registering with a resolver reads nothing');
    guard.assert('doc-2', V.c, 'unrelated text', 'no collision');
    ok(resolutions === 0, 'a candidate with an unseen vector never resolves existing inputs');
    guard.assert('doc-x', V.a, 'lazy stored text', 'collision, identical input');
    ok(resolutions === 1, 'a colliding vector resolves the existing input once');
    guard.assert('doc-y', V.a, 'lazy stored text', 'collision again');
    ok(resolutions === 1, 'the resolved input hash is cached on the record');
    throws(() => guard.assert('doc-z', V.a, 'other text'), /already stored for a different input/, 'the resolved record still guards the vector');
}

{
    // A resolver that cannot answer must fail loud, not silently drop the record.
    const guard = createStoredVectorGuard('core');
    guard.register('doc-1', V.a, () => { throw new Error('source file is missing'); });
    throws(() => guard.assert('doc-2', V.a, 'x'), /source file is missing/, 'a failing resolver surfaces as a loud error', null);
    throws(() => guard.assert('doc-2', V.a, 'x'), /source file is missing/, 'the record is not silently discarded after a resolver failure', null);
    // hashVector is what both the process-local and stored guards key on.
    ok(hashVector(V.a) === hashVector(Array.from(V.a)), 'vector hash is stable across array copies');
    ok(hashInput('x') !== hashInput('y'), 'input hash separates different inputs');
}

// ── 2. memory agent ─────────────────────────────────────────────────────
console.log('\nmemory');

{
    // buildMemoryVectorGuard over a tiny fake db: only active mem_ docs that
    // already have a stored vector are tracked; input hashes stay lazy.
    const docs = [
        { _id: 'mem_1', id: 1, description: 'stored A', embedStatus: 'embedded' },
        { _id: 'mem_2', id: 2, description: 'stored B', embedStatus: 'embedded' },
        { _id: 'mem_3', id: 3, description: 'never embedded', embedStatus: 'pending' },
        { _id: '_meta_0', nextId: 4 }
    ];
    const db = { iter: () => docs, get: (id) => docs.find((d) => d._id === id) };
    const coll = makeCollection([
        ['mem_1', V.a, JSON.stringify({ id: 1 })],
        ['mem_2', V.b, JSON.stringify({ id: 2 })]
    ]);
    const { guard, registered, missing } = buildMemoryVectorGuard({ db, coll, maxChars: 6000 });
    ok(registered === 2 && missing === 1, 'memory guard tracks every active memory with a stored vector');
    ok(guard.size() === 2, 'memory guard size mirrors the tracked memories');

    guard.assert('mem_9', V.d, 'unrelated text', 'mem candidate');
    ok(true, 'guard build never reads descriptions (no resolution without a collision)');

    // The resolver reads the CURRENT description, not a build-time snapshot.
    docs[0].description = 'stored A revised';
    throws(() => guard.assert('mem_9', V.a, 'stored A'), /already stored for a different input \(doc mem_1\)/, 'stored memory rejects a reused vector for different input');
    ok(true, 'the existing input is resolved from the memory current text');

    // insertMemoryVector: assert -> insert -> register.
    throws(
        () => insertMemoryVector({ coll, guard, ndbId: 'mem_9', memId: 9, input: 'unrelated text', vector: V.b }),
        /already stored for a different input \(doc mem_2\)/,
        'memory insert rejects a reused vector for a different input'
    );
    ok(coll.inserted.length === 0 && !coll.docs.has('mem_9'), 'a rejected memory embed never reaches the collection');

    insertMemoryVector({ coll, guard, ndbId: 'mem_9', memId: 9, input: 'unrelated text', vector: V.c });
    ok(coll.inserted.join(',') === 'mem_9' && guard.size() === 3, 'a clean memory embed inserts and is registered');
    throws(() => guard.assert('mem_10', V.c, 'yet another text'), /already stored for a different input \(doc mem_9\)/, 'the registered memory vector is guarded');
}

{
    // memory_update: the changed description embeds to the SAME vector because
    // the change sits past the 6000-char cap. The doc's own record must not
    // refuse it — the same-entity replacement path has to work before register
    // detaches the old record.
    const long = 'a'.repeat(6000);
    const docs = [{ _id: 'mem_1', id: 1, description: `${long} old tail` }];
    const db = { iter: () => docs, get: (id) => docs.find((d) => d._id === id) };
    const coll = makeCollection([['mem_1', V.a, JSON.stringify({ id: 1 })]]);
    const { guard } = buildMemoryVectorGuard({ db, coll, maxChars: 6000 });
    const oldInput = memoryVectorInput(`${long} old tail`, undefined, 6000);
    const newInput = memoryVectorInput(`${long} new tail`, undefined, 6000);
    ok(oldInput === newInput, 'a description change past the cap yields the same embedding input');
    insertMemoryVector({ coll, guard, ndbId: 'mem_1', memId: 1, input: newInput, vector: V.a });
    ok(true, 'an in-place memory update that legitimately reuses its own vector is accepted and re-registered');
    throws(() => guard.assert('mem_2', V.a, 'another memory'), /already stored for a different input \(doc mem_1\)/, 'the updated memory still owns the vector against other docs');
}

{
    // End-to-end through the real handlers: real nDB in a temp file, fake nVDB
    // collection holding vectors written by an "earlier process".
    const dbFile = path.join(tmpRoot, 'memory', 'data.jsonl');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const { Database } = loadNdb();
    const seed = Database.open(dbFile, { persistence: 'immediate' });
    seed.insertWithPrefix('_meta', { nextId: 3 });
    seed.insertWithPrefix('mem', { id: 1, description: 'stored A', category: 'notes', confidence: 0.5, timestamp: new Date().toISOString(), embedStatus: 'embedded' });
    seed.insertWithPrefix('mem', { id: 2, description: 'stored B', category: 'notes', confidence: 0.5, timestamp: new Date().toISOString(), embedStatus: 'embedded' });
    seed.flush();
    seed.close();

    const coll = makeCollection();
    // The seeded doc ids are nDB-generated, so read them back from the file.
    const reopen = Database.open(dbFile, { persistence: 'immediate' });
    const seeded = reopen.iter().filter((d) => d._id.startsWith('mem_'));
    const realA = seeded.find((d) => d.id === 1)._id;
    const realB = seeded.find((d) => d.id === 2)._id;
    reopen.close();
    coll.insert(realA, V.a, JSON.stringify({ id: 1 }));
    coll.insert(realB, V.b, JSON.stringify({ id: 2 }));

    let nextVector = null;
    const gateway = { embed: async () => nextVector };
    const state = await memoryInit({
        gateway,
        config: { agents: { memory: { dbPath: dbFile, maxMemoryChars: 6000 } } },
        agents: { get: () => ({ getCollection: () => coll, embeddingDim: 4 }) }
    });
    const settle = () => new Promise((r) => setImmediate(r));
    const docByDescription = (description) => state.memories.iter().find((d) => d.description === description);

    // Fresh vector identical to a STORED vector, different text → rejected.
    nextVector = V.a;
    await memory_store({ description: 'fresh C', category: 'notes' }, { gateway, progress: null });
    await settle();
    const freshC = docByDescription('fresh C');
    ok(freshC && freshC.embedStatus === 'pending', 'a colliding memory stays pending');
    ok(/already stored for a different input/.test(freshC.embedError), 'the collision is recorded on the pending memory');
    ok(!coll.docs.has(freshC._id) && !coll.inserted.includes(freshC._id), 'a colliding memory is never inserted into nVDB');

    // Identical input is legitimate.
    nextVector = V.a;
    await memory_store({ description: 'stored A', category: 'notes' }, { gateway, progress: null });
    await settle();
    const dupA = state.memories.iter().filter((d) => d.description === 'stored A').sort((a, b) => b.id - a.id)[0];
    ok(dupA.embedStatus === 'embedded', 'a memory whose text matches the stored input embeds fine');
    ok(coll.docs.has(dupA._id), 'the identical-input memory was inserted');

    // Forget releases the id, so its vector can belong to a different input.
    await memory_forget({ id: 2 }, { gateway, progress: null });
    ok(!state.memories.iter().some((d) => d.id === 2), 'memory_forget removed the document');
    nextVector = V.b;
    await memory_store({ description: 'fresh D', category: 'notes' }, { gateway, progress: null });
    await settle();
    const freshD = docByDescription('fresh D');
    ok(freshD.embedStatus === 'embedded' && coll.docs.has(freshD._id), 'a forgotten memory releases its vector for a new input');

    // …and the guard is not weakened by all of that.
    nextVector = V.a;
    await memory_store({ description: 'fresh E', category: 'notes' }, { gateway, progress: null });
    await settle();
    const freshE = docByDescription('fresh E');
    ok(freshE.embedStatus === 'pending' && !coll.docs.has(freshE._id), 'a tracked vector is still refused for a new input after the other operations');
}

// ── 3. VDB agent ────────────────────────────────────────────────────────
console.log('\nvdb');

const storageRoot = path.join(tmpRoot, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });
const chunk0 = '# Title\n\nfirst chunk body';
const chunk1 = 'second chunk body';
const fileText = `${chunk0}${chunk1}`;
const sourcePath = path.join(storageRoot, 'a.md');
fs.writeFileSync(sourcePath, fileText);
const fileHash = sha256(fileText);
const header = formatContextHeader({ docType: 'note', keywords: ['k1'], entities: ['e1'], summary: 'a summary' });

function chunkPayload(offset, len, isLastChunk) {
    return JSON.stringify({
        path: 'a.md',
        absolutePath: sourcePath,
        collection: 'storage',
        extension: '.md',
        splitIdx: 0,
        charOffset: offset,
        charLen: len,
        isLastChunk,
        tokEst: 10,
        contentHash: fileHash,
        summary: 'a summary',
        keywords: ['k1'],
        entities: ['e1'],
        docType: 'note',
        contextEnhanced: true
    });
}

const scanIndex = {
    files: {
        'storage:a.md': { collection: 'storage', path: 'a.md', absolutePath: sourcePath, contentHash: fileHash, chunks: 2 },
        'storage:alias.md': { collection: 'storage', path: 'alias.md', absolutePath: path.join(storageRoot, 'alias.md'), contentHash: fileHash, chunks: 0, duplicateOf: 'storage:a.md' },
        'memory:other': { collection: 'memory', path: 'other', absolutePath: 'x', contentHash: 'x', chunks: 1 }
    }
};
const storedColl = makeCollection([
    ['storage:a.md#0', V.a, chunkPayload(0, chunk0.length, false)],
    ['storage:a.md#1', V.b, chunkPayload(chunk0.length, chunk1.length, true)]
]);

const built = buildChunkVectorGuard({ collections: [{ name: 'storage', coll: storedColl, index: scanIndex }], storageRoot });
const vdbGuard = built.guard;
ok(built.registered === 2, 'chunk guard tracks every stored chunk of the scanned collection');
ok(built.missing === 0, 'no tracked chunk id was missing a stored vector');

// Lazy reconstruction: the input is rebuilt from the payload coordinates plus
// the same context header the enhancer applied.
{
    const rebuilt = storedChunkInput({ coll: storedColl, chunkId: 'storage:a.md#0', storageRoot });
    ok(rebuilt === `${header}${chunk0}`, 'the stored chunk input is reconstructed with payload coordinates and context header');
    vdbGuard.assert('storage:other.md#0', V.a, `${header}${chunk0}`, 'reconstructed identical input');
    ok(true, 'a candidate matching the reconstructed input is accepted');
    throws(() => vdbGuard.assert('storage:other.md#1', V.a, chunk0), /already stored for a different input \(doc storage:a\.md#0\)/, 'the same vector with the header-less text is rejected');
}

{
    // No read at build: removing the source afterwards still builds cleanly.
    fs.rmSync(sourcePath, { force: true });
    const lazyBuilt = buildChunkVectorGuard({ collections: [{ name: 'storage', coll: storedColl, index: scanIndex }], storageRoot });
    ok(lazyBuilt.registered === 2, 'the guard builds without reading any source file');
    lazyBuilt.guard.assert('storage:other.md#0', V.d, 'a text nobody stored', 'no collision, source gone');
    ok(true, 'a candidate whose vector is not stored needs no reconstruction');
    throws(() => lazyBuilt.guard.assert('storage:other.md#1', V.a, `${header}${chunk0}`), /source file is missing/, 'a collision that cannot be reconstructed fails loud', null);
    fs.writeFileSync(sourcePath, fileText);
}

{
    // A source that no longer matches the payload hash must not be guessed at.
    const driftedPath = path.join(storageRoot, 'drift.md');
    fs.writeFileSync(driftedPath, 'original body');
    const driftColl = makeCollection([['storage:drift.md', V.c, JSON.stringify({
        path: 'drift.md',
        absolutePath: driftedPath,
        collection: 'storage',
        charOffset: 0,
        charLen: 'original body'.length,
        contentHash: sha256('original body'),
        contextEnhanced: false
    })]]);
    const driftGuard = buildChunkVectorGuard({
        collections: [{ name: 'storage', coll: driftColl, index: { files: { 'storage:drift.md': { collection: 'storage', chunks: 1 } } } }],
        storageRoot
    }).guard;
    fs.writeFileSync(driftedPath, 'rewritten body');
    throws(() => driftGuard.assert('storage:other.md', V.c, 'anything'), /changed since it was indexed/, 'a drifted source is a loud failure, not a guess', null);
}

{
    // The configured storage root wins over payload.absolutePath: copied/lab
    // indexes carry absolute paths that no longer hold the indexed bytes.
    const rootCopy = path.join(storageRoot, 'nested', 'moved.md');
    fs.mkdirSync(path.dirname(rootCopy), { recursive: true });
    const rootBody = 'body under the configured root';
    fs.writeFileSync(rootCopy, rootBody);
    const stalePath = path.join(tmpRoot, 'stale-copy.md');
    const staleBody = 'body of a stale absolute path copy';
    fs.writeFileSync(stalePath, staleBody);

    const payload = JSON.stringify({
        path: 'nested/moved.md',
        absolutePath: stalePath,
        collection: 'storage',
        charOffset: 0,
        charLen: rootBody.length,
        contentHash: sha256(rootBody),
        contextEnhanced: false
    });
    const prefColl = makeCollection([['storage:nested/moved.md', V.d, payload]]);
    const prefIndex = { files: { 'storage:nested/moved.md': { collection: 'storage', chunks: 1 } } };
    const prefGuard = buildChunkVectorGuard({ collections: [{ name: 'storage', coll: prefColl, index: prefIndex }], storageRoot }).guard;

    ok(
        storedChunkInput({ coll: prefColl, chunkId: 'storage:nested/moved.md', storageRoot }) === rootBody,
        'the stored input is rebuilt from payload.path under the configured storage root'
    );
    prefGuard.assert('storage:elsewhere.md', V.d, rootBody, 'root content');
    ok(true, 'the root-derived input is accepted while a different-content absolute path exists');
    throws(
        () => prefGuard.assert('storage:elsewhere.md#1', V.d, staleBody),
        /already stored for a different input/,
        'the stale absolute-path content is not what the stored vector belongs to'
    );

    // Root gone, stale absolute path left behind: the contentHash check refuses
    // to pretend it has the indexed bytes.
    fs.rmSync(rootCopy, { force: true });
    const fallbackGuard = buildChunkVectorGuard({ collections: [{ name: 'storage', coll: prefColl, index: prefIndex }], storageRoot }).guard;
    throws(
        () => fallbackGuard.assert('storage:elsewhere.md#2', V.d, staleBody),
        /changed since it was indexed/,
        'a stale absolute path is never accepted as the indexed content',
        null
    );
    fs.writeFileSync(rootCopy, rootBody);
}

function preparedFile(chunks, { docBaseId = 'storage:b.md', relPath = 'b.md' } = {}) {
    return {
        docBaseId,
        collectionName: 'storage',
        relPath,
        absolutePath: path.join(storageRoot, relPath),
        contentHash: sha256(chunks.join('')),
        extension: '.md',
        metadata: {},
        chunks: chunks.map((text, i) => ({
            docId: chunks.length === 1 ? docBaseId : `${docBaseId}#${i}`,
            text,
            splitIdx: i,
            charOffset: 0,
            charLen: text.length,
            isLastChunk: i === chunks.length - 1,
            tokEst: 1
        }))
    };
}

{
    // No insert when any chunk collides.
    const coll = makeCollection([
        ['storage:a.md#0', V.a, chunkPayload(0, chunk0.length, false)]
    ]);
    const prepared = preparedFile(['clean chunk', 'new chunk']);
    throws(
        () => insertPreparedVectors({ coll, guard: vdbGuard, prepared, embeddings: [V.d, V.a] }),
        /VDB storage:b\.md chunk 1: vector .* already stored for a different input/,
        'a colliding chunk rejects the whole file'
    );
    ok(coll.inserted.length === 0 && coll.docs.size === 1, 'no chunk of a colliding file is inserted');
    ok(vdbGuard.size() === 2, 'a rejected file registers nothing');
}

{
    // Two different inputs in one file that embed identically: rejected before insert.
    const coll = makeCollection();
    const prepared = preparedFile(['first distinct chunk', 'second distinct chunk']);
    throws(
        () => insertPreparedVectors({ coll, guard: vdbGuard, prepared, embeddings: [V.e, V.e] }),
        /two different inputs in this batch embed to the same vector/,
        'identical vectors for different chunks in one file are rejected'
    );
    ok(coll.inserted.length === 0, 'the within-file duplicate inserts nothing');
}

{
    // Legitimate repeated chunk text, plus registration after insert.
    const coll = makeCollection();
    const prepared = preparedFile(['repeated text', 'repeated text']);
    insertPreparedVectors({ coll, guard: vdbGuard, prepared, embeddings: [V.f, V.f] });
    ok(coll.inserted.length === 2 && vdbGuard.size() === 4, 'repeated identical chunk text is inserted and registered per chunk');
    throws(() => vdbGuard.assert('storage:c.md#0', V.f, 'a different text'), /already stored for a different input/, 'the newly inserted chunk vectors are guarded');
}

{
    // Update/delete release, and same-file re-insertion is not a self-collision.
    const coll = makeCollection();
    const guard = createStoredVectorGuard('vdb-test');
    const first = preparedFile(['one', 'two'], { docBaseId: 'storage:up.md' });
    insertPreparedVectors({ coll, guard, prepared: first, embeddings: [V.a, V.b] });
    ok(guard.size() === 2, 'the file register both chunk ids');

    // update path: deleteExistingChunks releases, then the re-insert may reuse
    // the same vector for the same text (and for a rewritten text).
    releaseDocumentVectors(guard, 'storage:up.md', 2);
    ok(guard.size() === 0, 'releaseDocumentVectors drops every chunk id of the file');
    insertPreparedVectors({ coll, guard, prepared: first, embeddings: [V.a, V.b] });
    ok(true, 're-inserting the same file after release is not a self-collision');

    // same chunk id, new vector, same text → replacement, no false positive.
    insertPreparedVectors({ coll, guard, prepared: preparedFile(['one', 'two'], { docBaseId: 'storage:up.md' }), embeddings: [V.c, V.d] });
    ok(guard.size() === 2, 'replacement keeps one record per chunk id');
    guard.assert('storage:other.md#0', V.a, 'unrelated', 'released old vector');
    ok(true, 'the replaced chunk vectors are released for other inputs');

    // delete path releases the whole document.
    releaseDocumentVectors(guard, 'storage:up.md', 2);
    guard.assert('storage:other.md#1', V.c, 'unrelated again', 'released on delete');
    ok(true, 'deleting a document releases all of its chunk vectors');
}

{
    // Old-vs-new: the old shape accepted this candidate; the guard does not.
    const legacy = createStoredVectorGuard('legacy-sim');
    legacy.assert('storage:new.md#0', V.a, `${header}${chunk0} changed`, 'legacy');
    ok(true, 'the old (no stored knowledge) shape accepts a reused vector for new text');
    throws(
        () => vdbGuard.assert('storage:new.md#0', V.a, `${header}${chunk0} changed`),
        /already stored for a different input \(doc storage:a\.md#0\)/,
        'the stored-index guard rejects the same candidate'
    );
}

// ── 4. startup cost (informational) ─────────────────────────────────────
{
    const vec = Array.from({ length: 2560 }, (_, i) => (i % 97) / 97 + 0.001);
    const n = 2000;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) hashVector(vec);
    const perVectorMs = Number(process.hrtime.bigint() - t0) / 1e6 / n;
    console.log(`\nhashVector(2560 dims): ${perVectorMs.toFixed(3)}ms/vector → ~${(perVectorMs * 50).toFixed(2)}s for 50k tracked chunk vectors`);
    ok(perVectorMs < 5, 'vector hashing is cheap enough to hash the whole index at startup');
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} passed`);
