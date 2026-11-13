// Rust tier-0 analysis: module/use edges, boundary-relevant error discard hunts.
// This is deliberately structural rather than a partial Rust parser. Candidates
// go to the orchestrator; no regex hit is promoted to a finding here.

function lineAt(source, index) {
    let line = 1;
    for (let i = 0; i < index && i < source.length; i++) {
        if (source.charCodeAt(i) === 10) line++;
    }
    return line;
}

function stripComments(source) {
    let out = '';
    let state = 'code';
    let blockDepth = 0;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        const next = source[i + 1];
        if (state === 'line') {
            if (ch === '\n') {
                state = 'code';
                out += ch;
            } else out += ' ';
            continue;
        }
        if (state === 'block') {
            if (ch === '/' && next === '*') {
                blockDepth++;
                out += '  ';
                i++;
            } else if (ch === '*' && next === '/') {
                blockDepth--;
                out += '  ';
                i++;
                if (blockDepth === 0) state = 'code';
            } else out += ch === '\n' ? '\n' : ' ';
            continue;
        }
        if (state === 'string') {
            out += ch === '\n' ? '\n' : ' ';
            if (ch === '\\') {
                if (next === '\n') out += '\n';
                else out += ' ';
                i++;
            } else if (ch === '"') state = 'code';
            continue;
        }
        if (ch === '/' && next === '/') {
            state = 'line';
            out += '  ';
            i++;
        } else if (ch === '/' && next === '*') {
            state = 'block';
            blockDepth = 1;
            out += '  ';
            i++;
        } else if (ch === '"') {
            state = 'string';
            out += ' ';
        } else out += ch;
    }
    return out;
}

function moduleBase(fromRel) {
    const dir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
    const name = fromRel.slice(fromRel.lastIndexOf('/') + 1);
    if (name === 'lib.rs' || name === 'main.rs' || name === 'mod.rs') return dir;
    return `${dir}/${name.slice(0, -3)}`.replace(/^\//, '');
}

function crateRoot(fromRel) {
    const parts = fromRel.split('/');
    const src = parts.lastIndexOf('src');
    return src === -1 ? '' : parts.slice(0, src + 1).join('/');
}

function existingModule(base, files) {
    const normalized = base.replace(/^\//, '').replace(/\/$/, '');
    for (const candidate of [`${normalized}.rs`, `${normalized}/mod.rs`]) {
        if (files.has(candidate)) return candidate;
    }
    return null;
}

function resolveMod(fromRel, name, files) {
    const base = moduleBase(fromRel);
    return existingModule(`${base}/${name}`, files);
}

function resolveUse(fromRel, specifier, files) {
    let segments = specifier.split('::').filter(Boolean);
    if (segments.length === 0) return null;
    let base;
    if (segments[0] === 'crate') {
        base = crateRoot(fromRel);
        segments = segments.slice(1);
    } else if (segments[0] === 'super' || segments[0] === 'self') {
        const parts = moduleBase(fromRel).split('/').filter(Boolean);
        while (segments[0] === 'super' || segments[0] === 'self') {
            if (segments.shift() === 'super') parts.pop();
        }
        base = parts.join('/');
    } else return null;

    // A use path usually names an item inside a module, not the module file:
    // crate::engine::Engine must resolve to src/engine.rs. Longest prefix wins.
    for (let length = segments.length; length > 0; length--) {
        const candidate = `${base}/${segments.slice(0, length).join('/')}`.replace(/^\//, '');
        const target = existingModule(candidate, files);
        if (target) return target;
    }
    return null;
}

function huntRust(code, original, rel) {
    const hunts = [];
    const lines = code.split('\n');
    const originalLines = original.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const snippet = originalLines[i]?.trim().slice(0, 140) ?? '';
        if (/\blet\s+_\s*=\s*.+/.test(line) || /\.\s*ok\s*\(\s*\)\s*;/.test(line)) {
            hunts.push({ kind: 'discarded-result', file: rel, line: i + 1, snippet });
        }
        if (/(?:std::env::var|env::var|config|cfg|settings)/.test(line) && /\.unwrap_or(?:_default|_else)?\s*\(/.test(line)) {
            hunts.push({ kind: 'default-mask', file: rel, line: i + 1, snippet });
        }
    }
    const emptyError = /\bErr\s*\([^)]*\)\s*=>\s*(?:\{\s*\}|\(\s*\))/g;
    for (let match; (match = emptyError.exec(code));) {
        hunts.push({
            kind: 'swallowed-error-branch',
            file: rel,
            line: lineAt(code, match.index),
            snippet: match[0].replace(/\s+/g, ' ').slice(0, 140)
        });
    }
    return hunts;
}

export function analyzeRust(rel, source, rustFiles) {
    const code = stripComments(source);
    const edges = new Set();
    const unresolved = [];
    const addEdge = (target, specifier, kind = 'unresolved-relative') => {
        if (target && target !== rel) edges.add(target);
        else if (!target) unresolved.push({ from: rel, specifier, kind });
    };

    const modRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
    for (let match; (match = modRe.exec(code));) {
        addEdge(resolveMod(rel, match[1], rustFiles), match[1]);
    }

    const useRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm;
    for (let match; (match = useRe.exec(code));) {
        const specifier = match[1].trim();
        const target = resolveUse(rel, specifier, rustFiles);
        if (target) edges.add(target);
        else if (!/^(?:crate|super|self)::/.test(specifier)) {
            unresolved.push({ from: rel, specifier: specifier.slice(0, 120), kind: 'bare' });
        } else {
            unresolved.push({ from: rel, specifier: specifier.slice(0, 120), kind: 'unresolved-relative' });
        }
    }

    const includeRe = /\binclude!\s*\(\s*"([^"]+)"\s*\)/g;
    for (let match; (match = includeRe.exec(code));) {
        const base = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        const target = `${base}/${match[1]}`.replace(/^\//, '').split('/').reduce((parts, part) => {
            if (part === '..') parts.pop();
            else if (part !== '.') parts.push(part);
            return parts;
        }, []).join('/');
        addEdge(rustFiles.has(target) ? target : null, match[1]);
    }

    return { edges: [...edges], unresolved, hunts: huntRust(code, source, rel) };
}
