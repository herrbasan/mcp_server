// Context enhancement for VDB indexing.
//
// Uses a lightweight local LLM (routed via task='local' on the gateway) to
// generate per-file metadata: summary, keywords, entities, and docType.
// The metadata is embedded into chunk text as a header and also stored in
// the nVDB payload for retrieval-time display/filtering.

const DEFAULT_PROMPT = `You are an indexing assistant for a semantic file search system.

Given a file path and its content (possibly truncated), produce a concise JSON object with these fields:
- summary: one clear sentence describing what this file is about
- keywords: 5-10 relevant search keywords or short phrases
- entities: named entities such as people, projects, tools, APIs, file formats, or model names
- docType: the kind of file (e.g. "spec", "code", "note", "log", "config", "draft", "test", "doc")

File path: {path}

Content:
{content}

Respond ONLY with valid JSON matching the requested schema.`;

function truncateHead(content, maxChars) {
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + '\n\n[content truncated for context window]';
}

function truncateHeadTail(content, maxChars) {
    if (content.length <= maxChars) return content;
    const headChars = Math.floor(maxChars * 0.7);
    const tailChars = maxChars - headChars;
    return content.slice(0, headChars) + '\n\n[... middle truncated ...]\n\n' + content.slice(-tailChars);
}

function truncateHeadMidTail(content, maxChars) {
    if (content.length <= maxChars) return content;
    const segmentChars = Math.floor(maxChars / 3);
    const head = content.slice(0, segmentChars);
    const midStart = Math.floor((content.length - segmentChars) / 2);
    const mid = content.slice(midStart, midStart + segmentChars);
    const tail = content.slice(-segmentChars);
    return head + '\n\n[... part 1/3 end ...]\n\n' + mid + '\n\n[... part 2/3 end ...]\n\n' + tail;
}

function truncateMiddle(content, maxChars) {
    if (content.length <= maxChars) return content;
    const half = Math.floor(maxChars / 2);
    return content.slice(0, half) + '\n\n[... middle truncated ...]\n\n' + content.slice(-half);
}

const TRUNCATORS = {
    head: truncateHead,
    headtail: truncateHeadTail,
    headmidtail: truncateHeadMidTail,
    middle: truncateMiddle
};

export function createContextEnhancer(config, gateway, logger, cache = null) {
    if (!config.enabled) return null;
    if (!gateway) throw new Error('Context enhancer enabled but gateway not available');

    const maxInputChars = config.maxInputChars ?? 12000;
    const maxOutputTokens = config.maxOutputTokens ?? 512;
    const temperature = config.temperature ?? 0.3;
    const task = config.task || 'local';
    const promptTemplate = config.prompt || DEFAULT_PROMPT;
    const truncation = config.truncation || 'headmidtail';
    const truncator = TRUNCATORS[truncation] || truncateHeadMidTail;
    const includeFolders = config.includeFolders || null;
    const maxFileSizeForEnhancement = config.maxFileSizeForEnhancement ?? null;

    function shouldEnhance(preparedFile) {
        const size = preparedFile.size ?? 0;
        if (maxFileSizeForEnhancement && size > maxFileSizeForEnhancement) {
            return false;
        }
        if (includeFolders && includeFolders.length > 0) {
            const rel = preparedFile.relPath || '';
            const firstSegment = rel.split('/')[0];
            if (!includeFolders.includes(firstSegment)) {
                return false;
            }
        }
        return true;
    }

    function truncateContent(content) {
        if (!content || content.length <= maxInputChars) return content || '';
        return truncator(content, maxInputChars);
    }

    function renderPrompt(filePath, content) {
        return promptTemplate
            .replace('{path}', filePath)
            .replace('{content}', truncateContent(content));
    }

    function formatHeader(meta) {
        const keywords = Array.isArray(meta.keywords) ? meta.keywords.join(', ') : '';
        const entities = Array.isArray(meta.entities) ? meta.entities.join(', ') : '';
        const parts = [
            meta.docType ? `Type: ${meta.docType}` : '',
            keywords ? `Keywords: ${keywords}` : '',
            entities ? `Entities: ${entities}` : '',
            meta.summary ? `Summary: ${meta.summary}` : ''
        ].filter(Boolean);
        if (parts.length === 0) return '';
        return `[${parts.join(' | ')}]\n\n`;
    }

    function applyHeaderAndMetadata(preparedFile, meta, header) {
        if (header) {
            for (const chunk of preparedFile.chunks) {
                chunk.text = header + chunk.text;
                // Do NOT mutate tokEst — it is used to slice the original file
                // content at retrieval time (charOffset + tokEst * ratio).
                // The header only exists in the embedding text, not on disk.
            }
        }
        return {
            ...preparedFile,
            metadata: {
                ...preparedFile.metadata,
                summary: meta.summary || '',
                keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
                entities: Array.isArray(meta.entities) ? meta.entities : [],
                docType: meta.docType || '',
                contextEnhanced: true
            }
        };
    }

    async function enhance(preparedFile) {
        const { absolutePath, relPath, chunks, content, contentHash } = preparedFile;
        if (!chunks || chunks.length === 0) return preparedFile;
        if (!shouldEnhance(preparedFile)) {
            return {
                ...preparedFile,
                metadata: {
                    ...preparedFile.metadata,
                    contextEnhanced: false
                }
            };
        }

        // Check cache first.
        if (cache && contentHash) {
            const cached = cache.get(contentHash);
            if (cached) {
                logger.info(`[VDB] Enhancement cache hit for ${relPath}`, null, 'VDB');
                return applyHeaderAndMetadata(preparedFile, cached.meta, cached.header);
            }
        }

        // Prefer the full original file content if available. If not (legacy callers),
        // fall back to the first chunk. The truncation strategy in renderPrompt then
        // sees the whole file and can apply head / headtail / headmidtail / middle correctly.
        const sampleContent = content || chunks[0].text;
        const prompt = renderPrompt(relPath, sampleContent);

        try {
            const raw = await gateway.predict({
                task,
                prompt,
                systemPrompt: 'You are a concise indexing assistant. Reply only with the requested JSON.',
                maxTokens: maxOutputTokens,
                temperature,
                responseFormat: { type: 'json_object' }
            });

            let meta = raw;
            if (typeof raw === 'string') {
                // Some gateway adapters return the raw JSON text even with json_object format.
                const firstBrace = raw.indexOf('{');
                const lastBrace = raw.lastIndexOf('}');
                if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
                    throw new Error(`Local model returned non-JSON response: ${raw.slice(0, 200)}`);
                }
                meta = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
            }

            if (!meta || typeof meta !== 'object') {
                throw new Error(`Local model returned non-object metadata: ${typeof meta}`);
            }

            const header = formatHeader(meta);
            if (cache && contentHash) {
                cache.set(contentHash, { meta, header });
            }

            return applyHeaderAndMetadata(preparedFile, meta, header);
        } catch (err) {
            // Enhancement is best-effort enrichment. Log the failure clearly but
            // do not block indexing of the raw content.
            logger.warn(`[VDB] Context enhancement failed for ${absolutePath}: ${err.message}`, null, 'VDB');
            return {
                ...preparedFile,
                metadata: {
                    ...preparedFile.metadata,
                    contextEnhanced: false,
                    contextError: err.message
                }
            };
        }
    }

    return { enhance };
}
