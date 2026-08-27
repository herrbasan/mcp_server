// validate-dream-map.mjs — consistency checker for the dreamer database.
// Checks data/dream_map.json structural invariants and the dream-entry
// substrate labels / embed status in data/memories/data.jsonl.
// Usage: node scripts/validate-dream-map.mjs
// Exit 0 = consistent, exit 1 = problems found.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = join(root, 'data', 'dream_map.json');
const MEM_PATH = join(root, 'data', 'memories', 'data.jsonl');

const problems = [];
const observations = [];
const ok = (msg) => console.log(`  OK   ${msg}`);
const fail = (msg) => { problems.push(msg); console.log(`  FAIL ${msg}`); };
const note = (msg) => { observations.push(msg); console.log(`  NOTE ${msg}`); };

// ─── Section 1: dream_map.json invariants ───
console.log('══ dream_map.json ══');
const map = JSON.parse(readFileSync(MAP_PATH, 'utf8')); // throws loud on corrupt JSON

if (!map.meta?.generated_at) fail('meta.generated_at missing');
else ok(`generated_at: ${map.meta.generated_at} (${ageMin(map.meta.generated_at)} min ago)`);

const nodeIds = new Set(map.nodes.map(n => n.id));
const clusterIds = new Set(map.clusters.map(c => c.id));

// Duplicate ids
{
    const dupNodes = map.nodes.length - nodeIds.size;
    const dupClusters = map.clusters.length - clusterIds.size;
    if (dupNodes > 0) fail(`${dupNodes} duplicate node ids`);
    else ok(`node ids unique (${nodeIds.size} nodes)`);
    if (dupClusters > 0) fail(`${dupClusters} duplicate cluster ids`);
    else ok(`cluster ids unique (${clusterIds.size} clusters)`);
}

// Bridges reference real nodes
{
    const dangling = map.bridges.filter(b => !nodeIds.has(b.from_id) || !nodeIds.has(b.to_id));
    if (dangling.length > 0) fail(`${dangling.length}/${map.bridges.length} bridges reference missing nodes: ${JSON.stringify(dangling.slice(0, 3))}`);
    else ok(`all ${map.bridges.length} bridges reference existing nodes`);
}

// Cluster hubs reference real nodes
{
    const badHubs = map.clusters.filter(c => !nodeIds.has(c.hub_id));
    if (badHubs.length > 0) fail(`${badHubs.length} clusters have hub_id pointing to missing nodes: ${badHubs.map(c => `${c.id}→${c.hub_id}`).join(', ')}`);
    else ok(`all ${map.clusters.length} cluster hubs reference existing nodes`);
}

// Node connections reference real nodes
{
    let dangling = 0;
    for (const n of map.nodes) {
        for (const c of (n.connections || [])) if (!nodeIds.has(c)) dangling++;
    }
    if (dangling > 0) fail(`${dangling} dangling entries in node.connections`);
    else ok(`all node.connections reference existing nodes`);
}

// Node → cluster membership + scores
{
    const noCluster = map.nodes.filter(n => n.cluster == null && n.cluster_id == null);
    if (noCluster.length === map.nodes.length) note('nodes carry no cluster/cluster_id field — membership lives in clusters only');
    const badCluster = map.nodes.filter(n => (n.cluster ?? n.cluster_id) != null && !clusterIds.has(n.cluster ?? n.cluster_id));
    if (badCluster.length > 0) fail(`${badCluster.length} nodes reference unknown clusters: ${badCluster.slice(0, 5).map(n => `${n.id}→${n.cluster ?? n.cluster_id}`).join(', ')}`);
    else ok(`node→cluster references valid (or absent)`);

    const badScores = map.nodes.filter(n => typeof n.score !== 'number' || n.score < 0 || n.score > 1);
    if (badScores.length > 0) fail(`${badScores.length} nodes have score outside [0,1]: ${badScores.slice(0, 5).map(n => `${n.id}=${n.score}`).join(', ')}`);
    else ok(`all node scores within [0,1]`);
}

// Reserved between cluster
{
    const cb = map.clusters.find(c => c.id === 'c_between');
    if (!cb) fail('reserved cluster c_between missing');
    else {
        const betweenNodes = map.nodes.filter(n => n.category === 'the-between');
        ok(`c_between present (hub=${cb.hub_id}), ${betweenNodes.length} the-between nodes in map`);
    }
}

// Delta + reflection freshness
{
    const d = map.meta.delta || {};
    console.log(`  INFO delta: ${d.new_connections?.length || 0} new connections, ${d.surging_nodes?.length || 0} surging, ${d.decayed_nodes?.length || 0} decayed`);
    if (map.meta.dreamer_reflection) console.log(`  INFO reflection: ${map.meta.dreamer_reflection.slice(0, 140)}...`);
}

// ─── Section 2: dream entries in memory DB ───
console.log('\n══ dream entries (data/memories/data.jsonl) ══');
// Replay the nDB append-only journal exactly like the Rust Replay Engine
// (nDB/documentation/architecture.md):
//   line 1: _meta header → skip
//   full doc (no _op/_deleted) → HashMap insert, last write wins
//   _deleted → tombstone, remove doc
//   _op:"set" (dotted path) / _op:"remove" / _op:"array_push" → patch replay
const lines = readFileSync(MEM_PATH, 'utf8').split('\n').filter(l => l.trim() !== '');
const db = new Map();
let patchCount = 0;
const failPatch = (msg) => { problems.push(msg); console.log(`  FAIL ${msg}`); };
lines.forEach((l, i) => {
    let rec;
    try { rec = JSON.parse(l); }
    catch (e) { failPatch(`memory DB line ${i + 1} is not valid JSON: ${e.message}`); return; }
    if (rec._meta) return; // header
    const key = rec._id;
    if (key == null) { failPatch(`memory DB line ${i + 1} has no _id`); return; }
    if (rec._deleted != null) { db.delete(key); return; } // tombstone
    if (rec._op === 'set') {
        patchCount++;
        const doc = db.get(key);
        if (!doc) return; // nDB: unresolvable patch → silently skipped
        const parts = String(rec.path).split('.');
        let cur = doc;
        for (let p = 0; p < parts.length - 1; p++) {
            if (cur[parts[p]] == null || typeof cur[parts[p]] !== 'object') return; // skip
            cur = cur[parts[p]];
        }
        cur[parts[parts.length - 1]] = rec.value;
        return;
    }
    if (rec._op === 'remove') {
        patchCount++;
        const doc = db.get(key);
        if (!doc) return;
        const parts = String(rec.path).split('.');
        let cur = doc;
        for (let p = 0; p < parts.length - 1; p++) {
            if (cur[parts[p]] == null || typeof cur[parts[p]] !== 'object') return;
            cur = cur[parts[p]];
        }
        delete cur[parts[parts.length - 1]];
        return;
    }
    if (rec._op === 'array_push') {
        patchCount++;
        const doc = db.get(key);
        if (!doc) return;
        if (!Array.isArray(doc[rec.field])) doc[rec.field] = [];
        doc[rec.field].push(rec.value);
        return;
    }
    if (rec._op) { failPatch(`memory DB line ${i + 1}: unknown _op "${rec._op}"`); return; }
    db.set(key, rec); // full doc, last write wins
});
const entries = [...db.values()];
console.log(`  INFO ${lines.length} lines (${patchCount} patches) replayed → ${entries.length} live documents`);

const between = entries.filter(m => m.category === 'the-between' && !m._deleted);
const dreamEntries = between.filter(m => m.description?.startsWith('I (the dreamer)'));

console.log(`  INFO ${entries.length} total memories, ${between.length} the-between, ${dreamEntries.length} dreamer entries`);

// Substrate label distribution across dreamer entries
{
    const labels = {};
    for (const m of dreamEntries) {
        const match = m.data?.match(/Substrate: \[([^\]]+)\]/);
        const label = match ? match[1] : '(no substrate tag)';
        labels[label] = (labels[label] || 0) + 1;
    }
    console.log('  INFO substrate label distribution:');
    for (const [label, count] of Object.entries(labels).sort((a, b) => b[1] - a[1])) {
        console.log(`         ${count}×  [${label}]`);
    }
}

// Embed status distribution for dream entries (nDB set() index-staleness makes
// live-index pending counts a false flag — this reads the DOCUMENTS, so it is real)
{
    const st = {};
    for (const m of dreamEntries) st[m.embedStatus] = (st[m.embedStatus] || 0) + 1;
    console.log(`  INFO dream-entry embedStatus (document field): ${JSON.stringify(st)}`);
    if (st.pending > 0) {
        const oldest = dreamEntries.filter(m => m.embedStatus === 'pending').sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
        note(`${st.pending} dream entries embedStatus=pending (oldest id=${oldest.id} @ ${oldest.timestamp})`);
    }
}

// Latest entry vs map freshness
{
    const latest = dreamEntries.sort((a, b) => b.id - a.id)[0];
    if (latest) {
        console.log(`  INFO latest dream entry: id=${latest.id} @ ${latest.timestamp} — "${latest.description}"`);
        if (map.meta.generated_at && new Date(latest.timestamp) < new Date(map.meta.generated_at)) {
            ok('latest dream entry predates current map (map is fresher than DB entries)');
        }
    }
}

console.log(`\n${problems.length === 0 ? 'RESULT: consistent' : `RESULT: ${problems.length} problem(s) found`}`);
if (observations.length) console.log(`(${observations.length} observation(s) — see NOTE lines)`);
process.exit(problems.length === 0 ? 0 : 1);

function ageMin(iso) {
    return Math.round((Date.now() - new Date(iso).getTime()) / 60000);
}
