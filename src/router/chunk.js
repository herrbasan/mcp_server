import { estimateTokens } from './tokenize.js';

export function chunkText(text, maxTokensPerChunk) {
  if (!text || text.length === 0) {
    return { chunks: [], tokenCounts: [], totalChunks: 0 };
  }

  if (maxTokensPerChunk <= 0) {
    throw new Error('maxTokensPerChunk must be positive');
  }

  const charsPerChunk = maxTokensPerChunk * 3;
  const numChunks = Math.ceil(text.length / charsPerChunk);
  
  const chunks = [];
  const tokenCounts = [];

  for (let i = 0; i < numChunks; i++) {
    const start = i * charsPerChunk;
    const end = Math.min(start + charsPerChunk, text.length);
    const chunk = text.slice(start, end);
    
    chunks.push(chunk);
    tokenCounts.push(estimateTokens(chunk).tokens);
  }

  return { chunks, tokenCounts, totalChunks: numChunks };
}

export function calculateChunkSize(contextWindow, systemPromptTokens, outputBufferTokens) {
  if (contextWindow <= 0) {
    throw new Error('contextWindow must be positive');
  }

  const overhead = systemPromptTokens + outputBufferTokens;
  
  if (overhead >= contextWindow) {
    throw new Error(`Overhead (${overhead}) exceeds context window (${contextWindow})`);
  }

  return contextWindow - overhead;
}

export function checkFits(text, availableTokens) {
  const textTokens = estimateTokens(text).tokens;
  const fits = textTokens <= availableTokens;
  const overflow = fits ? 0 : textTokens - availableTokens;

  return { fits, textTokens, available: availableTokens, overflow };
}
