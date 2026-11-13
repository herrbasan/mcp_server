// Source resolver — every input kind materializes to a local snapshot + tree hash.
// Spec §5: stability (tree can't change mid-review), cache key, provenance.
// Snapshot hygiene is load-bearing: secrets never enter the snapshot (it feeds
// third-party gateways), and every exclusion is recorded — silently dropping a
// relevant file is the same sin as silent degradation.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import { execFile } from 'child_process';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'vendor', 'third_party', 'third-party', 'external', 'pdfium', 'coverage', '.cache', '__pycache__']);
const SECRET_FILE_PATTERNS = [/^\.env(\..+)?$/, /\.pem$/, /\.key$/, /\.crt$/, /\.pfx$/, /\.p12$/, /^id_rsa/, /\.kdbx$/, /^credentials.*\.json$/];
const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'tgz', 'bz2', '7z', 'rar',
    'wav', 'mp3', 'ogg', 'flac', 'mp4', 'webm', 'mov', 'avi', 'mkv',
    'exe', 'dll', 'node', 'bin', 'dat', 'woff', 'woff2', 'ttf', 'eot',
    'class', 'jar', 'so', 'dylib', 'pyc', 'wasm'
]);
const TEXT_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'json', 'md', 'txt', 'html', 'css', 'scss', 'yml', 'yaml', 'toml', 'xml', 'svg', 'sh', 'ps1', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'hpp', 'sql', 'gitignore', 'editorconfig', 'npmrc', 'nvmrc']);

function isSecretName(name) {
    return SECRET_FILE_PATTERNS.some((re) => re.test(name));
}

function isBinaryName(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return true;
    // Unknown extension and not a known text extension: sniff for NUL bytes later is
    // overkill for v1 — treat unknown extensions as binary (excluded, listed).
    if (!TEXT_EXTENSIONS.has(ext) && ext !== name.toLowerCase()) return true;
    return false;
}

// Minified/vendor heuristic: extremely long lines in a .js-family file.
function looksMinified(content) {
    const lines = content.split('\n');
    if (lines.length === 0) return false;
    const avgLen = content.length / lines.length;
    const maxLen = Math.max(...lines.slice(0, 200).map((l) => l.length));
    return avgLen > 300 || maxLen > 5000;
}

function sha256Buf(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: opts.timeoutMs ?? 120_000, cwd: opts.cwd, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

async function* walkFiles(root, relPrefix = '') {
    const entries = await fsp.readdir(path.join(root, relPrefix), { withFileTypes: true });
    for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.name === '_snapshot.json') continue; // provenance metadata never enters hashes or copies
        if (entry.isDirectory()) {
            if (EXCLUDED_DIRS.has(entry.name)) {
                yield { rel, isDir: true, reason: `directory: ${entry.name}` };
                continue;
            }
            yield* walkFiles(root, rel);
        } else if (entry.isFile()) {
            yield { rel, isDir: false };
        }
        // Symlinks and other types: skipped. A symlinked tree is not copied as one —
        // stability of the snapshot beats completeness of exotic layouts.
    }
}

/**
 * Copy a tree into dst applying exclusion rules. Returns { copied, exclusions }
 * where each exclusion is { rel, reason } — the report lists every one.
 */
export async function copyTreeFiltered(srcRoot, dstRoot) {
    await fsp.mkdir(dstRoot, { recursive: true });
    const copied = [];
    const exclusions = [];
    let processed = 0;
    for await (const entry of walkFiles(srcRoot)) {
        processed++;
        if (processed % 200 === 0) await new Promise((r) => setImmediate(r)); // never block the loop

        if (entry.isDir) {
            exclusions.push({ rel: entry.rel, reason: entry.reason });
            continue;
        }
        const rel = entry.rel;
        const base = path.posix.basename(rel);
        if (isSecretName(base)) {
            exclusions.push({ rel, reason: 'secret — never enters a snapshot that feeds model gateways' });
            continue;
        }
        if (isBinaryName(base)) {
            exclusions.push({ rel, reason: 'binary' });
            continue;
        }

        const src = path.join(srcRoot, ...rel.split('/'));
        const dst = path.join(dstRoot, ...rel.split('/'));
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        const content = await fsp.readFile(src);
        if ((base.endsWith('.js') || base.endsWith('.mjs') || base.endsWith('.cjs')) && looksMinified(content.toString('utf8'))) {
            exclusions.push({ rel, reason: 'minified/vendor heuristic' });
            continue;
        }
        await fsp.writeFile(dst, content);
        copied.push(rel);
    }
    return { copied, exclusions };
}

/**
 * Compute the tree hash: sha256 over sorted (relpath, filehash) pairs.
 * Any content or layout change produces a different hash — the incremental
 * review and the findings cache key start here.
 */
export async function hashTree(root) {
    const rels = [];
    for await (const entry of walkFiles(root)) {
        if (!entry.isDir) rels.push(entry.rel);
    }
    rels.sort();
    const hash = crypto.createHash('sha256');
    for (const rel of rels) {
        const buf = await fsp.readFile(path.join(root, ...rel.split('/')));
        hash.update(rel);
        hash.update('\0');
        hash.update(sha256Buf(buf));
        hash.update('\n');
    }
    return { treeHash: hash.digest('hex'), files: rels };
}

function classifySource(source) {
    if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\') || source.startsWith('/')) {
        return { kind: 'path', value: source };
    }
    const gh = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9._/-]+))?$/.exec(source);
    if (gh) return { kind: 'github', owner: gh[1], repo: gh[2], ref: gh[3] || 'HEAD' };
    throw new Error(`codereview: cannot classify source '${source}' — expected an absolute/UNC path, owner/repo[@ref], or an archive file path`);
}

async function fetchGitHubTree(owner, repo, ref, tmpDir) {
    // init+fetch+checkout works for branches, tags AND SHAs (GitHub allows shallow
    // fetch of any reachable object). Token never logged, never written to the snapshot.
    const token = process.env.GIT_TOKEN;
    const remote = token
        ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
        : `https://github.com/${owner}/${repo}.git`;
    try {
        await run('git', ['init', '--quiet'], { cwd: tmpDir });
        await run('git', ['remote', 'add', 'origin', remote], { cwd: tmpDir });
        await run('git', ['fetch', '--depth', '1', '--quiet', 'origin', ref], { cwd: tmpDir, timeoutMs: 300_000 });
        await run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: tmpDir });
    } catch (err) {
        // Strip the token from any error text before it reaches a log or the caller.
        // Empty-string tokens must not hit replaceAll('') — that splices '***'
        // between every character of the message.
        const raw = String(err.message || err);
        const safe = token ? raw.replaceAll(token, '***') : raw;
        throw new Error(`codereview: git fetch failed for ${owner}/${repo}@${ref}: ${safe}`);
    }
}

/**
 * Materialize any supported source into data/codereview/snapshots/<hash16>/.
 * Returns { snapshotDir, treeHash, files, exclusions, sourceKind, sourceLabel }.
 */
export async function materializeSource(source, snapshotsRoot) {
    if (!source || typeof source !== 'string') throw new Error('codereview: source is required');
    await fsp.mkdir(snapshotsRoot, { recursive: true });
    const classified = classifySource(source);

    let stagingRoot = null;
    let cleanupStaging = null;
    let sourceKind;
    let sourceLabel;

    if (classified.kind === 'github') {
        sourceKind = 'github';
        sourceLabel = `${classified.owner}/${classified.repo}@${classified.ref}`;
        stagingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codereview-gh-'));
        cleanupStaging = () => fsp.rm(stagingRoot, { recursive: true, force: true });
        await fetchGitHubTree(classified.owner, classified.repo, classified.ref, stagingRoot);
    } else {
        const abs = path.resolve(classified.value);
        let stat;
        try {
            stat = await fsp.stat(abs);
        } catch {
            throw new Error(`codereview: source path does not exist: ${abs}`);
        }
        if (stat.isDirectory()) {
            sourceKind = 'directory';
            sourceLabel = abs;
            stagingRoot = abs;
        } else {
            const ext = path.extname(abs).toLowerCase();
            if (!['.zip', '.tar', '.gz', '.tgz'].includes(ext)) {
                throw new Error(`codereview: single-file sources and non-archive files are not supported (got '${ext || 'no extension'}). Point at a directory, a .zip/.tar.gz archive, or owner/repo@ref`);
            }
            sourceKind = 'archive';
            sourceLabel = abs;
            stagingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codereview-archive-'));
            cleanupStaging = () => fsp.rm(stagingRoot, { recursive: true, force: true });
            // Windows tar.exe (bsdtar) handles zip as well as tarballs.
            await run('tar', ['-xf', abs, '-C', stagingRoot], { timeoutMs: 300_000 });
        }
    }

    try {
        // Staging INSIDE the snapshots root: the final rename is then always
        // same-device, and a cross-device EXDEV cannot exist by construction.
        // (os.tmpdir may live on another drive — the first live review died on
        // exactly that; staging location eliminates the failure mode.)
        const stagingSnapshot = path.join(snapshotsRoot, `.staging-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
        try {
            const { copied, exclusions } = await copyTreeFiltered(stagingRoot, stagingSnapshot);
            if (copied.length === 0) {
                throw new Error(`codereview: snapshot is empty after exclusions (${exclusions.length} files excluded) — nothing to review`);
            }
            const { treeHash } = await hashTree(stagingSnapshot);
            const snapshotDir = path.join(snapshotsRoot, treeHash.slice(0, 16));
            if (fs.existsSync(snapshotDir)) {
                // Same tree content → same snapshot. Idempotent re-review of an unchanged tree.
                await fsp.rm(stagingSnapshot, { recursive: true, force: true });
            } else {
                await fsp.rename(stagingSnapshot, snapshotDir);
            }
            const meta = { sourceKind, sourceLabel, treeHash, createdAt: new Date().toISOString(), fileCount: copied.length, excludedCount: exclusions.length };
            await fsp.writeFile(path.join(snapshotDir, '_snapshot.json'), JSON.stringify(meta, null, 2));
            logger.info(`[codereview] snapshot ${treeHash.slice(0, 16)}: ${copied.length} files, ${exclusions.length} excluded (${sourceKind})`, null, 'CodeReview');
            return { snapshotDir, treeHash, files: copied, exclusions, ...meta };
        } catch (err) {
            await fsp.rm(stagingSnapshot, { recursive: true, force: true }).catch(() => {});
            throw err;
        }
    } finally {
        if (cleanupStaging) await cleanupStaging().catch(() => {});
    }
}
