import fs from 'fs';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger();

export async function query_model(args, context) {
    const { gateway, prompts, progress } = context;
    const { prompt, files = [], systemPrompt } = args;

    let fileContext = '';
    for (const file of files) {
        if (!fs.existsSync(file)) {
            return { content: [{ type: "text", text: `Error: File not found: ${file}` }], isError: true };
        }
        const content = fs.readFileSync(file, 'utf8');
        fileContext += `\n\n--- File: ${file} ---\n${content}\n--- End File ---\n`;
    }

    const finalPrompt = fileContext ? `${fileContext}\n\n${prompt}` : prompt;
    const sysPrompt = systemPrompt || prompts.system || 'You are a helpful AI assistant.';

    if (progress) progress('Querying LLM...', 10, 100);
    logger.debug(`[LLM Tool] Started query with prompt length ${finalPrompt.length}`);

    let receivedChars = 0;
    let lastPct = 10;
    let lastProgressTime = 0;
    let deltaEvents = 0;
    let firstGenerationSeen = false;

    function emitProgress(message, pct, force = false) {
        if (!progress) return;
        const now = Date.now();
        if (!force && now - lastProgressTime <= 250) return;
        if (!force && pct <= lastPct && now - lastProgressTime <= 1000) return;
        lastPct = Math.max(lastPct, pct);
        lastProgressTime = now;
        logger.debug(`[LLM Tool] Emitting progress: ${lastPct}% (${receivedChars} chars, ${deltaEvents} deltas)`);
        progress(message, lastPct, 100);
    }

    const response = await gateway.chat({
        task: 'query',
        messages: [{ role: 'user', content: finalPrompt }],
        systemPrompt: sysPrompt,
        onProgress: (phase, ctx) => {
            logger.debug(`[LLM Tool] Progress phase: ${phase}`, { ctx });
            if (progress) {
                if (phase === 'reasoning_started') {
                    progress('Model is thinking (stripping reasoning output)...', lastPct, 100);
                } else if (phase === 'routing') {
                    progress('Routing request to upstream...', lastPct, 100);
                } else if (phase === 'context_stats' && ctx) {
                    progress(`Context stats: ${ctx.used_tokens} used, ${ctx.available_tokens} avail`, lastPct, 100);
                } else {
                    progress(`Status: ${phase}`, lastPct, 100);
                }
            }
        },
        onDelta: (content, meta = {}) => {
            deltaEvents = meta.deltaCount || (deltaEvents + 1);
            if (content) receivedChars += content.length;
            if (!progress) return;

            if (!firstGenerationSeen) {
                firstGenerationSeen = true;
                emitProgress('Model started generating...', Math.max(lastPct, 15), true);
            }

            const basePct = Math.min(95, 15 + Math.floor(deltaEvents / 20));
            if (content) {
                const contentPct = Math.min(99, 20 + Math.floor(receivedChars / 100));
                const pct = Math.max(basePct, contentPct);
                emitProgress(`Receiving response (${receivedChars} chars, ${deltaEvents} deltas)...`, pct);
            } else {
                emitProgress(`Model generating... (${deltaEvents} deltas observed, no text yet)`, basePct);
            }
        }
    });

    logger.debug(`[LLM Tool] Finished. Total received characters: ${receivedChars}`);
    if (progress) progress('Done', 100, 100);

    return { content: [{ type: "text", text: response.content }] };
}
