import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let storePath;
let memories;

function chunkText(text, maxChars) {
    const chunks = [];
    for (let i = 0; i < text.length; i += maxChars) {
        chunks.push(text.slice(i, i + maxChars));
    }
    return chunks;
}

function extractDomain(text) {
    const match = text.match(/^PROJECT:\s*([^\-\n]+?)\s*\-\s*/);
    if (match) {
        return {
            domain: match[1].trim(),
            text: text.substring(match[0].length).trim()
        };
    }
    return { domain: null, text };
}

function cosineSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a.length !== b.length) return 0;
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

export async function init(context) {
    storePath = join(__dirname, '..', '..', '..', 'data', 'memories.json');
    memories = loadMemories(storePath);
    return { memories };
}

export async function shutdown() {
    if (memories) {
        saveMemories();
    }
}

export async function memory_remember(args, context) {
    const { gateway, progress } = context;
    const { text, category, domain } = args;
    
    let processedText = text;
    let finalDomain = domain;
    const now = new Date().toISOString();
    const maxChars = context.config.maxMemoryChars || 6000;

    if (!finalDomain) {
        const extracted = extractDomain(text);
        finalDomain = extracted.domain;
        processedText = extracted.text;
    }

    if (processedText.length > maxChars) {
        const chunks = chunkText(processedText, maxChars);
        const memoryIds = [];
        progress(`Embedding ${chunks.length} memory chunks...`, 10);
        
        for (let i = 0; i < chunks.length; i++) {
            const embedding = await gateway.embed(chunks[i]);
            const memory = {
                id: memories.nextId++,
                text: chunks[i],
                category,
                embedding,
                timestamp: now,
                confidence: 0.3,
                observations: 1,
                firstSeen: now,
                lastSeen: now,
                chunkInfo: { part: i + 1, total: chunks.length }
            };
            if (finalDomain) memory.domain = finalDomain;
            memories.memories.push(memory);
            memoryIds.push(memory.id);
            progress(`Embedded chunk ${i + 1}/${chunks.length}`, 10 + (90 * (i + 1) / chunks.length));
        }

        saveMemories();
        const domainStr = finalDomain ? ` [${finalDomain}]` : '';
        return {
            content: [{ type: 'text', text: `Stored ${chunks.length} memory chunks #${memoryIds.join(', #')} in '${category}'${domainStr}` }]
        };
    }

    progress(`Generating embedding...`, 50);
    const embedding = await gateway.embed(processedText);
    const memory = {
        id: memories.nextId++,
        text: processedText,
        category,
        embedding,
        timestamp: now,
        confidence: 0.3,
        observations: 1,
        firstSeen: now,
        lastSeen: now
    };
    if (finalDomain) memory.domain = finalDomain;

    memories.memories.push(memory);
    saveMemories();

    const domainStr = finalDomain ? ` [${finalDomain}]` : '';
    progress(`Embedding complete`, 100);
    return {
        content: [{ type: 'text', text: `Stored memory #${memory.id} in '${category}'${domainStr}` }]
    };
}

export async function memory_recall(args, context) {
    const { gateway, progress } = context;
    const { query, limit = 5, category, domain } = args;

    progress('Embedding query...', 50);
    const maxChars = context.config.maxMemoryChars || 6000;
    const safeQuery = query.length > maxChars ? query.slice(0, maxChars) : query;
    const queryEmbed = await gateway.embed(safeQuery);

    let candidates = memories.memories;
    if (category) candidates = candidates.filter(m => m.category === category);
    if (domain) candidates = candidates.filter(m => m.domain && m.domain.toString().trim() === domain.toString().trim());

    const scored = candidates.map(m => {
        const conf = m.confidence ?? 0.5;
        const sim = cosineSimilarity(queryEmbed, m.embedding);
        return { ...m, score: sim, weightedScore: sim * (0.7 + conf * 0.3) };
    }).sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit);

    if (!scored.length) {
        return { content: [{ type: 'text', text: 'No memories found' }] };
    }

    const results = scored.map(m => {
        const conf = m.confidence ?? 0.5;
        const obs = m.observations ?? 1;
        const confTag = conf >= 0.7 ? '[proven]' : conf >= 0.5 ? '[likely]' : '[uncertain]';
        const domainTag = m.domain ? `[${m.domain}] ` : '';
        return `[#${m.id}] ${domainTag}${m.category} (${(m.score * 100).toFixed(1)}%) ${confTag}${obs > 1 ? ` x${obs}` : ''}\n${m.text}`;
    }).join('\n\n');

    progress('Search complete', 100);
    return {
        content: [{ type: 'text', text: `Found ${scored.length} memories:\n\n${results}` }]
    };
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
        content: [{ type: 'text', text: `Deleted memory #${id}: ${deleted.text.substring(0, 50)}...` }]
    };
}

export async function memory_list(args, context) {
    const { category, domain } = args;
    let list = memories.memories;
    if (category) list = list.filter(m => m.category === category);
    if (domain) list = list.filter(m => m.domain && m.domain.toString().trim() === domain.toString().trim());

    if (!list.length) {
        return { content: [{ type: 'text', text: 'No memories found matching criteria' }] };
    }

    const formatted = list.map(m => {
        const conf = m.confidence ?? 0.5;
        const confTag = conf >= 0.7 ? '[proven]' : conf >= 0.5 ? '[likely]' : '[uncertain]';
        const domainTag = m.domain ? `[${m.domain}] ` : '';
        const preview = m.text.length > 100 ? m.text.substring(0, 100) + '...' : m.text;
        return `[#${m.id}] ${domainTag}${m.category} ${confTag} - ${preview}`;
    }).join('\n');

    return {
        content: [{ type: 'text', text: `Total matching memories: ${list.length}\n\n${formatted}` }]
    };
}

export async function memory_update(args, context) {
    const { gateway } = context;
    const { id, text, category, domain } = args;
    
    const memory = memories.memories.find(m => m.id === id);
    if (!memory) {
        return { content: [{ type: 'text', text: `Memory #${id} not found` }], isError: true };
    }

    if (text && text !== memory.text) {
        memory.text = text;
        const maxChars = context.config.maxMemoryChars || 6000;
        const safeText = text.length > maxChars ? text.slice(0, maxChars) : text;
        memory.embedding = await gateway.embed(safeText);
    }
    
    if (category) memory.category = category;
    if (domain !== undefined) memory.domain = domain;
    
    memory.lastSeen = new Date().toISOString();
    saveMemories();

    return {
        content: [{ type: 'text', text: `Updated memory #${id}` }]
    };
}

