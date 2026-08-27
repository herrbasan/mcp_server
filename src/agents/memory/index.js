import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { loadNdb } from './ndb-loader.js';
import { requireFields, requireId } from '../../utils/require-fields.js';
import { createProgressReporter } from '../../utils/progress-reporter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = getLogger();

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

// ── State ────────────────────────────────────────────────────────────

let DB = null;            // nDB Database instance
let VDB_AGENT = null;     // VDB agent instance (for nVDB collection access)
let MEM_COLL = null;      // nVDB 'memory' collection
let GATEWAY = null;       // LLM Gateway client
let CONFIG = null;        // Memory agent config
let EMBEDDING_DIM = 2560; // Must match VDB agent + gateway model

// ── Helpers ──────────────────────────────────────────────────────────

function serializeData(data) {
    if (data == null) return '';
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function embedText(gateway, description, data, maxChars, opts) {
    const parts = [description];
    if (data) parts.push(serializeData(data));
    const combined = parts.join(' ');
    const safe = combined.length > maxChars ? combined.slice(0, maxChars) : combined;
    return gateway.embed(safe, opts);
}

function normId(id) {
    return typeof id === 'number' ? id : parseInt(String(id || '').replace(/^#/, ''), 10);
}

// Tool name prefix for validation errors — keeps messages consistent.
const TOOL = 'memory';

// Find the nDB _id for a memory by its integer id field.
// Uses the 'id' index (created at init).
function findNdbIdByMemId(memId) {
    const hits = DB.find('id', memId);
    if (hits.length === 0) return null;
    return hits[0]._id;
}

// Read the _meta document to get/set nextId.
function getNextId() {
    const metaHits = DB.iter().filter(d => d._id.startsWith('_meta'));
    if (metaHits.length === 0) throw new Error('Memory _meta document not found');
    return metaHits[0].nextId;
}

function incrementNextId() {
    const metaHits = DB.iter().filter(d => d._id.startsWith('_meta'));
    if (metaHits.length === 0) throw new Error('Memory _meta document not found');
    const meta = metaHits[0];
    const newNextId = meta.nextId + 1;
    DB.set(meta._id, 'nextId', newNextId);
    return meta.nextId;
}

// ── Init / Shutdown ──────────────────────────────────────────────────

export async function init(context) {
    GATEWAY = context.gateway;
    CONFIG = context.config?.agents?.memory || {};

    // Open nDB
    const dbPath = resolve(PROJECT_ROOT, CONFIG.dbPath || 'data/memories/data.jsonl');
    const { Database } = loadNdb();
    DB = Database.open(dbPath, { persistence: 'immediate' });

    // Create indexes if they don't exist
    if (!DB.hasIndex('id')) DB.createIndex('id');
    if (!DB.hasIndex('category')) DB.createIndex('category');
    if (!DB.hasIndex('embedStatus')) DB.createIndex('embedStatus');

    // Get the VDB agent and access the memory collection
    VDB_AGENT = context.agents?.get('vdb');
    if (VDB_AGENT?.getCollection) {
        EMBEDDING_DIM = VDB_AGENT.embeddingDim || EMBEDDING_DIM;
        try {
            MEM_COLL = VDB_AGENT.getCollection('memory');
            logger.info(`[Memory] nVDB 'memory' collection ready (dim=${EMBEDDING_DIM})`, null, 'Memory');
        } catch {
            // Collection doesn't exist yet — the VDB agent creates it lazily via getCollection
            // but that may fail if the VDB agent isn't fully initialized. Try creating it.
            try {
                MEM_COLL = VDB_AGENT.getCollection('memory');
            } catch (e2) {
                logger.warn(`[Memory] nVDB memory collection unavailable: ${e2.message}. Recall will degrade to recency.`, null, 'Memory');
            }
        }
    } else {
        logger.warn('[Memory] VDB agent not available — recall will degrade to recency', null, 'Memory');
    }

    // Clean up orphaned vectors: soft-deleted nDB documents may still have
    // vectors in nVDB if the delete didn't flush properly. Remove them.
    if (MEM_COLL) {
        const deletedIds = DB.deletedIds().filter(id => id.startsWith('mem_'));
        let cleaned = 0;
        for (const id of deletedIds) {
            try { MEM_COLL.delete(id); cleaned++; } catch {}
        }
        if (cleaned > 0) {
            MEM_COLL.flush();
            logger.info(`[Memory] Cleaned up ${cleaned} orphaned vectors from nVDB`, null, 'Memory');
        }
    }

    const memCount = DB.iter().filter(d => d._id.startsWith('mem_')).length;
    logger.info(`[Memory] Initialized: ${memCount} memories in nDB at ${dbPath}`, null, 'Memory');

    return {
        // Dreaming agent compatibility: expose .memories as an object with
        // .iter() (returns array of memory docs) and .memories (getter alias
        // for backward compatibility with the old JSON-backed agent).
        memories: {
            iter: () => DB.iter().filter(d => d._id.startsWith('mem_')),
            get memories() { return DB.iter().filter(d => d._id.startsWith('mem_')); },
            get: (memId) => {
                const ndbId = findNdbIdByMemId(memId);
                return ndbId ? DB.get(ndbId) : null;
            },
            count: () => DB.iter().filter(d => d._id.startsWith('mem_')).length
        }
    };
}

export async function shutdown() {
    if (DB) DB.flush();
    if (MEM_COLL) {
        try { MEM_COLL.flush(); } catch {}
    }
}

// ── Tool: memory_store ───────────────────────────────────────────────

export async function memory_store(args, context) {
    const { gateway, progress } = context;
    requireFields(args, ['description'], `${TOOL}.store`);
    const description = args.description || args.text;
    const category = args.category || 'notes';
    const confidence = args.confidence ?? 0.5;
    const { data } = args;
    const now = new Date().toISOString();
    const maxChars = CONFIG.maxMemoryChars || 6000;

    // Store immediately — embedding runs detached so provider hangs never
    // block the tool response. Marked pending; self-heal in memory_overview
    // re-embeds stragglers automatically.
    const memId = incrementNextId();
    const doc = {
        id: memId,
        description,
        category,
        confidence: Math.max(0, Math.min(1, confidence)),
        timestamp: now,
        embedStatus: 'pending'
    };
    if (data) doc.data = data;

    const ndbId = DB.insertWithPrefix('mem', doc);
    DB.flush();

    // Detached: embed in background. On success the vector is inserted and
    // embedStatus → 'embedded'. On failure embedError is set; the periodic
    // self-heal in memory_overview retries it later.
    // Background timeout: let the wrapper queue work it off, don't abort at
    // the foreground cap (would churn pending->heal->retry).
    embedText(gateway, description, data, maxChars, { background: true }).then(embedding => {
        if (MEM_COLL) {
            MEM_COLL.insert(ndbId, embedding, JSON.stringify({ id: memId }));
            MEM_COLL.flush();
        }
        DB.set(ndbId, 'embedStatus', 'embedded');
        DB.set(ndbId, 'embedError', null);
        DB.flush();
    }).catch(err => {
        DB.set(ndbId, 'embedError', err.message || 'embed failed');
        DB.flush();
    });

    const totalCount = DB.iter().filter(d => d._id.startsWith('mem_')).length;

    return {
        content: [{ type: 'text', text: `✓ #${memId} [${category}] stored (${totalCount} memories total). Embedding runs in background — visible to memory_recall within seconds.` }]
    };
}

export { memory_store as memory_remember };

// ── Tool: memory_recall ──────────────────────────────────────────────

export async function memory_recall(args, context) {
    const { gateway, progress } = context;
    const { query, limit = 5, category } = args;
    const pr = createProgressReporter(progress);

    pr.set('Embedding query...', 20, true);
    const maxChars = CONFIG.maxMemoryChars || 6000;
    const safeQuery = query.length > maxChars ? query.slice(0, maxChars) : query;

    let queryEmbed = null;
    let embedError = null;
    try {
        queryEmbed = await gateway.embed(safeQuery);
    } catch (err) {
        // Embed timed out or provider unreachable — degrade to recency so the
        // model still gets context, but surface the REAL error. The generic
        // "embed provider error" hid the actual failure mode for months.
        embedError = err.message || String(err);
        logger.warn(`[Memory] recall query embed failed: ${embedError}`, null, 'Memory');
    }
    pr.set('Searching memory index...', 60);

    // Get candidates (optionally filtered by category)
    let candidates = DB.iter().filter(d => d._id.startsWith('mem_'));
    if (category) candidates = candidates.filter(m => m.category === category);

    if (!queryEmbed || !MEM_COLL) {
        // Degrade to recency
        const recent = candidates.slice(-limit).reverse();
        if (!recent.length) {
            pr.done('Search complete');
            return { content: [{ type: 'text', text: 'No memories found. This topic is new — consider storing insights with memory_store as you learn.' }] };
        }
        const results = recent.map(m => {
            const conf = m.confidence ?? 0.5;
            const hasData = m.data ? ' [has data]' : '';
            return `[#${m.id}] [${m.category}] conf:${conf.toFixed(1)}${hasData}\n${m.description}`;
        }).join('\n\n');
        const reason = !MEM_COLL ? 'nVDB unavailable' : (embedError || 'embed provider error');
        pr.done('Search complete');
        return {
            content: [{ type: 'text', text: `⚠ Semantic search unavailable (${reason}) — returning ${recent.length} most recent memories instead:\n\n${results}` }]
        };
    }

    // Semantic search via nVDB — over-fetch so the summary tier has headroom
    const searchResults = MEM_COLL.search({
        vector: queryEmbed,
        topK: Math.max(limit * 5, 25)
    });

    if (searchResults.length === 0) {
        pr.done('Search complete');
        return { content: [{ type: 'text', text: 'No memories found. This topic is new — consider storing insights with memory_store as you learn.' }] };
    }

    pr.set('Ranking results...', 80);

    // Join nVDB hits with nDB documents, apply confidence weighting
    const scored = [];
    const seenIds = new Set();

    for (const hit of searchResults) {
        // DB.get throws for soft-deleted documents. A vector may linger in
        // nVDB after its nDB doc was deleted (tombstoned) — skip those hits.
        let doc;
        try {
            doc = DB.get(hit.id);
        } catch {
            continue;
        }
        if (!doc || !doc._id?.startsWith('mem_')) continue;
        if (seenIds.has(doc.id)) continue;
        if (category && doc.category !== category) continue;
        seenIds.add(doc.id);

        const conf = doc.confidence ?? 0.5;
        const sim = hit.score;
        scored.push({ ...doc, score: sim, weightedScore: sim * (0.7 + conf * 0.3) });
    }

    scored.sort((a, b) => b.weightedScore - a.weightedScore);

    // Split into full-text tier (top `limit`) and summary tier (the rest
    // above a score floor, so the LLM knows what else was found).
    const SCORE_FLOOR = 0.35;
    const top = scored.slice(0, limit);
    const also = scored.slice(limit).filter(m => m.score >= SCORE_FLOOR);

    if (!top.length) {
        return { content: [{ type: 'text', text: 'No memories found. This topic is new — consider storing insights with memory_store as you learn.' }] };
    }

    const results = top.map(m => {
        const conf = m.confidence ?? 0.5;
        const hasData = m.data ? ' [has data]' : '';
        return `[#${m.id}] [${m.category}] ${(m.score * 100).toFixed(1)}% conf:${conf.toFixed(1)}${hasData}\n${m.description}`;
    }).join('\n\n');

    // Compact summary of second-tier results: one line each, no description.
    let summary = '';
    if (also.length > 0) {
        const lines = also.map(m =>
            `#${m.id} [${m.category}] ${(m.score * 100).toFixed(1)}%`
        ).join('  ');
        summary = `\n\n--- also found ---\n${lines}`;
    }

    const totalFound = scored.length;
    const header = also.length > 0
        ? `Found ${totalFound} memories (showing top ${top.length} with details):`
        : `Found ${top.length} memories:`;

    pr.done('Search complete');
    return {
        content: [{ type: 'text', text: `${header}\n\n${results}${summary}` }]
    };
}

// ── Tool: memory_get ─────────────────────────────────────────────────

export async function memory_get(args, context) {
    const id = requireId(args.id, 'id', `${TOOL}.get`);
    const ndbId = findNdbIdByMemId(id);

    if (!ndbId) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }

    const memory = DB.get(ndbId);
    const conf = memory.confidence ?? 0.5;
    let result = `[#${memory.id}] [${memory.category}] conf:${conf.toFixed(1)}\n`;
    result += `Description: ${memory.description}\n`;
    if (memory.data) result += `Data: ${serializeData(memory.data)}\n`;
    result += `Created: ${memory.timestamp}`;

    return { content: [{ type: 'text', text: result }] };
}

// ── Tool: memory_forget ──────────────────────────────────────────────

export async function memory_forget(args, context) {
    const id = requireId(args.id, 'id', `${TOOL}.forget`);
    const ndbId = findNdbIdByMemId(id);

    if (!ndbId) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }

    DB.delete(ndbId);
    DB.flush();

    // Also remove the vector from nVDB
    if (MEM_COLL) {
        try { MEM_COLL.delete(ndbId); MEM_COLL.flush(); } catch {}
    }

    return { content: [{ type: 'text', text: `✓ Forgot memory #${id}.` }] };
}

// ── Tool: memory_list ────────────────────────────────────────────────

export async function memory_list(args, context) {
    const { category } = args;
    let list = DB.iter().filter(d => d._id.startsWith('mem_'));
    if (category) list = list.filter(m => m.category === category);

    if (!list.length) {
        return { content: [{ type: 'text', text: 'No memories found. Memory is empty or no match for this category.' }] };
    }

    const formatted = list.map(m => {
        const conf = m.confidence ?? 0.5;
        const hasData = m.data ? ' [has data]' : '';
        return `[#${m.id}] [${m.category}] conf:${conf.toFixed(1)}${hasData} - ${m.description}`;
    }).join('\n');

    return {
        content: [{ type: 'text', text: `${list.length} memories stored:\n\n${formatted}` }]
    };
}

// ── Tool: memory_update ──────────────────────────────────────────────

export async function memory_update(args, context) {
    const { gateway } = context;
    const id = requireId(args.id, 'id', `${TOOL}.update`);
    const { description, category, confidence, data } = args;

    const ndbId = findNdbIdByMemId(id);
    if (!ndbId) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }

    const memory = DB.get(ndbId);
    const textChanged = (description && description !== memory.description) || (data !== undefined && data !== memory.data);

    if (textChanged) {
        const newDesc = description || memory.description;
        const newData = data !== undefined ? data : memory.data;
        const maxChars = CONFIG.maxMemoryChars || 6000;
        // Detached: embed in background so provider hangs never block the
        // response. Self-heal picks up failures on the next memory_overview.
        // Background timeout: let the wrapper queue work it off.
        embedText(gateway, newDesc, newData, maxChars, { background: true }).then(newEmbedding => {
            if (MEM_COLL) {
                MEM_COLL.insert(ndbId, newEmbedding, JSON.stringify({ id }));
                MEM_COLL.flush();
            }
            DB.set(ndbId, 'embedStatus', 'embedded');
            DB.set(ndbId, 'embedError', null);
            DB.flush();
        }).catch(err => {
            DB.set(ndbId, 'embedStatus', 'pending');
            DB.set(ndbId, 'embedError', err.message || 'embed failed');
            DB.flush();
        });
    }

    if (description) DB.set(ndbId, 'description', description);
    if (category) DB.set(ndbId, 'category', category);
    if (confidence !== undefined) DB.set(ndbId, 'confidence', Math.max(0, Math.min(1, confidence)));
    if (data !== undefined) {
        if (data === null) {
            DB.remove(ndbId, 'data');
        } else {
            DB.set(ndbId, 'data', data);
        }
    }

    DB.set(ndbId, 'timestamp', new Date().toISOString());
    DB.flush();

    return {
        content: [{ type: 'text', text: `Updated #${id}. Use memory_recall to verify.` }]
    };
}

// ── Self-heal: re-embed memories stored during provider outages ──────

let lastHealAt = 0;

// The embedStatus secondary index goes stale: nDB's set() (delta patch) does
// NOT update indexes, so docs flipped pending→embedded via set() stay indexed
// as 'pending' in the running process. Always count pending via a linear scan
// of live docs — small dataset (~1k), and correct regardless of index state.
function findPendingMemories() {
    return DB.iter().filter(d => d._id.startsWith('mem_') && d.embedStatus === 'pending');
}

async function memoryEmbedHeal(context, batchLimit = 10, onProgress = null) {
    const { gateway } = context;
    if (!gateway) return { healed: 0, remaining: 0, skipped: 'no gateway' };
    if (!MEM_COLL) return { healed: 0, remaining: 0, skipped: 'no nVDB collection' };

    const pending = findPendingMemories();
    if (pending.length === 0) return { healed: 0, remaining: 0 };

    const maxChars = CONFIG.maxMemoryChars || 6000;
    const batch = pending.slice(0, batchLimit);
    let healed = 0;
    for (let i = 0; i < batch.length; i++) {
        const m = batch[i];
        try {
            // Background timeout: let the wrapper queue work it off.
            const embedding = await embedText(gateway, m.description, m.data, maxChars, { background: true });
            MEM_COLL.insert(m._id, embedding, JSON.stringify({ id: m.id }));
            DB.set(m._id, 'embedStatus', 'embedded');
            DB.set(m._id, 'embedError', null);
            healed++;
        } catch (err) {
            DB.set(m._id, 'embedError', err.message || 'embed failed');
            break;
        }
        if (onProgress) onProgress(i + 1, batch.length, `Re-embedding memory #${m.id} (${i + 1}/${batch.length})`);
    }
    if (healed > 0) {
        MEM_COLL.flush();
        DB.flush();
    }
    return { healed, remaining: pending.length - healed };
}

export async function memory_embed_heal(args, context) {
    const pr = createProgressReporter(context?.progress);
    const result = await memoryEmbedHeal(context, args?.batchLimit || 50, (done, total, msg) => pr.step(done, total, msg));
    pr.done(`Embed heal finished: ${result.healed} re-embedded, ${result.remaining} still pending`);
    return {
        content: [{ type: 'text', text: `Embed heal: ${result.healed} re-embedded, ${result.remaining} still pending${result.skipped ? ` (${result.skipped})` : ''}.` }]
    };
}

// ── Tool: memory_overview ────────────────────────────────────────────

function momentumArrow(momentum) {
    if (!momentum) return '';
    const delta = typeof momentum === 'object' ? momentum.delta : momentum;
    if (delta > 1) return ' ↗';
    if (delta < -1) return ' ↘';
    return '';
}

function nodeLabel(n) {
    if (n.state === 'title') return n.title || `#${n.id}`;
    return n.summary || n.title || `#${n.id}`;
}

// Summary-tier bounds. The summary is the cheap orientation pass — it must stay
// small enough to avoid client pagination. Deep detail is behind recall/full.
// (Issue #14: 242KB summary at 1177 nodes / 2036 bridges was defeating the purpose.)
const SUMMARY = {
    clusterDescChars: 160, // cluster teaser length — descs otherwise read like node summaries
    maxClusters: 20,       // max cluster lines in summary (by hub score desc)
    maxBridges: 20,        // max bridge lines, then a …and N more pointer
};

function truncate(s, max) {
    if (!s) return s;
    return s.length <= max ? s : s.slice(0, max).trimEnd() + '…';
}

export async function memory_overview(args, context) {
    const { format = 'summary' } = args;
    const mapPath = join(__dirname, '..', '..', '..', 'data', 'dream_map.json');

    // Self-heal trigger: session start is the natural cadence. Fire in the
    // background (rate-limited to 1 pass/min, 10 embeddings per pass).
    const pendingEmbedCount = findPendingMemories().length;
    if (pendingEmbedCount > 0 && Date.now() - lastHealAt > 60000) {
        lastHealAt = Date.now();
        memoryEmbedHeal(context, 10).catch(() => {});
    }

    if (!existsSync(mapPath)) {
        return { content: [{ type: 'text', text: 'No knowledge map available yet. It is generated automatically every 15 minutes, or run dream_generate to create one now.' }] };
    }

    const map = JSON.parse(readFileSync(mapPath, 'utf-8'));
    const lines = [`[Your Knowledge — generated ${map.meta?.generated_at || 'unknown'}]`];
    const memCount = DB.iter().filter(d => d._id.startsWith('mem_')).length;
    const nodeCount = map.nodes?.length || 0;

    if (pendingEmbedCount > 0) {
        lines.push(`⚠ ${pendingEmbedCount} ${pendingEmbedCount === 1 ? 'memory' : 'memories'} pending re-embed (stored during provider outage) — self-heal running in background.\n`);
    }

    // TL;DR
    const tldrParts = [];
    if (map.clusters?.length) {
        const topClusters = [...map.clusters].sort((a, b) => {
            const aScore = map.nodes?.find(n => n.id === a.hub_id)?.score || 0;
            const bScore = map.nodes?.find(n => n.id === b.hub_id)?.score || 0;
            return bScore - aScore;
        }).slice(0, 3);
        tldrParts.push(`focused on ${topClusters.map(c => c.name).join(', ')}`);
    }
    if (map.bridges?.length) tldrParts.push(`${map.bridges.length} active bridges between topics`);
    if (tldrParts.length) lines.push(`**TL;DR**: You're ${tldrParts.join(' with ')}.\n`);

    // Dreamer self-audit
    if (map.meta?.dreamer_reflection) {
        lines.push(`> ${map.meta.dreamer_reflection}\n`);
    }

    // Delta
    const delta = map.meta?.delta;
    if (delta) {
        const parts = [];
        if (delta.new_connections?.length) parts.push(`${delta.new_connections.length} new connections`);
        if (delta.surging_nodes?.length) parts.push(`${delta.surging_nodes.length} surging ↗`);
        if (delta.decayed_nodes?.length) {
            const fadingLabels = delta.decayed_nodes.map(id => {
                const n = map.nodes?.find(n => n.id === id);
                return `#${id}${n ? ` ${nodeLabel(n)}` : ''}`;
            });
            parts.push(`${delta.decayed_nodes.length} fading ↘ (${fadingLabels.join(', ')})`);
        }
        if (delta.promoted?.length) parts.push(`${delta.promoted.length} promoted`);
        if (delta.demoted?.length) parts.push(`${delta.demoted.length} demoted`);
        if (delta.compressed_to_summary?.length) parts.push(`${delta.compressed_to_summary.length} compressed to summary`);
        if (delta.compressed_to_title?.length) parts.push(`${delta.compressed_to_title.length} compressed to title`);
        if (parts.length) lines.push(`Since last dream: ${parts.join(', ')}\n`);
    }

    lines.push(`${nodeCount} nodes covering ${memCount} memories\n`);

    // Lighter tier: clusters only (names + hub + counts). All a session start
    // needs to pick a recall query. No bridges, no top-nodes, no node detail.
    if (format === 'clusters') {
        if (map.clusters?.length) {
            lines.push('## Clusters');
            for (const c of map.clusters) {
                if (c.id === 'c_between') continue; // covered by The Between via recall
                const cNodes = map.nodes?.filter(n => n.cluster_id === c.id) || [];
                lines.push(`- **${c.name}** (${cNodes.length} nodes) [hub: #${c.hub_id}]`);
            }
            lines.push('');
        }
        lines.push(`Use format: 'summary' for bridges and top nodes, 'full' for all ${nodeCount} nodes with details.`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    // The Between — dedicated second-person section (spec: the section being
    // *addressed to the instance* is what makes the region inherited, not
    // merely listed). Top-N capped; recall is the paid path for detail.
    const betweenNodes = (map.nodes || []).filter(n => n.category === 'the-between');
    if (betweenNodes.length > 0) {
        const top = [...betweenNodes].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
        lines.push('## The Between — your side (the partner\'s log)');
        for (const n of top) {
            lines.push(`- #${n.id} ${n.state === 'title' ? '(title-only — recall for detail)' : n.summary}`);
        }
        if (betweenNodes.length > top.length) {
            lines.push(`…and ${betweenNodes.length - top.length} more — use memory_recall (category: the-between) for the full log.`);
        }
        lines.push('');
    }

    // Clusters — descs truncated to teaser length, capped by hub score.
    if (map.clusters?.length) {
        // The between has its own section above — don't double-list it.
        const listedClusters = map.clusters.filter(c => c.id !== 'c_between');
        const scored = listedClusters.map(c => ({
            c,
            score: map.nodes?.find(n => n.id === c.hub_id)?.score || 0,
        })).sort((a, b) => b.score - a.score);
        for (const { c } of scored.slice(0, SUMMARY.maxClusters)) {
            const cNodes = map.nodes?.filter(n => n.cluster_id === c.id) || [];
            lines.push(`- **${c.name}** (${cNodes.length} nodes): ${truncate(c.desc, SUMMARY.clusterDescChars)} [hub: #${c.hub_id}]`);
        }
        if (scored.length > SUMMARY.maxClusters) {
            lines.push(`…and ${scored.length - SUMMARY.maxClusters} more clusters — use format: 'clusters' or 'full' to list them.`);
        }
        lines.push('');
    }

    // Bridges — capped; recall is the paid path for detail. Same elision pattern
    // as The Between. Sorted by the endpoint nodes' score (bridges carry no weight).
    if (map.bridges?.length) {
        lines.push('## Cross-Cluster Bridges');
        const scoreOf = (id) => map.nodes?.find(n => n.id === id)?.score || 0;
        const scored = [...map.bridges]
            .map(b => ({ b, s: Math.max(scoreOf(b.from_id), scoreOf(b.to_id)) }))
            .sort((a, b) => b.s - a.s);
        for (const { b } of scored.slice(0, SUMMARY.maxBridges)) {
            lines.push(`- #${b.from_id} ↔ #${b.to_id}: ${b.reason}`);
        }
        if (scored.length > SUMMARY.maxBridges) {
            lines.push(`…and ${scored.length - SUMMARY.maxBridges} more — use memory_recall to explore specific topics.`);
        }
        lines.push('');
    }

    // Wildcards
    if (map.wildcards?.length) {
        lines.push('## Wildcards');
        for (const w of map.wildcards) {
            const n = map.nodes?.find(n => n.id === w.id);
            lines.push(`- #${w.id} [${n?.category || '?'}] ${w.summary || nodeLabel(n)} (${w.reason})`);
        }
        lines.push('');
    }

    // Nodes
    if (map.nodes?.length) {
        if (format === 'full') {
            lines.push('## All Nodes');
            const byCluster = {};
            const unclustered = [];
            for (const n of map.nodes) {
                if (n.cluster_id) (byCluster[n.cluster_id] ??= []).push(n);
                else unclustered.push(n);
            }
            for (const [cid, nodes] of Object.entries(byCluster)) {
                const cluster = map.clusters?.find(c => c.id === cid);
                lines.push(`[${cluster?.name || cid}]`);
                for (const n of nodes) {
                    const bridge = n.is_bridge ? ' ★bridge' : '';
                    const arrow = momentumArrow(n.momentum);
                    if (n.state === 'title') {
                        lines.push(`  #${n.id} [${n.category}] (title-only)${bridge}${arrow}`);
                    } else {
                        lines.push(`  #${n.id} [${n.category}] ${nodeLabel(n)} (score:${n.score?.toFixed(2)})${bridge}${arrow}`);
                    }
                }
            }
            if (unclustered.length) {
                lines.push('[unclustered]');
                for (const n of unclustered) {
                    lines.push(`  #${n.id} [${n.category}] ${nodeLabel(n)}`);
                }
            }
        } else {
            lines.push('## Top Nodes by Cluster');
            const byCluster = {};
            for (const n of map.nodes) {
                if (n.cluster_id) (byCluster[n.cluster_id] ??= []).push(n);
            }
            for (const [cid, nodes] of Object.entries(byCluster)) {
                if (cid === 'c_between') continue; // dedicated The-Between section above
                const cluster = map.clusters?.find(c => c.id === cid);
                const top = nodes.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
                lines.push(`[${cluster?.name || cid}]`);
                for (const n of top) {
                    const arrow = momentumArrow(n.momentum);
                    // Summary tier: truncate the node's prose — full text lives in
                    // the 'full' tier and memory_recall. Prevents the 5×N nodes
                    // section from re-bloating the summary past pagination.
                    lines.push(`  #${n.id} [${n.category}] ${truncate(nodeLabel(n), SUMMARY.clusterDescChars)} (score:${n.score?.toFixed(2)})${arrow}`);
                }
            }
            lines.push('');
            lines.push(`Use format: 'full' to see all ${nodeCount} nodes with details.`);
        }
    }

    // Recall directive
    if (map.meta?.coverage_cutoff) {
        lines.push(`\n[Memories after ${map.meta.coverage_cutoff} are not yet mapped — use memory_recall to find recent memories.]`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
}
