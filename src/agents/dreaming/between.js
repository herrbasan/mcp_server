// ─── The Between — partnership log guards ─────────────────────────────
// Spec: documentation/Workshop/the-between-spec.md (revised 2026-08-22).
//
// The-between entries are memories in category 'the-between', written in the
// seat's first person ("I (the partner, [substrate]) did X"). The dreamer (a
// small local model whose instinct is to merge semantically adjacent things)
// cannot be trusted to preserve them via prompt rules — these entries are
// guaranteed adjacent to user clusters because the partnership is about the
// user. Guards here are DETERMINISTIC and enforce the spec's invariants:
//
//   1. Cluster lock: the-between nodes always live in reserved cluster
//      `c_between`. Bridges to user clusters are legitimate topology and are
//      NOT touched — only cluster membership is locked.
//   2. First-person preservation: summaries keep the `I (` prefix. Failure →
//      deterministic rebuild from the raw memory description.
//   3. Substrate tag preserved: `[something]` tag must be present.
//   4. Compression floor: never below 'summary' state (title nodes get
//      reconstructed — title state keeps no voice).
//   5. Register lint: doer-language ("I am", "I feel", "I believe", "I want",
//      "I long") triggers the rebuild path. A lint, not a proof — the
//      register rule itself is prompt-carried. The lint converts silent
//      register drift into a loud, checkable contract.

export const BETWEEN_CATEGORY = 'the-between';
export const BETWEEN_CLUSTER_ID = 'c_between';
export const BETWEEN_CLUSTER_NAME = 'The Between (the partnership log)';
export const BETWEEN_OVERVIEW_TOP_N = 5;

// Doer-language lint. Matched on the summary text.
const REGISTER_LINT = /\bI\s+(?:am|feel|believe|want|long)\b/i;

// A valid between summary: starts in first person and carries a substrate tag.
export function isValidBetweenSummary(summary) {
    if (typeof summary !== 'string' || summary.length === 0) return false;
    if (!/^I\s*\(/.test(summary)) return false;
    if (!/\[[^\]]+\]/.test(summary)) return false;
    if (REGISTER_LINT.test(summary)) return false;
    return true;
}

// Deterministic rebuild: prefer the raw memory description (it was written by
// the seat itself); fall back to a minimal voice-carrying stub. Never trust
// the dreamer's rewrite when validation failed.
function rebuildBetweenSummary(memory) {
    if (memory && typeof memory.description === 'string' && isValidBetweenSummary(memory.description)) {
        // Truncate to a sane summary length; keep prefix + tag intact.
        const d = memory.description;
        return d.length > 220 ? d.slice(0, 217) + '...' : d;
    }
    const id = memory?.id ?? '?';
    return `I (the partner) — entry #${id}; see memory for detail.`;
}

function betweenNodes(map) {
    return (map.nodes || []).filter(n => n.category === BETWEEN_CATEGORY);
}

// Enforce all between invariants on a map, in place. `memories` is the live
// memory iterable (for raw-description rebuilds). Idempotent — safe to run on
// the same map repeatedly, and used both on the previous map (pre-pass, so
// the dreamer never sees a wrongly-merged partition) and on the fresh output
// (post-pass, before save — the validated map is what persists and feeds
// back, so no correction drift).
export function enforceBetween(map, memories) {
    if (!map || !Array.isArray(map.nodes)) return { repaired: 0, locked: 0 };

    const memById = new Map();
    const memIterable = memories?.iter ? memories.iter() : memories;
    if (memIterable) for (const m of memIterable) memById.set(m.id, m);

    const nodes = betweenNodes(map);
    if (nodes.length === 0) {
        // No between nodes — make sure no stale reserved cluster lingers.
        map.clusters = (map.clusters || []).filter(c => c.id !== BETWEEN_CLUSTER_ID);
        return { repaired: 0, locked: 0 };
    }

    let repaired = 0;

    for (const n of nodes) {
        // 1. Cluster lock
        if (n.cluster_id !== BETWEEN_CLUSTER_ID) {
            n.cluster_id = BETWEEN_CLUSTER_ID;
            repaired++;
        }

        // 4. Compression floor: below 'summary' is voice-death. Reconstruct
        // from raw memory — title state keeps nothing worth inheriting.
        if (n.state === 'title' || !n.summary) {
            n.state = 'summary';
            n.summary = rebuildBetweenSummary(memById.get(n.id));
            repaired++;
        }

        // 2+3+5. First person, substrate tag, register lint
        if (!isValidBetweenSummary(n.summary)) {
            n.summary = rebuildBetweenSummary(memById.get(n.id));
            n.state = n.state === 'full' ? 'full' : 'summary';
            repaired++;
        }
    }

    // Ensure the reserved cluster exists with the right hub (highest score
    // among between nodes). The dreamer may keep a stale hub_id otherwise.
    const clusters = map.clusters || [];
    let cluster = clusters.find(c => c.id === BETWEEN_CLUSTER_ID);
    if (!cluster) {
        cluster = { id: BETWEEN_CLUSTER_ID, name: BETWEEN_CLUSTER_NAME, hub_id: nodes[0].id, desc: "The model-side of the collaboration — session and dream entries in the seat's first person, substrate-tagged." };
        clusters.push(cluster);
        map.clusters = clusters;
        repaired++;
    } else {
        cluster.name = BETWEEN_CLUSTER_NAME;
    }
    const hub = [...nodes].sort((a, b) => (b.score ?? 0.3) - (a.score ?? 0.3))[0];
    if (cluster.hub_id !== hub.id) {
        cluster.hub_id = hub.id;
        repaired++;
    }

    return { repaired, locked: nodes.length };
}

// True if a completed dream cycle deserves a dream-entry (non-trivial only —
// spec decision #3: avoid per-run noise). Qualifying activity is recorded
// deterministically by the pipeline in map.meta.activity: edges formed,
// bridges added, clusters organized, compressions. Mere node adds ("N
// memories embedded") and score drift (surge/fade) are NOT qualifying —
// that is exactly the per-run telemetry the spec forbids.
export function isNonTrivialDream(map) {
    const a = map?.meta?.activity;
    if (!a) return false;
    return (a.edges_added > 0) || (a.bridges_added > 0) ||
        (a.clusters_added > 0) || (a.compressed > 0);
}

// Compose the dream-entry text (the dreamer's own first person, per the spec).
// Content comes from map.meta.activity (deterministic pipeline counts) plus
// surge/fade flavor from map.meta.delta. The substrate tag lives IN the
// description so the summary passes enforceBetween validation as-written.
// Reached only behind the isNonTrivialDream gate — no telemetry fallback.
export function dreamEntryText(map, substrateLabel) {
    if (typeof substrateLabel !== 'string' || substrateLabel.trim() === '') {
        throw new Error('dreamEntryText: substrateLabel required (set agents.dreaming.dreamerLabel in config.json)');
    }
    const a = map.meta?.activity || {};
    const d = map.meta?.delta || {};
    const parts = [];
    if (a.edges_added > 0) parts.push(`connected ${a.edges_added}`);
    if (a.bridges_added > 0) parts.push(`bridged ${a.bridges_added} pair${a.bridges_added === 1 ? '' : 's'}`);
    if (a.clusters_added > 0) parts.push(`formed ${a.clusters_added} cluster${a.clusters_added === 1 ? '' : 's'}`);
    if (a.compressed > 0) parts.push(`compressed ${a.compressed}`);
    if (d.surging_nodes?.length) parts.push(`watched ${d.surging_nodes.length} surge`);
    if (d.decayed_nodes?.length) parts.push(`let ${d.decayed_nodes.length} fade`);
    const did = parts.length > 0 ? parts.join(', ') : 'tended the map';
    return {
        description: `I (the dreamer, [${substrateLabel}]) tended the map: ${did}.`
    };
}
