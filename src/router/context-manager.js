import { estimateTokens } from './tokenize.js';
import { chunkText, checkFits as checkFitsRaw } from './chunk.js';
import { rollingCompact } from './compact.js';

export function createContextManager(config) {
  const { httpEndpoint, model, maxTokens = 1000, temperature = 0.3 } = config;
  
  let liveContextWindow = config.contextWindow;
  
  return {
    get contextWindow() { return liveContextWindow; },
    set contextWindow(value) { liveContextWindow = value; },
    
    estimateTokens(text) {
      return estimateTokens(text).tokens;
    },
    
    checkFits(text, availableTokens) {
      return checkFitsRaw(text, availableTokens).fits;
    },
    
    calculateAvailableTokens(systemPrompt, outputTokens) {
      const systemTokens = systemPrompt ? estimateTokens(systemPrompt).tokens : 0;
      const available = liveContextWindow - systemTokens - outputTokens;
      return Math.max(available, 1000);
    },
    
    async compact(text, availableTokens) {
      const safeAvailable = Math.max(availableTokens, 1000);
      const { chunks } = chunkText(text, safeAvailable);
      
      if (chunks.length === 0) return '';
      if (chunks.length === 1) return text;
      
      const { summaries } = await rollingCompact(chunks, httpEndpoint, model, maxTokens);
      return summaries[summaries.length - 1]; // Return final merged summary
    }
  };
}
