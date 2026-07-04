// Text chunking for embeddings.
//
// Defaults are tuned for RAG: 1024-token chunks with 128-token overlap.
// This gives better retrieval granularity than the chat's whole-message
// embedding (30k tokens). Override via config if needed.
//
// Also exports isGarbageChunk() — a content-quality gate that rejects
// non-text files, hex dumps, and low-entropy filler before they pollute
// the vector index.

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_OVERLAP_TOKENS = 128;
const DEFAULT_TOK_CHARS_RATIO = 2.5;

// ── Garbage detection ─────────────────────────────────────────────────
//
// Returns { ok: true } if the text is worth embedding, or
// { ok: false, reason } if it should be rejected.
//
// Catches the three garbage types observed in production:
//   1. Filler files (e.g. bench-64kb.txt = 64KB of 'a')
//   2. Hex dumps from binary conversions (long runs of [0-9a-f]{2})
//   3. Binary content that slipped through the extension filter

const PRINTABLE_ASCII = /^[\x09\x0A\x0D\x20-\x7E]+$/;
const HEX_RUN = /[0-9a-f]{8,}/gi;

export function isGarbageChunk(text, options = {}) {
    if (!text || typeof text !== 'string') {
        return { ok: false, reason: 'empty or non-string' };
    }

    const minLen = options.minChunkChars ?? 32;
    if (text.length < minLen) {
        return { ok: false, reason: `too short (${text.length} < ${minLen} chars)` };
    }

    // 1. Binary / non-printable content.
    // Allow a small percentage of replacement chars (encoding artifacts) but
    // reject anything with control bytes or null bytes.
    const sample = text.length > 4096 ? text.slice(0, 4096) : text;
    if (!PRINTABLE_ASCII.test(sample.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ''))) {
        // The sample had non-printable bytes that got stripped — check ratio.
        const stripped = sample.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
        if (stripped.length < sample.length * 0.85) {
            return { ok: false, reason: 'binary content (>15% non-printable)' };
        }
    }

    // 2. Low entropy: single character dominates.
    // Catches 'aaaa...' filler. A real text chunk never has one char > 50%.
    const charCounts = new Map();
    for (const ch of sample) {
        charCounts.set(ch, (charCounts.get(ch) || 0) + 1);
    }
    let maxCharCount = 0;
    let maxChar = '';
    for (const [ch, count] of charCounts) {
        if (count > maxCharCount) { maxCharCount = count; maxChar = ch; }
    }
    if (maxCharCount / sample.length > 0.5 && maxChar !== ' ' && maxChar !== '\n') {
        return { ok: false, reason: `low entropy ('${maxChar}' = ${(maxCharCount / sample.length * 100).toFixed(0)}%)` };
    }

    // 3. Hex dump detection.
    // Binary conversions produce long unbroken runs of hex pairs.
    // A real markdown/text file rarely has >30% of its length in hex runs.
    const hexMatches = sample.match(HEX_RUN) || [];
    const hexTotal = hexMatches.reduce((s, m) => s + m.length, 0);
    if (hexTotal / sample.length > 0.30) {
        return { ok: false, reason: `hex dump (${(hexTotal / sample.length * 100).toFixed(0)}% hex runs)` };
    }

    return { ok: true };
}

// Check whether an entire file is worth indexing. Reads the content once
// and applies isGarbageChunk to a representative sample. Used at the file
// level (before chunking) to skip pure-garbage files entirely.
export function isGarbageFile(content, options = {}) {
    if (!content || typeof content !== 'string') {
        return { ok: false, reason: 'empty or non-string content' };
    }
    // Sample the first 4KB — enough to catch filler/hex/binary without
    // scanning a 10MB file.
    const sample = content.length > 4096 ? content.slice(0, 4096) : content;
    return isGarbageChunk(sample, options);
}

export function makeChunker(options = {}) {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    const tokRatio = options.tokCharsRatio ?? DEFAULT_TOK_CHARS_RATIO;
    const maxChars = Math.floor(maxTokens * tokRatio);
    const overlapChars = Math.floor(overlapTokens * tokRatio);

    return function chunkText(text) {
        if (!text || typeof text !== 'string') return [];
        if (text.length <= maxChars) return [{ text, splitIdx: 0, charOffset: 0, isLastChunk: true }];

        const chunks = [];
        let charOffset = 0;
        let splitIdx = 0;

        while (charOffset < text.length) {
            const end = Math.min(charOffset + maxChars, text.length);
            const chunkText = text.slice(charOffset, end);
            const chunkTokEst = Math.ceil(chunkText.length / tokRatio);

            chunks.push({
                text: chunkText,
                tokEst: chunkTokEst,
                splitIdx: splitIdx++,
                charOffset,
                isLastChunk: end === text.length
            });

            if (end === text.length) break;
            charOffset += maxChars - overlapChars;
            if (charOffset >= end) charOffset = end; // safety: prevent infinite loop
        }

        return chunks;
    };
}

export function estimateTokens(text, tokCharsRatio = DEFAULT_TOK_CHARS_RATIO) {
    return Math.ceil(text.length / tokCharsRatio);
}
