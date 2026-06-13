import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_DOCS_DIR = join(__dirname, '..', '..', '..', 'mcp_documentation');

let llmDocsPath;

// ── YAML frontmatter parser ──────────────────────────────────────────
function parseFrontmatter(content) {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!match) return { data: {}, body: content };
    const raw = match[1];
    const data = {};
    let currentKey = null;
    for (const line of raw.split('\n')) {
        const kv = line.match(/^(\w[\w_-]*):\s*(.*)/);
        if (kv) {
            currentKey = kv[1];
            const val = kv[2].trim();
            if (val.startsWith('[') && val.endsWith(']')) {
                data[currentKey] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            } else if (val.startsWith('"') || val.startsWith("'")) {
                data[currentKey] = val.slice(1, -1);
            } else {
                data[currentKey] = val;
            }
        } else if (currentKey && line.startsWith('  - ')) {
            if (!Array.isArray(data[currentKey])) data[currentKey] = [];
            data[currentKey].push(line.slice(4).trim().replace(/^['"]|['"]$/g, ''));
        }
    }
    return { data, body: content.slice(match[0].length) };
}

// ── Path resolution ──────────────────────────────────────────────────

function getDocsBase(context) {
    if (llmDocsPath) return llmDocsPath;
    const cfg = context?.config?.agents?.docs?.llmDocsPath;
    llmDocsPath = cfg || 'D:\\DEV\\LLM_Docs';
    return llmDocsPath;
}

function resolveDocPath(context, file) {
    const base = getDocsBase(context);
    return join(base, 'Documentation', file);
}

function getDomainDir(context, domain) {
    const base = getDocsBase(context);
    return join(base, 'Documentation', domain);
}

// ── File scanning ────────────────────────────────────────────────────

function scanDomain(domainPath, domainName) {
    if (!existsSync(domainPath)) return null;
    const entries = readdirSync(domainPath).filter(f => {
        const full = join(domainPath, f);
        return statSync(full).isFile() && f.endsWith('.md') && f !== 'README.md' && f !== 'Agents.md';
    });

    const docs = [];
    for (const file of entries) {
        const content = readFileSync(join(domainPath, file), 'utf-8');
        const { data: fm } = parseFrontmatter(content);
        docs.push({
            file,
            title: fm.title || file.replace(/\.md$/, ''),
            scope: fm.scope || '',
            tags: fm.tags || [],
            category: fm.category || '',
            source: fm.source || '',
            date: fm.date || ''
        });
    }

    // Read README for domain description
    let description = '';
    const readmePath = join(domainPath, 'README.md');
    if (existsSync(readmePath)) {
        const readmeContent = readFileSync(readmePath, 'utf-8');
        const { data: rmFm } = parseFrontmatter(readmeContent);
        description = rmFm.scope || rmFm.title || '';
    }

    return { domain: domainName, description, count: docs.length, docs };
}

function listAllDomains(context) {
    const base = getDocsBase(context);
    const docDir = join(base, 'Documentation');
    if (!existsSync(docDir)) return [];

    const entries = readdirSync(docDir, { withFileTypes: true });
    const domains = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const result = scanDomain(join(docDir, entry.name), entry.name);
        if (result) domains.push(result);
    }
    return domains;
}

// ── MCP tool handlers ────────────────────────────────────────────────

export async function docs_list(args, context) {
    const { domain } = args || {};

    if (domain) {
        const dir = getDomainDir(context, domain);
        const result = scanDomain(dir, domain);
        if (!result) return { content: [{ type: 'text', text: `Domain not found: "${domain}". Available domains: ${listAllDomains(context).map(d => d.domain).join(', ')}` }], isError: true };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    const domains = listAllDomains(context);
    const summary = {
        basePath: getDocsBase(context),
        totalDocs: domains.reduce((s, d) => s + d.count, 0),
        domains: domains.map(d => ({ domain: d.domain, description: d.description, count: d.count, docs: d.docs }))
    };
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
}

export async function docs_get(args, context) {
    const { file, lines } = args || {};
    if (!file) return { content: [{ type: 'text', text: 'Error: "file" parameter is required.' }], isError: true };

    const fullPath = resolveDocPath(context, file);
    if (!existsSync(fullPath)) {
        return { content: [{ type: 'text', text: `Document not found: "${file}". Use docs_list() to see available documents.` }], isError: true };
    }

    const content = readFileSync(fullPath, 'utf-8');
    const { data: fm, body } = parseFrontmatter(content);

    if (lines && Array.isArray(lines) && lines.length === 2) {
        const bodyLines = body.split('\n');
        const start = Math.max(0, lines[0] - 1);
        const end = Math.min(bodyLines.length, lines[1]);
        const partial = bodyLines.slice(start, end).join('\n');
        return {
            content: [{ type: 'text', text: `--- File: ${file} (lines ${lines[0]}-${lines[1]}) ---\nFrontmatter: ${JSON.stringify(fm)}\n\n${partial}` }]
        };
    }

    return { content: [{ type: 'text', text: `--- File: ${file} ---\nFrontmatter: ${JSON.stringify(fm)}\n\n${body}` }] };
}

export async function docs_query(args, context) {
    const { question, domain, files } = args || {};
    if (!question) return { content: [{ type: 'text', text: 'Error: "question" parameter is required.' }], isError: true };

    const { gateway, progress } = context;

    let docsToLoad = [];

    if (files && Array.isArray(files) && files.length > 0) {
        // Load specific files
        for (const file of files) {
            const fullPath = resolveDocPath(context, file);
            if (!existsSync(fullPath)) {
                return { content: [{ type: 'text', text: `Document not found: "${file}"` }], isError: true };
            }
            const content = readFileSync(fullPath, 'utf-8');
            docsToLoad.push({ file, content });
        }
    } else {
        // Load domain(s)
        const domains = domain && domain !== 'all'
            ? [domain]
            : listAllDomains(context).map(d => d.domain);

        for (const dom of domains) {
            const dir = getDomainDir(context, dom);
            if (!existsSync(dir)) {
                return { content: [{ type: 'text', text: `Domain not found: "${dom}". Use docs_list() to see available domains.` }], isError: true };
            }
            const entries = readdirSync(dir).filter(f => {
                const full = join(dir, f);
                return statSync(full).isFile() && f.endsWith('.md');
            });
            for (const file of entries) {
                const fullPath = join(dir, file);
                const content = readFileSync(fullPath, 'utf-8');
                docsToLoad.push({ file: `${dom}/${file}`, content });
            }
        }
    }

    if (!docsToLoad.length) {
        return { content: [{ type: 'text', text: 'No documents found to query. Use docs_list() to see available domains.' }], isError: true };
    }

    if (progress) progress(`Loading ${docsToLoad.length} docs into context...`, 10, 100);

    const totalChars = docsToLoad.reduce((s, d) => s + d.content.length, 0);
    const docsContext = docsToLoad.map(d =>
        `### DOC: ${d.file}\n\`\`\`markdown\n${d.content}\n\`\`\``
    ).join('\n\n---\n\n');

    if (progress) progress(`Context: ${docsToLoad.length} docs, ${(totalChars / 1024).toFixed(0)}KB. Querying LLM...`, 30, 100);

    const systemPrompt = `You are a documentation expert with access to the COMPLETE knowledge base loaded below. Answer the user's question using ONLY the provided documentation. Cite specific documents by filename when relevant. If the docs don't cover the answer, say so clearly — do not fabricate.

The user may ask you to:
- Answer a specific question about the documented systems
- Proofread or verify something against the documented knowledge
- Explain concepts, relationships, or patterns from the docs
- Compare or contrast documented components/providers/architectures`;

    const result = await gateway.chat({
        task: 'query',
        messages: [{
            role: 'user',
            content: `KNOWLEDGE BASE (${docsToLoad.length} documents):\n\n${docsContext}\n\n---\n\nUSER QUESTION: ${question}`
        }],
        systemPrompt
    });

    const answer = typeof result === 'string' ? result : result?.content || '';

    return {
        content: [{
            type: 'text',
            text: `### Docs Query Result\n**Question:** ${question}\n**Docs loaded:** ${docsToLoad.length} (${(totalChars / 1024).toFixed(0)}KB)\n**Domains:** ${[...new Set(docsToLoad.map(d => d.file.split('/')[0]))].join(', ')}\n\n${answer}`
        }]
    };
}

// ── Legacy helpers (keep backward compat) ────────────────────────────

function loadDoc(filename) {
    try {
        const content = readFileSync(join(MCP_DOCS_DIR, `${filename}.md`), 'utf-8');
        return { content: [{ type: 'text', text: content }] };
    } catch (err) {
        return { content: [{ type: 'text', text: `Error reading document: ${err.message}` }], isError: true };
    }
}

export async function get_philosophy(args, context) {
    return loadDoc('coding-philosophy');
}

export async function get_orchestrator_doc(args, context) {
    return loadDoc('orchestrator');
}

