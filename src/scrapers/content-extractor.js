// Content Extraction Module - Hardened for LLM consumption
// Provides robust HTML-to-text extraction with multiple fallback strategies

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

/**
 * Extract clean content from HTML using multiple strategies
 * Strategy 1: Readability (best for articles)
 * Strategy 2: Semantic extraction (headings + paragraphs from article/main/content areas)
 * Strategy 3: Density-based extraction (find text-dense regions)
 * Strategy 4: Raw body text (last resort)
 * 
 * @param {string} html - Raw HTML
 * @param {string} url - Source URL for context
 * @param {Object} options - Extraction options
 * @returns {Object|null} Extracted content or null if insufficient
 */
export function extractContent(html, url, options = {}) {
  const {
    minLength = 200,        // Minimum chars to consider successful
    maxLength = 50000,      // Maximum chars to return
    charThreshold = 200     // Readability threshold
  } = options;
  
  // Handle null/undefined input
  if (!html || typeof html !== 'string') {
    return {
      success: false,
      strategy: 'error',
      title: null,
      content: null,
      excerpt: null,
      sections: [],
      metadata: { url },
      stats: { htmlSize: 0, extractedSize: 0, reduction: 0 },
      error: 'Invalid HTML input'
    };
  }
  
  const htmlSize = html.length;
  
  // Declare results outside try for error reporting
  let readabilityResult = null;
  let semanticResult = null;
  let densityResult = null;
  let fallbackResult = null;
  let metadata = null;
  
  try {
    // Pre-clean HTML for better extraction
    const cleanedHtml = preCleanHtml(html);
    
    // Create DOM
    const dom = new JSDOM(cleanedHtml, { url });
    const doc = dom.window.document;
    
    // Extract metadata first (always useful)
    metadata = extractMetadata(doc, url);
    
    // Strategy 1: Readability
    readabilityResult = tryReadability(doc, charThreshold, maxLength);
    if (readabilityResult && readabilityResult.length >= minLength) {
      const structured = structureContent(readabilityResult.text, readabilityResult.title);
      return {
        success: true,
        strategy: 'readability',
        title: readabilityResult.title || metadata.title,
        content: structured.text,
        excerpt: readabilityResult.excerpt || generateExcerpt(structured.text),
        sections: structured.sections,
        metadata,
        stats: {
          htmlSize,
          extractedSize: structured.text.length,
          reduction: ((1 - structured.text.length / htmlSize) * 100).toFixed(1)
        }
      };
    }
    
    // Strategy 2: Semantic extraction (look for content containers)
    semanticResult = trySemanticExtraction(doc, maxLength);
    if (semanticResult && semanticResult.length >= minLength) {
      const structured = structureContent(semanticResult.text, metadata.title);
      return {
        success: true,
        strategy: 'semantic',
        title: metadata.title,
        content: structured.text,
        excerpt: generateExcerpt(structured.text),
        sections: structured.sections,
        metadata,
        stats: {
          htmlSize,
          extractedSize: structured.text.length,
          reduction: ((1 - structured.text.length / htmlSize) * 100).toFixed(1)
        }
      };
    }
    
    // Strategy 3: Density-based extraction
    densityResult = tryDensityExtraction(doc, maxLength);
    if (densityResult && densityResult.length >= minLength) {
      const structured = structureContent(densityResult.text, metadata.title);
      return {
        success: true,
        strategy: 'density',
        title: metadata.title,
        content: structured.text,
        excerpt: generateExcerpt(structured.text),
        sections: structured.sections,
        metadata,
        stats: {
          htmlSize,
          extractedSize: structured.text.length,
          reduction: ((1 - structured.text.length / htmlSize) * 100).toFixed(1)
        }
      };
    }
    
    // Strategy 4: Fallback to cleaned body text
    fallbackResult = tryFallbackExtraction(doc, maxLength);
    if (fallbackResult && fallbackResult.length >= minLength / 2) { // Lower threshold for fallback
      return {
        success: true,
        strategy: 'fallback',
        title: metadata.title,
        content: fallbackResult,
        excerpt: generateExcerpt(fallbackResult),
        sections: [],
        metadata,
        stats: {
          htmlSize,
          extractedSize: fallbackResult.length,
          reduction: ((1 - fallbackResult.length / htmlSize) * 100).toFixed(1)
        }
      };
    }
    
    // Nothing worked
    return {
      success: false,
      strategy: 'failed',
      title: metadata.title,
      content: null,
      excerpt: null,
      sections: [],
      metadata,
      stats: { htmlSize, extractedSize: 0, reduction: 0 },
      error: `Insufficient content extracted (best attempt: ${Math.max(
        readabilityResult?.length || 0,
        semanticResult?.length || 0,
        densityResult?.length || 0,
        fallbackResult?.length || 0
      )} chars)`
    };
    
  } catch (err) {
    return {
      success: false,
      strategy: 'error',
      title: null,
      content: null,
      excerpt: null,
      sections: [],
      metadata: { url },
      stats: { htmlSize, extractedSize: 0, reduction: 0 },
      error: err.message
    };
  }
}

/**
 * Pre-clean HTML before DOM parsing
 * Removes obvious non-content elements
 */
function preCleanHtml(html) {
  return html
    // Remove script and style tags with their content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    // Remove common navigation patterns (be careful not to be too aggressive)
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    // Remove inline event handlers (onclick, onload, etc.)
    // Must be at word boundary or after space to avoid matching "content="
    .replace(/(\s|^)on[a-z]+="[^"]*"/gi, '$1');
}

/**
 * Extract page metadata
 */
function extractMetadata(doc, url) {
  // Try multiple selectors for each metadata type
  const getMetaContent = (selectors) => {
    for (const selector of selectors) {
      try {
        const tag = doc.querySelector(selector);
        if (tag) {
          const content = tag.getAttribute('content')?.trim();
          if (content) return content;
        }
      } catch (e) {
        // Invalid selector, skip
      }
    }
    return null;
  };
  
  return {
    url,
    title: doc.title?.trim() || null,
    description: getMetaContent([
      'meta[name="description"]',
      'meta[property="description"]',
      'meta[property="og:description"]',
      'meta[name="og:description"]',
      'meta[property="twitter:description"]'
    ]),
    author: getMetaContent([
      'meta[name="author"]',
      'meta[property="author"]',
      'meta[property="article:author"]',
      'meta[property="og:article:author"]'
    ]),
    published: getMetaContent([
      'meta[property="article:published_time"]',
      'meta[property="og:article:published_time"]',
      'meta[name="publishedDate"]',
      'meta[name="datePublished"]'
    ]),
    site: getMetaContent([
      'meta[name="application-name"]',
      'meta[property="site_name"]',
      'meta[property="og:site_name"]'
    ]),
    image: getMetaContent([
      'meta[property="image"]',
      'meta[property="og:image"]',
      'meta[property="twitter:image"]',
      'meta[property="og:image:url"]'
    ])
  };
}

/**
 * Try Readability extraction
 */
function tryReadability(doc, charThreshold, maxLength) {
  try {
    const reader = new Readability(doc, {
      charThreshold,
      nbTopCandidates: 5,
      keepClasses: false
    });
    
    const article = reader.parse();
    if (!article || !article.textContent) return null;
    
    // Clean up the content
    const text = cleanExtractedText(article.textContent, maxLength);
    
    return {
      text,
      title: article.title,
      excerpt: article.excerpt,
      length: text.length
    };
  } catch (err) {
    return null;
  }
}

/**
 * Try semantic extraction from content containers
 */
function trySemanticExtraction(doc, maxLength) {
  try {
    // Look for common content containers in order of preference
    const selectors = [
      'article',                          // HTML5 article
      '[role="main"]',                    // ARIA main
      'main',                             // HTML5 main
      '.content', '.post-content', '.entry-content', // Common class names
      '#content', '#main-content',        // Common IDs
      '.article', '.post', '.entry',
      '[class*="content" i]',             // Classes containing "content"
      '.markdown-body', '.readme',        // GitHub/GitLab specific
      '#wiki-body', '.wiki-content'       // Wiki specific
    ];
    
    let bestContent = '';
    let bestElement = null;
    
    for (const selector of selectors) {
      const elements = doc.querySelectorAll(selector);
      for (const el of elements) {
        const text = el.textContent || '';
        // Prefer longer content but penalize extremely long (might be whole page)
        const score = text.length > bestContent.length && text.length < 100000 ? text.length : 0;
        if (score > bestContent.length) {
          bestContent = text;
          bestElement = el;
        }
      }
      if (bestContent.length > 5000) break; // Good enough
    }
    
    if (bestContent.length < 200) return null;
    
    // Extract structure from the element
    const text = cleanExtractedText(bestContent, maxLength);
    return { text, length: text.length };
  } catch (err) {
    return null;
  }
}

/**
 * Try density-based extraction (paragraph clustering)
 */
function tryDensityExtraction(doc, maxLength) {
  try {
    const paragraphs = doc.querySelectorAll('p');
    if (paragraphs.length === 0) return null;
    
    // Score paragraphs by text density and length
    const scored = [];
    paragraphs.forEach(p => {
      const text = p.textContent || '';
      const trimmed = text.trim();
      if (trimmed.length < 50) return; // Skip very short paragraphs
      
      // Score based on length and link density (lower is better)
      const links = p.querySelectorAll('a');
      const linkText = Array.from(links).reduce((sum, a) => sum + (a.textContent?.length || 0), 0);
      const linkDensity = linkText / trimmed.length;
      
      // Prefer paragraphs with low link density and good length
      const score = trimmed.length * (1 - linkDensity * 0.5);
      scored.push({ element: p, text: trimmed, score, length: trimmed.length });
    });
    
    if (scored.length === 0) return null;
    
    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);
    
    // Take top paragraphs that are close together in DOM (same cluster)
    const topParagraphs = scored.slice(0, 20);
    
    // Build content from top paragraphs
    let content = '';
    let totalLength = 0;
    for (const p of topParagraphs) {
      if (totalLength + p.length > maxLength) break;
      content += p.text + '\n\n';
      totalLength += p.length + 2;
    }
    
    const text = content.trim();
    return text.length >= 200 ? { text, length: text.length } : null;
  } catch (err) {
    return null;
  }
}

/**
 * Fallback: extract from body with aggressive cleaning
 */
function tryFallbackExtraction(doc, maxLength) {
  try {
    const body = doc.body;
    if (!body) return null;
    
    // Clone to avoid modifying original
    const clone = body.cloneNode(true);
    
    // Remove obvious non-content elements
    const removeSelectors = [
      'header', 'footer', 'nav', 'aside',
      '.header', '.footer', '.nav', '.navigation', '.menu', '.sidebar', '.sidenav',
      '#header', '#footer', '#nav', '#navigation', '#menu', '#sidebar',
      '.ad', '.ads', '.advertisement', '.promo', '.social', '.share',
      '.comments', '#comments',
      'button', 'input', 'select', 'textarea',
      '[role="navigation"]', '[role="banner"]', '[role="complementary"]'
    ];
    
    removeSelectors.forEach(selector => {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    });
    
    // Special handling for table-based layouts (old-school sites)
    // Often nav is in first column, content in second
    const tables = clone.querySelectorAll('table');
    tables.forEach(table => {
      // Remove first column cells which often contain navigation
      const firstCells = table.querySelectorAll('td:first-child, th:first-child');
      firstCells.forEach(cell => {
        // Only remove if it looks like nav (contains mostly links)
        const links = cell.querySelectorAll('a');
        const text = cell.textContent?.trim() || '';
        const linkText = Array.from(links).reduce((sum, a) => sum + (a.textContent?.length || 0), 0);
        if (links.length > 0 && linkText / text.length > 0.3) {
          cell.remove();
        }
      });
    });
    
    const text = cleanExtractedText(clone.textContent || '', maxLength);
    return text.length > 0 ? text : null;
  } catch (err) {
    return null;
  }
}

/**
 * Clean extracted text while preserving structure
 */
function cleanExtractedText(text, maxLength) {
  return text
    // Normalize whitespace but preserve paragraph breaks
    .replace(/[ \t]+/g, ' ')           // Collapse spaces/tabs
    .replace(/\n{3,}/g, '\n\n')         // Max 2 consecutive newlines
    .replace(/^\s+|\s+$/gm, '')        // Trim each line
    // Clean up common artifacts
    .replace(/\{\{[^}]*\}\}/g, '')     // Template syntax
    .replace(/\[\s*\]/g, '')           // Empty brackets
    // Final trim and truncate
    .trim()
    .substring(0, maxLength);
}

/**
 * Structure content into sections based on headings
 */
function structureContent(text, title) {
  // Split on common heading patterns in plain text
  const lines = text.split('\n');
  const sections = [];
  let currentText = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Detect headings (all caps, ends with colon, or short line)
    const isHeading = (
      (trimmed.length < 100 && trimmed === trimmed.toUpperCase() && trimmed.length > 3) ||
      (trimmed.length < 80 && /^[\d.]+\s+\w/.test(trimmed)) ||
      (trimmed.length < 60 && trimmed.endsWith(':') && !trimmed.includes('. '))
    );
    
    if (isHeading) {
      if (currentText.length > 0) {
        sections.push(currentText.join('\n').trim());
        currentText = [];
      }
      sections.push({ heading: trimmed, isHeading: true });
    } else {
      currentText.push(line);
    }
  }
  
  if (currentText.length > 0) {
    sections.push(currentText.join('\n').trim());
  }
  
  // Extract heading texts for structure
  const sectionHeadings = sections
    .filter(s => s.isHeading)
    .map(s => s.heading);
  
  return {
    text: text,
    sections: sectionHeadings.slice(0, 20) // Max 20 sections
  };
}

/**
 * Generate excerpt from content
 */
function generateExcerpt(text, maxLength = 300) {
  if (!text) return '';
  
  // Find a good break point (end of sentence)
  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastSpace = truncated.lastIndexOf(' ');
  
  if (lastPeriod > maxLength * 0.5) {
    return truncated.substring(0, lastPeriod + 1);
  } else if (lastSpace > maxLength * 0.8) {
    return truncated.substring(0, lastSpace) + '...';
  }
  
  return truncated + (text.length > maxLength ? '...' : '');
}

/**
 * Quick check if content is worth processing
 * Useful for filtering out bot detection pages, errors, etc.
 */
export function validateContent(content, url) {
  if (!content || !content.content) return { valid: false, reason: 'no_content' };
  
  const text = content.content;
  
  // Check for common bot/captcha pages
  const botPatterns = [
    /are you a human/i,
    /captcha/i,
    /verify you are human/i,
    /please enable javascript/i,
    /access denied/i,
    /403 forbidden/i,
    /cloudflare/i,
    /checking your browser/i
  ];
  
  for (const pattern of botPatterns) {
    if (pattern.test(text.substring(0, 500))) {
      return { valid: false, reason: 'bot_detection' };
    }
  }
  
  // Check content quality
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 50) {
    return { valid: false, reason: 'too_short' };
  }
  
  // Check link density (high = probably nav/menu page)
  const linkMatches = text.match(/https?:\/\//g);
  if (linkMatches && linkMatches.length > wordCount * 0.5) {
    return { valid: false, reason: 'high_link_density' };
  }
  
  return { valid: true, reason: null };
}
