// Text chunking for embeddings.
//
// Defaults are tuned for RAG: 1024-token chunks with 128-token overlap.
// This gives better retrieval granularity than the chat's whole-message
// embedding (30k tokens). Override via config if needed.

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_OVERLAP_TOKENS = 128;
const DEFAULT_TOK_CHARS_RATIO = 2.5;

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
