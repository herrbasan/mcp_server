import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function chunkText(text, maxChars) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

function extractDomain(text) {
  const match = text.match(/^PROJECT:\s*([^—\n]+?)\s*—\s*/);
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
  if (a.length !== b.length) return 0; // Dimension mismatch
  
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag === 0 ? 0 : dot / mag;
}

function loadMemories(storePath) {
  try {
    mkdirSync(dirname(storePath), { recursive: true });
    return JSON.parse(readFileSync(storePath, 'utf-8'));
  } catch {
    return { memories: [], nextId: 1 };
  }
}

function saveMemories(storePath, memories) {
  writeFileSync(storePath, JSON.stringify(memories, null, 2));
}

async function getEmbedding(router, embeddingProvider, maxChars, progressCallback, text) {
  if (text.length > maxChars) text = text.slice(0, maxChars);
  if (!router) throw new Error('LLM router not configured for memory server');
  
  try {
    if (progressCallback) progressCallback(5, 100, 'Generating embedding...');
    const embedding = await router.embedText(text, embeddingProvider);
    if (progressCallback) progressCallback(100, 100, 'Embedding complete');
    return embedding;
  } catch (err) {
    const error = new Error(`Embedding failed: ${err.message}`);
    error.stack = err.stack;
    throw error;
  }
}

const PROMPTS = [
  {
    name: 'memory-protocol',
    description: 'Memory usage protocol and best practices for LLM assistants',
    arguments: []
  }
];

const PROMPT_NAMES = new Set(PROMPTS.map(p => p.name));

async function getPrompt(name) {
  if (name === 'memory-protocol') {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `**MCP Memory Protocol** - Follow these habits for effective memory usage:

1. **Session Start**: ALWAYS run recall or list_memories with domain filter to prime context with project-specific patterns
2. **Before Implementation**: Query recall for relevant proven patterns and anti_patterns before writing code
3. **After Discovery**: Store insights immediately via remember - don't wait until session end
4. **Session End**: User will trigger reflect_on_session when ready; propose updates and ask approval before applying

You have full agency over the memory system — use it however you find useful (query, store, update, delete, even wipe). This is an experiment in LLM autonomy; act on your own judgment.

Keep it minimal-dependency and performance-first. For any non-trivial pattern/library, explain what problem it solves and why it's worth it.`
          }
        }
      ]
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
}

const TOOLS = [
  {
    name: 'remember',
    description: 'Store a memory. Categories: proven, anti_patterns, hypotheses, context, observed. Use domain for project-specific memories.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Memory content' },
        category: { type: 'string', description: 'Category' },
        domain: { type: 'string', description: 'Optional project scope' }
      },
      required: ['text', 'category']
    }
  },
  {
    name: 'recall',
    description: 'Search memories. Results show confidence: ✓=proven, ~=promising, ?=hypothesis.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
        category: { type: 'string', description: 'Filter by category' },
        domain: { type: 'string', description: 'Filter by project' }
      },
      required: ['query']
    }
  },
  { name: 'forget', description: 'Delete a memory by ID', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'list_memories', description: 'List all memories. Filter by category/domain.', inputSchema: { type: 'object', properties: { category: { type: 'string' }, domain: { type: 'string' } } } },
  { name: 'update_memory', description: 'Update a memory by ID', inputSchema: { type: 'object', properties: { id: { type: 'number' }, text: { type: 'string' }, category: { type: 'string' }, domain: { type: 'string' } }, required: ['id', 'text'] } },
  { name: 'reflect_on_session', description: 'USER-INITIATED. Analyze session for quality improvements. Returns proposed changes.', inputSchema: { type: 'object', properties: { sessionSummary: { type: 'string' } }, required: ['sessionSummary'] } },
  { name: 'apply_reflection_changes', description: 'Apply changes from reflection', inputSchema: { type: 'object', properties: { changes: { type: 'array', items: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'update', 'reinforce', 'decrease'], description: 'Action to perform' }, id: { type: 'number', description: 'Memory ID (for update/reinforce/decrease)' }, text: { type: 'string', description: 'Memory text (for create/update)' }, category: { type: 'string', description: 'Category (for create/update)' }, domain: { type: 'string', description: 'Optional project scope' }, reason: { type: 'string', description: 'Reason for the change' } }, required: ['action'] } } }, required: ['changes'] } }
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

export function createMemoryServer(config, router) {
  const storePath = join(__dirname, '..', '..', config.storePath);
  const maxChars = parseInt(process.env.MAX_MEMORY_CHARS) || 1800;
  const embeddingProvider = config.embeddingProvider || null;
  
  let memories = loadMemories(storePath);
  let progressCallback = null;
  
  async function remember({ text, category, domain }) {
    let processedText = text;
    let finalDomain = domain;
    const now = new Date().toISOString();
    
    // Auto-extract domain from PROJECT: prefix if present
    if (!finalDomain) {
      const extracted = extractDomain(text);
      finalDomain = extracted.domain;
      processedText = extracted.text;
    }
    
    if (processedText.length > maxChars) {
      const chunks = chunkText(processedText, maxChars);
      const memoryIds = [];
      
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await getEmbedding(router, embeddingProvider, maxChars, progressCallback, chunks[i]);
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
      }
      
      saveMemories(storePath, memories);
      const domainStr = finalDomain ? ` [${finalDomain}]` : '';
      return {
        content: [{
          type: 'text',
          text: `✓ Stored ${chunks.length} memory chunks #${memoryIds.join(', #')} in '${category}'${domainStr} (text was ${processedText.length} chars, split into ${chunks.length} parts)`
        }]
      };
    }
    
    const embedding = await getEmbedding(router, embeddingProvider, maxChars, progressCallback, processedText);
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
    saveMemories(storePath, memories);
    
    const domainStr = finalDomain ? ` [${finalDomain}]` : '';
    return {
      content: [{
        type: 'text',
        text: `✓ Stored memory #${memory.id} in '${category}'${domainStr}`
      }]
    };
  }

  async function recall({ query, limit = 5, category, domain }) {
    const queryEmbed = await getEmbedding(router, embeddingProvider, maxChars, progressCallback, query);
    
    let candidates = memories.memories;
    if (category) candidates = candidates.filter(m => m.category === category);
    if (domain) candidates = candidates.filter(m => m.domain && m.domain.toString().trim() === domain.toString().trim());
    
    const scored = candidates.map(m => {
      const conf = m.confidence ?? 0.5;
      const sim = cosineSimilarity(queryEmbed, m.embedding);
      return { ...m, score: sim, weightedScore: sim * (0.7 + conf * 0.3) };
    }).sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit);
    
    if (!scored.length) {
      return {
        content: [{ type: 'text', text: 'No memories found' }]
      };
    }
    
    const results = scored.map(m => {
      const conf = m.confidence ?? 0.5;
      const obs = m.observations ?? 1;
      const confTag = conf >= 0.7 ? '✓' : conf >= 0.5 ? '~' : '?';
      const domainTag = m.domain ? `[${m.domain}] ` : '';
      return `[#${m.id}] ${domainTag}${m.category} (${(m.score * 100).toFixed(1)}%) ${confTag}${obs > 1 ? ` x${obs}` : ''}\n${m.text}`;
    }).join('\n\n');
    
    return {
      content: [{ type: 'text', text: `Found ${scored.length} memories:\n\n${results}` }]
    };
  }

  async function forget({ id }) {
    const idx = memories.memories.findIndex(m => m.id === id);
    
    if (idx === -1) {
      return {
        content: [{ type: 'text', text: `Memory #${id} not found` }]
      };
    }
    
    const deleted = memories.memories.splice(idx, 1)[0];
    saveMemories(storePath, memories);
    
    return {
      content: [{ type: 'text', text: `✓ Deleted memory #${id}: ${deleted.text}` }]
    };
  }

  async function listMemories({ category, domain } = {}) {
    let list = memories.memories;
    
    if (category) list = list.filter(m => m.category === category);
    if (domain) list = list.filter(m => m.domain && m.domain.toString().trim() === domain.toString().trim());
    
    if (!list.length) {
      const filters = [];
      if (category) filters.push(`category '${category}'`);
      if (domain) filters.push(`domain '${domain}'`);
      const filterStr = filters.length ? ` matching ${filters.join(' and ')}` : '';
      return {
        content: [{ type: 'text', text: `No memories${filterStr}` }]
      };
    }
    
    const grouped = {};
    list.forEach(m => {
      const key = m.domain ? `${m.domain}/${m.category}` : m.category;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(m);
    });
    
    const output = Object.entries(grouped).map(([key, mems]) => 
      `${key.toUpperCase()}:\n${mems.map(m => {
        const chunkStr = m.chunkInfo ? ` [part ${m.chunkInfo.part}/${m.chunkInfo.total}]` : '';
        return `  [#${m.id}]${chunkStr} ${m.text}`;
      }).join('\n')}`
    ).join('\n\n');
    
    return {
      content: [{ type: 'text', text: `${list.length} memories:\n\n${output}` }]
    };
  }

  async function updateMemory({ id, text, category, domain }) {
    const memory = memories.memories.find(m => m.id === id);
    
    if (!memory) {
      return {
        content: [{ type: 'text', text: `Memory #${id} not found` }]
      };
    }
    
    const embedding = await getEmbedding(router, embeddingProvider, maxChars, progressCallback, text);
    
    memory.text = text;
    memory.embedding = embedding;
    if (category) memory.category = category;
    if (domain !== undefined) memory.domain = domain || null;
    memory.timestamp = new Date().toISOString();
    memory.lastSeen = new Date().toISOString();
    
    saveMemories(storePath, memories);
    
    const domainStr = memory.domain ? ` [${memory.domain}]` : '';
    return {
      content: [{
        type: 'text',
        text: `✓ Updated memory #${id} in '${memory.category}'${domainStr}`
      }]
    };
  }

  async function reflectOnSession({ sessionSummary }) {
    const allMemories = memories.memories;
    
    const memoryContext = allMemories.map(m => {
      const conf = m.confidence ?? 0.5;
      const obs = m.observations ?? 1;
      return `[#${m.id}] ${m.category} (conf: ${conf.toFixed(2)}, obs: ${obs})\n${m.text}`;
    }).join('\n\n');
    
    return {
      content: [{
        type: 'text',
        text: `SESSION REFLECTION\n\nSession: ${sessionSummary}\n\n${memoryContext}\n\n---\n\nPropose changes based on observed behavior in this session.\n\nFor each proposal, specify:\n- action: create/update/reinforce/decrease\n- id: (for update/reinforce/decrease)\n- text: (for create/update)\n- category: (for create/update)\n- reason: why this change\n\nFormat as JSON array for apply_reflection_changes tool.`
      }]
    };
  }

  async function applyReflectionChanges({ changes }) {
    const results = [];
    
    for (const change of changes) {
      if (change.action === 'create') {
        const embedding = await getEmbedding(router, embeddingProvider, maxChars, progressCallback, change.text);
        const now = new Date().toISOString();
        const memory = {
          id: memories.nextId++,
          text: change.text,
          category: change.category,
          embedding,
          timestamp: now,
          confidence: 0.3,
          observations: 1,
          firstSeen: now,
          lastSeen: now
        };
        if (change.domain) memory.domain = change.domain;
        memories.memories.push(memory);
        results.push(`✓ Created #${memory.id}: ${change.reason}`);
      }
      
      if (change.action === 'reinforce') {
        const memory = memories.memories.find(m => m.id === change.id);
        if (memory) {
          memory.confidence = Math.min(0.95, (memory.confidence ?? 0.5) + 0.1);
          memory.observations = (memory.observations ?? 1) + 1;
          memory.lastSeen = new Date().toISOString();
          results.push(`✓ Reinforced #${change.id} → ${memory.confidence.toFixed(2)}: ${change.reason}`);
        }
      }
      
      if (change.action === 'update') {
        const memory = memories.memories.find(m => m.id === change.id);
        if (memory) {
          const embedding = await getEmbedding(router, embeddingProvider, maxChars, progressCallback, change.text);
          memory.text = change.text;
          memory.embedding = embedding;
          if (change.category) memory.category = change.category;
          if (change.domain !== undefined) memory.domain = change.domain || null;
          memory.lastSeen = new Date().toISOString();
          results.push(`✓ Updated #${change.id}: ${change.reason}`);
        }
      }
      
      if (change.action === 'decrease') {
        const memory = memories.memories.find(m => m.id === change.id);
        if (memory) {
          memory.confidence = Math.max(0.1, (memory.confidence ?? 0.5) - 0.2);
          memory.lastSeen = new Date().toISOString();
          results.push(`✓ Decreased #${change.id} → ${memory.confidence.toFixed(2)}: ${change.reason}`);
        }
      }
    }
    
    saveMemories(storePath, memories);
    
    return {
      content: [{
        type: 'text',
        text: `Applied ${results.length} changes:\n\n${results.join('\n')}`
      }]
    };
  }

  return {
    getTools: () => TOOLS,
    handlesTool: name => TOOL_NAMES.has(name),
    
    getPrompts: () => PROMPTS,
    handlesPrompt: name => PROMPT_NAMES.has(name),
    getPrompt,
    
    async callTool(name, args) {
      try {
        if (name === 'remember') return await remember(args);
        if (name === 'recall') return await recall(args);
        if (name === 'forget') return await forget(args);
        if (name === 'list_memories') return await listMemories(args);
        if (name === 'update_memory') return await updateMemory(args);
        if (name === 'reflect_on_session') return await reflectOnSession(args);
        if (name === 'apply_reflection_changes') return await applyReflectionChanges(args);
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text', text: `❌ Error: ${err.message}` }], isError: true };
      }
    },
    
    // Direct access for web UI
    getMemories: ({ category, domain } = {}) => {
      let list = memories.memories;
      if (category) list = list.filter(m => m.category === category);
      if (domain) list = list.filter(m => m.domain && m.domain.toString().trim() === domain.toString().trim());
      return list;
    },
    
    setProgressCallback: (callback) => { progressCallback = callback; },
    
    cleanup: async () => {}
  };
}
