// ============================================
// fileops — confined, versioned file operations
// ============================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { createPathTranslator } from '../agents/storage/path-translator.js';

const SKIP_DIRS = new Set(['.versions', 'node_modules', '.git']);
const VERSIONS_DIR = '.versions';
const GREP_MAX_FILE_BYTES = 50 * 1024 * 1024;
const TAIL_CHUNK = 64 * 1024;

let tmpCounter = 0;

// ============================================
// Glob → RegExp
// ============================================

function globToRegExp(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                i++;
                out += '[\\s\\S]*';
            } else {
                out += '[^/]*';
            }
        } else if (c === '?') {
            out += '[^/]';
        } else if ('\\^$.+(){}|[]'.includes(c)) {
            out += '\\' + c;
        } else {
            out += c;
        }
    }
    return new RegExp('^' + out + '$');
}

// ============================================
// Factory
// ============================================

export function createFileOps({ root, translator = null, keepVersions = 10 }) {
    if (!root) throw new Error('createFileOps: root required');
    if (typeof root !== 'string') throw new Error('createFileOps: root must be a string');
    if (typeof keepVersions !== 'number' || keepVersions < 1) {
        throw new Error('createFileOps: keepVersions must be a positive number');
    }

    fs.mkdirSync(root, { recursive: true });
    const REAL_ROOT = fs.realpathSync(root);
    const SEP = path.sep;

    // ============================================
    // Internal: resolve (confinement)
    // ============================================

    function resolve(userPath) {
        if (typeof userPath !== 'string') {
            throw new Error('resolve: userPath must be a string');
        }
        let p = userPath;
        if (translator) p = translator.toLocal(p);

        const resolved = path.isAbsolute(p) ? p : path.resolve(root, p);

        // Walk up to nearest existing ancestor, collect tail segments.
        const tail = [];
        let ancestor = resolved;
        while (tail.length < 256) {
            try {
                const real = fs.realpathSync(ancestor);
                const rejoined = tail.length === 0 ? real : path.join(real, ...tail);
                if (rejoined !== REAL_ROOT &&
                    rejoined !== REAL_ROOT + SEP &&
                    !rejoined.startsWith(REAL_ROOT + SEP)) {
                    throw new Error('Path escapes root: ' + userPath);
                }
                return rejoined;
            } catch (e) {
                if (e.message.startsWith('Path escapes root')) throw e;
                // ENOENT or EINVAL (broken symlink) — go up one level
                tail.unshift(path.basename(ancestor));
                ancestor = path.dirname(ancestor);
                if (ancestor === path.dirname(ancestor)) {
                    // reached filesystem root without finding existing dir
                    throw new Error('resolve: cannot find existing ancestor for ' + userPath);
                }
            }
        }
        throw new Error('resolve: path too deep: ' + userPath);
    }

    function rel(absPath) {
        let r = path.relative(REAL_ROOT, absPath);
        if (SEP !== '/') r = r.split(SEP).join('/');
        return r;
    }

    // ============================================
    // Internal: atomicWrite
    // ============================================

    function atomicWrite(targetAbs, buffer) {
        const dir = path.dirname(targetAbs);
        fs.mkdirSync(dir, { recursive: true });
        tmpCounter++;
        const tmp = path.join(dir, `.fileops-tmp-${process.pid}-${tmpCounter}`);
        fs.writeFileSync(tmp, buffer);
        fs.renameSync(tmp, targetAbs);
    }

    // ============================================
    // Internal: versioning
    // ============================================

    function versionStamp() {
        return new Date().toISOString().replace(/[:.]/g, '-');
    }

    function versionDirFor(targetRel) {
        const vdir = path.join(REAL_ROOT, VERSIONS_DIR, targetRel);
        if (vdir !== REAL_ROOT && !vdir.startsWith(REAL_ROOT + SEP)) {
            throw new Error('versionDirFor: escapes root: ' + targetRel);
        }
        return vdir;
    }

    function snapshot(targetRel, op) {
        const liveAbs = path.join(REAL_ROOT, ...targetRel.split('/'));
        if (!fs.existsSync(liveAbs)) return;
        const stat = fs.statSync(liveAbs);
        if (!stat.isFile()) return;

        const vdir = versionDirFor(targetRel);
        fs.mkdirSync(vdir, { recursive: true });
        const stamp = versionStamp();
        const versionPath = path.join(vdir, `${stamp}_${op}`);
        try {
            fs.linkSync(liveAbs, versionPath);
        } catch (e) {
            if (e.code === 'EXDEV') {
                console.warn(`[fileops] snapshot: cross-device link, falling back to copy for ${targetRel}`);
                fs.copyFileSync(liveAbs, versionPath);
            } else if (e.code === 'EEXIST') {
                // stamp collision (same ms) — append a suffix
                fs.linkSync(liveAbs, versionPath + '_' + process.hrtime.bigint());
            } else {
                throw e;
            }
        }

        // Prune
        const entries = fs.readdirSync(vdir).sort();
        while (entries.length > keepVersions) {
            const oldest = entries.shift();
            fs.unlinkSync(path.join(vdir, oldest));
            entries.splice(entries.indexOf(oldest), 1);
        }
    }

    function snapshotByAbs(targetAbs, op) {
        const targetRel = rel(targetAbs);
        snapshot(targetRel, op);
    }

    // ============================================
    // Internal: iterative directory walk
    // ============================================

    function walkDir(startAbs) {
        const results = [];
        const stack = [startAbs];
        while (stack.length) {
            const cur = stack.pop();
            let entries;
            try {
                entries = fs.readdirSync(cur, { withFileTypes: true });
            } catch (e) {
                continue;
            }
            for (const ent of entries) {
                if (SKIP_DIRS.has(ent.name)) continue;
                const full = path.join(cur, ent.name);
                if (ent.isDirectory()) {
                    stack.push(full);
                } else if (ent.isFile()) {
                    results.push(full);
                }
            }
        }
        return results;
    }

    // ============================================
    // Public: stat
    // ============================================

    async function stat(userPath) {
        const abs = resolve(userPath);
        if (!fs.existsSync(abs)) return { exists: false };
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
            return { exists: true, type: 'dir', size: st.size, modified: st.mtime };
        }
        return { exists: true, type: 'file', size: st.size, modified: st.mtime };
    }

    // ============================================
    // Public: read
    // ============================================

    async function read(userPath, { encoding = 'utf8' } = {}) {
        if (encoding !== 'utf8' && encoding !== 'base64') {
            throw new Error('read: encoding must be utf8 or base64');
        }
        const abs = resolve(userPath);
        const st = fs.statSync(abs);
        if (st.isDirectory()) throw new Error('read: cannot read a directory: ' + userPath);
        const content = fs.readFileSync(abs, encoding);
        return { content, size: st.size };
    }

    // ============================================
    // Public: write
    // ============================================

    async function write(userPath, content, { encoding = 'utf8', overwrite = false } = {}) {
        if (encoding !== 'utf8' && encoding !== 'base64') {
            throw new Error('write: encoding must be utf8 or base64');
        }
        const abs = resolve(userPath);
        if (fs.existsSync(abs) && !overwrite) {
            throw new Error('write: target exists, pass overwrite:true');
        }
        const targetRel = rel(abs);
        snapshot(targetRel, 'write');
        const buf = Buffer.from(content, encoding);
        atomicWrite(abs, buf);
        return { size: buf.length };
    }

    // ============================================
    // Public: list
    // ============================================

    async function list(userPath = '', { recursive = false, pattern = null } = {}) {
        const abs = resolve(userPath);
        const matcher = pattern ? globToRegExp(pattern) : null;
        const entries = [];

        if (!fs.existsSync(abs)) return { entries: [] };

        const stack = [abs];
        while (stack.length) {
            const cur = stack.pop();
            let dirEntries;
            try {
                dirEntries = fs.readdirSync(cur, { withFileTypes: true });
            } catch (e) {
                continue;
            }
            for (const ent of dirEntries) {
                if (SKIP_DIRS.has(ent.name)) continue;
                const full = path.join(cur, ent.name);
                const entRel = rel(full);
                const type = ent.isDirectory() ? 'dir' : 'file';
                if (type === 'dir' && recursive) {
                    stack.push(full);
                }
                if (matcher && !matcher.test(entRel)) continue;
                let st;
                try { st = fs.statSync(full); } catch (e) { continue; }
                entries.push({
                    name: ent.name,
                    type,
                    size: st.size,
                    modified: st.mtime,
                    path: entRel
                });
            }
        }
        return { entries };
    }

    // ============================================
    // Public: move
    // ============================================

    async function move(fromPath, toPath) {
        const fromAbs = resolve(fromPath);
        const toAbs = resolve(toPath);
        if (!fs.existsSync(fromAbs)) throw new Error('move: source does not exist: ' + fromPath);
        if (fs.existsSync(toAbs)) throw new Error('move: destination exists: ' + toPath);
        const fromRel = rel(fromAbs);
        snapshot(fromRel, 'move');
        fs.mkdirSync(path.dirname(toAbs), { recursive: true });
        fs.renameSync(fromAbs, toAbs);
        const type = fs.statSync(toAbs).isDirectory() ? 'dir' : 'file';
        return { from: fromRel, to: rel(toAbs), type };
    }

    // ============================================
    // Public: remove
    // ============================================

    async function remove(userPath, { recursive = false } = {}) {
        const abs = resolve(userPath);
        if (!fs.existsSync(abs)) throw new Error('remove: path does not exist: ' + userPath);
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
            const contents = fs.readdirSync(abs);
            if (contents.length > 0 && !recursive) {
                throw new Error('remove: directory not empty, pass recursive:true');
            }
            snapshotByAbs(abs, 'remove');
            fs.rmSync(abs, { recursive: true });
        } else {
            snapshotByAbs(abs, 'remove');
            fs.unlinkSync(abs);
        }
        return { deleted: true };
    }

    // ============================================
    // Public: copy
    // ============================================

    async function copy(fromPath, toPath, { overwrite = false } = {}) {
        const fromAbs = resolve(fromPath);
        const toAbs = resolve(toPath);
        if (!fs.existsSync(fromAbs)) throw new Error('copy: source does not exist: ' + fromPath);
        if (fs.existsSync(toAbs) && !overwrite) {
            throw new Error('copy: target exists, pass overwrite:true');
        }
        const st = fs.statSync(fromAbs);
        if (fs.existsSync(toAbs) && overwrite) {
            snapshotByAbs(toAbs, 'copy');
        }
        fs.mkdirSync(path.dirname(toAbs), { recursive: true });
        if (st.isDirectory()) {
            fs.cpSync(fromAbs, toAbs, { recursive: true });
        } else {
            fs.copyFileSync(fromAbs, toAbs);
        }
        const finalStat = fs.statSync(toAbs);
        return { from: rel(fromAbs), to: rel(toAbs), size: finalStat.size };
    }

    // ============================================
    // Public: append
    // ============================================

    async function append(userPath, content, { encoding = 'utf8' } = {}) {
        if (encoding !== 'utf8' && encoding !== 'base64') {
            throw new Error('append: encoding must be utf8 or base64');
        }
        const abs = resolve(userPath);
        const targetRel = rel(abs);
        snapshot(targetRel, 'append');

        if (fs.existsSync(abs)) {
            const st = fs.statSync(abs);
            if (st.nlink > 1) {
                // Break sharing: copy live → temp → rename, then append
                const existing = fs.readFileSync(abs);
                atomicWrite(abs, existing);
            }
        }
        const buf = Buffer.from(content, encoding);
        const fd = fs.openSync(abs, 'a');
        fs.writeSync(fd, buf);
        fs.closeSync(fd);
        return { size: fs.statSync(abs).size };
    }

    // ============================================
    // Public: replace
    // ============================================

    // Server-side marker swap: read file, replace occurrence(s) of marker
    // with replacement, write back via snapshot + atomicWrite. This is the
    // large-file edit path — content never leaves the server.
    // occurrence: 'first' (default) | 'last' | 'all'.
    // Throws when marker is absent (fail loud — the caller's mental model
    // of the file is wrong, silently no-op'ing would hide that).
    async function replace(userPath, marker, replacement, { occurrence = 'first' } = {}) {
        if (typeof marker !== 'string' || marker.length === 0) {
            throw new Error('replace: marker must be a non-empty string');
        }
        if (typeof replacement !== 'string') {
            throw new Error('replace: replacement must be a string');
        }
        if (occurrence !== 'first' && occurrence !== 'last' && occurrence !== 'all') {
            throw new Error('replace: occurrence must be first, last, or all');
        }
        const abs = resolve(userPath);
        if (!fs.existsSync(abs)) throw new Error('replace: path does not exist: ' + userPath);
        const st = fs.statSync(abs);
        if (st.isDirectory()) throw new Error('replace: cannot replace in a directory: ' + userPath);

        const original = fs.readFileSync(abs, 'utf8');
        let updated;
        let count = 0;

        if (occurrence === 'all') {
            // Count first so a zero-match fails the same way as first/last
            const parts = original.split(marker);
            count = parts.length - 1;
            if (count === 0) throw new Error('replace: marker not found in ' + userPath);
            updated = parts.join(replacement);
        } else if (occurrence === 'last') {
            const idx = original.lastIndexOf(marker);
            if (idx === -1) throw new Error('replace: marker not found in ' + userPath);
            updated = original.slice(0, idx) + replacement + original.slice(idx + marker.length);
            count = 1;
        } else {
            const idx = original.indexOf(marker);
            if (idx === -1) throw new Error('replace: marker not found in ' + userPath);
            updated = original.slice(0, idx) + replacement + original.slice(idx + marker.length);
            count = 1;
        }

        if (updated === original) {
            throw new Error('replace: replacement is identical to marker — no change');
        }

        const targetRel = rel(abs);
        snapshot(targetRel, 'replace');
        atomicWrite(abs, Buffer.from(updated, 'utf8'));
        return { size: Buffer.byteLength(updated, 'utf8'), replacements: count };
    }

    // ============================================
    // Public: readWindow
    // ============================================

    async function readWindow(userPath, opts = {}) {
        const abs = resolve(userPath);
        if (!fs.existsSync(abs)) throw new Error('readWindow: path does not exist: ' + userPath);
        const st = fs.statSync(abs);
        if (st.isDirectory()) throw new Error('readWindow: cannot window a directory');

        const hasOffset = opts.offset !== undefined && opts.length !== undefined;
        const hasHead = opts.head !== undefined;
        const hasTail = opts.tail !== undefined;
        const modeCount = [hasOffset, hasHead, hasTail].filter(Boolean).length;
        if (modeCount === 0) throw new Error('readWindow: must specify offset/length, head, or tail');
        if (modeCount > 1) throw new Error('readWindow: specify exactly one mode');

        if (hasOffset) {
            const { offset, length } = opts;
            if (typeof offset !== 'number' || typeof length !== 'number') {
                throw new Error('readWindow: offset and length must be numbers');
            }
            const fd = await fs.promises.open(abs, 'r');
            const buf = Buffer.alloc(length);
            const { bytesRead } = await fd.read(buf, 0, length, offset);
            await fd.close();
            return {
                content: buf.slice(0, bytesRead).toString('utf8'),
                size: st.size,
                window: { offset, length, bytesRead }
            };
        }

        if (hasHead) {
            const n = opts.head;
            if (typeof n !== 'number' || n < 0) throw new Error('readWindow: head must be a non-negative number');
            const rl = readline.createInterface({
                input: fs.createReadStream(abs),
                crlfDelay: Infinity
            });
            const lines = [];
            for await (const line of rl) {
                lines.push(line);
                if (lines.length >= n) break;
            }
            return { content: lines.join('\n'), size: st.size, window: { head: n } };
        }

        // tail
        const n = opts.tail;
        if (typeof n !== 'number' || n < 0) throw new Error('readWindow: tail must be a non-negative number');

        const fd = await fs.promises.open(abs, 'r');
        const fileSize = (await fd.stat()).size;
        const chunks = [];
        let pos = fileSize;
        let lineCount = 0;
        let trailing = '';

        while (pos > 0 && lineCount <= n) {
            const readSize = Math.min(TAIL_CHUNK, pos);
            pos -= readSize;
            const buf = Buffer.alloc(readSize);
            await fd.read(buf, 0, readSize, pos);
            const text = buf.toString('utf8') + trailing;
            const parts = text.split('\n');
            trailing = parts[0];
            for (let i = parts.length - 1; i >= 1; i--) {
                chunks.unshift(parts[i]);
                lineCount++;
                if (lineCount >= n) break;
            }
            if (lineCount >= n) break;
        }
        await fd.close();

        if (pos === 0 && trailing) {
            chunks.unshift(trailing);
        }
        const result = chunks.slice(-n);
        return { content: result.join('\n'), size: st.size, window: { tail: n } };
    }

    // ============================================
    // Public: grep
    // ============================================

    async function grep(userPath, pattern, { maxMatches = 100, context = 0, ignoreCase = false } = {}) {
        if (typeof pattern !== 'string') throw new Error('grep: pattern must be a string');
        const testRegex = new RegExp(pattern, ignoreCase ? 'i' : '');
        const abs = resolve(userPath);
        if (!fs.existsSync(abs)) throw new Error('grep: path does not exist: ' + userPath);

        const files = [];
        const st = fs.statSync(abs);
        if (st.isFile()) {
            files.push(abs);
        } else if (st.isDirectory()) {
            files.push(...walkDir(abs));
        }

        const matches = [];
        let truncated = false;

        fileLoop:
        for (const file of files) {
            let fst;
            try { fst = fs.statSync(file); } catch (e) { continue; }
            if (fst.size > GREP_MAX_FILE_BYTES) {
                console.warn(`[fileops] grep: skipping ${fst.size} byte file ${rel(file)}`);
                continue;
            }

            const rl = readline.createInterface({
                input: fs.createReadStream(file),
                crlfDelay: Infinity
            });

            const beforeBuffer = [];
            let lineNum = 0;
            let pendingMatch = null;
            let pendingAfter = 0;

            for await (const line of rl) {
                lineNum++;
                if (pendingAfter > 0 && pendingMatch) {
                    pendingMatch.after.push(line);
                    pendingAfter--;
                    if (pendingAfter === 0) {
                        pendingMatch = null;
                        if (matches.length >= maxMatches) {
                            truncated = true;
                            break fileLoop;
                        }
                    }
                }
                if (testRegex.test(line)) {
                    const match = {
                        path: rel(file),
                        line: lineNum,
                        text: line
                    };
                    if (context > 0) {
                        match.before = [...beforeBuffer];
                        match.after = [];
                        pendingMatch = match;
                        pendingAfter = context;
                    }
                    matches.push(match);
                    if (context === 0 && matches.length >= maxMatches) {
                        truncated = true;
                        break fileLoop;
                    }
                }
                if (context > 0) {
                    beforeBuffer.push(line);
                    if (beforeBuffer.length > context) beforeBuffer.shift();
                }
            }
            rl.close();
            // If a match's after-context ran past EOF, it stays as-is.
            if (matches.length >= maxMatches) {
                truncated = true;
                break fileLoop;
            }
        }

        return { matches, truncated };
    }

    // ============================================
    // Public: batch
    // ============================================

    // pickOpts: build an options object from a batch item, including only the
    // named keys that are present. Returns undefined when nothing matched so
    // the callee's default options kick in.
    function pickOpts(item, keys) {
        const out = {};
        let found = false;
        for (const k of keys) {
            if (item[k] !== undefined) { out[k] = item[k]; found = true; }
        }
        return found ? out : undefined;
    }

    function reqContent(item) {
        if (item.content === undefined || item.content === null) {
            throw new Error('batch: op requires content');
        }
        return item.content;
    }

    async function batch(opsList, { onError = 'collect' } = {}) {
        if (!Array.isArray(opsList)) throw new Error('batch: opsList must be an array');
        if (onError !== 'collect' && onError !== 'abort') {
            throw new Error('batch: onError must be collect or abort');
        }
        const results = [];
        // Each entry maps an op name to a function taking the batch item object.
        // Args are routed by NAME, never by position — a batch item is a bag of
        // named fields, and spreading them positionally breaks any op whose
        // options object isn't the last field in the item.
        const knownOps = {
            stat:         (a) => stat(a.path),
            read:         (a) => read(a.path, pickOpts(a, ['encoding'])),
            write:        (a) => write(a.path, reqContent(a), pickOpts(a, ['encoding', 'overwrite'])),
            list:         (a) => list(a.path, pickOpts(a, ['recursive', 'pattern'])),
            move:         (a) => move(a.from, a.to),
            remove:       (a) => remove(a.path, pickOpts(a, ['recursive'])),
            copy:         (a) => copy(a.from, a.to, pickOpts(a, ['overwrite'])),
            append:       (a) => append(a.path, reqContent(a), pickOpts(a, ['encoding'])),
            replace:      (a) => replace(a.path, a.marker, a.replacement, pickOpts(a, ['occurrence'])),
            readWindow:   (a) => readWindow(a.path, pickOpts(a, ['offset', 'length', 'head', 'tail'])),
            grep:         (a) => grep(a.path, a.pattern, pickOpts(a, ['maxMatches', 'context', 'ignoreCase'])),
            hash:         (a) => hash(a.path, pickOpts(a, ['algo'])),
            snapshotDir:  (a) => snapshotDir(a.path),
            writeFromUrl: (a) => writeFromUrl(a.path, a.url, pickOpts(a, ['allowedPrefixes', 'overwrite']))
        };

        for (const item of opsList) {
            const { op } = item;
            if (!op || typeof knownOps[op] !== 'function') {
                results.push({ op: op || '(missing)', ok: false, error: `batch: unknown op "${op}"` });
                if (onError === 'abort') break;
                continue;
            }
            try {
                const returnValue = await knownOps[op](item);
                results.push({ op, ok: true, ...returnValue });
            } catch (e) {
                results.push({ op, ok: false, error: e.message });
                if (onError === 'abort') break;
            }
        }
        return { results };
    }

    // ============================================
    // Public: writeFromUrl
    // ============================================

    async function writeFromUrl(userPath, url, { allowedPrefixes = [], overwrite = false } = {}) {
        if (typeof url !== 'string') throw new Error('writeFromUrl: url must be a string');
        if (!Array.isArray(allowedPrefixes) || allowedPrefixes.length === 0) {
            throw new Error('writeFromUrl: no allowedPrefixes configured');
        }
        const ok = allowedPrefixes.some((p) => url.startsWith(p));
        if (!ok) throw new Error('writeFromUrl: url not in allowedPrefixes');

        const abs = resolve(userPath);
        if (fs.existsSync(abs) && !overwrite) {
            throw new Error('writeFromUrl: target exists, pass overwrite:true');
        }
        const targetRel = rel(abs);
        snapshot(targetRel, 'writeFromUrl');

        const res = await fetch(url);
        if (!res.ok) throw new Error(`writeFromUrl: fetch failed ${res.status} ${res.statusText}`);

        const mime = res.headers.get('content-type') || 'application/octet-stream';
        const buf = Buffer.from(await res.arrayBuffer());
        atomicWrite(abs, buf);
        return { size: buf.length, mime };
    }

    // ============================================
    // Public: hash
    // ============================================

    async function hash(userPath, { algo = 'sha256' } = {}) {
        const abs = resolve(userPath);
        if (!fs.existsSync(abs)) throw new Error('hash: path does not exist: ' + userPath);
        const st = fs.statSync(abs);
        if (st.isDirectory()) throw new Error('hash: cannot hash a directory');
        return new Promise((resolveP, rejectP) => {
            const h = crypto.createHash(algo);
            const stream = fs.createReadStream(abs);
            stream.on('data', (chunk) => h.update(chunk));
            stream.on('end', () => resolveP({ hash: h.digest('hex'), size: st.size }));
            stream.on('error', rejectP);
        });
    }

    // ============================================
    // Public: snapshotDir / diffSnapshots
    // ============================================

    async function snapshotDir(userPath) {
        const abs = resolve(userPath);
        if (!fs.existsSync(abs)) throw new Error('snapshotDir: path does not exist: ' + userPath);
        const files = walkDir(abs);
        const manifest = {};
        for (const f of files) {
            const st = fs.statSync(f);
            manifest[rel(f)] = { size: st.size, mtimeMs: st.mtimeMs };
        }
        return { files: manifest };
    }

    function diffSnapshots(before, after) {
        const beforeFiles = before?.files || {};
        const afterFiles = after?.files || {};
        const added = [];
        const removed = [];
        const modified = [];

        for (const key of Object.keys(afterFiles)) {
            if (!beforeFiles[key]) {
                added.push(key);
            } else if (beforeFiles[key].size !== afterFiles[key].size ||
                       beforeFiles[key].mtimeMs !== afterFiles[key].mtimeMs) {
                modified.push(key);
            }
        }
        for (const key of Object.keys(beforeFiles)) {
            if (!afterFiles[key]) removed.push(key);
        }
        return { added, removed, modified };
    }

    // ============================================
    // Public: history / restore
    // ============================================

    async function history(userPath) {
        const abs = resolve(userPath);
        const targetRel = rel(abs);
        const vdir = versionDirFor(targetRel);
        if (!fs.existsSync(vdir)) return { versions: [] };
        const entries = fs.readdirSync(vdir).sort().reverse();
        const versions = entries.map((name, i) => {
            const st = fs.statSync(path.join(vdir, name));
            const op = name.indexOf('_') >= 0 ? name.slice(name.indexOf('_') + 1) : name;
            return { version: i + 1, op, size: st.size, modified: st.mtime };
        });
        return { versions };
    }

    async function restore(userPath, { steps = 1 } = {}) {
        if (typeof steps !== 'number' || steps < 1) {
            throw new Error('restore: steps must be a positive number');
        }
        const abs = resolve(userPath);
        const targetRel = rel(abs);
        const vdir = versionDirFor(targetRel);
        if (!fs.existsSync(vdir)) throw new Error('restore: no versions for ' + userPath);
        const entries = fs.readdirSync(vdir).sort().reverse();
        if (steps > entries.length) {
            throw new Error(`restore: only ${entries.length} versions, requested ${steps}`);
        }
        // Snapshot current state first
        snapshot(targetRel, 'restore');

        const chosen = entries[steps - 1];
        const chosenAbs = path.join(vdir, chosen);
        const buf = fs.readFileSync(chosenAbs);
        atomicWrite(abs, buf);
        return { restored: true, from: chosen };
    }

    // ============================================
    // Assemble frozen API
    // ============================================

    return Object.freeze({
        stat,
        read,
        write,
        list,
        move,
        remove,
        copy,
        append,
        replace,
        readWindow,
        grep,
        batch,
        writeFromUrl,
        hash,
        snapshotDir,
        diffSnapshots,
        history,
        restore
    });
}
