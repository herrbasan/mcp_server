import { searchGoogle } from './scrapers/google-adapter.js';
import { searchDuckDuckGo } from './scrapers/duckduckgo-adapter.js';
import { extractContent } from './scrapers/content-extractor.js';
import { StreamingResearchPipeline, prioritizeUrls } from './streaming-research.js';

export async function research_topic(args, context) {
    const { agents, gateway, prompts, progress } = context;
    const { query, engines = ['duckduckgo', 'google'], max_pages = 5 } = args;

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
            const extracted = extractContent(html, url);
            return extracted ? { success: true, url, ...extracted } : null;
        } catch (e) {
            return null;
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
        return { content: [{ type: "text", text: "Failed to extract content from any search results." }], isError: true };
    }

    log(`Phase 4: Synthesizing ${scrapedContent.length} sources...`, 75);

    const sourcesContext = scrapedContent.map((c, i) =>
        `[Source ${i+1}: ${c.url}]\n${c.title ? `Title: ${c.title}\n` : ''}${c.content}\n`
    ).join('\n---\n');

    const synthesisResult = await gateway.chat({
        model: context.config.models?.synthesis || 'default',
        messages: [{ role: 'user', content: `You are a research assistant compiling a report on: "${query}"\n\nUse the following sources to synthesize a comprehensive answer. Cite your sources using [1], [2], etc.\n\nSOURCES:\n${sourcesContext}` }],
        systemPrompt: prompts.synthesis || "You are an expert researcher. Synthesize fact-based, objective reports that directly answer the prompt. Always cite your sources."
    });

    log(`Phase 5: Evaluating...`, 95);

    const evalResult = await gateway.chat({
        model: context.config.models?.analysis || 'default',
        messages: [{ role: 'user', content: `Original Query: "${query}"\n\nSynthesized Answer:\n${synthesisResult.content}\n\nRate confidence from 0.0 to 1.0 based on how well this answers the query and the quality of sources. Describe weaknesses.` }],
        systemPrompt: prompts.evaluation || "You are an evaluator."
    });

    const finalOutput = `${synthesisResult.content}\n\n---\n*Evaluation:\n${evalResult.content}*`;

    return { content: [{ type: "text", text: finalOutput }] };
}
