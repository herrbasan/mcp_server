import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let storePath;
let memories;

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
}

function loadMemories(path) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        return { memories: [], nextId: 1 };
    }
}

function saveMemories() {
    writeFileSync(storePath, JSON.stringify(memories, null, 2));
}

// Serialize a data payload for display/embedding. Objects must be
// JSON.stringify'd — template interpolation yields '[object Object]'.
function serializeData(data) {
    if (data == null) return '';
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

function embedText(gateway, description, data, maxChars) {
    const parts = [description];
    if (data) parts.push(serializeData(data));
    const combined = parts.join(' ');
    const safe = combined.length > maxChars ? combined.slice(0, maxChars) : combined;
    return gateway.embed(safe);
}

export async function init(context) {
    storePath = join(__dirname, '..', '..', '..', 'data', 'memories.json');
    memories = loadMemories(storePath);
    return { memories };
}

export async function shutdown() {
    if (memories) saveMemories();
}

export async function memory_store(args, context) {
    const { gateway, progress } = context;
    const description = args.description || args.text;
    const category = args.category || 'notes';
    const confidence = args.confidence ?? 0.5;
    const { data } = args;
    const now = new Date().toISOString();
    const maxChars = context.config.maxMemoryChars || 6000;

    if (!description) {
        return { content: [{ type: 'text', text: 'Error: description is required' }], isError: true };
    }

    progress('Generating embedding...', 50);
    const embedding = await embedText(gateway, description, data, maxChars);

    const memory = {
        id: memories.nextId++,
        description,
        category,
        confidence: Math.max(0, Math.min(1, confidence)),
        embedding,
        timestamp: now
    };
    if (data) memory.data = data;

    memories.memories.push(memory);
    saveMemories();

    progress('Embedding complete', 100);
    return {
        content: [{ type: 'text', text: `✓ #${memory.id} [${category}] stored. ${memories.memories.length} memories total — keep storing freely, dreaming organizes them.` }]
    };
}

export { memory_store as memory_remember };

export async function memory_recall(args, context) {
    const { gateway, progress } = context;
    const { query, limit = 5, category } = args;

    progress('Embedding query...', 50);
    const maxChars = context.config.maxMemoryChars || 6000;
    const safeQuery = query.length > maxChars ? query.slice(0, maxChars) : query;
    const queryEmbed = await gateway.embed(safeQuery);

    let candidates = memories.memories;
    if (category) candidates = candidates.filter(m => m.category === category);

    const scored = candidates.map(m => {
        const conf = m.confidence ?? 0.5;
        const sim = cosineSimilarity(queryEmbed, m.embedding);
        return { ...m, score: sim, weightedScore: sim * (0.7 + conf * 0.3) };
    }).sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit);

    if (!scored.length) {
        return { content: [{ type: 'text', text: 'No memories found. This topic is new — consider storing insights with memory_store as you learn.' }] };
    }

    const results = scored.map(m => {
        const conf = m.confidence ?? 0.5;
        const hasData = m.data ? ' [has data]' : '';
        return `[#${m.id}] [${m.category}] ${(m.score * 100).toFixed(1)}% conf:${conf.toFixed(1)}${hasData}\n${m.description}`;
    }).join('\n\n');

    progress('Search complete', 100);
    return {
        content: [{ type: 'text', text: `Found ${scored.length} memories:\n\n${results}` }]
    };
}

function normId(id) { return typeof id === 'number' ? id : parseInt(String(id || '').replace(/^#/, ''), 10); }

export async function memory_get(args, context) {
    const id = normId(args.id);
    const memory = memories.memories.find(m => m.id === id);

    if (!memory) {
        return { content: [{ type: 'text', text: `Memory #${args.id} not found` }], isError: true };
    }

    const conf = memory.confidence ?? 0.5;
    let result = `[#${memory.id}] [${memory.category}] conf:${conf.toFixed(1)}\n`;
    result += `Description: ${memory.description}\n`;
    if (memory.data) result += `Data: ${serializeData(memory.data)}\n`;
    result += `Created: ${memory.timestamp}`;

    return { content: [{ type: 'text', text: result }] };
}

export async function memory_forget(args, context) {
    const id = normId(args.id);
    const idx = memories.memories.findIndex(m => m.id === id);

    if (idx === -1) {
        return { content: [{ type: 'text', text: `Memory #${args.id} not found` }], isError: true };
    }

    const deleted = memories.memories.splice(idx, 1)[0];
    saveMemories();

    return {
        content: [{ type: 'text', text: `Forgot #${id}: ${(deleted.description || '').substring(0, 80)}` }]
    };
}

export async function memory_list(args, context) {
    const { category } = args;
    let list = memories.memories;
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

export async function memory_update(args, context) {
    const { gateway } = context;
    const id = normId(args.id);
    const { description, category, confidence, data } = args;

    const memory = memories.memories.find(m => m.id === id);
    if (!memory) {
        return { content: [{ type: 'text', text: `Memory #${args.id} not found` }], isError: true };
    }

    const textChanged = (description && description !== memory.description) || (data !== undefined && data !== memory.data);
    if (textChanged) {
        const newDesc = description || memory.description;
        const newData = data !== undefined ? data : memory.data;
        const maxChars = context.config.maxMemoryChars || 6000;
        memory.embedding = await embedText(gateway, newDesc, newData, maxChars);
    }

    if (description) memory.description = description;
    if (category) memory.category = category;
    if (confidence !== undefined) memory.confidence = Math.max(0, Math.min(1, confidence));
    if (data !== undefined) {
        if (data === null) {
            delete memory.data;
        } else {
            memory.data = data;
        }
    }

    memory.timestamp = new Date().toISOString();
    saveMemories();

    return {
        content: [{ type: 'text', text: `Updated #${id}. Use memory_recall to verify.` }]
    };
}

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

export async function memory_overview(args, context) {
    const { format = 'summary' } = args;
    const mapPath = join(__dirname, '..', '..', '..', 'data', 'dream_map.json');

    if (!existsSync(mapPath)) {
        return { content: [{ type: 'text', text: 'No knowledge map available yet. It is generated automatically every 15 minutes, or run dream_generate to create one now.' }] };
    }

    const map = JSON.parse(readFileSync(mapPath, 'utf-8'));
    const lines = [`[Your Knowledge — generated ${map.meta?.generated_at || 'unknown'}]`];
    const memCount = memories.memories.length;
    const nodeCount = map.nodes?.length || 0;

    // TL;DR — one-line narrative synthesized from top clusters and bridges
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

    // Delta — what changed since last dream
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

    // Clusters
    if (map.clusters?.length) {
        lines.push('## Clusters');
        for (const c of map.clusters) {
            const cNodes = map.nodes?.filter(n => n.cluster_id === c.id) || [];
            lines.push(`- **${c.name}** (${cNodes.length} nodes): ${c.desc} [hub: #${c.hub_id}]`);
        }
        lines.push('');
    }

    // Bridges
    if (map.bridges?.length) {
        lines.push('## Cross-Cluster Bridges');
        for (const b of map.bridges) {
            lines.push(`- #${b.from_id} ↔ #${b.to_id}: ${b.reason}`);
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

    // Nodes — summary vs full
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
            // Summary: top nodes by cluster
            lines.push('## Top Nodes by Cluster');
            const byCluster = {};
            for (const n of map.nodes) {
                if (n.cluster_id) (byCluster[n.cluster_id] ??= []).push(n);
            }
            for (const [cid, nodes] of Object.entries(byCluster)) {
                const cluster = map.clusters?.find(c => c.id === cid);
                const top = nodes.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
                lines.push(`[${cluster?.name || cid}]`);
                for (const n of top) {
                    const arrow = momentumArrow(n.momentum);
                    lines.push(`  #${n.id} [${n.category}] ${nodeLabel(n)} (score:${n.score?.toFixed(2)})${arrow}`);
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
