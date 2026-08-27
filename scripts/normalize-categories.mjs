// Phase 2 category normalization — DRY RUN by default.
// Usage: node scripts/normalize-categories.mjs [--apply]
// Without --apply: prints the mapping table + affected doc counts, writes nothing.
// With --apply: rewrites `category` via the nDB API (DB.set) and prints a summary.
import { loadNdb } from '../src/agents/memory/ndb-loader.js';

// ── Canonical vocabulary (~45) ─────────────────────────────────────────────
// Chosen to match the dominant existing spellings so the big clusters keep
// their names. Everything else maps onto these.
const MAP = {
    // case/variant merges
    'Digital Twin': 'digital-twin', 'digital-twin': 'digital-twin',
    'Arena Slides Project': 'Arena Slides', 'Arena Slides': 'Arena Slides',
    'arena-slides': 'Arena Slides', 'arena-curation': 'Arena Slides',
    'Arena': 'arena', 'arena': 'arena', 'arena-experiments': 'arena',
    'Arena Observations': 'arena',
    'nSpeech': 'nSpeech', 'nspeech': 'nSpeech', 'speech': 'nSpeech',
    'nvoice': 'nVoice', 'nVoice': 'nVoice', 'vibevoice': 'nVoice',
    'nspeech/nvoice': 'nSpeech',
    'nPort-architecture': 'nPort', 'nport': 'nPort',
    'mcp_server': 'mcp-server', 'mcp-server': 'mcp-server',
    'llm-gateway': 'llm-gateway', 'LLM Gateway': 'llm-gateway',
    'Gateway & Infrastructure': 'llm-gateway', 'gateway': 'llm-gateway',
    'chat-app-bff': 'chat-app', 'bff-refactor': 'chat-app', 'user_project_chat_app': 'chat-app',
    'nui': 'nui', 'nui_library': 'nui', 'nui-library-quirks': 'nui', 'nui_wc2': 'nui',
    'raum-project': 'RAUM', 'raum-blog': 'RAUM',
    'Kimi Session Mining': 'data-mining', 'data_mining': 'data-mining',
    'geo-aeo': 'GEO/AEO',
    'llama-cpp-builds': 'llama-cpp', 'llama-cpp-wrapper': 'llama-cpp',

    // bug family
    'bug': 'bug', 'bug-fix': 'bug', 'bug fix': 'bug', 'bugfix': 'bug',
    'bugs-fixed': 'bug', 'known-bugs': 'bug', '[materna] bug': 'bug',
    'debug': 'debugging', 'debugging': 'debugging', 'investigation': 'debugging',
    'open-investigation': 'debugging', 'probe-result': 'debugging',
    'storage-bottleneck': 'debugging', 'incident': 'debugging',
    'monitoring': 'debugging', 'verification': 'testing', 'testing': 'testing',

    // project family
    'project': 'project', 'project-status': 'project', 'project state': 'project',
    'project-state': 'project', 'Project Setup': 'project', 'project context': 'project',
    'project-history': 'project', 'project audit': 'project', 'inventory': 'project',
    'project-idea': 'project-idea', 'idea': 'project-idea', 'plan': 'project-plan',
    'project-plan': 'project-plan', 'task_plan': 'project-plan', 'todo': 'project-plan',
    'project-architecture': 'architecture', 'architecture': 'architecture',
    'frontend': 'frontend', 'Frontend': 'frontend', 'web/css-zoom-detection': 'frontend',
    'implementation': 'project', 'refactor': 'project', 'milestone': 'milestone',
    '[materna] milestone': 'milestone', 'feature': 'feature', 'api': 'feature',

    // meta/process family
    'handover': 'handover', 'session handover': 'handover', 'handoff': 'handover',
    'session': 'session', 'session-summary': 'session', 'session log': 'session',
    'conversation_meta': 'session',
    'coding style': 'coding-style', 'workspace-rule': 'coding-style',
    'project-rules': 'coding-style', 'rules': 'coding-style', 'critical-rule': 'coding-style',
    'lesson': 'lesson', 'gotcha': 'lesson', 'patterns': 'lesson',
    'workflow': 'workflow', 'sync': 'workflow', 'recovery': 'workflow',
    'documentation': 'documentation', 'code-review': 'code-review', 'review': 'code-review',
    'report': 'report', 'friction-report': 'report', 'probe': 'report',
    'commit': 'report', 'cleanup': 'project', 'exploration': 'research',
    'research': 'research', 'experiment': 'research', 'theory': 'research',
    'performance': 'performance', 'System Performance': 'performance',
    'performance_philosophy': 'performance', 'storage': 'storage',
    'storage-public-url': 'storage', 'json_export_test': 'testing',
    'websocket-removal': 'project', 'prime-directive': 'documentation',
    'workshop-tool-issue': 'workshop', 'forge': 'forge', 'vdb': 'vdb',
    'memory': 'memory', 'ndb': 'nDB', 'models': 'models', 'model preferences': 'preference',
    'hardware': 'infrastructure', 'infrastructure': 'infrastructure',

    // personal family
    'preference': 'preference', 'Preferences': 'preference', 'preferences': 'preference',
    'user-preference': 'preference', 'user preference': 'preference',
    'personal preference': 'preference', 'personal': 'personal',
    'Personal': 'personal', 'Personal Context': 'personal', 'personal context': 'personal',
    'Personal / Identity': 'identity', 'identity': 'identity', 'Identity': 'identity',
    'biography': 'biography', 'vita': 'biography', 'career': 'career',
    'mental-state': 'mental-state', 'user-state': 'mental-state',
    'user philosophy': 'philosophy', 'philosophy': 'philosophy', 'Philosophy': 'philosophy',
    'aphorism': 'philosophy', 'religion': 'religion', 'Religion': 'religion',
    'humor': 'personal', 'music': 'personal', 'communication': 'personal',
    'accomplishment': 'personal', 'blog': 'blog', 'blog-idea': 'blog', 'writing': 'writing',
    'notes': 'notes', 'decision': 'decision', 'issues': 'workshop',
    'the-between': 'the-between', 'the-between-design': 'the-between',

    // compound comma-lists → primary domain
    'storage, mcp, transport, browser, workaround': 'storage',
    'storage, mcp, transport, browser, workaround, design': 'storage',
    'storage, mcp, transport, lan, success, verified': 'storage',
    'storage, mcp, transport, lesson': 'lesson',
    'storage, network, lan, publicUrl, lesson': 'storage',
    'storage, mcp, resource_link, transport': 'storage',
    '[materna] architecture': 'architecture',
    'materna': 'project',
};

const { Database } = loadNdb();
const db = Database.open('data/memories/data.jsonl');
const deleted = new Set(db.deletedIds());
const docs = db.iter().filter(d => d._id.startsWith('mem_') && !deleted.has(d._id));

const apply = process.argv.includes('--apply');
const changes = [];
const unmapped = new Map();
for (const d of docs) {
    const cat = d.category || '(none)';
    const to = MAP[cat];
    if (to === undefined) { unmapped.set(cat, (unmapped.get(cat) || 0) + 1); continue; }
    if (to !== cat) changes.push({ _id: d._id, id: d.id, from: cat, to });
}

// Report
const grouped = new Map();
for (const c of changes) {
    if (!grouped.has(c.to)) grouped.set(c.to, []);
    grouped.get(c.to).push(c);
}
console.log(`live docs: ${docs.length} | would change: ${changes.length} | unmapped categories: ${unmapped.size}`);
console.log('\n── target ← sources ──');
for (const [to, list] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const froms = [...new Set(list.map(c => c.from))].join(', ');
    console.log(`${String(list.length).padStart(4)} → ${to}   (${froms})`);
}
if (unmapped.size) {
    console.log('\n── UNMAPPED (left as-is) ──');
    for (const [c, n] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), c);
}

if (apply) {
    for (const c of changes) db.set(c._id, 'category', c.to);
    console.log(`\nAPPLIED: ${changes.length} docs updated. Distinct categories now: ${new Set(db.iter().filter(d => d._id.startsWith('mem_') && !deleted.has(d._id)).map(d => d.category)).size}`);
} else {
    console.log('\n(dry run — pass --apply to write)');
}
