# Codebase Indexing - Maintenance System

> Automatic index refresh and staleness detection for indexed codebases.

## Overview

The maintenance system keeps indexed codebases up-to-date by:
- Periodically checking for changed files
- Auto-refreshing stale indexes
- Tracking maintenance statistics
- Providing staleness reports

## Configuration

```json
{
  "servers": {
    "codebase-indexing": {
      "enabled": true,
      "dataDir": "data/codebases",
      "maintenance": {
        "enabled": true,
        "intervalMs": 3600000,
        "autoRefresh": true,
        "staleThresholdMs": 300000
      }
    }
  }
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable maintenance cycle |
| `intervalMs` | `3600000` (1 hour) | How often to check for changes |
| `autoRefresh` | `true` | Automatically refresh stale indexes |
| `staleThresholdMs` | `300000` (5 min) | Time before considering a file stale |

## MCP Tools

### Check Codebase Status
```javascript
mcp_orchestrator_check_codebase_status({
  codebase: "mcp_server"
})
// Returns:
// {
//   codebase: "mcp_server",
//   totalFiles: 165,
//   staleFiles: 3,
//   missingFiles: 0,
//   status: "stale",
//   lastIndexed: "2026-02-15T20:49:49.267Z"
// }
```

### Check File Stale
```javascript
mcp_orchestrator_check_file_stale({
  codebase: "mcp_server",
  path: "src/http-server.js"
})
// Returns:
// {
//   stale: true,
//   lastIndexed: "2026-02-15T20:49:49.188Z",
//   fileMtime: "2026-02-15T20:57:07.971Z",
//   indexMtime: "2026-02-15T14:43:20.693Z"
// }
```

### Run Maintenance
```javascript
// Refresh all codebases
mcp_orchestrator_run_maintenance({})

// Refresh specific codebase
mcp_orchestrator_run_maintenance({
  codebase: "mcp_server"
})
// Returns:
// {
//   codebase: "mcp_server",
//   refreshed: true,
//   filesUpdated: 4,
//   added: 3,
//   updated: 1,
//   deleted: 0
// }
```

### Get Maintenance Stats
```javascript
mcp_orchestrator_get_maintenance_stats({})
// Returns:
// {
//   totalRefreshes: 10,
//   filesUpdated: 47,
//   errors: 0,
//   lastRun: "2026-02-15T21:30:00.000Z",
//   isRunning: false,
//   enabled: true,
//   intervalMinutes: 60
// }
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Maintenance Cycle                         │
│                   (every 60 minutes)                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Scan codebase files → Build current file list           │
│  2. Compare with indexed files                              │
│     - New files: Added to index                             │
│     - Modified files (mtime): Re-indexed                    │
│     - Deleted files: Removed from index                     │
│  3. Run incremental refresh (only changed files)            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Detection Logic

### Staleness Check
- Compares file `mtime` (modification time) from filesystem vs index
- Files are stale if `fs.mtime > indexed.mtime`
- Missing files are always considered stale

### What Gets Scanned
Only code files matching these extensions:
- `.js`, `.ts`, `.jsx`, `.tsx`
- `.py`, `.rs`
- `.java`, `.go`, `.c`, `.cpp`, `.h`
- `.cs`, `.rb`, `.php`

Ignored directories (same as indexer):
- `node_modules/**`, `.git/**`, `.vscode/**`
- `dist/**`, `build/**`, `.next/**`
- `*.log`, `*.lock`, `*.map`, `**/*.min.js`, `**/*.d.ts`

## Startup Behavior

When the server starts:
1. Codebase indexing service initializes
2. Maintenance cycle starts automatically (if enabled)
3. First maintenance run happens after `intervalMs` (not immediately)
4. Shutdown gracefully stops maintenance before exiting

## Manual vs Automatic

| Mode | Behavior |
|------|----------|
| **Automatic** | Maintenance cycle runs periodically, auto-refreshes stale codebases |
| **Manual** | Use `run_maintenance` tool to trigger refresh on-demand |
| **Disabled** | No automatic checks; staleness detection still works via tools |

To disable auto-refresh but keep periodic checks:
```json
{
  "maintenance": {
    "enabled": true,
    "autoRefresh": false
  }
}
```
