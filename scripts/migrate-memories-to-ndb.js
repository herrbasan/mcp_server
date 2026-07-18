/**
 * One-time migration: memories.json → nDB (documents) + nVDB (vectors)
 *
 * READ-ONLY on the source (data/memories.json). Does not modify it.
 * Creates a new nDB database with all memory metadata.
 *
 * Vectors are NOT migrated here — the nVDB database is locked by the
 * running server process. Instead, each memory document is marked with
 * embedStatus='embedded' and the nDB _id is stored as the vector key.
 * On first startup with the new memory agent, a vector backfill runs
 * inside the server process (which owns the nVDB lock) to populate
 * the memory collection from the source embeddings.
 *
 * Alternatively, run with the server stopped to migrate vectors here.
 *
 * Usage:
 *   node scripts/migrate-memories-to-ndb.js            # nDB only (server can be running)
 *   node scripts/migrate-memories-to-ndb.js --vectors  # nDB + nVDB (server MUST be stopped)
 *   node scripts/migrate-memories-to-ndb.js --verify   # verify migration
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SOURCE_PATH = path.join(PROJECT_ROOT, 'data', 'memories.json');
const NDB_PATH = path.join(PROJECT_ROOT, 'data', 'memories.jsonl');
const NVDB_PATH = path.join(PROJECT_ROOT, 'data', 'nvdb');
const EMBEDDING_DIM = 2560;
const NVDB_COLLECTION = 'memory';

// ── Load native modules ──────────────────────────────────────────────

import { loadNdb } from '../src/agents/memory/ndb-loader.js';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';

function log(msg) {
    console.log(`[migrate] ${msg}`);
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ── Migration ────────────────────────────────────────────────────────

async function migrate(migrateVectors) {
    const startTime = Date.now();

    // 1. Read source
    log(`Reading source: ${SOURCE_PATH}`);
    const sourceSize = fs.statSync(SOURCE_PATH).size;
    log(`  Source size: ${formatBytes(sourceSize)}`);

    const raw = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf-8'));
    const sourceMemories = raw.memories;
    const sourceNextId = raw.nextId;

    if (!Array.isArray(sourceMemories)) {
        throw new Error('Source memories.json has no memories array');
    }

    log(`  Source memories: ${sourceMemories.length}, nextId: ${sourceNextId}`);

    // 2. Validate: no duplicate IDs
    const idSet = new Set();
    const duplicates = [];
    for (const m of sourceMemories) {
        if (idSet.has(m.id)) duplicates.push(m.id);
        idSet.add(m.id);
    }
    if (duplicates.length > 0) {
        throw new Error(`Source has duplicate memory IDs: ${duplicates.join(', ')}`);
    }

    // 3. Open nDB (fresh — refuse to overwrite existing data)
    if (fs.existsSync(NDB_PATH)) {
        throw new Error(`nDB target already exists: ${NDB_PATH}\nDelete it first if you want to re-run migration.`);
    }

    const { Database } = loadNdb();
    const db = Database.open(NDB_PATH, { persistence: 'immediate' });
    log(`Opened nDB at: ${NDB_PATH}`);

    // 4. Open nVDB if migrating vectors (requires server stopped)
    let memColl = null;
    if (migrateVectors) {
        const { Database: NvdbDatabase } = loadNvdb();
        const nvdb = new NvdbDatabase(NVDB_PATH);
        try {
            memColl = nvdb.getCollection(NVDB_COLLECTION);
            log(`Opened existing nVDB collection: ${NVDB_COLLECTION}`);
        } catch {
            memColl = nvdb.createCollection(NVDB_COLLECTION, EMBEDDING_DIM);
            log(`Created nVDB collection: ${NVDB_COLLECTION} (dim=${EMBEDDING_DIM})`);
        }
    } else {
        log('Skipping nVDB vector migration (server may be running).');
        log('  Vectors will be backfilled by the memory agent on first startup.');
    }

    // 5. Migrate
    let docCount = 0;
    let vectorCount = 0;
    let pendingCount = 0;
    const categoryCounts = {};

    for (const m of sourceMemories) {
        // Build nDB document — strip embedding, add embedStatus
        const hasEmbedding = Array.isArray(m.embedding) && m.embedding.length === EMBEDDING_DIM;

        const doc = {
            id: m.id,
            description: m.description,
            category: m.category || 'notes',
            confidence: typeof m.confidence === 'number' ? m.confidence : 0.5,
            timestamp: m.timestamp || new Date().toISOString(),
            embedStatus: hasEmbedding ? 'embedded' : 'pending'
        };
        if (m.embedError) doc.embedError = m.embedError;
        if (m.data !== undefined && m.data !== null) doc.data = m.data;

        // Insert into nDB
        const ndbId = db.insertWithPrefix('mem', doc);
        docCount++;

        // Track stats
        const cat = doc.category;
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;

        // Insert vector into nVDB if requested and we have a valid embedding
        if (migrateVectors && memColl && hasEmbedding) {
            const key = ndbId; // nDB _id is the nVDB key
            const payload = JSON.stringify({ id: m.id });
            memColl.insert(key, m.embedding, payload);
            vectorCount++;
        } else if (hasEmbedding) {
            // Not migrating vectors now, but the embedding exists and will be backfilled
            vectorCount++;
        } else {
            pendingCount++;
        }

        // Progress every 100 memories
        if (docCount % 100 === 0) {
            log(`  ... ${docCount}/${sourceMemories.length} migrated`);
        }
    }

    // 6. Insert _meta document with nextId
    db.insertWithPrefix('_meta', { nextId: sourceNextId, migratedAt: new Date().toISOString() });
    log(`Inserted _meta document (nextId=${sourceNextId})`);

    // 7. Create indexes
    db.createIndex('category');
    db.createIndex('embedStatus');
    db.createIndex('id');
    log('Created indexes: category, embedStatus, id');

    // 8. Flush
    db.flush();
    if (memColl) memColl.flush();
    log('Flushed nDB' + (memColl ? ' + nVDB' : ''));

    // 9. Verify counts
    const ndbCount = db.len();
    const expectedDocs = sourceMemories.length + 1; // +1 for _meta

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  MIGRATION COMPLETE');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Mode:            ${migrateVectors ? 'nDB + nVDB' : 'nDB only (vectors backfilled later)'}`);
    console.log(`  Duration:        ${duration}s`);
    console.log(`  Source:          ${sourceMemories.length} memories (${formatBytes(sourceSize)})`);
    console.log(`  nDB documents:   ${ndbCount} (expected ${expectedDocs}: ${sourceMemories.length} memories + 1 _meta)`);
    console.log(`  With embedding:  ${vectorCount}`);
    console.log(`  Pending embed:   ${pendingCount}`);
    console.log(`  nextId:          ${sourceNextId}`);
    console.log('');
    console.log('  Categories:');
    for (const [cat, count] of Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${cat}: ${count}`);
    }
    console.log('');
    console.log(`  nDB path:   ${NDB_PATH}`);
    if (migrateVectors) console.log(`  nVDB path:  ${NVDB_PATH} (collection: ${NVDB_COLLECTION})`);
    console.log(`  Source:     ${SOURCE_PATH} (untouched)`);
    console.log('═══════════════════════════════════════════════════════════');

    if (ndbCount !== expectedDocs) {
        console.error(`⚠ WARNING: nDB count ${ndbCount} != expected ${expectedDocs}`);
        process.exit(1);
    }
    if (vectorCount + pendingCount !== sourceMemories.length) {
        console.error(`⚠ WARNING: vectors ${vectorCount} + pending ${pendingCount} != total ${sourceMemories.length}`);
        process.exit(1);
    }

    console.log('\n✓ All counts match. Migration verified.');
}

// ── Verification mode ────────────────────────────────────────────────

async function verify() {
    log('VERIFICATION MODE');
    log('');

    // Load source
    const raw = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf-8'));
    const sourceMemories = raw.memories;

    // Load nDB
    if (!fs.existsSync(NDB_PATH)) {
        throw new Error(`nDB not found: ${NDB_PATH}. Run migration first.`);
    }
    const { Database } = loadNdb();
    const db = Database.open(NDB_PATH);

    const ndbDocs = db.iter();
    const memDocs = ndbDocs.filter(d => d._id.startsWith('mem_'));
    const metaDoc = ndbDocs.find(d => d._id.startsWith('_meta'));

    log(`Source memories:  ${sourceMemories.length}`);
    log(`nDB memory docs:  ${memDocs.length}`);
    log(`nDB _meta nextId: ${metaDoc?.nextId} (source: ${raw.nextId})`);
    log('');

    // Check every source memory exists in nDB by id
    let missing = 0;
    let mismatched = 0;
    db.createIndex('id');

    for (const src of sourceMemories) {
        const found = db.find('id', src.id);
        if (found.length === 0) {
            console.error(`  MISSING: #${src.id} not found in nDB`);
            missing++;
            continue;
        }
        if (found.length > 1) {
            console.error(`  DUPLICATE: #${src.id} found ${found.length} times in nDB`);
            mismatched++;
            continue;
        }
        const doc = found[0];

        // Verify key fields
        if (doc.description !== src.description) {
            console.error(`  MISMATCH #${src.id}: description differs`);
            mismatched++;
        }
        if (doc.category !== (src.category || 'notes')) {
            console.error(`  MISMATCH #${src.id}: category ${doc.category} != ${src.category || 'notes'}`);
            mismatched++;
        }
        if (doc.confidence !== (typeof src.confidence === 'number' ? src.confidence : 0.5)) {
            console.error(`  MISMATCH #${src.id}: confidence ${doc.confidence} != ${src.confidence}`);
            mismatched++;
        }
    }

    // Load nVDB (optional — may be locked by running server)
    let memColl = null;
    try {
        const { Database: NvdbDatabase } = loadNvdb();
        const nvdb = new NvdbDatabase(NVDB_PATH);
        memColl = nvdb.getCollection(NVDB_COLLECTION);
    } catch (e) {
        log(`nVDB check skipped: ${e.message}`);
    }

    // Check vector coverage (only if nVDB is accessible)
    let vectorsWithDoc = 0;
    let docsMissingVector = 0;

    if (memColl) {
        for (const doc of memDocs) {
            if (doc.embedStatus !== 'embedded') continue;
            const vec = memColl.get(doc._id);
            if (vec) {
                vectorsWithDoc++;
            } else {
                console.error(`  MISSING VECTOR: #${doc.id} (${doc._id}) marked embedded but no vector in nVDB`);
                docsMissingVector++;
            }
        }
    }

    log('');
    log('═══════════════════════════════════════════════════════════');
    log('  VERIFICATION RESULT');
    log('═══════════════════════════════════════════════════════════');
    log(`  Missing from nDB:     ${missing}`);
    log(`  Field mismatches:     ${mismatched}`);
    if (memColl) {
        log(`  Vectors with doc:     ${vectorsWithDoc}`);
        log(`  Docs missing vector:  ${docsMissingVector}`);
    } else {
        log(`  nVDB vectors:         (skipped — server holds the lock)`);
    }
    log('═══════════════════════════════════════════════════════════');

    if (missing === 0 && mismatched === 0 && docsMissingVector === 0) {
        log('\n✓ VERIFICATION PASSED — all memories accounted for.');
    } else {
        console.error('\n✗ VERIFICATION FAILED — see errors above.');
        process.exit(1);
    }
}

// ── Entry point ──────────────────────────────────────────────────────

const mode = process.argv[2];

try {
    if (mode === '--verify') {
        await verify();
    } else if (mode === '--vectors') {
        await migrate(true);
    } else {
        await migrate(false);
    }
} catch (err) {
    console.error(`\n✗ Migration failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
}
