// Tier 0 — deterministic analysis. No model, no judgment: structure extraction,
// dependency graph, boundary classification, defensive-pattern hunts, dive ranking.
// Everything checkable mechanically stays here; a missed hunt is a bug in the
// hunt list, not model variance (spec §4.1).
//
// Hunts produce CANDIDATES, not findings — the orchestrator judges them against
// the rubric and must produce evidence + ladder + test spec for anything that
// survives. Tier 0 never decides what is a finding.

import fsp from 'fs/promises';
import path from 'path';
import { parse as acornParse } from 'acorn';
import { getLogger } from '../../utils/logger.js';
import { analyzeRust } from './rust-analyzer.js';

const logger = getLogger();

const LANGUAGE_BY_EXTENSION = new Map([
    ['.js', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
    ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.jsx', 'javascript'],
    ['.rs', 'rust'], ['.py', 'python'], ['.go', 'go'], ['.java', 'java'],
    ['.c', 'c'], ['.h', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.hpp', 'cpp'],
    ['.cs', 'csharp'], ['.rb', 'ruby'], ['.php', 'php'], ['.swift', 'swift'],
    ['.kt', 'kotlin'], ['.kts', 'kotlin'], ['.scala', 'scala'], ['.sh', 'shell'],
    ['.ps1', 'powershell'], ['.sql', 'sql'], ['.lua', 'lua'], ['.dart', 'dart'],
    ['.vue', 'vue'], ['.svelte', 'svelte']
]);

function describeLanguage(rel) {
    const ext = path.posix.extname(rel).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION.get(ext) ?? (ext ? ext.slice(1) : 'text');
    const analysisMode = language === 'javascript' && ext !== '.jsx' ? 'ast' : language === 'rust' ? 'structural' : 'generic';
    return { language, analysisMode };
}

const BOUNDARY_PATTERNS = [
    { kind: 'network', re: /\bfetch\s*\(|\bhttps?\b\s*\.\s*request|\bnet\.connect|\btls\.connect|new\s+WebSocket|\bws:\/\/|\bwss:\/\/|XMLHttpRequest|undici|axios|got\s*\(|node-fetch|reqwest|TcpStream|TcpListener|UdpSocket|hyper::|tonic::|requests\.|urllib|http\.client/ },
    { kind: 'process', re: /child_process|\bexecSync?\s*\(|\bspawnSync?\s*\(|\bexecFile\b|\bfork\s*\(|worker_threads|\bcross-spawn\b|std::process::Command|tokio::process::Command|subprocess\.|ProcessBuilder/ },
    { kind: 'fs', re: /\bfs\s*\.\s*\w+|\bfsPromises\s*\.\s*\w+|from\s+['"]fs|\breadFile|\bwriteFile|createReadStream|createWriteStream|\breaddir\b|\bmkdir\b|std::fs|tokio::fs|File::open|OpenOptions|read_to_string|read_to_end/ }
];

// Config-ish roots: defaults masking THESE are hiding configuration absence.
const CONFIG_ROOT_RE = /^(config|cfg|conf|settings|opts|options|env|props|params)$/;

function parseJs(rel, source) {
    const comments = [];
    const opts = (sourceType) => ({
        ecmaVersion: 'latest',
        sourceType,
        locations: true,
        onComment: (isBlock, text, start, end, lineStart) => {
            // With locations: true acorn hands Position objects ({line, column})
            // — store the number or hunt lines render as '[object Object]'.
            comments.push({ isBlock, text, start, end, line: lineStart.line });
        }
    });
    try {
        return { ast: acornParse(source, opts('module')), comments, sourceType: 'module' };
    } catch {
        // .js files may be CJS; a module-parse failure falls back to script.
        // The failed module parse already pushed comments via onComment —
        // clear them or every comment before the syntax error is duplicated
        // (duplicate narration hunts, inflated dive ranking).
        comments.length = 0;
        try {
            return { ast: acornParse(source, opts('script')), comments, sourceType: 'script' };
        } catch (err) {
            return { ast: null, comments, parseError: `${err.message}` };
        }
    }
}

// Minimal recursive walker — acorn-walk is a separate package and the node types
// we need are a fixed small set; hand-rolled beats a dependency.
function walk(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const child of value) {
                if (child && typeof child.type === 'string') walk(child, visit);
            }
        } else if (value && typeof value.type === 'string') {
            walk(value, visit);
        }
    }
}

function resolveImportSpecifier(specifier, fromRel, jsFilesSet) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        return { unresolved: { from: fromRel, specifier, kind: 'bare' } };
    }
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
    const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.mjs`];
    for (const candidate of candidates) {
        if (jsFilesSet.has(candidate)) return { target: candidate };
    }
    return { unresolved: { from: fromRel, specifier, kind: 'unresolved-relative' } };
}

function collectImports(ast, fromRel, jsFilesSet) {
    const edges = [];
    const unresolved = [];
    const resolveEdge = (specifier) => {
        const resolved = resolveImportSpecifier(specifier, fromRel, jsFilesSet);
        if (resolved.target) edges.push(resolved.target);
        else unresolved.push(resolved.unresolved);
    };
    walk(ast, (node) => {
        if (node.type === 'ImportDeclaration' && node.source?.value) {
            resolveEdge(node.source.value);
        } else if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source?.value) {
            resolveEdge(node.source.value);
        } else if (node.type === 'ImportExpression') {
            // acorn 8.x parses `import(x)` as ImportExpression with a .source
            // property — NOT a CallExpression. Matching the CallExpression shape
            // missed every dynamic import and let their importers escape the
            // incremental blast radius.
            if (node.source?.type === 'Literal' && typeof node.source.value === 'string') {
                resolveEdge(node.source.value);
            } else {
                unresolved.push({ from: fromRel, specifier: '<dynamic expression>', kind: 'dynamic' });
            }
        } else if (node.type === 'CallExpression' && node.callee?.type === 'ImportExpression') {
            if (node.arguments?.[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
                resolveEdge(node.arguments[0].value);
            } else {
                unresolved.push({ from: fromRel, specifier: '<dynamic expression>', kind: 'dynamic' });
            }
        }
    });
    return { edges: [...new Set(edges)], unresolved };
}

function classifyBoundaries(source) {
    const kinds = new Set();
    const lines = source.split('\n');
    for (const line of lines) {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue; // comment text isn't a boundary
        for (const { kind, re } of BOUNDARY_PATTERNS) {
            if (re.test(line)) kinds.add(kind);
        }
    }
    return [...kinds];
}

function lineAt(source, index) {
    let line = 1;
    for (let i = 0; i < index && i < source.length; i++) {
        if (source.charCodeAt(i) === 10) line++;
    }
    return line;
}

// ── Hunts ──────────────────────────────────────────────────────────────────

function rootIdentifierOf(memberExpr) {
    let node = memberExpr;
    while (node && node.type === 'MemberExpression') node = node.object;
    return node?.type === 'Identifier' ? node.name : null;
}

function isConfigishLeft(left) {
    const root = rootIdentifierOf(left);
    if (root && CONFIG_ROOT_RE.test(root)) return true;
    // process.env.*
    let node = left;
    while (node && node.type === 'MemberExpression') {
        if (node.object?.type === 'MemberExpression' && node.object.property?.name === 'env' && node.object.object?.name === 'process') return true;
        node = node.object;
    }
    return false;
}

function huntSwallowedCatch(ast, rel, source) {
    const hits = [];
    walk(ast, (node) => {
        if (node.type !== 'CatchClause') return;
        const body = node.body?.body ?? [];
        if (body.length === 0) {
            hits.push({ kind: 'swallowed-catch', file: rel, line: lineAt(source, node.start), snippet: `catch (${node.param?.name ?? ''}) { }` });
            return;
        }
        let throws = false;
        let logs = false;
        walk(node.body, (n) => {
            if (n.type === 'ThrowStatement') throws = true;
            if (n.type === 'CallExpression') {
                const callee = n.callee;
                const name = callee?.property?.name || callee?.name || '';
                if (/^(log|warn|error|info|debug|trace|report|notify)$/i.test(name) || /logger|console/i.test(String(callee?.object?.name ?? ''))) logs = true;
            }
        });
        const paramUsed = node.param && walkUsesIdentifier(node.body, node.param.name);
        if (!throws && !logs && !paramUsed) {
            const first = body[0];
            hits.push({ kind: 'swallowed-catch', file: rel, line: lineAt(source, node.start), snippet: source.slice(node.start, Math.min(first.end, node.start + 120)).replace(/\s+/g, ' ') });
        }
    });
    return hits;
}

function walkUsesIdentifier(node, name) {
    let used = false;
    walk(node, (n) => {
        if (n.type === 'Identifier' && n.name === name) used = true;
    });
    return used;
}

function huntDefaultMasks(ast, rel, source) {
    const hits = [];
    walk(ast, (node) => {
        if (node.type !== 'LogicalExpression' && node.type !== 'ChainExpression') return;
        const expr = node.type === 'ChainExpression' ? node.expression : node;
        if (node.type === 'ChainExpression') {
            // Optional chaining on a config-ish root — invariant masked as absence.
            if (expr.type === 'MemberExpression' && isConfigishLeft(expr)) {
                hits.push({ kind: 'optional-chain-config', file: rel, line: lineAt(source, node.start), snippet: source.slice(node.start, node.end).slice(0, 120) });
            }
            return;
        }
        if ((expr.operator === '||' || expr.operator === '??') && expr.left.type === 'MemberExpression' && isConfigishLeft(expr.left)) {
            const rightIsLiteral = expr.right.type === 'Literal';
            if (rightIsLiteral) {
                hits.push({ kind: expr.operator === '||' ? 'or-default-config' : 'nullish-default-config', file: rel, line: lineAt(source, node.start), snippet: source.slice(node.start, node.end).slice(0, 120) });
            }
        }
    });
    return hits;
}

const NARRATION_STOPWORDS = new Set(['the', 'a', 'an', 'this', 'that', 'to', 'of', 'and', 'or', 'is', 'are', 'it', 'its', 'for', 'with', 'in', 'on', 'we', 'our', 'be']);

function huntNarrationComments(comments, ast, rel, source) {
    const hits = [];
    const statements = [];
    walk(ast, (n) => {
        if (n.type.endsWith('Statement') || n.type.endsWith('Declaration')) statements.push(n);
    });
    statements.sort((a, b) => a.start - b.start);
    for (const comment of comments) {
        const text = comment.text.trim();
        if (text.length < 8 || text.length > 80) continue;
        if (text.startsWith('!') || text.startsWith('TODO') || text.startsWith('FIXME') || text.startsWith('mb:')) continue;
        const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !NARRATION_STOPWORDS.has(t));
        if (tokens.length < 2) continue;
        // Find the first statement after the comment.
        const next = statements.find((s) => s.start >= comment.end);
        if (!next || next.start - comment.end > 200) continue;
        const idents = new Set();
        walk(next, (n) => {
            if (n.type === 'Identifier') idents.add(n.name.toLowerCase());
            if (n.type === 'Literal' && typeof n.value === 'string') {
                for (const word of n.value.toLowerCase().split(/[^a-z0-9]+/)) if (word) idents.add(word);
            }
        });
        const covered = tokens.filter((t) => [...idents].some((id) => id.includes(t) || t.includes(id)));
        if (covered.length >= 2 && covered.length >= tokens.length / 2) {
            hits.push({ kind: 'narration-comment', file: rel, line: comment.line, snippet: text.slice(0, 100) });
        }
    }
    return hits;
}

// `if (err) { }` — an error branch with an empty body is the same swallow as an
// empty catch, wearing callback clothes.
function huntEmptyErrorBranch(ast, rel, source) {
    const hits = [];
    walk(ast, (node) => {
        if (node.type !== 'IfStatement') return;
        if (node.consequent?.type !== 'BlockStatement' || (node.consequent.body?.length ?? 1) > 0) return;
        if (node.alternate) return;
        const test = node.test;
        const isErr = (test.type === 'Identifier' && /^(err|error|e)$/.test(test.name)) ||
            (test.type === 'MemberExpression' && /(err|error)/i.test(test.property?.name ?? ''));
        if (isErr) {
            hits.push({ kind: 'empty-error-branch', file: rel, line: lineAt(source, node.start), snippet: source.slice(node.start, node.end).slice(0, 120) });
        }
    });
    return hits;
}

// ── Ranking ────────────────────────────────────────────────────────────────

const BOUNDARY_WEIGHTS = { network: 3, process: 2, fs: 1 };

/**
 * Full tier-0 pass over a snapshot. Never throws on individual files — a parse
 * error is recorded on the file and reported; the rest of the tree still gets
 * analyzed. Returns the analysis consumed by the map builder and persisted for
 * incremental reviews.
 */
export async function analyzeSnapshot(snapshotDir) {
    const sourceFiles = new Set();
    const jsFilesSet = new Set();
    const rustFilesSet = new Set();
    const allFiles = [];

    async function collect(dir, relPrefix) {
        const entries = await fsp.readdir(path.join(snapshotDir, relPrefix), { withFileTypes: true });
        for (const entry of entries) {
            const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
            if (entry.name === '_snapshot.json') continue;
            if (entry.isDirectory()) await collect(dir, rel);
            else if (entry.isFile()) allFiles.push(rel);
        }
    }
    await collect(snapshotDir, '');
    for (const rel of allFiles) {
        const descriptor = describeLanguage(rel);
        sourceFiles.add(rel);
        if (descriptor.analysisMode === 'ast') jsFilesSet.add(rel);
        if (descriptor.analysisMode === 'structural') rustFilesSet.add(rel);
    }

    const fileInfo = new Map(); // rel → facts
    const graphEdges = new Map(); // rel → Set<rel> (imports)
    const reverseEdges = new Map(); // rel → Set<rel> (imported-by)
    const unresolvedEdges = [];
    const hunts = [];
    let processed = 0;

    for (const rel of allFiles) {
        const descriptor = describeLanguage(rel);
        fileInfo.set(rel, { rel, size: 0, lines: 0, boundaries: [], parseError: null, ...descriptor });
        processed++;
        if (processed % 50 === 0) await new Promise((r) => setImmediate(r));

        const abs = path.join(snapshotDir, ...rel.split('/'));
        const source = await fsp.readFile(abs, 'utf8');
        const info = fileInfo.get(rel);
        info.size = source.length;
        info.lines = source.split('\n').length;
        info.boundaries = classifyBoundaries(source);

        let edges = [];
        let unresolved = [];
        if (descriptor.analysisMode === 'ast') {
            const { ast, comments, parseError } = parseJs(rel, source);
            if (parseError) {
                info.parseError = parseError;
                continue;
            }
            ({ edges, unresolved } = collectImports(ast, rel, jsFilesSet));
            hunts.push(...huntSwallowedCatch(ast, rel, source));
            hunts.push(...huntDefaultMasks(ast, rel, source));
            hunts.push(...huntEmptyErrorBranch(ast, rel, source));
            hunts.push(...huntNarrationComments(comments, ast, rel, source));
        } else if (descriptor.analysisMode === 'structural') {
            const rust = analyzeRust(rel, source, rustFilesSet);
            edges = rust.edges;
            unresolved = rust.unresolved;
            hunts.push(...rust.hunts);
        }
        graphEdges.set(rel, new Set(edges));
        for (const target of edges) {
            if (!reverseEdges.has(target)) reverseEdges.set(target, new Set());
            reverseEdges.get(target).add(rel);
        }
        unresolvedEdges.push(...unresolved);
    }

    // Fan-in + hunt density + boundary weights → deterministic dive ranking.
    const huntCounts = new Map();
    for (const hunt of hunts) huntCounts.set(hunt.file, (huntCounts.get(hunt.file) ?? 0) + 1);

    const ranked = [];
    for (const rel of sourceFiles) {
        const info = fileInfo.get(rel);
        const fanIn = reverseEdges.get(rel)?.size ?? 0;
        const huntHits = huntCounts.get(rel) ?? 0;
        let score = 0;
        const reasons = [];
        for (const b of info.boundaries) {
            score += BOUNDARY_WEIGHTS[b] ?? 1;
            reasons.push(`boundary:${b}`);
        }
        if (fanIn > 0) {
            score += Math.min(fanIn, 10) * 1.5;
            reasons.push(`fan-in:${fanIn}`);
        }
        if (huntHits > 0) {
            score += huntHits * 2.5;
            reasons.push(`hunts:${huntHits}`);
        }
        score += Math.min(info.lines / 400, 2);
        if (info.parseError) reasons.push('parse-error');
        ranked.push({ rel, score, fanIn, huntHits, boundaries: info.boundaries, reasons, lines: info.lines, parseError: info.parseError ?? null, language: info.language, analysisMode: info.analysisMode });
    }
    ranked.sort((a, b) => b.score - a.score);

    // Hierarchical map level 1: module (directory) rollup.
    const modules = new Map();
    for (const rel of allFiles) {
        const dir = path.posix.dirname(rel) === '.' ? '/' : path.posix.dirname(rel);
        const info = fileInfo.get(rel);
        const mod = modules.get(dir) ?? { dir, fileCount: 0, totalLines: 0, boundaries: new Set(), jsCount: 0, rustCount: 0, genericCount: 0 };
        mod.fileCount++;
        mod.totalLines += info.lines;
        if (info.analysisMode === 'ast') mod.jsCount++;
        else if (info.analysisMode === 'structural') mod.rustCount++;
        else mod.genericCount++;
        for (const b of info.boundaries) mod.boundaries.add(b);
        modules.set(dir, mod);
    }

    const languageCounts = {};
    const analysisModeCounts = { ast: 0, structural: 0, generic: 0 };
    const genericFiles = [];
    for (const rel of sourceFiles) {
        const info = fileInfo.get(rel);
        languageCounts[info.language] = (languageCounts[info.language] ?? 0) + 1;
        analysisModeCounts[info.analysisMode]++;
        if (info.analysisMode === 'generic') {
            genericFiles.push({ rel, language: info.language, reason: 'no language-specific tier-0 adapter; model digest/dive remains available' });
        }
    }

    const result = {
        fileCount: allFiles.length,
        eligibleFileCount: sourceFiles.size,
        jsFileCount: jsFilesSet.size,
        rustFileCount: rustFilesSet.size,
        languageCounts,
        analysisModeCounts,
        genericFiles,
        files: [...fileInfo.values()],
        graph: {
            edges: Object.fromEntries([...graphEdges.entries()].map(([k, v]) => [k, [...v]])),
            reverse: Object.fromEntries([...reverseEdges.entries()].map(([k, v]) => [k, [...v]])),
            unresolved: unresolvedEdges
        },
        hunts,
        ranked,
        modules: [...modules.values()].map((m) => ({ ...m, boundaries: [...m.boundaries] }))
    };
    logger.info(`[codereview] tier-0 done: ${sourceFiles.size} text files (${result.jsFileCount} js, ${result.rustFileCount} rust, ${analysisModeCounts.generic} generic), ${hunts.length} hunt candidates, ${unresolvedEdges.length} unresolved edges`, null, 'CodeReview');
    return result;
}

/**
 * Blast radius for an incremental review: changed files plus everything
 * reachable from them in the dependency graph. Callers whose imports changed
 * are re-reviewed even when their own bytes didn't change (spec §4.3).
 * Files reachable only through unresolved edges are NOT claimed as covered —
 * they are reported as uncovered instead.
 */
export function computeBlastRadius(analysis, changedFiles) {
    const changed = new Set(changedFiles);
    const queue = [...changedFiles];
    const seen = new Set(changedFiles);
    while (queue.length > 0) {
        const current = queue.pop();
        for (const dependent of analysis.graph.reverse[current] ?? []) {
            if (!seen.has(dependent)) {
                seen.add(dependent);
                changed.add(dependent);
                queue.push(dependent);
            }
        }
    }
    return changed;
}

/**
 * Deletion-aware blast radius. Deleted files' importers exist only in the
 * PRIOR graph — the new snapshot cannot contain edges to a file that no longer
 * exists — so deletions traverse priorGraphEdges (importer → targets) and the
 * result is unioned with the current-graph blast.
 */
export function computeBlastRadiusWithDeletions(analysis, changedFiles, deletedFiles, priorGraphEdges) {
    const blast = computeBlastRadius(analysis, changedFiles);
    if (!deletedFiles?.length) return blast;
    const priorReverse = new Map();
    for (const [importer, targets] of Object.entries(priorGraphEdges ?? {})) {
        for (const target of targets) {
            if (!priorReverse.has(target)) priorReverse.set(target, new Set());
            priorReverse.get(target).add(importer);
        }
    }
    const queue = [...deletedFiles];
    while (queue.length > 0) {
        const current = queue.pop();
        for (const importer of priorReverse.get(current) ?? []) {
            if (!blast.has(importer)) {
                blast.add(importer);
                queue.push(importer);
            }
        }
    }
    return blast;
}
