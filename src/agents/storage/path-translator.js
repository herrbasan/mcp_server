// UNC ↔ local path translation for the storage root.
//
// The storage root (config.json agents.storage.root) is the canonical local
// path the MCP server uses for storage operations. The same directory may also
// be reachable from other LAN machines via a UNC share (config.json
// agents.storage.uncShare). This module translates between the two forms so
// that callers (LLMs, other agents, LAN clients) can pass paths in either form
// without breaking.
//
// Translation is exact-prefix only:
//   - toLocal(p):   if p starts with uncShare, replace with root. Else return p.
//   - toUnc(p):     if p starts with root,     replace with uncShare. Else return p.
//
// Paths that don't match the configured share are passed through unchanged.
// A UNC path pointing at a different share (e.g. \\OTHER-PC\foo) is NOT
// translated — path.resolve will handle it (either via Windows SMB resolution
// or with a loud ENOENT/EACCES error). This keeps the translation surface
// narrow and auditable.

import path from 'path';

const UNC_RE = /^\\\\[^\\]+\\[^\\]+/;

export function createPathTranslator({ localRoot, uncShare }) {
    // Normalize: trailing separators and case (Windows is case-insensitive
    // but case-preserving — match the user's intent by lowercasing both sides
    // for comparison only, then returning the canonical-case form).
    const norm = (p) => p ? p.replace(/[\\/]+$/, '') : p;
    const local = norm(localRoot);
    const share = uncShare ? norm(uncShare) : null;

    // Drive-letter prefix on local root, e.g. "D:" — used to detect cases
    // where a caller passes just "D:\\foo" (relative to current drive).
    const localDrive = local ? local.match(/^([A-Za-z]:)/)?.[1] : null;

    const lc = (s) => s ? s.toLowerCase() : s;
    const startsWithCi = (haystack, needle) =>
        haystack && needle && lc(haystack).startsWith(lc(needle));

    const sep = (s) => s && (s.includes('\\') && !s.includes('/')) ? '\\' : path.sep;

    function toLocal(p) {
        if (typeof p !== 'string' || !p) return p;
        if (!share) return p;
        if (startsWithCi(p, share + '\\') || lc(p) === lc(share)) {
            const tail = p.slice(share.length);
            return local + tail;
        }
        // Also accept the bare drive form "D:\\..." that happens to be the
        // same directory — useful when the same machine is the share host.
        if (localDrive && new RegExp(`^${localDrive}\\\\`, 'i').test(p)) {
            return p;
        }
        return p;
    }

    function toUnc(p) {
        if (typeof p !== 'string' || !p) return p;
        if (!share) return p;
        if (startsWithCi(p, local + '\\') || lc(p) === lc(local)) {
            const tail = p.slice(local.length);
            return share + tail;
        }
        return p;
    }

    function isUnc(p) {
        return typeof p === 'string' && UNC_RE.test(p);
    }

    return { toLocal, toUnc, isUnc, localRoot: local, uncShare: share };
}

// Convenience: build from the storage agent config (config.json agents.storage).
// Returns null if no uncShare is configured — callers should fall back to
// pass-through behavior.
export function createTranslatorFromConfig(agentStorageConfig) {
    if (!agentStorageConfig?.root || !agentStorageConfig?.uncShare) return null;
    return createPathTranslator({
        localRoot: agentStorageConfig.root,
        uncShare: agentStorageConfig.uncShare
    });
}