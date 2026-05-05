const API = 'https://api.github.com';
let token;

function headers() {
    return {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'mcp-server-orchestrator'
    };
}

async function api(path, opts = {}) {
    const url = `${API}${path}`;
    const res = await fetch(url, { headers: headers(), ...opts });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GitHub API ${res.status}: ${path} — ${body.slice(0, 300)}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('json')) return res.json();
    return res.text();
}

function paginate(path, limit) {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}per_page=${Math.min(limit, 100)}`;
}

function decodeContent(b64) {
    return Buffer.from(b64, 'base64').toString('utf-8');
}

export async function init(context) {
    token = process.env.GIT_TOKEN;
    if (!token) throw new Error('GIT_TOKEN not set in .env');
    const test = await api('/user');
    return { user: test.login };
}

export async function git_read_file(args) {
    const { owner, repo, path: filePath = '', branch } = args;
    const ref = branch ? `?ref=${branch}` : '';
    const p = filePath ? `/${filePath.replace(/^\/+/, '')}` : '';
    const data = await api(`/repos/${owner}/${repo}/contents${p}${ref}`);

    if (Array.isArray(data)) {
        return {
            content: [{
                type: 'text',
                text: data.map(f => `${f.type.padEnd(6)} ${(f.size || 0).toString().padStart(8)}  ${f.path}`).join('\n')
            }]
        };
    }

    if (data.type === 'file' && data.encoding === 'base64') {
        return {
            content: [{ type: 'text', text: decodeContent(data.content) }]
        };
    }

    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function git_list_tree(args) {
    const { owner, repo, path: scopePath, branch } = args;
    const ref = branch || await getDefaultBranch(owner, repo);
    const tree = await api(`/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`);

    if (tree.truncated) {
        return {
            content: [{ type: 'text', text: 'Tree too large — GitHub truncated it. Use path parameter to scope, or git_read_file for directories.' }],
            isError: true
        };
    }

    let entries = tree.tree;
    if (scopePath) {
        const prefix = scopePath.replace(/^\/+|\/+$/g, '');
        entries = entries.filter(e => e.path.startsWith(prefix + '/') || e.path === prefix);
    }

    const lines = entries.map(e => `${e.type.padEnd(6)} ${e.path}`);
    return {
        content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No files found matching path.' }]
    };
}

async function getDefaultBranch(owner, repo) {
    const info = await api(`/repos/${owner}/${repo}`);
    return info.default_branch;
}

export async function git_log(args) {
    const { owner, repo, path: filePath, branch, limit = 20 } = args;
    let url = paginate(`/repos/${owner}/${repo}/commits`, Math.min(limit, 100));
    if (branch) url += `&sha=${branch}`;
    if (filePath) url += `&path=${filePath}`;

    const commits = await api(url);
    const lines = commits.map(c => {
        const sha = c.sha.slice(0, 7);
        const date = c.commit.author.date.slice(0, 10);
        const author = c.commit.author.name;
        const msg = c.commit.message.split('\n')[0];
        return `${sha}  ${date}  ${author.padEnd(18)} ${msg}`;
    });
    return {
        content: [{ type: 'text', text: lines.join('\n') }]
    };
}

export async function git_search_code(args) {
    const { query, limit = 10 } = args;
    const url = paginate(`/search/code?q=${encodeURIComponent(query)}`, Math.min(limit, 30));
    const data = await api(url);

    if (!data.items || !data.items.length) {
        return { content: [{ type: 'text', text: `No code results for: ${query}` }] };
    }

    const lines = data.items.map(i => {
        const repo = i.repository.full_name;
        const path = i.path;
        return `${repo}/${path}`;
    });
    const header = `Found ${data.total_count} results (showing ${lines.length}):\n`;
    return {
        content: [{ type: 'text', text: header + lines.join('\n') }]
    };
}

export async function git_diff(args) {
    const { owner, repo, base, head } = args;
    const data = await api(`/repos/${owner}/${repo}/compare/${base}...${head}`);

    const summary = [
        `Comparing ${base}...${head}`,
        `Commits: ${data.total_commits}`,
        `Files changed: ${data.files?.length || 0}`,
        `${data.status}`,
        ''
    ];

    if (data.files) {
        for (const f of data.files) {
            summary.push(`${f.status.padEnd(10)} ${f.filename} (+${f.additions} -${f.deletions})`);
            if (f.patch && f.patch.length < 3000) {
                summary.push(f.patch);
            } else if (f.patch) {
                summary.push(f.patch.slice(0, 3000) + '\n... (truncated)');
            }
            summary.push('');
        }
    }

    return {
        content: [{ type: 'text', text: summary.join('\n') }]
    };
}

export async function git_pr_list(args) {
    const { owner, repo, state = 'open', limit = 10 } = args;
    const url = paginate(`/repos/${owner}/${repo}/pulls?state=${state}&sort=updated`, Math.min(limit, 50));
    const prs = await api(url);

    if (!prs.length) {
        return { content: [{ type: 'text', text: `No ${state} pull requests in ${owner}/${repo}` }] };
    }

    const lines = prs.map(p => {
        const num = `#${p.number}`.padEnd(6);
        const st = p.state.padEnd(6);
        const from = p.head.ref;
        const to = p.base.ref;
        return `${num} ${st} ${from} → ${to}  ${p.title}`;
    });
    return {
        content: [{ type: 'text', text: lines.join('\n') }]
    };
}

export async function git_issue_list(args) {
    const { owner, repo, state = 'open', labels, limit = 10 } = args;
    let url = paginate(`/repos/${owner}/${repo}/issues?state=${state}&sort=updated`, Math.min(limit, 50));
    if (labels) url += `&labels=${encodeURIComponent(labels)}`;

    const issues = await api(url);
    const filtered = issues.filter(i => !i.pull_request);

    if (!filtered.length) {
        return { content: [{ type: 'text', text: `No ${state} issues in ${owner}/${repo}` }] };
    }

    const lines = filtered.map(i => {
        const num = `#${i.number}`.padEnd(6);
        const st = i.state.padEnd(6);
        const lbls = i.labels?.map(l => l.name).join(', ') || '';
        return `${num} ${st} ${i.title}${lbls ? `  [${lbls}]` : ''}`;
    });
    return {
        content: [{ type: 'text', text: lines.join('\n') }]
    };
}

export async function git_repo_info(args) {
    const { owner, repo } = args;
    const data = await api(`/repos/${owner}/${repo}`);

    const info = [
        `${data.full_name}`,
        `Description: ${data.description || '(none)'}`,
        `Language: ${data.language || '(none)'}`,
        `Default branch: ${data.default_branch}`,
        `Size: ${(data.size / 1024).toFixed(1)} MB`,
        `Stars: ${data.stargazers_count}  Forks: ${data.forks_count}  Issues: ${data.open_issues_count}`,
        `Created: ${data.created_at.slice(0, 10)}  Updated: ${data.updated_at.slice(0, 10)}`,
        `Topics: ${data.topics?.join(', ') || '(none)'}`,
        `URL: ${data.html_url}`
    ];
    return {
        content: [{ type: 'text', text: info.join('\n') }]
    };
}
