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
import { resolve, basename, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { loadNdb } from '../memory/ndb-loader.js';
import { requireFields, requireId } from '../../utils/require-fields.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = getLogger();

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const TYPES = ['idea', 'task', 'date', 'contact'];
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
};

let NEXT_ID = null;
let META_ID = null;   // actual _id of the counter document (insertWithPrefix appends a suffix)

// ── Init ─────────────────────────────────────────────────────────────

export async function init(context) {
    const config = context.config?.agents?.notepad || {};
    const dbPath = resolve(PROJECT_ROOT, config.dbPath || 'data/notepad/data.jsonl');

    const { Database } = loadNdb();
    const db = Database.open(dbPath, { persistence: 'immediate' });

    if (!db.hasIndex('id')) db.createIndex('id');
    if (!db.hasIndex('type')) db.createIndex('type');
    if (!db.hasIndex('status')) db.createIndex('status');

    store.db = db;
    store.config = { ...config, dbPath };

    // Sequential integer ids (LLM-friendly: "task 12"). Counter persists in a
    // _meta document; cached in memory after the single startup read.
    const meta = db.iter().find(d => d._id.startsWith('_meta'));
    if (!meta) {
        META_ID = db.insertWithPrefix('_meta', { nextId: 2 });
        NEXT_ID = 1;
    } else {
        META_ID = meta._id;
        NEXT_ID = meta.nextId;
    }

    // Seed the context registry on first boot (empty registry only). David
    // trims the list via context_remove before real use — that's why remove
    // exists even though the proposal lists only add/list/rename.
    if (listContextDocs().length === 0) {
        for (const name of SEED_CONTEXTS) {
            db.insertWithPrefix('_ctx', { name });
        }
        logger.info(`[Notepad] Seeded context registry: ${SEED_CONTEXTS.join(', ')}`, null, 'Notepad');
    }

    logger.info(`[Notepad] nDB open at ${dbPath} (${countItems()} items, ${listContextDocs().length} contexts)`, null, 'Notepad');
}

function isItemDoc(d) {
    return !d._id.startsWith('_');
}

function countItems() {
    return store.db.iter().filter(isItemDoc).length;
}

// ── Record helpers ───────────────────────────────────────────────────

function allocId() {
    const id = NEXT_ID;
    NEXT_ID += 1;
    store.db.set(META_ID, 'nextId', NEXT_ID);
    return id;
}

function findById(id) {
    const hits = store.db.find('id', id).filter(isItemDoc);
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

function listContextDocs() {
    return store.db.iter()
        .filter(d => d._id.startsWith('_ctx'))
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
function assertContextExists(name) {
    const canonical = canonicalContext(name);
    const known = listContextDocs().map(d => d.name);
    if (known.includes(canonical)) return canonical;
    const suggestion = known.find(k => k.startsWith(canonical) || canonical.startsWith(k) || k.includes(canonical) || canonical.includes(k));
    throw new Error(`unknown context "${canonical}"${suggestion ? ` — did you mean "${suggestion}"?` : ` — known contexts: ${known.join(', ')}`}`);
}

export function contextAdd(args) {
    requireFields(args, ['name'], 'notepad.context_add');
    const canonical = canonicalContext(args.name);
    if (listContextDocs().some(d => d.name === canonical)) {
        throw new Error(`notepad.context_add: context "${canonical}" already exists`);
    }
    store.db.insertWithPrefix('_ctx', { name: canonical, createdAt: new Date().toISOString() });
    return { added: canonical, contexts: listContextDocs().map(d => d.name) };
}

export function contexts() {
    return { contexts: listContextDocs().map(d => d.name) };
}

export function contextRename(args) {
    requireFields(args, ['from', 'to'], 'notepad.context_rename');
    const from = assertContextExists(args.from);
    const to = canonicalContext(args.to);
    if (from === to) throw new Error('notepad.context_rename: from and to are the same');
    if (listContextDocs().some(d => d.name === to)) throw new Error(`notepad.context_rename: context "${to}" already exists`);

    const oldDoc = listContextDocs().find(d => d.name === from);
    store.db.insertWithPrefix('_ctx', { name: to, createdAt: oldDoc.createdAt });
    store.db.delete(oldDoc._id);
    for (const doc of store.db.iter().filter(d => isItemDoc(d) && d.context === from)) {
        store.db.set(doc._id, 'context', to);
    }
    return { renamed: from, to, contexts: listContextDocs().map(d => d.name) };
}

// Not in the original proposal — needed so David can trim the seed list.
// Refuses while any item still references the context (implicit renumbering
// is the drift problem the registry exists to prevent).
export function contextRemove(args) {
    requireFields(args, ['name'], 'notepad.context_remove');
    const name = assertContextExists(args.name);
    const users = store.db.iter().filter(d => isItemDoc(d) && d.context === name);
    if (users.length > 0) {
        throw new Error(`notepad.context_remove: "${name}" is used by ${users.length} item(s) (#${users.map(d => d.id).join(', #')}) — move or clear them first`);
    }
    const doc = listContextDocs().find(d => d.name === name);
    store.db.delete(doc._id);
    return { removed: name, contexts: listContextDocs().map(d => d.name) };
}

// ── Mutations (shared by MCP tools + REST routes) ────────────────────

export function addItem(args) {
    requireFields(args, ['type', 'title', 'owner'], 'notepad.add');
    requireType(args.type);
    const { type, title } = args;
    if (typeof title !== 'string' || !title.trim()) throw new Error('notepad.add: title must be a non-empty string');

    const now = new Date().toISOString();
    const doc = {
        id: allocId(), type, title: title.trim(), notes: args.notes ?? null,
        owner: requireOwner(args.owner), createdAt: now, updatedAt: now,
    };

    if (args.context !== undefined) {
        if (type === 'contact') throw new Error('notepad.add: context is not valid on contact items');
        doc.context = assertContextExists(args.context);
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

    const _id = store.db.insert(doc);
    return { _id, item: publicDoc(store.db.get(_id)) };
}

export function listItems(args = {}) {
    const { type, status, owner, context, limit = 100 } = args;
    let docs = store.db.iter().filter(isItemDoc);
    if (type) {
        requireType(type);
        docs = docs.filter(d => d.type === type);
    }
    if (status) docs = docs.filter(d => d.status === status);
    if (owner) {
        requireOwner(owner);
        docs = docs.filter(d => (d.owner ?? 'david') === owner);
    }
    if (context) docs = docs.filter(d => d.context === assertContextExists(context));
    docs.sort((a, b) => a.id - b.id);
    return docs.slice(0, limit).map(taskOrFull);
}

function taskOrFull(doc) {
    return doc.type === 'task' && doc.status === 'open' ? taskSummary(doc) : publicDoc(doc);
}

export function getItem(args) {
    requireFields(args, ['id'], 'notepad.get');
    return publicDoc(findById(requireId(args.id, 'id', 'notepad.get')), { includeBody: true });
}

export function updateItem(args) {
    requireFields(args, ['id'], 'notepad.update');
    if (args.type !== undefined) throw new Error('notepad.update: type cannot be changed (use notepad.promote for idea→task)');
    const doc = findById(requireId(args.id, 'id', 'notepad.update'));
    const { id: _ignored, ...patch } = args;
    if (Object.keys(patch).length === 0) throw new Error('notepad.update: no fields to update (received keys: [id])');

    validateTypedFields(doc.type, patch);

    if (patch.owner !== undefined) patch.owner = requireOwner(patch.owner);
    if (patch.context !== undefined) {
        if (doc.type === 'contact') throw new Error('notepad.update: context is not valid on contact items');
        patch.context = assertContextExists(patch.context);
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
    applyPatch(doc._id, patch);
    return publicDoc(store.db.get(doc._id));
}

// db.set() per field: delta patches, and nDB's set() on an array field
// replaces it wholesale (steps swap is one write, not a doc rewrite).
function applyPatch(_id, patch) {
    for (const [field, value] of Object.entries(patch)) {
        if (value === null) {
            store.db.remove(_id, field);
        } else {
            store.db.set(_id, field, value);
        }
    }
}

export function completeItem(args) {
    requireFields(args, ['id'], 'notepad.complete');
    const doc = findById(requireId(args.id, 'id', 'notepad.complete'));
    if (doc.type !== 'task') throw new Error(`notepad.complete: item #${doc.id} is a ${doc.type}, only tasks can be completed`);

    if (args.stepIndex !== undefined) {
        const idx = requireId(args.stepIndex, 'stepIndex', 'notepad.complete');
        const steps = doc.steps || [];
        if (idx >= steps.length) throw new Error(`notepad.complete: stepIndex ${idx} out of range (task has ${steps.length} steps)`);
        store.db.set(doc._id, `steps.${idx}.done`, true);
    } else {
        store.db.set(doc._id, 'status', 'done');
        store.db.set(doc._id, 'completedAt', new Date().toISOString());
    }
    store.db.set(doc._id, 'updatedAt', new Date().toISOString());
    return publicDoc(store.db.get(doc._id));
}

export function removeItem(args) {
    requireFields(args, ['id'], 'notepad.remove');
    const doc = findById(requireId(args.id, 'id', 'notepad.remove'));
    // Release bucket attachments — nDB only trashes a file when no active
    // document still references its nURI (dedup means shared files survive).
    for (const att of doc.attachments || []) {
        try { store.db.releaseFile(att.ref); } catch (e) {
            logger.warn(`[Notepad] releaseFile(${att.ref}) failed: ${e.message}`, null, 'Notepad');
        }
    }
    store.db.delete(doc._id);
    return { removed: doc.id, title: doc.title };
}

export function promoteIdea(args) {
    requireFields(args, ['id'], 'notepad.promote');
    const doc = findById(requireId(args.id, 'id', 'notepad.promote'));
    if (doc.type !== 'idea') throw new Error(`notepad.promote: item #${doc.id} is a ${doc.type}, only ideas can be promoted`);

    const task = addItem({
        type: 'task', title: doc.title, notes: doc.notes,
        owner: doc.owner ?? 'david', context: doc.context, ref: doc.ref, body: doc.body,
    });
    store.db.set(doc._id, 'status', 'promoted');
    store.db.set(doc._id, 'promotedTo', task.item.id);
    store.db.set(doc._id, 'updatedAt', new Date().toISOString());
    return { idea: publicDoc(store.db.get(doc._id)), task: task.item };
}

export function attachBuffer(id, name, data, mime) {
    const doc = findById(requireId(id, 'id', 'notepad.attach'));
    const meta = store.db.storeFile('notepad', name, data, mime);
    const ref = `${meta._file.bucket}:${meta._file.id}.${meta._file.ext}`;

    const attachments = doc.attachments || [];
    attachments.push({ ref, name: meta.name, type: mime, size: meta.size, addedAt: new Date().toISOString() });
    store.db.set(doc._id, 'attachments', attachments);
    store.db.set(doc._id, 'updatedAt', new Date().toISOString());

    return { item: doc.id, attachment: attachments[attachments.length - 1], url: `/notepad/files/${meta._file.id}.${meta._file.ext}` };
}

export function attachFile(args) {
    requireFields(args, ['id', 'path'], 'notepad.attach');
    if (!fs.existsSync(args.path)) throw new Error(`notepad.attach: file not found: ${args.path}`);
    const ext = extname(args.path).toLowerCase();
    return attachBuffer(args.id, args.name ?? basename(args.path), fs.readFileSync(args.path), EXT_MIME[ext] ?? 'application/octet-stream');
}

export function getFileBuffer(hash, ext) {
    return store.db.getFile('notepad', hash, ext);
}

// ── Snapshot (the Today view — computed on read, never stored) ───────

export function snapshot(args = {}) {
    const dueSoonDays = store.config.dueSoonDays ?? 7;
    const staleDays = store.config.staleDays ?? 60;
    const today = todayStr();
    const staleCutoff = new Date(Date.now() - staleDays * 86400000).toISOString();

    const docs = store.db.iter().filter(isItemDoc);
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
        const ctx = assertContextExists(args.context);
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
    result.contexts = listContextDocs().map(d => d.name);

    return result;
}

// ── MCP tool handlers ────────────────────────────────────────────────
// Envelope per house convention: { content: [{type:'text', text}], isError }.
// Named exports — the agent loader resolves handlers via mod[tool.name]
// and hard-exits if a config.json tool has no matching named export.

function ok(result) {
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
}

export const notepad_add = (args) => ok(addItem(args));
export const notepad_list = (args) => ok(listItems(args));
export const notepad_get = (args) => ok(getItem(args));
export const notepad_update = (args) => ok(updateItem(args));
export const notepad_complete = (args) => ok(completeItem(args));
export const notepad_remove = (args) => ok(removeItem(args));
export const notepad_promote = (args) => ok(promoteIdea(args));
export const notepad_attach = (args) => ok(attachFile(args));
export const notepad_snapshot = (args) => ok(snapshot(args));
export const notepad_context_add = (args) => ok(contextAdd(args));
export const notepad_contexts = () => ok(contexts());
export const notepad_context_rename = (args) => ok(contextRename(args));
export const notepad_context_remove = (args) => ok(contextRemove(args));
