// One-shot cleanup: delete orphaned garbage chunks from the nVDB storage collection.
//
// Background: bench-64kb.txt, bench-120kb.txt, and Urlaub Krk Herbst 95/All.md
// were indexed before the garbage filter existed. Their scan-index entries were
// removed, but the chunk vectors are still live in the DB segments. Because
// nVDB's exact_search does not apply memtable tombstones to segment scans,
// those orphans still appear in search results.
//
// This script:
//   1. Loads the nVDB Database directly (server must be stopped).
//   2. For each garbage file, calls coll.delete() on every chunk ID.
//   3. Flushes and compacts the storage collection so the orphans are
//      physically removed from the segments.
//   4. Reports before/after stats.
//
// Run with: node scripts/cleanup-vdb-garbage.js
// Server MUST be stopped — otherwise the live Database instance holds the lock.

import path from 'path';
import { fileURLToPath } from 'url';
import { loadNvdb } from '../src/agents/vdb/nvdb-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(PROJECT_ROOT, 'data/nvdb');
const EMBEDDING_DIM = 2560;

// The garbage files and their known chunk counts.
// bench-*.txt: old vectors from before the garbage filter existed. Not in
//   scan-index anymore but vectors persist in segments.
// real-copy-*.md: three identical 122KB copies of the same content. The
//   within-scan dedup fix will handle future scans, but existing vectors
//   need physical removal now. We delete all three; the next scan will
//   re-index one canonical copy.
const GARBAGE = [
    { docBaseId: 'storage:herrbasan/input/Texte/Dokumente/Urlaub Krk Herbst 95/All.md', chunks: 235 },
    { docBaseId: 'storage:test/bench-120kb.txt', chunks: 55 },
    { docBaseId: 'storage:test/bench-64kb.txt', chunks: 30 },
    { docBaseId: 'storage:test/real-copy-2.md', chunks: 55 },
    { docBaseId: 'storage:test/real-copy-mcp.md', chunks: 55 },
    { docBaseId: 'storage:test/real-copy-restart.md', chunks: 55 }
];

function chunkIdsFor(docBaseId, chunkCount) {
    // Single-chunk files use the bare docBaseId; multi-chunk files use #0..#N-1.
    if (chunkCount === 1) return [docBaseId];
    const ids = [];
    for (let i = 0; i < chunkCount; i++) ids.push(`${docBaseId}#${i}`);
    return ids;
}

function main() {
    const { Database } = loadNvdb();
    console.log(`Opening DB at ${DB_PATH}`);
    const db = new Database(DB_PATH);

    let storageColl;
    try {
        storageColl = db.getCollection('storage');
    } catch {
        throw new Error('storage collection not found — nothing to clean up');
    }

    // stats is a getter on the napi binding, not a function.
    const before = storageColl.stats;
    console.log('Before cleanup:', {
        memtableDocs: before.memtableDocs,
        totalSegmentDocs: before.totalSegmentDocs,
        segmentCount: before.segmentCount
    });

    let deleted = 0;
    let missing = 0;
    let failed = 0;

    for (const { docBaseId, chunks } of GARBAGE) {
        const ids = chunkIdsFor(docBaseId, chunks);
        for (const id of ids) {
            try {
                // delete() returns true if the id was found and tombstoned,
                // false if the id was not in the memtable.
                const existed = storageColl.delete(id);
                if (existed) deleted++;
                else missing++;
            } catch (e) {
                failed++;
                console.error(`FAILED to delete ${id}: ${e.message}`);
            }
        }
    }

    console.log(`\nDelete phase: ${deleted} deleted, ${missing} not in memtable, ${failed} failed`);

    // Compact to physically remove the deleted docs from segments.
    // Do NOT flush before compacting — flush() swaps the memtable (including
    // tombstones) into a segment and replaces it with an empty one. compact()
    // then finds no tombstones and removes nothing. Tombstones must be in the
    // memtable when compact() runs.
    console.log('\nCompacting storage collection...');
    return Promise.resolve(storageColl.compact()).then(compactResult => {
        const after = storageColl.stats;
        console.log('\nAfter cleanup:', {
            memtableDocs: after.memtableDocs,
            totalSegmentDocs: after.totalSegmentDocs,
            segmentCount: after.segmentCount
        });

        console.log('\nCompaction result:', {
            docsBefore: compactResult?.docsBefore ?? compactResult?.docs_before ?? before.totalSegmentDocs,
            docsAfter: compactResult?.docsAfter ?? compactResult?.docs_after ?? after.totalSegmentDocs,
            segmentsMerged: compactResult?.segmentsMerged ?? compactResult?.segments_merged ?? null
        });

        const removed = (before.totalSegmentDocs ?? 0) - (after.totalSegmentDocs ?? 0);
        console.log(`\nNet segment docs removed: ${removed}`);
        console.log('\nDone. Safe to restart the server now.');
    }).catch(e => {
        throw new Error(`Compaction failed: ${e.message}`);
    });
}

main();
