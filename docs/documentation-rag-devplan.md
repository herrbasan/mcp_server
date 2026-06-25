# Documentation Agent RAG Enhancement — Dev Plan

**Status:** Exploratory / design phase  
**Date:** 2026-06-25  
**Author:** GitHub Copilot (kimi-chat)  

---

## 1. Current State

The `documentation` agent (`src/agents/documentation/`) is a thin file-system wrapper around the `LLM_Docs` knowledge base plus the built-in `mcp_documentation/` (Workshop) domain.

**Tools today:**
- `documentation_domains` — lightweight domain list
- `documentation_list` — list domains and files with frontmatter metadata
- `documentation_get` — fetch one doc by `DomainName/filename.md`
- `documentation_query` — load docs into LLM context and ask a question

**Data model today:**
- Files are Markdown with simple YAML frontmatter (`title`, `scope`, `tags`, `category`, `source`, `date`).
- Domains are directories.
- The agent has no persistence of its own; it reads from disk every call.
- `documentation_query` loads **entire domains** into the prompt context. It has no token budget, no chunking, and no relevance filtering beyond the domain selector.

**Embedding infrastructure available:**
- `gateway.embed(text)` / `gateway.embedBatch(texts)` via `src/gateway-client.js`.
- The `memory` agent already stores embeddings in `data/memories.json` and does brute-force cosine similarity in JS.
- **nVDB is available** as a separate project (`https://github.com/herrbasan/nVDB`, npm package `nvdb`). It is an embedded vector database with a Node.js N-API binding, HNSW approximate search, and metadata filtering. It is **not currently used in this repo**.

---

## 2. The Idea

Turn the documentation agent into a **RAG-backed knowledge base** that supports semantic search, but keep the external interface conceptually simple: models still call a `query`-like tool, and internally the agent picks relevant documents, loads as much as fits into context, and answers.

Additionally, expose **write/update capabilities** so LLMs can maintain the knowledge base:
- Create/edit documents
- Create/edit domains
- Move documents between domains
- Maintain a category/tag system

### 2.1 Why This Might Be Valuable

- Today, models using the tool mostly `list` and `get` documents. That workflow works but is manual.
- The missing capability is **mutability**: letting an LLM append a lesson learned, add a new provider spec, or reorganize domains after a refactor.
- RAG would help `documentation_query` scale beyond small domains by retrieving only relevant chunks instead of dumping whole directories into context.

### 2.2 Why It Might Be Overengineered

- The current corpus is small. Loading whole domains into context is wasteful but probably works fine for now.
- Adding RAG + CRUD turns a simple file reader into a small CMS. That brings versioning, conflicts, schema migration, and backup concerns.
- The `memory` agent already stores unstructured lessons. The `storage` agent provides a generic file API. A documentation CMS may overlap with both.
- nVDB is available but adding it means taking a native dependency. For small corpora the brute-force cosine search the `memory` agent already uses is good enough.

---

## 3. Two Possible Scopes

### 3A. Minimal Enhancement (recommended first step)

Keep files as the source of truth. Add:

1. **Chunking + local embedding index for documentation**
   - On startup (or on first `query`), scan docs, split into chunks, embed, store in `data/documentation_index.json`.
   - Use the same brute-force cosine similarity as `memory` to start, or optionally use nVDB for larger corpora.
   - `documentation_query` retrieves top-K chunks, then loads as many full relevant documents as fit in a configurable token budget.

2. **Write tools**
   - `documentation_create` — create a new doc in a domain
   - `documentation_update` — edit an existing doc
   - `documentation_delete` — remove a doc
   - `documentation_move` — move a doc between domains
   - `documentation_create_domain` / `documentation_delete_domain`

3. **Metadata improvements**
   - Formalize tags/categories in frontmatter.
   - Add validation: required `title`, recommended `tags`.

**Pros:** Still simple, files remain human-readable, no external DB dependency.  
**Cons:** Large corpora will make brute-force search slow; embedding index can get stale.

### 3B. Full RAG Database

Introduce a real vector database (nVDB or equivalent) as the primary store:

- Documents are chunked; each chunk is a row/record with vector, metadata, and content.
- File export is a secondary "snapshot" feature, not the source of truth.
- Domains, categories, and tags become first-class queryable fields.
- Full CRUD API exposed through MCP tools.

**Pros:** Scales to large corpora; fast semantic search; rich metadata queries; nVDB is a known, maintained project.  
**Cons:** Adds a native dependency (`nvdb` npm package); backup/recovery more complex; diverges from the current file-first model; per the prime directive, dependencies should be justified.

---

## 4. Key Design Questions

### 4.1 What is nVDB?

nVDB is a real project: `https://github.com/herrbasan/nVDB`, published as npm package `nvdb`. It provides an embedded vector database with a Node.js native binding.

Key facts from its documentation:

```js
const { Database, FilterBuilder } = require('nvdb');
const db = new Database('./data');
const coll = db.createCollection('documents', 1536, { durability: 'sync' });

// Insert with JSON payload
const vector = await gateway.embedText('some text');
coll.insert('doc-id', vector, JSON.stringify({ domain: 'LLM APIs', tags: ['openai'] }));

// Search with optional metadata filter
const results = coll.search({
  vector: queryVector,
  topK: 10,
  distance: 'cosine',
  approximate: true,
  ef: 64,
  filter: FilterBuilder.eq('domain', 'LLM APIs')
});
```

- It is an **embedded library**, not a service.
- It supports **exact and HNSW approximate search** with cosine/dot/euclidean distance.
- It supports **metadata filtering** via `FilterBuilder`.
- It persists to a local folder (`Database-as-a-Folder` architecture).

Open questions before using it here:

- What is the exact npm install / build story on Windows? Are prebuilt binaries available for the current Node version?
- How does it handle collection dimension changes (e.g., if we switch embedding models)?
- What are the backup/export semantics?
- Is the native addon loadable in this project's Node runtime without extra toolchain setup?

If nVDB proves difficult to integrate, the first milestone should use the existing gateway embeddings + local JSON index (same pattern as `memory`).

### 4.2 Source of Truth

Two options:

| Approach | Reads | Writes | Indexing |
|----------|-------|--------|----------|
| **Files first** | Read Markdown files directly | Write Markdown files | Build/rebuild index from files |
| **Database first** | Query vector DB | Insert/update/delete records | Export to files optionally |

Recommendation for first step: **files first**. It preserves the existing `documentation_get` behavior and keeps the corpus editable outside the agent.

### 4.3 Chunking Strategy

- Per-heading splits are usually best for Markdown docs.
- Each chunk should carry metadata: `file`, `domain`, `title`, `heading`, `startLine`, `tags`, `category`.
- Retrieval returns chunks; the LLM context builder can then decide whether to load the whole doc or just the chunk neighborhood.

### 4.4 Token Budgeting

`documentation_query` currently has no context limit. A RAG version should:

1. Embed the question.
2. Retrieve top-N chunks by similarity.
3. Greedily add full documents (or expanded chunks) until a `maxContextChars` / `maxContextTokens` budget is reached.
4. Send the assembled context to the LLM.

The budget should be configurable in `config.json`.

### 4.5 Write API Shape

The simplest usable interface:

```json
{
  "tool": "documentation_create",
  "args": {
    "file": "LLM APIs/provider_xai.md",
    "content": "# xAI Grok\n...",
    "tags": ["api", "xai"],
    "category": "provider"
  }
}
```

For updates, prefer whole-document replacement over patch/diff unless we want to support concurrent edits. Whole-doc replacement is simpler and matches how LLMs naturally reason about documents.

### 4.6 Overlap with Memory / Storage

- `memory` stores unstructured observations with embeddings.
- `storage` is a generic file API.
- A mutable documentation agent sits between them: structured, domain-organized, semantically searchable knowledge.

To avoid confusion, document the boundaries clearly:
- **Memory:** transient, personal, high-volume observations; dreaming consolidates them.
- **Documentation:** curated, structured, long-lived reference material.
- **Storage:** arbitrary files; no semantic features.

---

## 5. Proposed Milestones

### Milestone 0: Spike nVDB Integration

- `npm install nvdb` in a test branch.
- Verify the native addon loads on the target Windows/Node environment.
- Create a small test collection, insert vectors, run a search.
- If it works, keep nVDB as an optional backend; if not, commit to a local JSON index using gateway embeddings.

### Milestone 1: RAG Query (read-only)

- Add chunking and local embedding index for documentation.
- Add `maxContextChars` config.
- Rewrite `documentation_query` to retrieve relevant chunks and load docs within budget.
- Keep existing `documentation_get`, `documentation_list`, `documentation_domains` unchanged.

### Milestone 2: Write Tools

- `documentation_create`
- `documentation_update`
- `documentation_delete`
- `documentation_create_domain`
- `documentation_delete_domain`
- `documentation_move`
- Add frontmatter validation and normalization.

### Milestone 3: Add nVDB Backend (optional)

- Add an abstraction layer so the documentation agent can use either the local JSON index or nVDB.
- Keep the tool interface and file-first semantics stable.
- Default to local index; enable nVDB via config for larger corpora.

---

## 6. Risks

1. **nVDB dependency** — native addon may have build/load issues on the target Node version; adds a dependency the prime directive would prefer to avoid.
2. **Scope creep** — write tools + categories + tags + domains can turn into a full CMS.
3. **Index staleness** — files can be edited on disk outside the agent; need a re-index trigger or watcher.
4. **Context budget tuning** — too small and answers miss detail; too large and context window overflows.
5. **Overlap with memory** — users may not know whether to store something as a memory or as documentation.

---

## 7. Recommendation

Start with **Milestone 1 only**: add RAG-style retrieval and token budgeting to `documentation_query`, using the existing gateway embeddings and a local JSON index. Do not expose write tools yet.

This gives the most immediate benefit (better query answers for large domains) with the least architectural risk. nVDB is real and available, but it should be treated as an optional optimization later, not a prerequisite.

---

## 8. Next Decision

Please choose one of:

1. **Proceed with Milestone 1** — implement RAG query using local embeddings and chunking.
2. **Spike nVDB integration** — install `nvdb` and verify the native addon loads before committing to it.
3. **Expand plan** — design the full write API and metadata schema now.
4. **Park the idea** — current docs tooling is good enough; no code changes.
