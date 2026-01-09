import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class MemoryServer {
  constructor(config) {
    this.endpoint = config.embeddingEndpoint;
    this.model = config.embeddingModel;
    this.storePath = join(__dirname, '..', '..', config.storePath);
    this.memories = this.loadMemories();
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: controller.signal
      });
      
      if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
      
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
        description: 'Store a memory (preference, project detail, weakness, pattern) for future recall',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The memory to store' },
            category: { type: 'string', description: 'Category: preferences, projects, weaknesses, patterns, or general' }
          },
          required: ['text', 'category']
        }
      },
      {
        name: 'recall',
        description: 'Semantic search for relevant memories based on query',
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
      }
    ];
  }

  handlesTool(name) {
    return ['remember', 'recall', 'forget', 'list_memories', 'update_memory'].includes(name);
  }

  async callTool(name, args) {
    if (name === 'remember') {
      const { text, category } = args;
      const embedding = await this.getEmbedding(text);
      
      const memory = {
        id: this.memories.nextId++,
        text,
        category,
        embedding,
        timestamp: new Date().toISOString()
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
      
      const scored = candidates.map(m => ({
        ...m,
        score: this.cosineSimilarity(queryEmbed, m.embedding)
      })).sort((a, b) => b.score - a.score).slice(0, limit);
      
      if (!scored.length) {
        return {
          content: [{ type: 'text', text: 'No memories found' }]
        };
      }
      
      const results = scored.map(m => 
        `[#${m.id}] ${m.category} (${(m.score * 100).toFixed(1)}%)\n${m.text}`
      ).join('\n\n');
      
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
        `${cat.toUpperCase()}:\n${mems.map(m => `  [#${m.id}] ${m.text}`).join('\n')}`
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
      
      this.saveMemories();
      
      return {
        content: [{
          type: 'text',
          text: `✓ Updated memory #${id} in '${memory.category}'`
        }]
      };
    }
  }
}
