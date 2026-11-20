// Golden gate for the nVDB hybrid + rerank production path.
//
// Runs the REAL agents (vdb, memory) against a throwaway copy of the candidate
// index, so the index the service uses stays untouched. Exits non-zero when a
// gate fails.
//
// Requirements: an nVDB addon built with --features rerank-onnx, resolvable by
// src/agents/vdb/nvdb-loader.js (or passed with --addon <path>), and a live
// Gateway serving /v1/embeddings/wizkid.
//
// Usage: node scripts/nvdb-hybrid-gate.mjs [--keep] [--addon <path>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const addonArg = args.indexOf('--addon');

process.chdir(repo);
if (addonArg !== -1) {
    const addon = path.resolve(args[addonArg + 1]);
    if (!fs.existsSync(addon)) {
        console.error(`gate: addon not found: ${addon}`);
        process.exit(1);
    }
    process.env.NODE_NVDB_NATIVE_PATH = addon;
}
// Without --addon the gate loads exactly what the service would load, so a
// missing/stale addon is caught here rather than at the restart.

const config = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const candidate = path.resolve(repo, config.agents.vdb.dbPath);
const workRoot = path.join(repo, 'data', 'temp', 'nvdb-gate');
const workNvdb = path.join(workRoot, 'nvdb');

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });
fs.cpSync(candidate, workNvdb, { recursive: true });
config.agents.vdb.dbPath = path.relative(repo, workNvdb).replace(/\\/g, '/');

const load = spec => import(pathToFileURL(path.join(repo, spec)).href);
const { createEmbedClient } = await load('src/embed-client.js');
const { createGatewayClient } = await load('src/gateway-client.js');
const vdb = await load('src/agents/vdb/index.js');
const memory = await load('src/agents/memory/index.js');

const gateway = createGatewayClient(
    config.gateway.wsUrl,
    config.gateway.httpUrl,
    config.gateway.accessKey,
    createEmbedClient(config.gateway.httpUrl, config.gateway.accessKey)
);
const agents = new Map();
const context = { config, gateway, agents, prompts: new Map(), app: null };

const failures = [];
function check(label, condition, detail) {
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures.push(label);
}

try {
    const instance = await vdb.init(context);
    agents.set('vdb', instance);
    await memory.init(context);

    check('reranker loaded', instance.reranker !== null);
    check('hybrid enabled', instance.hybrid?.enabled === true);
    check('snapshot mode', instance.snapshot === true);

    const started = performance.now();
    const results = await vdb.searchDocuments({ query: 'Consciousness Is the Record', top_k: 10 });
    const storageMs = Math.round(performance.now() - started);
    console.log(`\nstorage top-10 (${storageMs} ms):`);
    results.forEach((r, i) => console.log(`  ${i + 1}. ${r.path}  rerank=${r.rerankScore?.toFixed(3) ?? '-'} vec#${r.vectorRank ?? '-'}/lex#${r.lexicalRank ?? '-'}`));

    const rank = results.findIndex(r => (r.path || '').includes('consciousness-is-the-record'));
    check('storage exact title top-3', rank >= 0 && rank < 3, rank >= 0 ? `rank ${rank + 1}` : 'not in top 10');
    check('no result re-sorted over the reranked head', results[0].rerankScore !== undefined && results[0].rerankScore !== null, `head rerank=${results[0].rerankScore}`);

    const withContent = await vdb.searchDocuments({ query: 'markdown blocks spec', top_k: 5, include_content: true });
    check('include_content slices the embedded chunk', withContent.length === 5 && typeof withContent[0].content === 'string' && withContent[0].content.length > 0);

    const folderHits = await vdb.searchDocuments({ query: 'markdown blocks spec', top_k: 10, folder: 'documentation' });
    check('folder filter applies on snapshot payloads', folderHits.length > 0 && folderHits.every(r => (r.path || '').startsWith('documentation/')), `${folderHits.length} hit(s)`);

    // ── R3: extension filters across lanes ─────────────────────────────
    // Two defects from the broadening report (2026-11-20): `.md` was spelled into
    // `..md` and matched nothing, and the client-side filter ran after the
    // native top-N cut, so a lane whose top candidates happened to be .json was
    // emptied. The contract: both spellings are one request, a filter never
    // returns a non-match, and it never silently empties a lane that has
    // matching documents.
    const QUERY_R3 = 'A Little Religion v6 final';
    // The dense lane carries no .md candidate for QUERY_R3 at all (800 raw rows,
    // religion=2 and both ledger.json), so a dense filter test needs a query that
    // lane can actually serve. That distinction is the report's "dense-only
    // returns zero" boundary: correct filtering, not a filter defect.
    const QUERY_R3_DENSE = 'Consciousness Is the Record';
    // Lane isolation (issue #86): "dense only" must be the RAW dense lane. With
    // rerank left on, the cross-encoder reorders the head and the mode stops
    // being a lane probe at all — the three tables below were doing exactly that.
    const RAW_LANE = {
        dense: { dense: true, lexical: false, rerank: false },
        lexical: { dense: false, lexical: true, rerank: false }
    };
    const rawLaneCheck = (label, search, rows) => {
        if (search.rerank !== false) return;
        check(`${label}: raw lane carries no rerank scores`, rows.every(r => r.rerankScore === null || r.rerankScore === undefined));
    };
    const r3Modes = [
        ['hybrid', {}, QUERY_R3],
        ['dense-only', RAW_LANE.dense, QUERY_R3_DENSE],
        ['lexical-only', RAW_LANE.lexical, QUERY_R3]
    ];
    const idsOf = rows => rows.map(r => r.id).join('|');
    for (const [label, search, query] of r3Modes) {
        const md = await vdb.searchDocuments({ query, top_k: 5, search: { ...search }, extension: 'md' });
        const dotMd = await vdb.searchDocuments({ query, top_k: 5, search: { ...search }, extension: '.md' });
        const upper = await vdb.searchDocuments({ query, top_k: 5, search: { ...search }, extension: 'MD' });
        const deep = await vdb.searchDocuments({ query, top_k: 200, search: { ...search } });
        const deepIds = new Set(deep.map(r => r.id));
        console.log(`R3 ${label.padEnd(12)} md=${md.length} .md=${dotMd.length} MD=${upper.length} deep=${deep.length}  md-first=${md[0]?.path ?? '-'}`);
        rawLaneCheck(`R3 ${label}`, search, md);
        check(`R3 ${label}: extension filter returns matches`, md.length > 0);
        check(`R3 ${label}: ".md" equals "md"`, idsOf(dotMd) === idsOf(md) && md.length > 0);
        check(`R3 ${label}: "MD" equals "md"`, idsOf(upper) === idsOf(md) && md.length > 0);
        check(`R3 ${label}: filter returns only .md`, md.every(r => (r.path || '').toLowerCase().endsWith('.md')));
        check(`R3 ${label}: filter never invents hits`, md.every(r => deepIds.has(r.id)));

        const relFolder = await vdb.searchDocuments({ query, top_k: 5, search: { ...search }, folder: 'religion' });
        const relFolderMd = await vdb.searchDocuments({ query, top_k: 5, search: { ...search }, folder: 'religion', extension: 'md' });
        console.log(`R3 ${label.padEnd(12)} folder=religion ${relFolder.length}, +md ${relFolderMd.length}  ${relFolderMd.slice(0, 2).map(r => r.path).join(', ')}`);
        check(`R3 ${label}: folder+extension honours both`, relFolderMd.every(r => (r.path || '').startsWith('religion/') && r.path.toLowerCase().endsWith('.md')));
        // religion/ is mixed (.md and .json), so the extension must narrow the
        // folder result — but it must never erase it while matches exist.
        const relFolderMdRows = relFolder.filter(r => (r.path || '').toLowerCase().endsWith('.md'));
        check(`R3 ${label}: extension keeps matching folder hits`, relFolderMdRows.length === 0 || relFolderMd.length > 0);
    }
    for (const bad of ['md.', '..md', '', '.', '-md']) {
        let message = null;
        try {
            await vdb.searchDocuments({ query: QUERY_R3, top_k: 3, extension: bad });
        } catch (e) {
            message = e.message;
        }
        check(`R3 rejects extension ${JSON.stringify(bad)}`, message !== null, message ?? 'no error thrown');
    }
    const spaced = await vdb.searchDocuments({ query: QUERY_R3, top_k: 5, extension: ' .MD ' });
    const canonical = await vdb.searchDocuments({ query: QUERY_R3, top_k: 5, extension: '.md' });
    check('R3 whitespace/case spellings are one request', idsOf(spaced) === idsOf(canonical) && canonical.length > 0);

    // ── per-request layer selection (A/B) ──────────────────────────────
    const modes = [
        ['all layers', {}],
        ['no rerank', { rerank: false }],
        ['dense only', RAW_LANE.dense],
        ['lexical only', RAW_LANE.lexical],
        ['no diversity', { diversity: false }]
    ];
    console.log('\nA/B matrix (same query, layer by layer):');
    for (const [label, search] of modes) {
        const started = performance.now();
        const rows = await vdb.searchDocuments({ query: 'Consciousness Is the Record', top_k: 5, search });
        const ms = Math.round(performance.now() - started);
        console.log(`  ${label.padEnd(13)} ${String(ms).padStart(4)} ms  ${rows.map(r => `${r.path}#${r.splitIdx}`).join(', ') || '(none)'}`);
        check(`${label}: returns hits`, rows.length > 0);
        rawLaneCheck(label, search, rows);
        if (search.lexical === false) check('dense only: every hit carries a vector rank', rows.every(r => r.vectorRank !== null && r.vectorRank !== undefined));
        if (search.dense === false) check('lexical only: every hit carries a lexical rank', rows.every(r => r.lexicalRank !== null && r.lexicalRank !== undefined));
        if (search.dense === false) check('lexical only: no vector-only hit survives', rows.every(r => r.lexicalRank !== null && r.lexicalRank !== undefined));
        if (search.rerank !== false) check('rerank on: head carries a rerank score', rows[0].rerankScore !== undefined && rows[0].rerankScore !== null);
    }

    // Bad selections fail loudly — no silent fallback to the default search.
    for (const bad of [{ wibble: 1 }, { dense: false, lexical: false }, { rrfK: 0 }, { rerank: 'yes' }, { shortlist: 0 }]) {
        let message = null;
        try {
            await vdb.searchDocuments({ query: 'x', top_k: 3, search: bad });
        } catch (e) {
            message = e.message;
        }
        check(`rejects ${JSON.stringify(bad)}`, message !== null, message ?? 'no error thrown');
    }

    const modeLabel = vdb.describeSearchRequest({ dense: true, lexical: false, rerank: false });
    check('mode label names the active layers', modeLabel.startsWith('layers=dense'), modeLabel);

    // ── R1: rejection vs legitimate rare/single-token queries ──────────
    // Nonsense must not be presented as an answer; real rare-term and
    // single-token searches must survive. The floor only gates the reranked
    // path — dense and lexical scores are not calibrated signals.
    for (const query of ['zqxv bloraptastic nickel sorbet', 'xyzzy quantum banana radiator', 'gribble flurbex zebra']) {
        const out = await vdb.vdb_search({ query, top_k: 5 }, {});
        const text = out.content[0].text;
        console.log(`R1 storage 「${query}」 -> ${text.split('\n')[1]?.slice(0, 90)}`);
        check(`R1 storage rejects nonsense ("${query}")`, /No relevant storage matches/.test(text));
        check('R1 storage nonsense carries no 100% confidence', !text.includes('100.0%'));
    }
    for (const [query, expect] of [
        ['nConvert', /ingest\/2026/],
        ['Consciousness Is the Record', /consciousness-is-the-record/]
    ]) {
        const out = await vdb.vdb_search({ query, top_k: 5 }, {});
        const text = out.content[0].text;
        check(`R1 storage keeps legitimate query ("${query}")`, !/No relevant storage matches/.test(text) && expect.test(text));
    }
    // Measured boundary, not a bug: this German paraphrase's best storage hit
    // sits at rank 7 of the rerank shortlist (0.045), so a top_k=5 request sees
    // only 0.0015 and is rejected. Deeper retrieval and the memory lane do find
    // it (memory best 0.139). Recorded here so the trade-off stays visible.
    const germanStorage = await vdb.vdb_search({ query: 'Welche Rolle spielt Offenheit bei Modellen?', top_k: 10 }, {});
    console.log(`R1 storage German paraphrase at top_k=10 -> ${/No relevant storage matches/.test(germanStorage.content[0].text) ? 'rejected' : 'kept'}`);

    // ── R2: spelling / source-intent families ──────────────────────────
    // One intent, three surfaces (correct, misspelled, paraphrased) and three
    // lanes. The operational test record quoting the misspelled query must not
    // win, and the arena artifacts that led the dense lane must not win either.
    const R2_LANES = [['hybrid', {}], ['dense-only', RAW_LANE.dense], ['lexical-only', RAW_LANE.lexical]];
    const R2_FAMILIES = [
        ['correct', 'AI Consciousness'],
        ['misspelled', 'AI Conciousness'],
        ['paraphrase', 'is artificial intelligence conscious']
    ];
    for (const [family, query] of R2_FAMILIES) {
        for (const [lane, search] of R2_LANES) {
            const rows = await vdb.searchDocuments({ query, top_k: 5, search });
            const top = rows[0]?.path ?? '(none)';
            console.log(`R2 ${family.padEnd(12)} ${lane.padEnd(12)} rank1=${top}`);
            rawLaneCheck(`R2 ${family}/${lane}`, search, rows);
            check(`R2 ${family}/${lane}: rank 1 is consciousness material`, /conscious/i.test(top), top);
            check(`R2 ${family}/${lane}: no arena artifact at rank 1`, !/^arena-publication\//.test(top), top);
            check(`R2 ${family}/${lane}: operational test record is not rank 1`, !/architecture_recall-refactor/.test(top), top);
        }
    }
    const misspelledSearch = await vdb.vdb_search({ query: 'AI Conciousness', top_k: 5 }, {});
    check('R2 misspelled query reports its correction', /corrected: Conciousness → consciousness/.test(misspelledSearch.content[0].text), misspelledSearch.content[0].text.split('\n').slice(0, 2).join(' | '));
    // Deterministic guard: a legitimate inflection is not a typo.
    const inflected = await vdb.vdb_search({ query: 'which reranker model is licensed for production', top_k: 5 }, {});
    check('R2 inflections are left alone', !inflected.content[0].text.includes('corrected:'));

    const memStarted = performance.now();
    const reply = await memory.memory_recall({ query: 'German public funding Prototype Fund open source application window', limit: 5 }, context);
    const memoryMs = Math.round(performance.now() - memStarted);
    const text = reply.content[0].text;
    console.log(`\nmemory top-5 (${memoryMs} ms):\n${text.split('\n').filter(l => l.startsWith('[#')).join('\n')}`);
    const order = [...text.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]));
    const memRank = order.indexOf(6830);
    check('memory #6830 top-3', memRank >= 0 && memRank < 3, memRank >= 0 ? `rank ${memRank + 1}` : 'not in the recalled set');

    // Exact-quote positive control from the broadening report: a legitimate
    // exact-quote query must keep its target at rank 1 — the echo demotion must
    // not swallow real quoted searches.
    const quote = await memory.memory_recall({ query: 'A Little Religion v6 final', limit: 3 }, context);
    const quoteIds = [...quote.content[0].text.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]));
    check('exact-quote positive control: #2103 rank 1', quoteIds[0] === 2103, quoteIds.slice(0, 3).map(id => `#${id}`).join(', '));

    // ── R1 memory: nonsense rejected, rare/single-token kept ───────────
    for (const query of ['zqxv bloraptastic nickel sorbet', 'xyzzy quantum banana radiator']) {
        const out = await memory.memory_recall({ query, limit: 5 }, context);
        const text = out.content[0].text;
        console.log(`R1 memory 「${query}」 -> ${text.split('\n')[1]?.slice(0, 90)}`);
        check(`R1 memory rejects nonsense ("${query}")`, /No relevant memories/.test(text));
        check('R1 memory nonsense carries no 100% confidence', !text.includes('100.0%'));
    }
    for (const [query, id] of [['Prototype', 6830], ['nui_wc2', 3437]]) {
        const out = await memory.memory_recall({ query, limit: 3 }, context);
        const text = out.content[0].text;
        const first = [...text.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]))[0];
        check(`R1 memory keeps legitimate single-token "${query}" at rank 1`, !/No relevant memories/.test(text) && first === id, `first=#${first}`);
    }
    const german = await memory.memory_recall({ query: 'Welche Rolle spielt Offenheit bei Modellen?', limit: 5 }, context);
    check('R1 memory keeps a German paraphrase (no false rejection)', !/No relevant memories/.test(german.content[0].text));

    // Current-versus-historical intent must survive every ranking change.
    for (const [query, expected] of [
        ['Which model currently generates nConvert summaries?', 6716],
        ['What was nConvert summary routing before the local switch?', 6593]
    ]) {
        const out = await memory.memory_recall({ query, limit: 3 }, context);
        const first = [...out.content[0].text.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]))[0];
        check(`current-vs-historical intent preserved ("${query}")`, first === expected, `first=#${first}, expected #${expected}`);
    }

    // ── Prototype Fund source-intent regression (2026-11-20) ───────────
    // A verification record (#7137) quotes this exact query in its data, so both
    // lanes read it as a perfect match and it outranked #6830, the funding
    // memory that answers the query. The echo demotion must put #6830 back at
    // rank 1 without removing the record — it stays stored and returned.
    const proto = await memory.memory_recall({ query: 'Prototype Fund 47.5k application November 30 funding', limit: 5 }, context);
    const protoText = proto.content[0].text;
    console.log(`\nPrototype Fund golden:\n${protoText.split('\n').filter(l => l.startsWith('[#') || l.startsWith('mode:')).join('\n')}`);
    const protoOrder = [...protoText.matchAll(/\[#(\d+)\]/g)].map(m => Number(m[1]));
    check('Prototype Fund: #6830 rank 1', protoOrder[0] === 6830, protoOrder.slice(0, 3).map(id => `#${id}`).join(', '));
    check('Prototype Fund: echoed record is not rank 1', protoOrder[0] !== 7137);
    // Relevance display suppresses the demoted record from the answer set — it
    // scores ~0.0007 and must not be presented as a candidate. It is still
    // stored and still listed (marked ·echo) when the caller asks for depth.
    check('Prototype Fund: echoed record is not presented in the top 5', !protoOrder.includes(7137), protoOrder.join(', '));
    // The demotion is a position multiplier, so within a 200-row recall the
    // record lands mid-list — out of any ordinary depth. What must hold is that
    // it is suppressed as an answer and never deleted.
    const stillStored = await memory.memory_get({ id: 7137 }, context);
    check('Prototype Fund: echoed record is still stored', stillStored.content[0].text.includes('#7137'));

    console.log(`\nlatency: storage ${storageMs} ms, memory ${memoryMs} ms`);
} finally {
    await vdb.shutdown().catch(() => {});
    await memory.shutdown().catch(() => {});
    if (!keep) fs.rmSync(workRoot, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nGOLDEN GATE PASSED' : `\nGOLDEN GATE FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
