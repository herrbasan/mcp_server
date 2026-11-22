// Notepad agent — deliberate state, NOT memory.
// v2 (scratch/notepad-proposal.md): owner boards, context registry, refs,
// body-only-on-get, stale pins, per-context snapshot view.
//
// BOUNDARY (design-doc, non-negotiable): the dreaming system and any
// background automation never create, edit, remove, or archive notepad items.
// All mutations flow through explicit notepad.* calls initiated by David or a
// seat in an active session. Verified mechanically: src/agents/dreaming/ has
// no import of this module and no toolRouter access — the only writers are
// David or a model calling the tools below. Nothing automatic: no
// auto-archive, no background curation. Stale pins are surfaced in the
// snapshot, never acted on.

import fs from 'fs';
import { basename, extname } from 'path';
import { getLogger } from '../../utils/logger.js';
import { createNdbClient } from '../../lib/ndb-client.js';
import { requireFields, requireId } from '../../utils/require-fields.js';

const logger = getLogger();

const TYPES = ['idea', 'task', 'date', 'contact'];
// Bucket file references are `<hash>.<ext>`. `ndb serve` v1b writes the full
// 64-hex SHA-256; databases converted from the NAPI era hold 8-hex ids — both
// must stay readable (the URL is content-addressed, never regenerated).
export const FILE_REF_RE = /^([0-9a-f]{8}|[0-9a-f]{64})\.([A-Za-z0-9]+)$/;
const OWNERS = ['david', 'machine'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTEXT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Internal documents (id counter, context registry) live under an
// underscore-prefixed _id — item filters exclude everything starting with '_'.
const SEED_CONTEXTS = [
    'raum', 'blog', 'arena', 'teaching', 'materna-bav', 'materna-tremonia',
    'materna-dok-tools', 'nspeech', 'infrastructure', 'research',
];

// Fields each type accepts on add/update. Anything else is rejected — silent
// drops of mistyped fields are the failure mode where a model sets `due` on a
// contact and never learns it went nowhere.
const TYPE_FIELDS = {
    common: ['title', 'notes', 'owner', 'ref', 'body'],
    idea: ['status', 'context'],
    task: ['due', 'status', 'steps', 'context'],
    date: ['when', 'recur', 'context'],
    contact: ['phone', 'email', 'address'],
};

const EXT_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
    '.json': 'application/json', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

// ── State ────────────────────────────────────────────────────────────
// Exported so server.js REST routes share the same open database and the
// same mutation functions — one writer, two transports.
export const store = {
    db: null,
    config: null,
    baseUrl: null,
};

let NEXT_ID = null;
let META_ID = null;   // actual _id of the counter document (insert prefix yields a suffix)
// Serializes id allocation: the counter patch must land in the same order the
// ids were handed out, or a restart reissues a number already in use.
let ALLOC_LOCK = Promise.resolve();

// ── Init ─────────────────────────────────────────────────────────────

export async function init(context) {
    const config = context.config?.agents?.notepad || {};
    const baseUrl = config.ndbUrl || context.config?.ndb?.serviceUrl;
    const dbName = config.dbName || context.config?.ndb?.dbs?.notepad || 'notepad';
    if (!baseUrl) throw new Error('notepad.init: no ndb service URL — set config.ndb.serviceUrl (agents.notepad.ndbUrl overrides)');

    const client = createNdbClient(baseUrl);
    const health = await client.health();
    if (!health?.ok) throw new Error(`notepad.init: ndb serve at ${baseUrl} reported unhealthy: ${JSON.stringify(health)}`);
    const mounted = health.dbs || [];
    if (!mounted.includes(dbName)) {
        throw new Error(
            `notepad.init: database "${dbName}" is not mounted in ndb serve at ${baseUrl} ` +
            `(mounted: ${mounted.length ? mounted.join(', ') : 'none'}) — start the service with that DB`
        );
    }

    const db = client.db(dbName);
    // Idempotent in nDB: `created` reports whether the index was new.
    await db.createIndex('id');
    await db.createIndex('type');
    await db.createIndex('status');

    store.db = db;
    store.baseUrl = baseUrl;
    store.config = { ...config };

    // Sequential integer ids (LLM-friendly: "task 12"). Counter persists in a
    // _meta document; cached in memory after the single startup read.
    const meta = (await iterAllDocs()).find(d => typeof d._id === 'string' && d._id.startsWith('_meta'));
    if (!meta) {
        META_ID = (await db.insert({ nextId: 2 }, { prefix: '_meta' })).id;
        NEXT_ID = 1;
    } else {
        META_ID = meta._id;
        if (typeof meta.nextId !== 'number') throw new Error(`notepad.init: _meta document ${meta._id} has no numeric nextId (got ${JSON.stringify(meta.nextId)})`);
        NEXT_ID = meta.nextId;
    }
    ALLOC_LOCK = Promise.resolve();

    // Seed the context registry on first boot (empty registry only). David
    // trims the list via context_remove before real use — that's why remove
    // exists even though the proposal lists only add/list/rename.
    if ((await listContextDocs()).length === 0) {
        for (const name of SEED_CONTEXTS) {
            await db.insert({ name }, { prefix: '_ctx' });
        }
        logger.info(`[Notepad] Seeded context registry: ${SEED_CONTEXTS.join(', ')}`, null, 'Notepad');
    }

    logger.info(
        `[Notepad] ndb serve db "${dbName}" at ${baseUrl} (${await countItems()} items, ${(await listContextDocs()).length} contexts)`,
        null, 'Notepad'
    );
}

async function iterAllDocs() {
    return store.db.allSnapshotDocs();
}

function isItemDoc(d) {
    return typeof d._id === 'string' && !d._id.startsWith('_');
}

async function countItems() {
    return (await iterAllDocs()).filter(isItemDoc).length;
}

// ── Record helpers ───────────────────────────────────────────────────

async function allocId() {
    const task = ALLOC_LOCK.then(async () => {
        const id = NEXT_ID;
        NEXT_ID += 1;
        await store.db.patch(META_ID, [{ op: 'set', path: 'nextId', value: NEXT_ID }]);
        return id;
    });
    ALLOC_LOCK = task.then(() => {}, () => {});
    return task;
}

async function findById(id) {
    const { results } = await store.db.find('id', id);
    const hits = results.filter(isItemDoc);
    if (hits.length === 0) throw new Error(`Notepad item #${id} not found`);
    return hits[0];
}

function requireType(type) {
    if (!TYPES.includes(type)) {
        throw new Error(`notepad: type must be one of ${TYPES.join('|')} (received: ${JSON.stringify(type)})`);
    }
}

function requireOwner(owner) {
    if (!OWNERS.includes(owner)) {
        throw new Error(`notepad: owner is required and must be one of ${OWNERS.join('|')} (received: ${JSON.stringify(owner)})`);
    }
    return owner;
}

function requireDate(value, field) {
    if (!DATE_RE.test(value)) {
        throw new Error(`notepad: ${field} must be YYYY-MM-DD (received: ${JSON.stringify(value)})`);
    }
    return value;
}

function normalizeSteps(steps) {
    if (!Array.isArray(steps)) {
        throw new Error(`notepad: steps must be an array (received: ${typeof steps})`);
    }
    return steps.map((s, i) => {
        const text = typeof s === 'string' ? s : s?.text;
        if (!text || typeof text !== 'string') {
            throw new Error(`notepad: steps[${i}] must be a string or {text} (received: ${JSON.stringify(s)})`);
        }
        return { text, done: typeof s === 'object' && s.done === true };
    });
}

function normalizeRefs(refs) {
    if (!Array.isArray(refs)) {
        throw new Error(`notepad: ref must be an array of strings (received: ${typeof refs})`);
    }
    return refs.map((r, i) => {
        if (!r || typeof r !== 'string') throw new Error(`notepad: ref[${i}] must be a string (received: ${JSON.stringify(r)})`);
        return r;
    });
}

function validateTypedFields(type, fields) {
    const allowed = [...TYPE_FIELDS.common, ...TYPE_FIELDS[type]];
    const unknown = Object.keys(fields).filter(k => !allowed.includes(k));
    if (unknown.length > 0) {
        throw new Error(`notepad: fields [${unknown.join(', ')}] are not valid for type "${type}" (allowed: ${allowed.join(', ')})`);
    }
    return fields;
}

function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Next occurrence of a (possibly yearly) date. Returns { when, daysUntil }.
function nextOccurrence(when, recur) {
    const today = todayStr();
    if (recur !== 'yearly' || when >= today) return { when, daysUntil: Math.round((new Date(when) - new Date(today)) / 86400000) };
    const year = new Date().getFullYear();
    const thisYear = `${year}${when.slice(4)}`;
    const next = thisYear >= today ? thisYear : `${year + 1}${when.slice(4)}`;
    return { when: next, daysUntil: Math.round((new Date(next) - new Date(today)) / 86400000) };
}

// body is delivered ONLY by getItem — title is the post-it line, body is the
// long payload and must not leak into list/snapshot responses (token economy:
// the snapshot enters every session's context window).
function publicDoc(doc, { includeBody = false } = {}) {
    const { _id, body, ...rest } = doc;
    if (includeBody) rest.body = body ?? null;
    // Owner is required on writes; pre-v2 items (none in production) read as
    // david — conservative default.
    rest.owner = rest.owner ?? 'david';
    return rest;
}

// Compact shape for list/snapshot — dashboards render progress, not prose.
function taskSummary(doc) {
    const steps = doc.steps || [];
    return {
        id: doc.id, type: doc.type, title: doc.title, due: doc.due ?? null,
        status: doc.status, owner: doc.owner ?? 'david', context: doc.context ?? null,
        stepsDone: steps.filter(s => s.done).length, stepsTotal: steps.length,
        nextStep: steps.find(s => !s.done)?.text ?? null,
    };
}

// David's board first within every snapshot section — secretary duties
// outrank the machine's own notes.
function byBoard(a, b) {
    return (a.owner === 'machine' ? 1 : 0) - (b.owner === 'machine' ? 1 : 0);
}

// ── Context registry (contexts are deliberate state too) ────────────

async function listContextDocs() {
    return (await iterAllDocs())
        .filter(d => typeof d._id === 'string' && d._id.startsWith('_ctx'))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function canonicalContext(name) {
    if (!name || typeof name !== 'string') throw new Error('notepad: context name must be a non-empty string');
    const canonical = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!CONTEXT_RE.test(canonical)) {
        throw new Error(`notepad: context "${canonical}" invalid — lowercase alphanumeric, hyphens between (e.g. "materna-bav")`);
    }
    return canonical;
}

// Unknown contexts error with a fuzzy suggestion — freeform contexts rot into
// "raum" / "raum.com" / "website" drift.
async function assertContextExists(name) {
    const canonical = canonicalContext(name);
    const known = (await listContextDocs()).map(d => d.name);
    if (known.includes(canonical)) return canonical;
    const suggestion = known.find(k => k.startsWith(canonical) || canonical.startsWith(k) || k.includes(canonical) || canonical.includes(k));
    throw new Error(`unknown context "${canonical}"${suggestion ? ` — did you mean "${suggestion}"?` : ` — known contexts: ${known.join(', ')}`}`);
}

export async function contextAdd(args) {
    requireFields(args, ['name'], 'notepad.context_add');
    const canonical = canonicalContext(args.name);
    if ((await listContextDocs()).some(d => d.name === canonical)) {
        throw new Error(`notepad.context_add: context "${canonical}" already exists`);
    }
    await store.db.insert({ name: canonical, createdAt: new Date().toISOString() }, { prefix: '_ctx' });
    return { added: canonical, contexts: (await listContextDocs()).map(d => d.name) };
}

export async function contexts() {
    return { contexts: (await listContextDocs()).map(d => d.name) };
}

export async function contextRename(args) {
    requireFields(args, ['from', 'to'], 'notepad.context_rename');
    const from = await assertContextExists(args.from);
    const to = canonicalContext(args.to);
    if (from === to) throw new Error('notepad.context_rename: from and to are the same');
    if ((await listContextDocs()).some(d => d.name === to)) throw new Error(`notepad.context_rename: context "${to}" already exists`);

    const oldDoc = (await listContextDocs()).find(d => d.name === from);
    await store.db.insert({ name: to, createdAt: oldDoc.createdAt }, { prefix: '_ctx' });
    await store.db.delete(oldDoc._id);
    for (const doc of (await iterAllDocs()).filter(d => isItemDoc(d) && d.context === from)) {
        await store.db.patch(doc._id, [{ op: 'set', path: 'context', value: to }]);
    }
    return { renamed: from, to, contexts: (await listContextDocs()).map(d => d.name) };
}

// Not in the original proposal — needed so David can trim the seed list.
// Refuses while any item still references the context (implicit renumbering
// is the drift problem the registry exists to prevent).
export async function contextRemove(args) {
    requireFields(args, ['name'], 'notepad.context_remove');
    const name = await assertContextExists(args.name);
    const users = (await iterAllDocs()).filter(d => isItemDoc(d) && d.context === name);
    if (users.length > 0) {
        throw new Error(`notepad.context_remove: "${name}" is used by ${users.length} item(s) (#${users.map(d => d.id).join(', #')}) — move or clear them first`);
    }
    const doc = (await listContextDocs()).find(d => d.name === name);
    await store.db.delete(doc._id);
    return { removed: name, contexts: (await listContextDocs()).map(d => d.name) };
}

// ── Mutations (shared by MCP tools + REST routes) ────────────────────

export async function addItem(args) {
    requireFields(args, ['type', 'title', 'owner'], 'notepad.add');
    requireType(args.type);
    const { type, title } = args;
    if (typeof title !== 'string' || !title.trim()) throw new Error('notepad.add: title must be a non-empty string');

    const now = new Date().toISOString();
    const doc = {
        id: await allocId(), type, title: title.trim(), notes: args.notes ?? null,
        owner: requireOwner(args.owner), createdAt: now, updatedAt: now,
    };

    if (args.context !== undefined) {
        if (type === 'contact') throw new Error('notepad.add: context is not valid on contact items');
        doc.context = await assertContextExists(args.context);
    }
    if (args.ref !== undefined) doc.ref = normalizeRefs(args.ref);
    if (args.body !== undefined) {
        if (typeof args.body !== 'string') throw new Error('notepad.add: body must be a string');
        doc.body = args.body;
    }

    if (type === 'task') {
        doc.status = 'open';
        if (args.due !== undefined) doc.due = requireDate(args.due, 'due');
        if (args.steps !== undefined) doc.steps = normalizeSteps(args.steps);
    } else if (type === 'idea') {
        doc.status = 'open';
    } else if (type === 'date') {
        requireFields(args, ['when'], 'notepad.add (type=date)');
        doc.when = requireDate(args.when, 'when');
        doc.recur = args.recur ?? 'none';
        if (!['none', 'yearly'].includes(doc.recur)) throw new Error('notepad.add: recur must be none|yearly');
    } else if (type === 'contact') {
        if (!args.phone && !args.email && !args.address) {
            throw new Error('notepad.add: contact needs at least one of phone | email | address');
        }
        if (args.phone) doc.phone = args.phone;
        if (args.email) doc.email = args.email;
        if (args.address) doc.address = args.address;
    }

    const { id: _id } = await store.db.insert(doc);
    return { _id, item: publicDoc(await store.db.get(_id)) };
}

export async function listItems(args = {}) {
    const { type, status, owner, context, limit = 100 } = args;
    // Rust-side filtering: `id` exists only on real items (_ctx/_meta carry the
    // registry and the counter, never an item id).
    const filter = { id: { $exists: true } };
    if (type) {
        requireType(type);
        filter.type = { $eq: type };
    }
    if (status) filter.status = { $eq: status };
    if (owner) filter.owner = { $eq: requireOwner(owner) };
    if (context) filter.context = { $eq: await assertContextExists(context) };

    const { results } = await store.db.query({
        filter,
        sort: { field: 'id', dir: 'asc' },
        offset: 0,
        limit,
    });
    return results.map(taskOrFull);
}

function taskOrFull(doc) {
    return doc.type === 'task' && doc.status === 'open' ? taskSummary(doc) : publicDoc(doc);
}

export async function getItem(args) {
    requireFields(args, ['id'], 'notepad.get');
    return publicDoc(await findById(requireId(args.id, 'id', 'notepad.get')), { includeBody: true });
}

export async function updateItem(args) {
    requireFields(args, ['id'], 'notepad.update');
    if (args.type !== undefined) throw new Error('notepad.update: type cannot be changed (use notepad.promote for idea→task)');
    const doc = await findById(requireId(args.id, 'id', 'notepad.update'));
    const { id: _ignored, ...patch } = args;
    if (Object.keys(patch).length === 0) throw new Error('notepad.update: no fields to update (received keys: [id])');

    validateTypedFields(doc.type, patch);

    if (patch.owner !== undefined) patch.owner = requireOwner(patch.owner);
    if (patch.context !== undefined) {
        if (doc.type === 'contact') throw new Error('notepad.update: context is not valid on contact items');
        patch.context = await assertContextExists(patch.context);
    }
    if (patch.ref !== undefined) patch.ref = normalizeRefs(patch.ref);
    if (patch.body !== undefined && typeof patch.body !== 'string') throw new Error('notepad.update: body must be a string');
    if (patch.due !== undefined) patch.due = requireDate(patch.due, 'due');
    if (patch.when !== undefined) patch.when = requireDate(patch.when, 'when');
    if (patch.recur !== undefined && !['none', 'yearly'].includes(patch.recur)) throw new Error('notepad.update: recur must be none|yearly');
    if (patch.steps !== undefined) patch.steps = normalizeSteps(patch.steps);
    if (patch.status !== undefined) {
        const valid = doc.type === 'task' ? ['open', 'done', 'cancelled'] : ['open', 'promoted', 'archived'];
        if (!valid.includes(patch.status)) throw new Error(`notepad.update: status for ${doc.type} must be ${valid.join('|')}`);
        if (patch.status === 'done') patch.completedAt = new Date().toISOString();
    }

    patch.updatedAt = new Date().toISOString();
    // One atomic patch: a null field is removed, everything else set — an
    // array `steps` swap replaces the array wholesale.
    await store.db.patch(doc._id, Object.entries(patch).map(([field, value]) =>
        value === null
            ? { op: 'remove', path: field }
            : { op: 'set', path: field, value }
    ));
    return publicDoc(await store.db.get(doc._id));
}

export async function completeItem(args) {
    requireFields(args, ['id'], 'notepad.complete');
    const doc = await findById(requireId(args.id, 'id', 'notepad.complete'));
    if (doc.type !== 'task') throw new Error(`notepad.complete: item #${doc.id} is a ${doc.type}, only tasks can be completed`);

    const now = new Date().toISOString();
    let ops;
    if (args.stepIndex !== undefined) {
        const idx = requireId(args.stepIndex, 'stepIndex', 'notepad.complete');
        const steps = doc.steps || [];
        if (idx >= steps.length) throw new Error(`notepad.complete: stepIndex ${idx} out of range (task has ${steps.length} steps)`);
        ops = [{ op: 'set', path: `steps.${idx}.done`, value: true }];
    } else {
        ops = [
            { op: 'set', path: 'status', value: 'done' },
            { op: 'set', path: 'completedAt', value: now },
        ];
    }
    ops.push({ op: 'set', path: 'updatedAt', value: now });
    await store.db.patch(doc._id, ops);
    return publicDoc(await store.db.get(doc._id));
}

export async function removeItem(args) {
    requireFields(args, ['id'], 'notepad.remove');
    const doc = await findById(requireId(args.id, 'id', 'notepad.remove'));
    // Release bucket attachments — nDB only trashes a file when no active
    // document still references its nURI (dedup means shared files survive,
    // and a still-referenced file answers 409, which is not a failure here).
    for (const att of doc.attachments || []) {
        const ref = String(att.ref || '');
        const sep = ref.indexOf(':');
        if (sep < 0) throw new Error(`notepad.remove: attachment ref "${ref}" is not <bucket>:<hash>.<ext>`);
        try {
            await store.db.releaseFile(ref.slice(0, sep), ref.slice(sep + 1));
        } catch (e) {
            logger.warn(`[Notepad] releaseFile(${ref}) left the file in place: ${e.message}`, null, 'Notepad');
        }
    }
    await store.db.delete(doc._id);
    return { removed: doc.id, title: doc.title };
}

export async function promoteIdea(args) {
    requireFields(args, ['id'], 'notepad.promote');
    const doc = await findById(requireId(args.id, 'id', 'notepad.promote'));
    if (doc.type !== 'idea') throw new Error(`notepad.promote: item #${doc.id} is a ${doc.type}, only ideas can be promoted`);

    const task = await addItem({
        type: 'task', title: doc.title, notes: doc.notes,
        owner: doc.owner ?? 'david', context: doc.context, ref: doc.ref, body: doc.body,
    });
    await store.db.patch(doc._id, [
        { op: 'set', path: 'status', value: 'promoted' },
        { op: 'set', path: 'promotedTo', value: task.item.id },
        { op: 'set', path: 'updatedAt', value: new Date().toISOString() },
    ]);
    return { idea: publicDoc(await store.db.get(doc._id)), task: task.item };
}

export async function attachBuffer(id, name, data, mime) {
    const doc = await findById(requireId(id, 'id', 'notepad.attach'));
    const meta = await store.db.storeFile('notepad', data, name);

    const attachments = doc.attachments || [];
    attachments.push({ ref: meta.ref, name, type: mime, size: meta.size, addedAt: new Date().toISOString() });
    await store.db.patch(doc._id, [
        { op: 'set', path: 'attachments', value: attachments },
        { op: 'set', path: 'updatedAt', value: new Date().toISOString() },
    ]);

    return { item: doc.id, attachment: attachments[attachments.length - 1], url: `/notepad/files/${meta.hash}.${meta.ext}` };
}

export async function attachFile(args) {
    requireFields(args, ['id', 'path'], 'notepad.attach');
    if (!fs.existsSync(args.path)) throw new Error(`notepad.attach: file not found: ${args.path}`);
    const ext = extname(args.path).toLowerCase();
    return attachBuffer(args.id, args.name ?? basename(args.path), fs.readFileSync(args.path), EXT_MIME[ext] ?? 'application/octet-stream');
}

// Returns the raw bytes, or null when the bucket holds no such file.
export async function getFileBuffer(hash, ext) {
    const got = await store.db.getFile('notepad', `${hash}.${ext}`);
    if (!got) return null;
    return got.buffer;
}

// ── Snapshot (the Today view — computed on read, never stored) ───────

export async function snapshot(args = {}) {
    const dueSoonDays = store.config.dueSoonDays ?? 7;
    const staleDays = store.config.staleDays ?? 60;
    const today = todayStr();
    const staleCutoff = new Date(Date.now() - staleDays * 86400000).toISOString();

    const all = await iterAllDocs();
    const docs = all.filter(isItemDoc);
    const openTasks = docs.filter(d => d.type === 'task' && d.status === 'open');
    const openIdeas = docs.filter(d => d.type === 'idea' && d.status === 'open');

    const result = {
        generatedAt: new Date().toISOString(),
        today,
        dueSoonDays,
    };

    // 1. Project-start view: everything open in one context (the pin check —
    // part of project start, same slot as reading the project's Agents.md).
    if (args.context) {
        const ctx = await assertContextExists(args.context);
        result.context = ctx;
        result.contextOpen = [
            ...openTasks.filter(d => d.context === ctx).sort(byBoard).map(taskSummary),
            ...openIdeas.filter(d => d.context === ctx).sort(byBoard)
                .map(d => ({ id: d.id, title: d.title, owner: d.owner ?? 'david', createdAt: d.createdAt })),
        ];
    }

    result.overdue = openTasks.filter(d => d.due && d.due < today)
        .sort((a, b) => a.due.localeCompare(b.due) || byBoard(a, b)).map(taskSummary);
    result.dueSoon = openTasks.filter(d => d.due && d.due >= today && Math.round((new Date(d.due) - new Date(today)) / 86400000) <= dueSoonDays)
        .sort((a, b) => a.due.localeCompare(b.due) || byBoard(a, b)).map(taskSummary);
    result.openTasks = openTasks.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || byBoard(a, b)).map(taskSummary);

    result.upcoming = docs.filter(d => d.type === 'date')
        .map(d => ({ id: d.id, title: d.title, owner: d.owner ?? 'david', recur: d.recur, ...nextOccurrence(d.when, d.recur) }))
        .filter(d => d.daysUntil >= 0 && d.daysUntil <= dueSoonDays)
        .sort((a, b) => a.when.localeCompare(b.when) || byBoard(a, b));

    result.recentIdeas = openIdeas.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byBoard(a, b))
        .slice(0, 5)
        .map(d => ({ id: d.id, title: d.title, owner: d.owner ?? 'david', createdAt: d.createdAt }));

    // Stale pins — untriggered open ideas past ~2 months. Surfaced as a
    // cleanup prompt, machine-side only; nothing is ever archived here
    // automatically.
    result.stalePins = openIdeas.filter(d => d.createdAt < staleCutoff)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(d => ({ id: d.id, title: d.title, owner: d.owner ?? 'david', createdAt: d.createdAt }));

    // Footer: the context vocabulary, visible before creating a new one.
    result.contexts = all
        .filter(d => typeof d._id === 'string' && d._id.startsWith('_ctx'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => d.name);

    return result;
}

// ── MCP tool handlers ────────────────────────────────────────────────
// Envelope per house convention: { content: [{type:'text', text}], isError }.
// Named exports — the agent loader resolves handlers via mod[tool.name]
// and hard-exits if a config.json tool has no matching named export.

function ok(result) {
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
}

export const notepad_add = async (args) => ok(await addItem(args));
export const notepad_list = async (args) => ok(await listItems(args));
export const notepad_get = async (args) => ok(await getItem(args));
export const notepad_update = async (args) => ok(await updateItem(args));
export const notepad_complete = async (args) => ok(await completeItem(args));
export const notepad_remove = async (args) => ok(await removeItem(args));
export const notepad_promote = async (args) => ok(await promoteIdea(args));
export const notepad_attach = async (args) => ok(await attachFile(args));
export const notepad_snapshot = async (args) => ok(await snapshot(args));
export const notepad_context_add = async (args) => ok(await contextAdd(args));
export const notepad_contexts = async () => ok(await contexts());
export const notepad_context_rename = async (args) => ok(await contextRename(args));
export const notepad_context_remove = async (args) => ok(await contextRemove(args));
