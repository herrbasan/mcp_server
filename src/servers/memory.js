import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class MemoryServer {
  constructor(config, lmStudioServer = null) {
    this.lmStudioServer = lmStudioServer;
    this.endpoint = config.embeddingEndpoint;
    this.model = config.embeddingModel;
    this.storePath = join(__dirname, '..', '..', config.storePath);
    this.maxChars = parseInt(process.env.MAX_MEMORY_CHARS) || 1800; // ~450 tokens safe for 512 limit
    this.memories = this.loadMemories();
    this.progressCallback = null;
  }

  setProgressCallback(callback) {
    this.progressCallback = callback;
  }

  sendProgress(progress, total, message) {
    if (this.progressCallback) {
      this.progressCallback(progress, total, message);
    }
  }

  chunkText(text) {
    const chunks = [];
    for (let i = 0; i < text.length; i += this.maxChars) {
      chunks.push(text.slice(i, i + this.maxChars));
    }
    return chunks;
  }

  loadMemories() {
    try {
      mkdirSync(dirname(this.storePath), { recursive: true });
      return JSON.parse(readFileSync(this.storePath, 'utf-8'));
    } catch {
      return { memories: [], nextId: 1 };
    }
  }

  saveMemories() {
    writeFileSync(this.storePath, JSON.stringify(this.memories, null, 2));
  }

  async getEmbedding(text) {
    // Chunk large text to avoid embedding model token limits
    if (text.length > this.maxChars) {
      text = text.slice(0, this.maxChars);
    }
    
    // Use LMStudioSession if available (with model loading pipeline)
    if (this.lmStudioServer) {
      try {
        this.sendProgress(5, 100, 'Connecting to LM Studio...');
        
        // Ensure WebSocket connection is established
        await this.lmStudioServer.ensureConnected();
        
        this.sendProgress(10, 100, 'Preparing embedding...');
        
        // createEmbedding handles model loading with progress
        const embedding = await this.lmStudioServer.session.createEmbedding(
          text,
          this.model,
          {
            autoUnload: true,
            onProgress: (progress, message) => {
              // Map SDK progress (0-1) to MCP progress (10-95)
              const pct = 10 + Math.round(progress * 85);
              this.sendProgress(pct, 100, message);
            }
          }
        );
        
        this.sendProgress(100, 100, 'Embedding complete');
        return embedding;
      } catch (err) {
        // Preserve stack trace
        const error = new Error(`Embedding via LM Studio failed: ${err.message}`);
        error.stack = err.stack;
        throw error;
      }
    }
    
    // Fallback to HTTP endpoint (legacy, no model loading pipeline)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: controller.signal
      });
      
      if (!res.ok) {
        const error = await res.text();
        throw new Error(`Embedding failed (${res.status}): ${error}`);
      }
      
      const data = await res.json();
      return data.data[0].embedding;
    } finally {
      clearTimeout(timeout);
    }
  }

  cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  getTools() {
    return [
      {
        name: 'remember',
        description: 'LLM-managed memory for improving OUTPUT QUALITY. Store evidence-based rules, not user preferences. Categories: proven (demonstrated good outcomes), anti_patterns (caused problems), hypotheses (untested ideas), context (project facts), observed (behavioral patterns). New memories start confidence 0.3.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The memory to store - should be actionable for quality improvement' },
            category: { type: 'string', description: 'Category: proven, anti_patterns, hypotheses, context, or observed' }
          },
          required: ['text', 'category']
        }
      },
      {
        name: 'recall',
        description: 'Search quality rules and evidence. Results: [#id] category (similarity%) confidence-indicator. ✓=proven(0.7+), ~=promising(0.5-0.7), ?=hypothesis(<0.5). Use before generating code to check what approaches have worked or failed.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' },
            limit: { type: 'number', description: 'Max results (default: 5)' },
            category: { type: 'string', description: 'Filter by category (optional)' }
          },
          required: ['query']
        }
      },
      {
        name: 'forget',
        description: 'Delete a memory by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Memory ID to delete' }
          },
          required: ['id']
        }
      },
      {
        name: 'list_memories',
        description: 'List all memories or filter by category',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category (optional)' }
          }
        }
      },
      {
        name: 'update_memory',
        description: 'Update an existing memory by ID',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Memory ID to update' },
            text: { type: 'string', description: 'New text' },
            category: { type: 'string', description: 'New category (optional)' }
          },
          required: ['id', 'text']
        }
      },
      {
        name: 'reflect_on_session',
        description: 'USER triggers at session end. Analyze: What approaches worked? What failed? What should be promoted from hypothesis to proven, or flagged as anti_pattern? Focus on OUTPUT QUALITY - did the code we produced meet performance/simplicity standards? Propose evidence-based updates.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionSummary: { type: 'string', description: 'Summary of what was built, what worked, what did not' }
          },
          required: ['sessionSummary']
        }
      },
      {
        name: 'apply_reflection_changes',
        description: 'Apply quality-focused updates. Promote hypotheses to proven when validated. Create anti_patterns when approaches caused problems. Goal: accumulate evidence for what produces good outcomes, not what user prefers.',
        inputSchema: {
          type: 'object',
          properties: {
            changes: {
              type: 'array',
              description: 'Array of approved changes from reflection',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['create', 'update', 'reinforce', 'decrease'] },
                  id: { type: 'number', description: 'Memory ID for update/reinforce/decrease' },
                  text: { type: 'string', description: 'Memory text for create/update' },
                  category: { type: 'string', description: 'Category for create/update' },
                  reason: { type: 'string', description: 'Reasoning for this change' }
                }
              }
            }
          },
          required: ['changes']
        }
      }
    ];
  }

  handlesTool(name) {
    return ['remember', 'recall', 'forget', 'list_memories', 'update_memory', 'reflect_on_session', 'apply_reflection_changes'].includes(name);
  }

  async callTool(name, args) {
    if (name === 'remember') {
      const { text, category } = args;
      const now = new Date().toISOString();
      
      // Check if chunking is needed
      if (text.length > this.maxChars) {
        const chunks = this.chunkText(text);
        const memoryIds = [];
        
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await this.getEmbedding(chunks[i]);
          const memory = {
            id: this.memories.nextId++,
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
          this.memories.memories.push(memory);
          memoryIds.push(memory.id);
        }
        
        this.saveMemories();
        return {
          content: [{
            type: 'text',
            text: `✓ Stored ${chunks.length} memory chunks #${memoryIds.join(', #')} in '${category}' (text was ${text.length} chars, split into ${chunks.length} parts)`
          }]
        };
      }
      
      // Single memory for small text
      const embedding = await this.getEmbedding(text);
      const memory = {
        id: this.memories.nextId++,
        text,
        category,
        embedding,
        timestamp: now,
        confidence: 0.3,
        observations: 1,
        firstSeen: now,
        lastSeen: now
      };
      
      this.memories.memories.push(memory);
      this.saveMemories();
      
      return {
        content: [{
          type: 'text',
          text: `✓ Stored memory #${memory.id} in '${category}'`
        }]
      };
    }

    if (name === 'recall') {
      const { query, limit = 5, category } = args;
      const queryEmbed = await this.getEmbedding(query);
      
      let candidates = this.memories.memories;
      if (category) candidates = candidates.filter(m => m.category === category);
      
      const scored = candidates.map(m => {
        const conf = m.confidence ?? 0.5;
        const sim = this.cosineSimilarity(queryEmbed, m.embedding);
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
        return `[#${m.id}] ${m.category} (${(m.score * 100).toFixed(1)}%) ${confTag}${obs > 1 ? ` x${obs}` : ''}\n${m.text}`;
      }).join('\n\n');
      
      return {
        content: [{ type: 'text', text: `Found ${scored.length} memories:\n\n${results}` }]
      };
    }

    if (name === 'forget') {
      const { id } = args;
      const idx = this.memories.memories.findIndex(m => m.id === id);
      
      if (idx === -1) {
        return {
          content: [{ type: 'text', text: `Memory #${id} not found` }]
        };
      }
      
      const deleted = this.memories.memories.splice(idx, 1)[0];
      this.saveMemories();
      
      return {
        content: [{ type: 'text', text: `✓ Deleted memory #${id}: ${deleted.text}` }]
      };
    }

    if (name === 'list_memories') {
      const { category } = args;
      let list = this.memories.memories;
      
      if (category) list = list.filter(m => m.category === category);
      
      if (!list.length) {
        return {
          content: [{ type: 'text', text: category ? `No memories in '${category}'` : 'No memories stored' }]
        };
      }
      
      const grouped = {};
      list.forEach(m => {
        if (!grouped[m.category]) grouped[m.category] = [];
        grouped[m.category].push(m);
      });
      
      const output = Object.entries(grouped).map(([cat, mems]) => 
        `${cat.toUpperCase()}:\n${mems.map(m => {
          const chunkStr = m.chunkInfo ? ` [part ${m.chunkInfo.part}/${m.chunkInfo.total}]` : '';
          return `  [#${m.id}]${chunkStr} ${m.text}`;
        }).join('\n')}`
      ).join('\n\n');
      
      return {
        content: [{ type: 'text', text: `${list.length} memories:\n\n${output}` }]
      };
    }

    if (name === 'update_memory') {
      const { id, text, category } = args;
      const memory = this.memories.memories.find(m => m.id === id);
      
      if (!memory) {
        return {
          content: [{ type: 'text', text: `Memory #${id} not found` }]
        };
      }
      
      const embedding = await this.getEmbedding(text);
      
      memory.text = text;
      memory.embedding = embedding;
      if (category) memory.category = category;
      memory.timestamp = new Date().toISOString();
      memory.lastSeen = new Date().toISOString();
      
      this.saveMemories();
      
      return {
        content: [{
          type: 'text',
          text: `✓ Updated memory #${id} in '${memory.category}'`
        }]
      };
    }

    if (name === 'reflect_on_session') {
      const { sessionSummary } = args;
      const allMemories = this.memories.memories;
      
      const memoryContext = allMemories.map(m => {
        const conf = m.confidence ?? 0.5;
        const obs = m.observations ?? 1;
        return `[#${m.id}] ${m.category} (conf: ${conf.toFixed(2)}, obs: ${obs})\n${m.text}`;
      }).join('\n\n');
      
      const analysis = {
        sessionSummary,
        currentMemories: memoryContext,
        instructions: `Analyze this session against current memories. Propose changes:

1. CREATE: New observations not captured (start confidence: 0.3)
2. REINFORCE: Observed behavior matching existing memory (increase confidence by 0.1, max 0.95)
3. UPDATE: Nuance/correction needed in existing memory
4. DECREASE: Observed contradiction to existing memory (decrease confidence by 0.2)

Focus on:
- Stated preferences vs actual behavior
- Decision patterns under pressure
- Contradictions or nuances
- Repeated behaviors

Return JSON array of proposed changes with reasoning.`
      };
      
      return {
        content: [{
          type: 'text',
          text: `SESSION REFLECTION\n\nSession: ${sessionSummary}\n\n${memoryContext}\n\n---\n\nPropose changes based on observed behavior in this session.\n\nFor each proposal, specify:\n- action: create/update/reinforce/decrease\n- id: (for update/reinforce/decrease)\n- text: (for create/update)\n- category: (for create/update)\n- reason: why this change\n\nFormat as JSON array for apply_reflection_changes tool.`
        }]
      };
    }

    if (name === 'apply_reflection_changes') {
      const { changes } = args;
      const results = [];
      
      for (const change of changes) {
        if (change.action === 'create') {
          const embedding = await this.getEmbedding(change.text);
          const now = new Date().toISOString();
          const memory = {
            id: this.memories.nextId++,
            text: change.text,
            category: change.category,
            embedding,
            timestamp: now,
            confidence: 0.3,
            observations: 1,
            firstSeen: now,
            lastSeen: now
          };
          this.memories.memories.push(memory);
          results.push(`✓ Created #${memory.id}: ${change.reason}`);
        }
        
        if (change.action === 'reinforce') {
          const memory = this.memories.memories.find(m => m.id === change.id);
          if (memory) {
            memory.confidence = Math.min(0.95, (memory.confidence ?? 0.5) + 0.1);
            memory.observations = (memory.observations ?? 1) + 1;
            memory.lastSeen = new Date().toISOString();
            results.push(`✓ Reinforced #${change.id} → ${memory.confidence.toFixed(2)}: ${change.reason}`);
          }
        }
        
        if (change.action === 'update') {
          const memory = this.memories.memories.find(m => m.id === change.id);
          if (memory) {
            const embedding = await this.getEmbedding(change.text);
            memory.text = change.text;
            memory.embedding = embedding;
            if (change.category) memory.category = change.category;
            memory.lastSeen = new Date().toISOString();
            results.push(`✓ Updated #${change.id}: ${change.reason}`);
          }
        }
        
        if (change.action === 'decrease') {
          const memory = this.memories.memories.find(m => m.id === change.id);
          if (memory) {
            memory.confidence = Math.max(0.1, (memory.confidence ?? 0.5) - 0.2);
            memory.lastSeen = new Date().toISOString();
            results.push(`✓ Decreased #${change.id} → ${memory.confidence.toFixed(2)}: ${change.reason}`);
          }
        }
      }
      
      this.saveMemories();
      
      return {
        content: [{
          type: 'text',
          text: `Applied ${results.length} changes:\n\n${results.join('\n')}`
        }]
      };
    }
  }
}
