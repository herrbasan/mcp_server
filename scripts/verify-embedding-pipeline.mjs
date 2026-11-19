// End-to-end embedding pipeline provenance probe. The SAME five golden storage
// chunk inputs are hashed at every stage so the FIRST mismatch localizes the
// fault: direct llama.cpp HTTP -> llama-cpp-wrapper HTTP -> createEmbedClient
// (mcp/gateway shape) -> disposable nVDB insert/get/flush/reopen/get. Single and
// batch modes are measured separately, and single-vs-batch is compared per input
// inside each stage. Writes only temp nVDB dirs under <repo>\.cache (removed
// after close) and one JSON report under the snapshot's reports directory.
// Vectors compare on SHA-256 of their Float64 bytes; because nVDB stores f32 the
// readback boundary compares on the f32-canonical hash (Math.fround of each
// value), which the inserted representation must equal exactly. Inputs appear in
// the report as id, short label, char count and SHA-256 only — never text, and
// the gateway access key is never logged or reported.
//
//   node scripts/verify-embedding-pipeline.mjs [--snapshot <dir>] [--direct <url>]
//        [--wrapper <url>] [--gateway <url>] [--model <id>] [--reports <dir>] [--out <file>] [--no-report]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmbedClient } from '../src/embed-client.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import { reconstructStorageChunk, sha256Text } from './repair-memory-lab-vectors.mjs';
import { loadGoldenSuite, resolveSnapshotLayout, vectorHash } from './memory-lab-phase0.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const TOOL = 'verify-embedding-pipeline';
export const REPORT_VERSION = 1;
export const DEFAULT_SNAPSHOT = 'D:\\MCP_Lab\\memory-refactor\\baseline-2026-11-17';
export const DEFAULT_DIRECT_URL = 'http://192.168.0.145:4081';
export const DEFAULT_WRAPPER_URL = 'http://192.168.0.145:4080';
export const DEFAULT_MODEL = 'qwen/qwen3-embedding-4b-gguf';
export const NVDB_COLLECTION = 'provenance';
export const STAGE_NAMES = ['direct-single', 'wrapper-single', 'mcp-single', 'nvdb-single', 'direct-batch', 'wrapper-batch', 'mcp-batch', 'nvdb-batch'];

// `hash`    — SHA-256 over the Float64 bytes exactly as returned.
// `hashF32` — SHA-256 over the Float64 bytes of Math.fround(value): the value
//             nVDB actually stores, hence the only honest readback boundary.
export function describeVector(vector, expectedDim) {
    if (vector === undefined || vector === null) return { present: false };
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) throw new Error(`describeVector: expected an array-like vector, got ${typeof vector}`);
    const f32 = new Float64Array(vector.length);
    let finite = true;
    let sumSquares = 0;
    for (let i = 0; i < vector.length; i++) {
        const value = vector[i];
        if (!Number.isFinite(value)) {
            finite = false;
            break;
        }
        sumSquares += value * value;
        f32[i] = Math.fround(value);
    }
    return {
        present: true,
        dim: vector.length,
        dimOk: vector.length === expectedDim,
        finite,
        nonzero: finite && sumSquares > 0,
        hash: finite ? vectorHash(vector) : null,
        hashF32: finite ? crypto.createHash('sha256').update(Buffer.from(f32.buffer)).digest('hex') : null
    };
}

// nVDB normalizes payload key order, so payload equality is order-insensitive.
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function shortLabel(id) {
    const [filePath, chunk] = String(id).replace(/^storage:/, '').split('#');
    const base = filePath.split('/').pop();
    return chunk === undefined ? base : `${base}#${chunk}`;
}

// Responses are placed by their declared `index`, never by array position — a
// provider that mislabels an index is exactly the batch-mapping fault this
// probe exists to catch.
export function extractVectors(payload, count, { mode, stage }) {
    if (!payload || !Array.isArray(payload.data)) throw new Error(`${stage}: response has no data array (got ${payload === null ? 'null' : typeof payload?.data})`);
    if (payload.data.length !== count) throw new Error(`${stage}: expected ${count} embeddings, got ${payload.data.length}`);
    const out = new Array(count);
    for (let pos = 0; pos < payload.data.length; pos++) {
        const item = payload.data[pos];
        if (item === null || typeof item !== 'object') throw new Error(`${stage}: response item at position ${pos} is not an object`);
        if (mode === 'single') {
            if ('index' in item && item.index !== 0) throw new Error(`${stage}: single response index ${String(item.index)} — expected 0`);
            if (!Array.isArray(item.embedding)) throw new Error(`${stage}: response item has no embedding array`);
            out[0] = item.embedding;
            continue;
        }
        if (!Number.isInteger(item.index)) throw new Error(`${stage}: response item at position ${pos} has no integer index (got ${String(item.index)})`);
        if (item.index < 0 || item.index >= count) throw new Error(`${stage}: response index ${item.index} out of range 0..${count - 1}`);
        if (out[item.index] !== undefined) throw new Error(`${stage}: response repeats index ${item.index}`);
        if (!Array.isArray(item.embedding)) throw new Error(`${stage}: response index ${item.index} has no embedding array`);
        out[item.index] = item.embedding;
    }
    return out;
}

async function postEmbeddings({ url, model, input, fetchImpl, timeoutMs = 300000 }) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetchImpl(`${url.replace(/\/+$/, '')}/v1/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, input }),
            signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function runHttpStage({ stage, url, model, texts, mode, fetchImpl, expectedDim }) {
    try {
        const vectors = [];
        // Single mode is one request per input — the shape production search uses.
        for (const input of mode === 'single' ? texts : [texts]) {
            const payload = await postEmbeddings({ url, model, input, fetchImpl });
            vectors.push(...extractVectors(payload, mode === 'single' ? 1 : texts.length, { mode, stage }));
        }
        return { available: true, error: null, vectors, entries: vectors.map((vector, index) => ({ id: null, index, ...describeVector(vector, expectedDim) })) };
    } catch (e) {
        return { available: false, error: `${e.name ?? 'Error'}: ${e.message}`, entries: [], vectors: null };
    }
}

async function runMcpStage({ stage, embedder, texts, mode, expectedDim }) {
    try {
        const vectors = [];
        if (mode === 'single') {
            for (const text of texts) vectors.push(await embedder.embed(text, { background: true }));
        } else {
            vectors.push(...await embedder.embedBatch(texts, { background: true }));
        }
        if (vectors.length !== texts.length) throw new Error(`embedder returned ${vectors.length} vectors for ${texts.length} inputs`);
        return { available: true, error: null, vectors, entries: vectors.map((vector, index) => ({ id: null, index, ...describeVector(vector, expectedDim) })) };
    } catch (e) {
        return { available: false, error: `${e.name ?? 'Error'}: ${e.message}`, entries: [], vectors: null };
    }
}

function closeQuietly(target) {
    if (target && typeof target.close === 'function') {
        try { target.close(); } catch { /* already closed */ }
    }
}

// Insert the returned vectors under the golden ids/payloads into a fresh
// collection, flush, close, reopen and read back. The inserted vector is
// f32-quantized because that is nVDB's storage type, so readback must equal it.
async function runNvdbStage({ stage, inputs, vectors, expectedDim, nvdbFactory, tmpRoot }) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, `nvdb-${stage}-`));
    let db = null;
    let coll = null;
    try {
        const { Database } = nvdbFactory();
        db = new Database(dir);
        coll = db.createCollection(NVDB_COLLECTION, expectedDim);
        const inserted = vectors.map((vector) => Array.from(vector, Math.fround));
        for (let i = 0; i < inputs.length; i++) coll.insert(inputs[i].id, inserted[i], JSON.stringify(inputs[i].payload));
        if (typeof coll.flush === 'function') coll.flush();
        closeQuietly(coll);
        coll = null;
        closeQuietly(db);
        db = null;

        const reopened = new Database(dir);
        const readColl = reopened.getCollection(NVDB_COLLECTION);
        const entries = inputs.map((input, i) => {
            const doc = readColl.get(input.id);
            if (!doc || doc.vector === undefined || doc.vector === null) throw new Error(`${stage}: readback missing document ${input.id} after reopen`);
            const preInsert = describeVector(inserted[i], expectedDim);
            let payloadMatch = false;
            try { payloadMatch = stableStringify(JSON.parse(doc.payload)) === stableStringify(input.payload); } catch { payloadMatch = false; }
            return {
                id: input.id,
                index: i,
                ...describeVector(doc.vector, expectedDim),
                preInsertHash: preInsert.hash,
                preInsertHashF32: preInsert.hashF32,
                payloadMatch
            };
        });
        closeQuietly(readColl);
        closeQuietly(reopened);
        return { available: true, error: null, entries };
    } catch (e) {
        return { available: false, error: `${e.name ?? 'Error'}: ${e.message}`, entries: [] };
    } finally {
        closeQuietly(coll);
        closeQuietly(db);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function duplicateGroups(entries) {
    const byHash = new Map();
    for (const entry of entries) {
        if (!entry.hash) continue;
        if (!byHash.has(entry.hash)) byHash.set(entry.hash, []);
        byHash.get(entry.hash).push(entry.id);
    }
    return [...byHash.entries()].filter(([, ids]) => ids.length > 1).map(([hash, ids]) => ({ hash, ids }));
}

function compare(report, inputs, label, key, pickA, pickB, dependsOn) {
    const unavailable = dependsOn.filter((name) => !report.stages[name]?.available);
    if (unavailable.length > 0) {
        const skipped = { pair: label, comparedOn: key, equal: null, skipped: `stage unavailable: ${unavailable.join(', ')}`, mismatches: [] };
        report.comparisons.push(skipped);
        return skipped;
    }
    const mismatches = [];
    for (const input of inputs) {
        let a;
        let b;
        try {
            a = pickA(input.id);
            b = pickB(input.id);
        } catch (e) {
            mismatches.push({ inputId: input.id, reason: `${e.name}: ${e.message}` });
            continue;
        }
        if (a === null || a === undefined || b === null || b === undefined) {
            mismatches.push({ inputId: input.id, reason: 'hash unavailable (missing or non-finite vector)' });
            continue;
        }
        if (a !== b) mismatches.push({ inputId: input.id, a, b });
    }
    const record = { pair: label, comparedOn: key, equal: mismatches.length === 0, mismatches };
    report.comparisons.push(record);
    return record;
}

export function findFirstMismatch(report) {
    for (const record of report.comparisons) {
        if (record.equal !== false || record.mismatches.length === 0) continue;
        const first = record.mismatches[0];
        const [stageA, stageB] = record.pair.split(' vs ');
        return {
            inputId: first.inputId,
            stageA,
            stageB,
            comparedOn: record.comparedOn,
            hashA: first.a ?? null,
            hashB: first.b ?? null,
            reason: first.reason ?? null,
            note: `first divergence in ${record.pair} for ${first.inputId}`
        };
    }
    return null;
}

// ── orchestration ────────────────────────────────────────────────────────────

export async function runPipelineProvenance({
    inputs,
    directUrl = DEFAULT_DIRECT_URL,
    wrapperUrl = DEFAULT_WRAPPER_URL,
    model = DEFAULT_MODEL,
    expectedDim = 2560,
    embedder,
    fetchImpl = (...args) => globalThis.fetch(...args),
    nvdbFactory = loadNvdb,
    tmpRoot = path.join(REPO_ROOT, '.cache')
}) {
    if (!Array.isArray(inputs) || inputs.length !== 5) throw new Error(`runPipelineProvenance: exactly 5 golden inputs are required (got ${Array.isArray(inputs) ? inputs.length : typeof inputs})`);
    for (const input of inputs) {
        if (typeof input?.id !== 'string' || typeof input?.text !== 'string' || !input.payload) throw new Error('runPipelineProvenance: every input needs id, text and payload');
    }
    if (!embedder) throw new Error('runPipelineProvenance: embedder (createEmbedClient) is required');
    fs.mkdirSync(tmpRoot, { recursive: true });

    const texts = inputs.map((input) => input.text);
    const report = {
        tool: TOOL,
        reportVersion: REPORT_VERSION,
        createdAt: new Date().toISOString(),
        ok: false,
        verdict: null,
        environment: {
            directUrl,
            wrapperUrl,
            gatewayUrl: embedder.describeUrl ?? null,
            model,
            expectedDim,
            vectorHashing: { hash: 'SHA-256 over Float64 bytes as returned', hashF32: 'SHA-256 over Float64 bytes of Math.fround(value)', note: 'HTTP stages compare on hash; the nVDB readback boundary on hashF32' },
            nvdb: { collection: NVDB_COLLECTION, durability: 'temp dir, created and deleted per stage' }
        },
        inputs: inputs.map((input) => ({ id: input.id, label: shortLabel(input.id), textSha256: sha256Text(input.text), charCount: input.text.length })),
        stages: {},
        comparisons: [],
        firstMismatch: null,
        unavailable: [],
        warnings: []
    };

    const http = (name, url, mode) => () => runHttpStage({ stage: name, url, model, texts, mode, fetchImpl, expectedDim });
    const mcp = (name, mode) => () => runMcpStage({ stage: name, embedder, texts, mode, expectedDim });
    const runs = {
        'direct-single': http('direct-single', directUrl, 'single'),
        'wrapper-single': http('wrapper-single', wrapperUrl, 'single'),
        'mcp-single': mcp('mcp-single', 'single'),
        'direct-batch': http('direct-batch', directUrl, 'batch'),
        'wrapper-batch': http('wrapper-batch', wrapperUrl, 'batch'),
        'mcp-batch': mcp('mcp-batch', 'batch')
    };
    for (const [name, run] of Object.entries(runs)) {
        const result = await run();
        if (result.available) result.entries = result.entries.map((entry, i) => ({ ...entry, id: inputs[i].id }));
        const vectors = result.vectors ?? null;
        delete result.vectors;
        report.stages[name] = result;
        if (!name.startsWith('mcp-')) continue;
        // nVDB consumes the mcp response vectors, so the only new information it
        // adds is what survives the store/reopen boundary.
        const nvdbName = name.replace('mcp-', 'nvdb-');
        report.stages[nvdbName] = vectors
            ? await runNvdbStage({ stage: nvdbName, inputs, vectors, expectedDim, nvdbFactory, tmpRoot })
            : { available: false, error: `skipped: ${name} produced no vectors`, entries: [] };
    }

    for (const name of STAGE_NAMES) {
        const stage = report.stages[name];
        if (!stage.available) {
            report.unavailable.push({ stage: name, error: stage.error });
            continue;
        }
        stage.duplicateGroups = duplicateGroups(stage.entries);
        stage.distinct = stage.duplicateGroups.length === 0;
        stage.badDim = stage.entries.filter((entry) => entry.dimOk === false || entry.finite === false || entry.nonzero === false).map((entry) => entry.id);
        if (stage.badDim.length > 0) report.warnings.push(`${name}: structurally invalid vectors for ${stage.badDim.join(', ')}`);
        if (!stage.distinct) report.warnings.push(`${name}: provider duplicate — ${stage.duplicateGroups.map((group) => group.ids.join('=')).join('; ')}`);
        if (name.startsWith('nvdb-')) {
            stage.payloadMismatch = stage.entries.filter((entry) => entry.payloadMatch === false).map((entry) => entry.id);
            if (stage.payloadMismatch.length > 0) report.warnings.push(`${name}: payload did not round-trip for ${stage.payloadMismatch.join(', ')}`);
        }
    }

    const entryOf = (name, id) => {
        if (!report.stages[name].available) throw new Error(`stage ${name} unavailable`);
        const found = report.stages[name].entries.find((entry) => entry.id === id);
        if (!found) throw new Error(`stage ${name} has no entry for ${id}`);
        return found;
    };
    const field = (name, key) => (id) => entryOf(name, id)[key];

    const pairs = [
        ['direct-single', 'wrapper-single', 'hash'],
        ['wrapper-single', 'mcp-single', 'hash'],
        ['mcp-single', 'nvdb-single', 'hashF32'],
        ['direct-batch', 'wrapper-batch', 'hash'],
        ['wrapper-batch', 'mcp-batch', 'hash'],
        ['mcp-batch', 'nvdb-batch', 'hashF32']
    ];
    for (const [a, b, key] of pairs) compare(report, inputs, `${a} vs ${b}`, key, field(a, key), field(b, key), [a, b]);
    for (const mode of ['single', 'batch']) {
        const name = `nvdb-${mode}`;
        compare(report, inputs, `${name} pre-insert vs readback`, 'hashF32', field(name, 'preInsertHashF32'), field(name, 'hashF32'), [name]);
    }
    for (const name of ['direct', 'wrapper', 'mcp', 'nvdb']) {
        compare(report, inputs, `${name}-single vs ${name}-batch`, 'hash', field(`${name}-single`, 'hash'), field(`${name}-batch`, 'hash'), [`${name}-single`, `${name}-batch`]);
    }

    report.firstMismatch = findFirstMismatch(report);
    report.finishedAt = new Date().toISOString();

    const requiredSingles = ['direct-single', 'wrapper-single', 'mcp-single', 'nvdb-single'];
    const missingSingles = report.unavailable.filter((entry) => requiredSingles.includes(entry.stage)).map((entry) => entry.stage);
    const unhealthy = STAGE_NAMES.filter((name) => report.stages[name].available && (!report.stages[name].distinct || report.stages[name].badDim.length > 0));
    report.ok = missingSingles.length === 0 && report.firstMismatch === null && unhealthy.length === 0;
    if (missingSingles.length > 0) {
        report.verdict = `STAGE UNAVAILABLE: ${missingSingles.join(', ')} — cannot claim a healthy pipeline`;
    } else if (report.firstMismatch) {
        const m = report.firstMismatch;
        report.verdict = `FIRST MISMATCH: ${m.inputId} — ${m.stageA} vs ${m.stageB} (${m.comparedOn})`;
    } else if (unhealthy.length > 0) {
        report.verdict = `STAGES UNHEALTHY (duplicate or invalid vectors): ${unhealthy.join(', ')}`;
    } else {
        const batchMissing = report.unavailable.filter((entry) => !requiredSingles.includes(entry.stage)).map((entry) => entry.stage);
        report.verdict = batchMissing.length > 0
            ? `all four single-mode stages agree bit for bit; batch mode unavailable for ${batchMissing.join(', ')}`
            : 'all stages agree bit for bit in both modes';
    }
    return report;
}

// ── real inputs ──────────────────────────────────────────────────────────────

// The five golden explicit storage chunk ids resolved to their exact embed text
// from the WORK copy of storage (payload.absolutePath is never read).
export function loadGoldenStorageInputs({ snapshot = DEFAULT_SNAPSHOT, goldenPath = path.join(REPO_ROOT, 'tests', 'fixtures', 'memory-lab-phase0-golden.json') }) {
    const layout = resolveSnapshotLayout(snapshot);
    const suite = loadGoldenSuite(goldenPath);
    const ids = suite.explicitVectorIds;
    if (!Array.isArray(ids) || ids.length !== 5) throw new Error(`golden suite must declare exactly 5 explicitVectorIds (got ${Array.isArray(ids) ? ids.length : typeof ids})`);
    const { Database } = loadNvdb();
    const db = new Database(layout.nvdbDir);
    try {
        const collections = db.listCollections();
        if (!collections.includes('storage')) throw new Error(`work nVDB has no "storage" collection (has: ${collections.join(', ') || '<none>'})`);
        const coll = db.getCollection('storage');
        const inputs = ids.map((id) => {
            const record = coll.get(id);
            if (!record) throw new Error(`golden chunk ${id} is not present in the work storage collection`);
            const payload = JSON.parse(record.payload);
            const source = reconstructStorageChunk({ payload, storageWorkRoot: layout.storageDir });
            if (!source.available) throw new Error(`golden chunk ${id} has no usable source (${source.reason})`);
            return { id, text: source.embedText, payload };
        });
        closeQuietly(coll);
        return { inputs, layout, suiteVersion: suite.suiteVersion, expectedDim: suite.dataset?.expectedEmbeddingDim ?? 2560 };
    } finally {
        closeQuietly(db);
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const keys = { '--snapshot': 'snapshot', '--direct': 'direct', '--wrapper': 'wrapper', '--gateway': 'gateway', '--model': 'model', '--reports': 'reports', '--out': 'out' };
    const args = { snapshot: DEFAULT_SNAPSHOT, direct: DEFAULT_DIRECT_URL, wrapper: DEFAULT_WRAPPER_URL, gateway: null, model: DEFAULT_MODEL, reports: null, out: null, report: true };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--no-report') { args.report = false; continue; }
        const key = keys[arg];
        if (!key) throw new Error(`unknown argument: ${arg}`);
        if (i + 1 >= argv.length) throw new Error(`${arg} requires a value`);
        args[key] = argv[++i];
    }
    return args;
}

function writeReport(report, reportsDir, file) {
    fs.mkdirSync(reportsDir, { recursive: true });
    const target = file ?? path.join(reportsDir, `embedding-pipeline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return target;
}

function summarize(report) {
    const lines = [`${report.ok ? 'OK' : 'FAIL'} — ${report.verdict}`];
    for (const name of STAGE_NAMES) {
        const stage = report.stages[name];
        lines.push(`  ${stage.available ? 'ok  ' : 'MISS'} ${name}${stage.available ? '' : `: ${stage.error}`}`);
    }
    lines.push(`  distinctness: ${STAGE_NAMES.filter((name) => report.stages[name].available && !report.stages[name].distinct).join(', ') || 'all stages distinct'}`);
    for (const warning of report.warnings) lines.push(`  warn: ${warning}`);
    return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    const gatewayUrl = args.gateway ?? config.gateway?.httpUrl;
    if (!gatewayUrl) throw new Error('createEmbedClient stage needs a gateway URL (--gateway or config.json gateway.httpUrl)');
    const loaded = loadGoldenStorageInputs({ snapshot: args.snapshot });
    const embedder = createEmbedClient(gatewayUrl, config.gateway?.accessKey ?? null);
    embedder.describeUrl = gatewayUrl;
    const report = await runPipelineProvenance({
        inputs: loaded.inputs,
        directUrl: args.direct,
        wrapperUrl: args.wrapper,
        model: args.model,
        expectedDim: loaded.expectedDim,
        embedder,
        tmpRoot: path.join(REPO_ROOT, '.cache')
    });
    report.environment.snapshot = loaded.layout.root;
    report.environment.suiteVersion = loaded.suiteVersion;

    const outFile = args.report ? writeReport(report, args.reports ?? loaded.layout.reportsDir, args.out) : null;
    process.stdout.write(`${summarize(report)}\n${outFile ? `\nreport: ${outFile}\n` : ''}`);
    if (!report.ok) process.exitCode = 1;
    return { report, outFile };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);
if (invokedDirectly) {
    main().catch((e) => {
        process.stderr.write(`verify-embedding-pipeline failed: ${e.message}\n${e.stack ?? ''}\n`);
        process.exitCode = 1;
    });
}
