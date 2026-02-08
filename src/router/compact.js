import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { estimateTokens } from './tokenize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPACTION_PROMPT = readFileSync(join(__dirname, '..', '..', 'prompts', 'context_compaction.txt'), 'utf-8');

export async function compactChunk(chunk, previousSummary, endpoint, modelName, targetTokens) {
  const input = previousSummary 
    ? `${previousSummary}\n\n---NEW CONTENT---\n\n${chunk}`
    : chunk;
  
  const systemPrompt = buildCompactionPrompt(targetTokens);
  
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input }
      ],
      temperature: 0.3,
      max_tokens: targetTokens * 2
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LLM compaction failed: ${response.status} ${error}`);
  }
  
  const data = await response.json();
  const summary = data.choices[0].message.content.trim();
  const tokens = estimateTokens(summary).tokens;
  
  const inputTokens = estimateTokens(input).tokens;
  if (tokens >= inputTokens) {
    console.error('\n=== COMPACTION FAILURE ===');
    console.error('Input tokens:', inputTokens);
    console.error('Output tokens:', tokens);
    console.error('First 500 chars:', summary.substring(0, 500));
    console.error('Last 500 chars:', summary.substring(summary.length - 500));
    console.error('=========================\n');
    throw new Error(`Compaction failed: output ${tokens} >= input ${inputTokens} tokens`);
  }
  
  return { summary, tokens };
}

function buildCompactionPrompt(targetTokens) {
  return COMPACTION_PROMPT
    .replace('TARGET_TOKENS', targetTokens)
    .replace('TARGET_CHARS', Math.floor(targetTokens * 3));
}

export async function rollingCompact(chunks, endpoint, modelName, targetTokensPerChunk, onProgress = null) {
  const summaries = [];
  let previousSummary = null;
  
  for (let i = 0; i < chunks.length; i++) {
    const { summary, tokens } = await compactChunk(
      chunks[i],
      previousSummary,
      endpoint,
      modelName,
      targetTokensPerChunk
    );
    
    summaries.push(summary);
    previousSummary = summary;
    
    if (onProgress) {
      onProgress(i + 1, chunks.length, summary);
    }
  }
  
  const finalTokens = summaries.reduce((sum, s) => sum + estimateTokens(s).tokens, 0);
  
  return { summaries, finalTokens };
}
