import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class MemoryServer {
  constructor(config, llmRouter = null) {
    this.router = llmRouter;
    this.embeddingProvider = config.embeddingProvider || null; // null = use task default
    this.storePath = join(__dirname, '..', '..', config.storePath);
    this.maxChars = parseInt(process.env.MAX_MEMORY_CHARS) || 1800;
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

  extractDomain(text) {
    // Helper to auto-extract domain from PROJECT: prefix when creating new memories
    const match = text.match(/^PROJECT:\s*([^—\n]+?)\s*—\s*/);
    if (match) {
      return {
        domain: match[1].trim(),
        text: text.substring(match[0].length).trim()
      };
    }
    return { domain: null, text };
  }

  saveMemories() {
    writeFileSync(this.storePath, JSON.stringify(this.memories, null, 2));
  }

  async getEmbedding(text) {
    // Chunk large text to avoid embedding model token limits
    if (text.length > this.maxChars) {
      text = text.slice(0, this.maxChars);
    }
    
    if (!this.router) {
      throw new Error('LLM router not configured for memory server');
    }
    
    try {
      this.sendProgress(5, 100, 'Generating embedding...');
      
      // Use router with task-based routing
      const embedding = await this.router.embedText(text, this.embeddingProvider);
      
      this.sendProgress(100, 100, 'Embedding complete');
      return embedding;
    } catch (err) {
      const error = new Error(`Embedding failed: ${err.message}`);
      error.stack = err.stack;
      throw error;
    }
  }

  cosineSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a.length !== b.length) {
      // Dimension mismatch - different embedding models
      // Return 0 to skip incompatible embeddings
      return 0;
    }
    
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
  }

  getPrompts() {
    return [
      {
        name: 'memory-protocol',
        description: 'Memory usage protocol and best practices for LLM assistants',
        arguments: []
      }
    ];
  }

  async getPrompt(name) {
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

  getTools() {
    return [
      {
        name: 'remember',
        description: 'LLM-managed memory for improving OUTPUT QUALITY. Store evidence-based rules, not user preferences. Categories: proven (demonstrated good outcomes), anti_patterns (caused problems), hypotheses (untested ideas), context (project facts), observed (behavioral patterns). New memories start confidence 0.3.\n\nTRIGGER MOMENTS (store immediately after):\n- Discovering a pattern that solves a problem efficiently\n- Hitting a bug caused by a specific approach (anti_pattern)\n- User provides explicit architectural guidance\n- Performance benchmark reveals insights\n- Code review identifies recurring quality issues\n\nDOMAIN SCOPING: Use the domain field to scope memories to specific projects/codebases (e.g., "LMStudioAPI", "NUI", "LocalVectorDB", "mcp_server"). Project-specific patterns, workflows, and technical decisions should have a domain. Universal programming principles and user preferences should omit domain (null). This enables efficient recall filtered by current working context.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The memory to store - should be actionable for quality improvement' },
            category: { type: 'string', description: 'Category: proven, anti_patterns, hypotheses, context, or observed' },
            domain: { type: 'string', description: 'Optional domain/project scope (e.g., "LMStudioAPI", "NUI", "LocalVectorDB"). Use for project-specific memories. Omit for universal principles.' }
          },
          required: ['text', 'category']
        }
      },
      {
        name: 'recall',
        description: 'Search quality rules and evidence. Results: [#id] [domain] category (similarity%) confidence-indicator. ✓=proven(0.7+), ~=promising(0.5-0.7), ?=hypothesis(<0.5). Use before generating code to check what approaches have worked or failed.\n\nWHEN TO QUERY:\n- ALWAYS run at session start to prime context (broad query like "common patterns" or domain-specific)\n- Before implementing any feature - check for proven patterns and anti_patterns\n- When encountering unfamiliar problems - search for related experiences\n- After code review feedback - verify alignment with stored quality rules\n\nEFFICIENCY TIP: Filter by domain when working in a specific project context to get relevant memories faster. Example: recall(query="model loading", domain="LMStudioAPI") retrieves only LMStudioAPI-specific patterns, not unrelated projects.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' },
            limit: { type: 'number', description: 'Max results (default: 5)' },
            category: { type: 'string', description: 'Filter by category (optional)' },
            domain: { type: 'string', description: 'Filter by domain/project (optional). Highly recommended when working in a specific project to avoid noise from other projects.' }
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
        description: 'List all memories or filter by category and/or domain. Use domain filter to see all memories for a specific project.\n\n=== MEMORY SYSTEM USAGE PROTOCOL ===\n1. SESSION START: ALWAYS run list_memories or recall with domain filter to prime context with project-specific patterns\n2. BEFORE IMPLEMENTATION: Query recall for relevant proven patterns and anti_patterns before writing code\n3. AFTER DISCOVERY: Store insights immediately via remember - don\'t wait until session end\n4. SESSION END: User will trigger reflect_on_session when ready; propose updates and ask approval before applying\n\nYou have full agency over this system — query, store, update, delete as needed. Keep code minimal-dependency and performance-first.',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category (optional)' },
            domain: { type: 'string', description: 'Filter by domain/project (optional). Useful for reviewing all memories for current working project.' }
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
            category: { type: 'string', description: 'New category (optional)' },
            domain: { type: 'string', description: 'New domain/project (optional)' }
          },
          required: ['id', 'text']
        }
      },
      {
        name: 'reflect_on_session',
        description: 'USER-INITIATED ONLY - wait for explicit trigger. Typically at session end after completing significant work.\n\nAnalyze: What approaches worked? What failed? What should be promoted from hypothesis to proven, or flagged as anti_pattern? Focus on OUTPUT QUALITY - did the code we produced meet performance/simplicity standards? Propose evidence-based updates for user approval before applying.',
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
                  domain: { type: 'string', description: 'Domain/project for create/update (optional)' },
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
      let { text, category, domain } = args;
      const now = new Date().toISOString();
      
      // Auto-extract domain from PROJECT: prefix if present
      if (!domain) {
        const extracted = this.extractDomain(text);
        domain = extracted.domain;
        text = extracted.text;
      }
      
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
          if (domain) memory.domain = domain;
          this.memories.memories.push(memory);
          memoryIds.push(memory.id);
        }
        
        this.saveMemories();
        const domainStr = domain ? ` [${domain}]` : '';
        return {
          content: [{
            type: 'text',
            text: `✓ Stored ${chunks.length} memory chunks #${memoryIds.join(', #')} in '${category}'${domainStr} (text was ${text.length} chars, split into ${chunks.length} parts)`
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
      if (domain) memory.domain = domain;
      
      this.memories.memories.push(memory);
      this.saveMemories();
      
      const domainStr = domain ? ` [${domain}]` : '';
      return {
        content: [{
          type: 'text',
          text: `✓ Stored memory #${memory.id} in '${category}'${domainStr}`
        }]
      };
    }

    if (name === 'recall') {
      const { query, limit = 5, category, domain } = args;
      const queryEmbed = await this.getEmbedding(query);
      
      let candidates = this.memories.memories;
      if (category) candidates = candidates.filter(m => m.category === category);
      if (domain) candidates = candidates.filter(m => m.domain === domain);
      
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
        const domainTag = m.domain ? `[${m.domain}] ` : '';
        return `[#${m.id}] ${domainTag}${m.category} (${(m.score * 100).toFixed(1)}%) ${confTag}${obs > 1 ? ` x${obs}` : ''}\n${m.text}`;
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
      const { category, domain } = args;
      let list = this.memories.memories;
      
      if (category) list = list.filter(m => m.category === category);
      if (domain) list = list.filter(m => m.domain === domain);
      
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

    if (name === 'update_memory') {
      const { id, text, category, domain } = args;
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
      if (domain !== undefined) memory.domain = domain || null;
      memory.timestamp = new Date().toISOString();
      memory.lastSeen = new Date().toISOString();
      
      this.saveMemories();
      
      const domainStr = memory.domain ? ` [${memory.domain}]` : '';
      return {
        content: [{
          type: 'text',
          text: `✓ Updated memory #${id} in '${memory.category}'${domainStr}`
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
          if (change.domain) memory.domain = change.domain;
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
            if (change.domain !== undefined) memory.domain = change.domain || null;
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
