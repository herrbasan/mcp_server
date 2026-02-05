export function estimateTokens(text) {
  if (!text) return { tokens: 0 };
  return { tokens: Math.ceil(text.length / 3) };
}

export async function tokenizeText(text, endpoint, modelName) {
  if (!text) return { tokens: 0 };
  if (!endpoint || !modelName) return { tokens: 0, error: 'Missing endpoint or modelName' };

  try {
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: text }],
        max_tokens: 1,
        temperature: 0
      })
    });

    if (!response.ok) {
      return { tokens: 0, error: `Tokenization HTTP error: ${response.status}` };
    }

    const data = await response.json();
    
    if (!data.usage || typeof data.usage.prompt_tokens !== 'number') {
      return { tokens: 0, error: 'Invalid response - no usage.prompt_tokens' };
    }

    return { tokens: data.usage.prompt_tokens };
  } catch (err) {
    return { tokens: 0, error: `Tokenization failed: ${err.message}` };
  }
}

export function estimateTokensBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { total: 0, individual: [] };
  }

  const results = texts.map(text => estimateTokens(text).tokens);
  const total = results.reduce((sum, count) => sum + count, 0);

  return { total, individual: results };
}

export async function tokenizeBatch(texts, endpoint, modelName) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { total: 0, individual: [] };
  }

  const results = [];
  let total = 0;
  
  for (const text of texts) {
    const result = await tokenizeText(text, endpoint, modelName);
    if (result.error) return { total: 0, individual: [], error: result.error };
    results.push(result.tokens);
    total += result.tokens;
  }

  return { total, individual: results };
}

export function createCachedTokenizer(endpoint, modelName) {
  const cache = new Map();
  
  return async function tokenize(text) {
    const cacheKey = text.length < 1000 ? text : `${text.slice(0, 100)}...${text.length}`;
    
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    
    const result = await tokenizeText(text, endpoint, modelName);
    if (!result.error) cache.set(cacheKey, result);
    
    return result;
  };
}
