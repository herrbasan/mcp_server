# nDB

A high-performance, embedded, in-memory vector database designed for LLM workflows.

## Overview

nDB provides fast vector storage and similarity search with a minimal but complete API. It's designed for applications requiring low-latency vector operations without the overhead of a distributed database.

```rust
use ndb::{Database, CollectionConfig, Document, Search};

let db = Database::open("./data")?;
let coll = db.create_collection("embeddings", CollectionConfig::new(768))?;

coll.insert(Document {
    id: "doc1".to_string(),
    vector: vec![0.1; 768],
    payload: Some(serde_json::json!({"text": "Hello world"})),
})?;

let results = coll.search(Search::new(&query).top_k(10))?;
```

## Key Features

| Feature | Description |
|---------|-------------|
| **Zero-copy reads** | Memory-mapped persistence for instant recovery |
| **SIMD-accelerated search** | AVX2/AVX-512/NEON via the `wide` crate |
| **HNSW approximate search** | Configurable recall vs latency tradeoffs |
| **MongoDB-like filters** | Query by metadata with a familiar DSL |
| **LSM-Lite storage** | Memtable + mmap segments + WAL |
| **Embedded library** | Integrated directly into your application |
| **Single writer** | Natural for embedded use - your app is the only writer |

## When to Use nDB

- Storing embeddings from LLMs (768-1536 dimensions)
- Similarity search with optional metadata filtering
- Read-heavy workloads with occasional bulk writes
- Single-node deployments where embedded databases are appropriate

## When NOT to Use nDB

- Client-server architecture (use Qdrant, Milvus, etc.)
- Distributed/multi-node requirements
- Multiple independent applications writing to the same data
- Complex multi-document transactions
- SQL-style queries with joins

## Installation

```toml
# Cargo.toml
[dependencies]
ndb = "0.1"
serde_json = "1.0"
```

## Quick Start

```rust
use ndb::{Database, CollectionConfig, Document, Distance, Search};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db = Database::open("./data")?;

    let collection = db.create_collection(
        "embeddings",
        CollectionConfig::new(768)
    )?;

    // Insert documents
    collection.insert(Document {
        id: "doc1".to_string(),
        vector: vec![0.1; 768],
        payload: Some(serde_json::json!({
            "title": "Example",
            "category": "tutorial"
        })),
    })?;

    // Search with HNSW approximation
    let query = vec![0.1; 768];
    let results = collection.search(
        Search::new(&query)
            .top_k(10)
            .distance(Distance::Cosine)
            .approximate(true)
            .ef(64)
    )?;

    for m in results {
        println!("{}: score={:.3}", m.id, m.score);
    }

    Ok(())
}
```

## Documentation

| Document | Description |
|----------|-------------|
| [User Guide](docs/user-guide.md) | Complete API reference, configuration, best practices |
| [Integration Guide](docs/integration-guide.md) | Integration patterns, platform setup, deployment |
| [Scope & Boundaries](docs/scope-and-boundaries.md) | What nDB is and isn't |
| [Test Documentation](docs/test-documentation.md) | Test suite details |

## API Overview

### Database Operations

```rust
let db = Database::open(path)?;
let coll = db.create_collection(name, config)?;
let names = db.collection_names()?;
```

### Document Operations

```rust
coll.insert(doc)?;
coll.insert_batch(docs)?;
coll.get(id)?;
coll.delete(id)?;
coll.flush()?;
```

### Search

```rust
// Exact search (100% recall)
let results = coll.search(Search::new(&query).top_k(10))?;

// Approximate search with HNSW
let results = coll.search(
    Search::new(&query)
        .top_k(10)
        .approximate(true)
        .ef(128)
)?;

// With filter
let results = coll.search(
    Search::new(&query)
        .top_k(10)
        .filter(Filter::eq("category", "tutorial"))
)?;
```

### Index Management

```rust
coll.rebuild_index()?;    // Build HNSW index
coll.delete_index()?;     // Remove index
coll.compact()?;          // Remove deleted docs, rebuild index
```

## Build & Test

```bash
# Build
cargo build --release

# Run tests
cargo test

# Run benchmarks
cargo bench

# Generate documentation
cargo doc --open
```

## Examples

```bash
cargo run --example basic_usage
cargo run --example rag_system
cargo run --example web_service
```

## Architecture

nDB is an **embedded library** - it runs in-process with your application, not as a separate server. Think of it like SQLite for vectors.

```
Your Code → nDB (embedded) → WAL, Segments, Index (Filesystem)
```

This design means:
- No network overhead - direct function calls
- No separate database server to run
- Single writer (your application)

## Performance

| Dataset Size | Exact Search | Approximate (HNSW) |
|--------------|--------------|-------------------|
| 10K docs | <1ms | <1ms |
| 100K docs | 5-10ms | 1-2ms |
| 1M docs | 50-100ms | 2-5ms |
| 10M docs | 500ms-1s | 5-10ms |

## License

MIT OR Apache-2.0
