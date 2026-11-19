import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createWizkidJobClient, loadWizkidToken, batchIdempotencyKey, WIZKID_MODEL, WIZKID_DIM } from '../src/wizkid-job-client.js';
import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { memoryVectorInput, buildMemoryVectorGuard } from '../src/agents/memory/index.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';
import { init as initVdb, shutdown as shutdownVdb } from '../src/agents/vdb/index.js';
import {
    buildAgentConfig,
    createRealGateway,
    enumerateTextFiles,
    seedEnhancementCache,
    waitForInitialScan
} from './rebuild-memory-lab-storage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'data', 'candidates', 'wizkid-qwen3-embedding-4b');
const DEFAULT_TOKEN_FILE = '\\\\Wizkid\\f\\DEV\\openvino-qual\\.env';
const CACHE_COLLECTION = '__enhancement_cache';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
}

function readJson(file, fallback = null) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function inside(child, parent) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function parseArgs(argv) {
    const args = { root: DEFAULT_ROOT, only: 'all', resume: false, tokenFile: process.env.OVEM_TOKEN_FILE || DEFAULT_TOKEN_FILE, pauseFile: null, scanTimeoutMs: 4 * 60 * 60 * 1000, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => {
            const next = argv[++i];
            if (!next || next.startsWith('--')) throw new Error(`${arg} needs a value`);
            return next;
        };
        if (arg === '--root') args.root = path.resolve(value());
        else if (arg === '--only') args.only = value();
        else if (arg === '--resume') args.resume = true;
        else if (arg === '--token-file') args.tokenFile = value();
        else if (arg === '--pause-file') args.pauseFile = path.resolve(value());
        else if (arg === '--scan-timeout-ms') args.scanTimeoutMs = Number(value());
        else if (arg === '--help' || arg === '-h') args.help = true;
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (!['all', 'memory', 'storage'].includes(args.only)) throw new Error('--only must be all, memory, or storage');
    if (!Number.isFinite(args.scanTimeoutMs) || args.scanTimeoutMs <= 0) throw new Error('--scan-timeout-ms must be positive');
    return args;
}

export function usage() {
    return [
        'Usage: node scripts/build-wizkid-candidates.mjs [--only all|memory|storage] [--resume]',
        '',
        `Default candidate: ${DEFAULT_ROOT}`,
        'Creates isolated memory/storage nVDB collections. Live indexes are read-only.',
        'Use --resume after stopping. Create the PAUSE file to stop submitting new batches.',
        'Auth: OVEM_API_TOKEN, OVEM_TOKEN_FILE, or --token-file (never logged).'
    ].join('\n');
}

function prepareCandidate(root, resume, config) {
    const allowedRoot = path.join(REPO_ROOT, 'data', 'candidates');
    const liveNvdb = path.resolve(REPO_ROOT, config.agents.vdb.dbPath);
    if (!inside(root, allowedRoot)) throw new Error(`candidate root must be under ${allowedRoot}: ${root}`);
    if (inside(root, liveNvdb) || inside(liveNvdb, root)) throw new Error(`candidate and live nVDB roots overlap: ${root} / ${liveNvdb}`);
    if (fs.existsSync(root) && fs.realpathSync(root) !== path.resolve(root)) throw new Error(`candidate root must not be a symlink/junction: ${root}`);
    const metadataPath = path.join(root, 'candidate.json');
    const existing = readJson(metadataPath);
    if (!resume && (existing || (fs.existsSync(root) && fs.readdirSync(root).length > 0))) {
        throw new Error(`candidate is not empty; use --resume or choose a new root: ${root}`);
    }
    if (resume && !existing) throw new Error(`cannot resume without ${metadataPath}`);
    if (existing && (existing.model !== WIZKID_MODEL || existing.dimensions !== WIZKID_DIM)) {
        throw new Error(`candidate vector-space mismatch in ${metadataPath}`);
    }
    const metadata = existing || {
        version: 1,
        runId: `run-${Date.now().toString(36)}`,
        status: 'building',
        provider: 'wizkid-openvino',
        model: WIZKID_MODEL,
        dimensions: WIZKID_DIM,
        createdAt: new Date().toISOString(),
        liveNvdb,
        memorySource: path.resolve(REPO_ROOT, config.agents.memory.dbPath),
        storageSource: path.resolve(REPO_ROOT, config.agents.storage.root)
    };
    writeJson(metadataPath, metadata);
    return { root, nvdb: path.join(root, 'nvdb'), metadataPath, metadata, pauseFile: path.join(root, 'PAUSE') };
}

function openCollection(db, databasePath, name, dimension) {
    const meta = readJson(path.join(databasePath, 'meta.json'), null);
    if (meta?.collections?.includes(name)) return db.getCollection(name);
    return db.createCollection(name, dimension, { durability: 'buffered' });
}

function packInputs(records) {
    const batches = [];
    let current = [];
    let tokens = 0;
    for (const record of records) {
        const estimate = Math.ceil(record.text.length / 2.5);
        if (estimate > 8192) throw new Error(`${record.id} is above the 8192-token input limit (estimated ${estimate})`);
        if (current.length === 512 || (current.length > 0 && tokens + estimate > 262144)) {
            batches.push(current);
            current = [];
            tokens = 0;
        }
        current.push(record);
        tokens += estimate;
    }
    if (current.length) batches.push(current);
    return batches;
}

async function waitWhilePaused(pauseFile) {
    let announced = false;
    while (fs.existsSync(pauseFile)) {
        if (!announced) console.log(`[candidate] paused; remove ${pauseFile} to resume`);
        announced = true;
        await sleep(2000);
    }
}

function batchRunner({ client, runId, pauseFile, progressPath, lane }) {
    const progress = readJson(progressPath, { jobs: 0, inputs: 0 });
    return async texts => {
        await waitWhilePaused(pauseFile);
        const inputs = texts.map((text, index) => ({ id: `input-${index}`, text }));
        const key = batchIdempotencyKey(`${runId}-${lane}`, inputs);
        const result = await client.embed(inputs, { idempotencyKey: key });
        progress.jobs++;
        progress.inputs += inputs.length;
        progress.lastJobId = result.jobId;
        progress.updatedAt = new Date().toISOString();
        writeJson(progressPath, progress);
        console.log(`[${lane}] ${progress.inputs} texts embedded (${progress.jobs} jobs)`);
        return result.vectors;
    };
}

export async function buildMemoryCandidate({ candidate, config, client }) {
    const sourcePath = path.resolve(REPO_ROOT, config.agents.memory.dbPath);
    const maxChars = config.agents.memory.maxMemoryChars || 6000;
    const { Database: Ndb } = loadNdb();
    const { Database: Nvdb } = loadNvdb();
    const source = Ndb.open(sourcePath, { persistence: 'immediate' });
    const db = new Nvdb(candidate.nvdb);
    const coll = openCollection(db, candidate.nvdb, 'memory', WIZKID_DIM);
    const checkpointPath = path.join(candidate.root, 'memory-checkpoint.json');
    const checkpoint = readJson(checkpointPath, { records: {} });
    const docs = source.iter().filter(doc => doc._id.startsWith('mem_'));
    const currentIds = new Set(docs.map(doc => doc._id));
    const pending = [];

    try {
        for (const doc of docs) {
            const input = memoryVectorInput(doc.description, doc.data, maxChars);
            const inputHash = sha256(input);
            if (checkpoint.records[doc._id]?.inputHash === inputHash && coll.get(doc._id)) continue;
            pending.push({ doc, input, inputHash });
        }
        const runBatch = batchRunner({
            client,
            runId: candidate.metadata.runId,
            pauseFile: candidate.pauseFile,
            progressPath: path.join(candidate.root, 'memory-progress.json'),
            lane: 'memory'
        });
        const guard = buildMemoryVectorGuard({ db: source, coll, maxChars }).guard;
        const batches = packInputs(pending.map(item => ({ id: item.doc._id, text: item.input, item })));
        let embedded = 0;
        for (const batch of batches) {
            const vectors = await runBatch(batch.map(record => record.text));
            guard.assertMany(batch.map((record, index) => ({
                id: record.id,
                input: record.text,
                vector: vectors[index],
                where: `candidate memory ${record.id}`
            })));
            for (let i = 0; i < batch.length; i++) {
                const { doc, input, inputHash } = batch[i].item;
                coll.insert(doc._id, vectors[i], JSON.stringify({ id: doc.id }));
                guard.register(doc._id, vectors[i], input);
                checkpoint.records[doc._id] = { inputHash, memId: doc.id, embeddedAt: new Date().toISOString() };
                embedded++;
            }
            coll.flush();
            writeJson(checkpointPath, checkpoint);
        }
        for (const oldId of Object.keys(checkpoint.records)) {
            if (!currentIds.has(oldId)) {
                coll.delete(oldId);
                delete checkpoint.records[oldId];
            }
        }
        coll.flush();
        writeJson(checkpointPath, checkpoint);
        const missing = docs.filter(doc => !coll.get(doc._id)).map(doc => doc._id);
        const invalid = docs.filter(doc => {
            const stored = coll.get(doc._id);
            return stored && (!Array.isArray(stored.vector) || stored.vector.length !== WIZKID_DIM || stored.vector.some(value => !Number.isFinite(value)));
        }).map(doc => doc._id);
        if (missing.length || invalid.length) throw new Error(`memory candidate incomplete: missing=${missing.length} invalid=${invalid.length}`);
        return { expected: docs.length, embedded, resumed: docs.length - embedded, missing, invalid };
    } finally {
        coll.close();
        db.close();
        source.close();
    }
}

function prepareEnhancementCache({ candidate, config, discovery }) {
    const { Database } = loadNvdb();
    const db = new Database(candidate.nvdb);
    const coll = openCollection(db, candidate.nvdb, CACHE_COLLECTION, WIZKID_DIM);
    coll.close();
    db.close();
    return seedEnhancementCache({
        workScanIndexPath: path.join(path.resolve(REPO_ROOT, config.agents.vdb.dbPath), 'scan-index.json'),
        candidateNvdb: candidate.nvdb,
        embeddingDim: WIZKID_DIM,
        discoveredPaths: discovery.relPaths
    });
}

export async function buildStorageCandidate({ candidate, config, client }) {
    const storageRoot = path.resolve(REPO_ROOT, config.agents.storage.root);
    const discovery = enumerateTextFiles(storageRoot, config.agents.vdb);
    const cache = prepareEnhancementCache({ candidate, config, discovery });
    const agentConfig = buildAgentConfig(config, {
        candidateNvdb: candidate.nvdb,
        workStorage: storageRoot,
        scanTimeoutMs: candidate.scanTimeoutMs
    });
    agentConfig.agents.vdb.batchTokenLimit = 131072;
    agentConfig.agents.vdb.maxBatchTexts = 128;
    const gateway = createRealGateway(agentConfig);
    const runBatch = batchRunner({
        client,
        runId: candidate.metadata.runId,
        pauseFile: candidate.pauseFile,
        progressPath: path.join(candidate.root, 'storage-progress.json'),
        lane: 'storage'
    });
    gateway.embedBatchBackground = runBatch;
    gateway.embedBatch = runBatch;
    gateway.embed = async text => (await runBatch([text]))[0];
    const initialized = await initVdb({ config: agentConfig, gateway });
    if (path.resolve(initialized.dbPath) !== path.resolve(candidate.nvdb)) throw new Error('VDB opened a non-candidate database');
    let status;
    try {
        status = await waitForInitialScan({ timeoutMs: candidate.scanTimeoutMs + 300000 });
    } finally {
        await shutdownVdb();
    }
    const scan = status.status.lastScanStats;
    if (scan.errors || scan.pending) throw new Error(`storage scan incomplete: errors=${scan.errors} pending=${scan.pending}`);

    const index = readJson(path.join(candidate.nvdb, 'scan-index.json'));
    const entries = Object.values(index.files || {});
    const canonical = entries.filter(entry => !entry.duplicateOf);
    const indexedPaths = new Set(entries.map(entry => entry.path));
    const notIndexed = discovery.relPaths.filter(rel => !indexedPaths.has(rel));
    if (notIndexed.length) throw new Error(`storage candidate is missing ${notIndexed.length} source file(s): ${notIndexed.join(', ')}`);
    const coll = initialized.getCollection('storage');
    const missing = [];
    const invalid = [];
    let expected = 0;
    for (const entry of canonical) {
        const base = `storage:${entry.path}`;
        for (let i = 0; i < entry.chunks; i++) {
            expected++;
            const id = entry.chunks === 1 ? base : `${base}#${i}`;
            const stored = coll.get(id);
            if (!stored) missing.push(id);
            else if (!Array.isArray(stored.vector) || stored.vector.length !== WIZKID_DIM || stored.vector.some(value => !Number.isFinite(value))) invalid.push(id);
        }
    }
    if (missing.length || invalid.length) throw new Error(`storage candidate incomplete: missing=${missing.length} invalid=${invalid.length}`);
    return { files: entries.length, canonicalFiles: canonical.length, aliases: entries.length - canonical.length, vectors: expected, missing, invalid, scan, cache };
}

export async function run(args) {
    const config = readJson(path.join(REPO_ROOT, 'config.json'));
    const candidate = prepareCandidate(args.root, args.resume, config);
    candidate.pauseFile = args.pauseFile || candidate.pauseFile;
    candidate.scanTimeoutMs = args.scanTimeoutMs;
    const token = loadWizkidToken({ tokenFile: args.tokenFile });
    const report = { startedAt: new Date().toISOString(), candidate: candidate.root, only: args.only, liveIndexesUntouched: true };
    try {
        if (args.only === 'all' || args.only === 'memory') {
            const client = createWizkidJobClient({ token, callerId: 'mcp-memory-candidate', onRetry: info => console.log(`[memory] retry ${info.code || info.status} (${info.attempt})`) });
            report.wizkidLimits = await client.limits();
            report.memory = await buildMemoryCandidate({ candidate, config, client });
        }
        if (args.only === 'all' || args.only === 'storage') {
            const client = createWizkidJobClient({ token, callerId: 'mcp-storage-candidate', onRetry: info => console.log(`[storage] retry ${info.code || info.status} (${info.attempt})`) });
            report.wizkidLimits = await client.limits();
            report.storage = await buildStorageCandidate({ candidate, config, client });
        }
        report.finishedAt = new Date().toISOString();
        report.ok = true;
        candidate.metadata.status = args.only === 'all' ? 'complete' : `${args.only}-complete`;
        candidate.metadata.updatedAt = report.finishedAt;
        writeJson(candidate.metadataPath, candidate.metadata);
        return report;
    } finally {
        writeJson(path.join(candidate.root, 'reports', `build-${Date.now()}.json`), report);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        return;
    }
    try {
        const report = await run(args);
        console.log(`[candidate] OK: ${JSON.stringify({ memory: report.memory, storage: report.storage && { files: report.storage.files, vectors: report.storage.vectors } })}`);
        console.log(`[candidate] ${args.root}`);
        process.exit(0);
    } catch (error) {
        console.error(`[candidate] FAILED: ${error.stack || error.message}`);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
