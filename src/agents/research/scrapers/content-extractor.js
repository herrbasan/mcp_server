import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export function extractContent(html, url, options = {}) {
  const {
    minLength = 200,
    maxLength = 50000,
    charThreshold = 200
  } = options;
  
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
  
  let readabilityResult = null;
  let semanticResult = null;
  let densityResult = null;
  let fallbackResult = null;
  let metadata = null;
  
  try {
    const cleanedHtml = preCleanHtml(html);
    
    const dom = new JSDOM(cleanedHtml, { url });
    const doc = dom.window.document;
    
    metadata = extractMetadata(doc, url);
    
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
    
    fallbackResult = tryFallbackExtraction(doc, maxLength);
    if (fallbackResult && fallbackResult.length >= minLength / 2) {
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

function preCleanHtml(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/(\s|^)on[a-z]+="[^"]*"/gi, '$1');
}

function extractMetadata(doc, url) {
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

function tryReadability(doc, charThreshold, maxLength) {
  try {
    const reader = new Readability(doc, {
      charThreshold,
      nbTopCandidates: 5,
      keepClasses: false
    });
    
    const article = reader.parse();
    if (!article || !article.textContent) return null;
    
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

function trySemanticExtraction(doc, maxLength) {
  try {
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
        const score = text.length > bestContent.length && text.length < 100000 ? text.length : 0;
        if (score > bestContent.length) {
          bestContent = text;
          bestElement = el;
        }
      }
      if (bestContent.length > 5000) break;
    }
    
    if (bestContent.length < 200) return null;
    
    const text = cleanExtractedText(bestContent, maxLength);
    return { text, length: text.length };
  } catch (err) {
    return null;
  }
}

function tryDensityExtraction(doc, maxLength) {
  try {
    const paragraphs = doc.querySelectorAll('p');
    if (paragraphs.length === 0) return null;
    
    const scored = [];
    paragraphs.forEach(p => {
      const text = p.textContent || '';
      const trimmed = text.trim();
      if (trimmed.length < 50) return;
      
      const links = p.querySelectorAll('a');
      const linkText = Array.from(links).reduce((sum, a) => sum + (a.textContent?.length || 0), 0);
      const linkDensity = linkText / trimmed.length;
      
      const score = trimmed.length * (1 - linkDensity * 0.5);
      scored.push({ element: p, text: trimmed, score, length: trimmed.length });
    });
    
    if (scored.length === 0) return null;
    
    scored.sort((a, b) => b.score - a.score);
    
    const topParagraphs = scored.slice(0, 20);
    
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

function tryFallbackExtraction(doc, maxLength) {
  try {
    const body = doc.body;
    if (!body) return null;
    
    const clone = body.cloneNode(true);
    
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
    
    const tables = clone.querySelectorAll('table');
    tables.forEach(table => {
      const firstCells = table.querySelectorAll('td:first-child, th:first-child');
      firstCells.forEach(cell => {
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

function cleanExtractedText(text, maxLength) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/gm, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/\[\s*\]/g, '')
    .trim()
    .substring(0, maxLength);
}

function structureContent(text, title) {
  const lines = text.split('\n');
  const sections = [];
  let currentText = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    
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
  
  const sectionHeadings = sections
    .filter(s => s.isHeading)
    .map(s => s.heading);
  
  return {
    text: text,
    sections: sectionHeadings.slice(0, 20)
  };
}

function generateExcerpt(text, maxLength = 300) {
  if (!text) return '';
  
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

export function validateContent(content, url) {
  if (!content || !content.content) return { valid: false, reason: 'no_content' };
  
  const text = content.content;
  
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
  
  const wordCount = text.split(/\s+/).length;
  if (wordCount < 50) {
    return { valid: false, reason: 'too_short' };
  }
  
  const linkMatches = text.match(/https?:\/\//g);
  if (linkMatches && linkMatches.length > wordCount * 0.5) {
    return { valid: false, reason: 'high_link_density' };
  }
  
  return { valid: true, reason: null };
}
