# Codebase Management Scripts

> Simple scripts to manage the projects list.

## Two Scripts

### 1. `add-all-projects.js` - Add All Projects from a Space

Scans a space for code folders and adds them all at once.

```bash
# Usage
node add-all-projects.js <space-name> [prefix]

# Examples
node add-all-projects.js COOLKID-Work
node add-all-projects.js COOLKID-Work work-
node add-all-projects.js BADKID-DEV dev-
```

**What it does:**
1. Scans the space for folders containing code files
2. Adds them to `data/codebases.json`
3. Skips duplicates (won't add same name twice)

**Prefix is useful when you have same-named projects in different spaces:**
```bash
node add-all-projects.js COOLKID-Work work-
node add-all-projects.js BADKID-DEV dev-
# Results: work-nui, dev-nui (different prefixes avoid collision)
```

### 2. `manage-codebases.js` - Manual Management

Add, remove, or list projects one at a time.

```bash
# List all configured projects
node manage-codebases.js list

# Add a single project
node manage-codebases.js add MyProject "\\\server\share\MyProject"

# Remove a project
node manage-codebases.js remove MyProject
```

## Typical Workflow

**Setting up a new space:**
```bash
# Add all projects from COOLKID with prefix
node scripts/add-all-projects.js COOLKID-Work work-

# Add all projects from BADKID with prefix
node scripts/add-all-projects.js BADKID-DEV dev-

# Check what we have
node scripts/manage-codebases.js list

# Restart server to index everything
npm run start:http
```

**Adding just one project:**
```bash
node scripts/manage-codebases.js add SoundApp "\\\\COOLKID\\Work\\Work\\SoundApp"
npm run start:http
```

## What Gets Detected as a Project?

A folder is considered a project if it contains code files:
- `.js`, `.ts` (JavaScript/TypeScript)
- `.py` (Python)
- `.rs` (Rust)
- `.java`, `.go`, `.c`, `.cpp`
- `package.json`, `Cargo.toml`

**Skipped:**
- Hidden folders (starting with `.`)
- Folders starting with `_` (like `_trash`, `_gsdata_`)
- `node_modules/`, `dist/`, `build/`, `target/`

## The data/codebases.json File

This is just a JSON file mapping names to paths:

```json
{
  "codebases": {
    "work-electron": "\\\\COOLKID\\Work\\Work\\_DEV\\electron",
    "work-nui": "\\\\COOLKID\\Work\\Work\\_DEV\\nui",
    "dev-LibreHardwareMonitor": "\\\\BADKID\\Stuff\\DEV\\LibreHardwareMonitor"
  }
}
```

You can edit this file directly if you prefer. The server reads it on startup.
