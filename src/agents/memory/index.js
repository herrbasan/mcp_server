import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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

function embedText(gateway, description, data, maxChars) {
    const parts = [description];
    if (data) parts.push(data);
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
        content: [{ type: 'text', text: `Remembered #${memory.id} [${category}]. Use memory_recall to find it later.` }]
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

export async function memory_get(args, context) {
    const { id } = args;
    const memory = memories.memories.find(m => m.id === id);

    if (!memory) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }

    const conf = memory.confidence ?? 0.5;
    let result = `[#${memory.id}] [${memory.category}] conf:${conf.toFixed(1)}\n`;
    result += `Description: ${memory.description}\n`;
    if (memory.data) result += `Data: ${memory.data}\n`;
    result += `Created: ${memory.timestamp}`;

    return { content: [{ type: 'text', text: result }] };
}

export async function memory_forget(args, context) {
    const { id } = args;
    const idx = memories.memories.findIndex(m => m.id === id);

    if (idx === -1) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
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
    const { id, description, category, confidence, data } = args;

    const memory = memories.memories.find(m => m.id === id);
    if (!memory) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
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
