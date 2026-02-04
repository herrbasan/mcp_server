// Output formatting: thinking tag stripping, JSON extraction, markdown conversion

const DEFAULT_THINKING_TAGS = ['think', 'analysis', 'reasoning'];

function createThinkingStripper(tags = DEFAULT_THINKING_TAGS) {
  const maxBuffer = 16384;
  let buffer = '';
  let inTag = null;

  const closeNeedleFor = (tagLower) => `</${tagLower}>`;

  const isOpenTagAt = (text, idx, tagLower) => {
    if (text[idx] !== '<') return false;
    if (text[idx + 1] !== tagLower[0]) return false;
    const after = text[idx + 1 + tagLower.length];
    return after === '>' || after === ' ' || after === '\t' || after === '\r' || after === '\n' || after === '/';
  };

  const findNextOpen = () => {
    const lower = buffer.toLowerCase();
    let bestIdx = -1, bestTag = null;
    for (const tag of tags) {
      const tagLower = String(tag).toLowerCase();
      let idx = lower.indexOf(`<${tagLower}`);
      while (idx !== -1) {
        if (isOpenTagAt(lower, idx, tagLower)) break;
        idx = lower.indexOf(`<${tagLower}`, idx + 1);
      }
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestTag = tagLower;
      }
    }
    return bestIdx === -1 ? null : { idx: bestIdx, tag: bestTag };
  };

  const findNextClose = () => {
    const lower = buffer.toLowerCase();
    let bestIdx = -1, bestTag = null;
    for (const tag of tags) {
      const tagLower = String(tag).toLowerCase();
      const idx = lower.indexOf(closeNeedleFor(tagLower));
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestTag = tagLower;
      }
    }
    return bestIdx === -1 ? null : { idx: bestIdx, tag: bestTag };
  };

  return {
    process(text) {
      if (!text) return '';
      buffer += String(text);
      if (buffer.length > maxBuffer) buffer = buffer.slice(-maxBuffer);

      let out = '';
      while (true) {
        if (inTag) {
          const closeNeedle = closeNeedleFor(inTag);
          const closeIdx = buffer.toLowerCase().indexOf(closeNeedle);
          if (closeIdx === -1) {
            buffer = buffer.slice(-(closeNeedle.length - 1));
            break;
          }
          buffer = buffer.slice(closeIdx + closeNeedle.length);
          inTag = null;
          continue;
        }

        const nextOpen = findNextOpen();
        const nextClose = findNextClose();

        // Orphan close tag (separator style: everything before </think> is thinking)
        if (nextClose && (!nextOpen || nextClose.idx < nextOpen.idx)) {
          buffer = buffer.slice(nextClose.idx + closeNeedleFor(nextClose.tag).length);
          continue;
        }

        if (!nextOpen) break;

        if (nextOpen.idx > 0) {
          out += buffer.slice(0, nextOpen.idx);
          buffer = buffer.slice(nextOpen.idx);
        }

        const gt = buffer.indexOf('>');
        if (gt === -1) break;

        buffer = buffer.slice(gt + 1);
        inTag = nextOpen.tag;
      }

      return out;
    },
    flush() {
      const out = inTag ? '' : buffer;
      buffer = '';
      inTag = null;
      return out;
    }
  };
}

export function stripThinking(text, tags = DEFAULT_THINKING_TAGS) {
  if (!text || typeof text !== 'string') return text;
  const stripper = createThinkingStripper(tags);
  const result = stripper.process(text) + stripper.flush();
  return result.trim();
}

// Extract JSON from text that may contain thinking tags or surrounding text
export function extractJSON(text) {
  if (!text) return null;
  
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Continue to extraction attempts
  }
  
  // Try to find JSON in text (between { } or [ ])
  const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  
  return null;
}

// Format output based on options
export function formatOutput(text, options = {}) {
  if (!text) return text;
  
  let result = text;
  
  // Strip thinking tags if requested
  if (options.stripThinking) {
    result = stripThinking(result, options.thinkingTags);
  }
  
  // Extract JSON if responseFormat specified
  if (options.extractJSON) {
    const json = extractJSON(result);
    return json ? JSON.stringify(json) : result;
  }
  
  return result;
}
