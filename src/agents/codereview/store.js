// Findings store — nDB (decision §7.3): status transitions need mutation,
// JSONL append-only would make that a rewrite mess. Same pattern as notepad.
// Finding identity is the content fingerprint (evidence + failure mode), so
// rejected findings stay rejected as line numbers shift across snapshots.

import path from 'path';
import { loadNdb } from '../memory/ndb-loader.js';

let DB = null;

export function initStore(dataDir) {
    const { Database } = loadNdb();
    const dbPath = path.join(dataDir, 'db', 'data.jsonl');
    DB = new Database(dbPath);
    return DB;
}

function requireDb() {
    if (!DB) throw new Error('codereview store: not initialized — init(context) must run first');
    return DB;
}

export async function saveReview(review) {
    const db = requireDb();
    const id = db.insertWithPrefix('rev', { type: 'review', ...review, createdAt: new Date().toISOString() });
    return id;
}

export async function updateReview(id, patch) {
    const db = requireDb();
    const doc = db.get(id);
    if (!doc) throw new Error(`codereview store: review ${id} not found`);
    db.update(id, { ...doc, ...patch });
}

export async function getReview(id) {
    return requireDb().get(id) ?? null;
}

export async function findLatestReviewForSource(sourceLabel, modelPairKey, validatorVersion) {
    const db = requireDb();
    const reviews = await db.query({ type: { $eq: 'review' }, sourceLabel: { $eq: sourceLabel }, modelPair: { $eq: modelPairKey } });
    const eligible = reviews.filter((r) => r.validatorVersion === validatorVersion && r.status === 'done');
    eligible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return eligible[0] ?? null;
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
    const prior = await db.query({
        type: { $eq: 'finding' },
        fingerprint: { $eq: finding.fingerprint },
        sourceLabel: { $eq: finding.sourceLabel }
    });
    const rejectedPrior = prior.find((p) => p.status === 'rejected' && p.reviewId !== finding.reviewId);
    const status = rejectedPrior ? 'rejected' : (finding.status ?? 'new');
    const id = db.insertWithPrefix('fnd', {
        type: 'finding',
        ...finding,
        status,
        priorRejectionOf: rejectedPrior?._id ?? null,
        createdAt: new Date().toISOString()
    });
    return { id, status };
}

export async function listFindings(filter = {}) {
    const db = requireDb();
    const query = { type: { $eq: 'finding' } };
    if (filter.reviewId) query.reviewId = { $eq: filter.reviewId };
    if (filter.status) query.status = { $eq: filter.status };
    if (filter.snapshotHash) query.snapshotHash = { $eq: filter.snapshotHash };
    const docs = await db.query(query);
    docs.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return docs;
}

export async function getFinding(id) {
    return requireDb().get(id) ?? null;
}

export async function updateFinding(id, patch) {
    const db = requireDb();
    const doc = db.get(id);
    if (!doc) throw new Error(`codereview store: finding ${id} not found`);
    db.update(id, { ...doc, ...patch, updatedAt: new Date().toISOString() });
}
