// Findings store — nDB v2 over `ndb serve` (decision §7.3): status transitions
// need mutation, JSONL append-only would make that a rewrite mess. Same pattern
// as notepad. Finding identity is the content fingerprint (evidence + failure
// mode), so rejected findings stay rejected as line numbers shift across
// snapshots.

import { createNdbClient } from '../../lib/ndb-client.js';

// nDB caps an explicit limit at 50 000; larger result sets are paged, never
// silently truncated.
const PAGE_SIZE = 5_000;

let DB = null;

export async function initStore({ serviceUrl, dbName } = {}) {
    if (!serviceUrl) {
        throw new Error('codereview store: serviceUrl is required — set config.ndb.serviceUrl (agents.codereview.ndbUrl overrides)');
    }
    if (!dbName) {
        throw new Error('codereview store: dbName is required — set config.ndb.dbs.codereview (agents.codereview.dbName overrides)');
    }

    const client = createNdbClient(serviceUrl);
    const health = await client.health();
    if (!health?.ok) {
        throw new Error(`codereview store: ndb serve at ${serviceUrl} reported unhealthy: ${JSON.stringify(health)}`);
    }
    const mounted = health.dbs || [];
    if (!mounted.includes(dbName)) {
        throw new Error(
            `codereview store: database "${dbName}" is not mounted in ndb serve at ${serviceUrl} ` +
            `(mounted: ${mounted.length ? mounted.join(', ') : 'none'}) — start the service with that DB`
        );
    }

    const db = client.db(dbName);
    // Idempotent in nDB: `created` reports whether the index was new.
    for (const field of ['id', 'type', 'reviewId', 'fingerprint', 'snapshotHash', 'status', 'sourceLabel', 'modelPair', 'validatorVersion']) {
        await db.createIndex(field);
    }
    DB = db;
    return DB;
}

function requireDb() {
    if (!DB) throw new Error('codereview store: not initialized — init(context) must run first');
    return DB;
}

// Every matching document, paged — the caller's filter is applied Rust-side.
async function queryAll(filter, { sort } = {}) {
    const db = requireDb();
    const first = await db.query({ filter, sort, offset: 0, limit: PAGE_SIZE });
    if (first.total <= first.results.length) return first.results;
    const out = [...first.results];
    while (out.length < first.total) {
        const page = await db.query({ filter, sort, offset: out.length, limit: PAGE_SIZE });
        if (page.results.length === 0) {
            throw new Error(`codereview store: query returned an empty page at offset ${out.length} of ${first.total}`);
        }
        out.push(...page.results);
    }
    return out;
}

function patchOps(patch) {
    const ops = [];
    for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        ops.push({ op: 'set', path: field, value });
    }
    if (ops.length === 0) throw new Error('codereview store: empty patch');
    return ops;
}

export async function saveReview(review) {
    const db = requireDb();
    const { id } = await db.insert({ type: 'review', ...review, createdAt: new Date().toISOString() }, { prefix: 'rev' });
    return id;
}

export async function updateReview(id, patch) {
    const db = requireDb();
    const doc = await db.get(id);
    if (!doc) throw new Error(`codereview store: review ${id} not found`);
    await db.patch(id, patchOps(patch));
}

export async function getReview(id) {
    return requireDb().get(id) ?? null;
}

export async function findLatestReviewForSource(sourceLabel, modelPairKey, validatorVersion) {
    const db = requireDb();
    const { results } = await db.query({
        filter: {
            type: { $eq: 'review' },
            sourceLabel: { $eq: sourceLabel },
            modelPair: { $eq: modelPairKey },
            validatorVersion: { $eq: validatorVersion },
            status: { $eq: 'done' },
        },
        sort: { field: 'createdAt', dir: 'desc' },
        offset: 0,
        limit: 1,
    });
    return results[0] ?? null;
}

/**
 * Persist a finding. If the same fingerprint was REJECTED in a prior review of
 * the same source, the rejection stands — the finding does not resurface every
 * incremental run (spec §4.3).
 */
export async function saveFinding(finding) {
    const db = requireDb();
    // Rejection carry-forward is scoped to the SAME source (and never to the
    // review that just emitted the finding) — a fingerprint match from another
    // project's review is a different finding, not a prior rejection.
    const prior = await queryAll({
        type: { $eq: 'finding' },
        fingerprint: { $eq: finding.fingerprint },
        sourceLabel: { $eq: finding.sourceLabel },
    });
    const rejectedPrior = prior.find((p) => p.status === 'rejected' && p.reviewId !== finding.reviewId);
    const status = rejectedPrior ? 'rejected' : (finding.status ?? 'new');
    const { id } = await db.insert({
        type: 'finding',
        ...finding,
        status,
        priorRejectionOf: rejectedPrior?._id ?? null,
        createdAt: new Date().toISOString()
    }, { prefix: 'fnd' });
    return { id, status };
}

export async function listFindings(filter = {}) {
    const query = { type: { $eq: 'finding' } };
    if (filter.reviewId) query.reviewId = { $eq: filter.reviewId };
    if (filter.status) query.status = { $eq: filter.status };
    if (filter.snapshotHash) query.snapshotHash = { $eq: filter.snapshotHash };
    return queryAll(query, { sort: { field: 'createdAt', dir: 'asc' } });
}

export async function getFinding(id) {
    return requireDb().get(id) ?? null;
}

export async function updateFinding(id, patch) {
    const db = requireDb();
    const doc = await db.get(id);
    if (!doc) throw new Error(`codereview store: finding ${id} not found`);
    await db.patch(id, patchOps({ ...patch, updatedAt: new Date().toISOString() }));
}
