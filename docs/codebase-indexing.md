# Codebase Indexing

> Semantic code search for pre-configured projects. LLM only searches - never manages indexing.

## Design Philosophy

**Simple:**
1. Admin configures projects in `data/codebases.json`
2. Server auto-indexes on startup
3. Maintenance keeps indexes fresh
4. LLM just searches by project name

**No complexity exposed to LLM:**
- ❌ No UNC paths
- ❌ No spaces
- ❌ No discovery
- ❌ No indexing calls
- ✅ Just search by name

## Configuration

Edit `data/codebases.json`:

```json
{
  "codebases": {
    "mcp_server": "d:\\DEV\\mcp_server",
    "SoundApp": "\\\\COOLKID\\Work\\Work\\SoundApp",
    "nDB": "\\\\BADKID\\Stuff\\DEV\\nDB"
  }
}
```

Or use the helper script:
```bash
# List configured
node scripts/manage-codebases.js list

# Add a project
node scripts/manage-codebases.js add SoundApp "\\\\COOLKID\\Work\\Work\\SoundApp"

# Remove a project
node scripts/manage-codebases.js remove SoundApp
```

## Auto-Indexing

On server startup:
1. Loads `data/codebases.json`
2. Indexes any new/unindexed codebases
3. Maintenance cycle keeps them updated

```
[Startup]
  ↓
[Load config] → data/codebases.json
  ↓
[Check each project]
  ├─ Already indexed? Skip
  ├─ New? Auto-index now
  └─ Changed? Refresh in maintenance
  ↓
[Ready for search]
```

## LLM Usage

The LLM only needs search tools:

```javascript
// 1. List what's available (optional)
mcp_orchestrator_list_codebases({})
// → [{ name: "mcp_server", files: 165, status: "current" }, ...]

// 2. Search
mcp_orchestrator_search_codebase({
  codebase: "mcp_server",
  query: "websocket connection handling",
  limit: 10
})
```

**That's it.** No paths, no indexing, no maintenance.

## MCP Tools (LLM-Exposed)

| Tool | Purpose |
|------|---------|
| `list_codebases` | See available indexed projects |
| `search_codebase` | Hybrid search (semantic + keyword) |
| `search_semantic` | Pure semantic search |
| `search_keyword` | Path/keyword search |
| `grep_codebase` | Exact text search |
| `get_file_info` | Get functions/classes for a file |
| `get_file` | Read file content |
| `get_file_tree` | Browse directory structure |
| `check_codebase_status` | Check if index is stale |

**Admin tools** (not exposed to LLM):
- `index_codebase` - Manually trigger indexing
- `remove_codebase` - Remove index
- `refresh_codebase` - Force refresh

## Maintenance

Automatic background maintenance:
- Detects changed files (mtime comparison)
- Incremental refresh (only changed files)
- Configurable interval (default: 1 hour)

```json
{
  "servers": {
    "codebase-indexing": {
      "maintenance": {
        "enabled": true,
        "intervalMs": 3600000
      }
    }
  }
}
```

## Architecture

```
data/codebases.json          # Admin configuration
       ↓
AutoIndexer                  # Startup indexing
       ↓
nDB (vector DB)              # Indexed projects
       ↓
CodebaseMaintenance          # Background refresh
       ↓
MCP Tools                    # LLM search interface
```

## Adding Projects

### Option 1: Add All from a Space (Recommended)
```bash
# Add all projects from COOLKID-Work (with prefix)
node scripts/add-all-projects.js COOLKID-Work work-

# Add all from BADKID-DEV
node scripts/add-all-projects.js BADKID-DEV dev-

# Check what was added
node scripts/manage-codebases.js list
```

### Option 2: Manual (one by one)
```bash
node scripts/manage-codebases.js add MyProject "\\\server\share\MyProject"
```

### Restart to Index
```bash
npm run start:http
```

Then search:
```javascript
mcp_orchestrator_search_codebase({
  codebase: "work-nui",
  query: "..."
})
```

## Same Project in Multiple Locations?

Use different names:
```json
{
  "codebases": {
    "SoundApp-Dev": "\\\\COOLKID\\Work\\Work\\SoundApp",
    "SoundApp-Prod": "\\\\SERVER\\Production\\SoundApp"
  }
}
```

LLM searches by name, doesn't care about paths.
