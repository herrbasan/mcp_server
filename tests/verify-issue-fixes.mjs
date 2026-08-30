// Throwaway runtime verification for issues #22 #23 #24 #13 (2026-08-30).
// Compiles is never success — this exercises the REAL code paths in-process:
//   #22: src/lib/fileops.js  replace/find line-ending-agnostic matching
//   #23: memory.list sort/limit (temp nDB, real memory agent init)
//   #24: dreaming/between.js non-trivial gate + entry text (pure functions)
//   #13: llm pinned-model sessions (mock gateway, full lifecycle)
// Run: node tests/verify-issue-fixes.mjs
// Exit 0 = all green. Cleans up its temp dir under data/_test/.
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TMP = join(ROOT, 'data', '_test', 'verify-issues');

let pass = 0, fail = 0;
function ok(cond, label, detail = '') {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ''}`); }
}
async function throws(fn, label, match = null) {
    try {
        await fn();
        ok(false, label, 'expected a throw, got none');
    } catch (e) {
        ok(!match || (match instanceof RegExp ? match.test(e.message) : String(e.message).includes(match)),
            label, match ? `message did not match ${match}: "${e.message}"` : e.message);
    }
}
const section = (t) => console.log(`\n── ${t} ──`);

rmSync(TMP, { recursive: true, force: true });

// ═══════════════════════════════════════════════════════════════
section('#22 fileops: CRLF-agnostic replace + find');
{
    const { createFileOps } = await import('../src/lib/fileops.js');
    const dir = join(TMP, 'fileops');
    mkdirSync(dir, { recursive: true });
    const ops = createFileOps({ root: dir, translator: null });

    // CRLF file, LF marker — the exact repro from the issue
    const crlfBody = ['line one', '  - ../AGENTS.md', '  - ../AGENTS.md', 'line four'].join('\r\n') + '\r\n';
    writeFileSync(join(dir, 'crlf.md'), crlfBody);
    await ops.replace('crlf.md', '  - ../AGENTS.md\n  - ../AGENTS.md', '  - REPLACED', { occurrence: 'first' });
    const after = readFileSync(join(dir, 'crlf.md'), 'utf8');
    ok(after.includes('  - REPLACED'), 'LF marker matched CRLF file (replace)');
    ok(!after.includes('AGENTS.md'), 'marker text removed');
    ok(!/[^\r]\n/.test(after), 'file stays CRLF after write-back');
    ok(after.startsWith('line one\r\n'), 'untouched region byte-stable');

    // find with LF marker on CRLF file
    const f = await ops.find('crlf.md', 'REPLACED\nline four');
    ok(f.found === true && f.line === 2, 'find: LF marker matches CRLF file with correct line', JSON.stringify(f));

    // offset in raw coordinates (LF-land idx maps through inserted \r)
    ok(f.offset === readFileSync(join(dir, 'crlf.md'), 'utf8').indexOf('REPLACED\nline four'.replace('\n', '\r\n')),
        'find: offset reported in raw coordinates', String(f.offset));

    // occurrence 'all' with LF markers on CRLF file
    writeFileSync(join(dir, 'all.md'), 'x\r\na\r\nb\r\na\r\nb\r\ny\r\n');
    const r = await ops.replace('all.md', 'a\nb', 'Z', { occurrence: 'all' });
    ok(r.replacements === 2, 'replace all: both LF-marker occurrences matched');
    ok(readFileSync(join(dir, 'all.md'), 'utf8') === 'x\r\nZ\r\nZ\r\ny\r\n', 'replace all: content + CRLF preserved');

    // LF file with CRLF marker (reverse direction)
    writeFileSync(join(dir, 'lf.md'), 'one\ntwo\nthree\n', 'utf8');
    await ops.replace('lf.md', 'two\r\nthree', 'TWO-THREE');
    ok(readFileSync(join(dir, 'lf.md'), 'utf8') === 'one\nTWO-THREE\n', 'CRLF marker matches LF file, LF preserved');

    // mixed file → dominant convention wins (2 CRLF vs 1 lone LF)
    writeFileSync(join(dir, 'mixed.md'), 'p\r\nq\r\nr\ns\r\nt');
    await ops.replace('mixed.md', 'r\ns', 'RS');
    ok(readFileSync(join(dir, 'mixed.md'), 'utf8') === 'p\r\nq\r\nRS\r\nt', 'mixed file normalized to dominant CRLF');

    // fail-loud paths survive the refactor
    await throws(() => ops.replace('crlf.md', 'NOT\nPRESENT', 'x'), 'marker-not-found still throws', /marker not found/);
    await throws(() => ops.replace('crlf.md', 'REPLACED', 'REPLACED'), 'identical replacement still throws', /identical to marker/);

    // directory-mode find sees CRLF files through LF markers
    writeFileSync(join(dir, 'sub_crlf.md'), 'k\r\ntarget line\r\nend\r\n');
    const dirFind = await ops.find('.', 'target line\nend');
    ok(dirFind.found === true && dirFind.files.some(h => h.path.includes('sub_crlf.md')),
        'find directory mode: LF marker hits CRLF file', JSON.stringify(dirFind));
}

// ═══════════════════════════════════════════════════════════════
section('#24 dreaming: non-trivial gate + entry text');
{
    const between = await import('../src/agents/dreaming/between.js');
    // also proves the dreaming module graph loads (imports memory agent too)
    await import('../src/agents/dreaming/index.js');

    const { isNonTrivialDream, dreamEntryText, isValidBetweenSummary } = between;
    const act = (a) => ({ meta: { activity: a } });

    ok(isNonTrivialDream(act({ edges_added: 6 })) === true, 'gate: edges formed → non-trivial');
    ok(isNonTrivialDream(act({ bridges_added: 2 })) === true, 'gate: new bridge → non-trivial');
    ok(isNonTrivialDream(act({ clusters_added: 1 })) === true, 'gate: cluster organized → non-trivial');
    ok(isNonTrivialDream(act({ compressed: 3 })) === true, 'gate: compression → non-trivial');
    ok(isNonTrivialDream(act({ nodes_added: 30, nodes_updated: 5 })) === false, 'gate: pure embedding → NOT non-trivial (the #24 bug)');
    ok(isNonTrivialDream(act({ surging_nodes: [1, 2] })) === false, 'gate: score drift alone → NOT non-trivial');
    ok(isNonTrivialDream({ meta: {} }) === false, 'gate: no activity → false');

    const map = { meta: { activity: { edges_added: 6, bridges_added: 2, clusters_added: 1, compressed: 0 }, delta: { surging_nodes: [1, 2], decayed_nodes: [3] } }, clusters: [{ id: 'c_between' }], nodes: [{ id: 1 }, { id: 2 }] };
    const entry = dreamEntryText(map, 'gemma-4-e4b-dreamer on Badkid');
    ok(/^I \(the dreamer, \[gemma-4-e4b-dreamer on Badkid\]\) tended the map: connected 6, bridged 2 pairs, formed 1 cluster, watched 2 surge, let 1 fade\.$/.test(entry.description),
        'entry text: full activity sentence', entry.description);
    ok(isValidBetweenSummary(entry.description) === true, 'entry text: passes enforceBetween summary validation');
    await throws(() => dreamEntryText(map, ''), 'entry text: missing substrate label throws', /substrateLabel/);

    const minimal = dreamEntryText({ meta: { activity: { edges_added: 1 } }, clusters: [], nodes: [] }, 'x');
    ok(minimal.description === 'I (the dreamer, [x]) tended the map: connected 1.', 'entry text: minimal');
}

// ═══════════════════════════════════════════════════════════════
section('#23 memory_list: sort + limit');
{
    const { Database } = (await import('../src/agents/memory/ndb-loader.js')).loadNdb();
    const memDir = join(TMP, 'memory');
    mkdirSync(memDir, { recursive: true });
    const dbPath = join(memDir, 'data.jsonl');

    // Seed BEFORE the agent opens it: _meta + 5 memories, ids 1..5, known timestamps
    const seeder = Database.open(dbPath, { persistence: 'immediate' });
    seeder.insertWithPrefix('_meta', { nextId: 6, migratedAt: new Date().toISOString() });
    const seeds = [
        { id: 1, description: 'oldest seed entry', category: 'seed', confidence: 0.5, timestamp: '2026-08-25T10:00:00Z', embedStatus: 'embedded' },
        { id: 2, description: 'early seed entry', category: 'seed', confidence: 0.5, timestamp: '2026-08-26T10:00:00Z', embedStatus: 'embedded' },
        { id: 3, description: 'middle seed entry', category: 'other', confidence: 0.5, timestamp: '2026-08-27T10:00:00Z', embedStatus: 'embedded' },
        { id: 4, description: 'late seed entry', category: 'seed', confidence: 0.5, timestamp: '2026-08-28T10:00:00Z', embedStatus: 'embedded' },
        { id: 5, description: 'newest seed entry', category: 'other', confidence: 0.5, timestamp: '2026-08-29T10:00:00Z', embedStatus: 'embedded' }
    ];
    for (const s of seeds) seeder.insertWithPrefix('mem', s);
    seeder.flush();

    const memoryAgent = await import('../src/agents/memory/index.js');
    const agents = new Map(); // no vdb agent — init degrades with a warning
    await memoryAgent.init({ gateway: null, config: { agents: { memory: { dbPath: 'data/_test/verify-issues/memory/data.jsonl' } } }, agents });
    const list = async (args) => (await memoryAgent.memory_list(args, {})).content[0].text;

    const all = await list({});
    ok(all.includes('5 memories (all categories, newest-first)'), 'default: newest-first header', all.split('\n')[0]);
    ok(all.indexOf('#5]') < all.indexOf('#1]'), 'default: #5 before #1');

    const oldest = await list({ sort: 'oldest' });
    ok(oldest.indexOf('#1]') < oldest.indexOf('#5]'), 'sort oldest: #1 before #5');

    const limited = await list({ limit: 2 });
    ok(limited.includes('2 memories') && limited.includes('#5]') && limited.includes('#4]') && !limited.includes('#3]'),
        'limit 2: returns the 2 newest only');
    ok(limited.includes('of 5 shown'), 'limit: truncation hint present');

    const cat = await list({ category: 'seed', limit: 1 });
    ok(cat.includes('#4]') && !cat.includes('#5]'), 'category filter + limit combine');

    await throws(() => list({ limit: 'ten' }), 'limit validation: string throws', /positive integer/);
    await throws(() => list({ limit: 0 }), 'limit validation: zero throws', /positive integer/);
    await throws(() => list({ sort: 'sideways' }), 'sort validation: bad value throws', /newest.*oldest/);
}

// ═══════════════════════════════════════════════════════════════
section('#13 llm: pinned-model sessions');
{
    const llm = await import('../src/agents/llm/index.js');
    const chatCalls = [];
    const gateway = {
        listModels: async () => [{ id: 'mock-a' }, { id: 'mock-b' }],
        chat: async (args) => {
            chatCalls.push(args);
            return { content: `reply[model=${args.model}] msgs=${args.messages.length}${args.systemPrompt ? ' sys' : ''}` };
        }
    };
    const cfg = (over = {}) => ({ config: { agents: { llm: { sessionTtlMinutes: 60, sessionMaxSessions: 2, ...over } } } });

    await throws(
        () => llm.llm_session_create({ model: 'nope' }, { gateway, ...cfg() }),
        'create: unknown model fails fast', /unknown model "nope".*mock-a, mock-b/s);
    await throws(() => llm.llm_session_create({}, { gateway, ...cfg() }), 'create: missing model throws', /model required/);

    const file = join(TMP, 'ingest.txt');
    writeFileSync(file, 'ingested body');
    const created = JSON.parse((await llm.llm_session_create({ model: 'mock-a', files: [file] }, { gateway, ...cfg() })).content[0].text);
    ok(created.sessionId && created.model === 'mock-a' && created.files_ingested === 1 && created.messages === 2,
        'create: session summary', JSON.stringify(created));

    const q1 = (await llm.llm_session_query({ sessionId: created.sessionId, prompt: 'what did I ingest?' }, { gateway, ...cfg() })).content[0].text;
    ok(q1 === 'reply[model=mock-a] msgs=3', 'query: replays ingest + turn, pinned model used', q1);
    ok(chatCalls[0].task === undefined, 'query: no task sent (task would override the pin in gateway-client)');

    const q2 = (await llm.llm_session_query({ sessionId: created.sessionId, prompt: 'again', model: 'mock-b' }, { gateway, ...cfg() })).content[0].text;
    ok(q2.includes('model=mock-b') && q2.includes('msgs=5'), 'query: per-call model override wins, history grows');
    const q3 = (await llm.llm_session_query({ sessionId: created.sessionId, prompt: 'pinned again?' }, { gateway, ...cfg() })).content[0].text;
    ok(q3.includes('model=mock-a'), 'query: pin survives a per-call override');

    await throws(() => llm.llm_session_query({ sessionId: 'lls_missing', prompt: 'x' }, { gateway, ...cfg() }), 'query: unknown session throws', /unknown or expired/);
    await throws(() => llm.llm_session_query({ sessionId: created.sessionId, prompt: '' }, { gateway, ...cfg() }), 'query: empty prompt throws', /prompt required/);

    const c2 = JSON.parse((await llm.llm_session_create({ model: 'mock-b' }, { gateway, ...cfg() })).content[0].text);
    await throws(() => llm.llm_session_create({ model: 'mock-a' }, { gateway, ...cfg() }), 'create: session cap enforced', /session limit \(2\)/);

    const closed = (await llm.llm_session_close({ sessionId: c2.sessionId }, { gateway, ...cfg() })).content[0].text;
    ok(closed.includes(c2.sessionId), 'close: reports closed session');
    await throws(() => llm.llm_session_close({ sessionId: c2.sessionId }, { gateway, ...cfg() }), 'close: double close throws');

    // TTL expiry (lazy sweep): 60ms TTL, wait, then the session is gone
    const ttl = JSON.parse((await llm.llm_session_create({ model: 'mock-a' }, { gateway, ...cfg({ sessionTtlMinutes: 0.001 }) })).content[0].text);
    await new Promise(r => setTimeout(r, 120));
    await throws(() => llm.llm_session_query({ sessionId: ttl.sessionId, prompt: 'x' }, { gateway, ...cfg({ sessionTtlMinutes: 0.001 }) }), 'TTL: expired session vanishes loudly');
}

// ═══════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}\n${pass} passed, ${fail} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
