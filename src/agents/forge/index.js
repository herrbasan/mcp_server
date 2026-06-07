import { execFile } from 'child_process';
import { promises as fs, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = join(__dirname, '..', '..', '..', 'data', 'forge');
const TOOLS_DIR = join(FORGE_ROOT, 'tools');
const WORKSPACE_DIR = join(FORGE_ROOT, 'workspace');

function gitExec(args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd: opts.cwd || FORGE_ROOT, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                reject(err);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

async function ensureGitRepo() {
    mkdirSync(TOOLS_DIR, { recursive: true });
    mkdirSync(WORKSPACE_DIR, { recursive: true });
    const gitDir = join(FORGE_ROOT, '.git');
    if (!existsSync(gitDir)) {
        await gitExec(['init']);
        await gitExec(['config', 'user.email', 'forge@mcp.local']);
        await gitExec(['config', 'user.name', 'Forge Agent']);
    }
}

function toolPath(name) {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(TOOLS_DIR, `${safe}.js`);
}

async function resolvePayloadItem(item) {
    if (!item || typeof item !== 'string') return null;
    if (item.startsWith('http://') || item.startsWith('https://')) {
        const res = await fetch(item, { redirect: 'follow' });
        if (!res.ok) throw new Error(`Failed to fetch ${item}: ${res.status} ${res.statusText}`);
        return Buffer.from(await res.arrayBuffer());
    }
    return fs.readFile(item);
}

async function resolvePayload(items) {
    if (!items || !Array.isArray(items)) return [];
    return Promise.all(items.map(resolvePayloadItem));
}

export async function init(context) {
    await ensureGitRepo();
    return { forgeRoot: FORGE_ROOT };
}

export async function shutdown() {}

export async function forge_write(args, context) {
    const { name, code, description } = args;
    if (!name || !code) {
        return { content: [{ type: 'text', text: 'Error: name and code are required' }], isError: true };
    }
    const filePath = toolPath(name);
    if (existsSync(filePath)) {
        return { content: [{ type: 'text', text: `Error: tool "${name}" already exists. Use forge_update to modify it.` }], isError: true };
    }
    const header = description ? `// ${description}\n` : '';
    await fs.writeFile(filePath, header + code, 'utf8');
    await gitExec(['add', filePath]);
    await gitExec(['commit', '-m', `forge: create ${name}${description ? ' - ' + description : ''}`]);
    return { content: [{ type: 'text', text: `Tool "${name}" created and committed.` }] };
}

export async function forge_update(args, context) {
    const { name, code, message } = args;
    if (!name || !code) {
        return { content: [{ type: 'text', text: 'Error: name and code are required' }], isError: true };
    }
    const filePath = toolPath(name);
    if (!existsSync(filePath)) {
        return { content: [{ type: 'text', text: `Error: tool "${name}" does not exist. Use forge_write to create it.` }], isError: true };
    }
    await fs.writeFile(filePath, code, 'utf8');
    const commitMsg = message || `forge: update ${name}`;
    await gitExec(['add', filePath]);
    await gitExec(['commit', '-m', commitMsg]);
    return { content: [{ type: 'text', text: `Tool "${name}" updated.` }] };
}

export async function forge_read(args, context) {
    const { name, ref } = args;
    if (!name) {
        return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
    }
    const filePath = join('tools', `${name}.js`);
    let content;
    if (ref) {
        content = await gitExec(['show', `${ref}:${filePath}`]);
    } else {
        const fullPath = toolPath(name);
        if (!existsSync(fullPath)) {
            return { content: [{ type: 'text', text: `Error: tool "${name}" not found` }], isError: true };
        }
        content = await fs.readFile(fullPath, 'utf8');
    }
    return { content: [{ type: 'text', text: content }] };
}

export async function forge_list(args, context) {
    const entries = await fs.readdir(TOOLS_DIR).catch(() => []);
    const tools = [];
    for (const entry of entries) {
        if (!entry.endsWith('.js')) continue;
        const name = entry.slice(0, -3);
        const filePath = join(TOOLS_DIR, entry);
        const stat = await fs.stat(filePath);
        let lastCommit = '';
        try {
            lastCommit = await gitExec(['log', '-1', '--format=%h %s (%cr)', '--', filePath]);
        } catch {}
        tools.push({ name, modified: stat.mtime.toISOString(), lastCommit });
    }
    if (!tools.length) {
        return { content: [{ type: 'text', text: 'No tools in forge. Use forge_write to create one.' }] };
    }
    const lines = tools.map(t => `- ${t.name} | ${t.modified} | ${t.lastCommit}`);
    return { content: [{ type: 'text', text: `${tools.length} tool(s) in forge:\n\n${lines.join('\n')}` }] };
}

export async function forge_delete(args, context) {
    const { name } = args;
    const filePath = toolPath(name);
    if (!existsSync(filePath)) {
        return { content: [{ type: 'text', text: `Error: tool "${name}" not found` }], isError: true };
    }
    await fs.unlink(filePath);
    await gitExec(['add', filePath]);
    await gitExec(['commit', '-m', `forge: delete ${name}`]);
    return { content: [{ type: 'text', text: `Tool "${name}" deleted.` }] };
}

export async function forge_call(args, context) {
    const { name, options = {}, payload = [], timeout } = args;
    const { gateway, progress } = context;
    if (!name) {
        return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true };
    }
    const filePath = toolPath(name);
    if (!existsSync(filePath)) {
        return { content: [{ type: 'text', text: `Error: tool "${name}" not found` }], isError: true };
    }
    progress('Resolving payload...', 5, 100);
    let resolvedPayload;
    try {
        resolvedPayload = await resolvePayload(payload);
    } catch (err) {
        return { content: [{ type: 'text', text: `Payload resolution failed: ${err.message}` }], isError: true };
    }
    progress('Loading tool...', 10, 100);
    const mod = await import(`file://${filePath.replace(/\\/g, '/')}?t=${Date.now()}`);
    const toolFn = mod.default;
    if (typeof toolFn !== 'function') {
        return { content: [{ type: 'text', text: `Error: tool "${name}" does not export a default function` }], isError: true };
    }
    progress('Executing...', 15, 100);
    const effectiveTimeout = Math.min(timeout || 300000, 600000);
    const toolContext = {
        gateway,
        progress,
        payload: resolvedPayload,
        workspacePath: WORKSPACE_DIR
    };
    const timer = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${effectiveTimeout}ms`)), effectiveTimeout);
    });
    let result;
    try {
        result = await Promise.race([toolFn(options, toolContext), timer]);
    } catch (err) {
        return { content: [{ type: 'text', text: `Execution error: ${err.message}` }], isError: true };
    }
    return result || { content: [{ type: 'text', text: `Tool "${name}" completed with no output.` }] };
}

export async function forge_history(args, context) {
    const { name, limit = 20 } = args;
    const logArgs = ['log', `--max-count=${limit}`, '--format=%H|%s|%ci|%an'];
    if (name) {
        const filePath = join('tools', `${name}.js`);
        logArgs.push('--', filePath);
    }
    const stdout = await gitExec(logArgs);
    if (!stdout) {
        return { content: [{ type: 'text', text: name ? `No history for "${name}".` : 'No commits in forge.' }] };
    }
    const lines = stdout.split('\n').map(line => {
        const [hash, msg, date, author] = line.split('|');
        return `${hash.slice(0, 8)} | ${date} | ${author}\n  ${msg}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
}

export async function forge_rollback(args, context) {
    const { name, commit } = args;
    if (!name || !commit) {
        return { content: [{ type: 'text', text: 'Error: name and commit are required' }], isError: true };
    }
    const filePath = join('tools', `${name}.js`);
    const content = await gitExec(['show', `${commit}:${filePath}`]);
    const fullPath = toolPath(name);
    await fs.writeFile(fullPath, content, 'utf8');
    await gitExec(['add', fullPath]);
    await gitExec(['commit', '-m', `forge: rollback ${name} to ${commit.slice(0, 8)}`]);
    return { content: [{ type: 'text', text: `Tool "${name}" rolled back to ${commit.slice(0, 8)}.` }] };
}
