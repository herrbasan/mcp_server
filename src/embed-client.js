import { getLogger } from './utils/logger.js';

const logger = getLogger();

/**
 * Embed client — talks DIRECTLY to the llama-cpp-wrapper, no gateway hop.
 *
 * Architecture (2026-08-04): the LLM Gateway was removed from the embed path
 * after the immortal-request incident (32 hung gateway-side promises: no
 * abort propagation, no body-read deadline on the gateway's embed route).
 * The wrapper + llama-server already provide the required semantics:
 *   - llama-server's slot queue serializes execution (slow, never broken)
 *   - the wrapper propagates client disconnects upstream, freeing slots
 * So the only failure modes left are: wrapper machine down (fetch fails
 * fast) or queue wait longer than the timeout. Foreground embeds (search)
 * abort at a short cap and degrade; background embeds (store/heal) use a
 * generous deadlock guard and let the queue work them off eventually.
 *
 * There is deliberately NO circuit breaker here. A breaker exists to paper
 * over hangs; with abort propagation the queue drains, so a breaker would
 * only add a stateful failure mode on top of a stateless service.
 *
 * Config (env or config.json gateway section):
 *   EMBED_URL  — gateway base URL, e.g. http://localhost:3400. Embeds always
 *                go through the gateway, which owns the embed model — this
 *                client sends NO model so the gateway uses its default.
 */

// Foreground (search queries): keep snappy — degrade to recency rather than
// making the caller wait on a saturated queue.
const EMBED_TIMEOUT_MS = 15000;
const EMBED_BATCH_TIMEOUT_MS = 30000;
// Background (store/heal): generous deadlock guard, NOT a performance target.
// Lean into llama-server's slot queue — the wrapper serializes execution and
// propagates aborts upstream, so a long wait means "eventually served", not
// "lost". Prevents the pending->heal->retry churn from premature aborts.
const EMBED_BACKGROUND_TIMEOUT_MS = 300000; // 5 min

export function createEmbedClient(embedUrl, accessKey = null) {
    if (!embedUrl) throw new Error('createEmbedClient: embedUrl is required (env EMBED_URL or config gateway.embedUrl)');
    const baseUrl = embedUrl.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (accessKey) headers['Authorization'] = `Bearer ${accessKey}`;

    async function post(body, timeoutMs) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`${baseUrl}/v1/embeddings`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return await res.json();
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`Embedding timed out after ${timeoutMs / 1000}s — wrapper queue longer than timeout (retry is safe)`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        async embed(text, opts) {
            const timeout = opts?.background ? EMBED_BACKGROUND_TIMEOUT_MS : EMBED_TIMEOUT_MS;
            // No model sent — the gateway resolves its default embed model.
            const data = await post({ input: text }, timeout);
            return data.data[0].embedding;
        },

        async embedBatch(texts, opts) {
            const timeout = opts?.background ? EMBED_BACKGROUND_TIMEOUT_MS : EMBED_BATCH_TIMEOUT_MS;
            // No model sent — the gateway resolves its default embed model.
            const data = await post({ input: texts }, timeout);
            return data.data.map(d => d.embedding);
        }
    };
}
