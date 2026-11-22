// nDB v2 cutover — end-to-end proof against a REAL `ndb serve`.
//
// Boots an isolated service with three databases mounted at custom paths
// (`--db memories=… --db notepad=… --db codereview=…`) and exercises the
// production code paths: the notepad agent (MCP handlers + bucket attachments)
// and the codereview findings store. Nothing here mocks the transport — every
// call is HTTP to the Rust server.
//
// Run: node tests/ndb-mcp-e2e.test.mjs   (npm run test:ndb)
// Exit 0 = all green. Cleans up its temp root and the service in `finally`.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startNdbTestServer } from './helpers/ndb-test-server.mjs';

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
    if (cond) { passed++; console.log(`  ok  ${label}`); }
    else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
async function rejects(fn, label, match) {
    try {
        await fn();
        ok(false, label, 'expected a throw, got none');
    } catch (e) {
        ok(!match || match.test(e.message), label, `message did not match ${match}: "${e.message}"`);
    }
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ndb-mcp-e2e-'));
const dbPaths = {
    memories: path.join(tmp, 'dbs', 'memories'),
    notepad: path.join(tmp, 'dbs', 'notepad'),
    codereview: path.join(tmp, 'dbs', 'codereview'),
};

const ndb = await startNdbTestServer({ dbs: Object.entries(dbPaths) });

const config = {
    ndb: {
        serviceUrl: ndb.url,
        dbs: { memories: 'memories', notepad: 'notepad', codereview: 'codereview' },
    },
    agents: {},
};
const notepadContext = { config, gateway: null };

const call = async (handler, args) => JSON.parse((await handler(args)).content[0].text);

try {
    // ── Service shape ─────────────────────────────────────────────────────
    console.log('\n[ndb serve — multi-DB custom-path mounting]');
    const health = await (await import('../src/lib/ndb-client.js')).createNdbClient(ndb.url).health();
    ok(health?.ok === true, 'health reports ok');
    ok(['memories', 'notepad', 'codereview'].every((n) => (health.dbs || []).includes(n)),
        `all three custom-path DBs are mounted (${(health.dbs || []).join(', ')})`);

    const notepad = await import('../src/agents/notepad/index.js');
    const store = await import('../src/agents/codereview/store.js');

    // ── Notepad lifecycle ─────────────────────────────────────────────────
    console.log('\n[notepad — init, contexts, tasks, query]');
    await notepad.init(notepadContext);
    ok(notepad.store.db !== null, 'agent connected to the notepad DB over HTTP');

    const seeded = await call(notepad.notepad_contexts);
    ok(seeded.contexts.includes('raum'), 'seed context registry present on first boot');

    const added = await call(notepad.notepad_context_add, { name: 'e2e-project' });
    ok(added.added === 'e2e-project' && added.contexts.includes('e2e-project'), 'context_add registers a context');
    await rejects(() => notepad.notepad_context_add({ name: 'e2e-project' }), 'duplicate context_add refuses', /already exists/);

    const renamed = await call(notepad.notepad_context_rename, { from: 'e2e-project', to: 'e2e-renamed' });
    ok(renamed.to === 'e2e-renamed' && !renamed.contexts.includes('e2e-project'), 'context_rename replaces the name');

    const task = await call(notepad.notepad_add, {
        type: 'task', title: 'Ship the v2 cutover', owner: 'david', context: 'e2e-renamed',
        due: '2026-12-01', steps: ['Write the client', 'Run the tests', 'Update the docs'],
    });
    const taskId = task.item.id;
    ok(Number.isInteger(taskId) && task.item.steps.length === 3, `task created with steps (id ${taskId})`);

    const completed = await call(notepad.notepad_complete, { id: taskId, stepIndex: 0 });
    ok(completed.steps[0].done === true && completed.steps[1].done === false,
        'step completion is an atomic dotted PATCH (steps.0.done)');
    await rejects(() => notepad.notepad_complete({ id: taskId, stepIndex: 9 }), 'out-of-range stepIndex refuses', /out of range/);

    const afterStep = await call(notepad.notepad_get, { id: taskId });
    ok(afterStep.steps[0].done === true && afterStep.body === null, 'get returns the persisted step state (body omitted when unset)');

    const listed = await call(notepad.notepad_list, { type: 'task', owner: 'david', context: 'e2e-renamed' });
    ok(listed.length === 1 && listed[0].stepsDone === 1 && listed[0].stepsTotal === 3 && listed[0].nextStep === 'Run the tests',
        'notepad_list filters Rust-side and returns the compact task summary');

    const noneDone = await call(notepad.notepad_list, { type: 'task', status: 'done' });
    ok(Array.isArray(noneDone) && noneDone.length === 0, 'status filter excludes open tasks');

    const updated = await call(notepad.notepad_update, { id: taskId, due: '2026-12-15', notes: 'cutover checklist' });
    ok(updated.due === '2026-12-15' && updated.notes === 'cutover checklist', 'update applies a single atomic patch');
    await rejects(() => notepad.notepad_update({ id: taskId, type: 'idea' }), 'type change is refused', /cannot be changed/);

    const snap = await call(notepad.notepad_snapshot, { context: 'e2e-renamed' });
    ok(snap.context === 'e2e-renamed' && snap.contextOpen.length === 1 && snap.openTasks.length === 1,
        'snapshot builds the project-start view from the live DB');
    ok(snap.contexts.includes('e2e-renamed'), 'snapshot footer carries the context registry');

    // ── Idea → task promotion ─────────────────────────────────────────────
    console.log('\n[notepad — promote, remove]');
    const idea = await call(notepad.notepad_add, { type: 'idea', title: 'Pin the migration', owner: 'machine', context: 'e2e-renamed' });
    const promoted = await call(notepad.notepad_promote, { id: idea.item.id });
    ok(promoted.idea.status === 'promoted' && promoted.idea.promotedTo === promoted.task.id && promoted.task.type === 'task',
        'promote links idea → task and marks the idea promoted');
    const promotedTasks = await call(notepad.notepad_list, { type: 'task', context: 'e2e-renamed' });
    ok(promotedTasks.length === 2, 'promoted task is queryable in the same context');

    await rejects(() => notepad.notepad_context_remove({ name: 'e2e-renamed' }), 'context_remove refuses while items reference it', /used by 3 item/);

    // ── Attachments (bucket files) ────────────────────────────────────────
    console.log('\n[notepad — attachment bucket]');
    const attachPath = path.join(tmp, 'attachment.txt');
    const attachBytes = Buffer.from('nDB v2 attachment payload — e2e\n', 'utf8');
    await fsp.writeFile(attachPath, attachBytes);

    const attached = await call(notepad.notepad_attach, { id: taskId, path: attachPath });
    const urlMatch = /^\/notepad\/files\/([0-9a-f]+)\.([a-z0-9]+)$/.exec(attached.url);
    ok(urlMatch !== null, `attach returns a bucket URL (${attached.url})`);
    ok(urlMatch && /^[0-9a-f]{64}$/.test(urlMatch[1]), 'new uploads carry the full 64-hex SHA-256');
    ok(attached.attachment.ref === `notepad:${urlMatch[1]}.${urlMatch[2]}`, 'attachment ref is bucket:hash.ext');
    ok(notepad.FILE_REF_RE.test(`${urlMatch[1]}.${urlMatch[2]}`), 'route regex accepts 64-hex refs');
    ok(notepad.FILE_REF_RE.test('deadbeef.txt'), 'route regex still accepts legacy 8-hex refs');
    ok(!notepad.FILE_REF_RE.test('a'.repeat(40) + '.txt'), 'route regex rejects non-hash lengths');

    const fetched = await notepad.getFileBuffer(urlMatch[1], urlMatch[2]);
    ok(fetched !== null && fetched.equals(attachBytes), 'bytes read back through the bucket API match the upload');

    // Legacy id compatibility: a converted database holds 8-hex filenames.
    const bucketDir = path.join(dbPaths.notepad, '_files', 'notepad');
    await fsp.writeFile(path.join(bucketDir, 'deadbeef.txt'), Buffer.from('legacy bytes', 'utf8'));
    const legacy = await notepad.getFileBuffer('deadbeef', 'txt');
    ok(legacy !== null && legacy.toString('utf8') === 'legacy bytes', '8-hex legacy filename is still served');

    await call(notepad.notepad_remove, { id: taskId });
    ok(await notepad.getFileBuffer(urlMatch[1], urlMatch[2]) === null, 'removing the item releases its bucket attachment');
    await rejects(() => notepad.notepad_get({ id: taskId }), 'removed item is gone', /not found/);

    const remaining = await call(notepad.notepad_list, { type: 'task', context: 'e2e-renamed' });
    ok(remaining.length === 1, 'only the promoted task survives in the context');
    const snapAfter = await call(notepad.notepad_snapshot, { context: 'e2e-renamed' });
    ok(snapAfter.openTasks.length === 1, 'snapshot excludes deleted documents');

    await call(notepad.notepad_remove, { id: remaining[0].id });
    // The promoted idea keeps its own context reference — clear it too.
    await call(notepad.notepad_remove, { id: idea.item.id });
    const removedContext = await call(notepad.notepad_context_remove, { name: 'e2e-renamed' });
    ok(!removedContext.contexts.includes('e2e-renamed'), 'context_remove succeeds once nothing references it');

    // ── CodeReview store lifecycle ────────────────────────────────────────
    console.log('\n[codereview store — reviews & findings]');
    await store.initStore({ serviceUrl: ndb.url, dbName: 'codereview' });

    const validatorVersion = 'e2e-validator-v1';
    const reviewId = await store.saveReview({
        sourceLabel: 'src://e2e', snapshotHash: 'snap-e2e-1', modelPair: 'model-a+model-b',
        validatorVersion, status: 'done',
    });
    ok(typeof reviewId === 'string' && reviewId.startsWith('rev_'), `review persisted with a prefixed id (${reviewId})`);

    const latest = await store.findLatestReviewForSource('src://e2e', 'model-a+model-b', validatorVersion);
    ok(latest?._id === reviewId && latest.status === 'done', 'findLatestReviewForSource matches source+models+validator');

    const partialId = await store.saveReview({
        sourceLabel: 'src://e2e', snapshotHash: 'snap-e2e-2', modelPair: 'model-a+model-b',
        validatorVersion, status: 'partial',
    });
    const stillLatest = await store.findLatestReviewForSource('src://e2e', 'model-a+model-b', validatorVersion);
    ok(stillLatest?._id === reviewId, 'a partial review is not a completed incremental baseline');

    const f1 = await store.saveFinding({
        reviewId, sourceLabel: 'src://e2e', snapshotHash: 'snap-e2e-1', fingerprint: 'fp-alpha',
        file: 'src/a.js', failure_mode: 'swallowed error', status: 'new',
    });
    const f2 = await store.saveFinding({
        reviewId, sourceLabel: 'src://e2e', snapshotHash: 'snap-e2e-1', fingerprint: 'fp-beta',
        file: 'src/b.js', failure_mode: 'serial awaits', status: 'new',
    });
    ok(f1.id.startsWith('fnd_') && f2.id.startsWith('fnd_'), 'findings persisted with prefixed ids');

    ok((await store.listFindings({ reviewId })).length === 2, 'listFindings filters by reviewId');
    ok((await store.listFindings({ reviewId, status: 'new' })).length === 2, 'listFindings filters by status');
    ok((await store.listFindings({ snapshotHash: 'snap-e2e-1' })).length === 2, 'listFindings filters by snapshotHash');
    ok((await store.listFindings({ reviewId: partialId })).length === 0, 'findings of another review stay out');

    await store.updateFinding(f1.id, { status: 'rejected' });
    const rejected = await store.getFinding(f1.id);
    ok(rejected.status === 'rejected' && typeof rejected.updatedAt === 'string', 'updateFinding patches status atomically');
    ok((await store.listFindings({ status: 'rejected' })).length === 1, 'status filter sees the transition');

    const carry = await store.saveFinding({
        reviewId: 'r_later_run', sourceLabel: 'src://e2e', snapshotHash: 'snap-e2e-3', fingerprint: 'fp-alpha',
        file: 'src/a.js', failure_mode: 'swallowed error',
    });
    ok(carry.status === 'rejected' && carry.id !== f1.id, 'a rejection carries forward to the same source in a later review');

    await store.updateReview(reviewId, { status: 'done', findingCount: 2 });
    const reviewDoc = await store.getReview(reviewId);
    ok(reviewDoc.findingCount === 2, 'updateReview patches a review in place');

    // ── Fail-fast startup ─────────────────────────────────────────────────
    console.log('\n[fail-fast startup]');
    await rejects(
        () => notepad.init({ config: { ndb: { serviceUrl: ndb.url, dbs: { notepad: 'absent-notepad' } } } }),
        'notepad.init refuses an unmounted database', /not mounted/
    );
    await rejects(
        () => store.initStore({ serviceUrl: ndb.url, dbName: 'absent-codereview' }),
        'codereview store refuses an unmounted database', /not mounted/
    );
    await rejects(
        () => notepad.init({ config: { ndb: { serviceUrl: 'http://127.0.0.1:1', dbs: { notepad: 'notepad' } } } }),
        'notepad.init refuses an unreachable service', /unreachable|timed out/
    );
} catch (err) {
    failed++;
    console.error(`\n  FAIL harness threw: ${err.stack}`);
} finally {
    await ndb.stop();
    await fsp.rm(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
