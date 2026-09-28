import { searchGoogle } from './scrapers/google-adapter.js';
import { searchDuckDuckGo } from './scrapers/duckduckgo-adapter.js';
import { htmlToMarkdown } from '../../lib/html-to-markdown.js';
import { detectBlockPage } from '../browser/index.js';
import { StreamingResearchPipeline, prioritizeUrls } from './streaming-research.js';

// Per-source ceiling for the synthesis prompt. This pass SUMMARISES, so unlike
// browser.fetch it hands the model one prompt containing every source at once,
// and an uncapped docs page is 30-60 KB of Markdown. The old extractor capped at
// 50000 silently; the cap stays, but truncation is now reported in the output
// rather than being invisible.
const SYNTHESIS_PAGE_CHARS = 50000;

export async function research_topic(args, context) {
    const { agents, gateway, prompts, progress } = context;
    const { query, engines = ['duckduckgo', 'google'], max_pages = 5 } = args;

    if (typeof query !== 'string' || !query.trim()) {
        throw new Error("research_topic: 'query' is required (non-empty string)");
    }
    if (!Array.isArray(engines) || engines.some(e => e !== 'google' && e !== 'duckduckgo')) {
        throw new Error("research_topic: 'engines' must be an array containing 'google' and/or 'duckduckgo'");
    }

    const browserAgent = agents.get('browser');
    if (!browserAgent) {
        return { content: [{ type: "text", text: "Error: Browser agent not found." }], isError: true };
    }

    const log = (msg, pct) => { if (progress) progress(msg, pct, 100); };

    log(`Phase 1: Searching for "${query}" via [${engines.join(', ')}]`, 10);

    const searchPromises = [];
    if (engines.includes('google')) searchPromises.push(searchGoogle(query, browserAgent, 15000));
    if (engines.includes('duckduckgo')) searchPromises.push(searchDuckDuckGo(query, browserAgent, 15000));
    if (!searchPromises.length) searchPromises.push(searchDuckDuckGo(query, browserAgent, 15000));

    const searchResults = await Promise.allSettled(searchPromises);

    let urls = [];
    searchResults.forEach(res => {
        if (res.status === 'fulfilled' && res.value) {
            urls.push(...res.value.map(item => typeof item === 'string' ? item : item.url));
        }
    });
    urls = [...new Set(urls.filter(Boolean))];

    if (!urls.length) {
        return { content: [{ type: "text", text: `Search for "${query}" returned no URLs.` }], isError: true };
    }

    log(`Phase 2: Collected ${urls.length} URLs. Prioritizing...`, 20);
    const prioritizedUrls = prioritizeUrls(urls, query).slice(0, max_pages * 2);

    log(`Phase 3: Scraping top pages...`, 30);

    const pipeline = new StreamingResearchPipeline({ scrapeTimeout: 10000, maxConcurrent: 5, maxTotalTime: 60000 });

    const scrapeFn = async (url) => {
        const { page, markUsed, close } = await browserAgent.getPage();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const html = await page.content();

            // Same conversion as browser.fetch: fenced code keeps its language and
            // tables keep their structure, which the old textContent extraction
            // flattened — the two things most worth having when the model is
            // summarising technical material.
            const md = htmlToMarkdown(html, { url, maxLength: SYNTHESIS_PAGE_CHARS });

            // A challenge page is not a source. Summarising one produces confident
            // nonsense, so it is refused here for the same reason browser.fetch
            // refuses to store it.
            const block = detectBlockPage(md);
            if (block) {
                return { success: false, url, error: `the site served a block page (matched "${block}")` };
            }

            return {
                success: true,
                url,
                title: md.title,
                content: md.markdown,
                excerpt: md.excerpt || md.markdown.slice(0, 200),
                strategy: md.strategy,
                truncated: md.stats.truncated
            };
        } catch (e) {
            // Recorded, never swallowed: a source that vanished silently is the
            // one failure this pipeline must not make, because the synthesis is
            // indistinguishable from one built on complete evidence.
            return { success: false, url, error: e.message };
        } finally {
            markUsed();
            await close(5000);
        }
    };

    const scrapedContent = [];
    for await (const update of pipeline.scrapeStreaming(prioritizedUrls.slice(0, max_pages), scrapeFn)) {
        if (update.type === 'page' && update.data) {
            scrapedContent.push(update.data);
            log(`Scraped ${update.data.url} (${update.data.content?.length || 0} chars)`, 30 + (40 * update.count / max_pages));
        }
    }

    if (!scrapedContent.length) {
        const reasons = pipeline.getFailures().map(f => `\n  ${f.url}: ${f.error}`).join('');
        return {
            content: [{ type: "text", text: `Failed to extract content from any search result.${reasons}` }],
            isError: true
        };
    }

    log(`Phase 4: Synthesizing ${scrapedContent.length} sources...`, 75);

    const sourcesContext = scrapedContent.map((c, i) =>
        `[Source ${i+1}: ${c.url}]\n${c.title ? `Title: ${c.title}\n` : ''}${c.content}\n`
    ).join('\n---\n');

    const synthesisResult = await gateway.chat({
        task: 'synthesis',
        messages: [{ role: 'user', content: `You are a research assistant compiling a report on: "${query}"\n\nUse the following sources to synthesize a comprehensive answer. Cite your sources using [1], [2], etc.\n\nSOURCES:\n${sourcesContext}` }],
        systemPrompt: prompts.synthesis || "You are an expert researcher. Synthesize fact-based, objective reports that directly answer the prompt. Always cite your sources.",
        enableThinking: false
    });

    log(`Phase 5: Evaluating...`, 95);

    const evalResult = await gateway.chat({
        task: 'analysis',
        messages: [{ role: 'user', content: `Original Query: "${query}"\n\nSynthesized Answer:\n${synthesisResult.content}\n\nRate confidence from 0.0 to 1.0 based on how well this answers the query and the quality of sources. Describe weaknesses.` }],
        systemPrompt: prompts.evaluation || "You are an evaluator.",
        enableThinking: false
    });

    const finalOutput = `${synthesisResult.content}\n\n---\n*Evaluation:\n${evalResult.content}*${sourceNotes(scrapedContent, pipeline.getFailures())}`;

    return { content: [{ type: "text", text: finalOutput }] };
}

// The report is stamped with what it is actually built on. A synthesis over four
// of seven sources reads identically to one over all seven unless the gaps are
// named, and the same goes for a source that was cut off at the cap.
function sourceNotes(scraped, failures) {
    const lines = [];
    if (failures.length) {
        lines.push('', `*Sources not retrieved (${failures.length}):*`);
        for (const f of failures) lines.push(`- ${f.url} — ${f.error}`);
    }
    const truncated = scraped.filter(s => s.truncated);
    if (truncated.length) {
        lines.push('', `*Truncated at ${SYNTHESIS_PAGE_CHARS} characters (${truncated.length}):*`);
        for (const s of truncated) lines.push(`- ${s.url}`);
    }
    return lines.join('\n');
}
