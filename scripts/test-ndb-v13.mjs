// test-ndb-v13.mjs — verify the nDB v1.3 features the memory agent will rely on:
//   1. Delta ops (set/remove/arrayPush) maintain secondary indexes (fix for the
//      stale embedStatus index, herrbasan/nDB — the findPendingMemories workaround
//      depends on this being true).
//   2. Full-text search: term/phrase/prefix/exclude, AND/OR, case-insensitive default.
//   3. Text index maintenance on delta writes (set a description → new words findable).
//   4. Fail loud on search over a non-indexed field.
// Loads the FRESH binding via NODE_NDB_NATIVE_PATH (napi/ still holds the old
// locked binary while the live server runs).
// Run: node scripts/test-ndb-v13.mjs

process.env.NODE_NDB_NATIVE_PATH = 'D:\\DEV\\mcp_server\\nDB\\target\\release\\ndb-node.win32-x64-msvc.node';
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { Database } = require('../nDB/napi/index.js');

let failures = 0;
const ok = (name) => console.log(`  OK   ${name}`);
const fail = (name, detail) => { failures++; console.log(`  FAIL ${name}\n       ${detail}`); };
const check = (name, cond, detail = '') => cond ? ok(name) : fail(name, detail);

// ─── 1. Delta ops maintain secondary indexes ───
console.log('══ delta-op index maintenance ══');
{
    const db = Database.openInMemory();
    db.createIndex('category');
    const id1 = db.insert({ category: 'a', description: 'doc one' });
    const id2 = db.insert({ category: 'b', description: 'doc two' });

    // set() delta → index must track the new value
    db.set(id1, 'category', 'b');
    const foundB = db.find('category', 'b').map(d => d._id);
    check('set() updates hash index', foundB.includes(id1) && foundB.includes(id2), `find('category','b') = ${JSON.stringify(foundB)}, expected both ids`);
    const foundA = db.find('category', 'a').map(d => d._id);
    check('set() removes old index entry', !foundA.includes(id1), `find('category','a') = ${JSON.stringify(foundA)}, expected empty`);

    // remove() delta → field gone from index
    db.set(id2, 'category', 'c');
    db.remove(id2, 'category');
    const foundC = db.find('category', 'c').map(d => d._id);
    check('remove() clears index entry', !foundC.includes(id2), `find('category','c') = ${JSON.stringify(foundC)}, expected empty`);

    // delete() → tombstone, doc out of index
    db.delete(id2);
    const foundB2 = db.find('category', 'b').map(d => d._id);
    check('delete() removes doc from index', !foundB2.includes(id2), `find('category','b') = ${JSON.stringify(foundB2)}`);
}

// ─── 2. Full-text search semantics ───
console.log('══ text search ══');
{
    const db = Database.openInMemory();
    db.createTextIndex('description');
    const hare = db.insert({ description: 'The hare was tired at the end of the race' });
    const paul = db.insert({ description: 'Paul met the rabbit yesterday at the racetrack' });
    const zen = db.insert({ description: 'Zebra content unrelated to racing entirely' });

    const ids = (q) => db.textSearch('description', q).sort();
    const sorted = (...want) => [...want].sort();

    check('term whole-token (race ≠ racetrack)',
        JSON.stringify(ids({ queries: [{ type: 'term', value: 'race' }] })) === JSON.stringify([hare]),
        `got ${JSON.stringify(ids({ queries: [{ type: 'term', value: 'race' }] }))}`);

    check('phrase contiguous',
        JSON.stringify(ids({ queries: [{ type: 'phrase', value: 'hare was tired' }] })) === JSON.stringify([hare]),
        'phrase "hare was tired" should match hare doc only');

    check('phrase order matters',
        ids({ queries: [{ type: 'phrase', value: 'tired was hare' }] }).length === 0,
        'out-of-order phrase should not match');

    check('prefix',
        JSON.stringify(ids({ queries: [{ type: 'prefix', value: 'yester' }] })) === JSON.stringify([paul]),
        'prefix "yester" should match yesterday doc');

    check('AND mode',
        JSON.stringify(ids({ queries: [{ type: 'term', value: 'rabbit' }, { type: 'term', value: 'yesterday' }] })) === JSON.stringify([paul]),
        'both terms must match');

    check('exclude',
        JSON.stringify(ids({ queries: [{ type: 'term', value: 'the' }, { type: 'term', value: 'race', exclude: true }] })) === JSON.stringify([paul]),
        'docs with "the" but NOT whole-token "race" (racetrack ≠ race, zen lacks "the")');

    check('case-insensitive default',
        ids({ queries: [{ type: 'term', value: 'HARE' }] }).length === 1,
        'HARE should match hare');

    check('OR mode',
        ids({ mode: 'or', queries: [{ type: 'term', value: 'zebra' }, { type: 'term', value: 'hare' }] }).length === 2,
        'either term matches');

    // 3. Write-path maintenance via delta ops
    db.set(hare, 'description', 'brand new zebra phrasing entirely different');
    check('set() updates text index (new words findable)',
        JSON.stringify(ids({ queries: [{ type: 'phrase', value: 'zebra phrasing' }] })) === JSON.stringify([hare]),
        'search after set() should find new phrase');
    check('set() drops old words from text index',
        ids({ queries: [{ type: 'term', value: 'tired' }] }).length === 0,
        'old word should no longer match');

    // 4. Fail loud on non-indexed field
    let threw = false;
    try { db.textSearch('data', { queries: [{ type: 'term', value: 'x' }] }); } catch { threw = true; }
    check('fail loud on non-indexed field', threw, 'expected throw for un-indexed field');

    // Fail loud on unknown query type
    let threw2 = false;
    try { db.textSearch('description', { queries: [{ type: 'regex', value: 'x' }] }); } catch { threw2 = true; }
    check('fail loud on unknown query type', threw2, 'expected throw for type "regex"');
}

// ─── 3. Array-of-strings field (the memory agent's `data` shape) ───
console.log('══ array-of-strings field ══');
{
    const db = Database.openInMemory();
    db.createTextIndex('data');
    const a = db.insert({ data: ['Substrate: [gemini on Badkid]. Clusters: 33, nodes: 1290.'] });
    const b = db.insert({ data: 'plain string substrate value' });

    check('array-of-strings indexed',
        JSON.stringify(db.textSearch('data', { queries: [{ type: 'term', value: 'clusters' }] })) === JSON.stringify([a]),
        'term in array element should match');
    check('plain string field indexed',
        db.textSearch('data', { queries: [{ type: 'term', value: 'substrate' }] }).length === 2,
        'both docs contain substrate');
}

console.log(failures === 0 ? '\nRESULT: all green' : `\nRESULT: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
