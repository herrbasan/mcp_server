// One-time cleanup for GitHub issue #24 — remove per-run dreamer telemetry
// entries from the-between (spec decision #3: "non-trivial consolidations
// only"). After 8 days, 278 of 286 entries were "I (the dreamer) tended the
// map: connected N..." run reports — signal burial for the seat's own log.
//
// Deletes (tombstones) telemetry entries; KEEPS:
//   - seat-voiced entries ("I (the partner, [substrate]) ...")
//   - any dreamer-voiced entry without telemetry vocabulary (real events)
//
// The pipeline write-path gate (isNonTrivialDream, src/agents/dreaming/
// between.js) prevents new telemetry; this script clears the backlog.
//
// Orphaned nVDB vectors: memory.recall already skips tombstoned docs; reclaim
// space afterwards with scripts/cleanup-vdb-garbage.js if wanted.
//
// Usage:   node scripts/cleanup-between-telemetry.mjs [--apply]
// Requires the mcp_server to be STOPPED (nDB is single-writer).
import { loadNdb } from '../src/agents/memory/ndb-loader.js';

const { Database } = loadNdb();
const db = Database.open('data/memories/data.jsonl');
const deleted = new Set(db.deletedIds());
const docs = db.iter().filter(d => d._id.startsWith('mem_') && !deleted.has(d._id));

const apply = process.argv.includes('--apply');

// Telemetry predicate: dreamer-voiced AND tending-statistics vocabulary.
// Both must match — a dreamer entry describing a real event ("implemented
// the-between guards") survives.
const DREAMER_VOICED = /^I\s*\(\s*(?:the\s+)?dreamer\b/i;
const TELEMETRY_WORDS = /\b(tended|connected|surge\w*|fade\w*|watched)\b/i;

const preview = (d) => (d.description || '(no description)').slice(0, 110);

const doomed = [];
const kept = [];
for (const d of docs) {
    if (d.category !== 'the-between') continue;
    const desc = d.description || '';
    if (DREAMER_VOICED.test(desc) && TELEMETRY_WORDS.test(desc)) doomed.push(d);
    else kept.push(d);
}

console.log(`the-between entries: ${doomed.length + kept.length} | telemetry (delete): ${doomed.length} | keep: ${kept.length}`);
console.log('\n── DELETE (telemetry, first 10) ──');
for (const d of doomed.slice(0, 10)) console.log(`  #${d.id}  ${preview(d)}`);
if (doomed.length > 10) console.log(`  … and ${doomed.length - 10} more`);
console.log('\n── KEEP ──');
for (const d of kept) console.log(`  #${d.id}  ${preview(d)}`);

if (apply) {
    if (doomed.length === 0) {
        console.log('\nNothing to delete.');
        process.exit(0);
    }
    for (const d of doomed) db.delete(d._id);
    db.flush();
    console.log(`\nAPPLIED: ${doomed.length} telemetry entries tombstoned.`);
    console.log('Next dream run prunes their map nodes (pruneDeadNodes) and heals bridges/hubs automatically.');
} else {
    console.log('\n(dry run — pass --apply to write)');
}
