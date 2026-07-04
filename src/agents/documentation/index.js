import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from '../../utils/logger.js';
import { searchDocuments } from '../vdb/index.js';

const logger = getLogger();

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    const cfg = context?.config?.agents?.documentation?.llmDocsPath;
    llmDocsPath = cfg || 'D:\\DEV\\LLM_Docs';
    return llmDocsPath;
}

function resolveDocPath(context, file) {
    if (file.startsWith('Workshop/')) {
        return join(getMcpDocsPath(), file.slice('Workshop/'.length));
    }
    const base = getDocsBase(context);
    return join(base, 'Documentation', file);
}

function getMcpDocsPath() {
    return join(__dirname, '..', '..', '..', 'mcp_documentation');
}

function getDomainDir(context, domain) {
    if (domain === 'Workshop') return getMcpDocsPath();
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
    // Also scan the local mcp_documentation/ as the "Workshop" domain
    const mcpPath = getMcpDocsPath();
    const workshop = scanDomain(mcpPath, 'Workshop');
    if (workshop) domains.push(workshop);

    return domains;
}

// ── LLM-based domain resolution ──────────────────────────────────────
// When the caller provides a domain name that isn't an exact match,
// ask the LLM to pick the best domain(s) from the available list.

async function resolveDomainViaLLM(wanted, allDomains, question, gateway) {
    const domainList = allDomains.map(d =>
        `- "${d.domain}"${d.description ? ` — ${d.description}` : ''} (${d.count} files)`
    ).join('\n');

    const prompt = `You are selecting which documentation domain(s) to search. Below are the available domains:

${domainList}

The user asked: "${question}"
They suggested domain: "${wanted}"

Which domain(s) are most relevant? Reply with ONLY the exact domain name(s), comma-separated, from the list above. If multiple domains are relevant, list them. If none clearly match, reply "all". No explanation.`;

    try {
        const result = await gateway.chat({
            task: 'query',
            messages: [{ role: 'user', content: prompt }],
            systemPrompt: 'Reply with only domain names from the list, comma-separated, or "all". No other text.',
            maxTokens: 100,
            temperature: 0
        });

        const raw = (typeof result === 'string' ? result : result?.content || '').trim();
        // Parse comma-separated list
        const picks = raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        const valid = picks
            .map(p => allDomains.find(d => d.domain === p))
            .filter(Boolean)
            .map(d => d.domain);

        if (valid.length > 0) {
            return { domains: valid, note: `LLM resolved "${wanted}" → ${valid.join(', ')}` };
        }
        // LLM said "all" or returned unrecognizable — fall back to all
        return { domains: allDomains.map(d => d.domain), note: `LLM could not resolve "${wanted}" to a specific domain, fell back to all` };
    } catch {
        // LLM call failed — fall back to all
        return { domains: allDomains.map(d => d.domain), note: `Domain resolution skipped (LLM unavailable), fell back to all` };
    }
}

// ── MCP tool handlers ────────────────────────────────────────────────

export async function documentation_domains(args, context) {
    const domains = listAllDomains(context);
    const result = {
        basePath: getDocsBase(context),
        count: domains.length,
        domains: domains.map(d => ({
            domain: d.domain,
            description: d.description,
            fileCount: d.count
        }))
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export async function documentation_list(args, context) {
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

export async function documentation_get(args, context) {
    const { file, lines } = args || {};
    if (!file) return { content: [{ type: 'text', text: 'Error: "file" parameter is required.' }], isError: true };

    const fullPath = resolveDocPath(context, file);
    if (!existsSync(fullPath)) {
        const avail = listAllDomains(context).map(d => `${d.domain} (${d.count} files)`).join(', ');
        return { content: [{ type: 'text', text: `Document not found: "${file}". Paths must be 'DomainName/filename.md' (e.g., from documentation_list output). Available domains: ${avail}. Call documentation_list() for full file listings.` }], isError: true };
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

export async function documentation_query(args, context) {
    const { question, domain, files } = args || {};
    if (!question) return { content: [{ type: 'text', text: 'Error: "question" parameter is required.' }], isError: true };

    const { gateway, progress } = context;

    let docsToLoad = [];
    let retrievalMethod = 'vdb';
    let domainNote = '';

    if (files && Array.isArray(files) && files.length > 0) {
        // Load specific files
        for (const file of files) {
            const fullPath = resolveDocPath(context, file);
            if (!existsSync(fullPath)) {
                const avail = listAllDomains(context).map(d => d.domain).join(', ');
                return { content: [{ type: 'text', text: `Document not found: "${file}". Paths must be 'DomainName/filename.md'. Available domains: ${avail}. Call documentation_list() to see exact filenames, or use the 'domain' parameter instead of 'files'.` }], isError: true };
            }
            const content = readFileSync(fullPath, 'utf-8');
            docsToLoad.push({ file, content });
        }
        retrievalMethod = 'files';
    } else {
        // Try vector search first (simple RAG)
        try {
            if (progress) progress(`Searching documentation vectors...`, 5, 100);
            const vdbResults = await searchDocuments({
                query: question,
                collections: ['documentation'],
                folder: domain && domain !== 'all' ? domain : undefined,
                top_k: 12,
                include_content: true
            });

            const seenFiles = new Set();
            for (const r of vdbResults) {
                const fileName = r.path.replace(/\\/g, '/');
                if (seenFiles.has(fileName)) continue;
                seenFiles.add(fileName);
                const fullPath = r.absolutePath;
                if (!existsSync(fullPath)) continue;
                const content = readFileSync(fullPath, 'utf-8');
                let docFile = fileName;
                if (r.domain) docFile = `${r.domain}/${fileName}`;
                docsToLoad.push({ file: docFile, content, score: r.score });
            }

            if (docsToLoad.length) {
                retrievalMethod = 'vdb';
            }
        } catch (e) {
            logger.warn(`[Documentation] VDB search failed, falling back to full domain load: ${e.message}`, null, 'Docs');
        }

        // Fallback: load entire domain(s)
        if (!docsToLoad.length) {
            retrievalMethod = domain ? 'domain' : 'all';
            const allDomains = listAllDomains(context);
            const availNames = allDomains.map(d => d.domain);

            let domainsToLoad;

            if (!domain || domain === 'all') {
                domainsToLoad = availNames;
            } else {
                const exact = allDomains.find(d => d.domain === domain);
                if (exact) {
                    domainsToLoad = [exact.domain];
                } else {
                    if (progress) progress(`Resolving domain "${domain}" via LLM...`, 2, 100);
                    const resolved = await resolveDomainViaLLM(domain, allDomains, question, gateway);
                    domainsToLoad = resolved.domains;
                    domainNote = resolved.note;
                }
            }

            for (const dom of domainsToLoad) {
                const dir = getDomainDir(context, dom);
                if (!existsSync(dir)) continue;
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
    }

    if (!docsToLoad.length) {
        return { content: [{ type: 'text', text: 'No documents found to query. Use documentation_list() to see available domains.' }], isError: true };
    }

    if (progress) progress(`Loading ${docsToLoad.length} docs into context...`, 10, 100);

    const totalChars = docsToLoad.reduce((s, d) => s + d.content.length, 0);
    const docsContext = docsToLoad.map(d =>
        `### DOC: ${d.file}${d.score !== undefined ? ` (relevance: ${(d.score * 100).toFixed(1)}%)` : ''}\n\`\`\`markdown\n${d.content}\n\`\`\``
    ).join('\n\n---\n\n');

    if (progress) progress(`Context: ${docsToLoad.length} docs, ${(totalChars / 1024).toFixed(0)}KB. Querying LLM...`, 30, 100);

    const systemPrompt = `You are a documentation expert with access to the knowledge base loaded below. Answer the user's question using ONLY the provided documentation. Cite specific documents by filename when relevant. If the docs don't cover the answer, say so clearly — do not fabricate.

Use documentation.query for:
- **Search**: Find where a concept, API, or feature is documented across the knowledge base
- **Q&A**: Answer specific questions about documented systems, architecture, providers, or internals
- **Spec alignment**: Analyze a script, config, or code snippet against documented specs — flag gaps, violations, or inconsistencies

You can explain concepts, relationships, patterns, and compare/contrast documented components.`;

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
            text: `### Docs Query Result\n**Question:** ${question}\n**Retrieval:** ${retrievalMethod}\n**Docs loaded:** ${docsToLoad.length} (${(totalChars / 1024).toFixed(0)}KB)\n**Domains:** ${[...new Set(docsToLoad.map(d => d.file.split('/')[0]))].join(', ')}${domainNote ? `\n**Domain note:** ${domainNote}` : ''}\n\n${answer}`
        }]
    };
}

// ── REST API ─────────────────────────────────────────────────────────

export async function init(context) {
    const app = context.app;
    if (!app) return;

    // GET /docs — list all domains
    app.get('/docs', (_req, res) => {
        const domains = listAllDomains(context);
        res.json({
            basePath: getDocsBase(context),
            count: domains.length,
            domains: domains.map(d => ({
                domain: d.domain,
                description: d.description,
                fileCount: d.count,
                files: d.docs.map(f => f.file)
            }))
        });
    });

    // GET /docs/:domain — list files in a domain
    app.get('/docs/:domain', (req, res) => {
        const dir = getDomainDir(context, req.params.domain);
        const result = scanDomain(dir, req.params.domain);
        if (!result) return res.status(404).json({ error: `Domain not found: "${req.params.domain}"` });
        res.json(result);
    });

    // GET /docs/:domain/* — serve raw file content (middleware catches all sub-paths)
    app.use('/docs', (req, res, next) => {
        const urlPath = req.path.replace(/^\//, '');
        if (!urlPath || urlPath === '/') return next(); // let /docs itself fall through to the listing route
        const filePath = urlPath;
        const fullPath = resolveDocPath(context, filePath);
        if (!existsSync(fullPath)) return res.status(404).json({ error: `File not found: "${filePath}"` });

        const content = readFileSync(fullPath, 'utf-8');
        const { data: fm, body } = parseFrontmatter(content);
        const ext = filePath.endsWith('.md') ? 'text/markdown' : 'text/plain';
        res.set('Content-Type', `${ext}; charset=utf-8`);
        res.send(body);
    });
}



