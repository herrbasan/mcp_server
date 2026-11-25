// Phase 4 / Slice 4B — embedded query facade against a REAL `ndb serve` plus a
// controllable nVDB HTTP stub (online / stale→catch-up / stale→timeout /
// rebuilding / offline).
//
// Run: node tests/ndb-query-facade.test.mjs
// Exit 0 = all green. Cleans up its temp root, the stub and the service.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NDB_TEST_RAM = '1';
const { startNdbTestServer } = await import('./helpers/ndb-test-server.mjs');
const { startNvdbStub } = await import('./helpers/nvdb-stub-server.mjs');
const { createNdbClient } = await import('../src/lib/ndb-client.js');
const { createQueryFacade, NvdbUnavailableError } = await import('../src/lib/ndb-query-facade.js');

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
    if (cond) { passed += 1; console.log(`  ok  ${label}`); }
    else { failed += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
async function rejects(fn, label, match) {
    try {
        const value = await fn();
        ok(false, label, `expected a throw, got ${JSON.stringify(value)?.slice(0, 200)}`);
        return null;
    } catch (err) {
        const matched = !match || match.test(err.message);
        ok(matched, label, matched ? undefined : `message did not match ${match}: "${err.message}"`);
        return err;
    }
}
const idList = results => results.map(r => r._id);
const sameIds = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ndb-qfacade-'));
const dbPath = path.join(tmp, 'dbs', 'qfacade');
const ndb = await startNdbTestServer({ dbs: [['qfacade', dbPath]] });
const client = createNdbClient(ndb.url);
const db = client.db('qfacade');
let stub = null;

const LONG_TEXT = 'héllo wörld — this is a long unicode text with emoji 🚀 and more characters to page through.';
const docs = [
    { title: 'Alpha rust guide', text: LONG_TEXT, score: 5, domain: 'work', categories: ['rust', 'storage'], tags: ['x', 'y'], kind: 'guide', messages: ['m0', 'm1', 'm2', 'm3', 'm4'] },
    { title: 'Beta go caching', text: 'go caching notes', score: 3, domain: 'work', categories: ['go'], tags: ['y'], kind: 'note', messages: ['b0', 'b1'] },
    { title: 'Gamma rust notes', text: 'rust ownership notes', score: 4, domain: 'personal', categories: ['rust'], tags: ['x'], kind: 'note', messages: [] },
    { title: 'Delta storage layout', text: 'storage layout for caching', score: 5, domain: 'work', categories: ['storage'], tags: ['z'], kind: 'guide', messages: [] },
    { title: 'Epsilon misc', text: 'miscellaneous ramblings', score: 1, domain: 'personal', categories: [], tags: [], kind: 'note', messages: [] },
    { title: 'Zeta unranked', text: 'unranked rust appendix', domain: 'work', categories: ['rust'], tags: [], kind: 'note', messages: [] },
];

try {
    console.log('\n[setup — isolated ndb serve, classification profile, field mapping]');
    const created = [];
    for (const doc of docs) created.push(await db.insert(doc));
    const ids = created.map(c => c.id);
    ok(ids.length === 6 && new Set(ids).size === 6, 'six documents created');
    const byTitle = Object.fromEntries(created.map(c => [c.doc.title, c.id]));
    const alphaId = byTitle['Alpha rust guide'];

    const profileSchema = await db.enableClassificationProfile({ enabled: true, backfillEmpty: false });
    ok(profileSchema.classification_profile === true, 'classification profile enabled');
    ok(profileSchema.indexes.some(i => i.field === 'domain') && profileSchema.indexes.some(i => i.field === 'categories'),
        'domain + categories automatically indexed');

    const mapping = [
        { field: 'domain', hash: true, project: true },
        { field: 'categories', hash: true, project: true },
        { field: 'score', hash: true, ordered: true, project: true },
        { field: 'title', text: true, project: true },
        { field: 'text', text: true, project: true },
        { field: 'tags', hash: true, project: true },
        { field: 'kind', hash: true, project: true },
    ];
    const mapped = await db.setFieldMapping(mapping);
    ok(mapped.field_mapping.some(e => e.field === 'title' && e.text === true && e.project === true),
        'field mapping persists text + project capabilities');

    const facade = createQueryFacade({ ndbDb: db });

    console.log('\n[§6.1 — nVDB stopped: object CRUD, classification enforcement]');
    ok(facade.lastWriteSeq === 0, 'a fresh facade starts with no write watermark', `lastWriteSeq=${facade.lastWriteSeq}`);
    const beforeWrite = facade.lastWriteSeq;
    const tmpDoc = await facade.createItem({
        title: 'Temp lifecycle', text: 'temp', score: 2, domain: 'work', categories: ['rust'], tags: [], kind: 'note',
    });
    ok(Number.isInteger(tmpDoc.seq) && facade.lastWriteSeq === tmpDoc.seq && tmpDoc.seq > beforeWrite,
        'createItem tracks the ndb seq', `seq=${tmpDoc.seq} last=${facade.lastWriteSeq}`);
    const got = await facade.getItem(tmpDoc.id, { fields: ['title', 'categories'] });
    ok(got.title === 'Temp lifecycle' && Array.isArray(got.categories), 'getItem returns the authoritative object');
    const mget = await facade.mgetItems([tmpDoc.id, alphaId, 'missing-id']);
    ok(mget.docs[tmpDoc.id] && mget.docs[alphaId] && mget.missing.includes('missing-id'), 'mgetItems splits hits and misses');

    const replaced = await facade.replaceItem(tmpDoc.id, {
        title: 'Temp lifecycle v2', text: 'temp', score: 2, domain: 'work', categories: ['rust'], tags: [], kind: 'note',
    });
    ok(replaced.seq > tmpDoc.seq && facade.lastWriteSeq === replaced.seq, 'replaceItem advances the watermark');
    const patched = await facade.patchItem(tmpDoc.id, [{ op: 'set', path: 'score', value: 9 }]);
    ok(patched.doc.score === 9 && facade.lastWriteSeq === patched.seq, 'patchItem applies and tracks seq');
    const deleted = await facade.deleteItem(tmpDoc.id);
    ok(deleted.deleted === true && (await facade.getItem(tmpDoc.id)) === null, 'deleteItem tombstones the object');
    const restored = await facade.restoreItem(tmpDoc.id);
    ok(restored.doc.title === 'Temp lifecycle v2' && facade.lastWriteSeq === restored.seq, 'restoreItem brings it back');
    await facade.deleteItem(tmpDoc.id);

    await rejects(() => facade.createItem({ title: 'No domain', text: 'x', categories: [], kind: 'note' }),
        'profile refuses a document without domain', /domain/i);
    await rejects(() => facade.createItem({ title: 'Bad types', text: 'x', domain: 42, categories: [], kind: 'note' }),
        'profile refuses a non-string domain', /domain/i);
    await rejects(() => facade.patchItem(alphaId, [{ op: 'remove', path: 'domain' }]),
        'profile refuses removing domain through patch', /domain/i);
    const deduped = await facade.createItem({
        title: 'Dedup categories', text: 'dedupe', domain: 'work', categories: ['a', 'a', 'b'], tags: [], kind: 'note',
    });
    ok(JSON.stringify(deduped.doc.categories) === JSON.stringify(['a', 'b']), 'categories are deduplicated before storage',
        JSON.stringify(deduped.doc.categories));
    await facade.deleteItem(deduped.id);

    console.log('\n[§6.1 — nVDB stopped: list, multi-key sort, cursor, facets, lexical, peek]');
    const full = await facade.listItems({ filter: {}, sort: [{ field: 'score', dir: 'desc' }, { field: 'title', dir: 'asc' }] });
    ok(full.engine === 'ndb' && full.total === 6 && full.count === 6, 'listItems runs on NDB alone', `engine=${full.engine} total=${full.total}`);
    const expectedOrder = ['Alpha rust guide', 'Delta storage layout', 'Gamma rust notes', 'Beta go caching', 'Epsilon misc', 'Zeta unranked'];
    ok(JSON.stringify(full.results.map(r => r.title)) === JSON.stringify(expectedOrder),
        'multi-key sort: score desc, title asc, missing last', JSON.stringify(full.results.map(r => r.title)));
    ok(full.results[full.results.length - 1]._id === byTitle['Zeta unranked'], 'missing score sorts last');
    const missingFirst = await facade.listItems({ sort: [{ field: 'score', dir: 'desc', missing: 'first' }] });
    ok(missingFirst.results[0]._id === byTitle['Zeta unranked'], 'missing:first is absolute (not reversed by desc)');

    const page1 = await facade.listItems({ sort: [{ field: 'score', dir: 'desc' }, { field: 'title', dir: 'asc' }], limit: 2 });
    const page2 = await facade.listItems({ sort: [{ field: 'score', dir: 'desc' }, { field: 'title', dir: 'asc' }], limit: 2, cursor: page1.next_cursor });
    const page3 = await facade.listItems({ sort: [{ field: 'score', dir: 'desc' }, { field: 'title', dir: 'asc' }], limit: 2, cursor: page2.next_cursor });
    const paged = [...page1.results, ...page2.results, ...page3.results];
    ok(page1.count === 2 && typeof page1.next_cursor === 'string' && page3.next_cursor === null, 'cursor pagination walks the set');
    ok(sameIds(idList(paged), idList(full.results)) && paged.length === 6, 'pages reconstruct the full deterministic order');

    const workPage = await facade.listItems({ filter: { domain: 'work' }, fields: ['title', 'domain'], sort: [{ field: 'title', dir: 'asc' }] });
    ok(workPage.total === 4 && workPage.results.every(r => r.domain === 'work' && r.title && r._id), 'filtered + projected list');
    const memberPage = await facade.listItems({ filter: { categories: 'rust' }, fields: ['title'], sort: [{ field: 'title', dir: 'asc' }] });
    ok(memberPage.total === 3, 'category filter is array membership', `total=${memberPage.total}`);

    const allFacets = await facade.facets({}, ['domain', 'categories']);
    ok(allFacets.domain.work === 4 && allFacets.domain.personal === 2, 'facets count domains', JSON.stringify(allFacets.domain));
    ok(allFacets.categories.rust === 3 && allFacets.categories.storage === 2, 'facets count array members', JSON.stringify(allFacets.categories));
    const workFacets = await facade.facets({ domain: 'work' }, ['categories']);
    ok(workFacets.categories.rust === 2 && workFacets.categories.storage === 2 && workFacets.categories.go === 1,
        'filtered facets use the same filter semantics', JSON.stringify(workFacets.categories));

    const lexical = await facade.searchItems({ query: 'rust', limit: 10 });
    ok(lexical.engine === 'ndb' && lexical.total === 3, 'standalone lexical search on NDB alone', `total=${lexical.total}`);
    ok(typeof lexical.scanned_docs === 'number' && Array.isArray(lexical.used_indexes), 'search reports scanned_docs + used_indexes');
    const phrase = await facade.searchItems({ query: '"rust ownership"' });
    ok(phrase.total === 1 && phrase.results[0].title === 'Gamma rust notes', 'quoted phrase search');
    await rejects(() => facade.searchItems({ query: '"unterminated' }), 'unterminated phrase is refused loudly', /invalid_argument|unterminated/i);
    await rejects(() => facade.listItems({ maxScanDocs: 1 }), 'scan budget rejects excessive work', /scan_budget_exceeded/i);

    const peek1 = await facade.peekItem(alphaId, {
        fields: ['title'],
        textRanges: [{ path: 'text', offset: 0, limit: 20 }],
        arraySlices: [{ path: 'messages', offset: 0, limit: 2 }],
    });
    ok(peek1.seq === created[0].seq && peek1.doc.title === 'Alpha rust guide' && !('score' in peek1.doc),
        'peekItem projects fields and keeps the named range paths');
    ok(peek1.ranges.text.total === [...LONG_TEXT].length && peek1.ranges.messages.total === 5,
        'range totals are characters and elements', `text=${peek1.ranges.text.total}`);
    const more = await facade.readMore(peek1, {
        textRanges: [{ path: 'text', limit: 20 }],
        arraySlices: [{ path: 'messages', limit: 2 }],
    });
    ok(more.seq === peek1.seq && more.ranges.text.offset === 20 && more.ranges.messages.offset === 2,
        'readMore continues from next_offset at the same seq');

    console.log('\n[§6.8 — pinned multi-page reads, snippet handoff, 409 conflict]');
    let page = await facade.peekItem(alphaId, {
        textRanges: [{ path: 'text', offset: 0, limit: 20 }],
        arraySlices: [{ path: 'messages', offset: 0, limit: 2 }],
    });
    let textOut = page.doc.text;
    let messagesOut = [...page.doc.messages];
    const seqs = new Set([page.seq]);
    let pages = 1;
    const hasMore = (result, rangePath) => Boolean(result.ranges?.[rangePath]?.has_more);
    while (hasMore(page, 'text') || hasMore(page, 'messages')) {
        const args = {};
        if (hasMore(page, 'text')) args.textRanges = [{ path: 'text', limit: 20 }];
        if (hasMore(page, 'messages')) args.arraySlices = [{ path: 'messages', limit: 2 }];
        page = await facade.readMore(page, args);
        pages += 1;
        seqs.add(page.seq);
        if (page.doc.text) textOut += page.doc.text;
        if (page.doc.messages) messagesOut.push(...page.doc.messages);
    }
    ok(textOut === LONG_TEXT, 'text ranges reassemble the exact UTF-8 text across pages', `pages=${pages}`);
    ok(JSON.stringify(messagesOut) === JSON.stringify(['m0', 'm1', 'm2', 'm3', 'm4']), 'array slices reassemble the array');
    ok(seqs.size === 1 && pages >= 5, 'every page stayed on one pinned seq', `pages=${pages} seqs=${[...seqs].join(',')}`);
    await rejects(() => facade.readMore(page, { textRanges: [{ path: 'text', limit: 20 }] }),
        'readMore on an exhausted range refuses instead of looping', /exhausted/);

    const conflictBase = await facade.peekItem(alphaId, { textRanges: [{ path: 'text', offset: 0, limit: 20 }] });
    await facade.patchItem(alphaId, [{ op: 'set', path: 'title', value: 'Alpha rust guide (edited)' }]);
    const conflict = await rejects(() => facade.readMore(conflictBase, { textRanges: [{ path: 'text', limit: 20 }] }),
        '409 conflict when the object changes mid-read', /conflict/i);
    ok(conflict instanceof Error && conflict.code === 'conflict' && conflict.status === 409,
        'the conflict carries code=conflict and status=409', `${conflict?.code}/${conflict?.status}`);
    await facade.patchItem(alphaId, [{ op: 'set', path: 'title', value: 'Alpha rust guide' }]);

    console.log('\n[setup — nVDB stub mirrors the derived projection]');
    async function currentDocs() {
        const r = await db.query({ filter: {}, limit: 1000 });
        return r.results;
    }
    async function syncStub(target, asOfSeq) {
        const docsNow = await currentDocs();
        target.setDocs(docsNow);
        const lineage = await db.lineage();
        target.setAsOfSeq(asOfSeq ?? lineage.last_seq);
        return lineage.last_seq;
    }
    stub = await startNvdbStub({ collection: 'qfacade', docs: await currentDocs(), asOfSeq: (await db.lineage()).last_seq });
    const nvdbFacade = createQueryFacade({
        ndbDb: db, nvdbClient: stub.client, collection: 'qfacade', readYourWritesMs: 800, pollIntervalMs: 20, preferNvdbList: true,
    });

    const listQuery = {
        filter: { domain: 'work' },
        sort: [{ field: 'score', dir: 'desc' }, { field: 'title', dir: 'asc' }],
        fields: ['title', 'score', 'domain'],
        limit: 3,
    };
    const ndbList = await facade.listItems(listQuery);

    console.log('\n[§6.5 / §6.1 — identical task semantics: online]');
    const onlineList = await nvdbFacade.listItems(listQuery);
    ok(onlineList.engine === 'nvdb' && Number.isInteger(onlineList.as_of_seq), 'list routes to nVDB when online + projected + fresh',
        `engine=${onlineList.engine}`);
    ok(sameIds(idList(onlineList.results), idList(ndbList.results)) && onlineList.total === ndbList.total && onlineList.count === ndbList.count,
        'nVDB and NDB list return identical ids, order, total, count');
    ok(typeof onlineList.next_cursor === 'string', 'nVDB list returns a continuation cursor');
    const onlinePage2 = await nvdbFacade.listItems({ ...listQuery, cursor: onlineList.next_cursor, limit: 3 });
    const ndbPage2 = await facade.listItems({ ...listQuery, cursor: ndbList.next_cursor, limit: 3 });
    ok(sameIds(idList(onlinePage2.results), idList(ndbPage2.results)), 'page two matches through both engines');

    const lexicalOnline = await nvdbFacade.searchItems({ query: 'rust' });
    const lexicalNdb = await facade.searchItems({ query: 'rust' });
    ok(lexicalOnline.engine === 'nvdb' && Number.isInteger(lexicalOnline.as_of_seq), 'lexical search routes to nVDB when online');
    ok(sameIds(idList(lexicalOnline.results), idList(lexicalNdb.results)), 'nVDB and NDB lexical search agree on ids');

    const unprojected = await nvdbFacade.listItems({ filter: {}, fields: ['title', 'messages'] });
    ok(unprojected.engine === 'ndb', 'unprojected return field falls back to NDB', `engine=${unprojected.engine}`);
    const strong = await nvdbFacade.listItems({ ...listQuery, consistency: 'strong' });
    ok(strong.engine === 'ndb', 'consistency=strong always runs on NDB');

    console.log('\n[§6.5 — rebuilding]');
    stub.setRebuilding(true);
    const rebuildingList = await nvdbFacade.listItems(listQuery);
    ok(rebuildingList.engine === 'ndb' && sameIds(idList(rebuildingList.results), idList(ndbList.results)),
        'rebuilding nVDB falls back to identical NDB list', `engine=${rebuildingList.engine}`);
    const rebuildingSearch = await nvdbFacade.searchItems({ query: 'rust' });
    ok(rebuildingSearch.engine === 'ndb' && sameIds(idList(rebuildingSearch.results), idList(lexicalNdb.results)),
        'rebuilding nVDB falls back to identical NDB lexical search');
    stub.setRebuilding(false);

    console.log('\n[§6.5 / §6.6 — stale→catches up (read-your-writes) and stale→timeout]');
    const freshDoc = await nvdbFacade.createItem({
        title: 'Fresh write marker', text: 'fresh rust marker', score: 7, domain: 'work', categories: ['rust'], tags: [], kind: 'fresh',
    });
    const freshSeq = freshDoc.seq;
    ok(nvdbFacade.lastWriteSeq === freshSeq, 'write watermark advanced to the new seq', `seq=${freshSeq}`);
    stub.setDocs(await currentDocs());
    stub.setAsOfSeq(freshSeq - 1);
    stub.catchUpTo(freshSeq, 120);
    const started = Date.now();
    const catchUp = await nvdbFacade.listItems({ filter: { kind: 'fresh' }, fields: ['title', 'kind'], consistency: 'read_your_writes' });
    const elapsed = Date.now() - started;
    ok(catchUp.engine === 'nvdb' && catchUp.as_of_seq >= freshSeq, 'nVDB serves the fresh read once its watermark catches up',
        `engine=${catchUp.engine} as_of=${catchUp.as_of_seq} seq=${freshSeq}`);
    ok(catchUp.results.some(r => r.title === 'Fresh write marker'), 'the just-written document is in the nVDB answer');
    ok(elapsed >= 100, 'the facade waited for the watermark instead of racing it', `${elapsed}ms`);

    const timeoutFacade = createQueryFacade({
        ndbDb: db, nvdbClient: stub.client, collection: 'qfacade', readYourWritesMs: 200, pollIntervalMs: 20, preferNvdbList: true,
    });
    const second = await timeoutFacade.createItem({
        title: 'Stale timeout marker', text: 'stale marker', score: 8, domain: 'work', categories: ['go'], tags: [], kind: 'stale',
    });
    stub.setDocs(await currentDocs());
    stub.setAsOfSeq(second.seq - 1);
    const staleStart = Date.now();
    const staleRead = await timeoutFacade.listItems({ filter: { kind: 'stale' }, fields: ['title', 'kind'] });
    const staleElapsed = Date.now() - staleStart;
    ok(staleRead.engine === 'ndb', 'stale nVDB past the wait window falls back to NDB', `engine=${staleRead.engine}`);
    ok(staleRead.results.some(r => r.title === 'Stale timeout marker'), 'the fallback still returns the freshly written document');
    ok(staleElapsed >= 175, 'the fallback waited the full readYourWritesMs before giving up', `${staleElapsed}ms`);

    console.log('\n[§6.8 — snippet offsets hand off from nVDB into peekItem]');
    stub.setAsOfSeq((await db.lineage()).last_seq);
    const snippetSearch = await nvdbFacade.searchItems({ query: 'unicode', consistency: 'eventual' });
    ok(snippetSearch.engine === 'nvdb', 'lexical hit served by nVDB', `engine=${snippetSearch.engine}`);
    const snippetHit = snippetSearch.results.find(r => r._id === alphaId);
    ok(snippetHit && Array.isArray(snippetHit._search?.offsets) && snippetHit._search.offsets.length > 0,
        'nVDB hit carries source offsets', JSON.stringify(snippetHit?._search));
    const peeked = await facade.peekItem(alphaId, { textRanges: snippetHit._search.offsets });
    ok(peeked.ranges.text.offset === snippetHit._search.offsets[0].offset && peeked.doc.text.includes('unicode'),
        'peekItem consumes the nVDB offset unchanged');

    console.log('\n[§6.5 — offline]');
    await stub.stop();
    const offlineBaseline = await facade.listItems(listQuery);
    const offlineList = await nvdbFacade.listItems(listQuery);
    ok(offlineList.engine === 'ndb' && sameIds(idList(offlineList.results), idList(offlineBaseline.results)),
        'stopped nVDB: list falls back to identical NDB results', `engine=${offlineList.engine}`);
    const offlineLexicalBaseline = await facade.searchItems({ query: 'rust' });
    const offlineSearch = await nvdbFacade.searchItems({ query: 'rust' });
    ok(offlineSearch.engine === 'ndb' && sameIds(idList(offlineSearch.results), idList(offlineLexicalBaseline.results)),
        'stopped nVDB: lexical search falls back to identical NDB results');
    const status = await nvdbFacade.nvdbStatus();
    ok(status.state === 'unreachable', 'diagnostics report nVDB unreachable', status.state);

    console.log('\n[loud refusal — vector / hybrid / rerank never fake a lexical fallback]');
    for (const mode of ['vector', 'hybrid', 'rerank']) {
        const err = await rejects(() => nvdbFacade.searchItems({ query: 'rust', mode }), `${mode} refuses while nVDB is offline`, /unavailable/i);
        ok(err instanceof NvdbUnavailableError && err.code === 'NVDB_UNAVAILABLE' && err.mode === mode,
            `${mode} throws NvdbUnavailableError with code NVDB_UNAVAILABLE`, `${err?.name}/${err?.code}`);
    }
    const noClientFacade = createQueryFacade({ ndbDb: db });
    for (const mode of ['vector', 'hybrid', 'rerank']) {
        const err = await rejects(() => noClientFacade.searchItems({ query: 'rust', mode }), `${mode} refuses without any nVDB client`, /no nVDB client/i);
        ok(err instanceof NvdbUnavailableError && err.code === 'NVDB_UNAVAILABLE', `${mode} names the missing client loudly`);
    }

    console.log('\n[loud refusal — rebuilding]');
    stub = await startNvdbStub({ collection: 'qfacade', docs: await currentDocs(), asOfSeq: (await db.lineage()).last_seq });
    const liveFacade = createQueryFacade({
        ndbDb: db, nvdbClient: stub.client, collection: 'qfacade', readYourWritesMs: 300, pollIntervalMs: 20, preferNvdbList: true,
    });
    for (const mode of ['vector', 'hybrid', 'rerank']) {
        const okResult = await liveFacade.searchItems({ query: 'rust', mode, consistency: 'eventual' });
        ok(okResult.engine === 'nvdb' && Number.isInteger(okResult.as_of_seq) && okResult.results.length > 0,
            `${mode} runs on nVDB when online`, `engine=${okResult.engine}`);
    }
    stub.setRebuilding(true);
    for (const mode of ['vector', 'hybrid', 'rerank']) {
        const err = await rejects(() => liveFacade.searchItems({ query: 'rust', mode, consistency: 'eventual' }),
            `${mode} refuses while nVDB is rebuilding`, /rebuilding/i);
        ok(err instanceof NvdbUnavailableError, `${mode} rebuilding error is NvdbUnavailableError`);
    }

    console.log('\n[read-your-writes — stale nVDB cannot serve a vector answer]');
    stub.setRebuilding(false);
    const vectorFacade = createQueryFacade({
        ndbDb: db, nvdbClient: stub.client, collection: 'qfacade', readYourWritesMs: 150, pollIntervalMs: 20, preferNvdbList: true,
    });
    const vectorWrite = await vectorFacade.createItem({
        title: 'Vector freshness marker', text: 'vector marker', score: 9, domain: 'work', categories: ['go'], tags: [], kind: 'vector',
    });
    stub.setDocs(await currentDocs());
    stub.setAsOfSeq(vectorWrite.seq - 1);
    const staleVector = await rejects(() => vectorFacade.searchItems({ query: 'rust', mode: 'vector' }),
        'vector search refuses a stale nVDB past the wait', /behind required seq/i);
    ok(staleVector instanceof NvdbUnavailableError && staleVector.code === 'NVDB_UNAVAILABLE',
        'stale vector refusal is NvdbUnavailableError');
    stub.setAsOfSeq(vectorWrite.seq);
    const freshVector = await vectorFacade.searchItems({ query: 'rust', mode: 'vector' });
    ok(freshVector.engine === 'nvdb' && freshVector.as_of_seq >= vectorWrite.seq, 'fresh vector search carries as_of_seq');
} finally {
    if (stub && stub.state && !stub.state.stopped) {
        try { await stub.stop(); } catch { /* already closed */ }
    }
    await ndb.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
